/**
 * 非 players 表那几个整块 JSON 列的"读-改-写 vs 并发提交"活体门禁。
 *
 * 为什么单独一个探针：players.attributes 有 blobWriteGuard + state_version 兜底，
 * smoke_write_crossflow / smoke_soul_blob_writes 测的都是那张表。
 * 这里覆盖守卫射程之外的三处（都是本轮真实修过的丢数据形状）：
 *   F1 钓鱼状态轮询 getStatus 清过期会话 与重新抛竿 cast 并发 —— 轮询拿无锁快照把
 *      "会话已清空"写回去，会抹掉玩家刚抛出、刚扣了鱼饵的新会话；
 *   F2 试探 nibble 与提竿 reel 并发 —— 试探把 reel 结算完的会话原样写回，
 *      同一尾鱼可以再提一次（鱼获/灵石/熟练度重复发放）；
 *   F3 封鞘到期扫描 settleExpiredSheaths 与玩家侧提交并发 —— 扫描一次性 findAll 把整表
 *      快照读进内存再逐行 save，期间玩家重新封鞘/祭血提交的那一份会被旧快照抹掉。
 *
 * 判据两条，缺一不可（只判第一条会退化成空测）：
 *   1. 并发之后不允许出现"对手已经结算完成，而我这一份旧快照还留在库里"；
 *   2. 被测流程本身必须真的跑通（cast 成功、reel 真的入袋、扫描真的结算过至少一行）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_blob_races.js
 *       自建探针号 blobrace01，退出前删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const { Op } = require('sequelize');
const { app } = require('../index');
const Player = require('../models/player');
const PlayerFishing = require('../models/playerFishing');
const PlayerFishCatch = require('../models/playerFishCatch');
const PlayerEquipment = require('../models/playerEquipment');
const Item = require('../models/item');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const InventoryService = require('../game/services/InventoryService');
const FishingService = require('../game/services/FishingService');
const ArtifactDeepLineService = require('../game/services/ArtifactDeepLineService');

const ITERATIONS = Number(process.env.BLOB_RACE_ITERATIONS || 30);
const FILLER_COUNT = 40;
const FILLER_ID_BASE = 900000;
const results = [];
const skipped = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function writeSession(playerId, session) {
    await sequelize.query(
        'UPDATE player_fishing SET active_session=:s WHERE player_id=:p',
        { replacements: { s: JSON.stringify(session), p: playerId } }
    );
}

async function sessionOf(playerId) {
    const row = await PlayerFishing.findOne({ where: { player_id: playerId } });
    return row ? row.active_session : null;
}

/**
 * 开一竿并把时间快进到"鱼讯已到、提竿窗口还剩 6 秒"。
 * @returns {Promise<Object>} { session } 或 { error }
 */
async function openSession(playerId) {
    // 储物袋总容量 100，每轮先清一次（鱼获与伴生物会往袋里堆）
    await Item.destroy({ where: { player_id: playerId } });
    await InventoryService.addItem(playerId, 'diworm', 3, null);
    await sequelize.query(
        `UPDATE player_fishing SET active_session=NULL, daily_casts=0, buff_casts_remaining=0 WHERE player_id=${playerId}`
    );
    const casted = await FishingService.cast(playerId, 'qingyun_stream');
    if (!casted || casted.success !== true) return { error: casted && (casted.message || String(casted.success)) };
    const session = await sessionOf(playerId);
    if (!session) return { error: 'cast 成功但 active_session 为空' };
    session.nibble_at = Date.now() - 1000;
    session.reel_deadline = Date.now() + 6000;
    await writeSession(playerId, session);
    return { session };
}

/** 把熟练度顶到提竿不空竿，保证"入袋"这个前提真的会发生 */
async function makeNoEmpty(playerId) {
    const cfg = FishingService._config;
    const pool = cfg.fish_pools[cfg.ponds.qingyun_stream.fish_pool];
    let level = 1;
    while (level < 20 && Math.max(0, pool.empty_weight / 100 - FishingService._calcSkillEffects(level).emptyReduction) > 0) {
        level += 1;
    }
    await sequelize.query(`UPDATE player_fishing SET skill_level=${level} WHERE player_id=${playerId}`);
    return level;
}

/**
 * 一轮"提竿结算 vs 另一条会写同一块 blob 的流程"并发（F2）。
 * 对面用"每隔 1ms 打一次"的锤击，而不是一开始齐发：nibble 自身只要几毫秒，
 * 齐发时它早已写完，落不进提竿提交的窗口里（第一版控制实验就是这么跑成假绿的）。
 * 真实客户端本来就是每秒轮询+连点，锤击才是它的形状。
 * @param {string} label 检查名
 * @param {number} playerId 探针玩家
 * @param {(id:number)=>Promise<Object>} sideFlow 与提竿并发的流程
 */
async function raceAgainstReel(label, playerId, sideFlow) {
    let banked = 0;
    let resurrected = 0;
    let castError = null;
    let sideCalls = 0;

    for (let i = 0; i < ITERATIONS; i++) {
        const opened = await openSession(playerId);
        if (opened.error) { castError = opened.error; break; }
        const castAt = opened.session.cast_at;
        const before = await PlayerFishCatch.count({ where: { player_id: playerId } });

        let done = false;
        const hammer = (async () => {
            while (!done) {
                await sideFlow(playerId).catch(() => null);
                sideCalls += 1;
                await sleep(1);
            }
        })();
        await FishingService.reel(playerId);
        done = true;
        await hammer;

        // 鱼已入袋 = 这一竿确实结算完了
        if (await PlayerFishCatch.count({ where: { player_id: playerId } }) <= before) continue;
        banked += 1;
        const leftover = await sessionOf(playerId);
        if (leftover && leftover.cast_at === castAt) resurrected += 1;
    }

    check(
        `${label}：没有"鱼已入袋却被旧快照复活"，且流程真的跑通`,
        !castError && banked > 0 && resurrected === 0,
        `入袋=${banked}/${ITERATIONS} 轮, 复活=${resurrected}, 对面打了 ${sideCalls} 次`
        + (castError ? `, cast 失败：${castError}` : '')
    );
    await sequelize.query(`UPDATE player_fishing SET active_session=NULL WHERE player_id=${playerId}`);
}

/**
 * F1：过期会话的"轮询清理"与玩家重新抛竿并发。
 * getStatus 里真正会落库的只有清除过期会话那一支（另一支只改 getter 返回的临时对象，
 * Sequelize 检测不到变化，等于没写 —— 所以那一支不构成丢数据，探针也就不该拿它当判据）。
 * 危险形状：轮询在 t1 读到已过期的 X，玩家在这一瞬间抛出新的一竿 Y 并提交，
 * 轮询随后把 X 那份"已经没有了"整块写回 → 玩家扣了鱼饵的新会话凭空消失。
 * 但这个交错实测压不出来：预修复版跑 30 轮（28 次成功抛竿 + 188 次轮询）0 次抹竿，
 * 因为轮询自身只需 1~2ms，落不进 cast 的提交窗口。所以这一项只当行为回归用，
 * 真正的门禁在 tests/BlobWriteRaceGates.test.js（静态钉住轮询不再写这块 blob、
 * 清理必须加锁重读并复核 cast_at 与截止时间）。
 */
async function expiredSessionPollBehavior(playerId) {
    const opened = await openSession(playerId);
    if (opened.error) return check('F1 过期会话轮询清理后能立刻重抛', false, `cast 失败：${opened.error}`);
    const xCastAt = opened.session.cast_at;
    // 把这一竿改成"提竿窗口已过"，让轮询走清理那一支
    await writeSession(playerId, {
        ...opened.session,
        nibble_at: Date.now() - 60000,
        reel_deadline: Date.now() - 30000
    });

    const polled = await FishingService.getStatus(playerId);
    const afterPoll = await sessionOf(playerId);
    const recast = await FishingService.cast(playerId, 'qingyun_stream');
    const afterRecast = await sessionOf(playerId);

    check(
        'F1 过期会话轮询清理后能立刻重抛',
        polled && polled.success === true && polled.data && polled.data.status === 'expired'
            && afterPoll === null
            && recast && recast.success === true
            && !!afterRecast && afterRecast.cast_at !== xCastAt,
        `轮询状态=${polled && polled.data && polled.data.status}, 轮询后会话=${afterPoll ? '还在' : '已清'}, `
        + `重抛=${recast && (recast.success ? '成功' : recast.message)}, 新竿=${afterRecast ? '在' : '不在'}`
    );
    await sequelize.query(`UPDATE player_fishing SET active_session=NULL WHERE player_id=${playerId}`);
}

/** 库里是否已有探针之外的血魔剑带着到期封鞘 —— 有的话 F3 会改动别人的数据，跳过 */
async function countForeignExpiredSheaths(itemKey, probePlayerId) {
    const rows = await PlayerEquipment.findAll({
        where: { item_key: itemKey, player_id: { [Op.ne]: probePlayerId } },
        attributes: ['id', 'deep_line_state']
    });
    return rows.filter(r => {
        const s = (r.deep_line_state || {}).blood_sword;
        return s && s.sheath_until && new Date(s.sheath_until).getTime() <= Date.now();
    }).length;
}

/** F3：封鞘扫描期间，玩家侧提交的新封鞘 + 并发写入的键不该被扫描手上的旧快照抹掉 */
async function sheathSweepRace(playerId, itemKey) {
    const target = await PlayerEquipment.findOne({ where: { player_id: playerId, item_key: itemKey } });
    if (!target) return check('F3 封鞘扫描与玩家侧提交并发', false, '探针装备行没建起来');

    const fresh = JSON.parse(JSON.stringify(target.deep_line_state || {}));
    fresh.probe_sentinel = 'keep-me';
    fresh.blood_sword.sheath_until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    fresh.blood_sword.corruption = 60;
    fresh.blood_sword.suppression = 10;

    const sweepPromise = ArtifactDeepLineService.settleExpiredSheaths();
    await sleep(80);   // 让扫描先把整表快照读进内存
    await sequelize.query(
        'UPDATE player_equipment SET deep_line_state=:d WHERE id=:id',
        { replacements: { d: JSON.stringify(fresh), id: target.id } }
    );
    const swept = await sweepPromise;

    const final = (await PlayerEquipment.findByPk(target.id)).deep_line_state || {};
    const stillSheathed = !!(final.blood_sword && final.blood_sword.sheath_until
        && new Date(final.blood_sword.sheath_until).getTime() > Date.now());
    check(
        'F3 封鞘到期扫描与玩家侧提交并发：新封鞘与并发写入的键都还在，且扫描真的结算过',
        final.probe_sentinel === 'keep-me' && stillSheathed && swept && swept.settled_count >= 1,
        `哨兵=${final.probe_sentinel ? '在' : '被抹掉'}, 新封鞘=${stillSheathed ? '保留' : '被清除'}, `
        + `扫描结算=${swept && swept.settled_count} 行(填充 ${FILLER_COUNT} 行), 魔染=${final.blood_sword && final.blood_sword.corruption}`
    );
}

(async () => {
    await bootApp(app, { port: PORT });

    await Player.destroy({ where: { username: 'blobrace01' } });
    const player = await Player.create({
        username: 'blobrace01', password: 'not-a-real-hash', nickname: '并发探针',
        realm: '炼虚初期', realm_rank: 27, exp: 1000000, spirit_stones: 100000000,
        hp_current: 5000000, lifespan_current: 300, lifespan_max: 5000,
        attributes: {}, token_version: 0
    });

    await PlayerFishing.destroy({ where: { player_id: player.id } });
    await PlayerFishing.create({
        player_id: player.id, rod_tier: 1, skill_level: 10, skill_exp: 0, daily_casts: 0,
        daily_stone_earned: 0, daily_cultivation_earned: 0, buff_casts_remaining: 0,
        buff_luck_bonus: 0, total_catches: 0, total_success: 0, biggest_catch_kg: 0,
        rarest_catch_quality: 0, active_session: null
    });
    await PlayerFishCatch.destroy({ where: { player_id: player.id } });
    await Item.destroy({ where: { player_id: player.id } });
    const skill = await makeNoEmpty(player.id);

    /* F1 / F2 */
    await expiredSessionPollBehavior(player.id);
    await raceAgainstReel('F2 试探 nibble 与提竿并发', player.id, id => FishingService.nibble(id));

    /* F3 */
    const itemKey = ArtifactDeepLineService.getBloodSwordConfig().item_key;
    const foreign = await countForeignExpiredSheaths(itemKey, player.id);
    if (foreign > 0) {
        skipped.push(`F3 跳过：库里另有 ${foreign} 行到期封鞘的血魔剑，扫描会改动探针之外的数据`);
        console.log(`SKIP  F3 封鞘到期扫描并发（库里另有 ${foreign} 行别人的到期封鞘，不动它）`);
    } else {
        const expired = new Date(Date.now() - 3600 * 1000).toISOString();
        const mkState = () => ({
            blood_sword: {
                blood_pact_stage: 2, blood_pact_stage_name: '探针', corruption: 60, suppression: 10,
                blood_pact_weekly_progress: 1, blood_pact_week_reset_at: '2026-01-01',
                imprint_type: 'none', sheath_until: expired, last_sacrifice_at: null
            }
        });
        await PlayerEquipment.destroy({ where: { player_id: { [Op.gte]: FILLER_ID_BASE } } });
        await PlayerEquipment.destroy({ where: { player_id: player.id } });
        // 填充行 id 在前、目标行 id 最大 → 扫描按主键升序处理时目标落在最后，
        // 那次并发更新才夹得进"扫描读完"与"该行写回"之间
        for (let i = 0; i < FILLER_COUNT; i++) {
            await PlayerEquipment.create({
                player_id: FILLER_ID_BASE + i, slot: 'artifact', item_key: itemKey, refine_level: 0,
                is_benming: 0, spirit_power: 0, sort_order: 0, is_summoned: 0,
                deep_line_state: mkState()
            });
        }
        await PlayerEquipment.create({
            player_id: player.id, slot: 'artifact', item_key: itemKey, refine_level: 0,
            is_benming: 0, spirit_power: 0, sort_order: 0, is_summoned: 0,
            deep_line_state: mkState()
        });
        await sheathSweepRace(player.id, itemKey);
    }

    /* 收尾：探针数据全部删除 */
    await PlayerEquipment.destroy({ where: { player_id: player.id } });
    await PlayerEquipment.destroy({ where: { player_id: { [Op.gte]: FILLER_ID_BASE } } });
    await PlayerFishing.destroy({ where: { player_id: player.id } });
    await PlayerFishCatch.destroy({ where: { player_id: player.id } });
    await Item.destroy({ where: { player_id: player.id } });
    await Player.destroy({ where: { id: player.id } });

    const residue = await Promise.all([
        Player.count({ where: { username: 'blobrace01' } }),
        PlayerFishing.count({ where: { player_id: player.id } }),
        PlayerFishCatch.count({ where: { player_id: player.id } }),
        Item.count({ where: { player_id: player.id } }),
        PlayerEquipment.count({ where: { player_id: player.id } }),
        PlayerEquipment.count({ where: { player_id: { [Op.gte]: FILLER_ID_BASE } } })
    ]);
    check('TEARDOWN 探针数据全部清干净', residue.every(n => n === 0), `残留计数=${residue.join('/')}`);

    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} 项通过（提竿熟练度顶到 ${skill} 以保证真的入袋）`
        + (skipped.length ? `；跳过：${skipped.join('；')}` : ''));
    process.exit(passed === results.length ? 0 : 1);
})().catch(async error => {
    console.error('探针异常:', error);
    process.exit(1);
});
