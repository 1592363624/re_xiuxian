/**
 * 「灵根表能不能被资料片扩展」（2026-09-22，任务 #29）
 *
 * 起因是 role_init 里那条写了很久的结论："灵根三件套不登记成集合，因为 map 集合只支持对象值"。
 * 读 `ContentRegistry.applyOps` 的 map 分支把它否证了：标量值走 `passthrough` 原样带回，
 * 资料片条目的正路是 `add: [{id, value}]`，读取端过 `contentNumber`/`contentLabel`。
 * 于是"加一种灵根"从"改基础配置 + 改 PlayerService 抽卡 + 改加成键"变成"写三个 JSON"。
 *
 * 这一片要证明四件事，缺一条就红：
 *   1. **抽卡只有一处定义**（`stats/SpiritRoot.rollSpiritRoot`）。PlayerService 以前自己抄了一份
 *      池子逻辑，两份真相迟早分叉 —— 所以钉住"第二份不许存在"，并给检测器本身做控制跑。
 *   2. **权重语义是"比率 × 总权重"**。概率表现在和为 1，一旦片里加一档就 >1；
 *      若把传进来的比率当已乘过的绝对值，掷骰永远落在区间前段 —— 新灵根看起来配齐了，实际永远抽不到。
 *   3. **启动期闸认得合并视图**：片加的灵根漏了概率/加成，启动就抛并点名（只看基础文件的闸看不见片）。
 *   4. **新灵根零代码进三处消费点**：属性 provider 的加成、PvP 的五行类型、功法的元素词表。
 *   5. 相克表（technique_data.element_match.conflicts）同样可扩展：以前读取端只认裸数组，
 *      资料片就算写了 `{id,counters}` 也会被 `Array.isArray` 静默丢掉 —— 新灵根于是"只能契合不能相克"。
 *      现在过 `contentList`（数组/对象/单字符串三种写法都认），并由 `_validateElementMatch` 在启动期管键与值。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS, contentNumber, contentList } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { rollSpiritRoot, spiritRootRollPool, resolveSpiritRoot, spiritRootBonus, spiritRootTypes } = require('../game/stats/SpiritRoot');
const { buildProviders } = require('../game/stats/providers');
const TechniqueService = require('../game/services/TechniqueService');
const { serverRoot } = require('./helpers/realContent');

const CONFIG_DIR = path.join(serverRoot, 'config');
const REAL_PACK_DIR = path.join(serverRoot, 'content', 'packs');
const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_spiritroot_pack_fixture');

/** 一份"合法到能过闸"的最小灵根配置（B 组每条坏例都在它之上只改一处） */
function legalRoleInit() {
    return {
        spirit_roots: [
            { id: 'metal', name: '金', type: 'metal' },
            { id: 'wood', name: '木', type: 'wood' },
            { id: 'thunder', name: '雷', type: 'thunder', roll_enabled: false }
        ],
        spiritRootProbabilities: { '金': 0.5, '木': 0.5 },
        spiritRootBonuses: { '金': { atk: 4 }, '木': { hp_max: 30 }, '雷': { atk: 6 } }
    };
}

/** 直接跑生产那道闸，返回错误清单（空数组 = 过） */
function spiritRootGateErrors(roleInit) {
    const stub = Object.create(ContentRegistry.prototype);
    stub.datasets = new Map([['role_init', roleInit]]);
    try {
        ContentRegistry.prototype._validateSpiritRootRoll.call(stub);
        return [];
    } catch (error) {
        return String(error.message).split('\n').map(l => l.trim()).filter(l => l && !/校验失败/.test(l));
    }
}

/**
 * 造一份临时 packs 目录（不碰仓库）：基础配置仍从 config/ 读，片只放这里给的这些文件。
 * @returns {ContentRegistry} 已 load() 的内容层，调用方自己取 dataset
 */
function loadWithPack(files) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'fixture_spiritroot'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_spiritroot/pack.json'), JSON.stringify({
        id: 'fixture_spiritroot', name: '夹具·新灵根', version: '0.0.1', priority: 900, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_spiritroot', name), JSON.stringify(body, null, 4));
    }
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: FIXTURE_DIR, statRegistry });
    content.load();
    return content;
}

const ROOT_ENTRY = {
    dataset: 'role_init', into: 'spirit_roots',
    add: [{ id: 'star', name: '星', displayName: '星', type: 'star', description: '夹具灵根' }]
};
const PROB_ENTRY = { dataset: 'role_init', into: 'spiritRootProbabilities', add: [{ id: '星', value: 0.05 }] };
const BONUS_ENTRY = {
    dataset: 'role_init', into: 'spiritRootBonuses',
    add: [{ id: '星', atk: 3, crit_rate: 0.01 }]
};

afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe('抽灵根只有一处定义，且语义是"比率 × 总权重"', () => {
    test('现网池子就是没被 roll_enabled:false 关掉的那几档；雷/冰/风进不来（"先声明后开放"）', () => {
        const roleInit = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        roleInit.load();
        const merged = roleInit.dataset('role_init');
        const roll = rollSpiritRoot(merged, 0.5);
        expect(roll.pool.sort()).toEqual(['土', '木', '水', '火', '金'].sort());
        expect(roll.pool).not.toContain('雷');
        // 无论比率落在哪儿都抽不到被关掉的档
        for (const ratio of [0, 0.01, 0.3, 0.5, 0.9, 0.999]) expect(rollSpiritRoot(merged, ratio).name).not.toBe('雷');
        expect(roll.totalWeight).toBeCloseTo(1, 6);   // 现网这五条恰好和为 1，改造后仍然不靠这个假设
    });

    test('加一档新灵根不必回头把其余几条改成和为 1（先求和再归一化）', () => {
        const cfg = {
            spirit_roots: [{ name: '金' }, { name: '木' }, { name: '星' }],
            spiritRootProbabilities: { '金': 0.2, '木': 0.2, '星': { id: '星', value: 1.6 } }
        };
        const roll = rollSpiritRoot(cfg, 0.99);
        expect(roll.totalWeight).toBeCloseTo(2.0, 6);
        expect(roll.name).toBe('星');
        expect(rollSpiritRoot(cfg, 0.01).name).toBe('金');   // 权重小的那档仍占区间前段
    });

    test('控制跑：传进来的是 [0,1) 比率，不是已乘过权重的绝对值', () => {
        // 两档各权重 1 → 总权 2。比率 0.99 换算成 1.98 必须落在第二档；
        // 谁把语义改回"绝对值"，0.99 < 1.0 就永远抽第一档 —— 新灵根于是静默不可获得。
        const cfg = { spirit_roots: [{ name: '甲' }, { name: '乙' }], spiritRootProbabilities: { 甲: 1, 乙: 1 } };
        expect(rollSpiritRoot(cfg, 0.4).name).toBe('甲');
        expect(rollSpiritRoot(cfg, 0.99).name).toBe('乙');
    });

    test('坏权重只会把自己剔出池子，不会把整池算成 NaN', () => {
        const cfg = {
            spirit_roots: [{ name: '金' }, { name: '木' }, { name: '水' }, { name: '火' }, { name: '土' }, { name: '星' }],
            spiritRootProbabilities: {
                '金': '零', '木': { id: '木' }, '水': 0, '火': -1, '土': 0.2, '星': { id: '星', value: 0.3 }
            }
        };
        const roll = rollSpiritRoot(cfg, 0.9);
        expect(roll.pool).toEqual(['土', '星']);
        expect(Number.isFinite(roll.totalWeight)).toBe(true);
        expect(roll.name).toBe('星');
        // 反面对照：没有 contentNumber 时 `+=` 一个 {id,value} 对象会得到什么
        expect(Number.isNaN(Number({ id: '木' }))).toBe(true);
        expect(contentNumber({ id: '木' }, null)).toBeNull();
        expect(contentNumber({ id: '星', value: 0.3 }, null)).toBe(0.3);
    });

    test('配置坏到极致时不抛也不发假灵根：宁可不写，也不写一条查无此根的', () => {
        expect(rollSpiritRoot({}, 0.5)).toBeNull();
        expect(rollSpiritRoot(null, 0.5)).toBeNull();
        expect(rollSpiritRoot({ spirit_roots: [{ name: '雷', roll_enabled: false }] }, 0.5)).toBeNull();
        // 概率表整个读不到 → 按声明等分（不写死中文名）
        const cfg = { spirit_roots: [{ name: '金' }, { name: '木' }] };
        const roll = rollSpiritRoot(cfg, 0.9);
        expect(roll.pool).toEqual(['金', '木']);
        expect(roll.name).toBe('木');
    });

    test('启动闸与建号问的是同一个池子定义（闸里不许重述一遍规则）', () => {
        const text = fs.readFileSync(path.join(serverRoot, 'game', 'content', 'ContentRegistry.js'), 'utf8');
        const gate = /_validateSpiritRootRoll\(\)\s*\{[\s\S]*?\n    \}/.exec(text)?.[0] || '';
        expect(gate).toMatch(/spiritRootRollPool\(/);
        // "可抽"这件事不许在闸里再算一遍：只有池子函数能决定（重述就会和 PlayerService 分叉）
        expect(gate).not.toMatch(/rollable\s*=\s*declared\.filter/);
        expect(spiritRootRollPool(legalRoleInit()).map(e => e.name)).toEqual(['金', '木']);
        // 全被写成非正数时按声明等分（与改造前一致）：坏权重那一档自己进不了池子，
        // 但整池不会退化成"永远抽到第一个"。真正该响的是启动闸（每条非正数都点名）。
        expect(spiritRootRollPool({ spirit_roots: [{ name: '金' }], spiritRootProbabilities: { 金: '零' } }))
            .toEqual([{ name: '金', weight: 1 }]);
        expect(spiritRootRollPool({ spirit_roots: [{ name: '雷', roll_enabled: false }] })).toEqual([]);
        // 检测器自检：把"闸里自己重述一遍池子规则"的形状喂进去必须被抓到
        const restated = gate.replace('!spiritRootRollPool(roleInit).length',
            '!(rollable = declared.filter(r => r.roll_enabled !== false && r.name in probabilities)).length');
        expect(restated).not.toBe(gate);
        expect(/rollable\s*=\s*declared\.filter/.test(restated)).toBe(true);
    });

    test('PlayerService 里不许有第二份池子逻辑（静态钉 + 检测器自检）', () => {
        const text = fs.readFileSync(path.join(serverRoot, 'game', 'core', 'PlayerService.js'), 'utf8');
        const duplicated = /spiritRootProbabilities|cumulative\s*\+=|totalWeight/.exec(text);
        expect(text).toMatch(/require\('\.\.\/stats\/SpiritRoot'\)/);
        expect(text).toMatch(/rollSpiritRoot\(/);
        expect(text).toMatch(/if \(roll\)/);            // 池子空时不写假灵根（rollSpiritRoot 会返回 null）
        expect(duplicated && duplicated[0]).toBeNull();
        // 检测器本身要能抓到"抄了一份"的样子，否则上面那条是空测
        const synthetic = text + '\nconst total = pool.reduce((s, e) => s + e.weight, 0); cumulative += entry.weight;';
        expect(/spiritRootProbabilities|cumulative\s*\+=|totalWeight/.exec(synthetic)).not.toBeNull();
    });
});

describe('启动期灵根闸：八条规则逐条点名（含"声明了却没概率"从警告升成硬拦）', () => {
    test('合法基线过闸；现网真实内容也过（闸不是只会抛）', () => {
        expect(spiritRootGateErrors(legalRoleInit())).toEqual([]);
        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        content.load();
        expect(spiritRootGateErrors(content.dataset('role_init'))).toEqual([]);
    });

    test.each([
        ['概率表里有没声明过的灵根名（那一档谁也抽不到）', cfg => { cfg.spiritRootProbabilities['雷]拼错'] = 0.1; }, /雷\]拼错/],
        ['加成表里有没声明过的灵根名（加成永远用不上）', cfg => { cfg.spiritRootBonuses['星'] = { atk: 1 }; }, /spiritRootBonuses 含未声明的灵根名: 星/],
        ['概率值不是正数（整池权重会 NaN）', cfg => { cfg.spiritRootProbabilities['金'] = '零'; }, /spiritRootProbabilities\.金 不是正数/],
        ['声明了灵根却没给概率、也没标 roll_enabled:false', cfg => { cfg.spirit_roots.push({ id: 'star', name: '星', type: 'star' }); cfg.spiritRootBonuses['星'] = { atk: 1 }; }, /星 在 spirit_roots 里声明了/],
        ['roll_enabled:false 与概率同时给（到底开不开）', cfg => { cfg.spiritRootProbabilities['雷'] = 0.1; }, /雷 同时标了 roll_enabled:false 与概率/],
        ['一条可抽的灵根都没有', cfg => { cfg.spirit_roots.forEach(r => { r.roll_enabled = false; }); }, /一条"可抽"的灵根都没有/],
        ['加成用了注册表里没有的属性键', cfg => { cfg.spiritRootBonuses['金'] = { atk_k: 4 }; }, /spiritRootBonuses\.金 用了注册表里没有的属性键：atk_k=4/],
        ['声明了灵根却没配加成条目（抽到等于白抽）', cfg => { delete cfg.spiritRootBonuses['木']; }, /灵根 木 在 spiritRootBonuses 里没有加成条目/],
        ['概率/加成表里的 _comment 不算条目（否则说明文字自己会被判成坏数据）', cfg => {
            cfg.spiritRootProbabilities._comment = '说明'; cfg.spiritRootBonuses._comment = '说明';
        }, null]
    ])('%s', (_label, mutate, expected) => {
        const cfg = legalRoleInit();
        mutate(cfg);
        const errors = spiritRootGateErrors(cfg);
        if (!expected) {
            expect(errors).toEqual([]);
            return;
        }
        const text = errors.join('\n');
        expect(text).toMatch(expected);
        // 每条坏例只该被点名一次：同一条规则被两条 error 重复报，说明规则之间没正交
        expect(errors.filter(line => expected.test(line))).toHaveLength(1);
    });

    test('控制跑：坏例若真的没被点名，这份清单就会红（检测器不是空跑）', () => {
        const cfg = legalRoleInit();
        cfg.spiritRootProbabilities['金'] = '零';
        const errors = spiritRootGateErrors(cfg);
        expect(errors.length).toBe(1);
        expect(spiritRootGateErrors({ spirit_roots: [] })).toEqual([]);   // 灵根表整个读不到时不拦，交给 SpiritRoot 降级
    });
});

describe('资料片只写 JSON 就加一种灵根（端到端，三个消费点零改代码）', () => {
    test('三件套登记成集合：新增灵根、概率、加成都有可扩展的落点', () => {
        expect(DATASET_SPECS.role_init.collections).toMatchObject({
            spirit_roots: { key: 'id' },
            spiritRootProbabilities: { map: true, optional: true },
            spiritRootBonuses: { map: true, optional: true }
        });
    });

    test('片里 add 一档星灵根：合并视图有它、抽卡池有它、基础那几条一点没坏', () => {
        const content = loadWithPack({
            'role_init__spirit_roots.json': ROOT_ENTRY,
            'role_init__spiritRootProbabilities.json': PROB_ENTRY,
            'role_init__spiritRootBonuses.json': BONUS_ENTRY
        });
        const merged = content.dataset('role_init');
        const names = merged.spirit_roots.map(r => r.name);
        expect(names).toContain('星');
        expect(names).toEqual(expect.arrayContaining(['金', '木', '水', '火', '土']));
        // 资料片写的 {id,value} 与基础的裸数字混在一起也算得对：总权 = 1 + 0.05
        const roll = rollSpiritRoot(merged, 0.999);
        expect(roll.pool).toContain('星');
        expect(roll.totalWeight).toBeCloseTo(1.05, 6);
        expect(roll.name).toBe('星');
        expect(rollSpiritRoot(merged, 0.01).name).toBe('金');
    });

    test('新灵根零代码进属性：provider 的 collect 直接把加成算进去（面板与战斗共用这一条）', async () => {
        const content = loadWithPack({
            'role_init__spirit_roots.json': ROOT_ENTRY,
            'role_init__spiritRootProbabilities.json': PROB_ENTRY,
            'role_init__spiritRootBonuses.json': BONUS_ENTRY
        });
        const merged = content.dataset('role_init');
        const loader = { getConfig: name => (name === 'role_init' ? merged : {}) };
        const provider = buildProviders(statRegistry, loader).find(p => p.id === 'spirit_root');
        expect(provider).toBeTruthy();
        // PlayerService 写进 players.spirit_roots 的就是这个形状（`${name}灵根` → {level, affinity}）
        const player = { spirit_roots: { '星灵根': { level: '基础', affinity: 90 } } };
        const collected = await provider.collect({ player, attributes: {} });
        expect(collected).toMatchObject({ atk: 3, crit_rate: 0.01 });
        expect(resolveSpiritRoot(player, merged)).toMatchObject({ type: 'star', name: '星' });
        expect(spiritRootTypes(player, merged)).toEqual(['star']);
        expect(spiritRootBonus(player, merged)).toMatchObject({ atk: 3 });
        // 老形状不能因为这次改动坏掉
        expect(spiritRootTypes({ spirit_roots: { type: 'thunder' } }, merged)).toEqual(['thunder']);
        expect(resolveSpiritRoot({ spirit_roots: { '火灵根': { affinity: 85 } } }, merged))
            .toMatchObject({ type: 'fire', value: 85 });
    });

    test('新灵根的 type 自动进功法元素词表（片里用 element:"star" 的功法能装起来）', () => {
        expect(() => loadWithPack({
            'role_init__spirit_roots.json': ROOT_ENTRY,
            'role_init__spiritRootProbabilities.json': PROB_ENTRY,
            'role_init__spiritRootBonuses.json': BONUS_ENTRY,
            'technique_data__techniques.json': {
                dataset: 'technique_data', into: 'techniques',
                add: [{ id: 'star_light', name: '星光诀', grade: 'huang', element: 'star', bonuses: { atk: 2 } }]
            }
        })).not.toThrow();
    });

    test('控制跑：只加工法不加灵根 → 启动就抛并点名 star（证明上面那条不是空测）', () => {
        expect(() => loadWithPack({
            'technique_data__techniques.json': {
                dataset: 'technique_data', into: 'techniques',
                add: [{ id: 'star_light', name: '星光诀', grade: 'huang', element: 'star', bonuses: { atk: 2 } }]
            }
        })).toThrow(/techniques.star_light="star"/);
    });

    test('控制跑：片加了灵根却漏概率也漏 roll_enabled → 启动就抛（闸读的是合并视图，不是 config 原件）', () => {
        expect(() => loadWithPack({
            'role_init__spirit_roots.json': ROOT_ENTRY,
            'role_init__spiritRootBonuses.json': BONUS_ENTRY
        })).toThrow(/星 在 spirit_roots 里声明了/);
        // 只漏加成也一样
        expect(() => loadWithPack({
            'role_init__spirit_roots.json': ROOT_ENTRY,
            'role_init__spiritRootProbabilities.json': PROB_ENTRY
        })).toThrow(/灵根 星 在 spiritRootBonuses 里没有加成条目/);
        // 概率键写成英文 id（星 vs star）也会被点名：抽卡按中文 name 取键
        expect(() => loadWithPack({
            'role_init__spirit_roots.json': ROOT_ENTRY,
            'role_init__spiritRootProbabilities.json': { dataset: 'role_init', into: 'spiritRootProbabilities', add: [{ id: 'star', value: 0.05 }] },
            'role_init__spiritRootBonuses.json': BONUS_ENTRY
        })).toThrow(/spiritRootProbabilities 含未声明的灵根名: star/);
    });

    test('回滚安全：临时夹具不落到仓库 packs 目录，真实视图仍只有八档', () => {
        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        content.load();
        const names = content.dataset('role_init').spirit_roots.map(r => r.name);
        expect(names).not.toContain('星');
        expect(fs.existsSync(path.join(REAL_PACK_DIR, 'fixture_spiritroot'))).toBe(false);
    });
});

/**
 * 相克表这一腿（任务 #30）：新灵根不能只会"契合"，相克也得是数据。
 * 登记成集合之前，TechniqueService 读的是 `Array.isArray(conflicts[root])` —— 资料片就算把这条
 * 写进 technique_data，也会因为这个形状判断被静默丢掉：表现是"星灵根跟谁都不冲"，
 * 而启动期什么也不说（契合照常生效，看起来整条机制是好的）。
 */
describe('资料片给自己新增的灵根配一条相克（contentList 兼容两种形状）', () => {
    const CONFLICT_ENTRY = {
        dataset: 'technique_data', into: 'element_match.conflicts',
        add: [{ id: 'star', counters: ['metal'] }]
    };
    const ROOT_FILES = {
        'role_init__spirit_roots.json': ROOT_ENTRY,
        'role_init__spiritRootProbabilities.json': PROB_ENTRY,
        'role_init__spiritRootBonuses.json': BONUS_ENTRY
    };
    const mergedConflictOf = (content, key) => content.dataset('technique_data').element_match.conflicts[key];

    /** 直接跑相克闸（合并视图的两张表都从外面给） */
    function elementMatchGateErrors(roleInit, techniqueData) {
        const stub = Object.create(ContentRegistry.prototype);
        stub.datasets = new Map([['role_init', roleInit], ['technique_data', techniqueData]]);
        try {
            ContentRegistry.prototype._validateElementMatch.call(stub);
            return [];
        } catch (error) {
            return String(error.message).split('\n').map(l => l.trim()).filter(l => l && !/校验失败/.test(l));
        }
    }

    test('相克表登记成集合（不然资料片根本写不进来）', () => {
        expect(DATASET_SPECS.technique_data.collections['element_match.conflicts'])
            .toEqual({ map: true, optional: true });
    });

    test('contentList 认裸数组与资料片对象两种形状；Array.isArray 只认前者（这就是那个洞）', () => {
        expect(contentList(['metal'])).toEqual(['metal']);
        expect(contentList({ id: 'star', counters: ['metal'] })).toEqual(['metal']);
        expect(contentList('metal')).toEqual(['metal']);
        expect(contentList(undefined)).toEqual([]);
        expect(Array.isArray({ id: 'star', counters: ['metal'] })).toBe(false);
    });

    test('片里补一条 star→metal，TechniqueService 当场认得（期望的系数从生效配置现读现算）', () => {
        const content = loadWithPack({ ...ROOT_FILES, 'technique_data__element_match__conflicts.json': CONFLICT_ENTRY });
        const merged = content.dataset('technique_data');
        const match = merged.element_match;
        const penalty = 1 - Number(match.conflict_penalty_pct) / 100;
        const bonus = 1 + Number(match.match_bonus_pct) / 100;
        // 合并视图里：基础那几条仍是数组，片里那条是对象（两种形状并存是常态，不是要修的事）
        expect(contentList(merged.element_match.conflicts.fire)).toEqual(['metal']);
        expect(Array.isArray(merged.element_match.conflicts.star)).toBe(false);

        const saved = TechniqueService.configLoader;
        TechniqueService.initialize({ getConfig: name => content.dataset(name) });
        try {
            const starPlayer = { spirit_roots: { '星灵根': { level: '基础', affinity: 90 } } };
            expect(TechniqueService.getElementMultiplier(starPlayer, 'metal')).toBeCloseTo(penalty, 10);
            expect(TechniqueService.getElementMultiplier(starPlayer, 'star')).toBeCloseTo(bonus, 10);
            expect(TechniqueService.getElementMultiplier(starPlayer, 'wood')).toBe(1.0);   // 只克 metal
            // 老配置（数组形状）不能被这次改动弄坏：火克金
            expect(TechniqueService.getElementMultiplier({ spirit_roots: { type: 'fire' } }, 'metal'))
                .toBeCloseTo(penalty, 10);
        } finally {
            TechniqueService.initialize(saved);
        }
    });

    test('控制跑：不给相克表加那条，星灵根就只能契合不能相克（证明上面那条不是空测）', () => {
        const content = loadWithPack(ROOT_FILES);
        const saved = TechniqueService.configLoader;
        TechniqueService.initialize({ getConfig: name => content.dataset(name) });
        try {
            const starPlayer = { spirit_roots: { '星灵根': { level: '基础', affinity: 90 } } };
            expect(TechniqueService.getElementMultiplier(starPlayer, 'metal')).toBe(1.0);
            expect(mergedConflictOf(content, 'star')).toBeUndefined();
        } finally {
            TechniqueService.initialize(saved);
        }
    });

    test.each([
        ['键写成没声明过的灵根 type', { conflicts: { star: ['metal'], not_a_root: ['wood'] } }, /not_a_root/],
        ['值写成不存在的属性', { conflicts: { star: ['gold'] } }, /conflicts\.star 克的 "gold"/],
        ['值为空列表（配了等于没配）', { conflicts: { star: [] } }, /conflicts\.star 的值是空列表/],
        ['片写成了认不出的形状', { conflicts: { star: { id: 'star' } } }, /conflicts\.star 的值是空列表|认不出的形状/],
        ['_comment 与"键值都是声明过的 type"的条目都合法', { conflicts: { metal: ['wood'], _comment: '说明' } }, null]
    ])('启动闸：%s', (_label, techniqueFragment, expected) => {
        const roleInit = legalRoleInit();
        roleInit.spirit_roots.push({ id: 'star', name: '星', type: 'star', roll_enabled: false });
        const errors = elementMatchGateErrors(roleInit, { element_match: techniqueFragment });
        if (!expected) {
            expect(errors).toEqual([]);
            return;
        }
        expect(errors.join('\n')).toMatch(expected);
    });

    test('控制跑：真实视图过得了这道闸（闸不是只会抛），且现网没有 star 这条', () => {
        const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        content.load();
        expect(elementMatchGateErrors(content.dataset('role_init'), content.dataset('technique_data'))).toEqual([]);
        expect(mergedConflictOf(content, 'star')).toBeUndefined();
    });
});
