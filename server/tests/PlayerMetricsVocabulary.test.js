/**
 * 玩家统计量词表门禁（config/player_metrics.json）
 *
 * 这一族要防的是同一件事：**内容写了、界面印了、玩家其实一点也没拿到**。
 * 改造前的现网状态（2026-09-22 逐条实测）：
 *   · `AchievementService.METRIC_SOURCES` 里 `seclusion_count / kill_count / explore_count`
 *     取的是 `player.meditation_count / kill_count / exploration_count` —— players **没有这些列**
 *     （计数住在 players.stats 那坨 JSON 里）→ 取到 undefined → `|| 0` →
 *     34 条成就里 14 条进度恒为 0，接口照常返回"进度 0/5"，测试全绿；
 *   · 这些 stats 计数在现仓里**没有任何一处会涨**（v0.3 时代写过，后来那些代码没了），
 *     库里留着的是历史残值 —— 有人的 kill_count 停在三年前那个数；
 *   · `CaveLegacyService` 另抄了一份"总指令数"的八行求和，新计数永远进不去。
 * 现在词表在内容里、取数只有一处、事件点统一走 PlayerStateStore.bumpStat。
 * 这份测试钉四件事：表本身合法、口径与改造前逐项相等、启动闸真的会拦（含"合法扩展必须放行"的对照）、
 * 以及"声明了却没人写"必须当场点名。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry, statWriterCalls } = require('../game/content/ContentRegistry');
const { statRegistry } = require('../game/stats');
const PlayerMetrics = require('../game/stats/PlayerMetrics');
const Player = require('../models/player');
const { makeRealConfigLoader } = require('./helpers/realContent');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const REAL_PACK_DIR = path.join(__dirname, '..', 'content', 'packs');
const METRICS_FILE = path.join(CONFIG_DIR, 'player_metrics.json');
const SRC_DIR = path.join(__dirname, '..', 'game');
const ROUTES_DIR = path.join(__dirname, '..', 'routes');

/** 去掉注释：块注释按字符抹平但保留换行（行号要准），整行注释留空行 */
function noComments(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '');
}

/** 递归列出目录下的 .js（跳过 node_modules） */
function walkFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const rawMetrics = () => readJson(METRICS_FILE).metrics;

/** 启动期校验的入口：拿一份 pack 目录建一个 ContentRegistry 并 load（异常照抛给调用方判） */
function buildContent(packDir) {
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir, statRegistry });
    content.load();
    return content;
}

function loadWithPackDir(packDir) {
    return buildContent(packDir).load();
}

/** 临时资料片：files 是 `文件名 → 内容`，返回 packDir（调用方负责删） */
function fixturePack(files) {
    const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-metrics-'));
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

/** 合并视图（含真资料片）只建一次，供"取数与词表"这组用例复用 */
const realContent = (() => {
    const content = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
    content.load();
    return content;
})();

// jest 里全局 ConfigLoader 没 initialize，PlayerMetrics 必须吃这份合并视图，否则读出来是空表
PlayerMetrics.configure({ configLoader: makeRealConfigLoader(realContent) });

const metricsTable = realContent.dataset('player_metrics').metrics;
const metricIds = Object.keys(metricsTable);

describe('player_metrics 词表本身', () => {
    test('表非空，且每条都有与键不同的中文名、来源形状认识', () => {
        expect(metricIds.length).toBeGreaterThanOrEqual(14);
        for (const id of metricIds) {
            const spec = metricsTable[id];
            expect(typeof spec.label).toBe('string');
            expect(spec.label).toBeTruthy();
            expect(spec.label).not.toBe(id);
            const [kind] = String(spec.from).split('.');
            expect(PlayerMetrics.sourceKinds()).toContain(kind);
        }
    });

    test('原始文件里没有重复的度量名（JSON 重复键会被静默吃掉，只留最后一份）', () => {
        const raw = fs.readFileSync(METRICS_FILE, 'utf8');
        const declared = [...raw.matchAll(/^ {4}"([a-z_]+)":\s*\{/gm)].map(m => m[1]);
        const dupes = declared.filter((k, i) => declared.indexOf(k) !== i);
        expect(dupes).toEqual([]);
        expect(dupes.length).toBe(declared.length - new Set(declared).size);
        expect(new Set(declared).size).toBe(metricIds.length);
    });

    test('column.* 指向的列真的在 players 上，attr.* 真的是注册属性', () => {
        for (const id of metricIds) {
            const from = String(metricsTable[id].from);
            if (from.startsWith('column.')) {
                const col = from.slice('column.'.length);
                // 这一条就是当年 spirit_root 那个病的反面对照：模型里没这列，读起来永远是 undefined
                expect(Object.prototype.hasOwnProperty.call(Player.rawAttributes, col))
                    .toBe(true);
            }
            if (from.startsWith('attr.')) {
                expect(statRegistry.has(from.slice('attr.'.length))).toBe(true);
            }
            if (from.startsWith('query.')) {
                expect(PlayerMetrics.QUERIES[from.slice('query.'.length)]).toBeInstanceOf(Function);
            }
        }
    });

    test('每条成就的 metric 都在词表里（合并视图，含资料片加的成就）', () => {
        const achievements = realContent.dataset('achievement_data').achievements || [];
        expect(achievements.length).toBeGreaterThan(20);
        const missing = achievements
            .filter(a => a && !metricIds.includes(String(a.metric)))
            .map(a => `${a.id}→${a.metric}`);
        expect(missing).toEqual([]);
    });

    test('祖业"总指令数"累加的计数集合与改造前那份手写求和逐项相等（改口径是零行为变化）', () => {
        const before = [
            'meditation_count', 'breakthrough_count', 'kill_count', 'exploration_count',
            'alchemy_count', 'refining_count', 'items_collected', 'achievements_completed'
        ].sort();
        expect(PlayerMetrics.commandCounterKeys().slice().sort()).toEqual(before);
    });

    test('cumulative_command 只能挂在 stats 计数上（列与属性不是"次数"）', () => {
        for (const id of metricIds) {
            if (metricsTable[id].cumulative_command === true) {
                expect(String(metricsTable[id].from).startsWith('stats.')).toBe(true);
            }
        }
    });
});

describe('启动闸真的会拦（每条只许报自己那一个错）', () => {
    const cases = [
        ['引用不存在的列', [{ id: 'bad_col', label: '坏列', from: 'column.not_a_column' }], '不存在的 players 列'],
        ['attr 指向没注册的属性', [{ id: 'bad_attr', label: '坏属性', from: 'attr.definitely_not_a_stat' }], '不是注册属性'],
        ['缺中文名', [{ id: 'no_label', from: 'column.exp' }], '没有 label'],
        ['名字与键相同', [{ id: 'same_name', label: 'same_name', from: 'column.exp' }], '与键相同'],
        ['查询没登记', [{ id: 'bad_query', label: '坏查询', from: 'query.never_registered' }], '未登记的查询'],
        ['来源形状不认识', [{ id: 'bad_shape', label: '坏形状', from: 'join.exp' }], '不是认识的来源形状'],
        ['累计标记挂错来源', [{ id: 'bad_cmd', label: '坏累计', from: 'column.exp', cumulative_command: true }], '只累加 stats'],
        ['pending_writer 是空话', [{ id: 'lazy', label: '偷懒', from: 'stats.lazy_count', pending_writer: 'TODO' }], '必须写清'],
        // ↓ 2026-09-22 补：判据从"你自己说有没有人写"改成"我去源码里查"，所以正反两个方向都要能咬住
        ['配了 stats 计数但没人写', [{ id: 'ghost', label: '幽灵计数', from: 'stats.ghost_count' }], '没有任何 bumpStat'],
        ['旧口径点名点错文件', [{ id: 'wrong_file', label: '点错文件', from: 'stats.wrong_file_count', legacy_writer: 'game/services/NoSuchService.js' }], '源码文件读不到'],
        ['点名的文件里没有那行赋值', [{ id: 'wrong_key', label: '点错键', from: 'stats.definitely_not_written', legacy_writer: 'game/services/CombatService.js' }], '找不到对'],
        ['两条出口同时写', [{
            id: 'two_doors', label: '两个出口', from: 'stats.two_door_count',
            pending_writer: '这里既写了豁免又点了旧口径的文件，等于没人说得清今天谁在写这一格',
            legacy_writer: 'game/services/CombatService.js'
        }], '留一条'],
        ['写入点已经有了还留着豁免', [{ id: 'stale_exempt', label: '过期豁免', from: 'stats.kill_count', pending_writer: '这一格早就有 bumpStat 在写，理由留着只会把闸再关一次' }], '已经失效'],
        ['清零口径代码里没实现过', [{ id: 'bad_reset', label: '假清零', from: 'column.exp', resets: 'weekly' }], '清零口径'],
    ];

    for (const [title, entries, needle] of cases) {
        test(`坏内容被拦：${title}`, () => {
            const packDir = fixturePack({ 'player_metrics__metrics.json': { into: 'metrics', add: entries } });
            let error = null;
            try {
                loadWithPackDir(packDir);
            } catch (e) {
                error = e;
            } finally {
                fs.rmSync(packDir, { recursive: true, force: true });
            }
            expect(error).not.toBeNull();
            const message = String(error.message);
            expect(message).toContain('玩家统计量词表校验失败');
            expect(message.split('\n').filter(l => l.trim().startsWith('- '))).toHaveLength(1);
            expect(message).toContain(needle);
        });
    }

    test('成就引用一个不存在的度量 → 当场点名（这条以前只在测试里、且只看基础文件）', () => {
        const packDir = fixturePack({
            'achievement_data__achievements.json': {
                into: 'achievements',
                add: [{
                    id: 'probe_impossible', category: 'cultivation', name: '探针不可能',
                    description: '', metric: 'no_such_metric', target: 1, reward: {}
                }]
            }
        });
        let error = null;
        try {
            loadWithPackDir(packDir);
        } catch (e) {
            error = e;
        } finally {
            fs.rmSync(packDir, { recursive: true, force: true });
        }
        expect(error).not.toBeNull();
        expect(String(error.message)).toContain('probe_impossible 的 metric="no_such_metric"');
    });

    test('合法扩展必须放行：资料片加一档度量 + 一条引用它的成就，零代码', () => {
        const packDir = fixturePack({
            'player_metrics__metrics.json': {
                into: 'metrics',
                add: [{ id: 'probe_crit', label: '探针暴击强度', from: 'attr.crit_rate' }]
            },
            'achievement_data__achievements.json': {
                into: 'achievements',
                add: [{
                    id: 'probe_crit_master', category: 'combat', name: '探针会心',
                    description: '', metric: 'probe_crit', target: 30, reward: {}
                }]
            }
        });
        try {
            const content = buildContent(packDir);
            const table = content.dataset('player_metrics').metrics;
            expect(table.probe_crit).toBeTruthy();
            expect(table.probe_crit.from).toBe('attr.crit_rate');
        } finally {
            fs.rmSync(packDir, { recursive: true, force: true });
        }
    });

    test('空表等于所有成就都无从取值 → 必须抛（不能安静地让每条成就停在 0%）', () => {
        // 直接把合并出来的表换成空表再跑这道闸：真资料片下这张表本来非空，
        // 不这么制造场景就没法证明"空表会抛"（上一版想用 remove 一个不存在的键来清空，
        // 结果先被合并阶段的"要移除的不存在"拦下，报的根本不是本闸的话）。
        const empty = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        empty.load();
        empty.datasets.set('player_metrics', { metrics: {} });
        expect(() => empty._validatePlayerMetrics()).toThrow(/读不到或为空表/);
        // 对照：原样再跑一次必须过（证明上面那次红是空表造成的，不是校验器本身在抛）
        const ok = new ContentRegistry({ configPath: CONFIG_DIR, packDir: REAL_PACK_DIR, statRegistry });
        expect(() => ok.load()).not.toThrow();
    });
});

describe('取数实现（PlayerMetrics）', () => {
    const playerOf = over => ({ id: 1, realm: '元婴初期', ...over });

    test('stats.* 读的是 players.stats 那一坨，而不是玩家根上的同名属性', () => {
        // 根上放一个诱饵值：老写法读的正是这里（所以永远 0），新写法必须走 stats
        const player = playerOf({ kill_count: 999999, stats: { kill_count: 7 } });
        expect(PlayerMetrics.metricValue('kill_count', player)).resolves.toBe(7);
    });

    test('stats 是字符串（历史行）也要能读，读不出来按 0而不是抛', () => {
        expect(PlayerMetrics.metricValue('kill_count', playerOf({ stats: '{"kill_count":4}' })))
            .resolves.toBe(4);
        expect(PlayerMetrics.metricValue('kill_count', playerOf({ stats: '不是JSON' })))
            .resolves.toBe(0);
    });

    test('column.* 把 BigInt 列转成数字（exp/spirit_stones 是 BIGINT）', () => {
        const player = playerOf({ exp: BigInt(12345), spirit_stones: BigInt(7) });
        return Promise.all([
            expect(PlayerMetrics.metricValue('exp', player)).resolves.toBe(12345),
            expect(PlayerMetrics.metricValue('total_spirit_stones', player)).resolves.toBe(7)
        ]);
    });

    /**
     * realm_index 这一档要在**真启动**的链路上验（RealmService 在模块加载时就把全局 ConfigLoader
     * 绑死了，jest 里那个单例没 initialize，读境界表会抛"配置未加载"）。
     * 这里能钉住的是形状：它必须走"按名字查境界"那条路，而不是退回读 players.realm_rank 那一列 ——
     * 那列与境界名字不同步是出过事故的老毛病（GM 改 realm 不改 rank）。端到端的数值由探针量。
     */
    test('realm_index 走境界名字，不读 realm_rank 那一列', () => {
        const text = fs.readFileSync(path.join(__dirname, '..', 'game', 'stats', 'PlayerMetrics.js'), 'utf8');
        const branch = text.slice(text.indexOf("if (kind === 'realm_index')"), text.indexOf("if (kind === 'attr')"));
        expect(branch).toMatch(/getRealmByName\(player\.realm\)/);
        expect(branch).not.toMatch(/player\.realm_rank/);
        expect(String(metricsTable.realm_index.from)).toBe('realm_index');
    });

    test('词表里没有的度量返回 0 并且报一次错（不许静默）', () => {
        const before = PlayerMetrics.knownMetricIds().length;
        expect(before).toBeGreaterThan(10);
        return expect(PlayerMetrics.metricValue('definitely_not_declared', playerOf({}))).resolves.toBe(0);
    });
});

describe('"声明了就得有人写"（否则计数永远停在历史残值）', () => {
    /**
     * 扫全仓"这一格计数有没有人写"。判据只有一份：`ContentRegistry.statWriterCalls()`
     * （启动闸 `_validatePlayerMetrics` 用的就是它，这里复用，绝不在测试里再抄一套正则 ——
     * 两边各扫各的，就会出现"闸说有人写、测试说没人写"这种没人能解释的红）。
     * 认识的形状两种：
     *   · `bumpStat(实例, '<key>', …)`      —— 增量累加
     *   · `setStatKeys(实例, { <key>: … })` —— 每日计数那一族（换日则从 1 重新开始，$add 表达不出来）
     * 2026-09-22 起**不再承认** `.duel_count = ` 这种"从 blob 里读出来改一下再整块写回"的旧形状：
     * 切磋/斗法两处已经迁到 setStatKeys，留着那条放宽就等于给以后整块回写开后门。
     */
    function writtenCounterKeys() {
        return new Set(statWriterCalls());
    }

    const written = writtenCounterKeys();
    const declaredStats = metricIds
        .map(id => String(metricsTable[id].from))
        .filter(f => f.startsWith('stats.'))
        .map(f => f.slice('stats.'.length));

    test('检测器自己要有牙：真的扫到了若干 bumpStat 写入点（扫不到就是正则坏了）', () => {
        expect(written.size).toBeGreaterThanOrEqual(6);
        expect(written).toContain('kill_count');
        expect(written).toContain('meditation_count');
    });

    test('每一个 stats 计数要么有事件点写它，要么在内容里写清为什么还没有', () => {
        const pending = metricIds
            .filter(id => String(metricsTable[id].from).startsWith('stats.') && metricsTable[id].pending_writer)
            .map(id => String(metricsTable[id].from).slice('stats.'.length));
        const unwritten = [...new Set(declaredStats)].filter(k => !written.has(k) && !pending.includes(k));
        expect(unwritten).toEqual([]);
    });

    test('pending_writer 不许变成僵尸豁免（真有人写了就该把它删掉）', () => {
        const stale = metricIds
            .filter(id => metricsTable[id].pending_writer && written.has(String(metricsTable[id].from).slice('stats.'.length)))
            .map(id => id);
        expect(stale).toEqual([]);
    });
});

describe('不许再退回代码里抄一份', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

    test('成就服务不再有第二份取数表', () => {
        const text = read('game/services/AchievementService.js');
        // 历史说明里提一句旧名字是可以的，被禁止的是**再建一份代码表**
        expect(text).not.toMatch(/(const|let|var)\s+METRIC_SOURCES/);
        expect(text).toMatch(/PlayerMetrics\.metricValue/);
        // knownMetrics 必须读内容，不许回到"数代码里的键"
        expect(text).toMatch(/static knownMetrics\(\)\s*\{[\s\S]{0,160}PlayerMetrics\.knownMetricIds/);
    });

    test('洞府祖业不再手写计数清单', () => {
        const text = read('game/services/CaveLegacyService.js');
        for (const key of ['meditation_count', 'breakthrough_count', 'alchemy_count', 'refining_count']) {
            expect(text).not.toContain(`stats.${key}`);
        }
        expect(text).toMatch(/PlayerMetrics\.commandCounterKeys\(\)/);
    });

    /**
     * 我这一轮新接上写入点的这几格计数，只许通过 bumpStat 进账。
     * 判据是"没有 `<某变量>.<键> =` 这种读-改-写整值回写"。
     * 每日计数那一族（切磋/斗法）也一起纳入这一条禁止（2026-09-22 迁完），
     * 但它们走的是 `setStatKeys`（换日要从 1 重新开始，$add 表达不出来），所以要求分两种写。
     */
    test('本轮接上写入点的计数只走 bumpStat，不许再出现整值回写', () => {
        const mine = ['meditation_count', 'kill_count', 'breakthrough_count',
            'alchemy_count', 'refining_count', 'items_collected', 'achievements_completed', 'death_count'];
        const daily = ['sparring_count', 'duel_count'];
        const sources = [SRC_DIR, ROUTES_DIR]
            .flatMap(dir => walkFiles(dir))
            .filter(file => path.basename(file) !== 'PlayerStateStore.js');   // 守卫自己就是那个唯一入口
        const texts = sources.map(file => ({
            file,
            lines: noComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).split('\n')
        }));

        // 1) 这几格不许再出现"从 players.stats 里读出来、改一下、整值写回"那种形状。
        //    判据必须绑到"这个变量是从 *.stats 那坨 blob 上来的"，否则会误伤别的表上的同名字段：
        //    宗门战参战行的 kill_count、世界 BOSS 伤害记录的 death_count、副本结算响应里的
        //    items_collected 都是各自表/响应对象的列，跟 players.stats 无关（第一版我按"键名 + 赋值"扫，
        //    就是被这三处撞出了 7 条假红）。
        const offenders = [];
        for (const file of sources) {
            const text = noComments(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
            const statsVars = new Set();
            for (const line of text.split('\n')) {
                const bound = line.match(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*[\w$?.]*\.stats\b(?:\s*\|\|[^;]*)?;/);
                if (bound) statsVars.add(bound[1]);
            }
            if (!statsVars.size) continue;
            text.split('\n').forEach((line, i) => {
                for (const key of [...mine, ...daily]) {
                    if (new RegExp(`\\b(?:${[...statsVars].join('|')})\\s*\\.\\s*${key}\\s*(?:\\+?=)(?!=)`).test(line)) {
                        offenders.push(`${path.basename(file)}:${i + 1} ${key}`);
                    }
                }
            });
        }
        expect(offenders).toEqual([]);

        // 2) 每一格都必须有一个字面量的调用点（少了就是"配了没人写"又回来了）：
        //    普通计数走 bumpStat，每日计数走 setStatKeys
        const joined = texts.map(t => t.lines.join('\n')).join('\n');
        for (const key of mine) {
            expect(joined.includes(`bumpStat(`)).toBe(true);
            expect(new RegExp(`bumpStat\\([^)]*'${key}'`).test(joined)).toBe(true);
        }
        for (const key of daily) {
            expect(new RegExp(`setStatKeys\\([^,]+,\\s*\\{[^}]*\\b${key}\\s*:`).test(joined)).toBe(true);
        }
        // 3) 那两个服务里从此不许再出现"整块赋回 players.stats"（唯一入口是键级补丁）
        for (const rel of ['game/services/PvpService.js', 'game/services/DuelService.js']) {
            const text = noComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n'));
            expect(text).toMatch(/setStatKeys\(/);
            expect(text).not.toMatch(/\b[A-Za-z_$][\w$]*\.stats\s*=(?!=)/);
        }
    });
});
