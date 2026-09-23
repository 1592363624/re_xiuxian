/**
 * 风希的诅咒：配置语义与状态形状
 */
'use strict';

const FengxiCurseService = require('../game/services/FengxiCurseService');

describe('风希诅咒配置', () => {
    const c = FengxiCurseService.config();

    test('逃生基础 40%，风之祝福 +20%（帖：40%→60%）', () => {
        expect(c.escape_base_chance).toBeCloseTo(0.4, 10);
        expect(c.wind_blessing_escape_bonus).toBeCloseTo(0.2, 10);
    });

    test('战胜得 12 小时风之祝福，冷却数小时', () => {
        expect(c.wind_blessing_hours).toBe(12);
        expect(c.cooldown_hours_after).toBeGreaterThanOrEqual(1);
    });

    test('迎战失败损失修为比例高于逃跑失败', () => {
        expect(c.fight_lose_exp_loss_rate).toBeGreaterThan(c.escape_fail_exp_loss_rate);
    });
});
