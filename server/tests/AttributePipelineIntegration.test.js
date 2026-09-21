/**
 * 属性管线端到端集成测试（走真实的 AttributeService + 真实属性词表）
 *
 * 这里验的不是引擎的算法（那在 StatRegistryEngine.test.js），而是"改造后的服务
 * 是否仍然满足既有调用契约 + 新属性是否真的贯通到所有消费点"。
 */
'use strict';

const { statRegistry, ensureStatRegistryLoaded } = require('../game/stats');
const AttributeService = require('../game/core/AttributeService');
const AttributeMaxService = require('../game/core/AttributeMaxService');

/** 只给属性计算用到的那几个配置，避免测试与真实 json 内容耦合过深 */
function makeConfigLoader(overrides = {}) {
    const configs = {
        role_init: {
            spiritRootBonuses: {
                金: { atk: 4, def: 2 },
                火: { atk: 5, speed: 2 }
            }
        },
        realm_breakthrough: {
            realms: [
                { name: '凡人', rank: 0, base_hp: 100, base_mp: 0, base_atk: 10, base_def: 5, base_speed: 10, base_sense: 10, lifespan_max: 60 },
                { name: '炼气期1层', rank: 1, base_hp: 200, base_mp: 50, base_atk: 25, base_def: 12, base_speed: 14, base_sense: 18, lifespan_max: 120 }
            ]
        },
        spirit_system: { realm_settings: { 凡人: {}, 炼气期1层: { spirit_power_max: 5000 } } },
        talents: [{ id: 'sword_genius', name: '剑道奇才', bonuses: { atk_pct: 20, cultivate_speed_pct: 25 } }],
        titles: [{ id: 'hermit', name: '隐士', bonuses: { sense: 40, hp_max_pct: 10 } }],
        game_balance: { equipment: { refine: { bonus_per_level: {} } } },
        attribute_system: { attribute_reset: { cost_spirit_stones: 500, cooldown_minutes: 1440 } },
        ...overrides
    };
    return {
        getConfig: (name) => {
            if (!(name in configs)) throw new Error(`配置 ${name} 未加载`);
            return configs[name];
        },
        hasConfig: (name) => name in configs
    };
}

const makePlayer = (over = {}) => ({
    id: 101,
    realm: '炼气期1层',
    spirit_root: '金',
    talent_id: 'sword_genius',
    equipped_title_id: 'hermit',
    attribute_points: 10,
    attributes: { luck: 12, wisdom: 8, atk_bonus: 6, hp_bonus: 30 },
    ...over
});

beforeEach(() => {
    ensureStatRegistryLoaded();
    AttributeService._engine = null;
});

describe('静态快照与旧契约兼容', () => {
    test('同步路径 = 境界 + 灵根 + 加点 + 天赋 + 称号（不含查库来源）', () => {
        AttributeService.initialize(makeConfigLoader());
        const { final } = AttributeService.calculateFullAttributes(makePlayer());

        // atk: 境界 25 + 灵根金 4 + 加点 6 = 35，天赋 atk_pct 20% → 42
        expect(final.atk).toBe(42);
        // hp_max: 200 + 30(灵根无) + 加点 30 = 230，称号 hp_max_pct 10% → 253
        expect(final.hp_max).toBe(253);
        expect(final.def).toBe(14);        // 境界 12 + 灵根金 2
        expect(final.sense).toBe(58);      // 境界 18 + 称号 40
        expect(final.luck).toBe(12);
        expect(final.wisdom).toBe(8);
        expect(final.mp_max).toBe(5000);   // spirit_system 优先于 realm.base_mp
    });

    test('百分比键不再泄漏进属性面板（旧代码会把 atk_pct 当成一个属性留在 final 里）', () => {
        AttributeService.initialize(makeConfigLoader());
        const { final } = AttributeService.calculateFullAttributes(makePlayer());
        expect(Object.keys(final).filter(k => k.endsWith('_pct'))).toEqual([]);
    });

    test('breakdown 保留旧分组名，WorldBossService / 前端读取路径不变', () => {
        AttributeService.initialize(makeConfigLoader());
        const { breakdown } = AttributeService.calculateFullAttributes(makePlayer());
        for (const group of ['base', 'spirit_root', 'allocated', 'talent', 'title', 'equipment', 'spirit_beast', 'cultivation']) {
            expect(breakdown).toHaveProperty(group);
        }
        expect(breakdown.spirit_root).toEqual({ atk: 4, def: 2 });
        expect(breakdown.allocated).toEqual({ atk: 6, hp_max: 30 });
        expect(breakdown.title.sense).toBe(40);
    });

    test('info 保留旧字段（talent/title/spirit_root/spirit_beast/technique_skills）', () => {
        AttributeService.initialize(makeConfigLoader());
        const { info } = AttributeService.calculateFullAttributes(makePlayer());
        expect(info.talent).toMatchObject({ id: 'sword_genius' });
        expect(info.title).toMatchObject({ id: 'hermit' });
        expect(info.spirit_root).toBe('金');
        expect(info.spirit_beast).toBeNull();
        expect(info.technique_skills).toEqual([]);
    });

    test('缺境界配置时不崩，按属性默认兜底，并且必须报出来是谁查不到', () => {
        const warned = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            AttributeService.initialize(makeConfigLoader());
            const { final, breakdown } = AttributeService.calculateFullAttributes(makePlayer({ realm: '不存在的境界', spirit_root: '无' }));
            expect(breakdown.base.hp_max).toBe(100);  // 境界缺失 → 定义里的 default
            expect(final.hp_max).toBe(143);           // (100 + 30 加点) × 1.1 称号
            expect(final.atk).toBeGreaterThan(0);
            // "查不到境界"过去是静默的：真仙会按凡人基础值算，面板照开、日志无声。
            // 这条兜底本身是对的（不能让面板挂），要的是它必须留下声音。
            const messages = warned.mock.calls.map(call => call.join(' ')).join('\n');
            expect(messages).toMatch(/境界「不存在的境界」[\s\S]*default 兜底/);
        } finally {
            warned.mockRestore();
        }
    });

    test('境界基础值确实进属性：同一个人从凡人提到炼气期，面板要按境界表涨', () => {
        AttributeService.initialize(makeConfigLoader());
        const mortal = AttributeService.calculateFullAttributes(makePlayer({ realm: '凡人' }));
        const qi = AttributeService.calculateFullAttributes(makePlayer({ realm: '炼气期1层' }));
        // base 分组里就是境界表那一行的基础值（配置：凡人 atk10/hp100，炼气期1层 atk25/hp200）
        expect(mortal.breakdown.base).toMatchObject({ atk: 10, hp_max: 100 });
        expect(qi.breakdown.base).toMatchObject({ atk: 25, hp_max: 200 });
        // 最终值同向增长：境界加成不是"看着有、算起来没有"
        expect(qi.final.atk).toBeGreaterThan(mortal.final.atk);
        expect(qi.final.hp_max).toBeGreaterThan(mortal.final.hp_max);
    });
});

describe('完整快照（异步路径）', () => {
    test('装备/灵兽/功法/法宝深线加成进入 final 与 breakdown', async () => {
        AttributeService.initialize(makeConfigLoader());
        const player = makePlayer();
        const { final, breakdown } = await AttributeService.calculateFullAttributesAsync(player, {
            sourceOverrides: {
                equipment: { atk: 20, def: 10 },
                spirit_beast: { atk: 8, hp_max: 120, beast_info: { beast_name: '青羽狼' } },
                technique: { hp_max: 50, cultivate_speed_pct: 30, skills: ['sword_rain'] },
                artifact_deep_line: {
                    is_active: true,
                    absolute: { def: 15 },
                    percent: { atk: 0.1 },
                    effects: { crit: 12 },
                    breakdown: { blood_sword: { percent: { atk: 0.1 } } }
                }
            }
        });

        // atk：绝对值 (25 境界 + 4 灵根 + 6 加点 + 20 装备 + 8 灵兽) = 63，
        // 百分比 (天赋 20% + 法宝深线 10%) = 30% → 81
        expect(final.atk).toBe(81);
        expect(breakdown.equipment.atk).toBe(20);
        expect(breakdown.spirit_beast.atk).toBe(8);
        expect(breakdown.cultivation.hp_max).toBe(50);
        expect(final.hp_max).toBe(440);   // (200 + 30 加点 + 120 灵兽 + 50 功法) × 1.1 称号
        expect(final.def).toBe(39);       // 12 + 2 灵根 + 10 装备 + 15 法宝绝对值
        expect(breakdown.artifact_deep_line.is_active).toBe(true);
        expect(breakdown.artifact_deep_line.effects).toEqual({ crit: 12 });
        expect(breakdown.artifact_deep_line.percent).toEqual({ atk: 0.1 });
    });

    test('战斗要用的信息透传到 info：灵兽概览 / 法宝特效 / 功法神通', async () => {
        AttributeService.initialize(makeConfigLoader());
        const { info } = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: {
                spirit_beast: { atk: 8, beast_info: { beast_name: '青羽狼', star_level: 3 } },
                technique: { atk: 5, skills: ['sword_rain', 'fire_wall'] },
                artifact_deep_line: { is_active: true, absolute: {}, percent: {}, effects: { lifesteal: 8 }, breakdown: {} }
            }
        });
        expect(info.spirit_beast).toMatchObject({ beast_name: '青羽狼', star_level: 3 });
        expect(info.technique_skills).toEqual(['sword_rain', 'fire_wall']);
        expect(info.artifact_deep_line).toEqual({ lifesteal: 8 });
    });

    test('不再往 player 实例上挂临时字段（旧的 _equipmentBonus 并发互踩问题）', async () => {
        AttributeService.initialize(makeConfigLoader());
        const player = makePlayer();
        await AttributeService.calculateFullAttributesAsync(player, {
            sourceOverrides: { equipment: { atk: 20 } }
        });
        expect(Object.keys(player).filter(k => k.startsWith('_'))).toEqual([]);
        expect(player._equipmentBonus).toBeUndefined();
    });

    test('同一 player 实例并发两次求解，结果互不污染', async () => {
        AttributeService.initialize(makeConfigLoader());
        const player = makePlayer();

        const [a, b] = await Promise.all([
            AttributeService.calculateFullAttributesAsync(player, { sourceOverrides: { equipment: { atk: 10 } } }),
            AttributeService.calculateFullAttributesAsync(player, { sourceOverrides: { equipment: { atk: 90 } } })
        ]);

        expect(a.final.atk).toBe(54);   // (35 + 10) × 1.2
        expect(b.final.atk).toBe(150);  // (35 + 90) × 1.2
        expect(a.final.atk).toBeLessThan(b.final.atk);
    });

    test('某个来源查询失败时降级为无加成，不影响其余来源', async () => {
        AttributeService.initialize(makeConfigLoader());
        const { final, meta } = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: {
                equipment: { atk: 10 },
                spirit_beast: Promise.reject(new Error('beast db down'))
            }
        });
        expect(final.atk).toBe(54);
        expect(meta.provider_failures.some(f => f.id === 'spirit_beast')).toBe(true);
    });
});

describe('新属性贯通性（回归到服务层）', () => {
    afterEach(() => {
        ensureStatRegistryLoaded();
        AttributeService._engine = null;
    });

    test('资料片加一个新属性 + 一件带它的武器：面板/明细/战力自动出现，服务代码零改动', async () => {
        // 模拟内容层装载"带新属性的资料片词表"
        const defs = statRegistry.all().map(d => ({ ...d }));
        defs.push({
            key: 'sword_intent',
            label: '剑意',
            icon: '🗡️',
            group: 'offense',
            unit: 'point',
            base: { default: 0 },
            allocatable: true,
            bonusKey: 'sword_intent_bonus',
            pill: true,
            refineRate: 0.05,
            powerWeight: 2.2,
            panel: { visible: true, order: 33 },
            battleRoles: ['damage_sword']
        });
        statRegistry.reset();
        statRegistry.load(defs, 'test-pack');
        statRegistry.validate();
        AttributeService._engine = null;

        AttributeService.initialize(makeConfigLoader());
        const { final, breakdown } = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: { equipment: { sword_intent: 45, atk: 10 } }
        });

        // 1. 最终属性
        expect(final.sword_intent).toBe(45);
        // 2. 来源明细
        expect(breakdown.equipment.sword_intent).toBe(45);
        // 3. 面板 schema（前端按此渲染，不需要再改前端标签表）
        expect(AttributeService.getPanelSchema().find(s => s.key === 'sword_intent'))
            .toMatchObject({ label: '剑意', icon: '🗡️' });
        // 4. 可加点白名单自动包含它
        expect(AttributeService.allocatableBonusKeys.sword_intent).toBe('sword_intent_bonus');
        // 5. 战斗按 battleRole 取属性
        expect(statRegistry.battleRoleIndex().damage_sword).toEqual(['sword_intent']);
        // 6. 战力按注册表权重自动计入
        const power = statRegistry.all().reduce((sum, d) => sum + (final[d.key] || 0) * d.powerWeight, 0);
        expect(power).toBeGreaterThan(45 * 2.2);
    });

    test('已有装备补一个新字段，静态与异步路径都读到', async () => {
        AttributeService.initialize(makeConfigLoader());
        const before = AttributeService.calculateFullAttributes(makePlayer());
        expect(before.final.matk).toBe(0);

        const after = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: { equipment: { matk: 18 } }
        });
        expect(after.final.matk).toBe(18);
        expect(after.breakdown.equipment.matk).toBe(18);
    });

    test('all_stats_bonus 通配对新属性同样生效，且不污染百分比型属性', async () => {
        AttributeService.initialize(makeConfigLoader());
        const { final } = await AttributeService.calculateFullAttributesAsync(makePlayer(), {
            sourceOverrides: { equipment: { all_stats_bonus: 10 } }
        });
        expect(final.matk).toBe(10);
        expect(final.mdef).toBe(10);
        expect(final.atk).toBe(54);              // (35 + 10) × 1.2
        expect(final.crit_rate).toBe(5);         // 概率型属性不被"全属性"加 10 个百分点
    });
});

describe('两条属性管线统一（面板与恢复/上限结算同源）', () => {
    test('AttributeMaxService 的上限与 AttributeService 面板 final 完全一致', () => {
        AttributeService.initialize(makeConfigLoader());
        const player = makePlayer();

        const { final } = AttributeService.calculateFullAttributes(player);
        const maxValues = AttributeMaxService.calculateAttributeMaxValues(player, {
            name: '炼气期1层', base_hp: 200, base_mp: 50, lifespan_max: 120
        });

        expect(maxValues.hp_max).toBe(final.hp_max);
        expect(maxValues.mp_max).toBe(final.mp_max);
        expect(maxValues.lifespan_max).toBe(final.lifespan_max);
    });

    test('有 *_bonus 的玩家不会被"恢复上限"压掉面板上限（改造前两者相差一个加成总和）', () => {
        AttributeService.initialize(makeConfigLoader());
        const player = makePlayer({ attributes: { hp_bonus: 500, luck: 10, wisdom: 10 } });

        const { final } = AttributeService.calculateFullAttributes(player);
        const maxValues = AttributeMaxService.calculateAttributeMaxValues(player);

        // 旧实现里 maxValues.hp_max 恒等于 realm.base_hp(200)，
        // 于是 hp_current 能被恢复到 483 却按 200 校验为"超限"并 clamp 回退。
        expect(final.hp_max).toBe(770);   // (200 + 500) × 1.1 称号 hp_max_pct 10
        expect(maxValues.hp_max).toBe(final.hp_max);
    });

    test('丹药上限白名单来自注册表：新属性标 pill:true 即可被丹方使用', () => {
        const defs = statRegistry.all().map(d => ({ ...d }));
        defs.push({ key: 'body_refine', label: '炼体', base: { default: 0 }, pill: true, bonusKey: 'body_refine_bonus' });
        statRegistry.reset();
        statRegistry.load(defs, 'test-pack');
        statRegistry.validate();

        const effect = AttributeMaxService.buildPillEffectFromConfig({ body_refine: 40, not_effect: 99 });
        expect(effect).toEqual({ type: 'permanent_max_increase', attributes: { body_refine_bonus: 40 } });

        ensureStatRegistryLoaded();
        AttributeService._engine = null;
    });

    afterEach(() => {
        ensureStatRegistryLoaded();
        AttributeService._engine = null;
    });
});

describe('加点仍受注册表约束', () => {
    test('未注册属性不能加点', () => {
        AttributeService.initialize(makeConfigLoader());
        const plan = AttributeService.buildAllocationPlan({}, { not_a_stat: 1 }, 10);
        expect(plan.ok).toBe(false);
        expect(plan.message).toMatch(/未知的属性项/);
    });

    test('新注册的可加点属性能被加点并进账本', () => {
        const defs = statRegistry.all().map(d => ({ ...d }));
        defs.push({ key: 'pet_power', label: '兽威', base: { default: 0 }, allocatable: true, bonusKey: 'pet_power_bonus' });
        statRegistry.reset();
        statRegistry.load(defs, 'test-pack');
        statRegistry.validate();
        AttributeService._engine = null;
        AttributeService.initialize(makeConfigLoader());

        const plan = AttributeService.buildAllocationPlan({}, { pet_power: 3 }, 10);
        expect(plan.ok).toBe(true);
        expect(plan.attributes.pet_power_bonus).toBe(3);
        expect(plan.attributes.attribute_point_allocations.pet_power_bonus).toBe(3);

        const reset = AttributeService.buildAllocatedPointsReset({ attributes: plan.attributes });
        expect(reset.refundablePoints).toBe(3);
        expect(reset.attributes.pet_power_bonus).toBe(0);
    });

    afterEach(() => {
        ensureStatRegistryLoaded();
        AttributeService._engine = null;
    });
});
