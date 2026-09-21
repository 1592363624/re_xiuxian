/**
 * 历练遭遇的怪物属性表（AdventureEventService.computeMonsterStatsByRealm）—— 不连库
 *
 * 盯的缺陷形状：历练建的战斗行走的是 CombatService 的通用结算，但它的怪物属性是自己
 * 一份"境界 base_* 直取"，没有过内容声明层 —— 于是同一只怪在野外遭遇里能声明暴击/闪避，
 * 在历练里就声明不到（内容作者必须在两个入口各写一遍）。现在两处共用 MonsterStats。
 */
'use strict';

const { initializeModules } = require('../modules');
const { ensureStatRegistryLoaded } = require('../game/stats');
const { computeMonsterStatsByRealm } = require('../game/services/AdventureEventService');
const { monsterCombatStats, normalizeGeneratedMonster } = require('../game/combat/MonsterStats');
const realms = require('../config/realm_breakthrough.json').realms;

const MORTAL = realms.find(r => r.name === '凡人');
const SHARK = { id: 'shark', name: '鲨鱼精', realm: '筑基初期', exp: 200 };
const ZHUJI = realms.find(r => r.name === SHARK.realm);

beforeAll(async () => {
    await initializeModules();
    // 归一化函数按属性注册表判定"这个键登记过没有"，注册中心得先装好
    ensureStatRegistryLoaded();
});

describe('历练怪物属性表', () => {
    test('不声明时逐字段等于境界表（B24 的"按境界算强度"不变）', () => {
        const stats = computeMonsterStatsByRealm('凡人', 10, { id: 'rabbit' });
        expect(stats).toMatchObject({
            hp: MORTAL.base_hp, max_hp: MORTAL.base_hp,
            atk: MORTAL.base_atk, def: MORTAL.base_def, speed: MORTAL.base_speed,
            exp_reward: 10
        });
        expect(stats.crit_rate).toBeUndefined();
    });

    test('map_data 里给这只怪写的 stats，在历练遭遇里同样生效（一处声明，两条遭遇路径都算到）', () => {
        const declared = { ...SHARK, stats: { crit_rate: 30, dodge_rate: 12 } };
        const stats = computeMonsterStatsByRealm(declared.realm, declared.exp, declared);
        expect(stats).toMatchObject({
            atk: ZHUJI.base_atk, hp: ZHUJI.base_hp, crit_rate: 30, dodge_rate: 12
        });
    });

    test('声明 hp_max 会把 hp 与 max_hp 一起改（同一次遭遇里不许出现两个血量真相）', () => {
        const declared = { ...SHARK, stats: { hp_max: 4321 } };
        const stats = computeMonsterStatsByRealm(declared.realm, declared.exp, declared);
        expect([stats.hp, stats.max_hp, stats.hp_max]).toEqual([4321, 4321, 4321]);
    });

    test('境界名查不到时按默认兜底，但声明层照样并进来', () => {
        const stats = computeMonsterStatsByRealm('不存在的境界', 7, { stats: { crit_rate: 50 } });
        expect(stats).toMatchObject({ hp: 100, atk: 10, def: 5, exp_reward: 7, crit_rate: 50 });
    });

    test('交给结算的那份块带 hp_max（档位按注册表键读血量上限）', () => {
        const block = monsterCombatStats(computeMonsterStatsByRealm('凡人', 10, {}));
        expect(block.hp_max).toBe(MORTAL.base_hp);
        expect(block.def).toBe(MORTAL.base_def);
    });
});

/**
 * 模型生成的历练怪物是一道系统边界：以前 `JSON.parse(模型输出)` 直接进 active_battles.monster_data
 * 开打，所以"返回 hp:1e15"就是永远打不过的遭遇、"缺字段"就是当场 500、
 * "被提示词注入"就是往玩家身上砸任意奖励。这里钉住它现在按不可信输入处理。
 */
describe('AI 生成的怪物必须被钳制（外部输入边界）', () => {
    const realm = MORTAL;

    test('荒谬数值一律压到境界基础值的 3 倍以内', () => {
        const monster = normalizeGeneratedMonster({
            name: '吞天魔兽', realm: '凡人', hp: 1e15, atk: -5, def: '很多', speed: 1e9, exp_reward: 1e15
        }, { realmFallback: '凡人' });
        expect(monster.hp).toBe(realm.base_hp * 3);
        expect(monster.atk).toBe(realm.base_atk);          // 非正数 → 回落到境界基础值
        expect(monster.def).toBe(realm.base_def);          // 非数值 → 同上
        expect(monster.exp_reward).toBeLessThanOrEqual((realm.exp_cap || 10) * 3);
        expect(Number.isSafeInteger(monster.speed)).toBe(true);
    });

    test('缺字段不会把战斗炸掉（BigInt(undefined) 就是当场 500）', () => {
        const monster = normalizeGeneratedMonster({ name: '空壳' }, { realmFallback: '凡人' });
        expect(monster).toMatchObject({
            hp: realm.base_hp, max_hp: realm.base_hp, atk: realm.base_atk, def: realm.base_def
        });
    });

    test('编造的境界名回落到配置里有的名字（读的人全都要靠这个名字查表）', () => {
        const monster = normalizeGeneratedMonster({ realm: '宇宙无敌境界' }, { realmFallback: '炼气1层' });
        const qi = realms.find(r => r.name === '炼气1层');
        expect(monster.realm).toBe('炼气1层');
        expect(monster.hp).toBe(qi.base_hp);
    });

    test('只认注册表里登记过的属性键；exp 与 exp_reward 两种叫法都收', () => {
        const monster = normalizeGeneratedMonster(
            { realm: '凡人', crit_rate: 40, 未登记键: 999, exp: 25, description: 'x'.repeat(500) },
            { realmFallback: '凡人' }
        );
        expect(monster.crit_rate).toBe(40);
        expect(monster['未登记键']).toBeUndefined();
        expect(monster.exp_reward).toBeGreaterThan(0);
        expect(monster.description.length).toBeLessThanOrEqual(120);
    });

    test('输入根本不是对象也不许抛（模型返回数组/字符串/null 都是可能的）', () => {
        for (const junk of [null, undefined, 'not json', 42, [1, 2]]) {
            const monster = normalizeGeneratedMonster(junk, { realmFallback: '凡人' });
            expect(monster.hp).toBe(realm.base_hp);
            expect(typeof monster.name).toBe('string');
        }
    });

    test('生产链路上确实过了一道：AIService.generateMonster 用到了这个归一化函数', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(path.join(__dirname, '..', 'game', 'services', 'AIService.js'), 'utf-8');
        expect(source).toMatch(/monster:\s*normalizeGeneratedMonster\(/);
    });

    test('奖励上限从调用方传到归一化函数（不是在服务里另算一份）', () => {
        const fs = require('fs');
        const path = require('path');
        const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'game', 'services', file), 'utf-8');
        expect(read('AIService.js')).toMatch(/expCeiling:\s*context\.expCeiling/);
        expect(read('AdventureEventService.js')).toMatch(/expCeiling\s*=/);
    });
});

/**
 * AI 降级模板与"整块缩放"。
 *
 * 模板以前自带一张只有 6 个境界的数值表（凡人…筑基中期），表外的一切境界一律回落成
 * "炼气1层"的数值：化神期玩家遇到凡人强度的怪，speed 还用 atk*0.6 推。
 * 现在境界基础值只从 MonsterStats 那一处查，模板只负责名字与 ±10% 抖动。
 */
describe('AI 降级模板与整块缩放', () => {
    const AIService = require('../game/services/AIService');
    const { scaleStatBlock } = require('../game/combat/CombatStats');
    const service = new AIService();
    const HIGH = realms.find(r => r.name === '化神中期');

    const templateFor = (realm, extra = {}) =>
        service.generateMonsterFromTemplate({ playerRealm: realm, mapEnvironment: '山地', ...extra }).monster;

    test('高境界玩家遇到的怪按自己境界的强度生成（旧表最高只到筑基中期）', () => {
        const monster = templateFor('化神中期');
        expect(monster.realm).toBe('化神中期');
        for (const [key, base] of [['hp', HIGH.base_hp], ['atk', HIGH.base_atk], ['def', HIGH.base_def]]) {
            expect(monster[key]).toBeGreaterThanOrEqual(Math.floor(base * 0.9));
            expect(monster[key]).toBeLessThanOrEqual(Math.ceil(base * 1.1));
        }
    });

    test('模板给的每个数值都是整数（这块要进 BIGINT 列，留小数就是 BigInt(30.4) 当场抛错）', () => {
        for (const realm of ['凡人', '炼气1层', '筑基中期', '化神中期', '真仙']) {
            const monster = templateFor(realm);
            for (const key of ['hp', 'max_hp', 'atk', 'def', 'speed', 'exp_reward']) {
                expect(Number.isInteger(monster[key])).toBe(true);
            }
            expect(monster.max_hp).toBe(monster.hp);
        }
    });

    test('缩放整块：以后新增的属性自动跟着吃难度/抖动，不必回来补一行', () => {
        const scaled = scaleStatBlock({ atk: 10, def: '7', dodge_rate: 4, crit_rate: 12.9 }, 2);
        expect(scaled).toMatchObject({ atk: 20, def: 14, dodge_rate: 8, crit_rate: 25 });
    });

    test('默认不缩放奖励字段；血量的几种叫法缩放后仍是同一个数', () => {
        const scaled = scaleStatBlock({ hp: 101, max_hp: 101, atk: 10, exp_reward: 33 }, 1.5);
        expect(scaled).toMatchObject({ hp: 151, max_hp: 151, atk: 15, exp_reward: 33 });
    });

    test('expCeiling：模型不许比这张地图里最肥的怪还肥（境界 exp_cap 是"要攒满多少修为"，不是奖励上限）', () => {
        const clamped = normalizeGeneratedMonster(
            { realm: '真仙', exp_reward: 1e14 },
            { realmFallback: '凡人', expCeiling: 200 }
        );
        expect(clamped.exp_reward).toBeLessThanOrEqual(200);
        const unclamped = normalizeGeneratedMonster(
            { realm: '真仙', exp_reward: 1e14 },
            { realmFallback: '凡人' }
        );
        expect(unclamped.exp_reward).toBeGreaterThan(200);
    });
});
