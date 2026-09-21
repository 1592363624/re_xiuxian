/**
 * 玩家状态写入层的纯逻辑测试（不连库）：
 * 补丁语义、列白名单、SQL 字面量注入面。
 * 真实并发丢覆盖的验证走 scripts 下的连库探针（需要 MySQL）。
 */
'use strict';

const {
    mergeBlobPatch,
    patchPlayerState,
    readForUpdate,
    spendAmount,
    grantAmount,
    AMOUNT_COLUMNS
} = require('../game/persistence/PlayerStateStore');

describe('mergeBlobPatch 键级合并', () => {
    test('只动补丁点名的键，其余键原样保留', () => {
        const current = { sense: 100, hp_bonus: 5, sect_war_death_time: '2026-01-01' };
        const next = mergeBlobPatch(current, { sense: 90 });
        expect(next).toEqual({ sense: 90, hp_bonus: 5, sect_war_death_time: '2026-01-01' });
    });

    test('null 表示删除该键', () => {
        expect(mergeBlobPatch({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
    });

    test('$add 在锁内做增量，两个并发 +5 结果是 +10 而不是互相覆盖', () => {
        let blob = { sense: 100 };
        blob = mergeBlobPatch(blob, { sense: { $add: -5 } });
        blob = mergeBlobPatch(blob, { sense: { $add: -5 } });
        expect(blob.sense).toBe(90);
    });

    test('$add 对缺失键按 0 起步', () => {
        expect(mergeBlobPatch({}, { hp_bonus: { $add: 30 } })).toEqual({ hp_bonus: 30 });
    });

    test('$min 把增量钳在锁内判定，扣减不会把神识扣成负数', () => {
        let blob = { sense: 50 };
        blob = mergeBlobPatch(blob, { sense: { $add: -30, $min: 0 } });
        blob = mergeBlobPatch(blob, { sense: { $add: -30, $min: 0 } });
        expect(blob.sense).toBe(0);
    });

    test('$min 只钳下界，不影响正常增量', () => {
        expect(mergeBlobPatch({ sense: 50 }, { sense: { $add: 20, $min: 0 } }).sense).toBe(70);
    });

    test('$min 非数值同样报错，不静默变 NaN', () => {
        expect(() => mergeBlobPatch({ sense: 5 }, { sense: { $add: -1, $min: 'x' } })).toThrow(/\$min 非法/);
    });

    test('$max 钳住上限（残魂最多 100）', () => {
        expect(mergeBlobPatch({ remnant_soul: 90 }, { remnant_soul: { $add: 50, $max: 100 } }).remnant_soul).toBe(100);
    });

    test('$min 与 $max 同时给出时按先下后上钳制', () => {
        expect(mergeBlobPatch({ v: 5 }, { v: { $add: -9, $min: 0, $max: 10 } }).v).toBe(0);
        expect(mergeBlobPatch({ v: 5 }, { v: { $add: 9, $min: 0, $max: 10 } }).v).toBe(10);
    });

    test('$max 非数值报错', () => {
        expect(() => mergeBlobPatch({ v: 1 }, { v: { $add: 1, $max: 'x' } })).toThrow(/\$max 非法/);
    });

    test('$add 非数值直接报错，不静默变 NaN', () => {
        expect(() => mergeBlobPatch({ sense: 1 }, { sense: { $add: '5; DROP' } })).toThrow(/\$add 增量非法/);
    });

    test('BIGINT 列镜像进 blob 时收敛成 Number（JSON.stringify(BigInt) 会直接抛错）', () => {
        // 现场：hp_current/exp 等列从库里读出来是 BigInt 或字符串数字，
        // 镜像到 attributes 时若原样塞进去，setter 的 JSON.stringify 会抛
        // "Do not know how to serialize a BigInt"，等于整个恢复/战斗链路炸掉。
        const { toBlobMirror } = require('../game/persistence/PlayerStateStore');
        expect(toBlobMirror(1234567890123n)).toBe(1234567890123);
        expect(toBlobMirror('9007199254740993')).toBe(9007199254740993);
        expect(toBlobMirror(50)).toBe(50);
        expect(toBlobMirror(null)).toBe(null);
        expect(() => JSON.stringify({ hp_current: toBlobMirror(10n) })).not.toThrow();
    });

    test('不修改入参对象', () => {
        const current = { sense: 1 };
        mergeBlobPatch(current, { sense: 2 });
        expect(current.sense).toBe(1);
    });
});

describe('写入面的白名单与注入防护', () => {
    test('readForUpdate 必须带事务（否则拿不到行锁，等于没保护）', async () => {
        await expect(readForUpdate(1, {})).rejects.toThrow(/必须传入 transaction/);
    });

    test('非白名单列不能被增减', async () => {
        await expect(grantAmount(1, 'password', 1)).rejects.toThrow(/不允许增加的列/);
        await expect(spendAmount(1, 'is_banned', 1)).rejects.toThrow(/不允许扣减的列/);
        await expect(patchPlayerState(1, { amounts: { nickname: 'x' } })).rejects.toThrow(/不允许增减的列/);
    });

    test('标量列写入也走白名单，避免变成整行覆盖', async () => {
        await expect(patchPlayerState(1, { columns: { password: 'hacked' } }))
            .rejects.toThrow(/不允许写入的列: password/);
    });

    test('扣减量必须为正数', async () => {
        await expect(spendAmount(1, 'spirit_stones', 0)).rejects.toThrow(/必须为正数/);
        await expect(spendAmount(1, 'spirit_stones', -5)).rejects.toThrow(/必须为正数/);
    });

    test('非有限数值不能进入 SQL 字面量', async () => {
        await expect(grantAmount(1, 'exp', Infinity)).rejects.toThrow(/数值非法/);
        await expect(grantAmount(1, 'exp', NaN)).rejects.toThrow(/数值非法/);
        await expect(grantAmount(1, 'exp', '1; DROP TABLE players')).rejects.toThrow(/必须是整数/);
    });

    test('数值列白名单覆盖玩家主要资源', () => {
        for (const column of ['spirit_stones', 'exp', 'hp_current', 'mp_current', 'lifespan_current', 'attribute_points']) {
            expect(AMOUNT_COLUMNS.has(column)).toBe(true);
        }
    });
});
