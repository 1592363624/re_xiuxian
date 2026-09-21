/**
 * 世界 BOSS 的内容声明属性是否真的进反击结算（不连库）。
 *
 * 盯的缺陷形状：BOSS 实例行上只有 atk/def/speed/hp 四个数，服务给档位递的也就是
 * `{atk: bossAtk}` 一个字段 —— 于是"给某只 BOSS 加暴击/暴伤/吸血/五行抗性"在代码里没有落点，
 * 玩家在 BOSS 战里早已能用上自己堆的暴击，BOSS 却永远只能平A。
 * 现在 world_boss_data 里写 `stats: { crit_rate: 100, crit_damage: 50 }` 就该当场掷出来。
 */
'use strict';

const CombatResolver = require('../game/combat/CombatResolver');
const { infrastructure, initializeModules } = require('../modules');
const { ensureStatRegistryLoaded } = require('../game/stats');
const WorldBossSkillManager = require('../game/services/WorldBossSkillManager');

beforeAll(async () => {
    // 管理器与档位都读全局 ConfigLoader，所以要先把配置装进那个单例（不是造一个假的）
    await initializeModules();
    ensureStatRegistryLoaded();
    CombatResolver.initialize(infrastructure.ConfigLoader);
});

const BOSS = { atk: 2000, def: 100, phase: 1, active_buffs: [], skill_cooldowns: {}, minions: [] };
const SKILL = { name: '飞剑斩', type: 'single_target_basic', damage_multiplier: 1.0 };
const TARGET = { battleHp: 0, battleHpMax: 5000, playerDef: 300, playerStats: { def: 300 }, playerSkills: null, playerBeastElement: null };

function counter(declaredStats) {
    return WorldBossSkillManager.executeSkill(BOSS, SKILL, TARGET, {
        bossKey: 'probe_boss', bossElement: null, cfgBalance: {}, playerId: 1, declaredStats
    });
}

describe('BOSS 的声明属性进反击', () => {
    test('不声明时永远不会暴击（实例块只有 atk，档位掷出的概率是 0）', () => {
        for (let i = 0; i < 20; i++) {
            const result = counter(null);
            expect(result.crit).toBe(false);
            expect(result.missed).toBe(false);
            expect(result.damage_profile).toBe('ratio_mitigation_boss_skill');
            expect(result.counter_damage).toBeGreaterThan(0);
        }
    });

    test('声明 crit_rate=100 就必暴击，且暴伤按声明放大（±10% 浮动的两条带不重叠）', () => {
        const plain = [];
        const crits = [];
        for (let i = 0; i < 20; i++) {
            plain.push(counter(null).counter_damage);
            const crit = counter({ crit_rate: 100, crit_damage: 50 });
            expect(crit.crit).toBe(true);
            crits.push(crit.counter_damage);
        }
        expect(Math.min(...crits)).toBeGreaterThan(Math.max(...plain));
    });

    test('声明的闪避不会被误用成"BOSS 自己闪掉自己的攻击"（守方仍是玩家块）', () => {
        const result = counter({ dodge_rate: 100, crit_rate: 0 });
        expect(result.missed).toBe(false);
        expect(result.counter_damage).toBeGreaterThan(0);
    });

    test('反击用的攻击值仍是"含 Buff 与阶段"的有效攻击，声明层不许把它改掉', () => {
        const base = counter(null);
        const declared = counter({ atk: 999999 });
        // 内容里写 atk 也只该影响触发属性那一层；基础攻击由 getEffectiveBossAtk 说了算
        expect(declared.counter_damage).toBeLessThan(base.counter_damage * 10);
    });
});
