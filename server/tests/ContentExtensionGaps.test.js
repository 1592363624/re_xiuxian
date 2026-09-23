/**
 * 「数据集登记了」≠「里面每一块都能被资料片扩展」（2026-09-22 第十五轮，任务 #41）
 *
 * 已有的 `ContentRegistration` 只判"整份数据集要么登记、要么带理由豁免"。盲区是**登记了一半**：
 * `DATASET_SPECS.<ds>.collections` 没点到的区块走 passthrough，资料片写进去会被"没有该集合"挡下。
 * 这一族仓里已经撞过四次，每次都是人偶然撞上：灵兽 `settings`（战力权重）、阵法两张标签表、
 * 装备槽位、以及本轮的功法品阶 `grades` —— 前三次各留下一个真缺陷，第四次是刚补的。
 * 所以这一轮不再靠撞：检测器 + 台账 + 棘轮进内容层（`game/content/extensionGaps.js`），
 * 报告（`npm run content:report`）与这份测试判的是同一个函数。
 *
 * 本轮同时开出两格口子，各配启动闸：
 *   · `technique_data.grades`：品阶表不能扩，而 `getRequiredProficiency` 查不到品阶时返回 Infinity
 *     → 资料片写一个新 grade 就得到一部一层都突破不了的功法（还有 grade_name/grade_color 两个空字段）；
 *   · `fishing_data.fish_pools` + `rare_material_pools`：渔场 `fish_pool` 是外键，
 *     `FishingService:906` 读 `poolConfig.empty_weight` **没有兜底**（指错=玩家起竿时 500），
 *     `rare_material_pool` 那一头有兜底（指错=永远不出稀有材料，不响）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const {
    unregisteredContentTables, summarizeGaps, shapeOfList, shapeOfTable,
    looksLikePointer, coveredByCollection, identityValues,
    NOT_A_COLLECTION, GAP_EXITS
} = require('../game/content/extensionGaps');
const { extensionLedger } = require('../game/content/contentHealth');
const { serverRoot, loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');

const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_extension_gap_fixture');

/** 造一份临时 packs 目录（不碰仓库）：只放这支夹具片，基础配置仍从 config/ 读 */
function loadWithFixture(files, mutateSpec) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'fixture_ext'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_ext/pack.json'), JSON.stringify({
        id: 'fixture_ext', name: '夹具·扩展口子', version: '0.0.1', priority: 999, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_ext', name), JSON.stringify(body, null, 4));
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

const gradeEntry = {
    id: 'moshen', name: '魔阶', order: 6, color: '#8e24aa',
    max_layer: 18, attr_coefficient: 9, breakthrough_base_rate: 0.2, proficiency_per_layer: 8000
};
const newGradeTechnique = {
    id: 'zz_probe_scripture', name: '探针·魔阶功', grade: 'moshen', element: 'metal',
    bonuses: { atk: 10 }, max_level: 10
};
const newPool = {
    id: 'zz_probe_pool', empty_weight: 10,
    fishes: [{ id: 'zz_probe_fish', name: '探针鱼', quality: 'rare', weight: 50, min_kg: 1, max_kg: 2 }]
};
const newPond = {
    id: 'zz_probe_pond', name: '探针·幽潭', required_skill_level: 1,
    required_bait: 'diworm', fish_pool: 'zz_probe_pool', rare_material_pool: null, is_advanced: false
};

/** 合成一份"内容视图"给检测器用：只需要 datasets 这个 Map，不碰真配置 */
function fakeContent(datasets) {
    return { datasets: new Map(Object.entries(datasets)) };
}

afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe('检测器：什么形状算"一张能被资料片扩的表"', () => {
    test('列表要有身份字段；表要多数值是对象且字段对得上', () => {
        expect(shapeOfList([{ id: 'a', x: 1 }, { id: 'b', x: 2 }]).kind).toBe('list');
        expect(shapeOfList([{ x: 1 }, { x: 2 }])).toBeNull();          // 纯数值数组不是条目表
        expect(shapeOfTable({ a: { p: 1, q: 2 }, b: { p: 3, q: 4 } }).kind).toBe('table');
        expect(shapeOfTable({ a: 1, b: 2 })).toBeNull();               // 参数字典
        expect(shapeOfTable({ a: { p: 1 }, b: { q: 2 } })).toBeNull(); // 只有一个共有字段：不是同一族条目
    });

    test('_comment 与 __content_origin 都不算一条内容（否则会把说明当条目要求字段）', () => {
        expect(identityValues([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b']);
        expect(shapeOfTable({ _comment: '说明', a: { p: 1, q: 2 }, b: { p: 3, q: 4 } })).toMatchObject({ entries: 2 });
    });

    test('已登记集合的内部与父壳都不报；登记本身当然也不报', () => {
        const reg = ['cave.facilities', 'cave.garden.seeds'];
        expect(coveredByCollection(reg, 'cave.facilities')).toBe(true);
        expect(coveredByCollection(reg, 'cave.facilities.any.upgrade_costs')).toBe(true);
        expect(coveredByCollection(reg, 'cave.garden.plot_unlock_costs')).toBe(false);
    });

    test('指针判据按"字段名 ↔ 表名"配对，不按值撞键（值撞键曾把 skill_min_level 判成引用 level_table）', () => {
        expect(looksLikePointer('fish_pool', 'fish_pools')).toBe(true);
        expect(looksLikePointer('rarity', 'rarity_config')).toBe(true);
        expect(looksLikePointer('grade', 'grades')).toBe(true);
        expect(looksLikePointer('difficulty', 'fish_pools')).toBe(false);
        expect(looksLikePointer('required_bait', 'baits')).toBe(true);
    });

    /**
     * 合成一份"数据集 + 登记"喂给检测器：`DATASET_SPECS` 是唯一权威，所以合成数据集必须临时登记，
     * 检测器才会去看它（这也顺手证明了检测器真的按 DATASET_SPECS 走，而不是手里攥着一份清单）。
     */
    function withProbeSpec(collections, contentData, run) {
        DATASET_SPECS.zz_probe_data = { collections };
        try {
            return run(fakeContent({ zz_probe_data: contentData }));
        } finally {
            delete DATASET_SPECS.zz_probe_data;
        }
    }

    test('外键命中就点名是哪个字段；数字键表一律不判指针', () => {
        const rows = withProbeSpec({ things: { map: true } }, {
            things: { t1: { name: 'A', zone: 'deep', level: 1 }, t2: { name: 'B', zone: 'shallow', level: 2 } },
            zones: { deep: { cap: 1, rate: 2 }, shallow: { cap: 3, rate: 4 } },
            levels: { 1: { exp: 1, bonus: 2 }, 2: { exp: 3, bonus: 4 } }
        }, content => unregisteredContentTables(content));
        const byAt = new Map(rows.map(r => [r.at, r]));
        expect(byAt.has('things')).toBe(false);           // 已登记集合本身不报
        expect(byAt.get('zones').pointers).toEqual([{ field: 'zone', entries: 2, values: ['deep', 'shallow'] }]);
        // 数字键表：`level: 1` 与 levels 的键 1 撞上了，但那是一档门槛值不是外键
        expect(byAt.get('levels').numericKeyed).toBe(true);
        expect(byAt.get('levels').pointers).toEqual([]);
        expect(byAt.get('levels').entries).toBe(2);
    });

    test('控制跑：把已登记的集合从 DATASET_SPECS 里摘掉，检测器必须立刻把它列成缺口', () => {
        const before = summarizeGaps(loadRealContent());
        expect(before.open.map(r => r.id)).not.toContain('technique_data.grades');
        const spec = DATASET_SPECS.technique_data.collections;
        delete spec.grades;
        try {
            const during = summarizeGaps(loadRealContent());
            const row = during.open.find(r => r.id === 'technique_data.grades');
            expect(row).toBeTruthy();
            expect(row.entries).toBeGreaterThanOrEqual(5);
            expect(during.counts.registeredCollections).toBe(before.counts.registeredCollections - 1);
        } finally {
            spec.grades = { map: true };
        }
        // 还原要真的还原：检测器与启动闸读的是同一个对象引用
        expect(DATASET_SPECS.technique_data.collections.grades).toEqual({ map: true });
        expect(summarizeGaps(loadRealContent()).open.map(r => r.id)).not.toContain('technique_data.grades');
    });
});

describe('台账：豁免必须带理由，理由过期会反过来红', () => {
    test('每条豁免都点名"它是什么、为什么 pack 不该动它"（薄结论不算结论）', () => {
        const thin = Object.entries(NOT_A_COLLECTION).filter(([, r]) => String(r).length < 30).map(([k]) => k);
        expect(thin).toEqual([]);
        const exitsThin = Object.entries(GAP_EXITS).filter(([, r]) => String(r).length < 30).map(([k]) => k);
        expect(exitsThin).toEqual([]);
    });

    test('豁免与出口都只写"检测器现在还看得见"的那些（过期结论比没有结论更坏）', () => {
        const g = summarizeGaps(loadRealContent());
        expect(g.stale).toEqual([]);
        expect(g.staleExits).toEqual([]);
        // 反证：塞一条指向不存在区块的豁免，stale 必须点名它
        NOT_A_COLLECTION['zz_probe_not_a_block'] = '这是一条测试塞进去的假豁免，长度够长以免被薄结论判据拦下';
        try {
            expect(summarizeGaps(loadRealContent()).stale).toContain('zz_probe_not_a_block');
        } finally {
            delete NOT_A_COLLECTION['zz_probe_not_a_block'];
        }
        expect(summarizeGaps(loadRealContent()).stale).toEqual([]);
    });

    test('棘轮：缺口只许变小、已登记集合只许变多（基线是本轮实测的数）', () => {
        // 基线是实测值。09-23 上午 36 → 34（灵兽稀有度登记成集合）→ 25（赌石一次收 9 行）
        // → 20（道侣/侍妾：心劫选项词表 + 远航模式词表 + 远航奖励池）。
        // 这一格顺带纠正了一条**写错的豁免**：`companion_data.heart_tribulation.options` 曾被登记成
        // "扩它=改玩法本身（需设计）"，实测真正的障碍只是路由与服务各抄了一份字面数组 + 界面自己抄了名字表
        // —— 两处改成读内容之后零代码可扩。豁免写错比没写更坏：它让检测器闭嘴，而缺口还在。
        const OPEN_BASELINE = 20;
        const COLLECTIONS_BASELINE = 109;
        const g = summarizeGaps(loadRealContent());
        expect(g.counts.open).toBeLessThanOrEqual(OPEN_BASELINE);
        expect(g.counts.registeredCollections).toBeGreaterThanOrEqual(COLLECTIONS_BASELINE);
        expect(g.counts.candidates).toBe(g.counts.open + g.counts.exempted);
        if (g.counts.open < OPEN_BASELINE) {
            console.log(`扩展缺口比基线少：${OPEN_BASELINE} → ${g.counts.open}（把基线改成这个数，别让它虚高）`);
        }
    });
});

describe('报告与本账同源（同一批判据，两处消费）', () => {
    test('extension 板块的每个数字都由 summarizeGaps 现算', () => {
        const content = loadRealContent();
        const g = summarizeGaps(content);
        const section = extensionLedger(content);
        expect(section.open).toBe(g.counts.open);
        expect(section.exempted).toBe(g.counts.exempted);
        expect(section.candidates).toBe(g.counts.candidates);
        expect(section.registeredCollections).toBe(g.counts.registeredCollections);
        expect(section.withPointers).toBe(g.counts.withPointers);
        expect(section.pointers.map(p => p.id)).toEqual(g.open.filter(r => r.pointerEntries > 0).map(r => r.id));
        expect(section.evidence).toContain('extensionGaps');
    });

    test('有指针的缺口必须点名是哪个字段，并且报告与判据同形', () => {
        const content = loadRealContent();
        const g = summarizeGaps(content);
        const section = extensionLedger(content);
        expect(section.pointers).toEqual(g.open.filter(r => r.pointerEntries > 0)
            .map(r => ({ id: r.id, entries: r.entries, via: r.pointers.map(p => `${p.field}×${p.entries}`), exit: r.exit })));
        for (const p of section.pointers) {
            expect(p.via.length).toBeGreaterThan(0);
            if (p.exit) expect(String(p.exit).length).toBeGreaterThanOrEqual(40);
        }
        // 机制本身由上面 `zones / levels` 那支合成用例自证，所以现网命中数会随内容变化也不空转。
        // 这里钉一个已知事实：曾经唯一命中的 `spirit_beast_data.rarity_config` 已登记成 map 集合
        // （档名与颜色由 `game/stats/beastRarity.js` 下发），它再退回缺口的话由 staleExits 那条判据管。
        expect(g.open.map(r => r.id)).not.toContain('spirit_beast_data.rarity_config');
        expect(DATASET_SPECS.spirit_beast_data.collections.rarity_config).toBeTruthy();
    });
});

describe('本轮真开的两格口子：加一档内容不用改代码', () => {
    test('品阶表：资料片加一档 + 一部用它的新功法，装配通过且新档查得到', () => {
        const content = loadWithFixture({
            'technique_data__grades.json': { into: 'grades', add: [gradeEntry] },
            'technique_data.json': { into: 'techniques', add: [newGradeTechnique] }
        });
        const data = content.dataset('technique_data');
        expect(data.grades.moshen.name).toBe('魔阶');
        expect(data.grades.moshen.__content_origin).toBe('fixture_ext');   // 记在资料片名下，基础表没被动过
        expect(data.techniques.zz_probe_scripture.grade).toBe('moshen');
        // 消费端读得到（这就是 Infinity 那条兜底以前会踩空的地方）
        const TechniqueService = require('../game/services/TechniqueService');
        TechniqueService.initialize({ getConfig: () => data });
        expect(TechniqueService.getGradeConfig('moshen').max_layer).toBe(18);
        expect(TechniqueService.getRequiredProficiency('moshen', 1)).toBe(8000);   // 不是 Infinity
    });

    test('控制跑：把 grades 的登记摘掉，同一份资料片装不上（能扩来自登记，不是碰巧）', () => {
        const files = {
            'technique_data__grades.json': { into: 'grades', add: [gradeEntry] },
            'technique_data.json': { into: 'techniques', add: [newGradeTechnique] }
        };
        expect(() => loadWithFixture(files, () => {
            const spec = DATASET_SPECS.technique_data.collections;
            const saved = spec.grades;
            delete spec.grades;
            return () => { spec.grades = saved; };
        })).toThrow(/grades/);
    });

    test('控制跑：新功法指向一个表里没有的品阶 → 启动闸抛，并把后果说清', () => {
        let message = '';
        try {
            loadWithFixture({
                'technique_data.json': { into: 'techniques', add: [{ ...newGradeTechnique, grade: 'zz_not_a_grade' }] }
            });
        } catch (err) { message = String(err.message); }
        expect(message).toContain('zz_not_a_grade');
        expect(message).toContain('Infinity');           // 病名：熟练度阈值无限 → 一层都突破不了
        expect(message).toContain('zz_probe_scripture');  // 点名是哪部功法
    });

    test('控制跑：品阶缺一档被读到的字段就抛（每个缺失都对应一条静默兜底）', () => {
        const missing = { ...gradeEntry };
        delete missing.proficiency_per_layer;
        let message = '';
        try {
            loadWithFixture({ 'technique_data__grades.json': { into: 'grades', add: [missing] } });
        } catch (err) { message = String(err.message); }
        expect(message).toContain('grades.moshen.proficiency_per_layer');
        expect(message).toContain('|| 100');
    });

    test('渔池与鱼：资料片加一口新池 + 一个引用它的渔场，装配通过', () => {
        const content = loadWithFixture({
            'fishing_data__fish_pools.json': { into: 'fish_pools', add: [newPool] },
            'fishing_data__ponds.json': { into: 'ponds', add: [newPond] }
        });
        const data = content.dataset('fishing_data');
        expect(data.fish_pools.zz_probe_pool.fishes[0].id).toBe('zz_probe_fish');
        expect(data.ponds.zz_probe_pond.fish_pool).toBe('zz_probe_pool');
        // FishingService 起竿那一行读的就是这个：以前指不到新池，现在能
        expect(data.fish_pools[data.ponds.zz_probe_pond.fish_pool].empty_weight).toBe(10);
    });

    test('控制跑：渔场指一个不存在的鱼池 → 抛，并点名"玩家起竿时 500"', () => {
        let message = '';
        try {
            loadWithFixture({
                'fishing_data__ponds.json': { into: 'ponds', add: [{ ...newPond, fish_pool: 'zz_no_such_pool' }] }
            });
        } catch (err) { message = String(err.message); }
        expect(message).toContain('zz_no_such_pool');
        expect(message).toContain('TypeError');
    });

    test('控制跑：稀有材料池指不到 → 抛（那一头有兜底，所以不响的那条更要拦）', () => {
        let message = '';
        try {
            loadWithFixture({
                'fishing_data__ponds.json': { into: 'ponds', add: [{ ...newPond, rare_material_pool: 'zz_no_such_rare' }] }
            });
        } catch (err) { message = String(err.message); }
        expect(message).toContain('zz_no_such_rare');
        expect(message).toContain('永远不出稀有材料');
    });

    test('控制跑：空鱼池 / 权重为 0 的鱼 / empty_weight 越界，各自都抛', () => {
        const cases = [
            [{ ...newPool, fishes: [] }, /fishes 是空的/],
            [{ ...newPool, fishes: [{ id: 'zz_zero', weight: 0 }] }, /weight 不是正数/],
            [{ ...newPool, empty_weight: 250 }, /不是 0~100 的百分比/]
        ];
        for (const [pool, expectRe] of cases) {
            let message = '';
            try {
                loadWithFixture({
                    'fishing_data__fish_pools.json': { into: 'fish_pools', add: [pool] }
                });
            } catch (err) { message = String(err.message); }
            expect(message).toMatch(expectRe);
        }
    });

    test('防空转：现网四口渔池与全部渔场本来就对得上（所以硬拦零爆炸半径）', () => {
        const data = loadRealContent().dataset('fishing_data');
        const ponds = Object.keys(data.ponds).filter(k => !k.startsWith('_'));
        const pools = Object.keys(data.fish_pools).filter(k => !k.startsWith('_'));
        expect(ponds.length).toBeGreaterThanOrEqual(4);
        expect(pools.length).toBeGreaterThanOrEqual(4);
        for (const id of ponds) expect(pools).toContain(data.ponds[id].fish_pool);
    });

    test('控制跑：两张表都登记成 optional，但"基础有、合并视图被抹空"仍然响（optional ≠ 放行缺表）', () => {
        const content = loadRealContent();
        const tech = content.datasets.get('technique_data');
        const savedGrades = tech.grades;
        tech.grades = {};
        try {
            expect(() => content._validateTechniqueGrades()).toThrow(/grades 品阶表在基础配置里有/);
        } finally {
            tech.grades = savedGrades;
        }
        expect(() => content._validateTechniqueGrades()).not.toThrow();

        const fishing = content.datasets.get('fishing_data');
        const savedPools = fishing.fish_pools;
        fishing.fish_pools = {};
        try {
            expect(() => content._validateFishingPonds()).toThrow(/fish_pools 渔获表在基础配置里有/);
        } finally {
            fishing.fish_pools = savedPools;
        }
        expect(() => content._validateFishingPonds()).not.toThrow();
    });

    test('服务读的是合并视图：资料片那口新池真能被 _rollFish 抽到（不是只合并进了 JSON）', () => {
        // _rollFish 比较鱼品质高低问的是全局 ConfigLoader 里的 item_qualities 词表（§26 收口后的形状）。
        // 应用启动时由 infrastructure 把合并视图灌进它（`setMergedConfig`），测试里按同一扇门装一次。
        const globalLoader = require('../modules/infrastructure/ConfigLoader');
        const balanceWasLoaded = globalLoader.hasConfig('game_balance');
        const balanceWas = balanceWasLoaded ? globalLoader.getConfig('game_balance') : null;
        globalLoader.setMergedConfig('game_balance', loadRealContent().dataset('game_balance'));
        try {
            const content = loadWithFixture({
                'fishing_data__fish_pools.json': { into: 'fish_pools', add: [newPool] },
                'fishing_data__ponds.json': { into: 'ponds', add: [newPond] }
            });
            const FishingService = require('../game/services/FishingService');
            // 真实 loader 形状：fishing_data 取夹具那份合并视图，其余（品质词表）仍走全局那份
            FishingService.initialize(makeRealConfigLoader(content));
            const realRandom = Math.random;
            const drawAt = poolKey => {
                Math.random = () => 0;               // 判定式是 roll < ratio：0 对任何正权重都成立
                try { return FishingService._rollFish(poolKey, 1, 0, 1, 0); }
                finally { Math.random = realRandom; }
            };
            expect(drawAt('zz_probe_pool').id).toBe('zz_probe_fish');
            // 服务确实读的是合并视图（不是 require 了基础文件）：资料片那口池在它的 _config 里
            expect(FishingService._config.fish_pools.zz_probe_pool).toBeTruthy();

            // 控制跑：把服务实际看到的那一份池子抹掉 → 同一次抽取必须变成 null
            const pools = FishingService._config.fish_pools;
            const savedPool = pools.zz_probe_pool;
            delete pools.zz_probe_pool;
            try { expect(drawAt('zz_probe_pool')).toBeNull(); }
            finally { pools.zz_probe_pool = savedPool; }
            expect(drawAt('zz_probe_pool').id).toBe('zz_probe_fish');   // 还原要真的还原
        } finally {
            if (balanceWasLoaded) globalLoader.setMergedConfig('game_balance', balanceWas);
        }
    });

    test('_baseEntries 是这两道闸的"这份内容用不用这个机制"开关（合成夹具因此不会被误判）', () => {
        const real = loadRealContent();
        expect(real._baseEntries('technique_data', 'grades').sort()).toEqual(['di', 'huang', 'shen', 'tian', 'xuan']);
        expect(real._baseEntries('fishing_data', 'fish_pools').sort()).toEqual(['common', 'medium', 'rare', 'sea_rare']);
        expect(real._baseEntries('technique_data', 'no_such_collection')).toBeNull();
        // 桩对象（只 set 了 datasets、没有 configPath）= 不是从磁盘装的，返回 null 表示"不判"
        const stub = Object.create(ContentRegistry.prototype);
        stub.datasets = new Map([['technique_data', { techniques: { t: { id: 't', grade: 'nowhere' } } }]]);
        expect(stub._baseEntries('technique_data', 'grades')).toBeNull();
        // 于是"只塞 techniques 的合成夹具"不会被判成品阶坏了 —— 本轮实测：写成必填时一次红 7 条
        expect(() => stub._validateTechniqueGrades()).not.toThrow();
        expect(() => stub._validateFishingPonds()).not.toThrow();
    });
});
