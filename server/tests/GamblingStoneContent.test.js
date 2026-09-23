/**
 * 赌石这一坨内容"资料片能不能自己加"与"加了之后落不落到玩家身上"（2026-09-23）
 *
 * 登记之前，`gambling_stone_data` 在扩展缺口台账里占 9 行（线索表、等级称号、四张产出池、
 * 七个品质池），而读取侧其实一直在读配置 —— 也就是"只差登记与闸"那一类格子。
 * 登记完之后要回答的是另一半问题：**资料片写出来的形状，消费端认不认**。
 * 这里钉的就是这一半，因为它有现成的反例可撞：
 *   · map 集合里资料片追加的条目必然是对象（`{id, value}`），而 `yield_pools.spirit_stones` 的值
 *     是裸数组 —— 不兼容就直接 `[min,max]` 变成 `{...}`，产出算成 NaN，且炸在发钱那一步；
 *   · `skill.level_titles` 同理（不兼容就印 `[object Object]`）；
 *   · 品质档序、线索维度数、产地 pool_bias 三处都是"少配一格不会报错、只会静默变样"。
 *
 * 本轮顺手抓到的一条就是这样撞出来的：假线索减幅的键在 `skill.fake_reduction_per_level`，
 * 而代码读的是 `clues.fake_reduction_per_level` → NaN → `Math.random() < NaN` 恒 false，
 * **"每条线索 30% 是假的"这一层博弈从来没生效过**。第 8、10 两条判据钉的就是它。
 *
 * 用法：cd server && npx jest --runInBand tests/GamblingStoneContent.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS, contentRange, contentList, contentLabel } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');

const serverRoot = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(os.tmpdir(), 'xx_gambling_stone_fixture');
const PACK_ID = 'gs_probe';

/** 写一支临时资料片并装配整份内容层（packDir 传父目录，这是本仓夹具的口径） */
function loadFixture(files) {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    const dir = path.join(FIXTURE_ROOT, PACK_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: PACK_ID, name: '夹具·赌石', version: '0.0.1', priority: 999, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2));
    }
    const content = new ContentRegistry({ configPath: path.join(serverRoot, 'config'), packDir: FIXTURE_ROOT, statRegistry });
    content.load();
    return content;
}

const baseOf = dataset => JSON.parse(fs.readFileSync(path.join(serverRoot, 'config', `${dataset}.json`), 'utf8'));
const baseQualities = () => baseOf('gambling_stone_data').qualities;
/** 基础配置里最高的一档 —— 夹具的新档要排在它后面 */
const topTier = () => Math.max(...Object.values(baseQualities()).map(q => Number(q.tier)));
const qualityCount = () => Object.keys(baseQualities()).length;

const newQuality = (extra = {}) => ({
    dataset: 'gambling_stone_data', into: 'qualities',
    add: [{
        id: 'zz_immortal_mist', name: '紫霄仙雾石', tier: topTier() + 1, base_price: 88000,
        weight: 3, yield_multiplier: 4, rare_chance_bonus: 0.02, color: '#c4b5fd', ...extra
    }]
});
const rangeAdd = (collection, value) => ({
    dataset: 'gambling_stone_data', into: collection, add: [{ id: 'zz_immortal_mist', value }]
});
/** 每一维线索都要跟着多一档，否则"最贵那两档读起来一模一样" */
const clueOverride = (extraValue = '霞彩') => ({
    dataset: 'gambling_stone_data', into: 'clues',
    override: ['crust', 'weight', 'aura', 'color'].reduce((acc, dim, i) => {
        acc[dim] = { id: dim, name: `探针维度${i}`, values: [...Array(qualityCount() - 1).fill('低档'), '高档', extraValue] };
        return acc;
    }, {})
});

function expectLoadToThrow(files, phrase) {
    let message = '';
    try { loadFixture(files); } catch (err) { message = String(err && err.message || err); }
    expect(message).toContain(phrase);
    return message;
}

describe('资料片自己就能加一档品质（四张池子 + 线索档数都要跟着长）', () => {
    test('只加品质 → 拦，并点名"切开当场抛"那两张没有守卫的表', () => {
        const message = expectLoadToThrow({ 'gambling_stone_data__qualities.json': newQuality() }, 'zz_immortal_mist');
        expect(message).toContain('spirit_stones');
        expect(message).toContain('服务器内部错误');
    });

    test('补齐两张必配区间、但线索没跟着长 → 拦，点名"两档共用一条线索"', () => {
        // 报错点名的是**维度**（四行各一条），不是新档名 —— 这才是要人回去补的那句话
        const message = expectLoadToThrow({
            'gambling_stone_data__qualities.json': newQuality(),
            'gambling_stone_data__yield_pools__spirit_stones.json': rangeAdd('yield_pools.spirit_stones', [8000, 16000]),
            'gambling_stone_data__yield_pools__cultivation.json': rangeAdd('yield_pools.cultivation', [40000, 90000])
        }, 'qualities 有 5 档');
        expect(message).toContain('共用同一条线索');
    });

    test('全部补齐 → 装配通过，新档真的进了档序（排在最后），消费端读得到区间', () => {
        const content = loadFixture({
            'gambling_stone_data__qualities.json': newQuality(),
            'gambling_stone_data__yield_pools__spirit_stones.json': rangeAdd('yield_pools.spirit_stones', [8000, 16000]),
            'gambling_stone_data__yield_pools__cultivation.json': rangeAdd('yield_pools.cultivation', [40000, 90000]),
            'gambling_stone_data__clues.json': clueOverride()
        });
        const data = content.dataset('gambling_stone_data');
        expect(data.qualities.zz_immortal_mist.name).toBe('紫霄仙雾石');
        // 资料片经 map 集合写的区间是 `{id,value:[min,max]}` 那种对象 —— 取形必须与消费端同一份
        expect(contentRange(data.yield_pools.spirit_stones.zz_immortal_mist)).toEqual([8000, 16000]);
        expect(contentRange(data.yield_pools.spirit_stones.common)).toEqual([50, 200]);    // 裸数组那一份同样过

        const GamblingStoneService = require('../game/services/GamblingStoneService');
        const saved = GamblingStoneService._config;
        GamblingStoneService._config = data;
        try {
            const keys = GamblingStoneService._qualityKeys();
            expect(keys[keys.length - 1]).toBe('zz_immortal_mist');      // 档序按内容里的 tier，新档不用改代码
            expect(GamblingStoneService._clueDimensions()).toEqual(['crust', 'weight', 'aura', 'color']);
        } finally {
            GamblingStoneService._config = saved;
        }
    });

    test('控制跑：把 qualities 的登记摘掉，同一支夹具就不可能装出新档（证明这条登记就是那条路的入口）', () => {
        const spec = DATASET_SPECS.gambling_stone_data.collections;
        const saved = spec.qualities;
        delete spec.qualities;
        try {
            // 不抛 = 这一格根本没被当回事；抛在"缺主键/未知集合"那一类错上就是登记在管事
            let message = '';
            try {
                const content = loadFixture({ 'gambling_stone_data__qualities.json': newQuality() });
                expect(content.dataset('gambling_stone_data').qualities.zz_immortal_mist).toBeUndefined();
                return;
            } catch (err) { message = String(err && err.message || err); }
            expect(message.length).toBeGreaterThan(0);
        } finally {
            spec.qualities = saved;
        }
    });
});

describe('往已有那一档里加一条东西：条目表登记 + 物品必须真存在', () => {
    const oreInCommon = (itemId, over = {}) => ({
        dataset: 'gambling_stone_data', into: 'yield_pools.materials.common',
        add: [{ item_id: itemId, min: 1, max: 2, weight: 10, ...over }]
    });

    test('加一件基础配置里有的物品 → 长度 +1，且抽得到它（权重为正）', () => {
        const before = baseOf('gambling_stone_data').yield_pools.materials.common.length;
        const content = loadFixture({ 'gambling_stone_data__yield_pools__materials__common.json': oreInCommon('gold_pill') });
        const pool = content.dataset('gambling_stone_data').yield_pools.materials.common;
        expect(pool).toHaveLength(before + 1);
        expect(pool[pool.length - 1].item_id).toBe('gold_pill');
    });

    test('加一件不存在的物品 → 拦（全局引用闸先响，本闸那条是同一条路上第二道）', () => {
        const message = expectLoadToThrow({ 'gambling_stone_data__yield_pools__materials__common.json': oreInCommon('zz_no_such_ore') },
            '指向不存在的物品');
        expect(message).toContain('zz_no_such_ore');
    });

    test('重复 add 已有那一条 → 拦并让人改写 override（否则同一件东西被两份资料片各写一次，谁后合并谁赢）', () => {
        expectLoadToThrow({ 'gambling_stone_data__yield_pools__materials__common.json': oreInCommon('wild_herb') },
            '要修改既有内容请写 override');
    });

    test('min>max 与权重 0 各自被点名（一个是负产出，一个是「随机」其实是固定）', () => {
        expectLoadToThrow({ 'gambling_stone_data__yield_pools__materials__common.json': oreInCommon('gold_pill', { min: 9, max: 2 }) },
            'min/max 不合法');
        expectLoadToThrow({ 'gambling_stone_data__yield_pools__materials__common.json': oreInCommon('gold_pill', { weight: 0 }) },
            'weight 必须是正数');
    });

    test('稀有池子里可以没有 item_id，但必须是 {type:"ldc"} 那一种', () => {
        expectLoadToThrow({
            'gambling_stone_data__yield_pools__rare_drops__spirit_vein.json': {
                dataset: 'gambling_stone_data', into: 'yield_pools.rare_drops.spirit_vein',
                add: [{ name: '探针掉落', chance: 0.5 }]
            }
        }, '既没有 item_id');
        const content = loadFixture({
            'gambling_stone_data__yield_pools__rare_drops__spirit_vein.json': {
                dataset: 'gambling_stone_data', into: 'yield_pools.rare_drops.spirit_vein',
                add: [{ id: 'zz_probe_item_drop', item_id: 'wild_herb', name: '探针掉落', chance: 0.5 }]
            }
        });
        const rare = content.dataset('gambling_stone_data').yield_pools.rare_drops.spirit_vein;
        expect(rare[rare.length - 1].item_id).toBe('wild_herb');
    });
});

describe('那几个"少配一格不会报错、只会静默变样"的地方', () => {
    test('产地 pool_bias 少一键 → 拦（否则那个产地只出稀有）', () => {
        expectLoadToThrow({
            'gambling_stone_data__origins.json': {
                dataset: 'gambling_stone_data', into: 'origins',
                add: [{
                    id: 'zz_probe_origin', name: '探针矿脉', weight: 1,
                    pool_bias: { spirit_stones: 0.5, cultivation: 0.2, material: 0.1 }
                }]
            }
        }, 'pool_bias 必须齐');
    });

    test('pool_bias 四档之和不为 1 → 拦并打印实际和', () => {
        const message = expectLoadToThrow({
            'gambling_stone_data__origins.json': {
                dataset: 'gambling_stone_data', into: 'origins',
                add: [{
                    id: 'zz_probe_origin', name: '探针矿脉', weight: 1,
                    pool_bias: { spirit_stones: 0.5, cultivation: 0.5, material: 0.5, rare: 0.5 }
                }]
            }
        }, '四档之和=2.000');
        expect(message).toContain('产出分布和配表写的不是一回事');
    });

    test('fake_probability 越界 → 拦（假线索那一层博弈会静默消失）', () => {
        // 这颗是 map 集合里的**标量 passthrough**，资料片不能用 ops 改它（改不到 = 另一种安全），
        // 所以这里直接把装配好的那份数据集改坏再跑一次闸 —— 与启动期走的是同一段代码。
        const content = loadFixture({});
        const data = content.dataset('gambling_stone_data');
        data.clues.fake_probability = 9;
        expect(() => content._validateGamblingStone()).toThrow(/不是 0~1 的数/);
        data.clues.fake_probability = 0.3;
        expect(() => content._validateGamblingStone()).not.toThrow();
    });

    test('减幅那颗不许写进 clues —— 它的正确位置是 skill（本轮那条死功能就是这么来的）', () => {
        expectLoadToThrow({
            'gambling_stone_data__clues.json': {
                dataset: 'gambling_stone_data', into: 'clues',
                add: [{ id: 'fake_reduction_per_level', value: 0.001 }]
            }
        }, '又出现了一份');
    });

    test('等级称号允许资料片用 {id,label} 形状加一档，且服务读出的是字符串', () => {
        const content = loadFixture({
            'gambling_stone_data__skill__level_titles.json': {
                dataset: 'gambling_stone_data', into: 'skill.level_titles',
                add: [{ id: '20', label: '铁口直断' }]
            }
        });
        const titles = content.dataset('gambling_stone_data').skill.level_titles;
        expect(contentLabel(titles['20'], null)).toBe('铁口直断');
        const GamblingStoneService = require('../game/services/GamblingStoneService');
        const saved = GamblingStoneService._config;
        GamblingStoneService._config = content.dataset('gambling_stone_data');
        try {
            expect(GamblingStoneService._getSkillTitle(25)).toBe('铁口直断');       // 不是 [object Object]
            expect(GamblingStoneService._getSkillTitle(0)).toBe('赌石新手');         // 基础配置那份裸字符串
        } finally {
            GamblingStoneService._config = saved;
        }
    });

    test('线索维度只有一档 → 拦（假线索是在 values 里挑"不同的一个"，只有一档会死循环）', () => {
        expectLoadToThrow({
            'gambling_stone_data__clues.json': {
                dataset: 'gambling_stone_data', into: 'clues',
                override: { aura: { id: 'aura', name: '灵气强度', values: ['浓郁'] } }
            }
        }, '至少要有 2 个档位');
    });
});

describe('维度清单与产出区间都只有一份读法（不许回潮成手抄）', () => {
    const source = fs.readFileSync(path.join(serverRoot, 'game/services/GamblingStoneService.js'), 'utf8');
    const code = source.split(/\r?\n/).filter(line => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n');

    test('服务里不再出现写死的四档维度清单', () => {
        expect(code).not.toMatch(/\[\s*'crust'\s*,\s*'weight'/);
        expect(code).toMatch(/_clueDimensions\(\)/);
        expect((code.match(/clue_rows: this\._clueRowsOf\(clues\)/g) || []).length).toBe(3);
        // 库里那一列仍然存原始对象（含 `_fakes`，那是后端记账），所以这里不判 `clues:` 出现与否，
        // 外发不泄漏由下面那条投影单测判（_clueRowsOf 只认内容里的维度）
        // 三处消费点：_generateClues 的循环、_clueRowsOf 的投影、灵识透石的随机维度
        expect((code.match(/this\._clueDimensions\(\)/g) || []).length).toBe(3);
    });

    test('投影：只出内容里那些维，顺序按内容，且后端那份"哪几条是假的"不漏给玩家', () => {
        const GamblingStoneService = require('../game/services/GamblingStoneService');
        const saved = GamblingStoneService._config;
        GamblingStoneService._config = {
            clues: {
                fake_probability: 0.3,
                _fake_comment: '注释不是维度',
                crust: { name: '皮壳纹路', values: ['粗糙', '细腻'] },
                zz_new_dim: { name: '石温', values: ['凉', '热'] }     // 资料片新加的一维
            }
        };
        try {
            const rows = GamblingStoneService._clueRowsOf({
                crust: '细腻', zz_new_dim: '热', _fakes: ['crust'], _is_cursed_hint: true
            });
            expect(rows).toEqual([
                { key: 'crust', name: '皮壳纹路', value: '细腻' },
                { key: 'zz_new_dim', name: '石温', value: '热' }
            ]);
            expect(JSON.stringify(rows)).not.toContain('_fakes');
        } finally {
            GamblingStoneService._config = saved;
        }
    });

    test('界面那一份字典也没了：面板按 clue_rows 渲染，不再点写四个维度名', () => {
        // 这条跨端判据不许"文件不在就跳过"：跳过的话它就永远绿着，等于没有（本仓的静态闸都按这个口径写）
        const panel = path.join(serverRoot, '..', 'client', 'src', 'components', 'panels', 'GamblingStonePanel.vue');
        expect(fs.existsSync(panel)).toBe(true);
        const vue = fs.readFileSync(panel, 'utf8');
        expect(vue).toContain('clue_rows');
        for (const dim of ['crust', 'aura']) expect(vue).not.toContain(`clues.${dim}`);
        expect(vue).not.toContain('皮壳纹路');            // 中文名不再抄第二份
        const api = fs.readFileSync(path.join(serverRoot, '..', 'client', 'src', 'api', 'gamblingStone.ts'), 'utf8');
        expect(api).not.toMatch(/interface StoneClues/);
    });

    test('产出区间/池子/称号都过 content 兼容层读（两种形状同时认）', () => {
        expect(code).toMatch(/contentRange\(pools\.spirit_stones\?\.\[quality\]\)/);
        expect(code).toMatch(/contentRange\(pools\.cultivation\?\.\[quality\]\)/);
        expect(code).toMatch(/contentList\(pools\.materials\?\.\[quality\]\)/);
        expect(code).toMatch(/contentList\(pools\.rare_drops\?\.\[quality\]\)/);
        expect(code).toMatch(/contentLabel\(value, null\)/);
        // 假线索概率的减幅只能有一个出处
        expect(code).toMatch(/skill\?\.fake_reduction_per_level/);
        expect(code).not.toMatch(/clueCfg\.fake_reduction_per_level/);
    });

    test('兼容层本身对三种形状都成立（闸与消费端同一份口径的前提）', () => {
        expect(contentRange([5, 9])).toEqual([5, 9]);
        expect(contentRange({ id: 'x', value: [5, 9] })).toEqual([5, 9]);
        expect(contentRange({ min: 5, max: 9 })).toEqual([5, 9]);
        expect(contentRange('nope')).toBe(null);
        expect(contentRange({ id: 'x', value: ['a', 'b'] })).toBe(null);        // 非数不放过
        expect(contentList({ id: 'x', items: [1, 2] })).toEqual([1, 2]);
        expect(contentList([1, 2])).toEqual([1, 2]);
        expect(contentLabel({ id: 'x', value: '灵识透石' })).toBe('灵识透石');
        expect(contentLabel('裸串')).toBe('裸串');
        expect(contentLabel({ id: 'x' }, '兜底')).toBe('兜底');
    });
});
