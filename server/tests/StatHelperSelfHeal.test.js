/**
 * 属性块工具不许"静默交出空块"（2026-09-20）
 *
 * CombatStats 的两个函数靠属性注册表判断"这个键是不是属性"。注册表没装的时候
 * `resolveStatKey()` 对每个键都返回 undefined —— 于是 pickRegisteredStats() 返回 {}、
 * scaleStatBlock(…, {registeredOnly:true}) 一个键都不折算。傀儡/灵兽给玩家的加成会静默变 0，
 * 既不报错也不告警。这个文件**故意不调用** ensureStatRegistryLoaded()，用来证明函数会自己装上词表。
 */
'use strict';

const { statRegistry } = require('../game/stats');
const { pickRegisteredStats, scaleStatBlock } = require('../game/combat/CombatStats');

describe('CombatStats 的词表依赖会自愈', () => {
    test('前置条件：本文件里确实没人先装过词表', () => {
        expect(statRegistry.isLoaded).toBe(false);
    });

    test('pickRegisteredStats 认血量别名与登记键，剔除不是属性的数字', () => {
        expect(pickRegisteredStats({ hp: 120, atk: 30, level: 7, durability: 3, nonsense_key: 9 }))
            .toEqual({ hp_max: 120, atk: 30 });
        expect(statRegistry.isLoaded).toBe(true);
    });

    test('scaleStatBlock(registeredOnly) 折算属性、不折算玩家等级', () => {
        const out = scaleStatBlock({ atk: 100, hp_max: 1000, level: 7 }, 2, { registeredOnly: true });
        expect(out.atk).toBe(200);
        expect(out.hp_max).toBe(2000);
        expect(out.level).toBe(7);
    });

    test('自愈用的是基础词表，且第二次 ensure 不会把已装好的词表清空', () => {
        const before = statRegistry.panelStats().length;
        expect(before).toBeGreaterThan(0);
        require('../game/stats').ensureStatRegistryLoaded();
        expect(statRegistry.panelStats().length).toBe(before);
        expect(statRegistry.resolveStatKey('crit_rate')).toBeTruthy();
    });
});
