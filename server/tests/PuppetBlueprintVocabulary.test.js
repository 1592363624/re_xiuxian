/**
 * 「资料片能不能加一只新傀儡」—— puppet_data.blueprints 收成可扩集合（2026-09-23）
 *
 * `puppet_types` 早就登记成 map 集合，但每一档的 `blueprint_key` 指向的 `blueprints` 表没登记：
 * 于是"加一只新傀儡"写得出、**学不到也造不出** —— `learnBlueprint` 第一句就查不到图谱返回
 * "图谱不存在"，而参悟的前提是背包里有那张图谱**物品**。更要紧的是界面那一头：
 * 客户端"参悟"按钮以前自己按 `puppet_type + '_blueprint'` 拼 key（把内容里的一条命名约定抄进了 UI），
 * 图谱只要不合这个名字，点下去就是"图谱不存在"，玩家看到的是"这只傀儡没法学"。
 *
 * 所以这一格不是"补个登记"就完事：登记 + 启动闸双向对账（类型↔图谱、图谱↔物品、图谱↔名字与出处）
 * + 服务端把 key/名字/出处一次给全 + 界面不再拼 key，四件事一起做，
 * 与灵兽稀有度、功法品阶、装备槽位是同一套做法。见 [[project-content-reachability-gates]]。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { serverRoot, loadRealContent } = require('./helpers/realContent');
const PuppetService = require('../game/services/PuppetService');

const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_puppet_blueprint_fixture');

// 故意用不合 `<类型>_blueprint` 约定的 key：证明"约定"不再被任何一处代码依赖
const NEW_TYPE = 'xinyu_jiang';
const NEW_BLUEPRINT = 'tujian_xinyu_v2';
const newTypeEntry = {
    id: NEW_TYPE, name: '心傀·试片', description: '夹具傀儡', quality: 'epic',
    required_dayan_level: 0, blueprint_key: NEW_BLUEPRINT,
    base_stats: { atk: 40, def: 20, hp: 150, speed: 6 },
    manufacture_cost: { spirit_stone: 1000, materials: {} }, color: 'violet'
};
const newBlueprintEntry = {
    id: NEW_BLUEPRINT, name: '试片心傀图谱', puppet_type: NEW_TYPE,
    source: '夹具资料片掉落', description: '探针图谱'
};
const newBlueprintItem = {
    id: NEW_BLUEPRINT, name: '试片心傀图谱', type: 'material', quality: 'epic',
    description: '参悟用的图谱物品', price: 1
};

function loadWithFixture(files, mutateSpec) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'puppet_fixture'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'puppet_fixture/pack.json'), JSON.stringify({
        id: 'puppet_fixture', name: '夹具·傀儡图谱', version: '0.0.1', priority: 999, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, 'puppet_fixture', name), JSON.stringify(body, null, 4));
    }
    const content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'), packDir: FIXTURE_DIR, statRegistry
    });
    const undo = mutateSpec ? mutateSpec() : null;
    try { content.load(); return content; } finally { if (undo) undo(); }
}
const fullFiles = () => ({
    'puppet_data__puppet_types.json': { into: 'puppet_types', add: [newTypeEntry] },
    'puppet_data__blueprints.json': { into: 'blueprints', add: [newBlueprintEntry] },
    'item_data__items.json': { into: 'items', add: [newBlueprintItem] }
});

describe('现网五档傀儡（先钉住"这道闸不误伤现有内容"）', () => {
    const puppet = loadRealContent().datasets.get('puppet_data');

    test('每一档都有图谱、图谱指得回来、名字与出处齐备', () => {
        const keys = Object.keys(puppet.puppet_types);
        expect(keys).toHaveLength(5);
        for (const key of keys) {
            const bk = puppet.puppet_types[key].blueprint_key;
            expect(puppet.blueprints[bk]).toBeTruthy();
            expect(puppet.blueprints[bk].puppet_type).toBe(key);
            expect(puppet.blueprints[bk].name).toBeTruthy();
            expect(puppet.blueprints[bk].source).toBeTruthy();
        }
    });

    test('blueprintOf 是图谱展示信息的唯一读取口，查不到时给空串而不是抛', () => {
        PuppetService._config = { blueprints: { some_bp: { name: '某图谱', source: '某副本' } } };
        expect(PuppetService.blueprintOf('some_bp')).toEqual({ name: '某图谱', source: '某副本' });
        expect(PuppetService.blueprintOf('nope')).toEqual({ name: '', source: '' });
        expect(PuppetService.blueprintOf(undefined)).toEqual({ name: '', source: '' });
        PuppetService._config = { blueprints: null };
        expect(PuppetService.blueprintOf('some_bp')).toEqual({ name: '', source: '' });
        PuppetService._config = null;   // 交还给"每次现读配置"的正常路径，别把 override 留给后面的用例
    });

    test('配置是每次现读的：热更换掉 ConfigLoader 里那份对象后，傀儡服务立刻看到的是新的一份', () => {
        // 改造前这里是 `this._config = loader.getConfig(...)` 一次抓取 —— hotUpdateConfig 换的是
        // 缓存里的对象而不是原地改它，于是"装上新傀儡"要重启才生效，界面与启动日志都不报错。
        const originals = { loader: PuppetService._loader, cache: PuppetService._configCache, override: PuppetService._configOverride };
        let current = { puppet_types: { old_type: { name: '旧傀儡', blueprint_key: 'old_bp' } }, blueprints: {} };
        PuppetService._configOverride = null;
        PuppetService.initialize({
            getConfig: name => (name === 'puppet_data' ? current : null),
            peekConfig: name => (name === 'puppet_data' ? current : null)
        });
        expect(PuppetService._config.puppet_types.old_type.name).toBe('旧傀儡');
        current = { puppet_types: { new_type: { name: '新傀儡', blueprint_key: 'new_bp' } }, blueprints: {} };
        expect(Object.keys(PuppetService._config.puppet_types)).toEqual(['new_type']);
        expect(PuppetService.getConfig().puppet_types.new_type.name).toBe('新傀儡');
        Object.assign(PuppetService, originals);
    });

    test('没注入过 loader 时返回 null 而不是去猜一份配置（离线脚本忘 initialize 会量到假数据）', () => {
        const originals = { loader: PuppetService._loader, cache: PuppetService._configCache, override: PuppetService._configOverride };
        PuppetService._loader = null;
        PuppetService._configCache = null;
        PuppetService._configOverride = null;
        expect(PuppetService._config).toBeNull();
        Object.assign(PuppetService, originals);
    });
});

describe('加一只新傀儡 = 只写内容', () => {
    const content = loadWithFixture(fullFiles());
    const puppet = content.datasets.get('puppet_data');

    test('新类型与新图谱都进了合并视图，且记在资料片名下（基础表没被改）', () => {
        expect(puppet.puppet_types[NEW_TYPE].name).toBe('心傀·试片');
        expect(puppet.blueprints[NEW_BLUEPRINT].puppet_type).toBe(NEW_TYPE);
        expect(puppet.blueprints[NEW_BLUEPRINT].__content_origin).toBe('puppet_fixture');
    });

    test('图谱名字不合 `<类型>_blueprint` 约定也照样能用（闸只认 blueprint_key 这一个来源）', () => {
        expect(NEW_BLUEPRINT).not.toBe(`${NEW_TYPE}_blueprint`);
        expect(puppet.puppet_types[NEW_TYPE].blueprint_key).toBe(NEW_BLUEPRINT);
    });
});

describe('启动闸：每条都反过来打一遍', () => {
    const load = files => () => loadWithFixture(files);

    test('类型没登记 blueprint_key → 拦（这只傀儡没有任何获取途径）', () => {
        const files = fullFiles();
        files['puppet_data__puppet_types.json'] = { into: 'puppet_types', add: [{ ...newTypeEntry, blueprint_key: undefined }] };
        expect(load(files)).toThrow(/puppet_types\.xinyu_jiang 没有 blueprint_key/);
    });

    test('blueprint_key 指向一张不存在的图谱 → 拦，并点名 learnBlueprint 会回什么', () => {
        const files = fullFiles();
        delete files['puppet_data__blueprints.json'];
        expect(load(files)).toThrow(/blueprint_key="tujian_xinyu_v2" 在 blueprints 里没有这张图谱/);
    });

    test('图谱不是 item_data 里的物品 → 拦（参悟要先在背包里有它）', () => {
        const files = fullFiles();
        delete files['item_data__items.json'];
        expect(load(files)).toThrow(/不是 item_data 里的物品/);
    });

    test('图谱的 puppet_type 指错 / 与类型那条对不上 → 两种都拦', () => {
        const dangling = fullFiles();
        dangling['puppet_data__blueprints.json'] = { into: 'blueprints', add: [{ ...newBlueprintEntry, puppet_type: 'zz_no_such_type' }] };
        expect(load(dangling)).toThrow(/没有这一类傀儡/);

        const mismatched = fullFiles();
        mismatched['puppet_data__blueprints.json'] = { into: 'blueprints', add: [{ ...newBlueprintEntry, puppet_type: 'shadow' }] };
        expect(load(mismatched)).toThrow(/但那一类自己的 blueprint_key 指的是/);
    });

    test('图谱少名字 / 少出处 → 各拦各的（列表与"去哪拿"那一行都会是空的）', () => {
        const noName = fullFiles();
        noName['puppet_data__blueprints.json'] = { into: 'blueprints', add: [{ ...newBlueprintEntry, name: '' }] };
        expect(load(noName)).toThrow(/没有 name/);

        const noSource = fullFiles();
        noSource['puppet_data__blueprints.json'] = { into: 'blueprints', add: [{ ...newBlueprintEntry, source: '' }] };
        expect(load(noSource)).toThrow(/没有 source/);
    });

    test('控制跑：摘掉 blueprints 的登记，同一支夹具就装不进来（能扩来自登记）', () => {
        const spec = DATASET_SPECS.puppet_data.collections;
        expect(() => loadWithFixture(fullFiles(), () => {
            const saved = spec.blueprints;
            delete spec.blueprints;
            return () => { spec.blueprints = saved; };
        })).toThrow(/blueprints/);
        expect(spec.blueprints).toEqual({ map: true, optional: true });
    });
});

describe('界面不再抄内容的那条命名约定', () => {
    const clientRoot = path.join(serverRoot, '..', 'client');
    const panel = fs.readFileSync(path.join(clientRoot, 'src/components/panels/PuppetPanel.vue'), 'utf8');

    test('参悟用服务端下发的 blueprint_key，不再拼字符串', () => {
        expect(panel).not.toMatch(/puppet_type\s*\+\s*'_blueprint'/);
        expect(panel).toMatch(/const blueprintKey = mfg\.blueprint_key/);
        expect(panel).toMatch(/if \(!mfg\.blueprint_key\)/);           // 缺登记时明说，而不是发一个猜出来的 key
    });

    test('可制造列表那一行确实带了 key 与名字（服务端是唯一来源）', () => {
        const src = fs.readFileSync(path.join(serverRoot, 'game/services/PuppetService.js'), 'utf8');
        expect(src).toMatch(/blueprint_key: typeCfg\.blueprint_key \|\| null/);
        expect(src).toMatch(/blueprint_name: this\.blueprintOf\(typeCfg\.blueprint_key\)\.name/);
    });
});

/**
 * 这一格本来在扩展缺口台账里是"0 处外键证据"，所以排在最后面看不见 ——
 * 判据把 `blueprint_key` 规约成 "blueprint_key"、把表规约成 "blueprint"，两边对不上。
 * 下面两条把这条盲区钉住：正向是"摘掉登记就必须数出 5 处证据"，反向是"别把不相关的字段也算成外键"。
 */
describe('台账判据认得这条外键', () => {
    const { looksLikePointer, normalise, summarizeGaps } = require('../game/content/extensionGaps');

    test('字段名与表名的机械对应（含新认得的 _key/_id 后缀，和不该匹配的对照）', () => {
        expect(normalise('blueprint_key')).toBe('blueprint');
        expect(looksLikePointer('blueprint_key', 'blueprints')).toBe(true);
        expect(looksLikePointer('puppet_type', 'puppet_types')).toBe(true);
        expect(looksLikePointer('description', 'blueprints')).toBe(false);
        expect(looksLikePointer('manufacture_cost', 'blueprints')).toBe(false);
    });

    test('控制跑：把 blueprints 退回未登记，台账立刻数出五处外键证据（登记不是靠运气挡住的）', () => {
        const spec = DATASET_SPECS.puppet_data.collections;
        const saved = spec.blueprints;
        delete spec.blueprints;
        try {
            const row = summarizeGaps(loadRealContent()).open.find(r => r.id === 'puppet_data.blueprints');
            expect(row).toBeTruthy();
            expect(row.pointerEntries).toBe(5);
            expect(row.pointers[0].field).toBe('blueprint_key');
        } finally {
            spec.blueprints = saved;
        }
        // 还原要真的还原：登记回来之后这一格不再是缺口
        expect(summarizeGaps(loadRealContent()).open.map(r => r.id)).not.toContain('puppet_data.blueprints');
    });
});
