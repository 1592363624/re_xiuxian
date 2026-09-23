/**
 * "装备穿不上"这道启动期闸（EquipmentService.assertEquipableContent，任务：内容可扩展性收尾）
 *
 * 形状：`equip()` 的槽位取物品自己的 `subtype`，合法集来自 `game_balance.equipment.valid_slots`。
 * 两边各写各的时没有任何信号 —— 实测现网 `wuxing_truth` 片里的 `wuxing_banner`（五行神光旗）
 * 写的就是 `artifact`，那件传说装备在图鉴/商店里看着正常，点穿戴只会收到"无效的装备槽位"。
 * 这道闸现在会在启动装配里把它抛出来（本文件最后一条控制跑就是"改回 artifact 必须红"）。
 *
 * 一律用**内存里换掉 `configLoader.getConfig`** 的方式造反例，不改仓库里任何 json；
 * 每次换完都要在 finally 里还原，并再跑一次正向断言（证明还原成功、不是把后面的用例污染了）。
 */
'use strict';

const { initializeModules, infrastructure } = require('../modules');

let EquipmentService;
const ConfigLoader = infrastructure.ConfigLoader;

/** 换掉 getConfig 的返回值（只影响指定数据集），返回还原函数 */
function patchConfig(datasetName, transform) {
    const real = ConfigLoader.getConfig;
    ConfigLoader.getConfig = function (key) {
        const value = real.call(this, key);
        if (key !== datasetName || !value) return value;
        return transform(value);
    };
    return () => { ConfigLoader.getConfig = real; };
}

const equipmentItems = () => ConfigLoader.getConfig('item_data').items.filter(i => i && i.type === 'equipment');

beforeAll(async () => {
    await initializeModules();
    await require('../game').initializeGameServices(ConfigLoader);
    EquipmentService = require('../game/services/EquipmentService');
});

describe('装备槽位与物品 subtype 必须对得上（否则那件装备永远穿不上）', () => {
    test('现网内容通过：每一件装备的 subtype 都是合法槽位，且槽位都有中文名', () => {
        const { slots, labels } = EquipmentService.slotVocabulary();
        expect(slots.length).toBeGreaterThan(0);
        for (const item of equipmentItems()) {
            expect(slots).toContain(item.subtype);
            expect(labels[item.subtype]).toBeTruthy();
        }
        // 正向断言本身要有东西可判：现网 100 件装备（实测 111 件），不是"零件装备所以全通过"
        expect(equipmentItems().length).toBeGreaterThan(50);
        expect(EquipmentService.assertEquipableContent().equipmentItems).toBe(equipmentItems().length);
    });

    test('槽位词表只有一份：`valid_slots` 已经不在配置里，槽位清单由 `slot_names` 的键派生', () => {
        const gb = ConfigLoader.getConfig('game_balance');
        // 第二份真相一旦长回来，两处就会各说一套（这正是以前"槽位不能由资料片扩"的成因）
        expect(gb.equipment.valid_slots).toBeUndefined();
        const { slots } = EquipmentService.slotVocabulary();
        expect(slots).toEqual(Object.keys(gb.equipment.slot_names).filter(k => !k.startsWith('_')));
    });

    test('曾经穿不上的那件（五行神光旗）现在落在合法槽位上', () => {
        const banner = equipmentItems().find(i => i.id === 'wuxing_banner');
        expect(banner).toBeTruthy();
        expect(banner.subtype).toBe('fabao');
        expect(EquipmentService.slotVocabulary().slots).toContain('fabao');
    });

    test('控制跑 A：把 fabao 这一档从词表里去掉 → 当场点名所有法宝类装备', () => {
        const restore = patchConfig('game_balance', gb => {
            const names = { ...(gb.equipment.slot_names || {}) };
            delete names.fabao;
            return { ...gb, equipment: { ...gb.equipment, slot_names: names } };
        });
        try {
            expect(() => EquipmentService.assertEquipableContent()).toThrow(/wuxing_banner（五行神光旗）subtype="fabao" 不是合法槽位/);
        } finally { restore(); }
        expect(() => EquipmentService.assertEquipableContent()).not.toThrow();   // 还原要真的还原
    });

    test('控制跑 B：资料片加一件写错槽位的装备 → 启动装配就抛，而不是发给玩家一件废物', () => {
        const restore = patchConfig('item_data', data => ({
            ...data,
            items: [...data.items, {
                id: 'zz_probe_banner', name: '探针旗', type: 'equipment', subtype: 'zz_not_a_slot', quality: 'rare'
            }]
        }));
        try {
            expect(() => EquipmentService.assertEquipableContent())
                .toThrow(/zz_probe_banner（探针旗）subtype="zz_not_a_slot" 不是合法槽位/);
        } finally { restore(); }
        expect(() => EquipmentService.assertEquipableContent()).not.toThrow();
    });

    test('控制跑 C：槽位在词表里却没有 label（资料片 map 条目的典型形状）→ 也拦，界面不许印裸键', () => {
        // 单表之后"槽位存在"与"槽位有名"是同一条记录的两面，所以这一档要这样造：
        // 条目在（于是它是合法槽位），但 label 缺失（于是显示层只能拿到裸键）。
        const restore = patchConfig('game_balance', gb => ({
            ...gb,
            equipment: { ...gb.equipment, slot_names: { ...gb.equipment.slot_names, fabao: { id: 'fabao' } } }
        }));
        try {
            expect(() => EquipmentService.assertEquipableContent()).toThrow(/槽位 "fabao" 在 .*slot_names 里没有中文名/);
            expect(EquipmentService.slotVocabulary().slots).toContain('fabao');      // 合法槽位这一半仍然成立
        } finally { restore(); }
        expect(() => EquipmentService.assertEquipableContent()).not.toThrow();
    });

    test('控制跑 D：词表读不到时不许"全部放行"（闸门不能空转）', () => {
        const restore = patchConfig('game_balance', gb => ({ ...gb, equipment: {} }));
        try {
            expect(() => EquipmentService.assertEquipableContent()).toThrow(/读不到或为空/);
        } finally { restore(); }
        expect(() => EquipmentService.assertEquipableContent()).not.toThrow();
    });

    /**
     * 这次改造要买到的东西：**加一档槽位 = 加一条内容**（以前只能改 game_balance，而它是"改数值"不是"加内容"）。
     * 这里合成一条槽位 + 一件用它做 subtype 的装备：不抛、出现在词表末尾、中文名取自那条内容。
     * 还原之后必须又变成"不认识的槽位"，否则这条判据是在测脏状态。
     */
    test('资料片能新增一档槽位：词表多一个键，用它的装备就通过校验（零代码）', () => {
        const before = EquipmentService.slotVocabulary().slots;
        const restoreNames = patchConfig('game_balance', gb => ({
            ...gb,
            equipment: {
                ...gb.equipment,
                slot_names: { ...gb.equipment.slot_names, benming_jian: { id: 'benming_jian', label: '本命飞剑' } }
            }
        }));
        const restoreItems = patchConfig('item_data', data => ({
            ...data,
            items: [...data.items, {
                id: 'qingzhu_fengyun_jian', name: '青竹蜂云剑', type: 'equipment',
                subtype: 'benming_jian', quality: 'legendary'
            }]
        }));
        try {
            const { slots, labels } = EquipmentService.slotVocabulary();
            expect(slots.slice(before.length)).toEqual(['benming_jian']);   // 追加在资料片位置，不打乱基础顺序
            expect(labels.benming_jian).toBe('本命飞剑');
            expect(() => EquipmentService.assertEquipableContent()).not.toThrow();
            // equip()/unequip() 的合法集与这里同源，所以新槽位不需要在别处登记第二遍
            expect(EquipmentService.slotVocabulary().slots).toContain('benming_jian');
        } finally {
            // 嵌套 patch 必须**反序**还原：第二个补丁在装上是把"第一个补丁后的 getConfig"存下来当 real，
            // 正序还原会把第一个补丁又装回去（本用例第一版就这么假红了一次 —— 词表里还剩着新槽位）。
            restoreItems();
            restoreNames();
        }
        const after = EquipmentService.slotVocabulary().slots;
        expect(after).toEqual(before);
        expect(after).not.toContain('benming_jian');
    });
});
