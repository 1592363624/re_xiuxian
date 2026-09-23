/**
 * 只读对账：库里有多少行"指向已经不存在的玩家"（任务 #22）。
 *
 * 为什么要单独一个脚本：删号的派生行清理已经修好并接进 GM 接口（`game/persistence/PlayerCascadePurge.js`），
 * 但**修之前删过的号**留下的孤儿不会自己消失。本地测试库可以直接清，线上（`xiuxian`）要不要清、
 * 什么时候清是运营决定，所以这里默认只读数不动数据。
 *
 * 用法：
 *   只读对账（默认）      cd server && node --env-file=.env scripts/audit_player_orphans.js
 *   对账线上（需业主授权）  cd server && node --env-file=.env_pord scripts/audit_player_orphans.js
 *   数一遍将要清多少        ... scripts/audit_player_orphans.js --plan      （还是不删）
 *   真的清掉                ... scripts/audit_player_orphans.js --apply     （只允许隔离库；线上会直接拒）
 *
 * 口径：
 *   - 归属列（`player_id` / `owner_player_id`）的孤儿 = 这行属于一个已经不存在的号，可以清；
 *   - 引用列（`killer_player_id` / `target_player_id` …）**不在此列** —— 那些行属于还活着的玩家，
 *     指向一个死号只是"历史里有个查不出名字的人"，删它们等于替活人抹历史。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5097);
process.env.PORT = String(PORT);

const sequelize = require('../config/database');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const APPLY = process.argv.includes('--apply');
const PLAN = process.argv.includes('--plan') || APPLY;

(async () => {
    const one = async (sql) => (await sequelize.query(sql))[0][0];   // sequelize.query 返回 [rows, meta]
    const schemaName = (await one('SELECT DATABASE() AS s')).s;
    const version = (await one('SELECT VERSION() AS v')).v;
    console.log(`目标库：${schemaName}（MySQL ${version}）｜模式：${APPLY ? 'APPLY（会删行）' : PLAN ? 'PLAN（只数）' : 'READ（对账）'}`);
    if (!/^re_xiuxian_test$|^xiuxian$/.test(schemaName)) {
        throw new Error(`库名不是预期的 re_xiuxian_test / xiuxian，先确认 --env-file 指向哪个库再跑`);
    }
    if (APPLY && schemaName !== 're_xiuxian_test') {
        throw new Error('只允许在隔离库上 --apply。线上清孤儿要业主点头，并且先跑一遍只读对账留下数字。');
    }

    const playerCount = Number((await one('SELECT COUNT(*) n FROM players')).n);
    const maxId = Number((await one('SELECT COALESCE(MAX(id),0) n FROM players')).n);
    console.log(`现存玩家 ${playerCount} 个（MAX(id)=${maxId}）`);

    const ownership = await PlayerCascadePurge.ownershipTables({ refresh: true });
    const perTable = [];
    let total = 0;
    for (const entry of ownership) {
        // 一次 GROUP BY 同时拿到"几张表 / 各多少行 / 是哪些死号的"。
        // 以前只数总数、按表打印 `表.列 = 16`，那个数字看着像玩家 id 也像行数 —— 追查"哪个探针留下的"
        // 时必须知道 id，所以 id 清单直接打出来（超过 6 个省略，但要给总数）。
        const [rows] = await sequelize.query(
            `SELECT t.\`${entry.column}\` pid, COUNT(*) n FROM \`${entry.table}\` t
             LEFT JOIN players p ON p.id = t.\`${entry.column}\`
             WHERE p.id IS NULL AND t.\`${entry.column}\` IS NOT NULL
             GROUP BY t.\`${entry.column}\` ORDER BY n DESC`
        );
        if (!rows.length) continue;
        const n = rows.reduce((s, r) => s + Number(r.n), 0);
        perTable.push({ ...entry, orphans: n, deadIds: rows.map(r => Number(r.pid)) });
        total += n;
    }
    console.log(`\n归属清单 ${ownership.length} 张表里有孤儿的：${perTable.length} 张，合计 ${total} 行`);
    for (const row of perTable) {
        const ids = row.deadIds || [];
        const shown = ids.slice(0, 6).join('/') + (ids.length > 6 ? `…（共 ${ids.length} 个死号）` : '');
        console.log(`  ${row.table}.${row.column}：${row.orphans} 行孤儿，来自玩家 id ${shown}`);
    }

    if (!PLAN) {
        console.log('\n（只读模式，没有动任何数据。要清理：先 --plan 看清是哪几张表，再 --apply）');
        await sequelize.close();
        process.exit(0);
    }

    if (!APPLY) {
        console.log(PLAN
            ? '\n（PLAN：只报将要清多少行，没动数据。要真清：加 --apply）'
            : '\n（只读模式，没有动任何数据。要清理：先 --plan 看清是哪几张表，再 --apply）');
        await sequelize.close();
        process.exit(0);
    }

    // 孤儿没有"玩家 id"可传（号已经不在了），所以按 (表, 列) 逐张删：只删 join 不到 players 的那些行。
    // 报出来的数用"删前现数"，不依赖驱动 returned 的形状（Sequelize v6 对 DELETE 的返回不是 [rows, meta]）。
    let deleted = 0;
    for (const row of perTable) {
        const joinOut = `LEFT JOIN players p ON p.id = t.\`${row.column}\` WHERE p.id IS NULL AND t.\`${row.column}\` IS NOT NULL`;
        const [counted] = await sequelize.query(`SELECT COUNT(*) n FROM \`${row.table}\` t ${joinOut}`);
        const n = Number(counted[0].n);
        if (!n) continue;
        await sequelize.query(`DELETE t FROM \`${row.table}\` t ${joinOut}`);
        const [after] = await sequelize.query(`SELECT COUNT(*) n FROM \`${row.table}\` t ${joinOut}`);
        const left = Number(after[0].n);
        if (left !== 0) throw new Error(`${row.table}.${row.column} 清完之后仍有 ${left} 行孤儿（不该继续往下删）`);
        deleted += n;
        console.log(`  已清 ${row.table}.${row.column}：${n} 行`);
    }
    console.log(`\n合计清掉 ${deleted} 行（对账数 ${total}）`);
    await sequelize.close();
    process.exit(0);
})().catch(error => {
    console.error('对账失败:', error.message || error);
    process.exit(1);
});
