/**
 * 「灵兽稀有度收成内容词表」（2026-09-23）
 *
 * 业主原始需求的形状在这里是这样的：一只灵兽有"凡品/灵品/宝品/仙品"四档，后期想再加一档
 * （凡人修仙传世界观里的"灵界仙禽""太初古兽"这类），而且**新档要在所有用到它的地方直接算到**：
 * 图鉴与卡片的档名和配色、"我的灵兽"的分档统计、放生返还比例、升星消耗倍率、GM 后台的筛选下拉。
 *
 * 改造前有 6 处各自读 `config.rarity_config`，兜底还各不相同：
 *   · 名字 `?.name || key`（缺档名 → 把 `mythic` 这种裸键印给玩家）
 *   · 颜色 `?.color || '#9ca3af'`（把 common 那一档的颜色抄进了代码）
 *   · `getMyBeasts.stats.by_rarity` 手打四档（新档不计，而 total 照计 → 界面自相矛盾）
 *   · 放生 `Number(...?.release_return_ratio) || 0.2`
 *   · 升星读**另一张表** `star_upgrade.rarity_cost_multiplier`，缺档回落 1.0 = common 的倍率
 *     → 新档越稀有升星越便宜，方向反了；而且预览与真扣费各抄一份同样的乘法
 *   · 客户端后台再抄一份四档名字 + 两份按键名的 tailwind 色映射
 * 而 `rarity_config` 与那两张伴生表都不在 DATASET_SPECS 里 —— 资料片连"加一档"的入口都没有。
 *
 * 现在：词表 + 两张伴生表都登记成集合，读取口只剩 `game/stats/beastRarity.js` 一处，
 * 界面上的档名/颜色/顺序全部来自服务端，配套一道启动闸（这份测试第 3 组把它的每一条都反过来打一遍，
 * 证明"过闸"不是因为判据是空的）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { statRegistry, ensureStatRegistryLoaded } = require('../game/stats');
const { serverRoot } = require('./helpers/realContent');
const {
    rarityTable, rarityMap, countByRarity, vocabularyForApi, starUpCost,
    releaseReturnRatio, rarityLabel, rarityColor, rarityRank, FALLBACK
} = require('../game/stats/beastRarity');

const SpiritBeastService = require('../game/services/SpiritBeastService');
const SpiritBeast = require('../models/spiritBeast');
const { initializeModules } = require('../modules');

// `_formatBeast` 末尾会算战力，而战力走的是全局 ConfigLoader（夹具只喂内容层，喂不到全局那一份）
beforeAll(async () => {
    await initializeModules();
    ensureStatRegistryLoaded();
});

const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_beast_rarity_fixture');

/** 一支"只加数据"的资料片：新档 + 新档的升星倍率 + 一只用新档的灵兽 */
const NEW_KEY = 'primordial';
const RARITY_FILE = 'spirit_beast_data__rarity_config.json';
const MULTIPLIER_FILE = 'spirit_beast_data__star_upgrade__rarity_cost_multiplier.json';
const BEAST_FILE = 'spirit_beast_data__beast_types.json';

const newRarity = { id: NEW_KEY, name: '太初', color: '#f43f5e', order: 5, release_return_ratio: 0.6 };
// 倍率条目故意写成 map 集合唯一可能的对象形状 {id,value}：基础配置那一侧是裸数字，
// 两种形状必须在同一个读取口下同时算对（§23-24 那一条同族坑）
const newMultiplier = { id: NEW_KEY, value: 4 };
const newBeast = {
    beast_key: 'zz_probe_beast', name: '探针·太古兽', element: 'metal', rarity: NEW_KEY,
    base_hp: 100, base_atk: 20, base_def: 10, base_speed: 15, min_realm_rank: 1,
    catch_chance: 0.5, catch_cost_mp: 10, feed_exp: 10, description: '夹具'
};

function fullPackFiles() {
    return {
        [RARITY_FILE]: { into: 'rarity_config', add: [newRarity] },
        [MULTIPLIER_FILE]: { into: 'star_upgrade.rarity_cost_multiplier', add: [newMultiplier] },
        [BEAST_FILE]: { into: 'beast_types', add: [newBeast] }
    };
}

/** 装配一份内容层：files 是要塞进夹具片的文件，mutateSpec 用于控制跑（摘登记） */
function loadWithFixture(files, mutateSpec) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'rarity_fixture'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'rarity_fixture/pack.json'), JSON.stringify({
        id: 'rarity_fixture', name: '夹具·灵兽稀有度', version: '0.0.1', priority: 999, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, 'rarity_fixture', name), JSON.stringify(body, null, 4));
    }
    const content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'), packDir: FIXTURE_DIR, statRegistry
    });
    const undo = mutateSpec ? mutateSpec() : null;
    try {
        content.load();
        return content;
    } finally {
        if (undo) undo();
    }
}

const loaderOf = content => ({
    getConfig: name => (name === 'spirit_beast_data' ? content.datasets.get('spirit_beast_data') : null)
});

/** 装了"新档 + 新倍率 + 新灵兽"三份条目的完整内容视图（每次重新装配，不共用别的用例那份） */
function loadRealContentWithNewTier() {
    return loadWithFixture(fullPackFiles());
}

describe('现网词表本身（先钉住"改造没有改数值"）', () => {
    const content = loadWithFixture({});
    const loader = loaderOf(content);

    test('四档由低到高、名/色/序齐备，倍率与返还比例都来自内容', () => {
        const table = rarityTable(loader);
        expect(table.map(r => r.key)).toEqual(['common', 'rare', 'epic', 'legendary']);
        expect(table.map(r => r.label)).toEqual(['凡品', '灵品', '宝品', '仙品']);
        expect(table.map(r => r.starUpMultiplier)).toEqual([1, 1.5, 2, 3]);
        expect(table.map(r => r.releaseReturnRatio)).toEqual([0.2, 0.3, 0.4, 0.5]);
        for (const row of table) {
            expect(row.color).toMatch(/^#[0-9a-f]{6}$/i);
            expect(row.declared_order).not.toBeNull();
        }
    });

    test('升星实际消耗 = 消耗表那一行 × 这一档倍率，且预览与扣费是同一份定义', () => {
        const entry = content.datasets.get('spirit_beast_data').star_upgrade.upgrade_table[0];
        expect(entry).toMatchObject({ from_star: 1, to_star: 2, beast_soul_cost: 50, yaodan_cost: 1, spirit_stones_cost: 1000 });
        for (const [key, multiplier] of [['common', 1], ['rare', 1.5], ['epic', 2], ['legendary', 3]]) {
            const cost = starUpCost(loader, key, entry);
            expect(cost.multiplier).toBe(multiplier);
            expect(cost.beastSoulCost).toBe(Math.floor(50 * multiplier));
            expect(cost.yaodanCost).toBe(Math.floor(1 * multiplier));
            expect(cost.spiritStonesCost).toBe(BigInt(Math.floor(1000 * multiplier)));
        }

        const src = fs.readFileSync(path.join(serverRoot, 'game/services/SpiritBeastService.js'), 'utf8');
        // 服务里不许再留第二份同样的乘法（收口成一份定义的理由见文件头）
        expect(src).not.toMatch(/rarity_cost_multiplier\s*\?\.\[/);
        expect(src).not.toMatch(/beast_soul_cost\)\s*\|\|\s*0\)\s*\*/);
        // 两个调用点都是"解构赋值"拿那三个键。键名对不上不会报错：预览会在
        // `spiritStonesCost.toString()` 当场炸，而"材料够不够"那几行只是 NaN 比较 = 一路静默。
        // 这条断言拿服务源码里真实解构出来的名字核对返回形状（真库探针 R4 第一次跑就是这么炸出来的）。
        const destructured = [...src.matchAll(/const \{ ([^}]+) \} = starUp;/g)]
            .flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
        expect(destructured.length).toBe(6);                                  // 预览 + 真扣费，两处都走这一份
        expect(new Set(destructured)).toEqual(new Set(['beastSoulCost', 'yaodanCost', 'spiritStonesCost']));
        const shape = starUpCost(loader, 'common', entry);
        expect(Object.keys(shape)).toEqual(expect.arrayContaining(destructured));
        for (const name of new Set(destructured)) {
            if (shape[name] === undefined) throw new Error(`服务解构了 ${name}，但 starUpCost 没返回它`);
        }
    });

    test('后台那份词表清单走 entryOptions（GM 下拉的数据源）：含新档、带颜色与档序，默认集合仍是灵兽种类', () => {
        const options = content.entryOptions('spirit_beast_data', 'rarity_config');
        expect(options.map(o => o.key)).toEqual(['common', 'rare', 'epic', 'legendary']);
        expect(options[0]).toMatchObject({ name: '凡品', color: '#9ca3af', order: 1 });
        // 不传集合时取的是登记顺序里的第一个 —— 后台的"灵兽种类"下拉靠它，新登记不能插到前面
        expect(content.entryOptions('spirit_beast_data').every(o => o.collection === 'beast_types')).toBe(true);
        const withNew = loadRealContentWithNewTier();
        expect(withNew.entryOptions('spirit_beast_data', 'rarity_config').at(-1))
            .toMatchObject({ key: NEW_KEY, name: '太初', color: '#f43f5e', order: 5 });
    });

    test('分档统计的键集合 == 词表键集合（0 也发，旧行不丢）', () => {
        const rows = [{ rarity: 'common' }, { rarity: 'common' }, { rarity: 'zz_removed_tier' }];        const counts = countByRarity(loader, rows);
        expect(counts.map(c => c.key)).toEqual(['common', 'rare', 'epic', 'legendary', 'zz_removed_tier']);
        expect(counts[0]).toMatchObject({ count: 2, label: '凡品' });
        expect(counts.at(-1)).toMatchObject({ count: 1, label: FALLBACK.label });   // 词表外的旧档照样计数，只是名字兜底
    });
});

describe('加一档稀有度 = 只写内容', () => {
    const content = loadWithFixture(fullPackFiles());
    const loader = loaderOf(content);

    test('新档进入词表并排在末位，名/色/序/返还/倍率都读得到', () => {
        const table = rarityTable(loader);
        const added = table.find(r => r.key === NEW_KEY);
        expect(added).toMatchObject({ label: '太初', color: '#f43f5e', declared_order: 5, releaseReturnRatio: 0.6 });
        expect(table.map(r => r.key).at(-1)).toBe(NEW_KEY);
        expect(rarityLabel(loader, NEW_KEY)).toBe('太初');
        expect(rarityColor(loader, NEW_KEY)).toBe('#f43f5e');
        expect(rarityRank(loader, NEW_KEY)).toBe(5);
        expect(vocabularyForApi(loader).map(v => v.key)).toContain(NEW_KEY);
    });

    test('倍率表里 {id,value} 的对象形状与基础配置的裸数字同时算对', () => {
        const entry = content.datasets.get('spirit_beast_data').star_upgrade.upgrade_table[0];
        expect(starUpCost(loader, NEW_KEY, entry).beastSoulCost).toBe(200);       // 50 × 4
        expect(starUpCost(loader, 'rare', entry).beastSoulCost).toBe(75);           // 50 × 1.5（裸数字那一侧）
    });

    test('放生返还按新档自己的比例，而不是 0.2 那个兜底', () => {
        expect(releaseReturnRatio(loader, NEW_KEY)).toBe(0.6);
    });

    test('用新档的灵兽真的装得进来，卡片外发的是内容里的名与色', () => {
        const beastTypes = content.datasets.get('spirit_beast_data').beast_types;
        expect(beastTypes.map(b => b.beast_key)).toContain('zz_probe_beast');
        const beast = SpiritBeast.build({
            player_id: 1, beast_key: 'zz_probe_beast', element: 'metal', rarity: NEW_KEY,
            level: 3, star_level: 1, hp_max: 300, atk: 60, def: 30, speed: 45
        });
        const formatted = SpiritBeastService._formatBeast(beast, new Map(), {}, rarityMap(loader));
        expect(formatted).toMatchObject({ rarity: NEW_KEY, rarity_name: '太初', rarity_color: '#f43f5e', rarity_order: 5 });
    });

    test('分档统计里出现新档（0 也发）—— 手打四档那份写法会把整档吞掉', () => {
        const counts = countByRarity(loader, [{ rarity: 'common' }]);
        expect(counts.map(c => c.key)).toContain(NEW_KEY);
        expect(counts.find(c => c.key === NEW_KEY).count).toBe(0);
    });
});

describe('启动闸：每一条都反过来打一遍（过闸不能是因为判据是空的）', () => {
    const load = files => () => loadWithFixture(files);

    test('灵兽写一个词表里没有的档 → 点名是哪只、后果是什么', () => {
        const files = fullPackFiles();
        delete files[RARITY_FILE];            // 有灵兽、有倍率，唯独词表没这一档
        expect(load(files)).toThrow(/zz_probe_beast（探针·太古兽）的 rarity="primordial" 不在稀有度词表里/);
    });

    test('只加词表、忘了倍率表 → 拦下（否则新档按 1.0 收，越稀有越便宜）', () => {
        const files = fullPackFiles();
        delete files[MULTIPLIER_FILE];
        expect(load(files)).toThrow(/升星倍率表缺 "primordial"/);
    });

    test('倍率表多出一档而词表没有 → 拦下（那个倍率永远读不到）', () => {
        const files = {
            [MULTIPLIER_FILE]: { into: 'star_upgrade.rarity_cost_multiplier', add: [{ id: 'zz_orphan', value: 9 }] }
        };
        expect(load(files)).toThrow(/star_upgrade\.rarity_cost_multiplier\.zz_orphan 在稀有度词表里没有这一档/);
    });

    test('新档少写 order / 少中文名 / 少颜色 / 返还比例越界 → 各拦各的', () => {
        expect(load({ [RARITY_FILE]: { into: 'rarity_config', add: [{ id: 'zz_a', name: '甲', color: '#111111', release_return_ratio: 0.5 }] } }))
            .toThrow(/rarity_config\.zz_a 没有 order/);
        expect(load({ [RARITY_FILE]: { into: 'rarity_config', add: [{ id: 'zz_b', color: '#111111', order: 7, release_return_ratio: 0.5 }] } }))
            .toThrow(/rarity_config\.zz_b 没有中文名/);
        expect(load({ [RARITY_FILE]: { into: 'rarity_config', add: [{ id: 'zz_c', name: 'zz_c', color: '#111111', order: 8, release_return_ratio: 0.5 }] } }))
            .toThrow(/名字与键相同/);
        expect(load({ [RARITY_FILE]: { into: 'rarity_config', add: [{ id: 'zz_d', name: '丁', color: '#111111', order: 9, release_return_ratio: 1.5 }] } }))
            .toThrow(/release_return_ratio=1\.5 不在 0~1/);
    });

    test('控制跑：摘掉 rarity_config 的登记，同一支夹具片就装不进来（能扩来自登记，不是碰巧）', () => {
        const spec = DATASET_SPECS.spirit_beast_data.collections;
        expect(() => loadWithFixture(fullPackFiles(), () => {
            const saved = spec.rarity_config;
            delete spec.rarity_config;
            return () => { spec.rarity_config = saved; };
        })).toThrow(/rarity_config/);
        // 还原是真的还原：检测器与启动闸读的是同一个对象
        expect(spec.rarity_config).toEqual({ map: true, optional: true });
        expect(loadWithFixture(fullPackFiles())).toBeTruthy();
    });
});

describe('界面上不再抄第二份词表', () => {
    const clientRoot = path.join(serverRoot, '..', 'client');
    const read = rel => fs.readFileSync(path.join(clientRoot, rel), 'utf8');

    test('GM 后台的稀有度下拉与配色取自内容，不留按键名硬编的映射', () => {
        const vue = read('src/components/admin/sub/SpiritBeastManagement.vue');
        expect(vue).toContain("getContentKeyOptions('spirit_beast_data', 'rarity_config')");
        for (const tier of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
            expect(vue).not.toMatch(new RegExp(`['"]?${tier}['"]?\\s*:\\s*'bg-`));
        }
        expect(vue).not.toMatch(/const rarityClass|const rarityBgClass|const elementBgClass/);
    });

    test('前端的分档计数类型不再是四档字面量', () => {
        expect(read('src/api/spiritBeast.ts')).toMatch(/by_rarity:\s*Record<string,\s*number>/);
    });
});
