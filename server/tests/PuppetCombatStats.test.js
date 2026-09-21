/**
 * 傀儡（友方战斗单位）的属性块 —— 不连库
 *
 * 盯的缺陷形状：傀儡与怪物是同一类东西（一块战斗属性按比例/等级折算后进战斗），但改造前
 * 它是**手写四个字段**的：`Math.floor(puppet.atk * ratio)` 一行一个。两个直接后果：
 *   1. 给傀儡加一个新属性（暴伤、五行抗性…）不会报错，只是永远不生效；
 *   2. `quench.stat_growth_rate` 里明明写着 def/hp 两档增长率，代码却一律拿 atk 那档去乘 ——
 *      现网三个值恰好都是 0.08，所以"调 hp 成长没反应"这件事从来没有暴露过。
 * 现在两者都与其他战斗单位同源（CombatStats.scaleStatBlock + 整块 base_stats）。
 */
'use strict';

const PuppetService = require('../game/services/PuppetService');
const { scaleStatBlock, pickRegisteredStats } = require('../game/combat/CombatStats');
const realPuppet = require('../config/puppet_data.json');
const { DATASET_SPECS } = require('../game/content/ContentRegistry');
const { ensureStatRegistryLoaded } = require('../game/stats');

const CONFIG = {
    quench: { stat_growth_rate: { atk: 0.1, def: 0.02, hp: 0.05, speed: 0.03 } },
    battle_stat_ratio: 0.3,
    guard_counter_ratio: 0.5
};

let previous;
beforeAll(() => {
    previous = PuppetService._config;
    ensureStatRegistryLoaded();   // registeredOnly 口径要靠属性注册表判定"这个键是不是属性"
});
afterAll(() => { PuppetService._config = previous; });

describe('傀儡等级成长读各自那一档', () => {
    beforeEach(() => { PuppetService._config = CONFIG; });

    test('def / hp 的增长率现在真的生效（以前一律乘 atk 那一档）', () => {
        const typeCfg = { base_stats: { atk: 100, def: 100, hp: 1000, speed: 100 } };
        expect(PuppetService._calcStats(typeCfg, 11)).toEqual({
            atk: 200,      // 100 × (1 + 10×0.1)
            def: 120,      // 100 × (1 + 10×0.02)
            hp: 1500,      // 1000 × (1 + 10×0.05)
            speed: 130     // 100 × (1 + 10×0.03)
        });
    });

    test('资料片给傀儡类型加一个属性，它跟着等级走而不是被丢掉（没写增长率就不成长）', () => {
        const typeCfg = { base_stats: { atk: 100, def: 100, hp: 1000, speed: 100, crit_damage: 40 } };
        const stats = PuppetService._calcStats(typeCfg, 11);
        expect(stats.crit_damage).toBe(40);        // 不发明增长率：宁可平着不动
        expect(stats.atk).toBe(200);
    });

    test('非数值的声明（写成了文字）不会污染属性块', () => {
        const stats = PuppetService._calcStats({ base_stats: { atk: 100, _comment: '备注' } }, 3);
        expect(stats).toEqual({ atk: 120 });
    });

    test('现网五类傀儡在 1/3/5/8 级上与改造前逐字段相同（这不是数值改动）', () => {
        PuppetService._config = realPuppet;
        const g = realPuppet.quench.stat_growth_rate;
        for (const typeCfg of Object.values(realPuppet.puppet_types)) {
            for (const level of [1, 3, 5, 8]) {
                const multiplier = 1 + (level - 1) * g.atk;
                const legacy = {
                    atk: Math.floor(typeCfg.base_stats.atk * multiplier),
                    def: Math.floor(typeCfg.base_stats.def * multiplier),
                    hp: Math.floor(typeCfg.base_stats.hp * multiplier),
                    speed: Math.floor(typeCfg.base_stats.speed * (1 + (level - 1) * g.speed))
                };
                expect(PuppetService._calcStats(typeCfg, level)).toEqual(legacy);
            }
        }
    });
});

describe('出战/护法傀儡的折算', () => {
    // 数据库行的形状：属性列与 id/level/exp/durability 混在同一行里
    const PUPPET_ROW = {
        id: 7, player_id: 42, name: '铁甲傀儡', level: 5, exp: 900,
        durability: 80, max_durability: 100,
        atk: '120', def: '88', hp: '1500', speed: '60', crit_damage: 30, status: 'battle'
    };

    test('整块折算，但行里那些"不是属性"的数字不会被倍率带走', () => {
        const scaled = scaleStatBlock(PUPPET_ROW, 0.3, { registeredOnly: true });
        expect(scaled).toMatchObject({ atk: 36, def: 26, hp: 450, speed: 18, crit_damage: 9 });
        expect(scaled.level).toBe(5);
        expect(scaled.exp).toBe(900);
        expect(scaled.durability).toBe(80);
        expect(scaled.max_durability).toBe(100);
        expect(scaled.id).toBe(7);
        expect(scaled.player_id).toBe(42);
    });

    test('字符串列（BIGINT 读出来就是字符串）折算后是整数，进 BIGINT 列不会炸', () => {
        const scaled = scaleStatBlock({ atk: '101', hp: '999' }, 0.5, { registeredOnly: true });
        expect(Number.isInteger(scaled.atk)).toBe(true);
        expect(Number.isInteger(scaled.hp)).toBe(true);
        expect(scaled.hp).toBe(499);
    });

    test('属性引擎拿到的是整块属性（新属性不用回 providers.js 补一行），而行里的 id/等级/耐久不会进去', () => {
        const scaled = scaleStatBlock(PUPPET_ROW, 0.3, { registeredOnly: true });
        expect(pickRegisteredStats(scaled)).toEqual({
            atk: 36, def: 26, hp_max: 450, speed: 18, crit_damage: 9
        });
    });

    test('不登记进内容层，资料片就加不了傀儡类型', () => {
        expect(Object.keys(DATASET_SPECS)).toContain('puppet_data');
    });

    test('行里的四个老键仍是权威（现网语义不变），内容里新加的属性不需要建列就能生效', () => {
        PuppetService._config = {
            ...CONFIG,
            puppet_types: { iron_wood: { base_stats: { atk: 100, def: 100, hp: 1000, speed: 100, crit_damage: 40 } } }
        };
        const row = { puppet_type: 'iron_wood', level: 11, atk: 33, def: 44, hp: 555, speed: 66, durability: 90 };
        expect(PuppetService._statsOf(row)).toEqual({
            atk: 33, def: 44, hp: 555, speed: 66,
            crit_damage: 40         // 内容声明的新属性：没写增长率就不随等级成长，也不用加列
        });
    });

    test('类型被下架/资料片被关掉时，已有傀儡退回行里的快照，不会变成空壳', () => {
        PuppetService._config = { ...CONFIG, puppet_types: {} };
        const row = { puppet_type: 'gone_wood', level: 3, atk: 12, def: 8, hp: 300, speed: 9 };
        expect(PuppetService._statsOf(row)).toEqual({ atk: 12, def: 8, hp: 300, speed: 9 });
    });

    test('内容同时声明 hp 与 max_hp 时只留一个真相', () => {
        PuppetService._config = {
            ...CONFIG,
            puppet_types: { iron_wood: { base_stats: { atk: 100, hp: 700, max_hp: 700 } } }
        };
        const stats = PuppetService._statsOf({ puppet_type: 'iron_wood', level: 1, hp: 900 });
        expect([stats.hp, stats.max_hp]).toEqual([900, 900]);
    });

    test('服务里不再留有手写的那几行乘法', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'game', 'services', 'PuppetService.js'), 'utf-8');
        expect(source).not.toMatch(/Math\.floor\(puppet\.\w+ \* ratio\)/);
        expect(source).toMatch(/scaleStatBlock\([\s\S]{0,160}registeredOnly: true/);
    });
});
