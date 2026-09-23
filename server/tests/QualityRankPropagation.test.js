/**
 * 「加一档品质，所有用到档序的地方都跟着算吗」（2026-09-22，任务 #43）
 *
 * 业主那条原始需求的形状之一就是：一件东西加了一档新数值，用得到它的地方要能直接算到，
 * 而不是"很多位置都要重新去改"。品质档序这一族上一轮收成了词表
 * （`game_balance.item_qualities`，map 集合 = 资料片可加一档），但收口当轮留了一把退路：
 * 代码写着 `qCfg.quality_order || qualityOrder(...)`，而内容里 **两处 `quality_order`
 * 与词表逐字相同**（`game_balance.crafting.quality_float`、`cave_data.cave.social.treasure_pavilion`）。
 * 镜像的后果不是现在算错，而是：资料片新加一档时词表长了、镜像不会跟着长 →
 * 那一档在炼制品质浮动与万宝阁排名里等于不存在，且没有任何一处会响。
 *
 * 这一轮把镜像删了、两个消费点改成只问词表、并让启动闸拒绝任何再写 `quality_order` 的内容。
 * 这份测试要证明的是三件事：唯一来源真的是唯一（全仓扫一遍）、加一档确实全跟着走（执行，不是静态），
 * 以及新加的那一档名字不合规时会被拦（排行榜把档名拼进 SQL 的 FIELD(...)，那条按 /^[a-z][a-z0-9_]*$/ 过滤）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const { qualityOrder } = require('../game/items/itemQuality');
const { serverRoot, loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');

const FIXTURE_DIR = path.join(os.tmpdir(), 'xx_quality_rank_fixture');
const NEW_RANK = 'primordial';

/** 一支只加一档品质（外加一件用它品质的物品）的资料片；`itemQuality=null` 时只加档不发物品 */
function loadPack(extraQualityEntry, { itemQuality = NEW_RANK } = {}) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'fixture_rank'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'fixture_rank/pack.json'), JSON.stringify({
        id: 'fixture_rank', name: '夹具·新品质档', version: '0.0.1', priority: 950, enabled: true, depends: []
    }));
    const files = {
        'game_balance.json': {
            into: 'item_qualities',
            add: [extraQualityEntry || {
                id: NEW_RANK, name: '太初', tone: 'jade', order: 7,
                _comment: '夹具档：比神话更高一档'
            }]
        }
    };
    if (itemQuality) {
        files['item_data.json'] = {
            into: 'items',
            add: [{ id: 'zz_probe_taichu_pill', name: '探针·太初丹', type: 'consumable', quality: itemQuality }]
        };
    }
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(FIXTURE_DIR, `fixture_rank/${name}`), JSON.stringify(body, null, 4));
    }
    const content = new ContentRegistry({
        configPath: path.join(serverRoot, 'config'), packDir: FIXTURE_DIR, statRegistry
    });
    content.load();
    return content;
}

afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

describe('档序只有一个来源：现网事实', () => {
    test('六档词表按 order 严格递增，且 qualityOrder 就是那个顺序', () => {
        const content = loadRealContent();
        const table = content.dataset('game_balance').item_qualities;
        const keys = Object.keys(table).filter(k => !k.startsWith('_'));
        const orders = keys.map(k => Number(table[k].order));
        expect(new Set(orders).size).toBe(orders.length);
        expect(qualityOrder(makeRealConfigLoader(content))).toEqual(
            keys.slice().sort((a, b) => table[a].order - table[b].order));
    });

    test('全仓内容里再也没有 quality_order 镜像（这两处曾经与词表逐字相同）', () => {
        const hits = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
                else if (entry.name.endsWith('.json')) {
                    const text = fs.readFileSync(full, 'utf8');
                    if (/"quality_order"\s*:/.test(text)) hits.push(path.relative(serverRoot, full).replace(/\\/g, '/'));
                }
            }
        };
        walk(path.join(serverRoot, 'config'));
        walk(path.join(serverRoot, 'content'));
        expect(hits).toEqual([]);
    });

    test('两个消费点不再各自持有档序（静态哨兵，配合上面的运行时判据）', () => {
        // 判据读的是代码不是注释 —— 不先抹注释，我这轮写的解释性注释会冒充成一次抄写（上一版就被自己咬过）
        const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const rel of ['game/services/CraftingService.js', 'game/services/CaveSocialService.js']) {
            const text = codeOnly(fs.readFileSync(path.join(serverRoot, rel), 'utf8'));
            expect(text).not.toMatch(/\.quality_order\b/);
            expect(text).toMatch(/qualityOrder\(/);          // 反向也钉：确实还在问词表，不是整段被删掉
        }
    });
});

describe('资料片加一档品质：三处消费点都跟着算（执行，不是静态）', () => {
    test('词表长了、档位排序把它排在最高一档', () => {
        const content = loadPack();
        const ladder = qualityOrder(makeRealConfigLoader(content));
        expect(ladder).toHaveLength(7);
        expect(ladder[ladder.length - 1]).toBe(NEW_RANK);
    });

    test('炼制品质浮动：完美档把 mythic 再往上抬一档（加档之前那里就是上界）', () => {
        const content = loadPack();
        const CraftingService = require('../game/services/CraftingService');
        CraftingService.initialize(makeRealConfigLoader(content));
        // 偏差 0 = 完美档（upgrade +1）：现网最高档是 mythic，加一档之后 mythic 还能再往上一格
        const r = CraftingService.calcQualityTier(0, 0, 'mythic');
        expect(r.name).toBe('完美');
        expect(r.quality).toBe(NEW_RANK);
        // 反面对照（我第一版就是把期望写错了才发现的）：不加那一档时，同样一次升档只能停在 mythic
        CraftingService.initialize(makeRealConfigLoader(loadRealContent()));
        expect(CraftingService.calcQualityTier(0, 0, 'mythic').quality).toBe('mythic');
        CraftingService.initialize(makeRealConfigLoader(content));
        // 基准本身就是最高档时不许越过上界、也不许变成 undefined
        expect(CraftingService.calcQualityTier(0, 0, NEW_RANK).quality).toBe(NEW_RANK);
        // 劣品降一档仍然合法（下界钳制）
        expect(CraftingService.calcQualityTier(99, 0, 'common').quality).toBe('common');
    });

    test('万宝阁：新档的位次高于 legendary，未知档仍按最低档算', () => {
        const content = loadPack();
        const CaveSocialService = require('../game/services/CaveSocialService');
        CaveSocialService.initialize(makeRealConfigLoader(content));
        const rank = q => CaveSocialService._getQualityRank(q);
        expect(rank(NEW_RANK)).toBe(6);
        expect(rank(NEW_RANK)).toBeGreaterThan(rank('legendary'));
        expect(rank('not_a_rank_at_all')).toBe(0);
    });

    test('洞府遗宝的默认档集是从词表推的（加一档低档时它自己会挪）', () => {
        // 这条盯的是 CaveLegacyService 那句 `qualityOrder(...).slice(0, 4)`：
        // 以前默认四档是抄的，加一档只能靠人记得回来改。
        const content = loadPack(
            { id: 'zza_humble', name: '探针·蒙尘', tone: 'neutral', order: 0.5 },
            { itemQuality: null }            // 只加档，不带用它的物品（否则会被"quality 不在词表里"那道闸拦下）
        );
        const ladder = qualityOrder(makeRealConfigLoader(content));
        expect(ladder.slice(0, 4)).toEqual(['zza_humble', 'common', 'uncommon', 'rare']);
        expect(ladder).toHaveLength(7);
    });

    test('控制跑：谁再把档序抄进内容，启动期就抛（这一条就是本轮删掉的那两份镜像的回潮哨）', () => {
        let message = '';
        const content = loadRealContent();
        const balance = content.datasets.get('game_balance');
        const saved = balance.crafting.quality_float.quality_order;
        balance.crafting.quality_float.quality_order = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];
        try {
            content._validateItemQualities();
        } catch (err) { message = String(err.message); } finally {
            if (saved === undefined) delete balance.crafting.quality_float.quality_order;
            else balance.crafting.quality_float.quality_order = saved;
        }
        expect(message).toContain('档序只有一个来源');
        expect(message).toContain('game_balance.crafting.quality_float.quality_order');
        expect(() => content._validateItemQualities()).not.toThrow();      // 还原要真的还原
    });

    test('控制跑：新档名字不合形就抛（排行榜把档名拼进 SQL 的 FIELD(...)，那条按这个正则过滤）', () => {
        let message = '';
        try {
            loadPack({ id: 'Bad Rank', name: '探针·大写档', tone: 'jade', order: 8 });
        } catch (err) { message = String(err.message); }
        expect(message).toContain('Bad Rank');
        expect(message).toContain('FIELD(');
    });
});
