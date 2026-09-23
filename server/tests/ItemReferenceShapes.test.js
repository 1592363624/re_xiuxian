/**
 * "什么形状算物品引用"这张判据本身要能测（2026-09-22，任务 #31）
 *
 * 起因是一次普查：把 `ContentRegistry` 的物品引用遍历抽成 `_walkItemRefs` 之后，
 * 我拿"值等于已知物品 id"倒查全部内容，抓到两类以前没人管的东西：
 *   ① 深度上限 8 太小 —— 现网有一条 9 层的真实引用
 *      `dungeon_data.chapters[].nodes[].options[].rewards.items[].item_key`（15 处），
 *      走到第 9 层就 return，这些副本抉择奖励里的物品 id **从来没被存在性校验看过一眼**；
 *   ② 四种字段形状完全绕过判据：`upgrade_costs[].material`、`choices[].items_granted`、
 *      `alchemy.supported_pills`、`function_item_pools.items[].id` —— 每一处都对得上一个真实消费端
 *      （CaveService 按它扣材料 / MultiDungeonService 直接 grantItems / 掌天瓶炼丹 / 钓鱼奖池）。
 * 补判据的过程本身还红过一次：`game_balance.item_types.material = "材料"` 是**中文标签表**，
 * 一律按物品引用扫就会在启动期抛"材料不是物品"。那次红是判据太宽，不是内容坏了 ——
 * 所以 `material` 收窄成"只认数组元素里的那种"，而不是往豁免表里塞一条。
 *
 * 这里每一条都用合成数据打靶（形状判据不需要连库），再用真实视图证明"判据不会只会抛"。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { ContentRegistry } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { serverRoot } = require('./helpers/realContent');

const CONFIG_DIR = path.join(serverRoot, 'config');
const REAL_PACK_DIR = path.join(serverRoot, 'content', 'packs');

/** 只装一个真物品的极小物品表：坏引用必须被点名，好引用不许响 */
const ITEM_DATA = { items: [{ id: 'real_item', name: '真物品', type: 'material' }] };

/** 直接跑生产那道存在性校验，返回错误清单（空数组 = 过） */
function itemRefGateErrors(datasets) {
    const stub = Object.create(ContentRegistry.prototype);
    stub.datasets = new Map(Object.entries({ item_data: ITEM_DATA, ...datasets }));
    stub.dataset = name => stub.datasets.get(name);
    const warns = [];
    const spy = jest.spyOn(console, 'warn').mockImplementation(msg => warns.push(String(msg)));
    try {
        ContentRegistry.prototype._validateItemKeysDeep.call(stub);
        return { errors: [], warns };
    } catch (error) {
        const errors = String(error.message).split('\n').map(l => l.trim())
            .filter(l => l && !/内容里有物品引用|先补物品/.test(l));
        return { errors, warns };
    } finally {
        spy.mockRestore();
    }
}

/** 逐条形状：同一份合成数据，只有"引用写在哪种形状里"不同 */
const SHAPES = [
    ['数组元素里的 material（洞府设施升级扣的材料）', {
        cave_data: { cave: { facilities: { spirit_vein: { upgrade_costs: [{ material: 'ghost_item', material_count: 3 }] } } } }
    }, /cave_data\.cave\.facilities\.spirit_vein\.upgrade_costs\.0\.material/],
    ['choices[].items_granted（多人副本抉择直接 grantItems）', {
        multi_dungeon_data: { dungeons: { gu: { acts: [{ choices: [{ items_granted: ['ghost_item'] }] }] } } }
    }, /items_granted/],
    ['alchemy.supported_pills（掌天瓶炼丹白名单）', {
        artifact_deep_lines: { settings: { sky_bottle: { alchemy: { supported_pills: ['ghost_item'] } } } }
    }, /supported_pills/],
    ['function_item_pools.items[].id（钓鱼奖池，元素主键只有 id）', {
        fishing_data: { function_item_pools: { items: [{ id: 'ghost_item', weight: 1 }] } }
    }, /function_item_pools\.items\[\]\.id/],
    ['裸 id 数组 items:["x"]（历练/兽潮结算那种）', {
        adventure_event_data: { events: [{ rewards: { items: ['ghost_item'] } }] }
    }, /rewards\.items\[\]/],
    ['对象元素 items[].key（慕兰战线军需铺那种）', {
        border_military_data: { military_shop: { items: [{ key: 'ghost_item', price: 1 }] } }
    }, /military_shop\.items\[\]\.key/],
    ['第 9 层深的引用（旧深度上限 8 会直接放过 —— 现网真实存在这种形状）', {
        dungeon_data: { chapters: [{ nodes: [{ options: [{ rewards: { items: [{ item_key: 'ghost_item' }] } }] }] }] }
    }, /dungeon_data\.chapters\.0\.nodes\.0\.options\.0\.rewards\.items\[\]\.item_key/]
];

describe('物品引用形状判据（补上的四种 + 深度上限）', () => {
    test.each(SHAPES)('%s → 坏 id 必须被点名', (_label, datasets, expected) => {
        const { errors } = itemRefGateErrors(datasets);
        expect(errors.join('\n')).toMatch(expected);
        expect(errors.join('\n')).toMatch(/ghost_item/);
        expect(errors).toHaveLength(1);        // 一条引用只许报一次
    });

    test('引用指向真物品时一条都不报（判据不是只会抛）', () => {
        for (const [label, datasets] of SHAPES) {
            const fixed = JSON.stringify(datasets).replaceAll('ghost_item', 'real_item');
            const { errors } = itemRefGateErrors(JSON.parse(fixed));
            expect({ label, errors }).toEqual({ label, errors: [] });
        }
    });

    test('控制跑：material 当普通键用（中文标签表）不许被当成物品引用', () => {
        // game_balance.item_types 就是 `material → "材料"` 这种形状：一律按名字扫会抛
        // "材料不是物品"，那是判据太宽。收窄成"只认数组元素里的 material"之后这一条必须安静。
        const { errors } = itemRefGateErrors({ game_balance: { item_types: { material: '材料', weapon: '武器' } } });
        expect(errors).toEqual([]);
        // 反证：判据如果把 material 当普通物品字段（旧写法 test 里那条），同样的数据必须红
        const asElement = itemRefGateErrors({
            game_balance: { item_types: { list: [{ material: '材料' }] } }
        });
        expect(asElement.errors.join('\n')).toMatch(/item_types\.list\.0\.material/);
    });

    test('真实视图（基础 + 全部资料片）过得了这道闸：现网没有指向不存在物品的引用', () => {
        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        expect(() => content.load()).not.toThrow();
    });

    test('深度上限不再截断现网那条 9 层引用', () => {
        const source = fs.readFileSync(path.join(serverRoot, 'game', 'content', 'ContentRegistry.js'), 'utf8');
        const cap = /const MAX_ITEM_REF_DEPTH = (\d+);/.exec(source);
        expect(cap && Number(cap[1])).toBeGreaterThan(8);
        expect(source).not.toMatch(/if \(depth > 8 \|\|/);

        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        content.load();
        const deep = [...content.itemReferenceIndex().keys()].filter(p => p.split('.').length > 9);
        expect(deep.length).toBeGreaterThan(0);
        expect(deep.join('\n')).toMatch(/dungeon_data\.chapters\.\d+\.nodes\.\d+\.options\.\d+\.rewards\.items/);
    });

    test('itemReferenceIndex 出的是"路径 → 物品集合"，且物品表自己不算引用方', () => {
        const stub = Object.create(ContentRegistry.prototype);
        stub.datasets = new Map([
            ['item_data', ITEM_DATA],
            ['drop_data', { drops: [{ monster_id: 'm1', drops: [{ item_id: 'real_item', chance: 1 }] }] }]
        ]);
        stub.dataset = name => stub.datasets.get(name);
        const index = ContentRegistry.prototype.itemReferenceIndex.call(stub);
        expect([...index.keys()]).toEqual(['drop_data.drops.0.drops.0.item_id']);
        expect([...index.get('drop_data.drops.0.drops.0.item_id')]).toEqual(['real_item']);
        // 物品表自己的 id/name 不该被当成"有人引用了它"（否则来源账会自证自）
        expect([...index.keys()].join()).not.toContain('item_data');
    });

    test('控制跑：合成数据里若一条坏引用都没写，闸必须安静（上面每条红都是真判出来的）', () => {
        const { errors } = itemRefGateErrors({ fishing_data: { function_item_pools: { items: [] } } });
        expect(errors).toEqual([]);
    });
});
