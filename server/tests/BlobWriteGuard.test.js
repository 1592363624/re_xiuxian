/**
 * players 整块 JSON 列写入守卫的单元测试（不连库）
 *
 * 这一类缺陷要防的是：某个流程拿着请求开始时读的 attributes 快照，改一个键，
 * 然后整块 save() 回去 —— 同一时间别的流程写进去的键就永久丢了，且不报错。
 * 守卫拦两类：① 根本没有事务；② 有事务但手上那份 state_version 比库里旧。
 * 这里同时钉住：不能扩大化到把新鲜快照的普通保存也拦掉。
 */
'use strict';

const {
    assertBlobWriteAllowed,
    assertBulkBlobWriteAllowed,
    dirtyBlobColumns,
    versionOf,
    StalePlayerSnapshotError,
    WHOLE_BLOB_COLUMNS
} = require('../game/persistence/blobWriteGuard');
const { resetLogOnce } = require('../utils/logOnce');

/** 造一个只实现 changed()/getDataValue() 的假实例：守卫只用到这两点 */
function fakeInstance({ dirty = [], isNewRecord = false, id = 7, stateVersion = 3, values } = {}) {
    const valueMap = values || { id, state_version: stateVersion };
    return {
        isNewRecord,
        changed(column) {
            if (column === undefined) return dirty.length ? dirty.slice() : false;
            return dirty.includes(column) ? 'previous-value' : false;
        },
        getDataValue(key) {
            return valueMap[key];
        }
    };
}

/** 假模型：findByPk 返回"库里的当前版本"，并记下守卫传进来的查询参数 */
function fakeModel(stateVersionInDb, seen = []) {
    return {
        async findByPk(id, options) {
            seen.push({ id, options });
            if (stateVersionInDb === null) return null;
            return { getDataValue: key => (key === 'state_version' ? stateVersionInDb : undefined) };
        }
    };
}

/** 假事务：真实 transaction 有 LOCK.UPDATE，守卫据此决定是否加锁读 */
function fakeTransaction(withLock = true) {
    return withLock ? { id: 'fake-tx', LOCK: { UPDATE: 'UPDATE' } } : { id: 'fake-tx' };
}

describe('整块 JSON 列写入守卫', () => {
    test('五个整块列各自都被盯住', async () => {
        expect(WHOLE_BLOB_COLUMNS).toEqual(
            expect.arrayContaining(['attributes', 'stats', 'time_system_data', 'titles', 'spirit_roots'])
        );
        for (const column of WHOLE_BLOB_COLUMNS) {
            await expect(assertBlobWriteAllowed(fakeInstance({ dirty: [column] }), {}))
                .rejects.toThrow(column);
        }
    });

    test('事务外整块写回直接抛错，并且告诉调用方该走哪条路', async () => {
        await expect(assertBlobWriteAllowed(fakeInstance({ dirty: ['attributes'] }), {}))
            .rejects.toThrow(/PlayerStateStore\.patchPlayerState/);
    });

    test('事务内、版本一致时放行：读的就是锁内最新那份', async () => {
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes', 'stats'], stateVersion: 3 }),
            { transaction: fakeTransaction() },
            fakeModel(3n)
        )).resolves.toBeUndefined();
    });

    test('版本比对是加锁读，且只取那一列（不能顺手把整行读出来）', async () => {
        const seen = [];
        await assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'], stateVersion: 1 }),
            { transaction: fakeTransaction() },
            fakeModel(1n, seen)
        );
        expect(seen).toHaveLength(1);
        expect(seen[0].id).toBe(7);
        expect(seen[0].options.lock).toBe('UPDATE');
        expect(seen[0].options.attributes).toEqual(['state_version']);
        expect(seen[0].options.transaction).toBeTruthy();
    });

    test('事务内但快照比库里旧：抛 StalePlayerSnapshotError，两个版本号都写进报错里', async () => {
        const error = await assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'], stateVersion: '3' }),
            { transaction: fakeTransaction() },
            fakeModel(9n)
        ).then(() => null, e => e);
        expect(error).toBeInstanceOf(StalePlayerSnapshotError);
        expect(error.code).toBe('STALE_SNAPSHOT');
        expect(error.message).toMatch(/快照已过期/);
        expect(error.message).toMatch(/3 落后于库里的 9/);
        expect(error.message).toMatch(/readForUpdate/);
    });

    test('自己刚 +1 的写回（patchPlayerState 的形状）不能误拦', async () => {
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'], stateVersion: 8n }),
            { transaction: fakeTransaction() },
            fakeModel(7n)
        )).resolves.toBeUndefined();
    });

    test('拿不到版本号时放行：只读投影的用法不该被打断，同时不掩盖真实拦截', async () => {
        const unpinned = [null, undefined, '', 'abc', NaN];
        for (const value of unpinned) {
            await expect(assertBlobWriteAllowed(
                fakeInstance({ dirty: ['attributes'], values: { id: 7, state_version: value } }),
                { transaction: fakeTransaction() },
                fakeModel(5n)
            )).resolves.toBeUndefined();
        }
        // 库里读不到行（刚被删）同样放行，交给随后的 UPDATE 去报错
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'], stateVersion: 1 }),
            { transaction: fakeTransaction() },
            fakeModel(null)
        )).resolves.toBeUndefined();
    });

    test('放行不等于沉默：拿不到版本号的整块写回要响一次，而且同一个调用点不刷屏', async () => {
        resetLogOnce();
        const errors = [];
        const spy = jest.spyOn(console, 'error').mockImplementation(msg => errors.push(String(msg)));
        try {
            for (let i = 0; i < 3; i++) {
                await assertBlobWriteAllowed(
                    fakeInstance({ dirty: ['attributes'], values: { id: 7, state_version: undefined } }),
                    { transaction: fakeTransaction() },
                    fakeModel(5n)
                );
            }
        } finally {
            spy.mockRestore();
        }
        const hits = errors.filter(msg => msg.includes('blobWriteGuard.unversioned_write'));
        // 三声不响 = 这个洞又变回静默放行；每调一次刷一行 = 高频路径上没法看日志
        expect(hits).toHaveLength(1);
        expect(hits[0]).toContain('没有 state_version');
    });

    test('没传模型时只做事务判定（单元测试与不带模型的复用路径）', async () => {
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'] }), { transaction: fakeTransaction() }
        )).resolves.toBeUndefined();
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'] }), {}
        )).rejects.toThrow(/不能在事务外写回/);
    });

    test('事务没有 LOCK 时降级为不加锁读，不炸', async () => {
        const seen = [];
        await assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'], stateVersion: 2 }),
            { transaction: fakeTransaction(false) },
            fakeModel(2n, seen)
        );
        expect(seen[0].options.lock).toBeUndefined();
    });

    test('BIGINT 的三种回值形态（BigInt/字符串/数字）都能比对', () => {
        expect(versionOf(5n)).toBe(5n);
        expect(versionOf('5')).toBe(5n);
        expect(versionOf(5)).toBe(5n);
        expect(versionOf(' 5 ')).toBe(5n);
        expect(versionOf(null)).toBeNull();
        expect(versionOf('x')).toBeNull();
        expect(versionOf(3n)).toBeLessThan(versionOf(9n));
    });

    test('没脏整块列时不查库：普通标量保存必须照常工作', async () => {
        const seen = [];
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: ['nickname', 'exp'] }), {}, fakeModel(99n, seen)
        )).resolves.toBeUndefined();
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: [] }), {}, fakeModel(99n, seen)
        )).resolves.toBeUndefined();
        expect(seen).toEqual([]);
    });

    test('新建记录不拦（没有并发对手可被覆盖）', async () => {
        await expect(assertBlobWriteAllowed(
            fakeInstance({ dirty: ['attributes'], isNewRecord: true }), {}, fakeModel(99n)
        )).resolves.toBeUndefined();
        expect(dirtyBlobColumns(fakeInstance({ dirty: ['attributes'], isNewRecord: true }))).toEqual([]);
    });

    test('脏列枚举只报整块列，供错误信息使用', () => {
        expect(dirtyBlobColumns(fakeInstance({ dirty: ['attributes', 'nickname'] }))).toEqual(['attributes']);
    });
});

describe('bulk 路径（Player.update）的同一道守卫', () => {
    test('五个整块列都不许在事务外经 Player.update 整块覆盖', () => {
        for (const column of WHOLE_BLOB_COLUMNS) {
            expect(() => assertBulkBlobWriteAllowed({
                fields: [column], attributes: { [column]: '{}' }
            })).toThrow(column);
        }
        expect(() => assertBulkBlobWriteAllowed({ fields: ['attributes'], attributes: {} }))
            .toThrow(/PlayerStateStore\.patchPlayerState/);
    });

    test('事务内放行，但 state_version 由守卫顺手 +1：bulk 路径不涨它，版本判定就会失真', () => {
        const options = {
            fields: ['attributes', 'updated_at'],
            attributes: { attributes: '{}' },
            transaction: fakeTransaction()
        };
        assertBulkBlobWriteAllowed(options);
        expect(options.fields).toEqual(expect.arrayContaining(['attributes', 'updated_at', 'state_version']));
        expect(options.attributes.state_version).toBeTruthy();
        expect(options.attributes.state_version.val).toBe('`state_version` + 1');
    });

    test('不碰整块列时完全不介入：原子增减标量列不该被顺带涨版本', () => {
        const options = {
            fields: ['spirit_stones'],
            attributes: { spirit_stones: { val: 'spirit_stones - 100' } },
            transaction: fakeTransaction()
        };
        assertBulkBlobWriteAllowed(options);
        expect(options.fields).toEqual(['spirit_stones']);
        expect(options.attributes.state_version).toBeUndefined();
    });

    test('调用方自己管 state_version 时不覆盖它', () => {
        const options = {
            fields: ['attributes', 'state_version'],
            attributes: { attributes: '{}', state_version: 'mine' },
            transaction: fakeTransaction()
        };
        assertBulkBlobWriteAllowed(options);
        expect(options.attributes.state_version).toBe('mine');
        expect(options.fields.filter(f => f === 'state_version')).toHaveLength(1);
    });

    test('beforeBulkUpdate 确实挂在模型上（删掉钩子=bulk 路径重新裸奔）', () => {
        const Player = require('../models/player');
        const hooks = Player.options.hooks || {};
        expect([].concat(hooks.beforeBulkUpdate || []).length).toBeGreaterThan(0);
    });
});

describe('守卫确实挂在模型上', () => {
    test('Player 注册了 beforeSave 钩子，删掉它会让本用例失败', () => {
        // 连库探针能证明"现在没有代码违反它"，但证明不了"钩子还在"；这条补上那一半。
        const Player = require('../models/player');
        const hooks = Player.options.hooks || {};
        const beforeSave = [].concat(hooks.beforeSave || []);
        expect(beforeSave.length).toBeGreaterThan(0);
    });

    test('钩子把 Player 自己传给守卫，并且 await 它', async () => {
        // 第三参数缺失 = 版本判定静默失效；不 await = 异步判定被吞掉。
        // 两种写错的后果都是"守卫看着还在、其实只剩一半"，所以按源码钉住。
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '../models/player.js'), 'utf-8');
        expect(source).toMatch(/assertBlobWriteAllowed\(\s*instance,\s*options,\s*Player\s*\)/);
        expect(source).toMatch(/beforeSave\(async\s*\(/);

        const Player = require('../models/player');
        const hook = [].concat(Player.options.hooks.beforeSave)[0];
        const original = Player.findByPk;
        Player.findByPk = fakeModel(50n).findByPk;
        try {
            await expect(hook(fakeInstance({ dirty: ['attributes'], stateVersion: 1 }),
                { transaction: fakeTransaction() })).rejects.toBeInstanceOf(StalePlayerSnapshotError);
        } finally {
            Player.findByPk = original;
        }
    });
});
