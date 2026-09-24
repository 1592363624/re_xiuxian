/**
 * 神魂动荡/陨落配置语义
 */
'use strict';

const SoulRiskService = require('../game/services/SoulRiskService');

describe('神魂风险配置', () => {
    const c = SoulRiskService.config();

    test('同阶落败 20% 动荡，高阶 50%', () => {
        expect(c.unstable_chance_same_rank).toBeCloseTo(0.2, 10);
        expect(c.unstable_chance_higher_rank).toBeCloseTo(0.5, 10);
    });

    test('日斗法 10 次、同目标日胜 5 次', () => {
        expect(c.daily_duel_limit).toBe(10);
        expect(c.daily_win_per_target_limit).toBe(5);
    });

    test('道心破碎 24h，复仇 +5% 战力', () => {
        expect(c.heartbreak_duration_hours).toBe(24);
        expect(c.revenge_power_bonus).toBeCloseTo(0.05, 10);
    });
});
