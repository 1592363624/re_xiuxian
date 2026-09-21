/**
 * 属性注册中心 / 求解引擎 / 表达式求值器 单元测试
 *
 * 重点是最后那组"扩展性验收"：只加一条属性定义 + 一条物品 effect，
 * 面板、加点、战力、战斗公式、来源明细是否全部自动认这个新属性。
 * 这是本次架构改造的核心承诺，不通过就不算完成。
 */
'use strict';

const Expr = require('../game/stats/Expr');
const { StatRegistry, StatDefinitionError } = require('../game/stats/StatRegistry');
const { StatEngine, normalizeModifiers } = require('../game/stats/StatEngine');
const baseDefs = require('../config/stat_definitions.json').stats;

function makeRegistry(extraDefs = []) {
    const registry = new StatRegistry();
    registry.load(baseDefs, 'base');
    if (extraDefs.length) registry.load(extraDefs, 'test-pack');
    registry.validate();
    return registry;
}

function makeEngine(registry, providers, options = {}) {
    const engine = new StatEngine(registry, options);
    for (const provider of providers) engine.registerProvider(provider);
    return engine;
}

const ctx = (over = {}) => ({
    player: { id: 1, realm: '炼气期1层' },
    realm: { base_hp: 100, base_mp: 20, base_atk: 10, base_def: 5, base_speed: 10, base_sense: 10 },
    spiritRealm: { spirit_power_max: 120 },
    attributes: { luck: 12, wisdom: 8 },
    ...over
});

describe('Expr 受限表达式求值', () => {
    test('四则/优先级/括号/一元负号', () => {
        expect(Expr.evaluate('1 + 2 * 3')).toBe(7);
        expect(Expr.evaluate('(1 + 2) * 3')).toBe(9);
        expect(Expr.evaluate('-4 + 2')).toBe(-2);
        expect(Expr.evaluate('7 % 3')).toBe(1);
    });

    test('^ 右结合', () => {
        expect(Expr.evaluate('2^3^2')).toBe(512);
    });

    test('白名单函数', () => {
        expect(Expr.evaluate('floor(7 / 2)')).toBe(3);
        expect(Expr.evaluate('max(1, 2, 3)')).toBe(3);
        expect(Expr.evaluate('clamp(99, 0, 10)')).toBe(10);
    });

    test('标识符取自上下文', () => {
        expect(Expr.evaluate('atk * 2 - def', { atk: 50, def: 12 })).toBe(88);
    });

    test('未登记标识符报错，不静默按 0 计算', () => {
        expect(() => Expr.evaluate('atk + nope', { atk: 1 })).toThrow(/未知标识符 "nope"/);
    });

    test('拒绝代码注入面：字符串、点号访问、非白名单函数、赋值', () => {
        expect(() => Expr.evaluate('require("fs")')).toThrow(/不支持的字符/);
        expect(() => Expr.evaluate('process.exit(1)')).toThrow(/不支持的字符/);
        expect(() => Expr.evaluate('a.b', { a: 1 })).toThrow(/不支持的字符/);
        expect(() => Expr.evaluate('x = 1', { x: 0 })).toThrow(/不支持的字符/);
    });

    test('语法错误有定位信息', () => {
        expect(() => Expr.evaluate('1 +', '', 'hp_max')).toThrow(/hp_max/);
        expect(() => Expr.evaluate('(1 + 2')).toThrow(/缺少右括号/);
    });

    test('compile 复用同一 token 流', () => {
        const fn = Expr.compile('atk + def');
        expect(fn({ atk: 1, def: 2 })).toBe(3);
        expect(fn({ atk: 10, def: 20 })).toBe(30);
    });

    test('referencedIdents 供装配期校验，且不含函数名', () => {
        expect([...Expr.referencedIdents('max(a, b) + c')].sort()).toEqual(['a', 'b', 'c']);
    });
});

describe('StatRegistry 属性词表', () => {
    test('基础词表可加载，且原有属性全部保留', () => {
        const registry = makeRegistry();
        for (const key of ['hp_max', 'mp_max', 'atk', 'def', 'speed', 'sense', 'luck', 'wisdom', 'cultivate_speed']) {
            expect(registry.has(key)).toBe(true);
        }
    });

    test('加点白名单由定义推导，等价于旧 ALLOCATABLE_BONUS_KEYS', () => {
        const registry = makeRegistry();
        expect(registry.allocatableMap()).toMatchObject({
            hp: 'hp_bonus', mp: 'mp_bonus', atk: 'atk_bonus', def: 'def_bonus',
            speed: 'speed_bonus', sense: 'sense_bonus'
        });
    });

    test('丹药白名单由定义推导，覆盖旧 PILL_BONUS_KEY_MAP 且随定义自动扩展', () => {
        const registry = makeRegistry();
        const pillMap = registry.pillEffectMap();
        // 旧白名单的每一项都还在（不吃丹药的老行为不变）
        expect(pillMap).toMatchObject({
            hp_max: 'hp_bonus', mp_max: 'mp_bonus', atk: 'atk_bonus',
            def: 'def_bonus', speed: 'speed_bonus', sense: 'sense_bonus'
        });
        // 新属性标了 pill:true 就自动可被丹方使用，无需再改第二处白名单
        expect(pillMap.matk).toBe('matk_bonus');
        expect(pillMap.crit_rate).toBeUndefined();
        expect(Object.keys(pillMap).sort()).toEqual(
            registry.all().filter(d => d.pill).map(d => d.pillEffectKey).sort()
        );
    });

    test('祭炼系数由定义推导，等价于旧 game_balance.bonus_per_level', () => {
        const registry = makeRegistry();
        expect(registry.refineRateMap()).toEqual({
            hp_max: 0.05, mp_max: 0.05, atk: 0.05, def: 0.05, speed: 0.03, sense: 0.03,
            matk: 0.05, mdef: 0.05
        });
    });

    test('面板字段带标签/图标/说明，前端不再各自硬编码', () => {
        const registry = makeRegistry();
        const panel = registry.panelStats();
        expect(panel.find(s => s.key === 'atk')).toMatchObject({ label: '物理攻击', icon: '⚔️' });
        expect(panel.find(s => s.key === 'crit_rate').suffix).toBe('%');
        expect(panel.map(s => s.order)).toEqual([...panel.map(s => s.order)].sort((a, b) => a - b));
    });

    test('battleRole 索引让战斗公式按角色取属性而非写死键名', () => {
        const registry = makeRegistry();
        const index = registry.battleRoleIndex();
        expect(index.damage_phys).toEqual(['atk']);
        expect(index.damage_magic).toEqual(['matk']);
    });

    test('派生属性依赖未注册属性时启动即失败', () => {
        expect(() => makeRegistry([
            { key: 'broken', label: '坏', derive: 'nope + 1' }
        ])).toThrow(StatDefinitionError);
    });

    test('派生环检测', () => {
        expect(() => makeRegistry([
            { key: 'a_loop', label: 'A', derive: 'b_loop + 1' },
            { key: 'b_loop', label: 'B', derive: 'a_loop + 1' }
        ])).toThrow(/成环/);
    });

    test('存储键撞车即失败', () => {
        expect(() => makeRegistry([
            { key: 'dup_a', label: 'A', bonusKey: 'atk_bonus' },
            { key: 'dup_b', label: 'B', bonusKey: 'atk_bonus' }
        ])).toThrow(/冲突/);
    });

    test('percent 单位不允许 flat_then_pct 口径', () => {
        expect(() => makeRegistry([{ key: 'bad_pct', label: 'X', unit: 'percent', agg: 'flat_then_pct' }]))
            .toThrow(/百分点不再乘百分比/);
    });
});

describe('normalizeModifiers 历史写法归一', () => {
    test('绝对值 / _pct / 结构化三种写法统一成 {flat,pct}', () => {
        expect(normalizeModifiers({ atk: 5 }).mods.atk).toEqual({ flat: 5, pct: 0 });
        expect(normalizeModifiers({ atk_pct: 20 }).mods.atk).toEqual({ flat: 0, pct: 0.2 });
        expect(normalizeModifiers({ atk: { flat: 5, pct: 0.2 } }, { pctUnit: 'fraction' }).mods.atk)
            .toEqual({ flat: 5, pct: 0.2 });
    });

    test('非数值项进 unknown 而不是静默当 0', () => {
        const { mods, unknown } = normalizeModifiers({ skills: ['a'], hp_restore: '30' });
        expect(mods).toEqual({});
        expect(unknown.sort()).toEqual(['hp_restore', 'skills']);
    });
});

describe('StatEngine 求解', () => {
    test('唯一聚合口径：先加绝对值，再乘百分比合计', async () => {
        const registry = makeRegistry();
        const engine = makeEngine(registry, [
            { id: 'a', label: 'A', collect: () => ({ atk: 10, atk_pct: 20 }) },
            { id: 'b', label: 'B', collect: () => ({ atk: 5, atk_pct: 10 }) }
        ]);
        const { final, breakdown } = await engine.resolve(ctx());
        // base 10 + (10+5) = 25，再 ×(1+0.3) = 32.5 → floor 32
        expect(final.atk).toBe(32);
        expect(breakdown.atk.base).toBe(10);
        expect(breakdown.atk.flat_total).toBe(15);
        expect(breakdown.atk.pct_total).toBeCloseTo(0.3, 6);
    });

    test('百分比型属性只累加百分点，忽略百分比倍率并留痕', async () => {
        const registry = makeRegistry();
        const engine = makeEngine(registry, [
            { id: 'gear', label: '装备', collect: () => ({ crit_rate: 8, crit_rate_pct: 50 }) }
        ]);
        const { final, breakdown } = await engine.resolve(ctx());
        expect(final.crit_rate).toBe(13);
        expect(breakdown.crit_rate.ignored_pct).toEqual([{ from: 'gear', pct: 0.5 }]);
    });

    test('上下限钳制', async () => {
        const registry = makeRegistry();
        const engine = makeEngine(registry, [
            { id: 'gear', label: '装备', collect: () => ({ crit_rate: 999, hp_max: -99999 }) }
        ]);
        const { final } = await engine.resolve(ctx());
        expect(final.crit_rate).toBe(100);   // 概率型属性封顶 100%
        expect(final.hp_max).toBe(1);
    });

    test('mp_max 走 spirit 系统优先、realm 兜底', async () => {
        const registry = makeRegistry();
        const engine = makeEngine(registry, [{ id: 'none', label: '-', collect: () => ({}) }]);
        expect((await engine.resolve(ctx())).final.mp_max).toBe(120);
        expect((await engine.resolve(ctx({ spiritRealm: null }))).final.mp_max).toBe(20);
    });

    test('派生属性在依赖之后求解', async () => {
        const registry = makeRegistry();
        const engine = makeEngine(registry, [{ id: 'none', label: '-', collect: () => ({}) }]);
        const { final } = await engine.resolve(ctx());
        // 10 + wisdom 8 * 0.5 + sense 10 * 0.3 = 17
        expect(final.cultivate_speed).toBe(17);
    });

    test('单个来源抛错不影响其余来源与整体结果', async () => {
        const registry = makeRegistry();
        const engine = makeEngine(registry, [
            { id: 'boom', label: '坏的', collect: () => { throw new Error('db down'); } },
            { id: 'gear', label: '装备', collect: () => ({ atk: 7 }) }
        ]);
        const { final, meta } = await engine.resolve(ctx());
        expect(final.atk).toBe(17);
        expect(meta.provider_failures).toEqual([{ id: 'boom', message: 'db down' }]);
    });

    test('未知属性键：默认告警留痕，strict 下抛错', async () => {
        const registry = makeRegistry();
        const providers = [{ id: 'gear', label: '装备', collect: () => ({ not_a_stat: 5, atk: 1 }) }];

        const lenient = makeEngine(registry, providers);
        const { final, meta } = await lenient.resolve(ctx());
        expect(final.atk).toBe(11);
        expect(meta.unknown_stat_keys).toEqual(['not_a_stat']);

        const strict = makeEngine(registry, providers, { strict: true });
        await expect(strict.resolve(ctx())).rejects.toThrow(/未注册的属性键/);
    });

    test('来源被 provider.info 追加非数值信息（战斗读神通/特效用）', async () => {
        const registry = makeRegistry();
        const engine = makeEngine(registry, [
            { id: 'technique', label: '功法', collect: () => ({ atk: 3 }), info: () => ['skill_a'] }
        ]);
        const { info } = await engine.resolve(ctx({ baseInfo: { talent: { id: 't1' } } }));
        expect(info.talent).toEqual({ id: 't1' });
        expect(info.technique).toEqual(['skill_a']);
    });
});

describe('扩展性验收：加一个新属性需要改几个文件', () => {
    // 模拟 DLC pack：只声明属性 + 让一件武器带上该属性，不碰任何 Service
    const PACK_STAT = {
        key: 'wind_atk',
        label: '风系攻击',
        icon: '🌪️',
        group: 'offense',
        unit: 'point',
        agg: 'flat_then_pct',
        base: { realmField: 'base_wind_atk', default: 0 },
        min: 0,
        allocatable: true,
        bonusKey: 'wind_atk_bonus',
        pill: true,
        refineRate: 0.05,
        powerWeight: 1.8,
        panel: { visible: true, order: 36 },
        battleRoles: ['damage_wind']
    };

    test('新属性自动出现在面板/加点/丹药/祭炼/战力/战斗角色五类消费点', () => {
        const registry = makeRegistry([PACK_STAT]);

        expect(registry.panelStats().find(s => s.key === 'wind_atk')).toMatchObject({ label: '风系攻击' });
        expect(registry.allocatableMap().wind_atk).toBe('wind_atk_bonus');
        expect(registry.pillEffectMap().wind_atk).toBe('wind_atk_bonus');
        expect(registry.refineRateMap().wind_atk).toBe(0.05);
        expect(registry.battleRoleIndex().damage_wind).toEqual(['wind_atk']);
    });

    test('物品只写 effect.wind_atk，引擎即算出该属性并给出来源明细', async () => {
        const registry = makeRegistry([PACK_STAT]);
        // 装备来源与现网 EquipmentService 一样：对 effect 的键保持泛化，不 switch 属性名
        const itemEffect = { atk: 5, wind_atk: 37 };
        const engine = makeEngine(registry, [
            { id: 'equipment', label: '装备', collect: () => itemEffect }
        ]);

        const { final, breakdown } = await engine.resolve(ctx());
        expect(final.wind_atk).toBe(37);
        expect(breakdown.wind_atk.sources).toEqual([{ from: 'equipment', flat: 37, pct: 0 }]);
        expect(final.atk).toBe(15);
    });

    test('战力公式按注册表权重求和，新属性无需改公式', async () => {
        const registry = makeRegistry([PACK_STAT]);
        const engine = makeEngine(registry, [
            { id: 'equipment', label: '装备', collect: () => ({ wind_atk: 100 }) }
        ]);
        const { final } = await engine.resolve(ctx());

        const power = (defs) => defs.reduce((sum, d) => sum + (final[d.key] || 0) * d.powerWeight, 0);
        const withoutPack = power(new StatRegistry().load(baseDefs).all());
        const withPack = power(registry.all());

        expect(withPack - withoutPack).toBeCloseTo(100 * 1.8, 6);
    });

    test('伤害公式声明为数据：按 battleRole 取属性，新伤害类型不改代码', async () => {
        const registry = makeRegistry([PACK_STAT]);
        const engine = makeEngine(registry, [
            { id: 'equipment', label: '装备', collect: () => ({ wind_atk: 40, matk: 20 }) }
        ]);
        const { final } = await engine.resolve(ctx());

        const formula = (sourceRole, mitigationRole) => {
            const attackKey = registry.battleRoleIndex()[sourceRole][0];
            const defendKey = registry.battleRoleIndex()[mitigationRole]?.[0];
            return Expr.compile(
                'max(1, floor(source * 1.5 - mitigate * 0.8))',
                `${sourceRole}->${mitigationRole}`
            )({ source: final[attackKey], mitigate: defendKey ? final[defendKey] : 0 });
        };

        expect(formula('damage_phys', 'mitigate_phys')).toBe(11);   // atk 10 *1.5 - def 5 *0.8 = 11
        expect(formula('damage_wind', null)).toBe(60);             // 40 * 1.5
        expect(formula('damage_magic', null)).toBe(30);            // 20 * 1.5
    });
});
