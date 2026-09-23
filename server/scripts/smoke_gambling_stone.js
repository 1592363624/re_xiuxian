/**
 * 赌石这条链的活体判据（2026-09-23：把 gambling_stone_data 的产出池/线索/称号登记成可扩内容、
 * 并修掉"假线索从来没生效"之后补的 —— 之前这条玩法链在全仓**零活体覆盖**，jest 只能钉静态形状）
 *
 * 五组判据：
 *   G1 生成：回执里那几块石头真的在库里（不是一句"生成成功"）；
 *   G2 切开：**库里灵石增量 == 回执报的产出**、回执里每件材料都真的进了背包且数量对得上
 *      （钱写在改完规则的接口上判，不写在探测器上）；
 *   G3 假线索这层博弈真的在动：把 Math.random 钉成 0 与钉成 0.99 各生成一块，
 *      前者每条线索都被判假、后者一条都不判假 —— 本轮修的那个 bug（减幅键读错节 → NaN → 恒 false）
 *      在这两条上表现为"两边都是 0 个假线索"；
 *   G4/G5 热更：往仓库里那份配置临时加一种切法 → `hotUpdateConfig` → 服务的切法白名单与路由**不重启**就认它，
 *      并真用它切一块石头；随后按字节还原，再验一次白名单回到原样。
 *   G7 外发形状：`/stones` 每一行带 `clue_rows = [{key,name,value}]`，名字与顺序都取自内容；
 *      而后端记账那份 `_fakes`（哪几条线索是假的）不许出现在响应里 —— 它存在库行上是设计意图，漏给玩家等于把博弈送掉。
 *
 * 顺手在这条链上修掉的两处（都是"配了不报错、只是行为不对"那一族）：
 *   · 假线索减幅读错了节：代码读 `clues.fake_reduction_per_level`（不存在），内容里真身在 `skill` → 恒 NaN
 *     → `Math.random() < NaN` 恒 false → "每条线索 30% 是假的"这一层从来没生效过（G3 钉它）；
 *   · 挑假线索用 `do { 重抽 } while (抽到同一个)`：RNG 退化时会转死循环 —— 本探针第一版把 Math.random 钉成 0
 *     就正好挂在那里（生产不会挂，但任何"把随机钉死做确定性"的测试都会）。改成按偏移量一次取。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_gambling_stone.js
 *       自建探针号 gsblob01，退出前按账号名级联删号；配置文件由 finally + exit 钩子双重还原。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5103);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const Item = require('../models/item');
const PlayerStoneRecords = require('../models/playerStoneRecords');
const PlayerGamblingStone = require('../models/playerGamblingStone');
const sequelize = require('../config/database');
const configLoader = require('../modules/infrastructure/ConfigLoader');
const { bootApp, request, mintToken } = require('./lib/smoke_http');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const PROBE_USERNAME = 'gsblob01';
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'gambling_stone_data.json');
const PROBE_CUT = 'zz_probe_cut';
const results = [];
const originalBytes = fs.readFileSync(CONFIG_FILE);

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 把配置文件按字节还原（崩溃时由 exit 钩子兜底；热更要单独 await，见下） */
function restoreBytes() {
    const current = fs.readFileSync(CONFIG_FILE);
    if (!current.equals(originalBytes)) fs.writeFileSync(CONFIG_FILE, originalBytes);
}
// `hotUpdateConfig` 是 async（里面 `await loadConfig`）—— 不 await 就会看到"慢一拍"的旧配置：
// 探针第一版就是这么误判成"服务还在缓存旧副本"的，热更本身没问题。
const hotUpdate = () => configLoader.hotUpdateConfig('gambling_stone_data');
process.on('exit', () => { try { restoreBytes(); } catch { /* 收尾尽力而为 */ } });

const stonesOf = playerId => PlayerStoneRecords.findAll({ where: { player_id: playerId, is_cut: 0 } });
const stones = data => (data && (data.stones || data.created || data.list)) || [];
/** 每天只能生成有限几块：探针要反复生成，所以每次都先把计数归零（回执=库行数那条判据仍盯着别失控） */
const resetDaily = playerId => sequelize.query(
    'UPDATE player_gambling_stone SET daily_generates = 0, daily_reset_date = NULL WHERE player_id = ' + playerId
);

(async () => {
    await bootApp(app, { port: PORT });
    await PlayerCascadePurge.deleteByUsernames([PROBE_USERNAME]);
    const player = await Player.create({
        username: PROBE_USERNAME, password: 'not-a-real-hash', nickname: '赌石探针',
        realm: '结丹中期', realm_rank: 15, exp: 1000000, spirit_stones: 200000000,
        hp_current: 20000, mp_current: 5000, lifespan_current: 200, lifespan_max: 900,
        attributes: {}, token_version: 0
    });
    const token = mintToken(player);
    const call = (method, p, body) => request({ port: PORT, method, path: p, token, body });
    const GamblingStoneService = require('../game/services/GamblingStoneService');

    // G1 生成
    await PlayerStoneRecords.destroy({ where: { player_id: player.id } });
    const generated = await call('POST', '/api/gambling-stone/generate', {});
    const rows = await stonesOf(player.id);
    check('G1 生成原石：回执里那几块真的在库里（不是一句"生成成功"）',
        generated.status === 200 && generated.body.code === 200 && rows.length > 0,
        `status=${generated.status}, 回执消息=${generated.body.message}, 库里未切开=${rows.length} 行`);

    // G2 切开：钱与材料都要按回执落地
    const before = await Player.findByPk(player.id);
    const target = rows[0];
    const cut = await call('POST', '/api/gambling-stone/cut', { stone_id: target.id, cut_method: 'rough' });
    const yield_ = (cut.body && (cut.body.data?.yield || cut.body.data?.result || cut.body.data)) || {};
    const reportedStones = Number(yield_.spirit_stones || 0);
    const after = await Player.findByPk(player.id);
    const landedStones = Number(BigInt(after.spirit_stones) - BigInt(before.spirit_stones));
    const reportedItems = Array.isArray(yield_.items) ? yield_.items : [];
    const itemRows = reportedItems.length
        ? await Item.findAll({ where: { player_id: player.id, item_key: reportedItems.map(i => i.item_id) } })
        : [];
    const itemsOk = reportedItems.every(entry => {
        const row = itemRows.find(r => r.item_key === entry.item_id);
        return row && Number(row.quantity) >= Number(entry.quantity || 1);
    });
    check('G2a 切开：库里灵石增量 == 回执报的产出（列上原子加，不多不少）',
        cut.status === 200 && cut.body.code === 200 && reportedStones > 0 && landedStones === reportedStones,
        `回执=${JSON.stringify({ stones: reportedStones, cult: Number(yield_.cultivation || 0) })}, 库里灵石 ${before.spirit_stones}→${after.spirit_stones}（+${landedStones}）, 消息=${cut.body.message}`);
    check('G2b 切开：回执里每件材料都进了背包（数量 ≥ 回执）',
        itemsOk,
        `回执材料=${JSON.stringify(reportedItems.map(i => `${i.item_id}x${i.quantity}`))}, 背包=${JSON.stringify(itemRows.map(r => `${r.item_key}x${r.quantity}`))}`);
    check('G2c 切开之后那块石头标成已切（不是一刀砍两次）',
        (await stonesOf(player.id)).length === rows.length - 1,
        `未切开 ${rows.length}→${(await stonesOf(player.id)).length}`);

    // G3 假线索这层博弈
    const realRandom = Math.random;
    async function clueFakeCount(seed) {
        Math.random = seed;
        try {
            await PlayerStoneRecords.destroy({ where: { player_id: player.id, is_cut: 0 } });
            await resetDaily(player.id);
            await call('POST', '/api/gambling-stone/generate', {});
            const fresh = await stonesOf(player.id);
            const clues = fresh[0]?.clues || {};
            return { fakes: (clues._fakes || []).length, sample: JSON.stringify(clues).slice(0, 90) };
        } finally { Math.random = realRandom; }
    }
    const alwaysFake = await clueFakeCount(() => 0);
    const alwaysReal = await clueFakeCount(() => 0.99);
    check('G3 「每条线索 30% 是假的」这层博弈真的在动（减幅那颗键以前读错了节 → 恒 false）',
        alwaysFake.fakes >= 1 && alwaysReal.fakes === 0,
        `钉 0：假线索 ${alwaysFake.fakes} 条 ${alwaysFake.sample}；钉 0.99：假线索 ${alwaysReal.fakes} 条`);

    // G7 外发的线索形状：有序行 + 内容里的中文名，且后端那份「哪几条是假的」不漏给玩家
    const listBody = await call('GET', '/api/gambling-stone/stones', {});
    const listed = stones(listBody.body?.data);
    const firstRows = listed[0]?.clue_rows;
    const contentNames = Object.entries(configLoader.peekConfig('gambling_stone_data').clues)
        .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v?.values))
        .map(([k, v]) => ({ key: k, name: v.name }));
    check('G7 外发线索 = 按内容排好的 {key,name,value} 行，且不泄漏 _fakes',
        Array.isArray(firstRows) && firstRows.length === contentNames.length
        && firstRows.every((row, i) => row.key === contentNames[i].key && row.name === contentNames[i].name)
        && !JSON.stringify(listed).includes('_fakes'),
        `行数=${firstRows?.length}（内容里 ${contentNames.length} 维）, 首行=${JSON.stringify(firstRows?.[0])}, 前几名=${(firstRows || []).map(r => r.name).join('/')}`);

    // G4 热更一种切法：不重启就要能用（路由的白名单读的就是服务那一份现读配置）
    const mutated = JSON.parse(originalBytes.toString('utf8'));
    mutated.cut_methods[PROBE_CUT] = {
        name: '探针切法', description: '只在探针运行期间存在', cost_spirit_stones: 0,
        cost_dayan_level: 0, loss_rate: 0, guarantee_rare: false
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(mutated, null, 2));
    await hotUpdate();
    const keysAfterHotUpdate = GamblingStoneService.cutMethodKeys();
    await PlayerStoneRecords.destroy({ where: { player_id: player.id, is_cut: 0 } });
    await resetDaily(player.id);
    await call('POST', '/api/gambling-stone/generate', {});
    const hotStone = (await stonesOf(player.id))[0];
    const hotCut = await call('POST', '/api/gambling-stone/cut', { stone_id: hotStone?.id, cut_method: PROBE_CUT });
    check('G4 热更加一种切法：不重启，服务白名单与路由就认它，并真能切',
        keysAfterHotUpdate.includes(PROBE_CUT) && hotCut.status === 200 && hotCut.body.code === 200,
        `白名单=${keysAfterHotUpdate.join('/')}，切法回执 status=${hotCut.status}，消息=${hotCut.body.message}`);

    // G5 还原
    restoreBytes();
    await hotUpdate();
    const keysRestored = GamblingStoneService.cutMethodKeys();
    check('G5 还原：配置文件逐字节回到开始时那份，白名单里没有探针切法',
        fs.readFileSync(CONFIG_FILE).equals(originalBytes) && !keysRestored.includes(PROBE_CUT),
        `白名单=${keysRestored.join('/')}`);

    // 收尾：按账号名级联删号，再验这三张表没有残留
    await PlayerCascadePurge.deleteByUsernames([PROBE_USERNAME]);
    const leftover = {
        player: await Player.count({ where: { username: PROBE_USERNAME } }),
        stones: await PlayerStoneRecords.count({ where: { player_id: player.id } }),
        profile: await PlayerGamblingStone.count({ where: { player_id: player.id } }),
        items: await Item.count({ where: { player_id: player.id } })
    };
    check('G6 探针号与它的赌石记录/背包行都清干净',
        Object.values(leftover).every(n => n === 0),
        JSON.stringify(leftover));

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async error => {
    console.error('探针自身失败:', error);
    try { restoreBytes(); await PlayerCascadePurge.deleteByUsernames([PROBE_USERNAME]); } catch { /* 已经报错了 */ }
    process.exit(2);
});
