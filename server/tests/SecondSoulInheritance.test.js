/**
 * 元神属性继承（SecondSoulService.inheritSoulAttributes）单元测试 —— 不连库
 *
 * 盯住的缺陷形状：凝练第二元神时，"主元神属性"以前取的是 players.attributes 里的
 * atk / def / hp_max / speed —— 那是旧属性管线留下的输出键，注册表链路既不写它们、
 * 也不以它们为基数。玩家 blob 里没有这几个键（新号、或从没被旧代码写过）时，
 * 扣完灵石+神识+残魂凝出来的是一具 atk=0 的空壳元神。
 * 现在来源改成 CombatResolver.resolveCombatStats(player)。
 *
 * 2026-09-21 同一处又补了一刀：来源整块进来了，`inheritSoulAttributes` 却仍只抄 atk/def/hp_max/speed/sense
 * 五个键 —— 注册表里另外十二档（含资料片新加的血元）在"凝练第二元神"这一步被静默清零，
 * 而第三元神的继承源就是第二元神存下来的那份块，漏一次永久少一档。现在按注册表整块继承。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SecondSoulService = require('../game/services/SecondSoulService');
const { statRegistry } = require('../game/stats');
const { loadRealContent } = require('./helpers/realContent');

const { inheritSoulAttributes } = SecondSoulService;
const MAIN = { atk: 200, def: 100, hp_max: 5000, speed: 60, sense: 30 };
const RATIO = 0.6;
const RANGE = 0.1;

beforeAll(() => {
    // 装真实内容视图（基础 + 全部资料片），这样"资料片新加的那一档"才在注册表里
    loadRealContent(statRegistry);
});
const allKeys = () => statRegistry.all().map(d => d.key).sort();
const zeros = () => Object.fromEntries(allKeys().map(k => [k, 0]));

describe('元神属性继承', () => {
    test('rand=0.5 时不浮动，逐键等于 来源 × 继承比例', () => {
        expect(inheritSoulAttributes(MAIN, RATIO, RANGE, () => 0.5)).toMatchObject({
            atk: 120, def: 60, hp_max: 3000, speed: 36, sense: 18
        });
    });

    test('整块注册表属性都跟着继承走：以前手写五个键，其余十二档在凝练这一步被清零', () => {
        const result = inheritSoulAttributes(MAIN, RATIO, RANGE, () => 0.5);
        expect(Object.keys(result).sort()).toEqual(allKeys());
        // 第三元神的继承源是这一份块 → 漏一次就永久少一档，所以形状必须完整
        expect(allKeys()).toContain('blood_power');        // 资料片「魔道血修遗篇」那一档
        expect(result.blood_power).toBe(0);               // 来源没这一档时落 0，不留 undefined
        const withBlood = inheritSoulAttributes(
            { ...MAIN, blood_power: 100, matk: 40, crit_rate: 12 }, RATIO, RANGE, () => 0.5
        );
        expect(withBlood.blood_power).toBe(60);
        expect(withBlood.matk).toBe(24);
        expect(withBlood.crit_rate).toBe(7);             // 12×0.6=7.2 向下取整
    });

    test('随机浮动是 ±range，两端都取得到', () => {
        expect(inheritSoulAttributes(MAIN, RATIO, RANGE, () => 0).atk).toBe(108);   // 200×0.6×0.9
        expect(inheritSoulAttributes(MAIN, RATIO, RANGE, () => 1).atk).toBe(132);   // 200×0.6×1.1
    });

    test('缺键与非数值都落 0，不许产出 NaN（NaN 存进元神属性会一路带到战斗里）', () => {
        const result = inheritSoulAttributes(
            { atk: '不是数', def: undefined, hp_max: null, speed: NaN },
            RATIO, RANGE, () => 0.5
        );
        expect(result).toEqual(zeros());
        for (const value of Object.values(result)) expect(Number.isFinite(value)).toBe(true);
    });

    test('只认"解析后的最终值"这一层键：喂 *_bonus 只会得到 0，所以调用方必须传解析结果', () => {
        // 这条是反面钉子：证明 helper 不认存储键。若哪天有人图省事把 attributes blob 直接传进来，
        // 得到的就是一具空壳元神，而单测会先在这里响。
        expect(inheritSoulAttributes({ atk_bonus: 200, hp_bonus: 5000 }, RATIO, RANGE, () => 0.5))
            .toEqual(zeros());
    });

    test('凝练/分化的属性来源写在纸上：解析链路，不再读旧输出键', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'game', 'services', 'SecondSoulService.js'), 'utf-8'
        );
        expect(source).toMatch(/resolveCombatStats\(player\)/);
        // attributes.atk / playerAttrs.def / attrs.hp_max 这一类"读玩家 blob 里的旧输出键"的写法不许回来
        expect(source).not.toMatch(/(?:attributes|playerAttrs|attrs|attrs\?)\s*\??\.\s*(atk|def|hp_max|speed)\b/);
    });
});
