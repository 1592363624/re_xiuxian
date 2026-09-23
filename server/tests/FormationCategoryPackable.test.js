/**
 * 「阵法的流派/品级名字表能不能被资料片扩展」（2026-09-21）
 *
 * 顺着第 16 节（灵兽战力权重表）那条路找到的同类：`FormationService.formationCategories()`
 * 是 `Object.keys(cfg.global.category_display_names)` —— **这张表的键就是合法流派的全集**，
 * 路由拿它挡参数，列表/详情拿它出中文名。而 `formation_data` 以前只登记了 `formations` 一个集合，
 * 于是资料片能加阵法、加不了新的一档流派或品级 —— 服务注释还写着"以内容为准"，代码却做不到。
 *
 * 这一片要证明四件事，缺一条就红：
 *   1. 两张名字表登记成集合（片里 add 自己那一档就能生效）；
 *   2. 加了之后 `formationCategories()` 认它，`getConfig()` 下发的仍是字符串
 *      （资料片条目是 `{id,label}` 对象，原样透出前端就印 [object Object]）；
 *   3. 读取端一律过 `contentLabel`，不许再有"直接取表 || 原始键"的写法；
 *   4. `global.counter_relationships` **刻意不登记**：它的值是"流派→流派"的引用而不是标签，
 *      登记成集合只会让片里写的引用变成对象、比较处永远不相等（新的"配了不生效"）。
 *      所以片要写它会当场被"未登记集合"挡下，加新流派于是克性中性（与灵兽雷元素同一处置）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS, contentLabel } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const FormationService = require('../game/services/FormationService');
const { serverRoot } = require('./helpers/realContent');

const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_formation_pack_fixture');
const CATEGORY_ENTRY = {
    dataset: 'formation_data', into: 'global.category_display_names',
    add: [{ id: 'blood', label: '血煞阵', color: 'rose' }]
};

/** 造一份临时 packs 目录（不碰仓库）：只放这支夹具片，基础配置仍从 config/ 读 */
function loadWithFixture(files) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'fixture_formation'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_formation/pack.json'), JSON.stringify({
        id: 'fixture_formation', name: '夹具·阵法流派扩展', version: '0.0.1', priority: 900, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_formation', name), JSON.stringify(body, null, 4));
    }
    const content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'), packDir: FIXTURE_DIR, statRegistry
    });
    content.load();
    return content.dataset('formation_data');
}

afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe('阵法名字表随资料片扩展', () => {
    test('两张名字表登记成集合；相克引用表刻意不登记', () => {
        const collections = DATASET_SPECS.formation_data.collections;
        expect(collections['global.category_display_names']).toEqual({ map: true });
        expect(collections['global.grade_display_names']).toEqual({ map: true });
        expect(collections['global.counter_relationships']).toBeUndefined();
    });

    test('资料片加一档流派：合法全集认它（formationCategories 是路由参数的依据）', () => {
        const data = loadWithFixture({ 'formation_data__global__category_display_names.json': CATEGORY_ENTRY });
        const labels = data.global.category_display_names;
        expect(Object.keys(labels)).toContain('blood');
        expect(contentLabel(labels.blood)).toBe('血煞阵');
        // 基础那几档仍是字符串，不能被这次改动弄坏
        expect(typeof labels.attack).toBe('string');
        // 服务侧：整张遍历出来的全集里要有它，且每一项都是能显示的文本
        const keys = Object.keys(labels).filter(k => !k.startsWith('_'));
        for (const k of keys) expect(typeof contentLabel(labels[k], k)).toBe('string');
        expect(keys).toContain('blood');
    });

    test('_stringLabels 把两种形状都收成字符串（下发契约不变）', () => {
        const merged = loadWithFixture({
            'formation_data__global__category_display_names.json': CATEGORY_ENTRY,
            'formation_data__global__grade_display_names.json': {
                dataset: 'formation_data', into: 'global.grade_display_names',
                add: [{ id: 'immortal', label: '仙阵' }]
            }
        });
        const out = FormationService._stringLabels(merged.global);
        expect(out.category_display_names.blood).toBe('血煞阵');
        expect(out.grade_display_names.immortal).toBe('仙阵');
        expect(typeof out.category_display_names.attack).toBe('string');
        // 其它全局键原样保留（相克表、阈值…），别把这次的规范化变成大扫除
        expect(out.counter_relationships).toEqual(merged.global.counter_relationships);
        expect(out.counter_penalty_ratio).toBe(merged.global.counter_penalty_ratio);
    });

    test('读取端一律过 contentLabel，不再"直接取表 || 原始键"', () => {
        const read = f => fs.readFileSync(path.join(serverRoot, f), 'utf8');
        for (const f of ['game/services/FormationService.js', 'routes/admin_formation.js']) {
            const text = read(f);
            expect(text).toMatch(/contentLabel\(/);
            expect(text).not.toMatch(/category_display_names\??\.[^\]]+\]\s*\|\|/);
            expect(text).not.toMatch(/grade_display_names\??\.[^\]]+\]\s*\|\|/);
        }
        // getConfig 下发的是规范化后的 global，不是原始配置对象
        expect(read('game/services/FormationService.js')).toMatch(/global:\s*this\._stringLabels\(cfg\.global\)/);
    });

    test('控制跑：没登记成集合时片里写这张表当场抛；相克表写了也当场抛（不会静默不合并）', () => {
        const registered = DATASET_SPECS.formation_data.collections['global.category_display_names'];
        delete DATASET_SPECS.formation_data.collections['global.category_display_names'];
        try {
            expect(() => loadWithFixture({ 'formation_data__global__category_display_names.json': CATEGORY_ENTRY }))
                .toThrow(/没有该集合|未登记集合|不存在/);
        } finally {
            DATASET_SPECS.formation_data.collections['global.category_display_names'] = registered;
        }
        // 还原后确实能合并进这一档
        expect(Object.keys(loadWithFixture({ 'formation_data__global__category_display_names.json': CATEGORY_ENTRY })
            .global.category_display_names)).toContain('blood');
        // 相克引用表没登记 → 片想改它必须被点名（这是刻意的，见文件头第 4 条）
        expect(() => loadWithFixture({
            'formation_data__global__counter_relationships.json': {
                dataset: 'formation_data', into: 'global.counter_relationships',
                add: [{ id: 'blood', counters: 'attack' }]
            }
        })).toThrow(/没有该集合|未登记集合/);
    });
});

/**
 * 「面板印出来的那两个字段是不是人话」（浏览器验收的静态替身，2026-09-22 补）
 *
 * FormationPanel 印的是 `formation.category_display` / `grade_display` 这两个服务端现算字段
 * （FormationService.js:116/165/194 三处都走 contentLabel）。这里一旦退回"取不到就给原始键"，
 * 界面上就是 attack / mortal 这种裸 id；资料片条目形状一变就印 [object Object]。
 * 不连库、不开浏览器，直接把"基础包 + 全部资料片"的真实视图过一遍。
 */
describe('已发布阵法的中文名（面板就是印这两个字段）', () => {
    const { loadRealContent } = require('./helpers/realContent');

    /**
     * 判据直接委托给生产里那道闸（`ContentRegistry._validateFormationVocabulary`）。
     * 这里以前自己抄了一份检测器 —— 那正是本仓一直在清的形状：两份真相迟早分叉，
     * 于是"测试说没问题、启动期却抛"或者反过来。生产闸把它的错误逐行拆出来就是这份清单。
     */
    function displaysOf(data) {
        const stub = Object.create(ContentRegistry.prototype);
        stub.datasets = new Map([['formation_data', data]]);
        try {
            ContentRegistry.prototype._validateFormationVocabulary.call(stub);
            return [];
        } catch (error) {
            return String(error.message).split('\n').map(l => l.trim()).filter(l => l && !/校验失败/.test(l));
        }
    }

    test('真实视图里每一张阵法（含资料片新增的）都印得出中文名', () => {
        const data = loadRealContent(statRegistry).dataset('formation_data');
        expect((data.formations || []).length).toBeGreaterThan(0);
        expect(Object.keys(data.global.category_display_names).filter(k => !k.startsWith('_')).length)
            .toBeGreaterThan(0);
        expect(displaysOf(data)).toEqual([]);
    });

    test('控制跑：造四种坏名字表，生产那道闸必须逐条点名（否则上面那条是空测）', () => {
        const bad = displaysOf({
            formations: [
                { id: 'good', category: 'attack', grade: 'mortal' },
                { id: 'ghost', category: 'ghost', grade: 'mortal' },
                { id: 'nolabel', category: 'nolabel', grade: 'mortal' },
                { id: 'samename', category: 'samename', grade: 'mortal' },
                { id: 'nograde', category: 'attack', grade: 'unknown_grade' }
            ],
            global: {
                category_display_names: {
                    attack: '攻杀阵', nolabel: { note: '资料片忘了写 label' }, samename: 'samename'
                },
                grade_display_names: { mortal: '凡阵' }
            }
        });
        expect(bad).toHaveLength(4);
        const text = bad.join('\n');
        expect(text).toMatch(/ghost/);
        expect(text).toMatch(/nolabel/);
        expect(text).toMatch(/nograde/);
        // "名字与键相同"和"漏写名字"在界面上是同一件事，所以也要响
        expect(text).toMatch(/samename.*名字与键相同/);
        expect(text).not.toMatch(/阵法 good/);
    });
});
