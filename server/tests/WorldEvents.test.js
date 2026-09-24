/**
 * 世界事件与凶名称号
 */
'use strict';

const WorldEventsService = require('../game/services/WorldEventsService');

describe('天道世界事件', () => {
    test('事件池含祥瑞与厄运', () => {
        const events = WorldEventsService.config().world_events.events;
        expect(events.some(e => e.type === 'blessing')).toBe(true);
        expect(events.some(e => e.type === 'curse')).toBe(true);
    });

    test('凶名按杀戮递进', () => {
        expect(WorldEventsService.evaluateTitle(0)).toBeNull();
        expect(WorldEventsService.evaluateTitle(1).name).toBe('血手人屠');
        expect(WorldEventsService.evaluateTitle(100).name).toBe('天道宿敌');
        expect(WorldEventsService.evaluateTitle(50).power_bonus).toBeGreaterThan(WorldEventsService.evaluateTitle(1).power_bonus);
    });
});
