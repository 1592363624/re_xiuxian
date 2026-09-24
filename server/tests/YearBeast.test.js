/**
 * 年兽：护盾与破盾集火（纯配置/纯函数层）
 */
'use strict';

const YearBeastService = require('../game/services/YearBeastService');

describe('年兽讨伐配置', () => {
    test('配置：20 层盾、每回合回 2、爆竹破 1', () => {
        const c = YearBeastService.config();
        expect(c.shield_layers).toBe(20);
        expect(c.shield_regen_per_turn).toBe(2);
        expect(c.shield_damage_per_cracker).toBe(1);
    });

    test('snapshot 形状齐全', () => {
        const snap = YearBeastService._snapshot(
            { id: 1, leader_id: 2, status: 'forming', shield: 20, max_shield: 20, turns: 0, damage_dealt: 0, battle_log: [] },
            [{ player_id: 2, role: 'leader', firecrackers_used: 0, focus_count: 0, damage: 0, settled: false }]
        );
        expect(snap.party_id).toBe(1);
        expect(snap.members.length).toBe(1);
        expect(snap.shield).toBe(20);
    });
});
