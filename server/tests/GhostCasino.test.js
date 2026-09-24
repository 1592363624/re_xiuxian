/**
 * 鬼赌坊配置语义
 */
'use strict';

const GhostCasinoService = require('../game/services/GhostCasinoService');

describe('鬼赌坊配置', () => {
    const c = GhostCasinoService.config();

    test('天命玉简 7 关，每关奖池 ×1.8', () => {
        expect(c.destiny_slip.max_stages).toBe(7);
        expect(c.destiny_slip.stage_cash_multiplier).toBeCloseTo(1.8, 10);
    });

    test('六道轮回盘票价与奖池', () => {
        expect(c.six_paths_wheel.ticket_price).toBeGreaterThan(0);
        expect(c.six_paths_wheel.prizes.length).toBeGreaterThanOrEqual(3);
    });

    test('玲珑骰有上下限', () => {
        expect(c.linglong_dice.min_bet).toBeGreaterThan(0);
        expect(c.linglong_dice.max_bet).toBeGreaterThan(c.linglong_dice.min_bet);
    });
});
