/**
 * 斗法 / 切磋的战斗结算单测（注入属性，不连库）
 *
 * 这组用例存在的原因：PvpService / DuelService 的战斗路径此前完全没有测试 ——
 * 一次把 require 写漏（用到 CombatResolver 却没 require 它）都能骗过其余几百个用例，
 * 只有真跑一场才炸。回合结算本身是纯函数，正好适合离线测。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PvpService = require('../game/services/PvpService');
const DuelService = require('../game/services/DuelService');
const CombatResolver = require('../game/combat/CombatResolver');
const { StatRegistry } = require('../game/stats');

const serverRoot = path.join(__dirname, '..');

const combatConfig = {
    damage_random_range: 15,
    damage_random_offset: 7,
    skill_damage_multiplier: 1.5,
    skill_mp_cost: 20
};

const registry = new StatRegistry();
registry.load(JSON.parse(fs.readFileSync(path.join(serverRoot, 'config', 'stat_definitions.json'), 'utf-8')).stats, 'test');
registry.validate();

// 战斗档位现在会有资料片贡献（player_sword_intent 的定义跟着 sword_intent 属性走），
// 所以解析器按生产启动的方式装配：基础配置 + 资料片合并视图。
const { loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');
const configLoader = makeRealConfigLoader(loadRealContent(registry));

const fighter = (over = {}) => ({ atk: 100, def: 30, speed: 20, hp_max: 1000, mp_max: 500, ...over });

beforeAll(() => {
    CombatResolver.initialize(configLoader);
    DuelService.configLoader = {
        getConfig: (name) => (name === 'game_balance'
            ? { combat: combatConfig, pvp_extended: { duel: { enabled: true, max_rounds: 20 } } }
            : null)
    };
});

describe('DuelService._resolveRound（双方同时出招的回合结算）', () => {
    const battle = { attacker_id: 1, defender_id: 2 };
    const p1 = { id: 1, nickname: '甲' };
    const p2 = { id: 2, nickname: '乙' };

    function run(action1, action2, statsPair, roundsHistory = [], hpOver = {}) {
        const roundState = {
            round: 3,
            attacker_hp: 1000, defender_hp: 1000,
            attacker_action: action1, defender_action: action2,
            attacker_acted: true, defender_acted: true,
            ...hpOver
        };
        return DuelService._resolveRound(
            battle, p1, p2, action1, action2, roundState, roundsHistory, null, statsPair
        );
    }

    const even = { attacker: fighter(), defender: fighter() };

    test('相克获胜（蓄力克防御）：只有一方受伤，回合号推进', () => {
        const res = run('charge', 'defend', even);
        expect(res.roundEntry.outcome).toBe('p1_win');
        expect(res.roundEntry.damage_to_defender).toBeGreaterThan(0);
        expect(res.roundEntry.damage_to_attacker).toBe(0);
        expect(res.battleEnded).toBe(false);
        expect(res.nextRoundState.round).toBe(4);
    });

    test('未列入相克表的组合（attack vs defend）按平局处理，双方互减半伤害', () => {
        const res = run('attack', 'attack', even);
        expect(res.roundEntry.outcome).toBe('draw');
        expect(res.roundEntry.damage_to_defender).toBeGreaterThan(0);
        expect(res.roundEntry.damage_to_attacker).toBeGreaterThan(0);
    });

    test('伤害来自传入的解析属性，而不是玩家对象上的陈旧 attributes', () => {
        // p1/p2 上根本没有 attributes 字段：实现若回退去读 player.attributes 就会得到 NaN
        const weak = run('charge', 'defend', { attacker: fighter({ atk: 100 }), defender: fighter() });
        const strong = run('charge', 'defend', { attacker: fighter({ atk: 400 }), defender: fighter() });
        expect(Number.isFinite(strong.roundEntry.damage_to_defender)).toBe(true);
        expect(strong.roundEntry.damage_to_defender).toBeGreaterThan(weak.roundEntry.damage_to_defender);
    });

    test('上回合蓄力 + 本回合神通 = 1.5 倍伤害', () => {
        const plain = run('skill', 'charge', even).roundEntry;
        const charged = run('skill', 'charge', even, [
            { attacker_action: 'charge', defender_action: 'defend' }
        ]).roundEntry;
        expect(charged.damage_to_defender).toBeGreaterThan(plain.damage_to_defender);
    });

    test('HP 归零即分胜负并清空 round_state', () => {
        const res = run('charge', 'defend',
            { attacker: fighter({ atk: 5000 }), defender: fighter({ def: 0 }) },
            [], { defender_hp: 5 });
        expect(res.battleEnded).toBe(true);
        expect(res.winnerId).toBe(1);
        expect(res.nextRoundState).toBeNull();
    });
});

describe('PvpService._simulateSparringBattle（切磋木人整场模拟）', () => {
    const dummy = { atk: 30, def: 10, speed: 5, hp_max: 500 };

    test('玩家明显更强时获胜，且每回合伤害都 >= 1', () => {
        const sim = PvpService._simulateSparringBattle(
            fighter({ atk: 300, def: 200, hp_max: 3000, mp_max: 2000 }),
            dummy, 30, combatConfig
        );
        expect(sim.winner).toBe('player');
        expect(sim.battleLog.length).toBeGreaterThan(0);
        expect(sim.battleLog.every(e => Number(e.damage) >= 1)).toBe(true);
    });

    test('玩家太弱时木人获胜（证明双方都在真的算伤害，不是恒玩家胜）', () => {
        const sim = PvpService._simulateSparringBattle(
            fighter({ atk: 1, def: 0, speed: 1, hp_max: 50, mp_max: 0 }),
            { atk: 400, def: 500, speed: 100, hp_max: 100000 }, 30, combatConfig
        );
        expect(sim.winner).toBe('dummy');
    });

    test('双方都打不动时按最大回合数收场，不死循环', () => {
        const sim = PvpService._simulateSparringBattle(
            fighter({ atk: 1, def: 9999, hp_max: 99999, mp_max: 0 }),
            { atk: 1, def: 9999, speed: 1, hp_max: 99999 }, 4, combatConfig
        );
        expect(sim.battleLog.length).toBeLessThanOrEqual(4);
        expect(['player', 'dummy', null]).toContain(sim.winner);
    });

    test('先手由速度决定', () => {
        const fast = PvpService._simulateSparringBattle(fighter({ speed: 999 }), dummy, 2, combatConfig);
        expect(fast.battleLog[0].actor).toBe('player');

        const slow = PvpService._simulateSparringBattle(
            fighter({ speed: 0 }), { atk: 30, def: 10, hp_max: 500, speed: 999 }, 2, combatConfig
        );
        expect(slow.battleLog[0].actor).toBe('dummy');
    });
});

describe('战斗服务与解析层的接线', () => {
    test('普攻公式取同一条声明（漏 require 会在加载期就炸）', () => {
        const strike = CombatResolver.computeDamage('player_basic', {
            attackerStats: fighter({ atk: 100 }),
            defenderStats: fighter({ def: 30 }),
            random: 0.5,
            balanceConfig: { combat: combatConfig }
        });
        expect(strike.damage).toBe(70);   // 100 - 30 + floor(0.5*15) - 7
    });

    test('术法公式可用：新增伤害类型只靠配置，不需要改战斗代码', () => {
        const spell = CombatResolver.computeDamage('player_spell', {
            attackerStats: { matk: 200, atk: 10 },
            defenderStats: { mdef: 50, def: 9999 },
            random: 0,
            balanceConfig: { combat: combatConfig }
        });
        expect(spell.attack).toBe(200);
        expect(spell.mitigate).toBe(50);
        expect(spell.damage).toBe(243);   // 200*1.5 - 50 - 7
    });

    test('资料片的剑意公式可用', () => {
        expect(registry.has('sword_intent')).toBe(true);

        const strike = CombatResolver.computeDamage('player_sword_intent', {
            attackerStats: { sword_intent: 45, atk: 10 },
            defenderStats: { def: 40 },
            random: 0.5,
            balanceConfig: { combat: combatConfig }
        });
        expect(strike.attack).toBe(45);
        expect(strike.damage).toBe(34);   // 45*1.2 - 40*0.5 + 7 - 7
    });
});
