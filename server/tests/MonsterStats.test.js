/**
 * 怪物属性是否"内容驱动、并且真的进结算"。
 *
 * 盯的是这一类静默失效：玩家侧早就按属性块对称结算了，而 PVE 两个方向各只递了一个字段
 * （守方 { def }、攻方 { atk }），于是内容里给怪物写什么属性都不生效 ——
 * 想让一只妖狼会暴击，只能回去改 CombatService 里写死的字典。
 */
'use strict';

const { buildMonsterStats, monsterCombatStats } = require('../game/combat/MonsterStats');
const CombatResolver = require('../game/combat/CombatResolver');
const combatFormulas = require('../config/combat_formulas.json');
const statDefs = require('../config/stat_definitions.json').stats;

function makeResolver() {
    const resolver = new CombatResolver.CombatResolver();
    const configs = { combat_formulas: combatFormulas, stat_definitions: statDefs };
    resolver.initialize({
        getConfig: (name) => {
            if (!(name in configs)) throw new Error(`配置 ${name} 未加载`);
            return configs[name];
        },
        hasConfig: (name) => name in configs
    });
    return resolver;
}

const resolver = makeResolver();

// 与改造前同一组常数曲线（game_balance.combat 的口径），断言"不声明就等于什么都没变"
const COMBAT = {
    base_monster_hp: 100, base_monster_atk: 8, base_monster_def: 5, base_monster_speed: 10,
    level_multiplier_base: 1, level_multiplier_per_level: 0.1
};

describe('怪物属性表', () => {
    test('没有声明 stats 时，数值与改造前的手写公式逐键一致（不给现网带来任何变化）', () => {
        const data = buildMonsterStats({ id: 'rabbit', name: '野兔', realm: '凡人', exp: 10 }, { playerLevel: 5, combat: COMBAT });
        const mult = COMBAT.level_multiplier_base + 5 * COMBAT.level_multiplier_per_level;   // 1.5
        expect(data).toMatchObject({
            max_hp: Math.floor(100 * mult), hp: Math.floor(100 * mult),
            atk: Math.floor(8 * mult), def: Math.floor(5 * mult), speed: Math.floor(10 * mult),
            exp_reward: 10
        });
        // 没声明就没有触发属性：不会被凭空掷出暴击
        expect(data.crit_rate).toBeUndefined();
        expect(data.dodge_rate).toBeUndefined();
    });

    test('power_multiplier 是整块缩放（精英/首领档不必作者自己算绝对值）', () => {
        const one = buildMonsterStats({ id: 'wolf' }, { playerLevel: 0, combat: COMBAT });
        const elite = buildMonsterStats({ id: 'wolf', power_multiplier: 2.5 }, { playerLevel: 0, combat: COMBAT });
        expect(elite.max_hp).toBe(Math.floor(one.max_hp * 2.5));
        expect(elite.atk).toBe(Math.floor(one.atk * 2.5));
    });

    test('声明的属性原样进块；hp_max 会同步战斗行的 hp/max_hp', () => {
        const data = buildMonsterStats(
            { id: 'lang', stats: { crit_rate: 40, dodge_rate: 25, hp_max: 900, element_resist: 30 } },
            { playerLevel: 0, combat: COMBAT }
        );
        expect(data).toMatchObject({ crit_rate: 40, dodge_rate: 25, element_resist: 30, max_hp: 900, hp: 900, hp_max: 900 });
    });

    test('脏值跳过而不是把战斗炸掉', () => {
        const data = buildMonsterStats({ id: 'lang', stats: { crit_rate: '很高', def: 77 } }, { playerLevel: 0, combat: COMBAT });
        expect(data.crit_rate).toBeUndefined();
        expect(data.def).toBe(77);
    });
});

describe('副本那一记：私有公式换成了档位，但形状要一模一样', () => {
    // 改造前：atk<=def → 1~5；否则 (atk-def) × (0.8 + rand×0.4)
    const legacy = (atk, def, rand) => (atk <= def
        ? 1 + Math.floor(rand * 5)
        : Math.max(1, Math.floor(Number(atk - def) * (0.8 + rand * 0.4))));

    test('atk > def 的每一点都逐字等于旧公式（random=0.5 即 1.0 倍浮动）', () => {
        // 只在 atk>def 时比对：旧公式在"打不动"那一支给 1~5 随机，那是唯一被我改成保底 1 的地方
        // （见下面那条用例），其余形状完全照抄。
        for (const [atk, def] of [[500, 120], [80, 30], [1000, 900], [41, 40]]) {
            const strike = resolver.computeDamage('dungeon_battle', {
                attackerStats: { atk }, defenderStats: { def }, random: 0.5
            });
            expect([atk, def, strike.damage]).toEqual([atk, def, legacy(atk, def, 0.5)]);
        }
    });

    test('两端取值仍落在旧公式的 ±20% 带内', () => {
        for (const atk of [60, 500]) {
            const low = resolver.computeDamage('dungeon_battle', { attackerStats: { atk }, defenderStats: { def: 20 }, random: 0 });
            const high = resolver.computeDamage('dungeon_battle', { attackerStats: { atk }, defenderStats: { def: 20 }, random: 0.999 });
            expect(low.damage).toBeGreaterThanOrEqual(legacy(atk, 20, 0) - 1);
            expect(high.damage).toBeLessThanOrEqual(legacy(atk, 20, 0.999) + 1);
        }
    });

    test('打不动时保底 1（旧公式这里给 1~5 随机，那 4 点没有机制意义）', () => {
        const strike = resolver.computeDamage('dungeon_battle', { attackerStats: { atk: 10 }, defenderStats: { def: 999 }, random: 0.9 });
        expect(strike.damage).toBe(1);
    });
});

describe('声明进去就要算得到（PVE 两个方向共用同一套触发结算）', () => {
    const monsterBlock = monsterCombatStats(buildMonsterStats(
        { id: 'lang', power_multiplier: 1, stats: { atk: 100, crit_rate: 100, crit_damage: 50 } },
        { playerLevel: 0, combat: COMBAT }
    ));

    test('怪物自己声明的暴击率真的掷出暴击，并按暴伤放大', () => {
        const plain = resolver.computeDamage('monster_basic', {
            attackerStats: { atk: 100 }, defenderStats: { def: 0 }, random: 0.5
        });
        const crit = resolver.computeDamage('monster_basic', {
            attackerStats: monsterBlock, defenderStats: { def: 0, atk: 100 }, random: 0.5
        });
        // 攻方属性块里的 atk 与 plain 同值，所以差异只能来自"怪物会暴击了"
        expect(crit.attack).toBe(plain.attack);
        expect(crit.crit).toBe(true);
        expect(crit.damage).toBeGreaterThan(plain.damage);
    });

    test('玩家那一记会被怪物声明的闪避率闪掉（改造前守方只有一个 def，永远闪不掉）', () => {
        const dodgy = monsterCombatStats(buildMonsterStats(
            { id: 'lang', stats: { dodge_rate: 100 } }, { playerLevel: 0, combat: COMBAT }
        ));
        const strike = resolver.computeDamage('player_basic', {
            attackerStats: { atk: 500 }, defenderStats: dodgy, random: 0.5
        });
        expect(strike.missed).toBe(true);
        expect(strike.damage).toBe(0);
    });

    test('没声明的怪既不会暴击也不会闪（现网数值零变化）', () => {
        const plain = monsterCombatStats(buildMonsterStats({ id: 'rabbit' }, { playerLevel: 0, combat: COMBAT }));
        const monsterHit = resolver.computeDamage('monster_basic', { attackerStats: plain, defenderStats: { def: 0 }, random: 0.5 });
        const playerHit = resolver.computeDamage('player_basic', { attackerStats: { atk: 500 }, defenderStats: plain, random: 0.5 });
        expect(monsterHit.crit).toBe(false);
        expect(playerHit.missed).toBe(false);
    });
});
