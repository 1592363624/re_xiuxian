/**
 * 道侣/侍妾的两张词表与远航奖励池：能不能只写内容就扩，扩了落不落得下（2026-09-23）
 *
 * 与灵兽稀有度、赌石那两格同一个形状：内容里本来就有表、服务本来就在读配置，
 * 但"有哪几个键、各叫什么"在**路由 + 服务 + 客户端**各抄了一遍，于是资料片加一档就被挡在门外。
 * 这一轮把三处抄本都改成读内容，登记 + 启动闸跟上（台账一次少 5 行：34→…→20）。
 *
 * 同时钉住本轮实测抓到的两件"配了却没人做"：
 *   · `options.*.remnant_soul_cost` —— 结算路径整体不读它（连余额校验都没有），面板却照它印
 *     "· 残魂消耗：15"，确认框还写"将影响…残魂…"。出参层现在把这颗键滤掉（不替业主决定要不要真扣）；
 *   · 远航奖励池里三个 item_keys（rare_treasure_fragment / law_fragment_space / moon_jade_dew）
 *     在 item_data 里根本不存在（英文名 vs 全仓拼音键），抽中就在背包里写一行查无此物。
 *
 * 用法：cd server && npx jest --runInBand tests/CompanionVocabulary.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');

const serverRoot = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(os.tmpdir(), 'xx_companion_vocabulary_fixture');

function loadFixture(files) {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    const dir = path.join(FIXTURE_ROOT, 'cv_probe');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
        id: 'cv_probe', name: '夹具·道侣词表', version: '0.0.1', priority: 999, enabled: true, depends: []
    }));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2));
    }
    const content = new ContentRegistry({ configPath: path.join(serverRoot, 'config'), packDir: FIXTURE_ROOT, statRegistry });
    content.load();
    return content;
}

function expectThrow(files, phrase) {
    let message = '';
    try { loadFixture(files); } catch (err) { message = String(err && err.message || err); }
    expect(message).toContain(phrase);
    return message;
}

/**
 * 两份词表的唯一读入口是全局 ConfigLoader（服务每次现读、不缓存对象，所以热更不需要重启）。
 * 单测进程里没人装配过它，于是按启动时同一扇门（`setMergedConfig`）灌一次真实合并视图，用完原样收回。
 */
const configLoader = require('../modules/infrastructure/ConfigLoader');
const { loadRealContent } = require('./helpers/realContent');
const REAL_COMPANION_DATA = loadRealContent(statRegistry).dataset('companion_data');

function withCompanionData(data, run) {
    const had = configLoader.hasConfig('companion_data');
    const saved = had ? configLoader.getConfig('companion_data') : null;
    configLoader.setMergedConfig('companion_data', data);
    try { return run(); } finally {
        if (had) configLoader.setMergedConfig('companion_data', saved);
        else configLoader.configCache.delete('companion_data');     // 装配过才还，没装配过就收干净
    }
}

const newMode = {
    dataset: 'companion_data', into: 'voyage.modes',
    add: [{
        id: 'zz_star_sea', name: '星渊巡礼', description: '夹具用的一档远航',
        duration_hours: 6, risk_modifier: 1.2, reward_multiplier: 1.4, min_charm: 20
    }]
};
const newModePool = (items) => ({
    dataset: 'companion_data', into: 'voyage.reward_pools',
    add: [{ id: 'zz_star_sea', items }]
});

describe('词表只在内容里有一份（服务、路由、界面都从它取）', () => {
    test('远航模式清单：键、中文名、时长、门槛都来自内容，且按时长排序', () => {
        const ConcubineService = require('../game/services/ConcubineService');
        const modes = withCompanionData(REAL_COMPANION_DATA, () => ConcubineService.voyageModes());
        expect(modes.map(m => m.key)).toEqual(['safe', 'balanced', 'risky', 'moon_palace']);
        expect(modes[0]).toMatchObject({ name: '稳妥', duration_hours: 4, min_charm: 0 });
        expect(modes[modes.length - 1]).toMatchObject({ key: 'moon_palace', duration_hours: 24 });
        // 只改内容（这里灌一份假配置走同一扇门）：新加的一档立刻出现在清单里、且按时长排好
        const fake = { voyage: { modes: { b: { name: '乙', duration_hours: 9 }, a: { name: '甲', duration_hours: 2 } } } };
        expect(withCompanionData(fake, () => ConcubineService.voyageModeKeys())).toEqual(['a', 'b']);
    });

    test('心劫抉择清单同样来自内容；旧事件留下的其它键照常展示但按词表判可不可提交', () => {
        const CompanionService = require('../game/services/CompanionService');
        const choices = withCompanionData(REAL_COMPANION_DATA, () => CompanionService.heartTribulationOptions());
        expect(choices.map(c => c.key)).toEqual(['steady', 'ruthless', 'deceive']);
        expect(choices[0].name).toBe('稳');
        expect(choices[0].success_rate).toBe(0.7);
        // 只改内容就能加第四个选项：路由白名单与面板的可提交判定都跟着这份走
        const four = { heart_tribulation: { options: { steady: { name: '稳', success_rate: 0.7 }, zz_deal: { name: '易', success_rate: 0.4 } } } };
        expect(withCompanionData(four, () => CompanionService.heartTribulationChoiceKeys())).toEqual(['steady', 'zz_deal']);
    });

    test('未知键被拒，且拒绝的理由把合法键列出来（资料片新加的键不会因为"不在代码里"而被挡）', async () => {
        const ConcubineService = require('../game/services/ConcubineService');
        const CompanionService = require('../game/services/CompanionService');
        const voyage = await withCompanionData(REAL_COMPANION_DATA,
            () => ConcubineService.startVoyage(1, 1, 'zz_not_a_mode'));
        expect(voyage.success).toBe(false);
        expect(voyage.message).toContain('safe/balanced/risky/moon_palace');
        const tribulation = await withCompanionData(REAL_COMPANION_DATA,
            () => CompanionService.chooseHeartTribulation(1, 1, 'trust'));
        expect(tribulation.success).toBe(false);
        expect(tribulation.message).toContain('steady/ruthless/deceive');
    });

    test('服务与路由都不再点写这两份词表；界面也不再有第二份字典', () => {
        // 只看真代码：剥掉注释与模板里的 HTML 注释，否则"这段说明提到了某个键"会算成第二份抄本
        const codeOf = abs => fs.readFileSync(abs, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/(^|[^:])\/\/[^'"\n]*/g, '$1')
            .replace(/^\s*\*.*$/gm, '');
        const rel = p => path.join(serverRoot, p);
        expect(codeOf(rel('game/services/ConcubineService.js'))).not.toMatch(/\[\s*'safe'\s*,\s*'balanced'/);
        expect(codeOf(rel('game/services/CompanionService.js'))).not.toMatch(/\[\s*'steady'\s*,\s*'ruthless'/);
        expect(codeOf(rel('routes/concubine.js'))).not.toMatch(/\[\s*'safe'\s*,\s*'balanced'/);
        expect(codeOf(rel('routes/companion.js'))).not.toMatch(/\[\s*'steady'\s*,\s*'ruthless'/);

        const clientRoot = path.join(serverRoot, '..', 'client', 'src');
        const panels = {
            'components/panels/ConcubinePanel.vue': ['moon_palace', '稳妥', '月殿寻痕'],
            'components/panels/CompanionPanel.vue': ['TRIBULATION_CHOICE_LABELS', '残魂消耗', 'steady'],
            'api/companion.ts': ["'steady' | 'ruthless' | 'deceive'", "'safe' | 'balanced'", 'moon_palace']
        };
        for (const [file, banned] of Object.entries(panels)) {
            const text = codeOf(path.join(clientRoot, file));
            // 把命中项攒成一条断言：红的时候直接点名"哪个文件还抄了哪几个键"
            const offenders = banned.filter(needle => text.includes(needle));
            expect(offenders).toEqual([]);
        }
    });
});

describe('奖励池与词表都要对得上（否则"走出去必定空手回来"）', () => {
    test('加一档模式但没给同名奖励池 → 拦，并点名"空手回来而回执正常"', () => {
        const message = expectThrow({ 'companion_data__voyage__modes.json': newMode }, 'zz_star_sea');
        expect(message).toContain('必定空手回来');
    });

    test('池子给了（裸数组与 {id,items:[...]} 两种形状都认）→ 装配通过，服务经 contentList 读得到', () => {
        const content = loadFixture({
            'companion_data__voyage__modes.json': newMode,
            'companion_data__voyage__reward_pools.json': newModePool([
                { type: 'spirit_stones', min: 100, max: 200, weight: 10 },
                { type: 'item', item_keys: ['wild_herb'], weight: 5 }
            ])
        });
        const pools = content.dataset('companion_data').voyage.reward_pools;
        const raw = pools.zz_star_sea;
        // 资料片经 map 集合追加的条目必然是对象，服务侧靠 contentList 取形 —— 这里证明两种形状同源可读
        const { contentList } = require('../game/content/ContentRegistry');
        expect(contentList(raw, []).map(e => e.type)).toEqual(['spirit_stones', 'item']);
        expect(contentList(pools.safe, []).length).toBeGreaterThan(0);      // 基础配置那份裸数组照样读得出
    });

    test('池子里的 type 只认 spirit_stones / item（第三个 if 都没有，写了就是永远不出）', () => {
        expectThrow({
            'companion_data__voyage__modes.json': newMode,
            'companion_data__voyage__reward_pools.json': newModePool([{ type: 'cultivation', min: 1, max: 2, weight: 5 }])
        }, '只认 spirit_stones / item');
    });

    test('item_keys 指向不存在的物品 → 拦（三个英文名的死引用就是这么抓出来的）', () => {
        expectThrow({
            'companion_data__voyage__modes.json': newMode,
            'companion_data__voyage__reward_pools.json': newModePool([{ type: 'item', item_keys: ['moon_jade_dew'], weight: 5 }])
        }, '不是 item_data 里的物品');
    });

    test('现网那份池子本来就对得上（所以硬拦零爆炸半径）：四档模式四份池子、type 全合法', () => {
        const data = require('../config/companion_data.json');
        // 词表里 `_comment` 这类说明键也住在这张表里，服务侧已经把它们滤了，这里按同一口径取
        const modeKeys = Object.keys(data.voyage.modes).filter(key => !key.startsWith('_'));
        expect(modeKeys).toEqual(['safe', 'balanced', 'risky', 'moon_palace']);
        for (const key of modeKeys) {
            const pool = data.voyage.reward_pools[key];
            expect(Array.isArray(pool) && pool.length).toBeTruthy();
            expect(pool.every(entry => entry.type === 'spirit_stones' || entry.type === 'item')).toBe(true);
        }
        // 上一轮从这三处删掉的死引用不许回来。
        // 只看真引用，不扫原文 —— `_comment` 里正写着"原来那个英文名不存在"，扫原文会把自己判红（这条判据第一次就是这么红的）。
        const referenced = modeKeys.flatMap(key => (data.voyage.reward_pools[key] || [])
            .flatMap(entry => Array.isArray(entry.item_keys) ? entry.item_keys : []));
        expect(referenced.length).toBeGreaterThan(0);
        for (const dead of ['rare_treasure_fragment', 'law_fragment_space', 'moon_jade_dew']) {
            expect(referenced).not.toContain(dead);
        }
    });

    test('成功率公式缺任一键 → 拦（NaN 掺进乘加会让远航必定失败）', () => {
        const data = JSON.parse(JSON.stringify(require('../config/companion_data.json')));
        delete data.voyage.success_rate_formula.loyalty_weight;
        const content = loadFixture({});
        content.datasets.set('companion_data', data);
        expect(() => content._validateCompanionVoyage()).toThrow(/loyalty_weight/);
    });

    test('选项 success_rate 越界 → 拦并说清两种越界各自的后果', () => {
        const content = loadFixture({});
        const data = JSON.parse(JSON.stringify(content.dataset('companion_data')));
        data.heart_tribulation.options.steady.success_rate = 0;
        content.datasets.set('companion_data', data);
        expect(() => content._validateCompanionVoyage()).toThrow(/恒 false/);
    });
});

describe('「配了却没人扣」的残魂消耗：出参不再宣传，新增不许再写', () => {
    test('出参投影滤掉没人扣的 cost 与写给开发看的 _comment，其它键一个不少', () => {
        const CompanionService = require('../game/services/CompanionService');
        const projected = CompanionService.projectTribulationOptions({
            _comment: '写给开发看的说明，原文里就出现 remnant_soul_cost 这个词',
            steady: { name: '稳', success_rate: 0.7, intimacy_gain: 10, remnant_soul_cost: 5, _note: '内部批注' },
            legacy_trust: { success_rate: 0.5 },
            fake_probability: 0.3
        });
        // 事件行当初写的是整份 options（含 `_comment`），库里那些旧行不改写也要在出参层拦住
        expect(projected).toEqual({
            steady: { name: '稳', success_rate: 0.7, intimacy_gain: 10 },
            legacy_trust: { success_rate: 0.5 },
            fake_probability: 0.3
        });
        expect(JSON.stringify(projected)).not.toContain('remnant_soul_cost');
        expect(JSON.stringify(projected)).not.toContain('内部批注');
    });

    test('现网三档都写了 cost → 只告警（存量等业主选出口），理由表里没有这一格', () => {
        const content = loadFixture({});
        const warns = content.report.warnings.filter(w => w.includes('remnant_soul_cost'));
        expect(warns).toHaveLength(3);          // steady 5 / ruthless 15 / deceive 0，三档都配了
        expect(warns[0]).toContain('残魂消耗');
    });

    test('这两个服务只以静态方式使用：一个方法漏写 static 就等于那条接口 500', () => {
        // 本轮真的踩到了：投影方法少写了 static，`this.projectTribulationOptions(...)` 在静态方法里是 undefined，
        // 有 pending 心劫的玩家一打开面板就炸 —— 而 1276 项单测与全部 GET 都是绿的（它崩在出参构造那一步）。
        const nonStatic = (where, text) => text.split(/\r?\n/)
            .map((line, i) => ({ line, no: i + 1 }))
            .filter(({ line }) => {
                const m = line.match(/^    (?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_]\w*)\s*\(/);
                if (!m || /^\s*static\b/.test(line)) return false;
                return !['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'const', 'let'].includes(m[1]);
            })
            .map(({ line, no }) => `${where}:${no} ${line.trim()}`);
        const read = rel => fs.readFileSync(path.join(serverRoot, rel), 'utf8');
        for (const rel of ['game/services/CompanionService.js', 'game/services/ConcubineService.js']) {
            expect(nonStatic(rel, read(rel))).toEqual([]);
        }
        // 控制跑：把 static 摘掉一个，判据必须点名那一行（否则这条闸只是摆设）
        const companion = read('game/services/CompanionService.js');
        const hacked = companion.replace('    static projectTribulationOptions', '    projectTribulationOptions');
        expect(hacked).not.toBe(companion);
        const caught = nonStatic('CompanionService.js(控制跑)', hacked);
        expect(caught).toHaveLength(1);
        expect(caught[0]).toContain('projectTribulationOptions(snapshot) {');
    });

    test('资料片新加的选项再写这颗键 → 直接拦（同一族纪律：新账不欠，旧账带理由）', () => {
        expectThrow({
            'companion_data__heart_tribulation__options.json': {
                dataset: 'companion_data', into: 'heart_tribulation.options',
                add: [{ id: 'zz_broker', name: '夹具·交易', success_rate: 0.4, intimacy_gain: 5, remnant_soul_cost: 8 }]
            }
        }, '资料片新增的选项 "zz_broker"');
    });

    test('控制跑：摘掉 voyage.modes 的登记，同一支夹具连装配都过不去（能扩来自登记，不是碰巧）', () => {
        const spec = DATASET_SPECS.companion_data.collections;
        const saved = spec['voyage.modes'];
        delete spec['voyage.modes'];
        try {
            // 未登记的集合不是"静默忽略"而是直接拦 —— 资料片写错 into 时不会装成"生效了"
            expect(() => loadFixture({ 'companion_data__voyage__modes.json': newMode }))
                .toThrow(/companion_data 没有该集合/);
        } finally {
            spec['voyage.modes'] = saved;
        }
        const back = loadFixture({
            'companion_data__voyage__modes.json': newMode,
            'companion_data__voyage__reward_pools.json': newModePool([{ type: 'spirit_stones', min: 1, max: 2, weight: 1 }])
        });
        expect(back.dataset('companion_data').voyage.modes.zz_star_sea.name).toBe('星渊巡礼');
    });
});
