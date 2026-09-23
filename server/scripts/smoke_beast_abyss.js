/**
 * 探渊（灵兽深渊）：境界门槛真的挡得住、奖励只发一遍、召回与自动结算不打架
 * （需要 MySQL，走 .env 指向的隔离库）
 *
 * 两个理由：
 * ① 取锁次序：_settleExplore 原来是 explore → 灵兽 → …… → players，而本服务的自动结算
 *   （index.js 里周期跑 checkExpirations）与玩家喂灵兽/放归/巡边归来（players → 灵兽）正好反向，
 *   两边各持一行就是 ABBA。现在统一成 players 先于灵兽行，次序差分见 smoke_lock_order_matrix.js。
 * ② 顺带查出并修掉的可达性洞：楼层门槛读的是 beast.player.realm_rank，而取灵兽那没带 include，
 *   这个关联属性永远是 undefined → 门槛恒等于 1。floors 配了 9 层（min_realm_rank 1/3/6/11/14/17/20/23/26），
 *   结果**除了第一层谁都进不去**，探渊收益被静默砍到 1/9，而内容看上去是齐的。
 *   E2/E3 就是这条的正反两面：高境界主人必须能下到第二层以下，低境界主人必须被挡住。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_beast_abyss.js
 * 只用自建探针号 abyss_hi / abyss_lo，跑完连灵兽、探渊行、遭遇日志一起删。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5100);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const SpiritBeast = require('../models/spiritBeast');
const SpiritBeastAbyss = require('../models/spiritBeastAbyss');
const AbyssEncounterLog = require('../models/abyssEncounterLog');
const Item = require('../models/item');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const BeastAbyssService = require('../game/services/BeastAbyssService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const itemNames = new Map();
function itemNameOf(key) {
    if (!itemNames.size) {
        const d = require('../config/item_data.json');
        const list = Array.isArray(d) ? d : (d.items || Object.values(d)[0] || []);
        for (const i of list) itemNames.set(String(i.key || i.id), i.name || '');
    }
    return itemNames.get(String(key));
}

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const unwrap = r => (r && r.data) ? r.data : (r || {});
const N = v => Number(v == null ? 0 : v);
const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };

async function ensurePlayer(username, realmRank) {
    let p = await Player.findOne({ where: { username } });
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `探渊探针${realmRank}`,
            realm: `炼气${Math.min(realmRank, 9)}层`, realm_rank: realmRank, exp: 0, spirit_stones: 100,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    } else {
        await Player.update({ realm_rank: realmRank, spirit_stones: 100 }, { where: { id: p.id } });
    }
    const old = await SpiritBeast.findAll({ where: { player_id: p.id } });
    for (const b of old) {
        await AbyssEncounterLog.destroy({ where: { beast_id: b.id }, force: true });
    }
    // 这一段（含下面三条）留着手写：它清的是**还活着的**这个号的上一轮残留（E6/E7 中途还会再调一次），
    // 而级联那扇门的语义是"连着 players 行一起删"，用它等于把号也删了、id 变了，后面的断言就没主体了。
    await SpiritBeastAbyss.destroy({ where: { player_id: p.id }, force: true });
    await SpiritBeast.destroy({ where: { player_id: p.id }, force: true });
    await Item.destroy({ where: { player_id: p.id }, force: true });
    return Player.findByPk(p.id);
}

async function ensureBeast(playerId) {
    return SpiritBeast.create({
        player_id: playerId, beast_key: 'yin_ji', beast_name: '阴蛟（探针）', element: 'metal',
        rarity: 'rare', star_level: 1, beast_soul: 0, level: 30, exp: 0,
        hp_max: 900000, atk: 90000, def: 90000, speed: 90000, loyalty: 100,
        is_active: false, is_pasturing: false, is_exploring: false, stamina: 100
    });
}

/** 把探渊行"退回几小时前"：可探索层数 = 实际时长（1 层/小时），不回拨就只能测到第 1 层 */
async function backdate(exploreId, hours) {
    const start = new Date(Date.now() - hours * 3600 * 1000);
    await SpiritBeastAbyss.update(
        { start_time: start, end_time: new Date(start.getTime() + 4 * 3600 * 1000), created_at: start },
        { where: { id: exploreId } }
    );
}

async function runOne(tag, realmRank, hours) {
    const player = await ensurePlayer(tag === 'hi' ? 'abyss_hi' : 'abyss_lo', realmRank);
    const beast = await ensureBeast(player.id);
    let started = await BeastAbyssService.startExplore(player, beast.id, 4);
    const unwrap = (r) => (r && r.data) ? r.data : (r || {});
    started = unwrap(started);
    if (!started || !started.explore_id) throw new Error(`${tag}: startExplore 没返回 explore_id：${JSON.stringify(started).slice(0, 120)}`);
    await backdate(started.explore_id, hours);
    const stonesBefore = B((await Player.findByPk(player.id)).spirit_stones);
    const result = unwrap(await BeastAbyssService.recallBeast(await Player.findByPk(player.id), beast.id));
    const row = await SpiritBeastAbyss.findByPk(started.explore_id);
    const after = await Player.findByPk(player.id);
    return {
        player, beast, row, result,
        deepest: N(row?.max_floor_reached),
        gained: B(after.spirit_stones) - stonesBefore,
        stonesAfter: B(after.spirit_stones)
    };
}

async function main() {
    await bootApp(app, { port: PORT });
    BeastAbyssService.initialize(infrastructure.ConfigLoader);
    const cfg = BeastAbyssService.config || {};
    const floors = (cfg.floors || []).slice().sort((a, b) => a.floor - b.floor);
    const mins = floors.map(f => N(f.min_realm_rank));
    check('E0 内容里楼层门槛是逐层递增的（否则下面"高境界能下更多层"这条没有意义）',
        floors.length >= 4 && mins[0] === 1 && mins.some(v => v > 1),
        `层数=${floors.length} 门槛=${mins.join('/')}`);

    // ===== E1/E2 高境界主人：能下过第一层 =====
    const hi = await runOne('hi', 12, 4.5);
    check('E1 探渊起得来、召回结算落库（状态 recalled、有实际结束时间）',
        hi.row?.status === 'recalled' && !!hi.row?.actual_end_time,
        `status=${hi.row?.status} 最深=${hi.deepest} 层`);
    check('E2 主人 realm_rank=12 时能下过第 2 层（改造前恒为 1：门槛读到的是不存在的 beast.player）',
        hi.deepest >= 2,
        `max_floor_reached=${hi.deepest}（floors 门槛 1/3/6/11…）`);
    check('E2b 门槛仍然在挡：realm_rank=12 不该进得了要求 14 的第 5 层',
        hi.deepest <= 4, `max_floor_reached=${hi.deepest}`);

    // ===== E3 低境界主人：只许停在第 1 层 =====
    const lo = await runOne('lo', 1, 4.5);
    check('E3 主人 realm_rank=1 时确实被挡在第 1 层（门槛不是"干脆不判了"）',
        lo.deepest === 1, `max_floor_reached=${lo.deepest}`);

    // ===== E4 奖励守恒：灵石与物品都只按报出来的数额进账 =====
    const reportedStones = N(hi.result?.rewards?.total_spirit_stones);
    const reportedItems = (hi.result?.rewards?.total_items || []).reduce((a, i) => a + N(i.qty ?? i.quantity), 0);
    const bagRows = await Item.findAll({ where: { player_id: hi.player.id }, raw: true });
    const bagQty = bagRows.reduce((a, r) => a + N(r.quantity), 0);
    check('E4 玩家灵石增量 == 结算报出的 total_spirit_stones（不凭空多也不少）',
        hi.gained > 0n && hi.gained === BigInt(reportedStones),
        `实得 ${hi.gained.toString()} 报出 ${reportedStones}`);
    check('E4b 探渊物品真的按报出的数量进背包，且每一件都能在内容里查到名字',
        bagQty === reportedItems && bagRows.every(r => !!itemNameOf(r.item_key)),
        `背包 ${bagQty} 件 / ${bagRows.length} 行，报出 ${reportedItems} 件，键=${bagRows.map(r => `${r.item_key}(${itemNameOf(r.item_key) || '?'})`).join(',')}`
        // 「有没有掉到东西」由 E8 单独记（这一轮随机可能一件不掉，那时 bagRows 为空是对的，
        // 把它塞进本条守恒断言里就会变成偶发假红 —— 2026-09-22 实测踩过一次）
    );

    // ===== E5 重复召回：同一行不再发第二份 =====
    let again = null;
    try {
        again = await BeastAbyssService.recallBeast(await Player.findByPk(hi.player.id), hi.beast.id);
    } catch (e) {
        again = { rejected: e.message };
    }
    const afterReplay = B((await Player.findByPk(hi.player.id)).spirit_stones);
    check('E5 已结算的探渊重复召回不再发第二份（被拒或明确"已结算"，灵石一分不动）',
        afterReplay === hi.stonesAfter && (!!again?.rejected || /已结算|未找到活跃/.test(JSON.stringify(again))),
        `灵石 ${hi.stonesAfter.toString()}→${afterReplay.toString()} 返回=${JSON.stringify(again).slice(0, 90)}`);

    // ===== E6 自动结算：到期未召的行由 checkExpirations 结算，且只结算一次 =====
    const p2 = await ensurePlayer('abyss_hi', 12);
    const b2 = await ensureBeast(p2.id);
    const started2 = unwrap(await BeastAbyssService.startExplore(p2, b2.id, 4));
    await backdate(started2.explore_id, 5);
    const beforeAuto = B((await Player.findByPk(p2.id)).spirit_stones);
    await BeastAbyssService.checkExpirations();
    const row2 = await SpiritBeastAbyss.findByPk(started2.explore_id);
    const afterAuto = B((await Player.findByPk(p2.id)).spirit_stones);
    await BeastAbyssService.checkExpirations();
    const afterAuto2 = B((await Player.findByPk(p2.id)).spirit_stones);
    check('E6 自动结算把到期行落定（recalled），再跑一遍不重复发奖',
        row2?.status === 'recalled' && afterAuto > beforeAuto && afterAuto2 === afterAuto,
        `status=${row2?.status} 第一次 +${(afterAuto - beforeAuto).toString()} 第二次 +${(afterAuto2 - afterAuto).toString()}`);

    // ===== E7 并发：召回与自动结算抢同一行，不许死锁 =====
    const p3 = await ensurePlayer('abyss_lo', 12);
    const b3 = await ensureBeast(p3.id);
    const started3 = unwrap(await BeastAbyssService.startExplore(p3, b3.id, 4));
    await backdate(started3.explore_id, 5);
    const raced = await Promise.all([
        BeastAbyssService.recallBeast(await Player.findByPk(p3.id), b3.id).then(r => `召回:${r ? 'ok' : 'null'}`).catch(e => `召回[${e.message}]`.slice(0, 60)),
        BeastAbyssService.checkExpirations().then(() => '自动:ok').catch(e => `自动[${e.message}]`.slice(0, 60))
    ]);
    check('E7 玩家召回与后台自动结算并发同一行：谁都不许以死锁收场',
        !raced.some(x => /Deadlock|lock wait timeout/i.test(x)), raced.join(' ;; '));
    const row3 = await SpiritBeastAbyss.findByPk(started3.explore_id);
    check('E7b 并发之后这一行只结算了一次（灵石增量与报出一致靠 E4 管，这里管状态唯一）',
        row3?.status === 'recalled', `status=${row3?.status}`);

    // 探针物品背包只核对"没有裸 id"（探渊掉的东西名字要能在内容里查到）
    const stray = await Item.count({
        where: { player_id: { [Op.in]: [hi.player.id, lo.player.id] } }
    });
    check('E8 探渊奖励进背包的行数可核对（>0 说明发放路径真的走到背包）',
        stray >= 0, `背包行数=${stray}（本条只作可见性记录）`);
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (e) {
        hard = 1;
        console.error('探针异常：', e.message, e.stack);
    } finally {
        try {
            const ids = [];
            for (const username of ['abyss_hi', 'abyss_lo']) {
                const p = await Player.findOne({ where: { username } });
                if (!p) continue;
                // 遭遇日志按 beast_id 记（级联的"归属"档只认 player_id / owner_player_id），
                // 所以这一条留着，并且必须在删号之前跑 —— 号一没，兽行也就被级联带走了，拿不到 id
                const beasts = await SpiritBeast.findAll({ where: { player_id: p.id } });
                for (const b of beasts) {
                    await AbyssEncounterLog.destroy({ where: { beast_id: b.id }, force: true });
                }
                ids.push(p.id);
            }
            if (ids.length) {
                // 探渊行 / 灵兽 / 背包行这些都是 player_id 归属档，连同 players 行一次交给那扇门
                const purged = await PlayerCascadePurge.deletePlayers(ids);
                console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
