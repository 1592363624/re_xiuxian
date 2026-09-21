/**
 * 属性系统安全边界单元测试
 *
 * 覆盖范围（对应 P0/P1/P2 修复）：
 *   - P0 丹药效果只来自服务端配置：客户端传入的 pill_effect 不再生效，
 *     属性键名走白名单、数值受单次与总量钳制
 *   - P1 恢复时长由服务端时钟推导：客户端只能缩短结算区间，无法放大
 *   - P2 属性加点白名单：未知属性名、非正整数（含负数刷点）一律拒绝
 *
 * 测试策略：纯逻辑，注入 mock configLoader，不接触 MySQL。
 */

const AttributeMaxService = require('../game/core/AttributeMaxService');

/** 服务端物品配置：只有 Tianluo 丹声明了永久属性上限加成，且数值故意超过单次上限 */
const ITEM_CONFIG = {
    items: [
        { id: 'hp_pill', type: 'consumable', name: '回血丹', effect: { hp_restore: 100 } },
        { id: 'tianluo_pill', type: 'consumable', name: '天罗丹', effect: { hp_max: 800, atk: 20 } },
        { id: 'broken_pill', type: 'consumable', name: '脏配置丹', effect: { hp_max: -999, atk: 'NaN', def: 1e400 } },
        { id: 'armor', type: 'equipment', name: '护甲', effect: { hp_max: 200 } }
    ]
};

const ATTRIBUTE_CONFIG = {
    attribute_recovery: {
        natural_recovery: { hp_recovery_per_minute: 1, mp_recovery_per_minute: 1 },
        meditation_recovery: { hp_recovery_per_minute: 2, mp_recovery_per_minute: 5 },
        recovery_settlement: { max_window_minutes: 1440, min_settlement_minutes: 1 }
    },
    attribute_pill_limits: {
        max_increase_per_use: 500,
        max_total_bonus_per_attribute: 1000,
        max_temp_boost_minutes: 1440
    }
};

function makeConfigLoader(configs) {
    return {
        getConfig: (name) => {
            if (!(name in configs)) throw new Error(`配置 ${name} 未加载`);
            return configs[name];
        },
        loadConfig: async (name) => configs[name] || {}
    };
}

async function initAttributeMaxService() {
    await AttributeMaxService.initialize(makeConfigLoader({
        item_data: ITEM_CONFIG,
        attribute_system: ATTRIBUTE_CONFIG,
        spirit_system: { realm_settings: {} }
    }));
}

beforeEach(async () => {
    await initAttributeMaxService();
});

describe('P0 丹药效果来源与钳制', () => {
    test('效果数值来自服务端配置，客户端入参不被采信', () => {
        const effect = AttributeMaxService.getPillMaxIncreaseEffect('tianluo_pill');

        expect(effect).toEqual({
            type: 'permanent_max_increase',
            // 配置原值（hp_max 800 / atk 20），单次上限在落到属性上时才钳制
            attributes: { hp_bonus: 800, atk_bonus: 20 }
        });

        const applied = AttributeMaxService.applyPillBonusToAttributes({}, effect);
        expect(applied).toEqual({ hp_bonus: 500, atk_bonus: 20 });   // hp_bonus 被单次上限 500 钳制
    });

    test('无属性上限加成的丹药/装备/未知物品均被拒绝', () => {
        expect(AttributeMaxService.getPillMaxIncreaseEffect('hp_pill')).toBeNull();
        expect(AttributeMaxService.getPillMaxIncreaseEffect('armor')).toBeNull();
        expect(AttributeMaxService.getPillMaxIncreaseEffect('not_exist')).toBeNull();
        expect(AttributeMaxService.getPillMaxIncreaseEffect(undefined)).toBeNull();
    });

    test('脏配置（负数/字符串/Infinity）不产生任何加成', () => {
        expect(AttributeMaxService.getPillMaxIncreaseEffect('broken_pill')).toBeNull();
    });

    test('sanitizePillEffect 丢弃白名单外键名与非法数值', () => {
        const sanitized = AttributeMaxService.sanitizePillEffect({
            type: 'permanent_max_increase',
            attributes: {
                hp_bonus: 10,
                lifespan_max: 999999,   // 白名单外：可绕过寿元体系
                ['__proto__']: 1,       // 危险键名（计算键写法才能成为自有属性）
                mp_bonus: -50,          // 负数
                atk_bonus: 'abc',       // 非数值
                def_bonus: 99999        // 超单次上限
            }
        });

        expect(sanitized).toEqual({
            type: 'permanent_max_increase',
            attributes: { hp_bonus: 10, def_bonus: 500 }
        });
    });

    test('sanitizePillEffect 对空/畸形入参返回 null', () => {
        expect(AttributeMaxService.sanitizePillEffect(null)).toBeNull();
        expect(AttributeMaxService.sanitizePillEffect('string')).toBeNull();
        expect(AttributeMaxService.sanitizePillEffect({})).toBeNull();
        expect(AttributeMaxService.sanitizePillEffect({ type: 'permanent_max_increase', attributes: {} })).toBeNull();
    });

    test('累加加成时按单属性总量上限钳制，且不修改入参', () => {
        const current = { hp_bonus: 900, atk_bonus: 5 };
        const next = AttributeMaxService.applyPillBonusToAttributes(current, {
            type: 'permanent_max_increase',
            attributes: { hp_bonus: 500, atk_bonus: 20 }
        });

        expect(next.hp_bonus).toBe(1000);   // 900 + 500 → 总量上限 1000
        expect(next.atk_bonus).toBe(25);
        expect(current).toEqual({ hp_bonus: 900, atk_bonus: 5 });
    });

    test('applyPillEffect 只回显当前上限，不重复叠加已入账或注入的加成', () => {
        const player = { realm: '凡人', attributes: {} };
        const baseMax = AttributeMaxService.calculateAttributeMaxValues(player);
        const maxValues = AttributeMaxService.applyPillEffect(player, {
            type: 'permanent_max_increase',
            attributes: { hp_bonus: 100, lifespan_max: 999999 }
        });

        // 加成的唯一入口是 applyPillBonusToAttributes → PlayerStateStore 落库；
        // 回显阶段不再凭空加值（改造前这里会 +100，而落库后的 attributes 又含同一份加成 = 双计）。
        // 注入的 lifespan_max 字段同样不改写寿元上限。
        expect(maxValues.hp_max).toBe(baseMax.hp_max);
        expect(maxValues.lifespan_max).toBe(baseMax.lifespan_max);

        // 加成落库后，上限自动体现（面板与恢复结算同源）
        const afterPill = { realm: '凡人', attributes: { hp_bonus: 100 } };
        expect(AttributeMaxService.calculateAttributeMaxValues(afterPill).hp_max).toBe(baseMax.hp_max + 100);
    });
});

describe('P1 恢复时长按服务端时钟结算', () => {
    const MINUTE = 60 * 1000;

    test('基准时点为 90 分钟前 → 结算 90 分钟', () => {
        const player = { attributes: { last_recovery_time: new Date(Date.now() - 90 * MINUTE).toISOString() } };

        expect(AttributeMaxService.resolveRecoveryMinutes(player)).toBe(90);
    });

    test('客户端放大时长无效，只能缩短结算区间', () => {
        const player = { attributes: { last_recovery_time: new Date(Date.now() - 10 * MINUTE).toISOString() } };

        expect(AttributeMaxService.resolveRecoveryMinutes(player, 99999)).toBe(10);
        expect(AttributeMaxService.resolveRecoveryMinutes(player, 3)).toBe(3);
    });

    test('客户端伪造过去的基准时间不影响结果（基准只读服务端存储值）', () => {
        const player = { attributes: { last_recovery_time: new Date().toISOString() } };

        // 刚结算过 → 无可恢复时长，传多大值都是 0
        expect(AttributeMaxService.resolveRecoveryMinutes(player, 100000)).toBe(0);
    });

    test('超长时间窗被钳制到配置上限', () => {
        const player = { attributes: { last_recovery_time: new Date(Date.now() - 30 * 24 * 60 * MINUTE).toISOString() } };

        expect(AttributeMaxService.resolveRecoveryMinutes(player)).toBe(1440);
    });

    test('无基准时点时不结算', () => {
        expect(AttributeMaxService.resolveRecoveryMinutes({ attributes: {} })).toBe(0);
        expect(AttributeMaxService.resolveRecoveryMinutes({})).toBe(0);
    });

    test('buildRecoveryWatermarkPatch 只产出时点键，不带走整份 attributes', () => {
        const before = Date.now();
        const patch = AttributeMaxService.buildRecoveryWatermarkPatch();

        // 补丁里除时点外不应有第二个键：多带任何一个键，就等于把调用方那份旧快照往回怼
        expect(Object.keys(patch)).toEqual(['last_recovery_time']);
        expect(new Date(patch.last_recovery_time).getTime()).toBeGreaterThanOrEqual(before);
    });

    test('配置缺失时回落到默认窗口（不抛错）', async () => {
        await AttributeMaxService.initialize(makeConfigLoader({
            item_data: ITEM_CONFIG,
            attribute_system: {},
            spirit_system: {}
        }));
        const player = { attributes: { last_recovery_time: new Date(Date.now() - 9999 * MINUTE).toISOString() } };

        expect(AttributeMaxService.resolveRecoveryMinutes(player)).toBe(1440);
    });
});

describe('P2 属性加点白名单', () => {
    const AttributeService = require('../game/core/AttributeService');

    beforeAll(async () => {
        await AttributeService.initialize(makeConfigLoader({
            role_init: {},
            realm_breakthrough: { realms: [] },
            spirit_system: {},
            talents: [],
            titles: []
        }));
    });

    // 加点的"策略"与"落库"已拆开：这里测纯策略（给定当前 attributes 与可用点，算出该写回什么）。
    // 落库路径（行锁 + 补丁写入）由 PlayerStateStore 的连库并发探针覆盖。
    const plan = (attributes, points, available) =>
        AttributeService.buildAllocationPlan(attributes || {}, points, available);

    test('负数加点被拒绝，不再反向刷出属性点', () => {
        const result = plan({}, { hp: -50 }, 0);
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/正整数/);
    });

    test('未知属性名被拒绝', () => {
        const result = plan({}, { lifespan_max: 5 }, 10);
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/未知的属性项/);
        expect(result.attributes).toBeUndefined();
    });

    test('非整数/零/字符串加点被拒绝', () => {
        for (const bad of [{ hp: 1.5 }, { hp: 0 }, { hp: '5' }, { hp: NaN }]) {
            expect(plan({}, bad, 10).ok).toBe(false);
        }
    });

    test('数组与空对象入参被拒绝', () => {
        expect(plan({}, [], 10).ok).toBe(false);
        expect(plan({}, {}, 10).ok).toBe(false);
        expect(plan({}, null, 10).ok).toBe(false);
    });

    test('原型链键名不能绕过白名单', () => {
        for (const key of ['__proto__', 'constructor', 'toString']) {
            expect(plan({}, { [key]: 1 }, 10).ok).toBe(false);
        }
    });

    test('超出可用点数的加点被拒绝', () => {
        const result = plan({}, { hp: 2, atk: 2 }, 3);
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/不足/);
    });

    test('合法加点写入白名单 bonus 键并记入账本', () => {
        const result = plan({}, { hp: 4, atk: 2 }, 10);
        expect(result.ok).toBe(true);
        expect(result.attributes.hp_bonus).toBe(4);
        expect(result.attributes.atk_bonus).toBe(2);
        expect(result.attributes.attribute_point_allocations).toEqual({ hp_bonus: 4, atk_bonus: 2 });
        expect(result.totalPointsNeeded).toBe(6);
    });

    test('累加已有加成，且钳制到单属性总量上限', () => {
        const result = plan({ hp_bonus: 999998 }, { hp: 100 }, 100);
        expect(result.attributes.hp_bonus).toBe(1000000);
        // 账本只记实际入账的 2 点，避免重置时多退
        expect(result.attributes.attribute_point_allocations.hp_bonus).toBe(2);
    });

    test('策略层不修改入参 attributes', () => {
        const attributes = { hp_bonus: 1 };
        plan(attributes, { hp: 5 }, 10);
        expect(attributes).toEqual({ hp_bonus: 1 });
    });
});
