/**
 * 通天灵宝：成功率加成与惩罚
 */
'use strict';

const LegendaryWeaponsService = require('../game/services/LegendaryWeaponsService');

describe('青竹蜂云剑 / 七焰扇', () => {
    test('庚金版基础 50%，天金/天雷灵根各 +10%', () => {
        expect(LegendaryWeaponsService.successRate(0.5)).toBeCloseTo(0.5, 10);
        expect(LegendaryWeaponsService.successRate(0.5, { goldRoot: true })).toBeCloseTo(0.6, 10);
        expect(LegendaryWeaponsService.successRate(0.5, { goldRoot: true, thunderRoot: true })).toBeCloseTo(0.7, 10);
    });

    test('三焰扇 10%，火灵根 +20%，烈火之息 +15%，元婴宗 +5%', () => {
        const r = LegendaryWeaponsService.successRate(0.10, {
            fireRoot: true, fireSense: true, yuanyingSect: true
        });
        expect(r).toBeCloseTo(0.50, 10);
    });

    test('七焰扇仅 5% 且封顶 95%', () => {
        expect(LegendaryWeaponsService.successRate(0.05)).toBeCloseTo(0.05, 10);
        expect(LegendaryWeaponsService.successRate(0.5, {
            goldRoot: true, thunderRoot: true, fireRoot: true, metalSense: true, fireSense: true, yuanyingSect: true
        })).toBeLessThanOrEqual(0.95);
    });
});
