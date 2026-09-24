/**
 * 年兽：护盾与破盾集火
 */
'use strict';

const YearBeastService = require('../game/services/YearBeastService');

describe('年兽讨伐', () => {
    test('配置：20 层盾、每回合回 2、爆竹破 1', () => {
        const c = YearBeastService.config();
        expect(c.shield_layers).toBe(20);
        expect(c.shield_regen_per_turn).toBe(2);
        expect(c.shield_damage_per_cracker).toBe(1);
    });

    test('护盾未破时集火伤害为 0；归零后 200% 暴击', () => {
        const p = YearBeastService.createParty(1);
        YearBeastService.startParty(p.id, 1);
        const hit0 = YearBeastService.focusFire(p.id, 1);
        expect(hit0.damage).toBe(0);
        p.shield = 0;
        const hit1 = YearBeastService.focusFire(p.id, 1);
        expect(hit1.damage).toBeGreaterThan(0);
    });
});
