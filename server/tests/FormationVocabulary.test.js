/**
 * 阵法词表自检（`ContentRegistry._validateFormationVocabulary`）—— 与装备槽位那道闸同族（任务 #29，2026-09-22）
 *
 * 一句话形状：**一张"展示标签表"同时是合法值全集**（`formationCategories()` 取的是
 * `Object.keys(global.category_display_names)`，路由拿它挡参数），于是"某个阵法的 category 写错"
 * 既不会被任何引用校验发现，也不会有任何运行期错误 —— 列表页把裸键印给玩家，而那个阵法
 * 永远选不到、相克也永远不命中它。
 *
 * 判据用合成数据直接驱动校验函数（不往真实 json 里注入：注入用例要求逐字节还原，
 * 而这仓库可能被另一路改动同时写）。每条负向判据都要真的抛，并且还原后不抛。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');

const SERVER = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8');

/** 只喂一份 datasets 就能跑这个校验（它不读盘、不查库） */
function run(data) {
    const stub = Object.create(ContentRegistry.prototype);
    stub.datasets = new Map([['formation_data', data]]);
    return () => ContentRegistry.prototype._validateFormationVocabulary.call(stub);
}

const base = () => JSON.parse(read('config/formation_data.json'));
const CATEGORY_KEYS = ['attack', 'defense', 'support', 'special'];

describe('阵法词表：合法值全集与展示标签是同一张表，所以写错必须启动期响', () => {
    test('现网（基础配置）过校验，而且真的有东西可判', () => {
        const data = base();
        expect(run(data)).not.toThrow();
        expect(data.formations.length).toBeGreaterThan(10);
        expect(Object.keys(data.global.category_display_names).filter(k => !k.startsWith('_'))).toEqual(CATEGORY_KEYS);
        // 校验函数确实被挂在装配期调用链上（只写方法不调用 = 一道永远不响的闸）
        expect(read('game/content/ContentRegistry.js')).toMatch(/this\._validateFormationVocabulary\(\);/);
    });

    test('阵法的 category 不在词表里 → 点名是哪一件、非法值是什么', () => {
        const data = base();
        data.formations[0].category = 'sword_school_not_declared';
        expect(run(data)).toThrow(/不在流派词表里/);
        expect(run(data)).toThrow(new RegExp(`(${data.formations[0].id}).*sword_school_not_declared`));
    });

    test('阵法的 grade 不在词表里 → 也拦（品级名同理是合法全集）', () => {
        const data = base();
        data.formations[1].grade = 'divine';
        expect(run(data)).toThrow(/grade="divine" 不在品级词表里/);
    });

    test('阵法缺 category / 缺 grade → 拦（缺了它就进不了任何筛选与相克）', () => {
        const noCategory = base();
        delete noCategory.formations[2].category;
        expect(run(noCategory)).toThrow(/没有 category/);
        const noGrade = base();
        delete noGrade.formations[3].grade;
        expect(run(noGrade)).toThrow(/没有 grade/);
    });

    test('词表里某一档没有中文名 → 拦（界面会把裸键印给玩家）', () => {
        const data = base();
        data.global.category_display_names.special = { id: 'special' };   // 资料片 map 条目的典型形状：有 id 没 label
        expect(run(data)).toThrow(/category_display_names\.special 没有中文名/);
    });

    test('相克表指向不存在的流派 → 拦（这一行永远不生效，而它登记成集合反而会坏事，所以只能在这里查）', () => {
        const data = base();
        data.global.counter_relationships.attack = 'nonexistent_school';
        expect(run(data)).toThrow(/counter_relationships\.attack 指向 "nonexistent_school"/);
        const badKey = base();
        badKey.global.counter_relationships.ghost_school = 'defense';
        expect(run(badKey)).toThrow(/键 "ghost_school" 不是合法流派/);
        // 反面对照：合法的那几行不许被误报
        expect(run(base())).not.toThrow();
    });

    test('词表整段读不到 / 为空 → 抛（合法全集为空等于把所有参数都拒，闸不能空转）', () => {
        const empty = base();
        empty.global.category_display_names = { _comment: '只剩注释' };
        expect(run(empty)).toThrow(/读不到或为空/);
        const missing = base();
        delete missing.global.grade_display_names;
        expect(run(missing)).toThrow(/读不到或为空/);
    });

    test('这张表确实是可扩展集合（资料片能加流派），且相克表刻意不登记', () => {
        const collections = DATASET_SPECS.formation_data.collections;
        expect(collections['global.category_display_names']).toBeTruthy();
        expect(collections['global.grade_display_names']).toBeTruthy();
        // 反向钉子：登记成 map 集合会让"流派→流派"的引用变成对象，counterMap[a] === b 永远不成立
        expect(collections['global.counter_relationships']).toBeUndefined();
    });
});
