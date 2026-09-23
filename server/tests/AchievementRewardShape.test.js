/**
 * 成就奖励形状门禁：`reward` 里写的每一样，代码都必须真的发得出去
 *
 * 这一族防的还是那件事：**内容写了、界面印了、玩家其实一点也没拿到**。
 * 成就这条链上它已经出现过两次（度量指着不存在的列 → 进度恒 0；计数配了没人写 → 永远停在残值），
 * 这是第三次，形状最阴：`claimReward` 以前只读 `reward.spirit_stones` 与 `reward.exp`，
 * 其余一律 `Number(undefined) || 0`。于是把物品写成 `reward.item`、把称号写成 `reward.title`
 * （这两个名字最自然）时：成就页照样显示"有奖"、玩家照样领、回执照常 success、什么也不报错，
 * 而背包与称号列一个字都不会多 —— 全仓 34 条成就今天确实只用了那两种键（2026-09-22 量过），
 * 所以这条闸拦的是"下一次有人往 reward 里加东西"。
 *
 * 三件要钉的事：
 *   ① 合法键名单 = 服务源码里 `reward.<键>` 的真实取值点（两边不许分叉，所以去扫源码比对）；
 *   ② 启动闸真的会拦（每条坏内容只许报自己那一个错）+ 一份合法扩展必须放行；
 *   ③ 名字在出参那一刻解析：库里与内容里永远只存引用（item_key / title_id），
 *      界面读到的 item_name / title_name 由服务端按合并视图现算 —— 资料片改名字不用回头改成就。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, ACHIEVEMENT_REWARD_KEYS } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const AchievementService = require('../game/services/AchievementService');
const { infrastructure, initializeModules } = require('../modules');

const serverRoot = path.join(__dirname, '..');
const CONFIG_DIR = path.join(serverRoot, 'config');
const REAL_PACK_DIR = path.join(serverRoot, 'content', 'packs');
const SERVICE_FILE = path.join(serverRoot, 'game', 'services', 'AchievementService.js');

/** 去掉注释：块注释按字符抹平但保留换行，整行注释留空行（扫描判据不该被注释里的字骗到） */
function noComments(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '');
}

function buildContent(packDir) {
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir, statRegistry });
    content.load();
    return content;
}

/** 临时资料片：files 是 `文件名 → 内容`，返回 packDir 的父目录（调用方负责删） */
function fixturePack(files) {
    const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-reward-'));
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

/** 往合并视图里塞一条成就再装配（异常照抛给调用方判） */
function loadWithAchievement(achievement, extraFiles = {}) {
    return fixturePack({
        'achievement_data__achievements.json': { into: 'achievements', add: [achievement] },
        ...extraFiles
    });
}

const realContent = buildContent(REAL_PACK_DIR);
const achievements = realContent.dataset('achievement_data').achievements;
const itemIds = new Set(realContent.dataset('item_data').items.map(i => String(i.id)));
const titleIds = new Set(realContent.dataset('titles').map(t => String(t.id)));

const baseAchievement = () => ({
    id: 'probe_reward_shape', category: 'cultivation', name: '探针成就',
    description: '', metric: 'kill_count', target: 1
});

describe('reward 的合法键 = 代码真的读的那几个（名单与实现不许分叉）', () => {
    test('扫服务源码得到的 reward.<键> 取值点，与启动闸的名单逐项相等', () => {
        const src = noComments(fs.readFileSync(SERVICE_FILE, 'utf8'));
        const read = [...new Set([...src.matchAll(/\breward\.([a-z_]+)/g)].map(m => m[1]))].sort();
        expect(read).toEqual([...ACHIEVEMENT_REWARD_KEYS].sort());
    });

    test('四个键里每个都有代码真的去发：灵石/修为加在列上、物品走 grantItems、称号走 addTitleToInstance', () => {
        const src = noComments(fs.readFileSync(SERVICE_FILE, 'utf8'));
        expect(src).toMatch(/player\.spirit_stones\s*=/);
        expect(src).toMatch(/player\.exp\s*=/);
        expect(src).toMatch(/await grantItems\(\s*playerId,\s*itemEntries,\s*t/);     // 同事务，不是自己开一个
        expect(src).toMatch(/addTitleToInstance\(\s*player,\s*titleId\s*\)/);
        // 装不下必须整笔回滚：抛错要发生在把 claimed 置位之前
        expect(src.indexOf('grant.failed.length')).toBeLessThan(src.indexOf('finalRec.claimed = true'));
    });

    test('现网每条成就用到的 reward 键都在名单里（闸不是空转：真内容也在它管辖内）', () => {
        const used = new Set(achievements.flatMap(a => Object.keys(a.reward || {})));
        for (const key of used) expect(ACHIEVEMENT_REWARD_KEYS).toContain(key);
    });

    test('新的两条口子真的有人用：既有成就发物品，也有成就发称号', () => {
        const withItems = achievements.filter(a => Array.isArray(a.reward?.items));
        const withTitle = achievements.filter(a => a.reward?.title_id);
        expect(withItems.length).toBeGreaterThanOrEqual(3);
        expect(withTitle.length).toBeGreaterThanOrEqual(2);
        // 而且引用的东西真的存在（这一条闸也判，但这里要的是"合并视图这一层"的独立证据）
        for (const a of withItems) {
            for (const entry of a.reward.items) {
                const key = typeof entry === 'string' ? entry : entry.item_key;
                expect(itemIds.has(String(key))).toBe(true);
            }
        }
        for (const a of withTitle) expect(titleIds.has(String(a.reward.title_id))).toBe(true);
    });
});

describe('启动闸真的会拦（每条只许报自己那一个错）', () => {
    const cases = [
        ['物品写成 reward.item（最自然也最错的名字）', { item: 'ding_hun_xiang' }, '不是代码认识的奖励键'],
        ['称号写成 reward.title', { title: 'huangfeng_artificer' }, '不是代码认识的奖励键'],
        ['items 写成单个字符串', { items: 'wild_herb' }, '必须是非空数组'],
        ['items 写成空数组', { items: [] }, '必须是非空数组'],
        ['items 里既没有键也不是裸 id', { items: [{ quantity: 2 }] }, '既不是物品 id'],
        ['quantity 写 0', { items: [{ item_key: 'wild_herb', quantity: 0 }] }, '必须是正整数'],
        ['title_id 写成了数字', { title_id: 1001 }, '必须是 titles 里的称号 id'],
        ['灵石给负数', { spirit_stones: -50 }, '非负数'],
        ['分组名不存在', null, '不在 achievement_data.categories 里'],
        ['进度用了每日清零的计数', null, '每日重置口径']
    ];

    for (const [title, reward, needle] of cases) {
        test(`坏内容被拦：${title}`, () => {
            const achievement = { ...baseAchievement() };
            if (reward) achievement.reward = reward;
            const files = {};
            if (needle === '不在 achievement_data.categories 里') achievement.category = 'probe_category';
            if (needle === '每日重置口径') {
                achievement.metric = 'probe_daily_count';
                files['player_metrics__metrics.json'] = {
                    into: 'metrics',
                    add: [{ id: 'probe_daily_count', label: '探针当日计数', from: 'column.exp', resets: 'daily' }]
                };
            }
            const packDir = loadWithAchievement(achievement, files);
            let error = null;
            try {
                buildContent(packDir);
            } catch (e) {
                error = e;
            } finally {
                fs.rmSync(packDir, { recursive: true, force: true });
            }
            expect(error).not.toBeNull();
            const message = String(error.message);
            expect(message).toContain('成就奖励形状校验失败');
            expect(message.split('\n').filter(l => l.trim().startsWith('- '))).toHaveLength(1);
            expect(message).toContain(needle);
        });
    }

    test('对照：合法的新形状（物品带数量 + 称号 + 灵石修为）必须放行', () => {
        // 夹具的 packDir 会把真资料片整个换掉，所以这里只能引用基础配置里就有的物品与称号
        const packDir = loadWithAchievement({
            ...baseAchievement(),
            reward: {
                spirit_stones: 100, exp: 200,
                items: [{ item_key: 'wild_herb', quantity: 2 }, 'condensing_flower'],
                title_id: 'hermit'
            }
        });
        try {
            const content = buildContent(packDir);
            const added = content.dataset('achievement_data').achievements
                .find(a => a.id === 'probe_reward_shape');
            expect(added.reward.title_id).toBe('hermit');
        } finally {
            fs.rmSync(packDir, { recursive: true, force: true });
        }
    });

    test('这条闸不是只会抛：真内容原样装配必须过', () => {
        expect(() => buildContent(REAL_PACK_DIR)).not.toThrow();
    });
});

describe('成就分组词表（categories 已登记成 map 集合：资料片能自带一档分组）', () => {
    const catsOf = content => content.dataset('achievement_data').categories;
    const achOf = content => content.dataset('achievement_data').achievements;

    /** 拿一份夹具装配一次，返回错误文本（没抛就是空串）；夹具目录当场删掉 */
    function errorFromFixture(files) {
        const packDir = fixturePack(files);
        let message = '';
        try {
            buildContent(packDir);
        } catch (e) {
            message = String(e.message || e);
        } finally {
            fs.rmSync(packDir, { recursive: true, force: true });
        }
        return message;
    }

    const groupWithAchievement = (id, name, extraEntry = {}) => ({
        'achievement_data__categories.json': { into: 'categories', add: [{ id, ...extraEntry, ...(name ? { name } : {}) }] },
        'achievement_data__achievements.json': {
            into: 'achievements',
            add: [{ id: `probe_${id}`, category: id, name: '探针成就', description: '', metric: 'kill_count', target: 1, reward: {} }]
        }
    });

    test('现网合并视图里每一档分组都有与键不同的中文名、都被引用、且不写没人在读的 color', () => {
        const cats = catsOf(realContent);
        const keys = Object.keys(cats).filter(k => !k.startsWith('_'));
        expect(keys).toEqual(['cultivation', 'combat', 'wealth', 'social', 'explore', 'trial']);
        const used = new Set(achOf(realContent).map(a => String(a.category)));
        for (const key of keys) {
            const entry = cats[key];
            expect(typeof entry.name).toBe('string');
            expect(entry.name.trim()).toBeTruthy();
            expect(entry.name).not.toBe(key);
            expect(used.has(key)).toBe(true);
            expect(entry.color).toBeUndefined();
        }
        expect(used.isSubsetOf(new Set(keys))).toBe(true);
    });

    test('第 6 套资料片自带的那档分组真的接上了：4 条成就归在 trial 下，名字是「试艺」', () => {
        const cats = catsOf(realContent);
        expect(cats.trial.name).toBe('试艺');
        expect(cats.trial.__content_origin).toBe('huangfeng_trial');   // 来源可查（内容层每个条目都带这个）
        const mine = achOf(realContent).filter(a => String(a.id).startsWith('hf_'));
        expect(mine.length).toBe(4);
        expect(mine.every(a => a.category === 'trial')).toBe(true);
    });

    test('坏内容被拦：新分组没有 name（界面会把裸键印成分组标题）', () => {
        const message = errorFromFixture(groupWithAchievement('probe_no_name', null));
        expect(message).toContain('成就分组词表校验失败');
        expect(message).toContain('没有 name');
    });

    test('坏内容被拦：新分组没有任何成就挂在下面（死分组，界面上根本不会出现）', () => {
        const message = errorFromFixture({
            'achievement_data__categories.json': { into: 'categories', add: [{ id: 'probe_orphan', name: '探针孤儿分组', icon: '✦' }] }
        });
        expect(message).toContain('没有任何成就挂在下面');
    });

    test('坏内容被拦：分组里再写 color（没人读的字段，且那是一份没管过的颜色名清单）', () => {
        const message = errorFromFixture(groupWithAchievement('probe_color', '探针上色', { color: 'fuchsia' }));
        expect(message).toContain('没有人读');
    });

    test('对照：资料片自带一档分组 + 一条挂在它下面的成就，必须放行', () => {
        const packDir = fixturePack(groupWithAchievement('probe_ok_group', '探针分组'));
        try {
            const content = buildContent(packDir);
            expect(content.dataset('achievement_data').categories.probe_ok_group.name).toBe('探针分组');
        } finally {
            fs.rmSync(packDir, { recursive: true, force: true });
        }
    });

    test('出参不再带 category_color（内容里那一格已删，留着就是恒等于 stone 的假字段）', () => {
        const service = fs.readFileSync(path.join(__dirname, '..', 'game', 'services', 'AchievementService.js'), 'utf8');
        expect(service).not.toMatch(/category_color\s*:/);
        expect(service).toMatch(/category_name:/);
    });
});

describe('奖励出参只带名字，内容里只存引用', () => {
    beforeAll(async () => {
        await initializeModules();
        AchievementService.initialize(infrastructure.ConfigLoader);
    });

    test('rewardWithNames 把 item_key / title_id 现算成中文名，裸 id 形按一件算', () => {
        const out = AchievementService.rewardWithNames({
            spirit_stones: 100,
            items: ['ding_hun_xiang', { item_key: 'huangfeng_guest_seal', quantity: 2 }],
            title_id: 'huangfeng_artificer'
        });
        expect(out.items).toEqual([
            { item_key: 'ding_hun_xiang', quantity: 1, item_name: '定魂香' },
            { item_key: 'huangfeng_guest_seal', quantity: 2, item_name: '黄枫谷客卿印' }
        ]);
        expect(out.title_name).toBe('黄枫谷器师');
        expect(out.spirit_stones).toBe(100);
    });

    test('资料片改一次名字，成就页跟着变，成就配置一个字都不用动', () => {
        const loader = infrastructure.ConfigLoader;
        const original = loader.getConfig;
        const items = loader.getConfig('item_data').items;
        loader.getConfig = (name) => (name === 'item_data'
            ? { items: items.map(i => (i.id === 'ding_hun_xiang' ? { ...i, name: '临时改名' } : i)) }
            : original.call(loader, name));
        try {
            expect(AchievementService.rewardWithNames({ items: ['ding_hun_xiang'] }).items[0].item_name).toBe('临时改名');
        } finally {
            loader.getConfig = original;
        }
        expect(AchievementService.rewardWithNames({ items: ['ding_hun_xiang'] }).items[0].item_name).toBe('定魂香');
    });

    test('查不到名字的引用原样带出（界面还能退回键名），也不会把没写的一格凭空造出来', () => {
        const bare = AchievementService.rewardWithNames({ spirit_stones: 1 });
        expect(bare).toEqual({ spirit_stones: 1 });
        expect(AchievementService.rewardWithNames({ items: ['bu_cun_zai'] }).items[0])
            .toEqual({ item_key: 'bu_cun_zai', quantity: 1 });
        expect(AchievementService.rewardWithNames({ title_id: 'bu_cun_zai' }).title_name).toBeUndefined();
        expect(AchievementService.rewardWithNames(undefined)).toEqual({});
    });

    test('词表里被标了 resets 的度量，没有任何成就在用它（每日清零的计数撑不起一次性成就）', () => {
        const table = realContent.dataset('player_metrics').metrics;
        const daily = Object.keys(table).filter(k => table[k].resets);
        expect(daily.length).toBeGreaterThan(0);          // 有东西可判：切磋/斗法就是这一族
        const used = new Set(achievements.map(a => a.metric));
        for (const id of daily) expect(used.has(id)).toBe(false);
    });
});
