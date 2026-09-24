/**
 * 宗门外交：关系键与斗法因果配置
 */
'use strict';

const SectDiplomacyService = require('../game/services/SectDiplomacyService');

describe('宗门外交配置', () => {
    const c = SectDiplomacyService.config();

    test('友好掉率 -5%，敌对夺 15% 修为，结盟战力 +5%', () => {
        expect(c.friendly_loot_penalty).toBeCloseTo(0.05, 10);
        expect(c.hostile_bonus_exp_rate).toBeCloseTo(0.15, 10);
        expect(c.alliance_power_bonus).toBeCloseTo(0.05, 10);
    });

    test('掌门门槛为结丹后期以上', () => {
        expect(c.leader_min_realm_rank).toBeGreaterThanOrEqual(12);
    });

    test('解除盟约 72 小时禁新盟', () => {
        expect(c.break_alliance_block_hours).toBe(72);
    });
});
