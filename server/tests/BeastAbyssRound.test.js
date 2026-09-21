/**
 * 灵兽探渊的每回合伤害（BeastAbyssService）—— 不连库
 *
 * 盯的缺陷形状：探渊是最后两处把伤害公式抄在服务里的地方（打野怪一份、打别的玩家的灵兽一份，
 * 攻守各写一遍 `Math.max(1, atk - def * 0.5)`）。抄两份的后果不是"不好看"，而是：
 *   - 给深渊怪加一个属性，公式这边永远不会理它；
 *   - 全局调战斗公式（比如防御系数）时，探渊静悄悄不跟着变。
 * 现在它读 combat_formulas.json 的 beast_abyss_round 档位，属性块读内容声明层。
 */
'use strict';

const service = require('../game/services/BeastAbyssService');
const CombatResolver = require('../game/combat/CombatResolver');
const { infrastructure, initializeModules } = require('../modules');
const { ensureStatRegistryLoaded } = require('../game/stats');

beforeAll(async () => {
    // 档位读的是全局 ConfigLoader 单例（与运行期同一份），不是服务自带的一份公式
    await initializeModules();
    ensureStatRegistryLoaded();
    CombatResolver.initialize(infrastructure.ConfigLoader);
});

const floorConfig = (monster, difficulty = 1) => ({
    floor: 1,
    name: '测试层',
    monster_difficulty: difficulty,
    reward_multiplier: 1,
    stamina_cost_per_floor: 1,
    monsters: [monster],
    drops: []
});
// element 用 dark：相克表读 this.config，测试里不初始化配置也能跑（深渊鼠本来就是 dark）
const RAT = { key: 'abyss_rat', name: '深渊鼠', element: 'dark', hp: 200, atk: 30, def: 15, speed: 60, exp_reward: 20 };
const snapshot = (atk, def, hp) => ({ beast_id: 1, element: 'dark', atk, def, hp_max: hp });

describe('探渊的每回合伤害', () => {
    test('与改造前那份内联公式同一形状：攻 - 防×0.5，打不动也至少 1', () => {
        expect(service._roundDamage({ atk: 100, def: 0 }, { atk: 0, def: 30 })).toBe(85);
        expect(service._roundDamage({ atk: 10, def: 0 }, { atk: 0, def: 30 })).toBe(1);
    });

    test('同一对属性永远得到同一个数（探渊由后台定时器结算，两次结算不能给出两个结果）', () => {
        const first = service._roundDamage({ atk: 777, def: 12 }, { atk: 321, def: 99 });
        for (const random of [0, 0.5, 0.999]) {
            const original = Math.random;
            Math.random = () => random;
            try {
                for (let i = 0; i < 50; i += 1) {
                    expect(service._roundDamage({ atk: 777, def: 12 }, { atk: 321, def: 99 })).toBe(first);
                }
            } finally {
                Math.random = original;
            }
        }
    });

    test('层的难度整块缩放这只怪（改造前逐字段手写，新加的属性会漏乘）', () => {
        const original = Math.random;
        Math.random = () => 0;
        try {
            const plain = service._battleMonster(null, snapshot(100, 20, 5000), floorConfig(RAT, 1), 5000);
            const doubled = service._battleMonster(null, snapshot(100, 20, 5000), floorConfig(RAT, 2), 5000);
            expect(doubled.encounter_detail.monster_hp).toBe(plain.encounter_detail.monster_hp * 2);
            // 怪更硬也更疼：要么多花回合，要么更早倒下，总之不会与难度 1 完全等价
            expect(doubled.encounter_detail.rounds).toBeGreaterThan(plain.encounter_detail.rounds);
        } finally {
            Math.random = original;
        }
    });

    test('power_multiplier 在探渊里同样生效（资料片只改数据就能做一只异种精英）', () => {
        const original = Math.random;
        Math.random = () => 0;
        try {
            const elite = { ...RAT, power_multiplier: 3 };
            // 挑一只"打普通深渊鼠刚好赢、打三倍强度的它就输"的灵兽，才能证明这一档真的改变了结果
            const plain = service._battleMonster(null, snapshot(40, 10, 400), floorConfig(RAT, 1), 400);
            const buffed = service._battleMonster(null, snapshot(40, 10, 400), floorConfig(elite, 1), 400);
            expect(buffed.encounter_detail.monster_hp).toBe(plain.encounter_detail.monster_hp * 3);
            expect(plain.victory).toBe(true);
            expect(buffed.victory).toBe(false);          // 三倍血三倍的防：同一只灵兽从赢得变成输
            expect(buffed.hp_after).toBe(0);
        } finally {
            Math.random = original;
        }
    });

    test('记账自洽：败则清零、胜则不为负且不超过出发血量', () => {
        const original = Math.random;
        Math.random = () => 0;
        try {
            for (const [atk, def, hp] of [[5, 5, 300], [5000, 3000, 6000], [120, 15, 800]]) {
                const r = service._battleMonster(null, snapshot(atk, def, hp), floorConfig(RAT, 1), hp);
                expect(Number.isInteger(r.hp_after)).toBe(true);
                expect(r.hp_after).toBeGreaterThanOrEqual(0);
                expect(r.hp_after).toBeLessThanOrEqual(hp);
                expect(r.victory ? r.hp_after > 0 : r.hp_after === 0).toBe(true);
                if (r.victory) expect(r.exp_gain).toBe(RAT.exp_reward);
            }
        } finally {
            Math.random = original;
        }
    });

    test('服务里不再有自己那份伤害算式（公式只住在 combat_formulas.json）', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'game', 'services', 'BeastAbyssService.js'), 'utf-8');
        expect(source).not.toMatch(/Math\.max\(1,\s*\w*[Aa]tk\s*-/);
        expect(source).toMatch(/computeDamage\('beast_abyss_round'/);
    });
});
