/**
 * GM 删号的派生行清理：真库、真路由、真回滚（任务 #22）
 *
 * 背景（这条探针要守的东西）：`DELETE /api/admin/players/:id` 以前只清 items + admin_logs 两张表就把 players 行删了，
 * 而这个库**一个外键都没声明**（Sequelize sync() 不建 FK），数据库不会替它兜底。
 * 2026-09-22 在隔离库实测：82 张表按玩家列引用玩家，已删过的号在 25 张表上留着 925 行孤儿
 * （player_items 420、border_support_logs 95、multi_dungeon_cooldown 55…）。
 * 现在派生行由 `PlayerCascadePurge` 从 information_schema 现查清单来清。
 *
 * 这条探针判的是四件"只有连库才验得出来"的事：
 *   1. 清单在真 schema 上不是空的，也不是写死的（≥70 张表、含三张我播种的表、不含引用列）；
 *   2. 走真路由删号之后，**每一张**归属表对该 id 都是 0 行（不是"我以为清了的那几张"）；
 *   3. 别人记着这个号的行（garden_steal_logs.target_player_id 这种）**必须还在** —— 删错方向比留孤儿严重；
 *   4. 派生行与 players 行同生同死：回滚之后一份都没少（否则玩家会变成"号还在、数据全没"的空号，那才是真的丢数据）。
 * 再加一条控制跑：把旧写法（只清 items 就删号）原样复刻一遍，孤儿必须重新出现 ——
 * 不然上面第 2 条可能只是在测"库里本来就没东西"。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_player_cascade_purge.js
 *       自建 4 个探针号（cascdoomed01 / cascpeer01 / cascadmin01 / cascold01），退出前全部删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const { app } = require('../index');
const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerEquipment = require('../models/playerEquipment');
const SpiritBeast = require('../models/spiritBeast');
const PlayerFishing = require('../models/playerFishing');
const GardenStealLog = require('../models/gardenStealLog');
const Item = require('../models/item');
const InventoryService = require('../game/services/InventoryService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
const { bootApp, request, mintToken } = require('./lib/smoke_http');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

const countIn = async (table, column, playerId) => {
    const [rows] = await sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` = ${Number(playerId)}`);
    return Number(rows[0].n);
};

async function makePlayer(username, extra = {}) {
    // 上一轮探针如果中途崩了，这个用户名可能还挂着旧的 id 与它的派生行：先把旧号连派生行一起清，
    // 否则"删玩家行"自己就会造孤儿（这条探针正是来堵这个的，别在它自己的setup里犯）。
    const stale = await Player.findAll({ where: { username }, attributes: ['id'] });
    for (const row of stale) {
        await PlayerCascadePurge.purge(row.id);
        await sequelize.query(`DELETE FROM garden_steal_logs WHERE attacker_player_id = ${row.id} OR target_player_id = ${row.id}`);
    }
    await Player.destroy({ where: { username } });
    return Player.create({
        username, password: 'not-a-real-hash', nickname: username,
        realm: '筑基初期', realm_rank: 5, exp: 1000, spirit_stones: 100000,
        hp_current: 5000, lifespan_current: 100, lifespan_max: 200,
        attributes: {}, token_version: 0, ...extra
    });
}

/** 给一个号播种几张归属表的行（表要选"造得起"的，判据却是全部归属表） */
async function seedOwnedRows(player) {
    await InventoryService.addItem(player.id, 'diworm', 3, null);
    await PlayerEquipment.destroy({ where: { player_id: player.id } });
    await PlayerEquipment.create({
        player_id: player.id, slot: 'weapon', item_key: 'probe_cascade_blade', refine_level: 0,
        is_benming: 0, spirit_power: 0, sort_order: 0, is_summoned: 0, deep_line_state: {}
    });
    await SpiritBeast.destroy({ where: { player_id: player.id } });
    await SpiritBeast.create({
        player_id: player.id, beast_key: 'probe_cascade_beast', name: '孤儿兽', element: 'metal',
        rarity: 'common', star_level: 1, level: 1, hp_max: 100, atk: 10, def: 5, speed: 10,
        loyalty: 50, stamina: 100, is_active: true
    });
    await sequelize.query('DELETE FROM player_fishing WHERE player_id=:p', { replacements: { p: player.id } });
    await PlayerFishing.create({
        player_id: player.id, rod_tier: 1, skill_level: 1, skill_exp: 0, daily_casts: 0,
        daily_stone_earned: 0, daily_cultivation_earned: 0, buff_casts_remaining: 0,
        buff_luck_bonus: 0, total_catches: 0, total_success: 0, biggest_catch_kg: 0,
        rarest_catch_quality: 0, active_session: null
    });
}

(async () => {
    await bootApp(app, { port: PORT });

    /* P1 清单来自真 schema */
    const ownership = await PlayerCascadePurge.ownershipTables({ refresh: true });
    const owned = new Set(ownership.map(e => `${e.table}.${e.column}`));
    check('P1 归属清单在真库上非空、且把"归属"与"引用"分开了',
        ownership.length >= 70 && owned.has('player_items.player_id')
        && owned.has('player_equipment.player_id') && owned.has('spirit_beasts.player_id')
        && ![...owned].some(k => /_(?:killer|target|attacker|defender|challenger|winner|leader)_player_id$/.test(k)),
        `归属清单 ${ownership.length} 张表；players 自己在里面=${owned.has('players.player_id')}（必须 false）`);

    const doomed = await makePlayer('cascdoomed01');
    const peer = await makePlayer('cascpeer01');
    const admin = await makePlayer('cascadmin01', { role: 'admin' });
    await seedOwnedRows(doomed);
    // 活人（peer）记着死号的一条偷菜记录：这一行属于 peer 的历史，删号不该带走它
    const peerBeast = await SpiritBeast.create({
        player_id: peer.id, beast_key: 'probe_cascade_beast2', name: '偷菜兽', element: 'wood',
        rarity: 'common', star_level: 1, level: 1, hp_max: 100, atk: 10, def: 5, speed: 10,
        loyalty: 50, stamina: 100, is_active: true
    });
    const stealRow = await GardenStealLog.create({
        // 这张表是 underscored（模型属性 createdAt → 列 created_at），走模型插最省事
        attacker_player_id: peer.id, attacker_beast_id: peerBeast.id, target_player_id: doomed.id,
        stolen_qty: 2, result: 'success', counter_damage: 0, exp_gained: 0, loyalty_change: 0
    });
    const stealLogId = Number(stealRow.id);   // 探针自己记主键，收尾只删这一行

    /* P2 preview 对账：报告说多少行，库里就真是多少行 */
    const preview = await PlayerCascadePurge.preview(doomed.id);
    const perTable = new Map(preview.tables.map(t => [`${t.table}.${t.column}`, t.rows]));
    const actual = new Map();
    for (const entry of ownership) {
        const n = await countIn(entry.table, entry.column, doomed.id);
        if (n > 0) actual.set(`${entry.table}.${entry.column}`, n);
    }
    check('P2 preview 数出来的行与库里真有的行逐表相等（不是"顺手报了个数"）',
        preview.total > 0 && perTable.size === actual.size
        && [...actual].every(([k, v]) => perTable.get(k) === v),
        `preview=${JSON.stringify([...perTable])}｜实数=${JSON.stringify([...actual])}`);
    check('P3 引用列的行确实被算进"保留"而不是"会清掉"',
        preview.references.some(r => r.table === 'garden_steal_logs' && r.column === 'target_player_id' && r.rows === 1)
        && !perTable.has('garden_steal_logs.target_player_id'),
        `保留清单=${JSON.stringify(preview.references.map(r => `${r.table}.${r.column}=${r.rows}`))}`);

    /* P4 回滚不留半删状态（派生行与 players 行同生同死） */
    const t = await sequelize.transaction();
    await PlayerCascadePurge.purge(doomed.id, { transaction: t });
    await Player.destroy({ where: { id: doomed.id }, transaction: t });
    await t.rollback();
    const survivorPlayer = await Player.findByPk(doomed.id);
    const survivorRows = await countIn('player_items', 'player_id', doomed.id);
    check('P4 事务回滚之后号与派生行都还在（不许出现"号在数据没了"的空号）',
        !!survivorPlayer && survivorRows > 0 && perTable.get('player_items.player_id') === survivorRows,
        `players 行=${!!survivorPlayer}｜player_items=${survivorRows} 行（回滚前要 ${perTable.get('player_items.player_id') || 0}）`);

    /* P5 走真路由删号 */
    const adminToken = mintToken(admin);
    const del = await request({
        port: PORT, method: 'DELETE', path: `/api/admin/players/${doomed.id}`, token: adminToken
    });
    const body = del.body || {};     // lib/smoke_http 的 request() 已经把 JSON 解析好了（body 是对象，raw 才是原文）
    check('P5 GM 接口删号成功，回执报的清掉数与 preview 相等',
        del.status === 200 && body.code === 200 && body.purged_total === preview.total,
        `HTTP ${del.status}｜purged_total=${body.purged_total}｜preview=${preview.total}｜消息=${body.message || ''}${body.error ? '|err=' + body.error : ''}｜原文=${String(del.raw).slice(0, 160)}`);

    let leftovers = [];
    for (const entry of ownership) {
        const n = await countIn(entry.table, entry.column, doomed.id);
        if (n > 0) leftovers.push(`${entry.table}.${entry.column}=${n}`);
    }
    check('P6 删完之后遍历全部归属表：一张都不该留（判据覆盖清单，不覆盖"我播种的那几张"）',
        leftovers.length === 0, `残留=${leftovers.join(', ') || '无'}（共查 ${ownership.length} 张表）`);
    check('P7 活人记着死号的那行历史还在（删它等于替别人抹历史）',
        (await countIn('garden_steal_logs', 'target_player_id', doomed.id)) === 1
        && (await countIn('garden_steal_logs', 'attacker_player_id', peer.id)) === 1,
        `garden_steal_logs: target=${await countIn('garden_steal_logs', 'target_player_id', doomed.id)} 行`);

    /* P8 参数闸在真库上也不发语句 */
    const playersBefore = Number((await sequelize.query('SELECT COUNT(*) n FROM players'))[0][0].n);
    let threw = null;
    try { await PlayerCascadePurge.purge(undefined); } catch (e) { threw = e.message; }
    const playersAfter = Number((await sequelize.query('SELECT COUNT(*) n FROM players'))[0][0].n);
    check('P8 playerId 为空：抛错，且一行都没动（这条要是放行，就是"删全库"的形状）',
        /playerId/.test(threw || '') && playersBefore === playersAfter && playersBefore > 0,
        `抛错=${JSON.stringify((threw || '(没抛)').slice(0, 60))}｜players 行数 ${playersBefore}→${playersAfter}`);

    /* P9 控制跑：复刻旧写法（只清 items 就删号），孤儿必须重新出现 */
    const old = await makePlayer('cascold01');
    await seedOwnedRows(old);
    await Item.destroy({ where: { player_id: old.id } });
    await Player.destroy({ where: { id: old.id } });
    const orphanTables = [];
    for (const entry of ownership) {
        const n = await countIn(entry.table, entry.column, old.id);
        if (n > 0) orphanTables.push(`${entry.table}.${entry.column}=${n}`);
    }
    check('P9 控制跑：旧写法只清得掉 items，别的归属表照样留孤儿（说明 P6 是真判据，不是库里本来没东西）',
        orphanTables.length >= 2
        && (await countIn('player_items', 'player_id', old.id)) === 0
        && orphanTables.some(x => x.startsWith('player_equipment.'))
        && orphanTables.some(x => x.startsWith('spirit_beasts.')),
        `旧写法留下的孤儿=${orphanTables.join(', ') || '无'}`);
    // 用新清理把这条控制跑产生的孤儿收掉（探针不许给别人留脏数据）
    const fixOld = await PlayerCascadePurge.purge(old.id);

    await admin.update({ role: 'player' });
    for (const p of [peer, admin]) {
        await PlayerCascadePurge.purge(p.id);
        await Player.destroy({ where: { id: p.id } });
    }
    // 引用档刻意不随号删（那是活人的历史），所以探针自己插的那一行由探针自己按主键删
    await sequelize.query(`DELETE FROM garden_steal_logs WHERE id = ${stealLogId}`);
    const residue = await Promise.all([
        Player.count({ where: { username: ['cascdoomed01', 'cascpeer01', 'cascadmin01', 'cascold01'] } }),
        countIn('garden_steal_logs', 'target_player_id', doomed.id),
        countIn('spirit_beasts', 'player_id', peer.id),
        countIn('player_equipment', 'player_id', old.id)
    ]);
    check('TEARDOWN 四个探针号与它们产生的行都清干净',
        residue.every(n => n === 0),
        `残留=${residue.join('/')}｜控制跑补齐的行数=${fixOld.total}`);

    const passed = results.filter(r => r.ok).length;
    console.log(`\n${passed}/${results.length} 项通过，失败 ${results.length - passed} 项`);
    process.exit(passed === results.length ? 0 : 1);
})().catch(async error => {
    console.error('探针异常:', error);
    process.exit(1);
});
