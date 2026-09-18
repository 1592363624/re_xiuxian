/**
 * 属性丹服用链路与属性点重置单元测试
 *
 * 覆盖范围：
 *   - 背包"使用物品"与 POST /api/attribute/use_pill 共用同一套丹药加成解析（白名单 + 钳制）
 *   - 品质倍率参与计算但无法突破单次上限
 *   - 属性点重置只回收"加点账本"内的点数：丹药来源的 *_bonus 不被扣、也不折算成可分配点数
 *
 * 测试策略：纯逻辑 + 注入 mock configLoader，不接触 MySQL。
 */

const AttributeMaxService = require('../game/core/AttributeMaxService');
const AttributeService = require('../game/core/AttributeService');
const InventoryService = require('../game/services/InventoryService');

const ITEM_CONFIG = {
    items: [
        { id: 'qi_condensing_pill', name: '聚气丹', type: 'consumable', subtype: 'attribute', effect: { mp_max: 30 } },
        { id: 'nascent_soul_pill', name: '元婴丹', type: 'consumable', subtype: 'attribute', effect: { hp_max: 300, atk: 50 } },
        { id: 'overpowered_pill', name: '越界丹', type: 'consumable', effect: { hp_max: 999999 } },
        { id: 'mid_mana_pill', name: '凝气丹', type: 'consumable', subtype: 'mana', effect: { mp_restore: 50 } }
    ]
};

const ATTRIBUTE_CONFIG = {
    attribute_recovery: { natural_recovery: { hp_recovery_per_minute: 1, mp_recovery_per_minute: 1 } },
    attribute_pill_limits: {
        max_increase_per_use: 500,
        max_total_bonus_per_attribute: 1000,
        max_temp_boost_minutes: 1440
    },
    attribute_reset: { cost_spirit_stones: 500, cooldown_minutes: 1440 }
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

const ALL_CONFIGS = {
    item_data: ITEM_CONFIG,
    attribute_system: ATTRIBUTE_CONFIG,
    spirit_system: { realm_settings: {} },
    role_init: {},
    realm_breakthrough: { realms: [] },
    talents: [],
    titles: []
};

beforeAll(async () => {
    await AttributeMaxService.initialize(makeConfigLoader(ALL_CONFIGS));
    AttributeService.initialize(makeConfigLoader(ALL_CONFIGS));
});

describe('配置驱动的丹药效果解析', () => {
    test('effect 字段映射为白名单内的 bonus 键', () => {
        expect(AttributeMaxService.buildPillEffectFromConfig({ mp_max: 30 })).toEqual({
            type: 'permanent_max_increase',
            attributes: { mp_bonus: 30 }
        });
        expect(AttributeMaxService.buildPillEffectFromConfig({ hp_max: 300, atk: 50 }).attributes)
            .toEqual({ hp_bonus: 300, atk_bonus: 50 });
    });

    test('非属性类效果与脏值不产生加成', () => {
        expect(AttributeMaxService.buildPillEffectFromConfig({ hp_restore: 100 })).toBeNull();
        expect(AttributeMaxService.buildPillEffectFromConfig({ exp: 500 })).toBeNull();
        expect(AttributeMaxService.buildPillEffectFromConfig({ hp_max: '30' })).toBeNull();
        expect(AttributeMaxService.buildPillEffectFromConfig(null)).toBeNull();
        expect(AttributeMaxService.buildPillEffectFromConfig(undefined)).toBeNull();
    });

    test('item_key 解析：消耗品才有效果，装备与不存在物品返回 null', () => {
        expect(AttributeMaxService.getPillMaxIncreaseEffect('qi_condensing_pill')).not.toBeNull();
        expect(AttributeMaxService.getPillMaxIncreaseEffect('mid_mana_pill')).toBeNull();
        expect(AttributeMaxService.getPillMaxIncreaseEffect('nope')).toBeNull();
    });

    test('品质倍率参与计算，但单次收益仍受上限钳制', () => {
        const effect = AttributeMaxService.getPillMaxIncreaseEffect('qi_condensing_pill');

        const boosted = AttributeMaxService.applyPillBonusToAttributes({}, effect, 1.5);
        expect(boosted.mp_bonus).toBe(45);

        // 越界丹名义值 999999：无论品质倍率多高，单次最多 500
        const capped = AttributeMaxService.applyPillBonusToAttributes({}, {
            type: 'permanent_max_increase',
            attributes: { hp_bonus: 999999 }
        }, 20);
        expect(capped.hp_bonus).toBe(500);
    });

    test('脏倍率入参回落到 1 倍，数字字符串按数值处理（DB metadata 可能存成字符串）', () => {
        const effect = AttributeMaxService.getPillMaxIncreaseEffect('qi_condensing_pill');
        for (const bad of [NaN, null, undefined, -3, 0, 'abc', {}]) {
            expect(AttributeMaxService.applyPillBonusToAttributes({}, effect, bad).mp_bonus).toBe(30);
        }
        expect(AttributeMaxService.applyPillBonusToAttributes({}, effect, '2').mp_bonus).toBe(60);
    });

    test('diffAttributeBonuses 只报告白名单键的增量', () => {
        const diff = AttributeMaxService.diffAttributeBonuses(
            { mp_bonus: 10, atk_bonus: 5, toxicity: 3 },
            { mp_bonus: 40, atk_bonus: 5, toxicity: 9 }
        );

        expect(diff).toEqual({ mp_bonus: 30 });
    });
});

describe('背包使用物品链路（InventoryService）', () => {
    const makePlayer = () => ({
        hp_current: 10,
        mp_current: 0,
        exp: 0n,
        spirit_stones: 0n,
        attributes: { hp_max: 100, mp_max: 50 }
    });

    test('属性丹通过 _applyItemEffect 写入 bonus 并回显实际增量', async () => {
        const player = makePlayer();
        const effect = ITEM_CONFIG.items.find(i => i.id === 'nascent_soul_pill').effect;

        const applied = await InventoryService._applyItemEffect(player, effect, 1, 1, null);

        expect(player.attributes.hp_bonus).toBe(300);
        expect(player.attributes.atk_bonus).toBe(50);
        expect(applied.permanent_attribute_bonus).toEqual({ hp_bonus: 300, atk_bonus: 50 });
    });

    test('已达总量上限时不再产生增量，也不回显空加成', async () => {
        const player = makePlayer();
        player.attributes.hp_bonus = 1000;   // 配置上限 1000

        const applied = await InventoryService._applyItemEffect(
            player,
            { hp_max: 300 },
            1,
            1,
            null
        );

        expect(player.attributes.hp_bonus).toBe(1000);
        expect(applied.permanent_attribute_bonus).toBeUndefined();
    });

    test('普通回复类丹药物品行为不受影响', async () => {
        const player = makePlayer();
        const applied = await InventoryService._applyItemEffect(player, { mp_restore: 50 }, 1, 1, null);

        expect(Number(player.mp_current)).toBe(50);
        expect(applied.mp_restore).toBe(50);
        expect(applied.permanent_attribute_bonus).toBeUndefined();
    });

    test('永久属性丹拒绝批量使用（校验发生在查库之前）', async () => {
        InventoryService.initialize(makeConfigLoader(ALL_CONFIGS));

        await expect(InventoryService.useItem(1, 'nascent_soul_pill', 3))
            .rejects.toThrow('每次只能使用 1 颗');
    });
});

describe('落盘配置自检', () => {
    const REAL_ITEMS = require('../config/item_data.json').items;
    const ATTRIBUTE_PILLS = [
        'qi_condensing_pill',
        'qi_condensation_pill',
        'core_formation_pill',
        'xuanji_pill',
        'nascent_soul_pill'
    ];

    beforeAll(async () => {
        await AttributeMaxService.initialize(makeConfigLoader({
            item_data: require('../config/item_data.json'),
            attribute_system: require('../config/attribute_system.json'),
            spirit_system: require('../config/spirit_system.json')
        }));
    });

    afterAll(async () => {
        await AttributeMaxService.initialize(makeConfigLoader(ALL_CONFIGS));
    });

    test('新增属性丹都存在于 item_data 且效果键被服务端白名单识别', () => {
        for (const key of ATTRIBUTE_PILLS) {
            const item = REAL_ITEMS.find(i => i.id === key);
            expect(item).toBeTruthy();
            expect(item.type).toBe('consumable');

            const effect = AttributeMaxService.getPillMaxIncreaseEffect(key);
            expect(effect).toBeTruthy();
            // 配置里的每个属性字段都要落到对应 bonus 键上，不能出现写了却无效的效果
            expect(Object.keys(effect.attributes).length)
                .toBe(Object.keys(item.effect).filter(k => k !== 'comment').length);
        }
    });

    test('属性丹数值不超过服务端单次上限，且新增物品不与现有物品重名', () => {
        const { max_increase_per_use } = AttributeMaxService.getPillLimitsConfig();
        const newNames = ATTRIBUTE_PILLS.map(key => REAL_ITEMS.find(i => i.id === key).name);
        expect(new Set(newNames).size).toBe(newNames.length);

        for (const key of ATTRIBUTE_PILLS) {
            const item = REAL_ITEMS.find(i => i.id === key);
            for (const value of Object.values(item.effect)) {
                expect(value).toBeLessThanOrEqual(max_increase_per_use);
            }
            expect(REAL_ITEMS.filter(i => i.name === item.name).map(i => i.id)).toEqual([key]);
        }
    });
});

describe('属性点重置只回收加点账本', () => {
    const makePlayer = (overrides = {}) => ({
        attribute_points: 0,
        attributes: {},
        realm: '凡人',
        async save() { /* 纯逻辑测试不入库 */ },
        ...overrides
    });

    test('加点会记账，重置按记账值回收并退回点数', async () => {
        const player = makePlayer({ attribute_points: 10 });
        await AttributeService.allocatePoints(player, { hp: 4, atk: 2 });

        expect(player.attributes.attribute_point_allocations).toEqual({ hp_bonus: 4, atk_bonus: 2 });

        const plan = AttributeService.buildAllocatedPointsReset(player);
        expect(plan.refundablePoints).toBe(6);
        expect(plan.refunded).toEqual({ hp_bonus: 4, atk_bonus: 2 });
        expect(plan.attributes.hp_bonus).toBe(0);
        expect(plan.attributes.attribute_point_allocations).toBeUndefined();
    });

    test('丹药来源的加成不被扣掉，也不折算成可分配点数', async () => {
        const player = makePlayer({ attribute_points: 10 });
        await AttributeService.allocatePoints(player, { hp: 3 });
        // 模拟吃了聚气丹与元婴丹后的加成（不走账本）
        player.attributes = AttributeMaxService.applyPillBonusToAttributes(
            player.attributes,
            { type: 'permanent_max_increase', attributes: { hp_bonus: 300, mp_bonus: 30 } },
            1
        );

        const plan = AttributeService.buildAllocatedPointsReset(player);

        expect(plan.refundablePoints).toBe(3);           // 只退加点的 3 点
        expect(plan.attributes.hp_bonus).toBe(300);      // 丹药的 300 点保留
        expect(plan.attributes.mp_bonus).toBe(30);
    });

    test('账本值大于实际加成时按较小值回收，不会扣出负数', () => {
        const player = makePlayer({
            attributes: {
                hp_bonus: 2,
                attribute_point_allocations: { hp_bonus: 50 }
            }
        });

        const plan = AttributeService.buildAllocatedPointsReset(player);

        expect(plan.refundablePoints).toBe(2);
        expect(plan.attributes.hp_bonus).toBe(0);
    });

    test('账本被注入未知键或脏值时不产生任何回收', () => {
        const player = makePlayer({
            attributes: {
                hp_bonus: 10,
                lifespan_max_bonus: 9999,
                attribute_point_allocations: {
                    lifespan_max_bonus: 9999,
                    ['__proto__']: 500,
                    hp_bonus: 'abc',
                    atk_bonus: -5
                }
            }
        });

        const plan = AttributeService.buildAllocatedPointsReset(player);

        expect(plan.refundablePoints).toBe(0);
        expect(plan.attributes.lifespan_max_bonus).toBe(9999);
        expect(plan.attributes.hp_bonus).toBe(10);
    });

    test('无账本（历史玩家）时回收为 0，路由据此拒绝扣费', () => {
        const plan = AttributeService.buildAllocatedPointsReset(makePlayer({ attributes: { hp_bonus: 50 } }));

        expect(plan.refundablePoints).toBe(0);
        expect(plan.attributes.hp_bonus).toBe(50);
    });

    test('buildAttributesAfterReset 记录重置时点并清掉账本', () => {
        const plan = AttributeService.buildAllocatedPointsReset(makePlayer({
            attributes: { hp_bonus: 4, attribute_point_allocations: { hp_bonus: 4 } }
        }));
        const before = Date.now();
        const next = AttributeService.buildAttributesAfterReset(plan);

        expect(next.attribute_point_allocations).toBeUndefined();
        expect(new Date(next.last_attribute_reset_time).getTime()).toBeGreaterThanOrEqual(before);
    });

    test('重置规则可读配置，配置缺失时兜底', () => {
        expect(AttributeService.getAttributeResetConfig()).toEqual({
            cost_spirit_stones: 500,
            cooldown_minutes: 1440
        });

        AttributeService.initialize(makeConfigLoader({ attribute_system: { attribute_reset: { cost_spirit_stones: -1 } } }));
        expect(AttributeService.getAttributeResetConfig()).toEqual({
            cost_spirit_stones: 500,
            cooldown_minutes: 1440
        });

        AttributeService.initialize(makeConfigLoader(ALL_CONFIGS));
    });
});
