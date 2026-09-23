/**
 * 账号数据删除 / 清档（两档 account_mode）的形状与硬闸。
 *
 * 本套件不连库（jest 一律不碰 MySQL），判的是：
 *   1. 两档语义：keep 跳过 QQ 绑定并重写 players 行；delete 连 players 一起删
 *   2. 确认语 / 管理员拒自助 / 密码闸 在路由里真的接上了
 *   3. 引用档绝不进 DELETE
 *   4. 未来新表：列名进约定档就会被清（合成清单控制跑）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
const AccountDeletionService = require('../game/services/AccountDeletionService');

const SERVER = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');

function withQuerySpy(handler) {
    const real = sequelize.query;
    const calls = [];
    sequelize.query = async (sql, options) => {
        calls.push({ sql: String(sql), options: options || {} });
        return handler ? handler(sql, options) : [[], {}];
    };
    return {
        calls,
        restore: () => {
            sequelize.query = real;
            PlayerCascadePurge.resetCache();
        }
    };
}

const FIXTURE_TABLES = [
    { table_name: 'player_items', column_name: 'player_id' },
    { table_name: 'player_oauth_bindings', column_name: 'player_id' },
    { table_name: 'dao_companions', column_name: 'player_a_id' },
    { table_name: 'dao_companions', column_name: 'player_b_id' },
    { table_name: 'pvp_battle_records', column_name: 'attacker_id' },
    { table_name: 'chat_red_packets', column_name: 'sender_id' }
];

function spyWithFixture({ players = [{ id: 7, username: 'probe', nickname: '道友', role: 'user' }], counted = 2 } = {}) {
    return withQuerySpy((sql) => {
        const text = String(sql);
        if (text.includes('information_schema')) return [FIXTURE_TABLES, {}];
        if (text.startsWith('SELECT id, username, role FROM players')
            || text.startsWith('SELECT id FROM players')
            || text.startsWith('SELECT username, nickname FROM players')) return [players, {}];
        if (text.startsWith('SELECT COUNT')) return [[{ n: counted }], {}];
        if (text.startsWith('SELECT id FROM dao_companions')
            || text.startsWith('SELECT id FROM auctions')
            || text.startsWith('SELECT id FROM market_listings')
            || text.includes('multi_dungeon')) return [[], {}];
        return [{}, { affectedRows: counted }];
    });
}

describe('两档 account_mode 的分档动作', () => {
    test('keep：跳过 QQ 绑定表，但清玩法归属与道侣关系；引用档（attacker_id）不删', async () => {
        const spy = spyWithFixture();
        try {
            const purged = await PlayerCascadePurge.purge(7, {
                skipTables: AccountDeletionService.KEEP_SKIP_TABLES
            });
            const deletes = spy.calls.filter(c => c.sql.startsWith('DELETE')).map(c => c.sql);
            expect(deletes.some(s => s.includes('`player_items`'))).toBe(true);
            expect(deletes.some(s => s.includes('`player_oauth_bindings`'))).toBe(false);
            expect(deletes.some(s => s.includes('`dao_companions`'))).toBe(true);
            expect(deletes.some(s => s.includes('`chat_red_packets`'))).toBe(true);
            expect(deletes.some(s => s.includes('`pvp_battle_records`'))).toBe(false);
            expect(purged.total).toBeGreaterThan(0);
        } finally { spy.restore(); }
    });

    test('delete：QQ 绑定也进归属档随号走', async () => {
        const spy = spyWithFixture();
        try {
            await PlayerCascadePurge.purge(7);
            const deletes = spy.calls.filter(c => c.sql.startsWith('DELETE')).map(c => c.sql);
            expect(deletes.some(s => s.includes('`player_oauth_bindings`'))).toBe(true);
        } finally { spy.restore(); }
    });

    test('未来新表：只要列名进约定档，不改删除代码也会被清（控制跑）', async () => {
        const future = [
            { table_name: 'player_items', column_name: 'player_id' },
            { table_name: 'new_dlc_loot', column_name: 'player_id' },
            { table_name: 'new_dlc_owner', column_name: 'owner_id' },
            { table_name: 'new_dlc_pair', column_name: 'player_a_id' }
        ];
        const spy = withQuerySpy((sql) => {
            const text = String(sql);
            if (text.includes('information_schema')) return [future, {}];
            if (text.startsWith('SELECT COUNT')) return [[{ n: 1 }], {}];
            return [{}, { affectedRows: 1 }];
        });
        try {
            await PlayerCascadePurge.purge(7);
            const deletes = spy.calls.filter(c => c.sql.startsWith('DELETE')).map(c => c.sql).join('\n');
            expect(deletes).toMatch(/new_dlc_loot/);
            expect(deletes).toMatch(/new_dlc_owner/);
            expect(deletes).toMatch(/new_dlc_pair/);
        } finally { spy.restore(); }
    });
});

describe('AccountDeletionService.execute 的事务形状', () => {
    test('keep 走 UPDATE players（全量重开 + token_version+1），delete 走 DELETE FROM players', async () => {
        // ConfigLoader 在 jest 里可能未初始化，stub 掉初值构造（形状判据不依赖具体数值）
        const PlayerService = require('../game/core/PlayerService');
        const realBuild = PlayerService.buildFreshPlayerState;
        PlayerService.buildFreshPlayerState = (nickname) => ({
            nickname,
            realm: '凡人',
            exp: 0,
            spirit_stones: 0,
            attributes: { sense: 10 },
            spirit_roots: {},
            titles: '["newbie"]',
            token_note: 'fresh'
        });
        try {
            // keep
            const keepSpy = spyWithFixture();
            try {
                const AdminLog = require('../models/admin_log');
                const realCreate = AdminLog.create;
                AdminLog.create = async () => ({ id: 1 });
                try {
                    await AccountDeletionService.execute(7, { accountMode: 'keep', actorId: 7 });
                } finally {
                    AdminLog.create = realCreate;
                }
                const keepSqls = keepSpy.calls.map(c => c.sql);
                expect(keepSqls.some(s => s.startsWith('UPDATE players SET'))).toBe(true);
                expect(keepSqls.some(s => s.includes('token_version'))).toBe(true);
                expect(keepSqls.some(s => s.startsWith('DELETE FROM players'))).toBe(false);
            } finally { keepSpy.restore(); }

            // delete
            const delSpy = spyWithFixture();
            try {
                const AdminLog = require('../models/admin_log');
                const realCreate = AdminLog.create;
                const realDestroy = AdminLog.destroy;
                AdminLog.create = async () => ({ id: 1 });
                AdminLog.destroy = async () => 0;
                try {
                    await AccountDeletionService.execute(7, { accountMode: 'delete', actorId: 7 });
                } finally {
                    AdminLog.create = realCreate;
                    AdminLog.destroy = realDestroy;
                }
                const delSqls = delSpy.calls.map(c => c.sql);
                expect(delSqls.some(s => s.startsWith('DELETE FROM players'))).toBe(true);
                expect(delSqls.some(s => s.startsWith('UPDATE players SET'))).toBe(false);
            } finally {
                delSpy.restore();
            }
        } finally {
            PlayerService.buildFreshPlayerState = realBuild;
        }
    });

    test('确认语两档各是各的，assertMode 拒未知档', () => {
        expect(AccountDeletionService.CONFIRM_PHRASES.keep).toBe('清空数据');
        expect(AccountDeletionService.CONFIRM_PHRASES.delete).toBe('删除账号');
        expect(() => AccountDeletionService.assertMode('wipe')).toThrow(/account_mode/);
        expect(AccountDeletionService.assertMode('keep')).toBe('keep');
    });
});

describe('自助路由的硬闸（静态）', () => {
    const route = read('routes/account.js');

    test('必须密码 + 确认语，管理员拒自助', () => {
        expect(route).toMatch(/bcrypt\.compare/);
        expect(route).toMatch(/confirm_phrase/);
        expect(route).toMatch(/role === 'admin'/);
        expect(route).toMatch(/AccountDeletionService\.execute/);
    });

    test('preview 与 delete 都挂了 auth', () => {
        expect(route).toMatch(/router\.get\('\/deletion-preview',\s*auth/);
        expect(route).toMatch(/router\.post\('\/delete',\s*auth/);
    });

    test('index.js 注册了 /api/account', () => {
        expect(read('index.js')).toMatch(/app\.use\('\/api\/account'/);
    });
});
