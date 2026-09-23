/**
 * 删号时的派生行清理（"归属"随号走，"引用"原样留着）。
 *
 * 为什么要有这个文件：`DELETE /api/admin/players/:id` 以前只清两张表（items、admin_logs）就把 players 行删了。
 * 这个库里**一个外键都没声明**（Sequelize 的 sync() 不建 FK），所以没有任何东西替它兜底 ——
 * 实测（2026-09-22，隔离库 re_xiuxian_test）：82 张表按玩家列引用玩家，删过的号在 **25 张表上留下 925 行孤儿**
 * （player_items 420、border_support_logs 95、multi_dungeon_cooldown 55、fish_album 36、player_recipes 34…）。
 * 后果不是"脏数据"这么简单：`border_milestone_rewards` 是"这档已经发过了"的记账表，
 * `multi_dungeon_cooldown` / `spirit_beast_pvp_rankings` / `pvp_rankings` 是按玩家聚合的榜与冷却 ——
 * 死号占着的行会一直参与统计，而探针与 GM 面板每次都要自己想起来"顺手清一下这三张表"（漏一张就是一种假绿）。
 *
 * 两档口径（这是本文件唯一需要判断的地方，写清楚免得以后随手加列）：
 *   归属列 OWNERSHIP —— 这一行**就是**这个玩家的资产/记录，号没了它就该没：`player_id`、`owner_player_id`。
 *   引用列 REFERENCE —— 这一行是**别人**的历史，只是点了这个人的名字：`killer_player_id`、
 *     `attacker_player_id` / `target_player_id`（偷菜日志：记录属于被偷的那位）、`challenger`/`defender`/`winner`、
 *     `leader_player_id`（副本实例/宗门账本，属于全队）、`admin_id`（审计，必须活过被删的号）。
 *     **这一档一律不动** —— 删它就是替活人抹掉他们的历史，比留孤儿严重得多。
 *   `defender_player_ids` 这种"一列装多个 id"的（sect_war_territories）两档都不进：等值匹配不了，
 *     真要处理得单独设计（本文件会把它报成"未覆盖的引用"而不是假装清掉了）。
 *
 * 表清单不写死在代码里：每次从 `information_schema` 现查（`TABLE_SCHEMA = DATABASE()`，不写库名）。
 * 这正是这套改造一贯的口径 —— **新增一张带 `player_id` 的表不需要改这个文件**，
 * 它自动进"归属"档被清掉；新增一张带 `*_victim_player_id` 的表自动进"引用"档被留着并报告。
 * 这条性质由 tests/PlayerCascadePurge.test.js 钉住（含控制跑），并且有一条底线防止查询本身坏掉变成空清单。
 */
'use strict';

const sequelize = require('../../config/database');
const { logOnce } = require('../../utils/logOnce');

/** 归属列：见文件头两档口径 */
const OWNERSHIP_COLUMNS = ['player_id', 'owner_player_id'];

/**
 * 归属档里的例外（表名 → 为什么不能随号删）。空表是正常状态；
 * 出现条目就必须带理由，且这条由 tests/PlayerCascadePurge.test.js 反向钉住（表不存在时报"豁免过期"）。
 */
const OWNERSHIP_DENY = new Map([]);

/** 匹配"某个玩家的引用列"，用来出报告（不改数据） */
const REFERENCE_PATTERN = /^[a-z_]+_player_id$/;

let cache = null;

/** 现查 information_schema：BASE TABLE（视图不能删）× 归属列名 */
async function loadOwnershipTables(transaction) {
    const sql = `
        SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES t
          ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE()
          AND t.TABLE_TYPE = 'BASE TABLE'
          AND c.COLUMN_NAME IN (${OWNERSHIP_COLUMNS.map(col => sequelize.escape(col)).join(', ')})
        ORDER BY c.TABLE_NAME`;
    const [rows] = await sequelize.query(sql, transaction ? { transaction } : {});
    return rows
        .filter(r => r.table_name !== 'players')
        .filter(r => !OWNERSHIP_DENY.has(r.table_name))
        .map(r => ({ table: r.table_name, column: r.column_name }));
}

/** 进程内缓存一次：表结构在运行期不变，而删号是低频动作，每次现查也没成本 —— 但报告与删除要用同一份清单 */
async function ownershipTables({ refresh = false, transaction = null } = {}) {
    if (!cache || refresh) cache = await loadOwnershipTables(transaction);
    if (!cache.length) {
        // 空清单意味着"什么都没清"，而调用方会以为删干净了 —— 这比不清更危险，必须响并且抛。
        const message = '[PlayerCascadePurge] information_schema 里一张带 player_id 的表都没找到：'
            + '数据库账号读不到 information_schema，或者列名口径变了。拒绝把"什么都没清"当成"已经清干净"。';
        logOnce('playerCascadePurge.emptyOwnershipList', message);
        throw new Error(message);
    }
    return cache;
}

/** 纯函数：把一份 (table, column) 清单按两档口径分开 —— 单测用合成清单驱动它，不碰库 */
function classify(entries) {
    const ownership = new Set(OWNERSHIP_COLUMNS);
    const purge = [];
    const references = [];
    const uncovered = [];
    for (const entry of entries) {
        if (entry.table === 'players' || OWNERSHIP_DENY.has(entry.table)) continue;
        if (ownership.has(entry.column)) purge.push(entry);
        else if (REFERENCE_PATTERN.test(entry.column)) references.push(entry);
        else uncovered.push(entry);      // 例如复数列 defender_player_ids：等值匹配不了，只能点名
    }
    return { purge, references, uncovered };
}

/** 删号是"整条链一起走或一起不走"的操作，参数必须是一个明确的用户 id */
function assertPlayerId(playerId) {
    // 路由参数天然是字符串，所以认"纯数字字符串"；其余（undefined/null/0/负数/小数/带任何东西的串）一律拒。
    const text = typeof playerId === 'string' ? playerId.trim() : null;
    const id = typeof playerId === 'string' ? (/^\d+$/.test(text) ? Number(text) : NaN) : Number(playerId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`PlayerCascadePurge：playerId 必须是正整数，收到 ${JSON.stringify(playerId)} `
            + '—— 传空值会让每条语句变成"匹配不到任何行"或更糟，绝不猜');
    }
    return id;
}

const quoted = (table) => `\`${table}\``;

/**
 * 逐表数一遍/清一遍。
 *
 * 数与删都用**同一句 COUNT** 作为报出的数（Sequelize 对 `type: DELETE` 的返回值形状在 v6 里不是
 * `[rows, meta]` 那个形状 —— 拿到的是裸 OkPacket，按元组解构会直接 `TypeError: (intermediate value) is not iterable`，
 * 实测于本机 8.0.29 + sequelize 6.37）。删完再数也不行：那时候已经没有"删掉了多少"这个事实可读了。
 * 所以：先数 → 报这个数 → 非 dryRun 就删。两者必然同数（同一个事务、同一个 id、没人会给死号造新行）。
 * @param {number} playerId
 * @param {{dryRun?: boolean, transaction?: Object, entries?: Array}} [options]
 * @returns {Promise<{tables: Array<{table:string,column:string,rows:number}>, total:number, dryRun:boolean}>}
 */
async function applyOwnership(playerId, options = {}) {
    const id = assertPlayerId(playerId);
    const { dryRun = false, transaction = null } = options;
    // 清单来源可以是缓存、调用方给的（迁移脚本会传），但**删哪些**只认 `classify` 的归属档：
    // information_schema 那句 SQL 本来就只取归属列，这里是第二道闸 —— 万一哪天列名口径变了、
    // 或者有人从别处喂进来一份清单，引用档（killer_player_id 这种）也删不掉。
    // "替活人抹掉他们的历史"比留一排孤儿严重得多，所以这道闸值得多一次纯函数调用。
    const entries = classify(options.entries || await ownershipTables({ transaction })).purge;
    const tables = [];
    let total = 0;
    for (const entry of entries) {
        // id 已被 assertPlayerId 钉成纯数字，没有注入面；列名/表名来自 information_schema，用反引号包住
        const where = `${quoted(entry.column)} = ${id}`;
        const [rows] = await sequelize.query(
            `SELECT COUNT(*) AS n FROM ${quoted(entry.table)} WHERE ${where}`,
            transaction ? { transaction } : {}
        );
        const n = Number(rows[0].n);
        if (!n) continue;
        if (!dryRun) {
            await sequelize.query(`DELETE FROM ${quoted(entry.table)} WHERE ${where}`,
                transaction ? { transaction } : {});
        }
        tables.push({ table: entry.table, column: entry.column, rows: n });
        total += n;
    }
    return { tables, total, dryRun };
}

/** 归属列 + 引用列一起的清单：从 information_schema 按"名字像玩家列"筛，用于出报告与"未覆盖"点名 */
async function loadPlayerColumns(transaction) {
    const sql = `
        SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES t
          ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE()
          AND t.TABLE_TYPE = 'BASE TABLE'
          AND (c.COLUMN_NAME IN (${OWNERSHIP_COLUMNS.map(col => sequelize.escape(col)).join(', ')})
               OR c.COLUMN_NAME REGEXP '^[a-z_]+_player_ids?$'
               OR c.COLUMN_NAME = 'admin_id')
        ORDER BY c.TABLE_NAME`;
    const [rows] = await sequelize.query(sql, transaction ? { transaction } : {});
    return rows.map(r => ({ table: r.table_name, column: r.column_name }));
}

/** 引用列数一遍（只读）：GM 看得到"这个号还被谁的记录点着名"，那是要人判断的部分，不自动动手 */
async function countReferences(playerId, options = {}) {
    const id = assertPlayerId(playerId);
    const { transaction = null } = options;
    const { references, uncovered } = classify(await loadPlayerColumns(transaction));
    const out = [];
    for (const entry of references.concat(uncovered.map(e => ({ ...e, unmatched: true })))) {
        if (entry.table === 'players') continue;
        const [rows] = await sequelize.query(
            `SELECT COUNT(*) AS n FROM ${quoted(entry.table)} WHERE ${quoted(entry.column)} = ${id}`,
            transaction ? { transaction } : {}
        );
        const n = Number(rows[0].n);
        if (n > 0) out.push({ table: entry.table, column: entry.column, rows: n, needs_decision: true });
    }
    return out;
}

/**
 * 真正删派生行。调用方负责事务与 players 行本身（这样"清派生 + 删号"是同生同死的）。
 * @returns {Promise<{tables:Array,total:number}>}
 */
async function purge(playerId, options = {}) {
    const result = await applyOwnership(playerId, options);
    return { tables: result.tables, total: result.total };
}

/**
 * 批量版（探针收尾、GM 清一排号都用得上）。
 * 逐个走同一个 purge，所以每个 id 都要过 `assertPlayerId`：清单里混进 undefined 会直接抛，
 * 而不是"跳过那一个"—— 跳过就等于给那个号留下一堆孤儿行，而调用方以为全清了。
 * @returns {Promise<{total:number, perPlayer:Array}>}
 */
async function purgeMany(playerIds, options = {}) {
    if (!Array.isArray(playerIds)) {
        throw new Error(`PlayerCascadePurge.purgeMany：要传 id 数组，收到 ${JSON.stringify(playerIds)}`);
    }
    const perPlayer = [];
    let total = 0;
    for (const id of playerIds) {
        const out = await purge(id, options);
        perPlayer.push({ player_id: assertPlayerId(id), total: out.total });
        total += out.total;
    }
    return { total, perPlayer };
}

/** 只数不动（GM 确认框与探针都用它拿"将要清掉多少"的数） */
async function preview(playerId, options = {}) {
    const ownership = await applyOwnership(playerId, { ...options, dryRun: true });
    const references = await countReferences(playerId, options);
    return { tables: ownership.tables, total: ownership.total, references };
}

/**
 * 删号：派生行 + players 行一次带走。
 *
 * 为什么要多这一层，而不是让调用方自己 `purge()` + `Player.destroy()`：
 * 现网 35 个探针各自手写"收尾要清哪几张表"（`smoke_duel` 和 `smoke_bounty` 甚至各抄了一份同名 `wipe()`），
 * 漏一张就是一种孤儿，而新增玩法时每多一张带 `player_id` 的表就多一个漏点。把"删号"收成一次调用，
 * 调用方就没有"想起哪几张"的能力 —— 也就没有想不起的代价。
 *
 * 三条比 `Player.destroy` 更硬的默认口径（都是被真实事故形状逼出来的）：
 *   1. **id 在 players 里找不到就抛**。`destroy` 匹配不到时静默返回 0，于是"以为删了"的号会一直占着
 *      按玩家聚合的榜与冷却，下一轮探针读到上一轮的残留还当成断言通过。
 *   2. **`role='admin'` 的号不删**（要删得显式传 `includeAdmin`）。探针里"临时把探针号提成管理员、用完改回去"
 *      是常用手法（`smoke_option_lists` V8）；万一某条路数在提权状态下就走了收尾，静默删掉的是真账号。
 *   3. **只按 id 删不够**：探针崩溃时留下的残留行按 id 永远找不回来（下一轮是新 id），所以给一条
 *      `deleteByUsernames`，按账号名把"同名号的历次残留"一起收掉。
 *
 * 与 `purge()` 一样走裸 SQL：本模块不 require 任何模型（`models/player` 挂着 beforeSave/beforeBulkUpdate
 * 守卫，把它拽进来只是多一条循环依赖面，而 `Player` 现在也没有 beforeDestroy 钩子）。
 * @param {number|string} playerId
 * @param {{transaction?: Object, allowMissing?: boolean, includeAdmin?: boolean}} [options]
 * @returns {Promise<{player_id:number, username:string, total:number, tables:Array}>}
 */
async function deletePlayer(playerId, options = {}) {
    const out = await deletePlayers([playerId], options);
    const [one] = out.per_player;
    if (!one) {
        // 只有 allowMissing 才走到得了这里（默认路径在 deletePlayers 里就抛了）
        throw new Error(`PlayerCascadePurge.deletePlayer：id ${playerId} 没有对应的 players 行，`
            + '而单个删号必须落在一个真实存在号上（返回"删了 0 行"会让调用方以为清干净了）');
    }
    return { player_id: one.player_id, username: one.username, total: one.total, tables: one.tables };
}

/**
 * 批量版（探针收尾最常见：一轮造 2-6 个号）。
 * @param {Array<number|string>} playerIds
 * @returns {Promise<{ids:number[], skipped:Array, total:number, per_player:Array}>}
 */
async function deletePlayers(playerIds, options = {}) {
    if (!Array.isArray(playerIds)) {
        throw new Error(`PlayerCascadePurge.deletePlayers：要传 id 数组，收到 ${JSON.stringify(playerIds)}`);
    }
    const { transaction = null, allowMissing = false, includeAdmin = false } = options;
    const ids = [...new Set(playerIds.map(assertPlayerId))];
    const q = (sql) => sequelize.query(sql, transaction ? { transaction } : {});

    if (!ids.length) return { ids: [], skipped: [], total: 0, per_player: [] };

    // 存在性与角色一次查回来：既用来拒"根本不存在"，也用来拒"这是管理员号"
    const [found] = await q(`SELECT id, username, role FROM players WHERE id IN (${ids.join(', ')}) ORDER BY id`);
    const missing = ids.filter(id => !found.some(r => Number(r.id) === id));
    if (!allowMissing && missing.length) {
        throw new Error(`PlayerCascadePurge.deletePlayers：这些 id 在 players 里不存在：${missing.join(', ')}。`
            + '删不存在的号＝收尾没跑到而没人响，下一轮探针会读到上一轮的残留行。'
            + '确实要允许"可能已经没了"就显式传 allowMissing。');
    }
    const protectedRows = includeAdmin ? [] : found.filter(r => r.role === 'admin');
    if (protectedRows.length) {
        throw new Error(`PlayerCascadePurge.deletePlayers：拒绝删除管理员账号 `
            + `${protectedRows.map(r => `${r.id}/${r.username}`).join(', ')}（要删传 includeAdmin，`
            + '并先想清楚这条路径会不会碰到真人号）');
    }

    const perPlayer = [];
    let total = 0;
    for (const row of found) {
        const out = await applyOwnership(Number(row.id), { transaction });
        total += out.total;
        perPlayer.push({ player_id: Number(row.id), username: row.username, total: out.total, tables: out.tables });
    }
    if (found.length) {
        await q(`DELETE FROM players WHERE id IN (${found.map(r => Number(r.id)).join(', ')})`);
    }
    return {
        ids: found.map(r => Number(r.id)),
        skipped: missing,
        total,
        per_player: perPlayer
    };
}

/**
 * 按账号名删（探针开头清历次残留、结尾自清理都用它）。
 * 名字是调用方给的字符串，所以一律走 `sequelize.escape`；一个都对不上时返回空结果而不是抛
 * —— 这条路径的语义本来就是"有就清掉"。
 * @param {Array<string>} usernames
 * @returns {Promise<{ids:number[], total:number, per_player:Array}>}
 */
async function deleteByUsernames(usernames, options = {}) {
    if (!Array.isArray(usernames) || !usernames.length) {
        throw new Error('PlayerCascadePurge.deleteByUsernames：要传非空的账号名数组');
    }
    for (const name of usernames) {
        if (typeof name !== 'string' || !name.trim()) {
            throw new Error(`PlayerCascadePurge.deleteByUsernames：账号名必须是非空字符串，收到 ${JSON.stringify(name)}`);
        }
    }
    const transaction = options.transaction || null;
    const placeholders = usernames.map(n => sequelize.escape(n)).join(', ');
    const [rows] = await sequelize.query(
        `SELECT id FROM players WHERE username IN (${placeholders}) ORDER BY id`,
        transaction ? { transaction } : {}
    );
    return deletePlayers(rows.map(r => Number(r.id)), { ...options, allowMissing: true });
}

/** 测试/迁移后刷新表清单用 */
function resetCache() { cache = null; }

module.exports = {
    ownershipTables,
    classify,
    purge,
    purgeMany,
    deletePlayer,
    deletePlayers,
    deleteByUsernames,
    preview,
    countReferences,
    assertPlayerId,
    resetCache,
    OWNERSHIP_COLUMNS,
    OWNERSHIP_DENY,
    REFERENCE_PATTERN
};
