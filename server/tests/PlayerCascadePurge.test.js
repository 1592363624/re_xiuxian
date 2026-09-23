/**
 * 删号级联清理的两档口径与接线（任务 #22）
 *
 * 这套用例**不连库**（本仓 jest 一律不碰 MySQL），所以判的是"形状与判定"，
 * 真删干净没有由 scripts/smoke_player_cascade_purge.js 在隔离库上量。
 * 这里要钉住的是三件一旦错了就很贵的事：
 *   1. 只删"归属"这一档，引用别人的历史一律留着（删错方向比留孤儿严重）；
 *   2. 表清单来自 information_schema，新增一张带 player_id 的表不需要改代码 —— 但"读不到清单"
 *      必须抛，不能报"已经清干净"（那是把空转写成成功）；
 *   3. 传进来越界的 id 要在发出任何语句之前就被拒（`WHERE player_id = undefined` 这种事故不能有第二次）。
 * 每条负向断言都配了控制跑（合成数据驱动同一个纯函数），否则"绿"只说明我没写对测试。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const sequelize = require('../config/database');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
const { resetLogOnce, logOnce } = require('../utils/logOnce');

const SERVER = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8');

/** 把 sequelize.query 换成收集器：既能"一条都没发"这种断言，也能看发出的 SQL 形状 */
function withQuerySpy(handler) {
    const real = sequelize.query;
    const calls = [];
    sequelize.query = async (sql, options) => {
        calls.push({ sql: String(sql), options: options || {} });
        return handler ? handler(sql, options) : [[], {}];
    };
    try {
        return { calls, restore: () => { sequelize.query = real; PlayerCascadePurge.resetCache(); } };
    } catch (e) {
        sequelize.query = real;
        throw e;
    }
}

function captureErrors() {
    const real = console.error;
    const seen = [];
    console.error = (...args) => { seen.push(args.map(String).join(' ')); };
    return { seen, restore: () => { console.error = real; } };
}

describe('PlayerCascadePurge：两档口径（归属删、引用留）', () => {
    const entries = (list) => list.map(([table, column]) => ({ table, column }));

    test('列名分档：归属/关系进将删、引用进 references、复数列进 uncovered（等值匹配不了就点名，不假装清了）', () => {
        const { purge, relation, references, uncovered } = PlayerCascadePurge.classify(entries([
            ['player_items', 'player_id'],
            ['cave_legacies', 'owner_player_id'],
            ['chat_red_packets', 'sender_id'],
            ['auctions', 'seller_id'],
            ['cave_messages', 'cave_owner_id'],
            ['dao_companions', 'player_a_id'],
            ['dao_companions', 'player_b_id'],
            ['world_bosses', 'killer_player_id'],
            ['garden_steal_logs', 'attacker_player_id'],
            ['garden_steal_logs', 'target_player_id'],
            ['multi_dungeon_instance', 'leader_player_id'],
            ['spirit_beast_pvp_matches', 'winner_player_id'],
            ['pvp_battle_records', 'attacker_id'],
            ['pvp_battle_records', 'winner_id'],
            ['sect_war_territories', 'defender_player_ids'],
            ['admin_logs', 'admin_id'],
            ['players', 'id']
        ]));
        expect(purge.map(e => `${e.table}.${e.column}`).sort()).toEqual([
            'auctions.seller_id',
            'cave_legacies.owner_player_id',
            'cave_messages.cave_owner_id',
            'chat_red_packets.sender_id',
            'player_items.player_id'
        ]);
        expect(relation.map(e => `${e.table}.${e.column}`).sort()).toEqual([
            'dao_companions.player_a_id',
            'dao_companions.player_b_id'
        ]);
        expect(references.map(e => `${e.table}.${e.column}`).sort()).toEqual([
            'admin_logs.admin_id',
            'garden_steal_logs.attacker_player_id',
            'garden_steal_logs.target_player_id',
            'multi_dungeon_instance.leader_player_id',
            'pvp_battle_records.attacker_id',
            'pvp_battle_records.winner_id',
            'spirit_beast_pvp_matches.winner_player_id',
            'world_bosses.killer_player_id'
        ]);
        // 复数列：既不该被删，也不该被当成"已覆盖"
        expect(uncovered.map(e => `${e.table}.${e.column}`).sort())
            .toEqual(['sect_war_territories.defender_player_ids']);
    });

    test('可扩展性：资料片/新玩法加一张带 player_id 的表，不改这个文件就会被清；加一列 *_victim_player_id 就不会被删', () => {
        const before = PlayerCascadePurge.classify(entries([['old_table', 'player_id']]));
        const after = PlayerCascadePurge.classify(entries([['old_table', 'player_id'], ['new_dlc_table', 'player_id']]));
        expect(after.purge.map(e => e.table)).toContain('new_dlc_table');
        expect(after.purge.length).toBe(before.purge.length + 1);

        const ref = PlayerCascadePurge.classify(entries([['duel_records', 'victim_player_id'], ['duel_records', 'player_id']]));
        expect(ref.purge.map(e => e.column)).toEqual(['player_id']);
        expect(ref.references.map(e => e.column)).toEqual(['victim_player_id']);

        // 短名引用列（attacker_id 这种）也必须进引用档 —— 2026-09 扩档前它们掉进 uncovered 被漏掉
        const shortRef = PlayerCascadePurge.classify(entries([
            ['pvp_battle_records', 'attacker_id'],
            ['auctions', 'winner_id'],
            ['market_listings', 'buyer_id']
        ]));
        expect(shortRef.purge).toEqual([]);
        expect(shortRef.references.map(e => e.column).sort()).toEqual(['attacker_id', 'buyer_id', 'winner_id']);
    });

    test('players 表自己不进清单（删它由调用方负责，级联不该自己删主行）', () => {
        const { purge } = PlayerCascadePurge.classify(entries([['players', 'player_id'], ['players', 'id']]));
        expect(purge).toEqual([]);
    });

    test('归属档的豁免表：空是正常状态，出现条目就必须带理由；列名清单是扩展过的完整口径', () => {
        for (const [table, reason] of PlayerCascadePurge.OWNERSHIP_DENY) {
            expect(typeof table).toBe('string');
            expect(reason.length).toBeGreaterThan(10);
        }
        expect(PlayerCascadePurge.OWNERSHIP_COLUMNS).toEqual([
            'player_id', 'owner_player_id', 'owner_id', 'user_id',
            'sender_id', 'receiver_id', 'seller_id', 'bidder_id', 'cave_owner_id'
        ]);
        expect(PlayerCascadePurge.RELATION_COLUMNS).toEqual(['player_a_id', 'player_b_id']);
        // keep 账号时跳过的登录身份表必须点名存在，否则 AccountDeletionService 的 skip 会空转
        expect(PlayerCascadePurge.ACCOUNT_IDENTITY_TABLES).toContain('player_oauth_bindings');
    });
});

describe('发语句之前的三道闸', () => {
    test('id 不是正整数：抛，并且一条 SQL 都不发', async () => {
        const spy = withQuerySpy(() => [[], {}]);
        try {
            for (const bad of [undefined, null, 0, -1, 1.5, NaN, '', '   ', '1; DROP TABLE players', '7a']) {
                await expect(PlayerCascadePurge.purge(bad)).rejects.toThrow(/playerId/);
            }
            expect(spy.calls).toEqual([]);          // 这条断言才是本用例的价值：没发过任何语句
            // 路由参数天然是字符串：'7' 要能过第一道闸（这里它撞到的是"清单为空"那道，说明校验已经放行）
            await expect(PlayerCascadePurge.purge('7')).rejects.toThrow(/一张带 player_id 的表都没找到/);
        } finally { spy.restore(); }
    });

    test('purgeMany：批量走同一份校验，混进坏 id 要抛而不是"跳过那一个"', async () => {
        const spy = withQuerySpy(() => [[], {}]);
        try {
            await expect(PlayerCascadePurge.purgeMany(undefined)).rejects.toThrow(/id 数组/);
            // 跳过坏 id = 那个号留下孤儿行而调用方以为全清了，所以宁可整批停下
            await expect(PlayerCascadePurge.purgeMany([7, null], { entries: [] })).rejects.toThrow(/playerId/);
            await expect(PlayerCascadePurge.purgeMany([7, 8], { entries: [] }))
                .resolves.toEqual({ total: 0, perPlayer: [{ player_id: 7, total: 0 }, { player_id: 8, total: 0 }] });
            expect(spy.calls).toEqual([]);          // 校验/空清单都不该发 SQL
        } finally { spy.restore(); }
    });

    test('dryRun 与真实执行共用同一份清单：报告里的行数与实际删掉的行数是同一个数', async () => {
        const tables = [
            { table_name: 'player_items', column_name: 'player_id' },
            { table_name: 'spirit_beasts', column_name: 'player_id' },
            { table_name: 'cave_legacies', column_name: 'owner_player_id' }
        ];
        const spy = withQuerySpy((sql) => {
            const text = String(sql);
            if (text.includes('information_schema')) return [tables, {}];
            if (text.startsWith('SELECT COUNT')) return [[{ n: 3 }], {}];
            return [{}, { affectedRows: 3 }];
        });
        try {
            const preview = await PlayerCascadePurge.preview(7);
            expect(preview.total).toBe(9);
            expect(preview.tables.map(t => `${t.table}.${t.column}`).sort())
                .toEqual(['cave_legacies.owner_player_id', 'player_items.player_id', 'spirit_beasts.player_id']);

            const real = withQuerySpy((sql) => {
                const text = String(sql);
                if (text.includes('information_schema')) return [tables, {}];
                if (text.startsWith('SELECT COUNT')) return [[{ n: 3 }], {}];
                return [{}, { affectedRows: 3 }];
            });
            try {
                const out = await PlayerCascadePurge.purge(7);
                expect(out.total).toBe(9);
                const deletes = real.calls.filter(c => c.sql.startsWith('DELETE')).map(c => c.sql).sort();
                expect(deletes).toEqual([
                    'DELETE FROM `cave_legacies` WHERE `owner_player_id` = 7',
                    'DELETE FROM `player_items` WHERE `player_id` = 7',
                    'DELETE FROM `spirit_beasts` WHERE `player_id` = 7'
                ].sort());
                // 先数后删：报出来的行数是数出来的那个数，不是驱动 returned 的 affectedRows
                // （Sequelize v6 对 `type: DELETE` 返回的不是 [rows, meta]，按元组解构会 TypeError —— 实测踩过）
                expect(real.calls.filter(c => c.sql.startsWith('SELECT COUNT'))).toHaveLength(3);
                // 反过来：dryRun 绝不能发 DELETE
                const dry = withQuerySpy((sql) => (String(sql).includes('information_schema')
                    ? [tables, {}] : [[{ n: 3 }], {}]));
                try {
                    const seen = await PlayerCascadePurge.preview(7);
                    expect(seen.total).toBe(9);
                    expect(dry.calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
                } finally { dry.restore(); }
            } finally { real.restore(); }
        } finally { spy.restore(); }
    });

    test('视图不删、players 自己不删、豁免表不删（清单在 SQL 层就筛掉）', async () => {
        const spy = withQuerySpy((sql) => {
            const text = String(sql);
            if (text.includes('information_schema')) {
                expect(text).toMatch(/TABLE_TYPE = 'BASE TABLE'/);      // 视图不可 DELETE
                expect(text).toMatch(/DATABASE\(\)/);                   // 不写死库名（线上/本地同一份代码）
                expect(text).not.toMatch(/re_xiuxian/);
                return [[], {}];
            }
            return [[], {}];
        });
        try {
            await expect(PlayerCascadePurge.purge(7)).rejects.toThrow(/一张带 player_id 的表都没找到/);
        } finally { spy.restore(); }
    });

    test('读不到清单时必须抛，不许把"什么都没清"报成"已经清干净"（含控制跑）', async () => {
        resetLogOnce();
        const empty = withQuerySpy(() => [[], {}]);
        const errs = captureErrors();
        try {
            await expect(PlayerCascadePurge.preview(7)).rejects.toThrow(/拒绝把/);
            expect(errs.seen.some(e => e.includes('information_schema'))).toBe(true);
        } finally { empty.restore(); errs.restore(); }

        // 控制跑：清单只要有一条就不该抛 —— 否则上面那条只是"只要空数组就红"的假闸
        const ok = withQuerySpy((sql) => (String(sql).includes('information_schema')
            ? [[{ table_name: 'player_items', column_name: 'player_id' }], {}]
            : [[{ n: 0 }], { affectedRows: 0 }]));
        try {
            await expect(PlayerCascadePurge.purge(7)).resolves.toEqual({ tables: [], total: 0 });
        } finally { ok.restore(); }
    });

    test('错误收集器本身可用（否则上面那条"响过"的断言是空跑）', () => {
        resetLogOnce();
        const errs = captureErrors();
        try {
            logOnce('zz.selftest', 'probe-message');
            expect(errs.seen.some(e => e.includes('probe-message'))).toBe(true);
            // logOnce 的语义是"同一 key 只响一次"，收集器要是漏掉了第一次，上面就红
            logOnce('zz.selftest', 'probe-message-again');
            expect(errs.seen.some(e => e.includes('probe-message-again'))).toBe(false);
        } finally { errs.restore(); }
    });
});

/**
 * 纯函数：扫"在服务代码里删 players 行"的位置，要求同一份文件必须走级联清理。
 * 用合成输入驱动控制跑，不往真实文件里注入（注入用例要求逐字节还原，而这仓库可能被另一路改动同时写）。
 */
function findUnpurgedPlayerDeletes(sources) {
    const DESTROY = /\bPlayer\.destroy\s*\(|\bplayer\.destroy\s*\(\s*\)/;
    const offenders = [];
    const sites = [];
    for (const [rel, text] of sources) {
        if (!DESTROY.test(text)) continue;
        sites.push(rel);
        if (!/PlayerCascadePurge/.test(text)) offenders.push(rel);
    }
    return { sites, offenders };
}

describe('删 players 行这条路径只有一扇，而且必须带级联（防"第二条删号路"再长出来）', () => {
    const DIRS = ['game', 'routes', 'models'];
    /** 参数是**绝对路径**（递归时传的就是绝对路径），别在里面再拼一次 SERVER */
    function jsFiles(absDir, out = []) {
        for (const name of fs.readdirSync(absDir)) {
            const full = path.join(absDir, name);
            const st = fs.statSync(full);
            if (st.isDirectory()) jsFiles(full, out);
            else if (name.endsWith('.js')) out.push(full);
        }
        return out;
    }
    const sources = DIRS.map(d => jsFiles(path.join(SERVER, d))).flat()
        .map(f => [path.relative(SERVER, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8')]);

    test('现网只有一个删 players 行的位置，且它就在级联之后', () => {
        const { sites, offenders } = findUnpurgedPlayerDeletes(sources);
        expect(sites.length).toBeGreaterThanOrEqual(1);   // 底线：扫描器要是看不见任何东西，这条就是空跑
        expect(offenders).toEqual([]);
    });

    test('控制跑：新长出一条"直接删号、不清派生行"的路径会被点名', () => {
        const { sites, offenders } = findUnpurgedPlayerDeletes([
            ['game/services/FreshService.js', 'await Player.destroy({ where: { id } });'],
            ['routes/ok.js', 'await PlayerCascadePurge.purge(id); await Player.destroy({ where: { id }, transaction: t });']
        ]);
        expect(sites).toEqual(['game/services/FreshService.js', 'routes/ok.js']);
        expect(offenders).toEqual(['game/services/FreshService.js']);
    });
});

describe('删号路由真的接上了级联（静态闸 + 控制跑）', () => {
    /** 纯函数：把 DELETE /players/:id 那个 handler 抠出来看形状 */
    function deletePlayerHandler(text) {
        const start = text.indexOf("router.delete('/players/:id'");
        if (start < 0) return null;
        const nextRoute = text.indexOf('router.', start + 10);
        return text.slice(start, nextRoute < 0 ? text.length : nextRoute);
    }

    // 删号只有一扇门：AccountDeletionService.execute（内部才有 purge + 删 players + 事务）
    const required = [
        /AccountDeletionService\.execute\(/,
        /purged_total/,
        /kept_references/
    ];

    test('GM 删号走 AccountDeletionService，且回执带清了多少/留了哪些引用', () => {
        const handler = deletePlayerHandler(read('routes/admin.js'));
        expect(handler).not.toBeNull();
        for (const re of required) expect(handler).toMatch(re);
        // 不再手写"清两张表"那种半吊子清理，也不在路由里直接 destroy players
        expect(handler).not.toMatch(/Item\.destroy/);
        expect(handler).not.toMatch(/await player\.destroy\(\)/);
        expect(handler).not.toMatch(/Player\.destroy/);
    });

    test('AccountDeletionService 内部才是那笔同生同死的事务（purge + 删/重写 players + commit/rollback）', () => {
        const svc = read('game/services/AccountDeletionService.js');
        expect(svc).toMatch(/PlayerCascadePurge\.purge\(/);
        expect(svc).toMatch(/transaction/);
        expect(svc).toMatch(/await t\.commit\(\)/);
        expect(svc).toMatch(/await t\.rollback\(\)/);
        // keep 重写 / delete 删行，两条路径都在服务里
        expect(svc).toMatch(/DELETE FROM players/);
        expect(svc).toMatch(/UPDATE players SET/);
    });

    test('控制跑：把 handler 退回旧写法，上面那些判据必须逐条红', () => {
        const old = `router.delete('/players/:id', auth, adminCheck, async (req, res) => {
    const player = await Player.findByPk(req.params.id);
    await Item.destroy({ where: { player_id: req.params.id } });
    await AdminLog.destroy({ where: { admin_id: player.id } });
    await player.destroy();
});`;
        const hits = required.map(re => re.test(old));
        expect(hits).toEqual([false, false, false]);
        expect(/Item\.destroy/.test(old)).toBe(true);
        expect(/await player\.destroy\(\)/.test(old)).toBe(true);
    });
});

/**
 * deletePlayer / deletePlayers / deleteByUsernames（任务 #24 的落点）。
 * 判的还是形状：发语句的顺序、"该抛的时候一条都没发"、以及三条比 Player.destroy 更硬的默认口径。
 * 每条负向判据都配控制跑 —— 否则"拒删不存在的号"可能只是"随便什么都拒"。
 */
const OWNERSHIP_FIXTURE = [
    { table_name: 'player_items', column_name: 'player_id' },
    { table_name: 'garden_steal_logs', column_name: 'target_player_id' }   // 引用档：不该被删
];

/** 让 query 桩同时扮演 information_schema / players 存在性 / COUNT */
function withDeleteSpy({ players, tables = OWNERSHIP_FIXTURE, counted = 2 }) {
    return withQuerySpy((sql) => {
        const text = String(sql);
        if (text.includes('information_schema')) return [tables, {}];
        if (text.startsWith('SELECT id, username, role FROM players')
            || text.startsWith('SELECT id FROM players')) return [players, {}];
        if (text.startsWith('SELECT COUNT')) return [[{ n: counted }], {}];
        return [{}, { affectedRows: counted }];
    });
}

/**
 * 把 SQL 里的字符串字面量整段剥掉（按 MySQL 口径：单引号定界、反斜杠转义算内容）。
 * 用来判"用户给的字符串有没有逃出一个字面量"。
 * 别用 `/'[^']*'/` 这类正则代替 —— 它对 `'x\'; DROP…'` 会在转义引号处收尾，正好把安全的写法判成不安全。
 */
function stripSqlLiterals(sql) {
    let out = '';
    let inString = false;
    for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        if (!inString) {
            if (ch === "'") { inString = true; continue; }
            out += ch;
            continue;
        }
        if (ch === '\\') { i += 1; continue; }        // 转义字符（含 \'）是内容，不是定界符
        if (ch === "'") { inString = false; continue; }
    }
    return { outside: out, unbalanced: inString };
}

describe('deletePlayer/deletePlayers：删号只有一扇门，而且比 Player.destroy 更不肯静默', () => {
    test('顺序：先把派生表逐张数完删完，最后才删 players 行，并且每条语句都带上同一个事务', async () => {
        const t = { fake: 'tx' };
        const spy = withDeleteSpy({ players: [{ id: 7, username: 'probe_a', role: 'player' }] });
        try {
            const out = await PlayerCascadePurge.deletePlayer(7, { transaction: t });
            expect(out).toMatchObject({ player_id: 7, username: 'probe_a', total: 2 });
            const sqls = spy.calls.map(c => c.sql);
            const playerDelete = sqls.findIndex(s => s.startsWith('DELETE FROM players'));
            const derivedDelete = sqls.findIndex(s => s.startsWith('DELETE FROM `player_items`'));
            expect(derivedDelete).toBeGreaterThan(-1);
            expect(playerDelete).toBeGreaterThan(derivedDelete);
            // 引用档那张表不许出现在 DELETE 里
            expect(sqls.some(s => s.startsWith('DELETE FROM `garden_steal_logs`'))).toBe(false);
            // 事务必须透传到每一条（少了它＝派生行删了、players 行没删，正是这套改造要消灭的形状）
            expect(spy.calls.every(c => c.options.transaction === t)).toBe(true);
        } finally { spy.restore(); }
    });

    test('id 在 players 里不存在：抛，并且一条 DELETE 都没发', async () => {
        const spy = withDeleteSpy({ players: [] });
        try {
            await expect(PlayerCascadePurge.deletePlayer(7)).rejects.toThrow(/不存在/);
            expect(spy.calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
        } finally { spy.restore(); }

        // 控制跑：同样查不到，显式 allowMissing 就要安静地返回 0 而不是抛
        const ok = withDeleteSpy({ players: [] });
        try {
            await expect(PlayerCascadePurge.deletePlayers([7], { allowMissing: true }))
                .resolves.toEqual({ ids: [], skipped: [7], total: 0, per_player: [] });
            expect(ok.calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
        } finally { ok.restore(); }

        // 控制跑：allowMissing 也不能把"崩在 half-undefined"当成返回
        const single = withDeleteSpy({ players: [] });
        try {
            await expect(PlayerCascadePurge.deletePlayer(7, { allowMissing: true }))
                .rejects.toThrow(/没有对应的 players 行/);
        } finally { single.restore(); }
    });

    test('管理员号拒删（探针里"临时提权再改回去"是常用手法，收尾要是撞在提权状态上删的就是真人号）', async () => {
        const spy = withDeleteSpy({ players: [{ id: 7, username: 'owner_real', role: 'admin' }] });
        try {
            await expect(PlayerCascadePurge.deletePlayer(7)).rejects.toThrow(/管理员/);
            expect(spy.calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
        } finally { spy.restore(); }

        // 控制跑：显式 includeAdmin 才放行
        const ok = withDeleteSpy({ players: [{ id: 7, username: 'owner_real', role: 'admin' }] });
        try {
            const out = await PlayerCascadePurge.deletePlayers([7], { includeAdmin: true });
            expect(out.ids).toEqual([7]);
            expect(ok.calls.some(c => c.sql.startsWith('DELETE FROM players'))).toBe(true);
        } finally { ok.restore(); }
    });

    test('坏 id / 非数组：发出任何语句之前就抛；重复 id 只删一次', async () => {
        const spy = withQuerySpy(() => [[], {}]);
        try {
            await expect(PlayerCascadePurge.deletePlayers('7')).rejects.toThrow(/id 数组/);
            await expect(PlayerCascadePurge.deletePlayers([7, null])).rejects.toThrow(/playerId/);
            await expect(PlayerCascadePurge.deletePlayers([7, undefined])).rejects.toThrow(/playerId/);
            expect(spy.calls).toEqual([]);
            await expect(PlayerCascadePurge.deletePlayers([])).resolves.toEqual({ ids: [], skipped: [], total: 0, per_player: [] });
            expect(spy.calls).toEqual([]);          // 空批一条语句都不发
        } finally { spy.restore(); }

        const dup = withDeleteSpy({ players: [{ id: 7, username: 'probe_a', role: 'player' }] });
        try {
            const out = await PlayerCascadePurge.deletePlayers([7, 7, '7']);
            expect(out.per_player).toHaveLength(1);
            const playerDeletes = dup.calls.filter(c => c.sql.startsWith('DELETE FROM players'));
            expect(playerDeletes).toHaveLength(1);
            expect(playerDeletes[0].sql).toBe('DELETE FROM players WHERE id IN (7)');
        } finally { dup.restore(); }
    });

    test('deleteByUsernames：把同名号的历次残留一起收掉，账号名一律转义', async () => {
        const spy = withDeleteSpy({
            players: [{ id: 7, username: 'probe_a', role: 'player' }, { id: 8, username: 'probe_a', role: 'player' }]
        });
        try {
            const out = await PlayerCascadePurge.deleteByUsernames(['probe_a']);
            expect(out.ids).toEqual([7, 8]);
            expect(out.total).toBe(4);              // 每个号 2 行派生
            const lookup = spy.calls.find(c => c.sql.startsWith('SELECT id FROM players')).sql;
            expect(lookup).toMatch(/username IN \('probe_a'\)/);
            // 注入面：带引号与分号的名字必须整体待在一个字面量里，不许拼出第二条语句
            const evil = withDeleteSpy({ players: [] });
            try {
                await expect(PlayerCascadePurge.deleteByUsernames(["x'; DROP TABLE players; --"]))
                    .resolves.toMatchObject({ ids: [] });
                const evilSql = evil.calls.find(c => c.sql.startsWith('SELECT id FROM players')).sql;
                const stripped = stripSqlLiterals(evilSql);
                expect(stripped.unbalanced).toBe(false);
                expect(stripped.outside).not.toMatch(/DROP TABLE/);   // DROP 整体待在字面量里
                expect(evil.calls.some(c => c.sql.startsWith('DELETE'))).toBe(false);
                // 控制跑：同一份检查对"裸拼"的写法必须看得见，否则上面那条断言是空跑
                const naive = stripSqlLiterals(`SELECT id FROM players WHERE username IN ('x'; DROP TABLE players; --')`);
                expect(naive.outside).toMatch(/DROP TABLE players/);
            } finally { evil.restore(); }
        } finally { spy.restore(); }

        // 一个都对不上 = 正常返回，不抛（这条路径的语义本来就是"有就清掉"）
        const none = withDeleteSpy({ players: [] });
        try {
            await expect(PlayerCascadePurge.deleteByUsernames(['nothing_here']))
                .resolves.toMatchObject({ ids: [], total: 0 });
        } finally { none.restore(); }

        for (const bad of [undefined, [], [''], ['   '], [7]]) {
            await expect(PlayerCascadePurge.deleteByUsernames(bad)).rejects.toThrow(/账号名|非空/);
        }
    });
});
