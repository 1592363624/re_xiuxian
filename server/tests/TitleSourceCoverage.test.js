/**
 * 称号的两本账：发出去的称号查得到名字（引用方向）+ 每一档称号都有人发（来源方向）
 *
 * 为什么称号要单独一本账（与 tests/ItemSourceCoverage 同族但形状不同）：
 *   · `addTitleToInstance` 只判"字符串非空"，**不查 titles 词表**。内容里写一个不存在的称号 id，
 *     那条链照样把它写进 `players.titles`；而称号列表与属性引擎第 40 站都是
 *     `titles.find(t => t.id === …)` —— 两边查不到就是"玩家手里攥着一个查无此名的字符串"，
 *     没有任何一处报错。2026-09-22 实测：**副本/切磋的发放路径指着 10 档 titles 里根本不存在的称号**
 *     （掩月破阵者、封魔塔主、伏魔者…），而内容里还另抄了一份 `title_name` 镜像，
 *     所以播报文本看起来完全正常 —— 两个真相把这条断链盖住了。本轮补齐那 10 档（`bonuses: {}`，
 *     刻意零加成：号是名、印是凭，要给数值等业主签字）。
 *   · 反方向：`titles[].condition`（"完成1000次打坐"）这个字段**没有任何代码读**（本文件最后一钉），
 *     所以写 condition 不会让玩家拿到称号。现网 45 档里今天有发放路径的只有 29 档 ——
 *     剩下的 16 档本轮先量准、点名、写理由，并把账锁成只许变小的棘轮。
 *     基础内容没有直接硬拦：一次拦 16 档只会逼人删内容（把"补出口"变成"删表"）；
 *     资料片新增的那一档则当场硬拦（`_validateTitleGrants`），因为新加一档零来源的称号必然作者本意是没接完。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, TITLE_GRANT_PATHS } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');

const serverRoot = path.join(__dirname, '..');
const CONFIG_DIR = path.join(serverRoot, 'config');
const REAL_PACK_DIR = path.join(serverRoot, 'content', 'packs');

function loadView(packDir) {
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir, statRegistry });
    content.load();
    return content;
}

/** 临时资料片（packDir 是**父目录**，不是 pack 本身 —— 传错会得到一片假绿） */
function fixturePack(files) {
    const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'title-grants-'));
    const pack = path.join(packDir, 'probe_pack');
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({
        id: 'probe_pack', name: '探针片', version: '1.0.0', enabled: true
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(pack, name), JSON.stringify(body));
    }
    return packDir;
}

function errorOf(run) {
    try {
        run();
        return null;
    } catch (e) {
        return String(e.message || e);
    }
}

const real = loadView(REAL_PACK_DIR);
const titles = real.dataset('titles');
const grants = real.titleGrantIndex();
const titleIds = titles.map(t => String(t.id));
const zeroSource = titleIds.filter(id => !grants.has(id));

/**
 * 零来源存量名单住在 `game/content/sourceLedgers.js` 的 TITLE_UNREACHABLE_REASONS（2026-09-22 搬过去）：
 * 内容体检报告与这条棘轮必须读同一份，否则会出现"报告说 16 档、测试名单里 15 档"这种没人能解释的分歧。
 * 每条理由都要写清"缺的是哪个出口"，"以后再说"不算理由。
 */
const { TITLE_UNREACHABLE_REASONS: KNOWN_UNREACHABLE } = require('../game/content/sourceLedgers');

describe('称号发放路径账（清单对得上现网，也不许有已经没人用的旧条）', () => {
    test('TITLE_GRANT_PATHS 每一条都真的命中现网内容', () => {
        const dead = TITLE_GRANT_PATHS.filter(p => ![...grants.values()].some(set => set.has(p.by)));
        expect(dead.map(p => p.by)).toEqual([]);
    });

    test('发放路径确实有东西可判（不是空表全过）：被引用的称号数与"零来源"数都对得上', () => {
        expect(titles.length).toBeGreaterThanOrEqual(45);
        expect(grants.size).toBeGreaterThanOrEqual(29);
        expect(zeroSource.length).toBe(titleIds.length - grants.size);
    });

    test('内容里已经没有称号名/称号说明镜像（名字与说明只许住在 titles 里）', () => {
        expect(real.titleMirrorPaths()).toEqual([]);
        // 而且这条判据有东西可判：删掉之前现网真有 22 处（14 处独立行 + 8 处内联），
        // 现在改成"必须为 0"，将来谁再抄一份就当场红（下面那条控制跑证明它真的会红）
        const raw = fs.readFileSync(path.join(CONFIG_DIR, 'multi_dungeon_data.json'), 'utf8');
        expect(raw).not.toMatch(/title_name|title_desc/);
    });

    test('发放路径同层再写 title_name → 启动闸当场抛（只报这一个错）', () => {
        // 直接调这道闸而不是塞一份真资料片：镜像放进 achievement 的 reward 里会先被
        // "未知 reward 键"那道闸拦下（那里管形状），报的就不是本闸的话了（两道闸各判各的事）
        const probe = loadView(REAL_PACK_DIR);
        const achievements = probe.datasets.get('achievement_data');
        const original = JSON.parse(JSON.stringify(achievements));
        achievements.achievements.push({
            id: 'probe_mirror', category: 'cultivation', name: '探针镜像', description: '',
            metric: 'kill_count', target: 1,
            reward: { spirit_stones: 1, title_id: 'hermit', title_name: '隐士' }
        });
        let message = null;
        try {
            probe._validateTitleGrants();
        } catch (e) {
            message = String(e.message || e);
        } finally {
            probe.datasets.set('achievement_data', original);
        }
        expect(message).toContain('称号发放校验失败');
        expect(message).toContain('title_name');
        expect(message).toContain('只有一个来源');
        expect(message.split('\n').filter(l => l.trim().startsWith('- '))).toHaveLength(1);
        // 还原之后再跑一次必须过：证明上面那次红是那份镜像造成的，不是校验器自己坏
        expect(() => loadView(REAL_PACK_DIR)._validateTitleGrants()).not.toThrow();
    });

    test('出参那一刻按词表算名字：titleName(id) 与 titles[id].name 逐条一致', async () => {
        const { initializeModules } = require('../modules');
        await initializeModules();                       // titleNaming 读的是全局 ConfigLoader（与 itemNaming 同一形状）
        const { titleName } = require('../game/content/titleNaming');
        const byId = new Map(titles.map(t => [String(t.id), t]));
        for (const id of grants.keys()) expect(titleName(id)).toBe(byId.get(id).name);
        expect(titleName('probe_never_defined')).toBeNull();
        expect(titleName(null)).toBeNull();
    });

    test('服务端不再读那份镜像（防止有人把 rewards.title_name 改回去）', () => {
        const src = fs.readFileSync(path.join(serverRoot, 'game', 'services', 'MultiDungeonService.js'), 'utf8');
        expect(src).not.toMatch(/rewards\.title_name|r\.title_name/);
        expect(src).toMatch(/titleName\(\s*r\.title_id\s*\)/);
    });

    test('本轮补齐的 10 档副本称号：名字照镜像写回词表，且刻意零加成', () => {
        const byId = new Map(titles.map(t => [String(t.id), t]));
        const fixed = ['yanyue_breaker', 'canglongjiang_zhenjiaozhe_title', 'kunwu_tower_master',
            'xutian_conqueror', 'beiming_breaker', 'luoyun_guardian', 'cangkun_explorer',
            'blood_purgatory_survivor', 'demon_slayer', 'huanglong_master'];
        for (const id of fixed) {
            const row = byId.get(id);
            expect(row).toBeTruthy();
            expect(row.name).toBeTruthy();
            expect(row.bonuses).toEqual({});                 // 纯荣誉档：要给数值等业主签字
            expect(grants.has(id)).toBe(true);              // 而且确实有发放路径指着它
        }
    });
});

describe('零来源存量棘轮（只许变小，且每条都要写清缺哪个出口）', () => {
    test('今天的名单就是这一份：多一档红（新增死称号而没人说）、少一档也红（补上了出口就该把这行删掉）', () => {
        expect(zeroSource.sort()).toEqual(Object.keys(KNOWN_UNREACHABLE).sort());
    });

    test('每条理由要短到能读、长到能说清（"以后再说"不算理由）', () => {
        for (const [id, reason] of Object.entries(KNOWN_UNREACHABLE)) {
            expect(titles.find(t => String(t.id) === id)).toBeTruthy();
            expect(reason.length).toBeGreaterThanOrEqual(20);
        }
    });

    test('资料片新增一档零来源称号 → 启动闸当场抛（存量只棘轮，新增硬拦）', () => {
        const packDir = fixturePack({
            'titles__root.json': {
                into: 'root',
                add: [{ id: 'probe_dead_title', name: '探针死称号', quality: 'rare', description: '', condition: '', bonuses: {} }]
            }
        });
        const message = errorOf(() => loadView(packDir));
        fs.rmSync(packDir, { recursive: true, force: true });
        expect(message).toContain('称号发放校验失败');
        expect(message).toContain('probe_dead_title');
        expect(message).toContain('没有任何发放路径');
    });

    test('对照：同一档称号只要挂上一条发放链就放行（证明上一条红的是"没人发"，不是"资料片不许加称号"）', () => {
        const packDir = fixturePack({
            'titles__root.json': {
                into: 'root',
                add: [{ id: 'probe_live_title', name: '探针活称号', quality: 'rare', description: '', condition: '', bonuses: {} }]
            },
            'achievement_data__achievements.json': {
                into: 'achievements',
                add: [{
                    id: 'probe_title_giver', category: 'cultivation', name: '探针发称号',
                    description: '', metric: 'kill_count', target: 1,
                    reward: { spirit_stones: 1, title_id: 'probe_live_title' }
                }]
            }
        });
        try {
            const view = loadView(packDir);
            expect([...view.titleGrantIndex().get('probe_live_title')].join()).toContain('AchievementService');
        } finally {
            fs.rmSync(packDir, { recursive: true, force: true });
        }
    });
});

describe('引用方向：发放路径指向不存在的称号，启动期就得响', () => {
    test('成就 reward.title_id 写一个没有这一档的 id → 点名这一条（只报这一个错）', () => {
        const packDir = fixturePack({
            'achievement_data__achievements.json': {
                into: 'achievements',
                add: [{
                    id: 'probe_bad_ref', category: 'cultivation', name: '探针错引用',
                    description: '', metric: 'kill_count', target: 1,
                    reward: { spirit_stones: 1, title_id: 'probe_never_defined' }
                }]
            }
        });
        const message = errorOf(() => loadView(packDir));
        fs.rmSync(packDir, { recursive: true, force: true });
        expect(message).toContain('称号发放校验失败');
        expect(message).toContain('probe_never_defined');
        expect(message.split('\n').filter(l => l.trim().startsWith('- '))).toHaveLength(1);
        // 且报的是这道闸的话，不是成就形状那道（两边判同一件事就会分叉）
        expect(message).not.toContain('成就奖励形状校验失败');
    });

    test('这条闸的前提要成立：真的没有任何代码按 condition 发称号（否则 condition 就是第二条发放链，这本账得重写）', () => {
        const sources = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')) sources.push(full);
            }
        })(path.join(serverRoot, 'game'));
        const reads = sources
            .map(f => ({ f, text: fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') }))
            .filter(({ text }) => /\.condition\b/.test(text))
            .map(({ f }) => path.relative(serverRoot, f).replace(/\\/g, '/'));
        expect(reads).toEqual([]);
    });

    test('addTitleToInstance 确实不查词表（这就是为什么引用方向只能靠启动闸）', () => {
        const store = fs.readFileSync(path.join(serverRoot, 'game', 'persistence', 'PlayerStateStore.js'), 'utf8');
        const body = store.slice(store.indexOf('function addTitleToInstance'));
        expect(body).toMatch(/typeof titleId !== 'string'/);
        expect(body).not.toMatch(/getConfig\(['"]titles['"]\)/);
    });
});
