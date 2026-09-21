/**
 * 放养 ↔ 偷菜 并发探针（需要 MySQL，走 .env 指向的库）
 *
 * 测的是 BeastPastureService 的锁顺序契约：SpiritBeast → SpiritBeastPasture → PlayerGarden。
 * 改之前 stealCrops 用**无锁**读拿放养记录，然后 save() 整行写回（steal_count / steal_yields），
 * 而 recallBeast 是「先锁放养行、再锁灵兽行」—— 两把锁的获取次序正好相反，于是：
 *   1) ABBA 死锁：其中一笔被 MySQL 杀掉，玩家看到 500；
 *   2) 丢失更新：召回写下的 status=recalled / actual_end_time / yield_snapshot 被偷菜那笔
 *      按旧快照整行写回去，放养记录复活成 active，产物凭空消失。
 * 这两种都只在两个请求交错时出现，单请求永远正确，所以纯逻辑测试测不到，必须真并发打。
 *
 * 每轮都重新播种，跑 ROUNDS 轮，断言的是不变量而不是某一轮的顺序：
 *   - 两笔请求都不许出现 500/超时（死锁）
 *   - 召回返回 200 时，落库必须是已结束态（不许被写回 active）
 *   - 偷菜成功且召回也成功时，两笔的写入必须同时可见
 *   - 至少要有 1 轮真的命中「偷菜成功 + 召回 200」的交叉，否则整个探针是空测
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_pasture_race.js
 *       探针自建两个专用账号（smokepasture / smokepasture_victim），只动它们的行。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5090);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const SpiritBeast = require('../models/spiritBeast');
const SpiritBeastPasture = require('../models/spiritBeastPasture');
const PlayerGarden = require('../models/playerGarden');
const GardenStealLog = require('../models/gardenStealLog');
const sequelize = require('../config/database');
const { bootApp, request, mintToken } = require('./lib/smoke_http');

const ROUNDS = Number(process.env.SMOKE_ROUNDS || 10);
const THIEF = 'smokepasture';
const VICTIM = 'smokepasture_victim';
const SEED_ID = 'spirit_seed';
const PRODUCE_ITEM_ID = 'wild_herb';

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function post(token, path, body) {
    const res = await request({ port: PORT, method: 'POST', path, token, body });
    return { code: res.body?.code ?? res.status, status: res.status, body: res.body, raw: res.raw };
}

/** 偷菜成功率 = base + 速度 + 忠诚 + 星级 + 无护院加成，把灵兽喂满即可稳定 >1，让交叉可复现 */
async function ensurePlayer(username, nickname) {
    let player = await Player.findOne({ where: { username } });
    if (!player) {
        player = await Player.create({
            username,
            password: 'not-a-real-hash',
            nickname,
            realm: '炼气3层',
            realm_rank: 4,
            exp: 0,
            spirit_stones: 0,
            hp_current: 1000,
            mp_current: 1000,
            lifespan_current: 20,
            attributes: {},
            token_version: 0
        });
    }
    return player;
}

async function ensureBeast(playerId) {
    let beast = await SpiritBeast.findOne({ where: { player_id: playerId } });
    if (!beast) {
        beast = await SpiritBeast.create({
            player_id: playerId,
            beast_key: 'qingyun_wolf',
            beast_name: '探针青狼',
            element: 'metal',
            rarity: 'rare',
            star_level: 10,
            level: 10,
            exp: 0,
            hp_max: 5000,
            atk: 100,
            def: 100,
            speed: 300,
            loyalty: 100,
            is_active: false,
            is_pasturing: false,
            stamina: 100
        });
    }
    return beast;
}

async function seedRound(thief, victim, beastId) {
    await GardenStealLog.destroy({ where: { attacker_player_id: thief.id } });
    await SpiritBeastPasture.destroy({ where: { player_id: thief.id } });
    await SpiritBeast.update(
        { is_pasturing: false, is_active: false, speed: 300, loyalty: 100, star_level: 10 },
        { where: { id: beastId } }
    );
    // 被偷方不能带护院（出战灵兽），否则拦截会把结果随机掉，交叉就不可复现了
    await SpiritBeast.update({ is_active: false }, { where: { player_id: victim.id } });

    let plot = await PlayerGarden.findOne({ where: { player_id: victim.id, plot_index: 1 } });
    const fields = {
        seed_id: SEED_ID,
        produce_item_id: PRODUCE_ITEM_ID,
        status: 'mature',
        base_yield: 9,
        planted_at: new Date(Date.now() - 3 * 3600 * 1000),
        mature_at: new Date(Date.now() - 2 * 3600 * 1000)
    };
    if (plot) await plot.update(fields);
    else await PlayerGarden.create({ player_id: victim.id, plot_index: 1, ...fields });
}

async function main() {
    await bootApp(app, { port: PORT });

    const thief = await ensurePlayer(THIEF, '放养探针');
    const victim = await ensurePlayer(VICTIM, '药园探针');
    const beast = await ensureBeast(thief.id);
    const thiefToken = mintToken(thief);

    let hardFailures = [];
    let lostUpdates = [];
    let clobberedRecalls = [];
    let overlapRounds = 0;
    let stealSuccess = 0;
    let stealRejected = 0;
    let otherOutcomes = 0;
    let recallOk = 0;

    for (let round = 1; round <= ROUNDS; round++) {
        await seedRound(thief, victim, beast.id);
        const start = await post(thiefToken, '/api/spirit-beast/pasture/start', {
            beast_id: beast.id,
            location_key: 'qingyun_mountain',
            duration_hours: 1
        });
        if (start.code !== 200) {
            hardFailures.push(`第${round}轮放养启动就失败: ${JSON.stringify(start.body || start.raw)}`);
            break;
        }

        // 核心：两笔请求争同一条"灵兽 → 放养记录"的锁。
        // 一半轮次延迟 40ms 再发召回 —— 偷菜那笔前面要先查两张冷却表，天然比召回慢，
        // 同时发基本是召回先跑完（实测有整轮 0 交叉的情况，那样"两笔写入都在"就成了空断言）。
        // 让召回正好落在偷菜的"读放养记录 → 整行写回"窗口里，才是这条缺陷的靶心。
        const delayed = round % 3 !== 0;
        const stealPromise = post(thiefToken, '/api/spirit-beast/pasture/steal', {
            beast_id: beast.id,
            target_player_id: victim.id,
            target_plot_index: 1
        });
        const recallPromise = (delayed
            ? new Promise(resolve => setTimeout(resolve, 40)).then(() => null)
            : Promise.resolve()
        ).then(() => post(thiefToken, '/api/spirit-beast/pasture/recall', { beast_id: beast.id }));

        const [steal, recall] = await Promise.all([stealPromise, recallPromise]);

        const row = await SpiritBeastPasture.findByPk(start.body.data.pasture_id);
        const afterBeast = await SpiritBeast.findByPk(beast.id);
        const detail = `第${round}轮 steal=${steal.code}/${steal.body?.data?.result ?? '-'} recall=${recall.code} db=${row?.status}/${row?.recall_type}`;

        for (const [label, res] of [['steal', steal], ['recall', recall]]) {
            if (res.status >= 500 || res.body?.code === 500 || res.status === 0) {
                hardFailures.push(`${detail} ${label} 失败态: ${JSON.stringify(res.body || res.raw)}`);
            }
        }
        if (steal.body?.data?.result === 'success') stealSuccess++;
        else if (steal.code === 400) stealRejected++;
        else if (['failed', 'intercepted'].includes(steal.body?.data?.result)) otherOutcomes++;
        else hardFailures.push(`${detail} steal 返回了预期外的码: ${JSON.stringify(steal.body || steal.raw)}`);

        if (recall.code === 200) {
            recallOk++;
            if (!row || row.status === 'active' || !row.actual_end_time) {
                clobberedRecalls.push(`${detail} 召回写回放养行后被整行盖回: ${JSON.stringify(row && { s: row.status, e: row.actual_end_time })}`);
            }
            if (steal.body?.data?.result === 'success') {
                overlapRounds++;
                const yields = Array.isArray(row?.steal_yields) ? row.steal_yields : [];
                if (!row || Number(row.steal_count) < 1 || yields.length < 1) {
                    lostUpdates.push(`${detail} 偷菜的写入被召回抹掉: steal_count=${row?.steal_count} yields=${yields.length}`);
                }
            }
        }
        if (afterBeast?.is_pasturing) hardFailures.push(`${detail} 灵兽 is_pasturing 未复位`);
        console.log(`  · ${detail}`);
    }

    check('并发 steal/recall 不出现 500、超时或死锁', hardFailures.length === 0,
        hardFailures.slice(0, 3).join(' | ') || `${ROUNDS} 轮全部干净`);
    check('召回成功时放养行不会被旧快照写回 active', clobberedRecalls.length === 0,
        clobberedRecalls.slice(0, 3).join(' | ') || `召回 200 共 ${recallOk} 轮`);
    check('偷菜与召回同时成功时两笔写入都在', lostUpdates.length === 0,
        lostUpdates.slice(0, 3).join(' | ') || `交叉 ${overlapRounds} 轮`);
    check('探针不是空测：至少 1 轮真的出现「偷菜成功 + 召回 200」', overlapRounds >= 1,
        `偷菜成功 ${stealSuccess} 轮 / 召回先提交被拒 ${stealRejected} 轮 / 未命中 ${otherOutcomes} 轮 / 交叉 ${overlapRounds} 轮`);
    check('两把锁的争用真的发生过（召回与偷菜并非各跑各的）', recallOk >= 1 && stealSuccess + stealRejected >= 1,
        `recall200=${recallOk}`);
}

(async () => {
    await main();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
