/**
 * 神通特效词表的落地验收。
 *
 * 存在的原因：technique_data.skills[].effects 写了半年，战斗侧和属性侧都没人读——
 * "领悟烈焰爆发→造成额外火焰伤害"只是文案。现在三类信息集中在 game/combat/skillEffects.js，
 * 战斗特效由 CombatResolver 结算，属性类特效折进功法来源（于是面板/战力/突破都能看到）。
 */
'use strict';

const CombatResolver = require('../game/combat/CombatResolver');
const skillEffects = require('../game/combat/skillEffects');
const combatFormulas = require('../config/combat_formulas.json');
const statDefs = require('../config/stat_definitions.json').stats;

function makeResolver() {
    const resolver = new CombatResolver.CombatResolver();
    resolver.initialize({
        getConfig: (name) => {
            if (name === 'combat_formulas') return combatFormulas;
            if (name === 'stat_definitions') return { stats: statDefs };
            throw new Error(`配置 ${name} 未加载`);
        },
        hasConfig: () => true
    });
    // 属性注册表由 ensureStatRegistryLoaded 按同一份 stat_definitions 装成进程级单例
    return resolver;
}

/** 按顺序吐出随机数，让"神通发动 → 闪避 → 暴击"的掷骰次序可断言 */
function rollSeq(...values) {
    let i = 0;
    return () => (i < values.length ? values[i++] : 0.9999);
}

const skill = (effects, id = 's') => ({ id, name: id, effects });

describe('collectSkillProcs（战斗特效汇总）', () => {
    test('没有 trigger_chance 的特效常驻；有的按概率发动', () => {
        const always = skillEffects.collectSkillProcs([skill({ damage_reduction: 0.3 })], () => 0.99);
        expect(always.damage_reduction).toBeCloseTo(0.3);

        const gated = skillEffects.collectSkillProcs(
            [skill({ extra_damage_rate: 0.2, trigger_chance: 0.5 })], () => 0.9
        );
        expect(gated.extra_damage_rate).toBe(0);
        expect(gated.fired).toEqual([]);

        const hit = skillEffects.collectSkillProcs(
            [skill({ extra_damage_rate: 0.2, trigger_chance: 0.5 })], () => 0.1
        );
        expect(hit.extra_damage_rate).toBeCloseTo(0.2);
        expect(hit.fired).toEqual(['s']);
    });

    test('增伤按比例叠加，减伤/格挡/破防取最高一档', () => {
        const out = skillEffects.collectSkillProcs([
            skill({ extra_damage_rate: 0.2 }, 'a'),
            skill({ extra_damage_rate: 0.15 }, 'b'),
            skill({ defense_pierce_rate: 0.25 }, 'c'),
            skill({ defense_pierce_rate: 0.6 }, 'd')
        ], () => 0);
        expect(out.extra_damage_rate).toBeCloseTo(0.35);
        expect(out.defense_pierce_rate).toBeCloseTo(0.6);
    });

    test('上限夹住脏数据，资料片写 1.5 的破防不会把防御清零', () => {
        const out = skillEffects.collectSkillProcs(
            [skill({ defense_pierce_rate: 1.5, damage_reduction: 9 })], () => 0
        );
        expect(out.defense_pierce_rate).toBe(0.9);
        expect(out.damage_reduction).toBe(0.8);
    });

    test('空/脏输入不炸（老数据里 effects 可能缺字段）', () => {
        expect(skillEffects.collectSkillProcs(undefined).extra_damage_rate).toBe(0);
        expect(skillEffects.collectSkillProcs([null, {}, { effects: 'x' }]).fired).toEqual([]);
    });
});

describe('foldSkillStats（属性类特效折进功法产出）', () => {
    test('小数换算成面板百分点，写到规范属性键上', () => {
        const target = { atk: 10 };
        skillEffects.foldSkillStats([skill({ crit_rate_bonus: 0.12, crit_damage_bonus: 0.25 })], target);
        expect(target.crit_rate).toBe(12);
        expect(target.crit_damage).toBe(25);
        expect(target.atk).toBe(10);
    });

    test('百分比型加成写成 *_pct 后缀，交给 StatEngine 按同一口径处理', () => {
        const target = {};
        skillEffects.foldSkillStats([skill({ def_bonus_pct: 0.15 })], target);
        expect(target.def_pct).toBeCloseTo(15);
    });

    test('多门神通累加同一属性', () => {
        const target = {};
        skillEffects.foldSkillStats([
            skill({ crit_rate_bonus: 0.12 }, 'a'),
            skill({ crit_rate_bonus: 0.05 }, 'b')
        ], target);
        expect(target.crit_rate).toBeCloseTo(17);
    });

    test('突破加成折进注册过的隐藏属性，突破预览才拿得到', () => {
        expect(skillEffects.SKILL_STAT_EFFECTS.breakthrough_rate_bonus.stat).toBe('breakthrough_bonus');
        expect(statDefs.some(s => s.key === 'breakthrough_bonus')).toBe(true);
        const target = {};
        skillEffects.foldSkillStats([skill({ breakthrough_rate_bonus: 0.05 })], target);
        expect(target.breakthrough_bonus).toBe(5);
    });
});

describe('神通特效真的改变一次出手', () => {
    const resolver = makeResolver();
    const strike = (extra = {}) => resolver.computeDamage('player_basic', {
        attackerStats: { atk: 100 }, defenderStats: { def: 30 },
        random: 0.5, roll: () => 0.9999, ...extra
    });

    test('不带神通时与改造前一致（70）', () => {
        expect(strike().damage).toBe(70);
    });

    test('extra_damage_rate 放大伤害', () => {
        const out = strike({ skills: [skill({ extra_damage_rate: 0.2, trigger_chance: 1 })] });
        expect(out.damage).toBe(84);   // 70 × 1.2
    });

    test('defense_pierce_rate 在公式内削减防御', () => {
        const out = strike({ skills: [skill({ defense_pierce_rate: 0.5, trigger_chance: 1 })] });
        expect(out.damage).toBe(85);   // 100 - 30×(1-0.5) + 7 - 7
    });

    test('承受方的 damage_reduction 与 block_chance 生效', () => {
        const reduced = strike({ defenderSkills: [skill({ damage_reduction: 0.3, trigger_chance: 1 })] });
        expect(reduced.damage).toBe(49);   // 70 × 0.7

        // 格挡上限是 0.5，所以用必然命中的掷骰来验，而不是把概率写成 1
        const blocked = resolver.computeDamage('player_basic', {
            attackerStats: { atk: 100 }, defenderStats: { def: 30 },
            random: 0.5, roll: () => 0,
            defenderSkills: [skill({ block_chance: 0.5 })]
        });
        expect(blocked).toMatchObject({ damage: 0, blocked: true });
    });

    test('掷骰顺序：神通发动先于闪避与暴击（同一 roll 源可复现）', () => {
        // 神通 trigger 0.5 用掉第一次掷骰（0.1 → 发动），随后闪避(0.99)与暴击(0.99)都不中
        const out = resolver.computeDamage('player_basic', {
            attackerStats: { atk: 100, crit_rate: 50 },
            defenderStats: { def: 30, dodge_rate: 50 },
            random: 0.5,
            roll: rollSeq(0.1, 0.99, 0.99),
            skills: [skill({ extra_damage_rate: 0.5, trigger_chance: 0.5 })]
        });
        expect(out).toMatchObject({ crit: false, missed: false });
        expect(out.damage).toBe(105);   // 70 × 1.5
    });
});
