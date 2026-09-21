/**
 * 物品引用 → 中文名这一层（game/items/itemNaming.js）的验收测试。
 *
 * 盯的缺陷形状：掉落/奖励/切石产出在内容里只是引用（item_key / item_id），以前每条链各自
 * 把裸键摊给界面，玩家看到的是 "获得物品: wild_herb x3"。统一改成出参时按 item_data 解析名字，
 * 于是有两件事必须成立，本文件钉的就是它们：
 *   1) 名字只有一个来源 = 合并后的内容（资料片新加的物品、改过的名字，不重启就得生效）；
 *   2) 解析只加不减 —— 查不到时不许塞 item_name: null 去盖掉界面的键名退回，
 *      也不许顺手改掉调用方传进来的那份数组（那是奖励记录，改了就写进库）。
 * 配套的界面侧静态闸是 client/scripts/ui-check.mjs 第 7 项。
 */
'use strict';

const { infrastructure, initializeModules } = require('../modules');
const { itemName, withItemNames } = require('../game/items/itemNaming');

const loader = infrastructure.ConfigLoader;

/** 只在一次断言里替换某个数据集（不改真实配置文件，不影响别的用例） */
function withConfig(name, value, run) {
    const original = loader.getConfig;
    loader.getConfig = key => (key === name ? value : original.call(loader, key));
    try {
        return run();
    } finally {
        loader.getConfig = original;
    }
}

beforeAll(async () => {
    await initializeModules();
});

describe('物品名字只有一个来源：合并后的 item_data', () => {
    test('基础内容里的物品按 id 查得到中文名', () => {
        const item = loader.getConfig('item_data').items.find(i => i.name && !/^\w+$/.test(i.name));
        expect(item).toBeTruthy();
        expect(itemName(item.id)).toBe(item.name);
    });

    test('资料片加的物品同样查得到，不用改代码', () => {
        // 黄枫谷药圃（spirit_nursery）是纯内容资料片：它的物品能解析出名字，
        // 就说明这条链真的接在合并视图上，而不是接在基础配置文件上。
        const seed = itemName('zi_yun_shen');
        expect(seed).toBe('紫云参');
    });

    test('换一份数组引用（热更/重载）后索引跟着换，不会留着旧名字', () => {
        const base = loader.getConfig('item_data').items;
        const first = base[0];
        const renamed = [{ ...first, name: '临时改名' }];
        withConfig('item_data', { items: renamed }, () => {
            expect(itemName(first.id)).toBe('临时改名');
        });
        // 出作用域后回到真内容：证明缓存按数组引用失效，而不是按"第一次读到"定终身
        expect(itemName(first.id)).toBe(first.name);
    });
});

describe('解析只加不减', () => {
    test('查不到的键原样返回，界面还能退回显示键名', () => {
        expect(itemName('bu_cun_zai_de_dao_ju')).toBeNull();
        const list = [{ item_id: 'bu_cun_zai_de_dao_ju', quantity: 2 }];
        expect(withItemNames(list)).toEqual(list);
    });

    test('不改动调用方传进来的那份数组和条目', () => {
        const entry = { item_key: 'jade_core', quantity: 1 };
        const list = [entry];
        const out = withItemNames(list);
        expect(entry).not.toHaveProperty('item_name');
        expect(list).not.toBe(out);
        expect(out[0]).not.toBe(entry);
        expect(out[0].item_name).toBeTruthy();
        expect(out[0].quantity).toBe(1);
    });

    test('item_key / item_id 都认，字段名特殊时显式指定', () => {
        expect(withItemNames([{ item_key: 'zi_yun_shen', quantity: 1 }])[0].item_name).toBe('紫云参');
        expect(withItemNames([{ item_id: 'zi_yun_shen', quantity: 1 }])[0].item_name).toBe('紫云参');
        const costs = [{ material: 'zi_yun_shen', count: 10 }];
        expect(withItemNames(costs, 'material')[0].item_name).toBe('紫云参');
    });

    test('非数组进来不炸：空/缺字段一律给空数组（出参形状稳定）', () => {
        expect(withItemNames(undefined)).toEqual([]);
        expect(withItemNames(null)).toEqual([]);
        expect(withItemNames([{ quantity: 1 }])).toEqual([{ quantity: 1 }]);
        expect(withItemNames(['zi_yun_shen'])).toEqual(['zi_yun_shen']);
    });
});
