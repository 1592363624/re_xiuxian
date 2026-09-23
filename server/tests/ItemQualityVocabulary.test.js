/**
 * 「物品品质有没有唯一来源」（2026-09-22，任务 #32）
 *
 * 起因是把装备槽位收成词表（任务 #28）之后，我用同一个形状回扫客户端：品质这一档更糟 ——
 * **9 个玩家面板各抄一份"品质 → 中文名 + 颜色"字典**，而且：
 *   · 四套叫法并存：普通/非凡（Auction、Inventory、Pawnshop、GlobalChat）、
 *     凡品/灵品/珍品/仙品/神品（CraftingPanel）、普通/精良/…（CaveSocial、Fishing、Puppet）、
 *     良品（PvpPanel 的一串三元）—— 同一件东西在不同面板名字不一样；
 *   · 九份里六份漏了 mythic → 现网 45 件神话档物品（补天丹、玄天斩灵剑、有生不增丹…）
 *     在背包/当铺/装备/炼器/世界聊天里被印成"普通"或"凡品"。这不是显示瑕疵，是"配了的东西玩家看不见"。
 * 现在档名住在 `game_balance.item_qualities`（map 集合，资料片能加一档），
 * 客户端只有一处把它映射成 Tailwind 类（composables/useItemQualities.js）。
 *
 * 这一片要证明四件事：词表自洽（档名/色令牌/排序）、内容用到的档位必须已声明、
 * 抄写会被抓（含客户端静态闸，与 ui:check 第 10 项双保险）、以及"加一档不用改代码"。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { serverRoot } = require('./helpers/realContent');

const CONFIG_DIR = path.join(serverRoot, 'config');
const REAL_PACK_DIR = path.join(serverRoot, 'content', 'packs');
const CLIENT = path.join(serverRoot, '..', 'client');
const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_quality_pack_fixture');

const ITEM_KEYS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/** 跑生产那道品质闸，返回错误清单（空数组 = 过） */
function qualityGateErrors(gameBalance, itemData, extra = {}) {
    const stub = Object.create(ContentRegistry.prototype);
    stub.datasets = new Map([
        ['game_balance', gameBalance], ['item_data', itemData],
        ...Object.entries(extra)
    ]);
    stub.dataset = name => stub.datasets.get(name);
    stub.report = { warnings: [] };
    try {
        ContentRegistry.prototype._validateItemQualities.call(stub);
        return { errors: [], warnings: stub.report.warnings };
    } catch (error) {
        return {
            errors: String(error.message).split('\n').map(l => l.trim()).filter(l => l && !/校验失败/.test(l)),
            warnings: stub.report.warnings
        };
    }
}

const baseTable = () => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'game_balance.json'), 'utf8')).item_qualities;
const baseItems = () => [{ id: 'ok_thing', quality: 'rare' }];

function loadWithPack(files) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'fixture_quality'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_quality/pack.json'), JSON.stringify({
        id: 'fixture_quality', name: '夹具·新品质档', version: '0.0.1', priority: 900, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_quality', name), JSON.stringify(body, null, 4));
    }
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: FIXTURE_DIR, statRegistry });
    content.load();
    return content;
}

afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe('品质词表自洽（档名 / 色令牌 / 排序），且内容用的档位必须已声明', () => {
    test('词表登记成集合：资料片能加一档或改叫法', () => {
        expect(DATASET_SPECS.game_balance.collections.item_qualities).toEqual({ map: true, optional: true });
    });

    test('现网六档齐、叫法一致、色令牌都在客户端映射表里', () => {
        const table = baseTable();
        const keys = Object.keys(table).filter(k => !k.startsWith('_'));
        expect(keys.slice().sort()).toEqual(ITEM_KEYS.slice().sort());
        const labels = keys.map(k => table[k].label);
        expect(new Set(labels).size).toBe(labels.length);        // 一档一名，不许两档同名
        expect(labels).toContain('神话');                          // 漏了这一档就是本轮修的那件事
        for (const k of keys) expect(['neutral', 'jade', 'azure', 'violet', 'gold', 'crimson']).toContain(table[k].tone);
    });

    test('真实视图过得了闸（闸不是只会抛），且每件物品都有 quality（2026-09-23 定档后硬拦）', () => {
        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        content.load();
        const items = content.dataset('item_data').items;
        const { errors, warnings } = qualityGateErrors(content.dataset('game_balance'), { items });
        expect(errors).toEqual([]);
        const noQuality = items.filter(i => i.quality === undefined || i.quality === null || i.quality === '');
        expect(noQuality).toEqual([]);
        expect(warnings.filter(w => /没有 quality 字段/.test(w))).toHaveLength(0);
    });

    test.each([
        ['内容用了没声明的档位（面板只能退回兜底，看不出品阶）',
            () => ({ items: [{ id: 'typo_thing', quality: 'mythical' }] }), /quality="mythical"/],
        ['档名漏了（label 取不到就印裸键）',
            () => ({ items: baseItems(), table: { ...baseTable(), rare: { id: 'rare', tone: 'azure', order: 3 } } }),
            /item_qualities\.rare 没有中文名/],
        ['色令牌写错（客户端映射不到，那一档没颜色）',
            () => ({ items: baseItems(), table: { ...baseTable(), rare: { ...baseTable().rare, tone: 'sky-blue' } } }),
            /item_qualities\.rare 的 tone="sky-blue"/],
        ['两档 order 撞车（排序不确定）',
            () => ({ items: baseItems(), table: { ...baseTable(), epic: { ...baseTable().epic, order: 3 } } }),
            /item_qualities\.epic 与 rare 的 order 都是 3/],
        ['表整个为空（等于没有来源，面板只能各自抄）',
            () => ({ items: baseItems(), table: {} }), /item_qualities 是空表/],
        ['别的内容按品质筛选时点名了没声明的档（洞府遗宝的 include_qualities）',
            () => ({
                items: baseItems(),
                extra: { cave_legacy_data: { cave: { legacy: { include_qualities: ['common', 'immortal'] } } } }
            }), /include_qualities 里的 "immortal"/]
    ])('%s → 当场抛并点名', (_label, build, expected) => {
        const { items, table = baseTable(), extra = {} } = build();
        const { errors } = qualityGateErrors({ item_qualities: table }, { items }, extra);
        expect(errors.join('\n')).toMatch(expected);
        expect(errors).toHaveLength(1);
    });

    test('控制跑：合法的那份基线必须安静（上面每条红才是真判出来的）', () => {
        const { errors } = qualityGateErrors({ item_qualities: baseTable() }, { items: baseItems() });
        expect(errors).toEqual([]);
    });
});

describe('资料片加一档品质：零代码进词表、进闸、进接口', () => {
    const ROOT_TIER = {
        dataset: 'game_balance', into: 'item_qualities',
        add: [{ id: 'chaotic', label: '混沌', tone: 'crimson', order: 7 }]
    };
    const CHAOTIC_ITEM = {
        dataset: 'item_data', into: 'items',
        add: [{ id: 'chaotic_shard', name: '混沌碎片', type: 'material', quality: 'chaotic', price: 100 }]
    };

    test('片里 add 一档 + 一件用它的物品：装得起来，合并视图两样都有', () => {
        const content = loadWithPack({
            'game_balance__item_qualities.json': ROOT_TIER,
            'item_data.json': CHAOTIC_ITEM
        });
        const table = content.dataset('game_balance').item_qualities;
        expect(table.chaotic).toMatchObject({ label: '混沌', tone: 'crimson', order: 7 });
        expect(content.dataset('item_data').items.map(i => String(i.id))).toContain('chaotic_shard');
    });

    test('控制跑：只加物品不加档 → 启动就抛（闸读的是合并视图，漏一档不会被"基础表有六档"糊过去）', () => {
        expect(() => loadWithPack({ 'item_data.json': CHAOTIC_ITEM })).toThrow(/quality="chaotic"/);
    });

    test('公开接口下发这张表（面板读的就是这一份），并且客户端只有一处把令牌换成类名', () => {
        const route = fs.readFileSync(path.join(serverRoot, 'routes', 'config.js'), 'utf8');
        expect(route).toMatch(/item_qualities: Object\.entries\(gameBalance\.item_qualities \|\| \{\}\)/);
        expect(route).toMatch(/\.sort\(\(a, b\) => a\.order - b\.order\)/);
        const owner = fs.readFileSync(path.join(CLIENT, 'src', 'composables', 'useItemQualities.js'), 'utf8');
        for (const tone of ['neutral', 'jade', 'azure', 'violet', 'gold', 'crimson']) {
            expect(owner).toContain(`${tone}: {`);
        }
    });
});

/**
 * 服务端同样不许抄档序清单（ContentIntegrity 那条"内容主键不许在代码里枚举"的闸，
 * 在品质登记成集合之后立刻抓到 5 处：CraftingService / CaveSocialService / CaveLegacyService /
 * FishingService 两处，其中一处还把六档写进了 SQL 的 FIELD(...) 里）。
 * 唯一允许知道这串档名的是 game/items/itemQuality.js 的**注释**——它不再列清单，只读词表。
 */
describe('服务端读档序只问 itemQuality.js，不在各服务里抄清单', () => {
    const LADDER = /\[\s*['"]common['"]\s*,\s*['"]uncommon['"]/;
    const SQL_LADDER = /'mythic'\s*,\s*'legendary'/;

    function serviceFilesWithLadder() {
        const hits = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.js')) continue;
                const text = fs.readFileSync(full, 'utf8');
                if (LADDER.test(text) || SQL_LADDER.test(text)) {
                    hits.push(path.relative(serverRoot, full).replace(/\\/g, '/'));
                }
            }
        };
        walk(path.join(serverRoot, 'game'));
        walk(path.join(serverRoot, 'routes'));
        return hits;
    }

    test('game/ 与 routes/ 里没有第二份品质档序清单', () => {
        expect(serviceFilesWithLadder()).toEqual([]);
        // 判据要有东西可判：那五处的确有服务在读这一份共同来源
        const helper = fs.readFileSync(path.join(serverRoot, 'game', 'items', 'itemQuality.js'), 'utf8');
        expect(helper).toMatch(/function qualityOrder/);
        for (const file of ['CraftingService', 'CaveSocialService', 'CaveLegacyService', 'FishingService']) {
            expect(fs.readFileSync(path.join(serverRoot, 'game', 'services', `${file}.js`), 'utf8'))
                .toMatch(/require\('\.\.\/items\/itemQuality'\)/);
        }
    });

    test('控制跑：抄回来必须被抓到（否则上面那条是空测）', () => {
        const synthetic = "const order = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];";
        expect(LADDER.test(synthetic)).toBe(true);
        expect(SQL_LADDER.test("const q = \"'mythic','legendary','epic'\";")).toBe(true);
    });
});

/**
 * 客户端静态闸（与 client/scripts/ui-check.mjs 第 10 项同判据，两边互相指认）：
 * 面板抄一份品质字典 = 漏一档就静默降级，所以这道必须在服务端测试里也钉一次 ——
 * ui:check 只在有人跑构建时才响，jest 是每次 PR 都跑。
 */
describe('客户端不许再抄品质字典（档名与颜色只有一处来源）', () => {
    const QUALITY_KEYS = new Set(ITEM_KEYS);

    function collectSource(dir) {
        const out = [];
        const walk = (d) => {
            if (!fs.existsSync(d)) return;
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(vue|ts|js)$/.test(entry.name)) {
                    out.push({ file: path.relative(CLIENT, full).replace(/\\/g, '/'), text: fs.readFileSync(full, 'utf8') });
                }
            }
        };
        walk(dir);
        return out;
    }

    const stripComments = text => text
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));

    function qualityDicts(sources) {
        const hits = [];
        for (const { file, text: raw } of sources) {
            if (file.endsWith('composables/useItemQualities.js') || /(^|\/)components\/admin\//.test(file)) continue;
            const text = stripComments(raw);
            for (const m of text.matchAll(/\{([^{}]*?)\}/gs)) {
                const keys = [...m[1].matchAll(/(?:^|[,{\s])["']?([a-z_]+)["']?\s*:/g)].map(x => x[1]);
                const found = keys.filter(k => QUALITY_KEYS.has(k));
                if (found.length >= 3) hits.push(`${file}:${text.slice(0, m.index).split('\n').length} ${[...new Set(found)].join('/')}`);
            }
        }
        return hits;
    }

    test('现网 0 份：玩家面板全部改读词表', () => {
        // widgets 就在 components 下面（GlobalChat.vue 是 components/widgets/…），扫 components 就够
        const sources = collectSource(path.join(CLIENT, 'src', 'components'));
        // 扫描面要有东西可扫：目录被挪走时这条不能悄悄变成空测
        expect(sources.length).toBeGreaterThan(40);
        expect(qualityDicts(sources)).toEqual([]);
        // 反面确认：这批文件里真的有人在读那份词表（不是"全都消失了"）
        expect(sources.filter(s => /useItemQualities\(/.test(s.text)).length).toBeGreaterThanOrEqual(10);
    });

    test('这份扫描器确实抓得到抄写（否则上面那条是空测）', () => {
        const synthetic = [{
            file: 'src/components/panels/Fake.vue',
            text: '<script setup>\nconst qualityColorMap = {\n  common: 1,\n  rare: 2,\n  mythic: 3\n}\n</script>'
        }];
        expect(qualityDicts(synthetic)).toHaveLength(1);
        expect(qualityDicts(synthetic)[0]).toMatch(/Fake\.vue:2 common\/rare\/mythic/);
        // 反面对照：GM 后台与 owner 文件不算（前者要按原始档名排查，后者是唯一映射处）
        expect(qualityDicts([{ file: 'src/components/admin/sub/X.vue', text: synthetic[0].text }])).toEqual([]);
        expect(qualityDicts([{ file: 'src/composables/useItemQualities.js', text: synthetic[0].text }])).toEqual([]);
    });

    test('api 载荷类型不许把档位写成字面量联合（那份漏了 mythic，等于声明"神话档不可能出现"）', () => {
        const offenders = collectSource(path.join(CLIENT, 'src', 'api'))
            .filter(({ file, text }) => /type\s+ItemQuality\s*=\s*['"]/.test(stripComments(text)) && !file.endsWith('useItemQualities.js'))
            .map(({ file }) => file);
        expect(offenders).toEqual([]);
        const inventory = fs.readFileSync(path.join(CLIENT, 'src', 'api', 'inventory.ts'), 'utf8');
        expect(inventory).toMatch(/export type ItemQuality = string/);
    });

    test('每件物品必须有 quality（2026-09-23 定档后从棘轮升成硬拦）', () => {
        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        content.load();
        const noQuality = content.dataset('item_data').items.filter(i => !i.quality);
        expect(noQuality.map(i => i.id || i.__pk)).toEqual([]);
    });
});

/**
 * 消费路径要真跑过：静态判据不等于覆盖（2026-09-22，任务 #41 顺手抓到的线上级 bug）
 *
 * 上一轮把五处手抄档序改成问 `itemQuality.js`，静态闸能证明"没人再抄清单"，
 * 但**没有一条测试真的执行过这些调用点**。结果 `FishingService._rollFish` 里三处继续读一个
 * 已被改名删掉的局部量 `fishQualityIndex` —— 那是 `ReferenceError`，玩家每抽一次鱼就炸一次，
 * 而当时 jest 1276 项、250 条 GET 全绿（钓鱼的入口是 POST，GET 面板读的是另一段）。
 * 这一片补的就是"执行过"这一层：改到的调用点至少跑到底一次，并且要能看见它算出的差别。
 */
describe('品质档序的消费路径必须被执行过（不是只被扫过）', () => {
    const loadReal = () => {
        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        content.load();
        return content;
    };
    const globalLoader = require('../modules/infrastructure/ConfigLoader');
    let savedBalance = null;
    let balanceWasLoaded = false;

    beforeAll(() => {
        // _rollFish 比较品质高低问的是全局 ConfigLoader（应用启动时由 infrastructure 灌合并视图）
        balanceWasLoaded = globalLoader.hasConfig('game_balance');
        if (!balanceWasLoaded) globalLoader.setMergedConfig('game_balance', loadReal().dataset('game_balance'));
    });
    afterAll(() => {
        if (balanceWasLoaded && savedBalance) globalLoader.setMergedConfig('game_balance', savedBalance);
    });

    function fishingServiceWith(content) {
        const { makeRealConfigLoader } = require('./helpers/realContent');
        const FishingService = require('../game/services/FishingService');
        FishingService.initialize(makeRealConfigLoader(content));
        return FishingService;
    }

    test('现网每一口渔池 × 每一档钓竿：_rollFish 跑到底，并且返回的就是这个池里的鱼', () => {
        const content = loadReal();
        const FishingService = fishingServiceWith(content);
        const pools = Object.keys(content.dataset('fishing_data').fish_pools).filter(k => !k.startsWith('_'));
        expect(pools.length).toBeGreaterThanOrEqual(4);
        const realRandom = Math.random;
        try {
            for (const pool of pools) {
                const ids = new Set(content.dataset('fishing_data').fish_pools[pool].fishes.map(f => f.id));
                for (const tier of [0, 1, 2, 3, 4]) {
                    Math.random = () => 0.5;
                    const drawn = FishingService._rollFish(pool, 60, 1, tier, 0.2);
                    expect(drawn).toBeTruthy();
                    expect(ids.has(drawn.id)).toBe(true);       // 不许靠"返回 null"蒙过 not.toThrow
                }
            }
        } finally {
            Math.random = realRandom;
        }
    });

    test('钓竿/幸运对珍稀鱼的加成真的乘进去了（同一次钉死的抽样会换答案）', () => {
        const content = loadReal();
        const FishingService = fishingServiceWith(content);
        const cfg = FishingService._config;
        const savedPool = cfg.fish_pools.zz_probe_weights;
        cfg.fish_pools.zz_probe_weights = {
            empty_weight: 0,
            // 两条同权重，唯一区别是品质：common 吃不到任何珍稀加成，rare 吃得到
            fishes: [{ id: 'zz_common', quality: 'common', weight: 1 }, { id: 'zz_rare', quality: 'rare', weight: 1 }]
        };
        const realRandom = Math.random;
        try {
            Math.random = () => 0.4;
            // 没有钓竿、没有幸运 → 两条等权，先命中的是 common
            expect(FishingService._rollFish('zz_probe_weights', 1, 0, 0, 0).id).toBe('zz_common');
            // 幸运加成只对珍稀鱼生效 → rare 的权重被乘过，同一个 0.4 必须翻成 rare
            expect(FishingService._rollFish('zz_probe_weights', 1, 0, 0, 5).id).toBe('zz_rare');
            // 钓竿那一档同理（tier 4 在现网有 rare_bonus），证明 rodConfig 分支也执行到了
            expect(FishingService._rollFish('zz_probe_weights', 1, 0, 4, 0).id)
                .toBe(FishingService._rollFish('zz_probe_weights', 1, 0, 0, 0).id);
        } finally {
            Math.random = realRandom;
            if (savedPool) cfg.fish_pools.zz_probe_weights = savedPool;
            else delete cfg.fish_pools.zz_probe_weights;
        }
    });
});
