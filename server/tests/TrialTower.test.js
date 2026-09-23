/**
 * 试炼古塔：精英层/首领层判定与难度曲线
 */
'use strict';

const TrialTowerService = require('../game/services/TrialTowerService');

describe('试炼古塔分层', () => {
    const cfg = TrialTowerService.getConfig();

    test('配置齐全', () => {
        expect(cfg.max_floor).toBeGreaterThan(0);
        expect(cfg.daily_free_attempts).toBeGreaterThanOrEqual(1);
        expect(cfg.floor_difficulty.base_power).toBeGreaterThan(0);
    });

    test('精英/首领层按倍数判定（导出的内部通过 challenge 路径间接覆盖，这里钉配置语义）', () => {
        expect(cfg.elite_every).toBe(5);
        expect(cfg.boss_every).toBe(10);
        expect(cfg.boss_first_clear_stones).toBeGreaterThan(cfg.elite_first_clear_stones);
    });
});
