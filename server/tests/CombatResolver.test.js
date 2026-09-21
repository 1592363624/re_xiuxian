/**
 * 战斗数值解析层测试：伤害公式与战力全部由声明驱动，且不依赖玩家 attributes 里的陈旧快照。
 */
'use strict';

const CombatResolver = require('../game/combat/CombatResolver');
const combatFormulas = require('../config/combat_formulas.json');
const statDefs = require('../config/stat_definitions.json').stats;

function makeResolver(overrides = {}) {
    const resolver = new CombatResolver.CombatResolver();
    const configs = {
        combat_formulas: combatFormulas,
        stat_definitions: statDefs,
        ...overrides
    };
    resolver.initialize({
        getConfig: (name) => {
            if (!(name in configs)) throw new Error(`配置 ${name} 未加载`);
            return configs[name];
        },
        hasConfig: (name) => name in configs
    });
    return resolver;
}

describe('CombatResolver 伤害公式', () => {
    const resolver = makeResolver();

    test('玩家普攻与改造前的手写公式同形状：atk - def + rand(15) - 7，下限 1', () => {
        const { damage } = resolver.computeDamage('player_basic', {
            attackerStats: { atk: 100 },
            defenderStats: { def: 30 },
            random: 0.5            // floor(0.5*15)=7 → 100-30+7-7
        });
        expect(damage).toBe(70);
    });

    test('随机项取值范围与旧实现一致（0 与接近 1）', () => {
        const low = resolver.computeDamage('player_basic', { attackerStats: { atk: 100 }, defenderStats: { def: 30 }, random: 0 });
        const high = resolver.computeDamage('player_basic', { attackerStats: { atk: 100 }, defenderStats: { def: 30 }, random: 0.999 });
        expect(low.damage).toBe(63);    // 100-30+0-7
        expect(high.damage).toBe(77);   // 100-30+14-7
    });

    test('伤害永不为负，最低 min_damage', () => {
        const { damage } = resolver.computeDamage('player_basic', {
            attackerStats: { atk: 1 }, defenderStats: { def: 9999 }, random: 0
        });
        expect(damage).toBe(1);
    });

    test('技能伤害倍率优先取 game_balance 配置', () => {
        const fromBalance = resolver.computeDamage('player_skill', {
            attackerStats: { atk: 100 }, defenderStats: { def: 0 },
            balanceConfig: { combat: { skill_damage_multiplier: 2 } }, random: 0
        });
        const fallback = resolver.computeDamage('player_skill', {
            attackerStats: { atk: 100 }, defenderStats: { def: 0 }, random: 0
        });
        expect(fromBalance.damage).toBe(193);  // 100*2 + 0 - 7
        expect(fallback.damage).toBe(143);     // 100*1.5 - 7（配置缺失时用 profile 默认）
    });

    test('怪物攻击用怪物自己的 atk 与玩家的 def，随机窗口更窄', () => {
        const { damage } = resolver.computeDamage('monster_basic', {
            attackerStats: { atk: 40 }, defenderStats: { def: 15 }, random: 0.5  // floor(0.5*6)=3 → 40-15+3-3
        });
        expect(damage).toBe(25);
    });

    test('术法伤害走 matk/mdef：新伤害类型只靠配置就能生效', () => {
        const { damage, attack, mitigate } = resolver.computeDamage('player_spell', {
            attackerStats: { atk: 100, matk: 60 },
            defenderStats: { def: 999, mdef: 10 },
            random: 0
        });
        expect(attack).toBe(60);
        expect(mitigate).toBe(10);
        expect(damage).toBe(73);   // 60*1.5 - 10 - 7
    });

    test('术法在目标没有法防时退回物理防御', () => {
        const { mitigate } = resolver.computeDamage('player_spell', {
            attackerStats: { matk: 60 }, defenderStats: { def: 20 }, random: 0
        });
        expect(mitigate).toBe(20);
    });

    test('属性别名（crit/hp_steal）也能作为伤害入参键解析', () => {
        expect(resolver.registry.resolveStatKey('hp_steal').key).toBe('lifesteal');
        expect(resolver.registry.resolveStatKey('crit').key).toBe('crit_rate');
    });

    test('未注册的 profile 直接报错，不静默按 0 伤害', () => {
        expect(() => resolver.computeDamage('nope', {})).toThrow(/未注册的战斗公式 profile/);
    });
});

describe('CombatResolver 战力', () => {
    const resolver = makeResolver();

    test('战力来自注册表权重 + 境界排名权重，等价于旧的手写公式', () => {
        const stats = { hp_max: 1000, mp_max: 500, atk: 100, def: 50, speed: 20, sense: 30 };
        const legacy = Math.floor(100 * 2 + 50 * 1.5 + 20 * 1.2 + 1000 * 0.1 + 7 * 100);

        const power = resolver.computePower(stats, 7);
        // 注册表里还有 luck/wisdom/cultivate_speed/mp_max 等带权重的项，所以必然不低于旧公式
        expect(power).toBeGreaterThanOrEqual(legacy);
        // 同一份属性算两次结果一致（无隐藏随机/状态）
        expect(resolver.computePower(stats, 7)).toBe(power);
    });

    test('属性带 powerWeight 就自动计入战力，无需改战力代码', () => {
        const baseline = resolver.computePower({}, 0);
        const withMatk = resolver.computePower({ matk: 500 }, 0);
        expect(withMatk - baseline).toBe(1000);   // matk 的 powerWeight = 2

        const withCrit = resolver.computePower({ crit_rate: 20 }, 0);
        expect(withCrit - baseline).toBe(16);     // crit_rate 的 powerWeight = 0.8
    });

    test('配置缺失时退回兜底常量，不影响战斗', () => {
        const resolver = new CombatResolver.CombatResolver();
        resolver.initialize({ getConfig: () => { throw new Error('配置未加载'); }, hasConfig: () => false });
        const { damage } = resolver.computeDamage('player_basic', {
            attackerStats: { atk: 100 }, defenderStats: { def: 30 }, random: 0.5
        });
        expect(damage).toBe(70);
    });
});

/**
 * 暴击 / 闪避 / 吸血。
 * 这组用例存在的原因：crit_rate / crit_damage / dodge_rate / lifesteal 一直是面板上看得见、
 * 战力里算得着的属性，但**没有任何战斗代码掷过这三个骰子**——装备堆 6% 暴击，
 * 打出来的伤害和 0% 完全一样。现在概率按 battleRole 从注册表反查，来源不限都生效。
 */
describe('CombatResolver 战斗触发属性（procs）', () => {
    const resolver = makeResolver();
    const base = (attackerStats, defenderStats, roll) => resolver.computeDamage('player_basic', {
        attackerStats, defenderStats, random: 0.5, roll
    });

    test('没堆触发属性时与改造前完全一致（不凭空多掷骰子）', () => {
        const strike = base({ atk: 100 }, { def: 30 }, () => 0);
        expect(strike).toMatchObject({ damage: 70, crit: false, missed: false, lifesteal: 0 });
    });

    test('暴击按 crit_damage 放大伤害', () => {
        const strike = base({ atk: 100, crit_rate: 100, crit_damage: 100 }, { def: 30 }, () => 0);
        expect(strike.crit).toBe(true);
        expect(strike.damage).toBe(140);   // 70 × (1 + 100/100)
    });

    test('属性里没有暴击伤害时按配置的默认倍率（50%）', () => {
        expect(base({ atk: 100, crit_rate: 100 }, { def: 30 }, () => 0).damage).toBe(105);
    });

    test('概率判定用 roll：掷出 0.9999 时 5% 暴击不触发', () => {
        const strike = base({ atk: 100, crit_rate: 5 }, { def: 30 }, () => 0.9999);
        expect(strike.crit).toBe(false);
        expect(strike.damage).toBe(70);
    });

    test('闪避由防守方的 dodge_rate 决定，命中失败时伤害为 0', () => {
        const strike = base({ atk: 100 }, { def: 30, dodge_rate: 100 }, () => 0);
        expect(strike).toMatchObject({ damage: 0, missed: true });
    });

    test('吸血按最终伤害回血（暴击后的伤害才计入）', () => {
        const plain = base({ atk: 100, lifesteal: 20 }, { def: 30 }, () => 0.9999);
        expect(plain).toMatchObject({ damage: 70, lifesteal: 14 });

        const critting = base({ atk: 100, crit_rate: 100, crit_damage: 100, lifesteal: 20 }, { def: 30 }, () => 0);
        expect(critting).toMatchObject({ damage: 140, lifesteal: 28 });
    });

    test('profile 可以逐条关掉某个触发（例如无视闪避的必中档位）', () => {
        const custom = makeResolver({
            combat_formulas: {
                ...combatFormulas,
                profiles: {
                    ...combatFormulas.profiles,
                    always_hit: { ...combatFormulas.profiles.player_basic, procs: { dodge: false } }
                }
            }
        });
        const strike = custom.computeDamage('always_hit', {
            attackerStats: { atk: 100 }, defenderStats: { def: 30, dodge_rate: 100 },
            random: 0.5, roll: () => 0
        });
        expect(strike).toMatchObject({ damage: 70, missed: false });
    });

    test('同一个战斗角色挂多个属性时求和，不会只认第一个', () => {
        expect(resolver._points({ a: 5, b: 7 }, ['a', 'b'], 0)).toBe(12);
        expect(resolver._points({ b: 7 }, ['a', 'b'], 0)).toBe(7);
        expect(resolver._points({}, ['a', 'b'], 50)).toBe(50);
        expect(resolver._chance({ a: 5, b: 7 }, ['a', 'b'])).toBeCloseTo(0.12);
    });
});

/**
 * profile 自带 formula：形状完全不同的一种伤害（宗门战那种 ±15% 乘算浮动）也能靠数据进同一套结算。
 * 这条能力是"把最后一批私有公式收进解析层"的前提——收进来之后，玩家的暴击/闪避/神通
 * 特效才会对这些玩法生效（此前 SectWar 把 5% / 1.5× 写死在代码里）。
 */
describe('CombatResolver profile 级伤害形状', () => {
    const resolver = makeResolver();
    const hit = (profile, random, extra = {}) => resolver.computeDamage(profile, {
        attackerStats: { atk: 100 }, defenderStats: { def: 30 }, random, roll: () => 0.9999, ...extra
    });

    test('sect_war_attack：防御只算一半，随机是 ±15% 乘算', () => {
        expect(hit('sect_war_attack', 0.5).damage).toBe(85);    // (100 - 15) × 1.0
        expect(hit('sect_war_attack', 0).damage).toBe(72);      // 85 × 0.85
        expect(hit('sect_war_attack', 1).damage).toBe(97);      // 85 × 1.15
    });

    test('sect_war_skill：同一形状，倍率 1.5', () => {
        expect(hit('sect_war_skill', 0.5).damage).toBe(135);    // (150 - 15) × 1.0
    });

    test('没有自带 formula 的档位仍走全局算式，且两种形状互不污染缓存', () => {
        expect(hit('player_basic', 0.5).damage).toBe(70);       // 100 - 30 + 7 - 7
        expect(hit('sect_war_attack', 0.5).damage).toBe(85);
        expect(hit('player_basic', 0.5).damage).toBe(70);
    });

    test('破防与暴击同样作用于自带 formula 的档位', () => {
        const pierced = resolver.computeDamage('sect_war_attack', {
            attackerStats: { atk: 100 }, defenderStats: { def: 30 },
            random: 0.5, roll: () => 0.9999,
            skills: [{ id: 'x', effects: { defense_pierce_rate: 0.5, trigger_chance: 1 } }]
        });
        expect(pierced.damage).toBe(92);   // (100 - 30×0.5×0.5) × 1.0 = 92.5 → floor
    });

    test('ratio_mitigation：除法减伤曲线 + 动态技能倍率', () => {
        // 减伤 = def / (def + atk×2 + 1000) = 100/1500 = 6.667%
        const plain = resolver.computeDamage('ratio_mitigation', {
            attackerStats: { atk: 200 }, defenderStats: { def: 100 },
            random: 0.5, roll: () => 0.9999
        });
        expect(plain.damage).toBe(186);        // 200 × 0.9333 = 186.67 → 186

        // 技能倍率由调用方按动态技能表传入，不必为每种倍率开一个档位
        const skill = resolver.computeDamage('ratio_mitigation', {
            attackerStats: { atk: 200 }, defenderStats: { def: 100 },
            skill_multiplier: 2.5, random: 0.5, roll: () => 0.9999
        });
        expect(skill.damage).toBe(466);        // 200 × 2.5 × 0.9333 = 466.67 → 466
    });

    test('external_multiplier 乘在结算之后（组队加成/境界压制这类玩法倍率）', () => {
        const plain = resolver.computeDamage('ratio_mitigation', {
            attackerStats: { atk: 200 }, defenderStats: { def: 100 },
            random: 0.5, roll: () => 0.9999
        }).damage;
        const boosted = resolver.computeDamage('ratio_mitigation', {
            attackerStats: { atk: 200 }, defenderStats: { def: 100 },
            random: 0.5, roll: () => 0.9999, external_multiplier: 1.1
        }).damage;
        expect(boosted).toBe(Math.floor(plain * 1.1));
    });

    test('ratio_mitigation_boss_skill：BOSS 反击与玩家攻击同一条曲线，只有浮动档位不同', () => {
        const args = (random) => ({
            attackerStats: { atk: 200 }, defenderStats: { def: 100 }, random, roll: () => 0.9999
        });
        // 减伤 100/1500=6.667% → 无浮动时两侧完全一致
        expect(resolver.computeDamage('ratio_mitigation', args(0.5)).damage).toBe(186);
        expect(resolver.computeDamage('ratio_mitigation_boss_skill', args(0.5)).damage).toBe(186);
        // 玩家侧 ±15%，BOSS 技能侧 ±10%（历史行为，收进档位而不是再抄一份公式）
        expect(resolver.computeDamage('ratio_mitigation', args(0)).damage).toBe(158);
        expect(resolver.computeDamage('ratio_mitigation_boss_skill', args(0)).damage).toBe(168);
        expect(resolver.computeDamage('ratio_mitigation_boss_skill', args(1)).damage).toBe(205);
    });

    test('承受方传玩家完整属性块，所以闪避与神通减免对 BOSS 技能同样有效', () => {
        const dodged = resolver.computeDamage('ratio_mitigation_boss_skill', {
            attackerStats: { atk: 200 },
            defenderStats: { def: 100, dodge_rate: 30 },
            random: 0.5, roll: () => 0.1
        });
        expect(dodged.missed).toBe(true);
        expect(dodged.damage).toBe(0);

        const reduced = resolver.computeDamage('ratio_mitigation_boss_skill', {
            attackerStats: { atk: 200 },
            defenderStats: { def: 100 },
            defenderSkills: [{ id: 'hai', effects: { damage_reduction: 0.5, trigger_chance: 1 } }],
            random: 0.5, roll: () => 0.9999
        });
        expect(reduced.damage).toBe(93);     // 186 × (1 - 0.5)
    });

    test('缺少 formula 且全局算式也读不到时明确报错，而不是静默按 0 结算', () => {
        const broken = new CombatResolver.CombatResolver();
        broken.initialize({
            getConfig: (name) => (name === 'combat_formulas'
                ? { profiles: { weird: { label: '坏档位', attack_stat: 'atk', mitigate_stat: 'def', formula: ' ' } } }
                : {})
        });
        expect(() => broken.computeDamage('weird', { attackerStats: { atk: 1 }, defenderStats: {} }))
            .toThrow(/缺少可用的 formula/);
    });
});

describe('伤害档位由数据选择（selectSkillProfile）', () => {
    // 背景：combat_formulas 里声明了 player_sword_intent / player_five_element 等档位，
    // 但战斗代码一度只认 player_basic / player_skill 两个字面量，
    // 于是"资料片加了新伤害类型"在战斗里根本打不出来。现在由神通的 damage_profile 决定。
    // 这两条档位本身就来自资料片（各自的攻击属性只在资料片里登记），
    // 所以这里按生产启动的顺序装配：基础配置 + 资料片合并视图。
    const { statRegistry } = require('../game/stats');
    const { loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');
    const content = loadRealContent(statRegistry);
    const resolver = new CombatResolver.CombatResolver();
    resolver.initialize(makeRealConfigLoader(content));

    test('神通声明了档位就用它', () => {
        expect(resolver.selectSkillProfile([{ id: 'sword_qi_slash', damage_profile: 'player_sword_intent' }]))
            .toBe('player_sword_intent');
    });

    test('没声明时退回 player_skill，老神通行为不变', () => {
        expect(resolver.selectSkillProfile([{ id: 'flame_burst' }])).toBe('player_skill');
        expect(resolver.selectSkillProfile([])).toBe('player_skill');
        expect(resolver.selectSkillProfile(null)).toBe('player_skill');
        expect(resolver.selectSkillProfile(undefined, 'player_basic')).toBe('player_basic');
    });

    test('声明了一个不存在的档位时退回默认档，而不是让出手直接抛错', () => {
        expect(resolver.selectSkillProfile([{ id: 'oops', damage_profile: 'player_not_a_profile' }]))
            .toBe('player_skill');
    });

    test('按领悟顺序取第一条声明过的档位', () => {
        const skills = [
            { id: 'a', damage_profile: 'player_sword_intent' },
            { id: 'b', damage_profile: 'player_spell' }
        ];
        expect(resolver.selectSkillProfile(skills)).toBe('player_sword_intent');
    });

    test('现网每一条神通的 damage_profile 都是注册过的档位（拼错会被这条抓住）', () => {
        // 用"基础 + 资料片"的合并视图：player_five_element 来自资料片，
        // 只读基础配置会把这条正确的声明误判成野档位
        const { statRegistry } = require('../game/stats');
        const { loadRealContent } = require('./helpers/realContent');
        const content = loadRealContent(statRegistry);
        const profiles = content.dataset('combat_formulas').profiles;

        const declared = Object.values(content.dataset('technique_data').skills)
            .filter(s => s && typeof s === 'object' && s.damage_profile)
            .map(s => [s.id, s.damage_profile]);
        // 至少要有一条，否则这个机制又变回"配了没人用"
        expect(declared.length).toBeGreaterThan(0);
        expect(declared.filter(([, profile]) => !profiles[profile])).toEqual([]);
    });
});
