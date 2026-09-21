/**
 * 资料片「黄枫谷药圃」端到端验收
 *
 * 这一片的验收点不是"又多了几件物品"，而是**一条只靠数据拼出来的玩法闭环**：
 * 行脚商买到种子 → 洞府药园种下 → 收灵草 →（或放养灵兽在废圃拱草）→ 炼丹 → 服丹涨修为。
 * 它专门走本轮刚登记进内容层的几条集合（cave_data 的灵种/景观/货摊、
 * spirit_beast_pasture_data 的放养场所），所以顺带证明"登记之后资料片真能扩出条目"。
 *
 * 另外钉住一条容易踩的对应关系：seed_id 同时就是背包里那件种子的 item_key
 * （GardenService.plant 拿 seed_id 直接 removeItem），两者不一致的表现是永远提示种子不足。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { statRegistry } = require('../game/stats');
const { serverRoot, loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');

const PACK_DIR = path.join(serverRoot, 'content', 'packs', 'spirit_nursery');
let content;
let loader;

beforeAll(() => {
    content = loadRealContent(statRegistry);
    loader = makeRealConfigLoader(content);
});

function must(cond, message) {
    if (!cond) throw new Error(message);
}

/**
 * 合并内容里"会把某件物品发给玩家"的那些引用：字段名形如 item_key / item_id /
 * xxx_item_key / item_pool / seed_id 的值都算一处（与 ContentRegistry 的物品引用深扫同一套形状）。
 * 排除两处自引用：物品表自己的定义、灵种表里的 seed_id —— 否则"定义了"就被当成"有人发"。
 * @returns {Map<string, string>} item id → 第一个引用到它的位置
 */
function collectGrantReferences(content) {
    const pattern = /^(item_key|item_id|material_key|seed_id|[a-z_]+_item_key|[a-z_]+_item_id|item_pools?|[a-z_]+_item_pools?)$/;
    const grants = new Map();
    const walk = (node, where) => {
        if (Array.isArray(node)) { node.forEach(v => walk(v, where)); return; }
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            const list = Array.isArray(value) ? value : [value];
            if (pattern.test(key)) {
                for (const item of list) {
                    if (typeof item === 'string' && !grants.has(item)) grants.set(item, `${where}.${key}`);
                }
            }
            walk(value, `${where}.${key}`);
        }
    };
    for (const [dataset, data] of content.mergedDatasets()) {
        if (dataset === 'item_data') continue;
        if (dataset === 'cave_data') {
            const clone = JSON.parse(JSON.stringify(data));
            if (clone.cave && clone.cave.garden) delete clone.cave.garden.seeds;
            walk(clone, dataset);
            continue;
        }
        walk(data, dataset);
    }
    return grants;
}

const packFiles = () => fs.readdirSync(PACK_DIR).filter(n => n.endsWith('.json') && n !== 'pack.json');

describe('黄枫谷药圃：只加数据拼出的一条种植链', () => {
    test('资料片装得上，六个数据文件都落在已登记的集合上', () => {
        expect(fs.existsSync(path.join(PACK_DIR, 'pack.json'))).toBe(true);
        expect(packFiles().length).toBe(6);
        const cave = content.dataset('cave_data').cave;
        expect(cave.garden.seeds.map(s => s.seed_id)).toEqual(expect.arrayContaining(['qi_ye_qing_seed', 'zi_yun_shen_seed']));
        expect(cave.social.landscapes.map(l => l.id)).toContain('nursery_herbs');
        expect(cave.social.merchant.items.map(i => i.item_key)).toEqual(expect.arrayContaining(['qi_ye_qing_seed', 'zi_yun_shen_seed']));
        expect(content.dataset('spirit_beast_pasture_data').pasture.locations.map(l => l.location_key)).toContain('huangfeng_valley');
        expect(content.dataset('item_data').items.map(i => i.id)).toContain('ju_yuan_dan');
    });

    test('种子先能买到、再能种：seed_id 就是背包里的 item_key，两味灵草都有的产源', () => {
        const GardenService = require('../game/services/GardenService');
        GardenService.initialize(loader);
        const items = new Set(content.dataset('item_data').items.map(i => i.id));
        for (const seedId of ['qi_ye_qing_seed', 'zi_yun_shen_seed']) {
            const seed = GardenService.getSeedConfig(seedId);
            expect(seed).toBeTruthy();
            // 种植时 removeItem(playerId, seed_id, 1) —— 商品表里没有这一件就永远种不下去
            must(items.has(seed.seed_id), `种子 ${seed.seed_id} 没有对应的可拥有物品`);
            must(items.has(seed.produce_item_id), `产物 ${seed.produce_item_id} 不是真物品`);
            // 货摊上有它，玩家才拿得到第一粒
            const sold = content.dataset('cave_data').cave.social.merchant.items.some(i => i.item_key === seed.seed_id);
            must(sold, `${seed.seed_id} 既不在货摊也没有掉落，玩家无从获得`);
        }
    });

    test('全部灵种（含基础的）都满足这条对应关系，且每一粒都有人真的发', () => {
        const items = new Set(content.dataset('item_data').items.map(i => i.id));
        const grants = collectGrantReferences(content);
        for (const seed of content.dataset('cave_data').cave.garden.seeds) {
            must(items.has(seed.seed_id), `灵种 ${seed.seed_id} 不是可拥有物品`);
            must(items.has(seed.produce_item_id), `产物 ${seed.produce_item_id} 不是真物品`);
            must(grants.has(seed.seed_id),
                `灵种 ${seed.seed_id} 除了灵种表自己，没有任何内容发过它 —— 玩家无从获得，摆着好看而已`);
        }
    });

    test('放养场所进得了服务：够境界才看得见，产出物都是真物品', () => {
        const BeastPastureService = require('../game/services/BeastPastureService');
        BeastPastureService.initialize(loader);
        const keys = rank => BeastPastureService.getLocations({ realm_rank: rank }).data.locations.map(l => l.location_key);
        expect(keys(30)).toContain('huangfeng_valley');
        expect(keys(5)).not.toContain('huangfeng_valley');
        const loc = content.dataset('spirit_beast_pasture_data').pasture.locations.find(l => l.location_key === 'huangfeng_valley');
        const items = new Set(content.dataset('item_data').items.map(i => i.id));
        expect(loc.yield_items.every(y => items.has(y.item_id))).toBe(true);
        expect(loc.preferred_elements.every(e => ['metal', 'wood', 'water', 'fire', 'earth', 'thunder', 'ice', 'wind'].includes(e))).toBe(true);
    });

    test('洞府景观的加成键是现网已有键，不造没人读的新键', () => {
        const CaveSocialService = require('../game/services/CaveSocialService');
        CaveSocialService.initialize(loader);
        const landscapes = CaveSocialService.getLandscapesConfig();
        const added = landscapes.find(l => l.id === 'nursery_herbs');
        expect(added).toBeTruthy();
        const baseKeys = new Set(content.dataset('cave_data').cave.social.landscapes
            .filter(l => l.__content_origin !== 'spirit_nursery')
            .flatMap(l => Object.keys(l.bonus || {})));
        for (const key of Object.keys(added.bonus)) {
            must(baseKeys.has(key), `景观加成键 ${key} 只有资料片在用，代码未必读`);
        }
    });

    test('丹方把这条链收口：材料与产物都指向真物品，且丹药效果键是注册表认得的', () => {
        const recipe = (content.dataset('crafting_data').alchemy_recipes || [])
            .find(r => r.id === 'craft_ju_yuan_dan');
        expect(recipe).toBeTruthy();
        const items = new Set(content.dataset('item_data').items.map(i => i.id));
        expect(items.has(recipe.product.item_key)).toBe(true);
        for (const m of recipe.materials) must(items.has(m.item_key), `材料 ${m.item_key} 不是真物品`);
        const pill = content.dataset('item_data').items.find(i => i.id === 'ju_yuan_dan');
        // 效果键本身由启动期的 _validateItemEffects 管（validate_content 会跑）；
        // 这里只钉"这枚丹确实有一个会被消费的效果"，别炼出来一枚什么都不做的丹
        expect(Object.keys(pill.effect).length).toBeGreaterThan(0);
        expect(pill.effect.exp).toBeGreaterThan(0);
    });
});
