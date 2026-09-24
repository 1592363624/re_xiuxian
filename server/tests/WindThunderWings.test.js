/**
 * 风雷翅：冷却缩减与奇袭三式配置
 */
'use strict';

const WindThunderWingsService = require('../game/services/WindThunderWingsService');

describe('风雷翅配置', () => {
    const c = WindThunderWingsService.config();

    test('冷却 -30%，高阶逃生 +40%', () => {
        expect(c.cooldown_reduction).toBeCloseTo(0.3, 10);
        expect(c.escape_bonus_vs_higher).toBeCloseTo(0.4, 10);
    });

    test('冷却缩减函数生效', () => {
        const reduced = WindThunderWingsService.applyCooldownReduction(10000);
        expect(reduced).toBe(7000);
    });

    test('奇袭统一耗 2500 修为、冷却 6 小时', () => {
        expect(c.raid.cost_exp).toBe(2500);
        expect(c.raid.cooldown_hours).toBe(6);
        expect(c.raid.instant_kill_damage_multiplier).toBe(5);
    });
});
