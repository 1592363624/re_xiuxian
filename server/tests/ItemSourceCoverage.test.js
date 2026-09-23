/**
 * 「资料片加的每件物品，玩家到底拿不拿得到」（2026-09-22，任务 #31）
 *
 * 物品表方向上原来没有任何一处能回答这个问题：`_validateItemKeysDeep` 判的是**反方向**
 * （"这条引用指着的物品存不存在"），所以"物品定义了、却哪儿都不掉、不卖、不炼、不换"
 * 这一整类死内容完全没人管 —— 一件传说装备可以躺在 `item_data` 里标价 36000 灵石，
 * 面板能查到名字，玩家一辈子拿不到，而启动、测试、探针一路都是绿的。
 *
 * 这一片怎么判"有来源"：只认**内容里写明的发放路径**（下表 GRANT，每条都对着一个真实消费端），
 * 材料消耗 / 学习卷轴 / 捐献投入这些是**去路**不算来源。三档口径：
 *   1. 资料片新增的物品：100% 必须有来源（硬拦，例外要写理由，名单与判据同时钉）；
 *   2. 基础存量（改造前就配着的 443 件）：只许变小的棘轮 —— 数字来自实测，不靠记忆；
 *   3. 这条闸看不见的东西要写明白：服务代码里硬编码的发放、GM 后台发东西、玩家间交易/拍卖，
 *      都不在"内容路径"里。所以一次红必须先去代码里 grep 那个 id 再判断（本仓已这么查过一轮）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { ContentRegistry } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { serverRoot } = require('./helpers/realContent');

const CONFIG_DIR = path.join(serverRoot, 'config');
const REAL_PACK_DIR = path.join(serverRoot, 'content', 'packs');

/**
 * 来源/去路两张表与路径归一都住在 `game/content/sourceLedgers.js`（2026-09-22 搬过去的）：
 * 判据不能只活在测试里 —— 生产侧的内容体检报告（scripts/content_health_report.js）必须读同一份表，
 * 否则两份规则一定漂移，而漂移的结果是"测试说可达、报告说不可达"这种没人能解释的分歧。
 */
const {
    normalizeRefPath: norm, ITEM_GRANT_PATHS: GRANT_PATHS, ITEM_SINK_PATHS: SINK_PATHS
} = require('../game/content/sourceLedgers');

function loadView(packDir) {
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir, statRegistry });
    content.load();
    return content;
}

const full = loadView(REAL_PACK_DIR);
const base = loadView(path.join(serverRoot, 'content', '__no_such_pack_dir__'));

/** 路径 → 物品集合（已按下标归一化） */
function grantIndex(content) {
    const byPath = new Map();
    for (const [raw, ids] of content.itemReferenceIndex().entries()) {
        const at = norm(raw);
        if (!byPath.has(at)) byPath.set(at, new Set());
        for (const id of ids) byPath.get(at).add(id);
    }
    return byPath;
}

function grantPathsOf(byPath, id) {
    return [...byPath.entries()].filter(([, ids]) => ids.has(id)).map(([p]) => p);
}

const matchedGrantPaths = p => GRANT_PATHS.some(g => g.re.test(p));

const hasGrant = (byPath, id) => grantPathsOf(byPath, id).some(matchedGrantPaths);

function recipesOf(content) {
    const crafting = content.dataset('crafting_data') || {};
    return [...(crafting.alchemy_recipes || []), ...(crafting.refining_recipes || [])];
}

/**
 * 学不会的配方：learn_source 不是 default，而"教它的那张图谱"又不在任何来源里。
 *
 * 为什么这算物品可达性：`learn_source` 除 default 之外**没有任何代码读**
 * （CraftingService 只在 `_ensureDefaultRecipes` 里判 `=== 'default'`；
 * 学配方的真通道是 `useItem` 消耗一张 `effect.learn_recipe` 指向该配方的 recipe_scroll）。
 * 所以 `learn_source: "sect"` / `"scroll:recipe_x"` 都只是写给人看的镜像 —— 图谱不掉，
 * 这条炼制链就整条是死的：物品配了、配方配了、材料也有，玩家一辈子学不会那一方。
 */
function unlearnableRecipes(content, byPath) {
    const teacher = new Map(content.dataset('item_data').items
        .filter(i => i.effect && i.effect.learn_recipe)
        .map(i => [String(i.effect.learn_recipe), String(i.id)]));
    return recipesOf(content)
        .filter(r => r.learn_source !== 'default')
        .map(r => ({ recipe: String(r.id), learn_source: r.learn_source, scroll: teacher.get(String(r.id)) || null }))
        .filter(row => !row.scroll || !hasGrant(byPath, row.scroll));
}

describe('资料片新增物品的获取来源（内容路径判据 + 基础存量棘轮）', () => {
    const byPath = grantIndex(full);
    const allPaths = [...byPath.keys()];
    const items = content => content.dataset('item_data').items.map(i => String(i.id));
    const baseIds = new Set(items(base));
    const packItems = items(full).filter(id => !baseIds.has(id));

    test('来源/去路两张表都真的对得上现网路径（表不是凭空写的，也不许有已经没人用的旧条）', () => {
        const dead = [...GRANT_PATHS, ...SINK_PATHS].filter(g => !allPaths.some(p => g.re.test(p)));
        expect(dead.map(g => String(g.re))).toEqual([]);
        // 判据要有东西可判：现网真有这么多种来源路径（不是只匹配上一条就算"覆盖了"）
        const covered = allPaths.filter(matchedGrantPaths);
        expect(new Set(covered).size).toBeGreaterThanOrEqual(20);
    });

    test('同一条来源路径不许既在 GRANT 又在 SINK（两边都判 = 谁也不知道它算哪头）', () => {
        const both = GRANT_PATHS.filter(g => SINK_PATHS.some(s => s.re.source === g.re.source));
        expect(both).toEqual([]);
    });

    test('资料片新增的每一件物品都有至少一条来源路径', () => {
        const unreachable = packItems.filter(id => !grantPathsOf(byPath, id).some(matchedGrantPaths));
        // 例外要写理由（GM 专用/纯展示物品），空名单是本片默认期望
        expect(unreachable.map(id => `${id}（在 item_data 里定义了，但没有任何发放路径）`)).toEqual([]);
    });

    test('控制跑：把去路当来源算就会"全都可达" —— 判据必须分得清方向', () => {
        const synthetic = Object.create(ContentRegistry.prototype);
        synthetic.datasets = new Map([
            ['item_data', { items: [{ id: 'made_thing' }, { id: 'only_material' }] }],
            ['crafting_data', {
                alchemy_recipes: [{
                    id: 'r1',
                    product: { item_key: 'made_thing' },
                    materials: [{ item_key: 'only_material' }]
                }]
            }]
        ]);
        synthetic.dataset = name => synthetic.datasets.get(name);
        const by = grantIndex(synthetic);
        // 产物算来源、材料不算 —— 材料是玩家交出去的那一头
        expect(grantPathsOf(by, 'made_thing').some(matchedGrantPaths)).toBe(true);
        expect(grantPathsOf(by, 'only_material').some(matchedGrantPaths)).toBe(false);
        expect(grantPathsOf(by, 'only_material')).toEqual(['crafting_data.alchemy_recipes[].materials[].item_key']);
    });

    test('每一张配方都学得会（要么 default 自动教，要么真有一张会掉的图谱教它）', () => {
        const dead = unlearnableRecipes(full, byPath);
        expect(dead.map(r => `${r.recipe}（learn_source=${r.learn_source}，图谱=${r.scroll || '根本没有这张物品'}）`)).toEqual([]);
        expect(recipesOf(full).length).toBeGreaterThanOrEqual(40);   // 有东西可判，不是空表全过
    });

    test('这条判据的前提要成立：learn_source 除 default 外没有代码读', () => {
        const text = fs.readFileSync(path.join(serverRoot, 'game', 'services', 'CraftingService.js'), 'utf8');
        expect(text).toMatch(/learn_source === 'default'/);
        expect(text).not.toMatch(/learn_source === '(?!default)/);
        // 真通道是物品上的 effect.learn_recipe（这张判据就是照它算的）
        expect(text).toMatch(/effect\?\.learn_recipe/);
    });

    test('控制跑：教配方的图谱不掉 → 那条配方必须被判成学不会（补上掉落就放行）', () => {
        const datasets = {
            item_data: { items: [
                { id: 'secret_manual', type: 'recipe_scroll', effect: { learn_recipe: 'craft_secret' } },
                { id: 'secret_pill' }
            ] },
            crafting_data: { alchemy_recipes: [{
                id: 'craft_secret', learn_source: 'scroll:secret_manual', product: { item_key: 'secret_pill' }
            }] },
            drop_data: { drops: [] }
        };
        const build = () => {
            const stub = Object.create(ContentRegistry.prototype);
            stub.datasets = new Map(Object.entries(datasets));
            stub.dataset = name => stub.datasets.get(name);
            return grantIndex(stub);
        };
        let by = build();
        const asContent = { dataset: name => datasets[name] };
        expect(unlearnableRecipes(asContent, by).map(r => r.recipe))
            .toEqual(['craft_secret']);
        // 图谱开始掉了 —— 同一条判据立刻放行（证明上一条红真的是"掉不掉"判出来的）
        datasets.drop_data.drops = [{ monster_id: 'bandit', drops: [{ item_id: 'secret_manual', quantity: 1, chance: 0.1 }] }];
        by = build();
        expect(unlearnableRecipes(asContent, by)).toEqual([]);
    });

    test('基础存量里"没有任何内容引用"的物品数量只许变小（棘轮，数字来自实测）', () => {
        const orphanBase = items(base).filter(id => grantPathsOf(byPath, id).length === 0);
        // 这一条不是"已经修好"，是"别再变多"：基础表是改造前配的，缺来源要一件件判归属再补，
        // 修一批就把上限往下调一次（与 tests/ProbeCascadeCleanup.test.js 同一口径）。
        // 本轮就把上限从实测 156 调到 145：11 张教配方的图谱卷轴以前哪儿都不掉
        // （配方学不会 → 那条丹药/装备链整条是死的），现已挂到散修与劫道两张掉落表上。
        expect(orphanBase.length).toBeLessThanOrEqual(145);
        expect(orphanBase.length).toBeGreaterThan(0);   // 数字要真实：等到真降到 0 就该把这条升成硬拦
    });

    test('判据本身要能红：合成一份"定义了但没人发"的物品必须被点名', () => {
        const synthetic = Object.create(ContentRegistry.prototype);
        synthetic.datasets = new Map([
            ['item_data', { items: [{ id: 'ghost_blade' }, { id: 'lucky_charm' }] }],
            ['drop_data', { drops: [{ monster_id: 'm', drops: [{ item_id: 'lucky_charm' }] }] }]
        ]);
        synthetic.dataset = name => synthetic.datasets.get(name);
        const index = ContentRegistry.prototype.itemReferenceIndex.call(synthetic);
        const by = new Map([...index.entries()].map(([k, v]) => [norm(k), v]));
        expect([...by.keys()]).toEqual(['drop_data.drops[].drops[].item_id']);
        expect(grantPathsOf(by, 'lucky_charm').some(matchedGrantPaths)).toBe(true);
        expect(grantPathsOf(by, 'ghost_blade').length).toBe(0);
        // 而且这份合成数据过得了存在性闸（物品"存在"，只是没人发 —— 那正是本闸管的那一类）
        expect(() => ContentRegistry.prototype._validateItemKeysDeep.call(synthetic)).not.toThrow();
    });

    test('代码里硬编码发放的物品不算"内容路径"，红的时候要先去代码 grep（这条注释本身就是判据的一部分）', () => {
        const text = fs.readFileSync(path.join(serverRoot, 'game', 'content', 'ContentRegistry.js'), 'utf8');
        expect(text).toMatch(/itemReferenceIndex\(\)/);
        expect(text).toMatch(/_walkItemRefs\(onRef\)/);
        // 反向：来源账必须问 `_walkItemRefs` 要引用，不许再抄一份字段名判据（两份真相迟早分叉）
        const ledger = fs.readFileSync(__filename, 'utf8');
        expect(ledger).not.toMatch(/item_key\|item_id\|material_key/);
    });
});
