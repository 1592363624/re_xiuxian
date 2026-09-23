/**
 * 内容完整性 + 写入卫生 静态门禁
 *
 * 两类问题过去只能靠"启动一次看看炸不炸"或人工审出来，而它们的表征都是
 * "玩家数据不对"而不是报错，所以必须有一道自动化闸：
 *   1. config 目录与 content/packs 下的每个 json 都必须能被解析，
 *      且能通过内容层的启动期校验（属性键、跨表引用、派生公式）。
 *   2. players 的 JSON 大字段（attributes/stats/titles/time_system_data）
 *      只能由"锁内读→补丁写"的方式落库。新文件想用旧写法，这个测试就会红。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ContentRegistry, DATASET_SPECS } = require('../game/content/ContentRegistry');
const { StatRegistry } = require('../game/stats/StatRegistry');

const serverRoot = path.join(__dirname, '..');
const configDir = path.join(serverRoot, 'config');
const packDir = path.join(serverRoot, 'content', 'packs');

function walkJs(dirs) {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
    };
    for (const dir of dirs) if (fs.existsSync(dir)) walk(dir);
    return out;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('配置与资料片数据可解析', () => {
    const jsonFiles = [
        ...fs.readdirSync(configDir).filter(n => n.endsWith('.json')).map(n => path.join(configDir, n)),
        ...(fs.existsSync(packDir)
            ? walkJs([packDir]).filter(f => f.endsWith('.json'))
            : [])
    ];

    test.each(jsonFiles)('%s 是合法 JSON', (file) => {
        // 踩过的坑：改 game_balance.json 时把 \n 写成了真实换行，
        // 单测全绿（测试都 mock 配置），只有真启动才炸 —— 所以这里必须逐个 parse。
        expect(() => readJson(file)).not.toThrow();
    });

    test('内容层能装配真实配置 + 全部资料片（属性键、跨表引用都过校验）', () => {
        const registry = new StatRegistry();
        const content = new ContentRegistry({ configPath: configDir, packDir, statRegistry: registry });
        expect(() => content.load()).not.toThrow();
        expect(registry.has('atk')).toBe(true);
        expect(registry.count).toBeGreaterThan(15);
    });

    test('每个资料片都有合法 manifest，且启用的 pack 至少带一个数据集', () => {
        if (!fs.existsSync(packDir)) return;
        for (const entry of fs.readdirSync(packDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(packDir, entry.name);
            if (!fs.existsSync(path.join(dir, 'pack.json'))) continue;
            const manifest = readJson(path.join(dir, 'pack.json'));
            expect([manifest.id, typeof manifest.version]).toEqual([entry.name, 'string']);
            const datasets = fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'pack.json');
            expect([entry.name, datasets.length > 0]).toEqual([entry.name, true]);
            for (const file of datasets) {
                const name = file.replace(/\.json$/, '');
                // <dataset> 或 <dataset>__<集合路径>：文件名必须落在已登记的数据集/集合上，
                // 否则 ContentRegistry 只会警告并跳过，资料片内容静默不生效。
                // 集合路径可以有多层（cave_data__cave__garden__seeds → cave.garden.seeds），
                // 只取第二段当集合名会把三层以上的文件判成"没登记"—— 这条 pack 就是这么撞出来的。
                const [dataset, ...rest] = name.split('__');
                const collection = rest.join('.');
                const spec = DATASET_SPECS[dataset];
                const target = collection ? spec?.collections?.[collection] : !!spec;
                expect([`${entry.name}/${name}`, !!target]).toEqual([`${entry.name}/${name}`, true]);
            }
        }
    });
});

describe('players JSON 大字段的写入卫生', () => {
    /**
     * 允许出现"整块 JSON 赋值"的文件清单。每一处都经 2026-09-20 逐个核对：
     * 被写的行在同一事务内先用 FOR UPDATE 锁住、或在锁内重读过，因此不构成
     * 旧快照覆盖新快照。新增条目必须补一句依据，否则等于放开闸。
     */
    const REVIEWED_BLOB_WRITERS = {
        // 锁内 helper：调用方全部持有 FOR UPDATE 的玩家行
        // 2026-09-20：Ascension / SecondSoul 的神识 helper、LawService 的转换、AttributeService 的加点
        // 改成 PlayerStateStore.mirrorPatchedBlob（只镜像内存、不标脏），四家已从此表退出 ——
        // 补丁落库后调用方那份实例不再参与整块写回，这张表因此又短了一截。
        'game/services/SecondSoulService.js': '仅剩 soul.attributes（player_second_soul 行），不写 players 整块列',
        'routes/admin.js': 'GM 重置整号，语义就是全量覆盖'
        // 2026-09-23：routes/attribute.js 的 /reset 退出这张表 —— 它以前"锁内读出整行 → 摊平 attributes
        // 改三个键 → 赋回实例 → save 整行"。现在回收的那几个 *_bonus 按 $add 负增量（$min 在行锁内夹 0）、
        // 加点账本用 null 删键、冷却时点写一个键，扣费与退点走列上原子加减；一次重置只碰它该碰的那几个键。
        // 判据：tests/AttributePillAndReset.test.js 那两条补丁断言（无关的键不许出现在补丁里）
        // + scripts/smoke_write_crossflow.js 的 P5/P5b/P6（真 HTTP：退点与回收按回执落地、
        // 账本删掉、哨兵键与另一条链同时写的键都在、灵石净变化 == +发放 − 扣费、同时点两次只成一次）。
        // 2026-09-23：NascentSoulService 退出这张表 —— 出窍 / 凝练法相 / 探寻裂缝 / 天机回溯 四条链
        // 各自抄了一份"摊平 attributes → 改 sense → 赋回实例 → save 整行"，四份兜底还各不相同
        // （境界基数 / 10 / 10 / 0）。现在读与扣都在 game/core/sensePool.js 一处，
        // 四条链只写 attributes.sense 这一个键（行锁内 $add + $min）。
        // 顺带修掉 `attrs.sense || 兜底` 把 **0 当成"键不存在"**：神识是可以正常花光的
        // （`current < cost` 拒绝、等于就通过 → 正好扣到 0），于是"用光了"的人下一次会白拿一份兜底余额。
        // 现在 0 是合法余额，兜底只在键缺失/非数值时生效，且由调用点显式传。
        // 2026-09-23：SectWarService 退出这张表 —— joinWar 那处"摊平 attributes 改四个键再整块赋回 + save 整行"
        // 与 attackPlayer 双方的两段同类写法，全部改成 PlayerStateStore 的键级补丁（leaveWar 早就在这个形状上）。
        // 这两处原本并不丢账（一笔事务里两边都持行锁），所以这一格的价值是**不再靠锁才算安全**：
        // players.attributes 这一坨里住着十几个别的流程写的键，只要有人在同一条链上少写一句 FOR UPDATE，
        // 整块写回就立刻变成真丢数据；键级补丁把这件事变成不可能。
        // 2026-09-23：InventoryService 退出这张表 —— 使用物品（丹药）那条链以前是
        // "改手上那份实例 + 最后整块 save()"：血蓝按上限钳制、灵石/修为/寿元/丹毒按旧值算绝对值、
        // 属性丹整块替换 attributes。现在钳制值与增量都在 PlayerStateStore 一次键级落库
        // （灵石/修为/寿元走列上原子加、丹毒走原子减并由 store 夹到 0、属性丹按 $add 差分），
        // 回执要的数从落库那一份镜像回实例（不标脏）。
        // 2026-09-22：ReincarnationService.chooseTarget 与 routes/breakthrough 双双退出这张表 ——
        // 前者改成"标量列写在实例上 + 继承账走 patchPlayerState 键级补丁"，后者那段
        // "往 blob 里写 atk/def/hp_max/mp_max"整块删掉（那几个键没人读，写了只是留下陈旧快照）。
        // 少了一处整块写也要让这条断言红一次，才会逼着有人回来更新这张表：见下面那条 stale 检查。
        // 同日 DuelService / PvpService 也退出：切磋与斗法的每日计数改走 PlayerStateStore.setStatKeys
        // 键级补丁之后，这两个文件里已经没有整块赋回了。
        // 2026-09-23：WorldBossService / BeastInvasionService 退出 —— 那两份逐字相同的
        // `_applyDeathExpPenalty`（"绝对值写 exp + 把 attributes 整块赋回去"）合并成
        // `game/core/deathPenalty.js` 一份实现，写的是列上原子减，blob 镜像由 PlayerStateStore 维护。
        // （顺带一条自坑记录：第一版我在注释里写了 \`player.stats = {...}\` 作对比说明，
        //  扫描器不剥注释，于是这两条登记"看起来仍然成立"、stale 检查没有响 ——
        //  注释里出现被判据匹配的代码形状，会把一张本该变短的表钉住。判据能读到的文本要干净。）
    };

    // (?!=) 排除 `===` 比较：不写这个，`typeof player.attributes === 'string'` 会被当成赋值。
    // 右侧不限定形态：`player.stats = stats`（赋变量而不是字面量）也要抓到。
    // 注意这张网只是"提醒有人来看"，不是执行点：`{ attributes: ... }` 这种对象字面量写法
    // （Player.update / instance.update）正则分不清"整块写回"还是"键级补丁"，
    // 真正的拦截在 players 的 beforeSave / beforeBulkUpdate 两个钩子上（blobWriteGuard），
    // 由 smoke_write_concurrency 的 S7 连着真库验过。
    const BLOB_PATTERNS = [
        /\.attributes\s*=(?!=)/,
        /\.stats\s*=(?!=)/,
        /\.time_system_data\s*=(?!=)/,
        /\.titles\s*=(?!=)/,
        /\.spirit_roots\s*=(?!=)/
    ];

    // 作用于 toJSON() 出来的普通对象（不参与写库）的站点，按文件登记
    const NON_PERSISTED_ASSIGNEES = {
        'game/core/PlayerService.js': 'getPlayerData 里规范化 player.toJSON() 的结果，不写库'
    };

    const scanned = walkJs([
        path.join(serverRoot, 'game'),
        path.join(serverRoot, 'routes')
    ]).filter(f => !f.includes(`${path.sep}persistence${path.sep}`));

    const offenders = [];
    for (const file of scanned) {
        const relative = path.relative(serverRoot, file).split(path.sep).join('/');
        const lines = fs.readFileSync(file, 'utf-8').split('\n')
            // 整行注释 / JSDoc 行不参与匹配：这道网抓的是"代码里把整块 JSON 赋回去"，
            // 说明文字里写一句 `player.attributes = …` 不算命中（第一版就被自己写的注释判红过）。
            .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line));
        const hits = lines.filter(line => BLOB_PATTERNS.some(re => re.test(line)));
        if (!hits.length) continue;
        if (NON_PERSISTED_ASSIGNEES[relative]) continue;
        if (!REVIEWED_BLOB_WRITERS[relative]) {
            offenders.push(`${relative}: ${hits.length} 处未登记的整体 JSON 赋值`);
        }
    }

    test('没有未登记的 players JSON 整体赋值（要新增就得登记并说明为何安全）', () => {
        expect(offenders).toEqual([]);
    });

    test('登记表里的文件确实还在写，否则应从表中删掉（避免清单只增不减）', () => {
        const stale = Object.keys(REVIEWED_BLOB_WRITERS).filter(relative => {
            const file = path.join(serverRoot, relative);
            if (!fs.existsSync(file)) return true;
            const lines = fs.readFileSync(file, 'utf-8').split('\n');
            return !lines.some(line => BLOB_PATTERNS.some(re => re.test(line)));
        });
        expect(stale).toEqual([]);
    });

    test('每一处整块写回都还在用行锁：登记理由不能只是注释', () => {
        // 这张表之所以允许"整块赋值"，唯一依据是"被写的行在同一事务里先 FOR UPDATE 锁住了"。
        // 依据只写在注释里，就等于谁删掉那行 lock 都不会有人发现 —— 而删掉 lock 的表现
        // 正是本次改造要根治的那一类：旧快照覆盖新快照、玩家数据静默丢失。
        const unguarded = [];
        for (const relative of Object.keys(REVIEWED_BLOB_WRITERS)) {
            const file = path.join(serverRoot, relative);
            if (!fs.existsSync(file)) continue;
            const source = fs.readFileSync(file, 'utf-8');
            if (!/LOCK\.UPDATE|readForUpdate\(/.test(source)) unguarded.push(relative);
        }
        expect(unguarded).toEqual([]);
    });

    test('祭炼系数只有属性注册表一处定义', () => {
        // 以前 game_balance 里另抄了一份 bonus_per_level，两处必然漂移：
        // 新属性在注册表里有 refineRate，却不在旧清单里，表现为"祭炼到满级也不涨"。
        const gameBalance = readJson(path.join(configDir, 'game_balance.json'));
        expect(gameBalance.equipment?.refine?.bonus_per_level).toBeUndefined();

        const registry = new StatRegistry();
        registry.load(readJson(path.join(configDir, 'stat_definitions.json')).stats, 'base');
        const rates = registry.refineRateMap();
        expect(rates.atk).toBe(0.05);
        expect(rates.speed).toBe(0.03);
    });

    test('物品 effect 的属性键不含祭炼/属性系统之外的野键', () => {
        const registry = new StatRegistry();
        const content = new ContentRegistry({ configPath: configDir, packDir, statRegistry: registry });
        content.load();   // _validateItemEffects 会在有野键时抛错

        const items = content.dataset('item_data').items;
        const unrecognized = [];
        for (const item of items) {
            for (const [key, value] of Object.entries(item.effect || {})) {
                if (typeof value !== 'number') continue;
                if (!content.isKnownEffectKey(key)) unrecognized.push(`${item.id}.${key}`);
            }
        }
        expect(unrecognized).toEqual([]);
    });
});

/**
 * scripts/validate_content.js 是资料片作者的离线体检入口，也是这道闸的 CI 形态：
 * 只要现网内容（基础 + 资料片）让启动期校验过不去，这条就红，不必真的把服务起起来。
 */
describe('内容体检命令 validate_content.js', () => {
    const { execFile } = require('child_process');

    function runValidator() {
        return new Promise((resolve, reject) => {
            execFile(process.execPath, [path.join(serverRoot, 'scripts', 'validate_content.js'), '--json'],
                { cwd: serverRoot, maxBuffer: 8 * 1024 * 1024 },
                (error, stdout, stderr) => {
                    if (error && !stdout) {
                        reject(new Error(`${error.message}\n${stderr}`));
                        return;
                    }
                    try {
                        resolve({ result: JSON.parse(stdout), stderr });
                    } catch (parseError) {
                        reject(new Error(`stdout 不是纯 JSON: ${parseError.message}\n${stdout.slice(0, 500)}\n${stderr}`));
                    }
                });
        });
    }

    test('--json 只往 stdout 打 JSON，并且现网内容全部通过校验', async () => {
        const { result } = await runValidator();
        expect(result.ok).toBe(true);
        expect(result.error).toBeNull();
        expect(result.packs.length).toBeGreaterThanOrEqual(2);
        expect(result.datasets.item_data).toBeGreaterThan(400);
        expect(Object.values(result.datasets).every(n => n > 0)).toBe(true);
    }, 60000);

    test('登记的每一个属性都有人用（没有只进面板的孤立属性）', async () => {
        const { result } = await runValidator();
        expect(result.unusedStats).toEqual([]);
    }, 60000);
});

/**
 * 成就的"度量"词表：achievement_data 里每条成就靠 metric 决定进度怎么算，
 * 取数函数登记在 AchievementService.METRIC_SOURCES。
 * 两边对不上时不会报错，只会让那条成就永远停在 0%（以前 friend_count 就是 `() => 0` 的占位实现，
 * social_butterfly「广结善缘」目标 5 —— 一条正式内容里的成就，玩家无论怎么做都拿不到）。
 */
describe('成就度量必须真的有人计算', () => {
    const achievementPath = path.join(configDir, 'achievement_data.json');

    test('现网每一条成就的 metric 都在词表里（读合并视图，资料片加的那两边都算）', () => {
        // 2026-09-22：词表从 AchievementService 的代码表搬进 config/player_metrics.json，
        // "knownMetrics() 返回代码里的键"这个判据本身就不成立了 —— 它既看不见资料片加的度量，
        // 也看不见资料片加的成就（原来只读基础文件）。现在两边都从 ContentRegistry 的合并视图取；
        // 来源形状是否真取得到数由启动闸 _validatePlayerMetrics 判，"配了没人写"由
        // tests/PlayerMetricsVocabulary.test.js 判（那里还有"合法扩展必须放行"的对照）。
        const { loadRealContent, makeRealConfigLoader } = require('./helpers/realContent');
        const { statRegistry } = require('../game/stats');
        const content = loadRealContent(statRegistry);
        const known = new Set(Object.keys(content.dataset('player_metrics').metrics || {})
            .filter(k => !k.startsWith('_')));
        const achievements = content.dataset('achievement_data').achievements || [];

        const unmapped = [...new Set(achievements.map(a => a.metric))]
            .filter(m => !known.has(m));
        expect(unmapped).toEqual([]);
        expect(known.size).toBeGreaterThan(10);
        // 资料片是"往集合里加条目"，所以合并视图只会 ≥ 基础文件；少了说明某片整块替换掉了基础成就
        const baseAchievements = JSON.parse(fs.readFileSync(achievementPath, 'utf8')).achievements || [];
        expect(achievements.length).toBeGreaterThanOrEqual(baseAchievements.length);

        // 恒 0 的度量等于"这条成就永远完成不了"，和拼错 metric 是同一个后果
        const serviceSource = fs.readFileSync(
            path.join(serverRoot, 'game', 'services', 'AchievementService.js'), 'utf8'
        ).replace(/\r\n/g, '\n');
        const stubs = [...serviceSource.matchAll(/^\s{4}([a-z_]+): \(\) => 0,?$/gm)].map(m => m[1]);
        expect(stubs).toEqual([]);
    });
});

/**
 * 内容主键不许在代码里被枚举。
 *
 * 为什么单独一道闸：把数据集登记进内容层，只做到"资料片加得进来"；如果服务里还抄着一份
 * `['yanyue','duanwu',...]` 这样的主键白名单，加进来的那条内容会当场被校验挡回去 ——
 * 于是"支持 DLC"这句话只兑了一半，而且失败方式很隐蔽：内容层日志一切正常，玩法里就是没有。
 * 改造前 `multi_dungeon_data` 的 10 个副本键在这一个文件里被抄了 5 遍，
 * 每加一个副本都要改这 5 处（那些注释本身就是每次都手写一遍的痕证）。
 */
/**
 * 不许直接 require 配置文件。
 *
 * `require('../config/x.json')` 会被 Node 永久缓存：热更接口改了内存里的配置、
 * 资料片合并进来的内容、甚至运维直接改文件，这条读取路径都看不见 ——
 * 而它读到的值往往就是玩法开关/倍率/名字，表现是"配了不生效"。
 * 2026-09-21 清掉的 4 处：切磋木人结算时间（注释还写着"支持热更新"）、灵兽PVP元素表、
 * 跨图播报的宗门名（资料片新开的宗门在播报里没名字）、通知图标。
 */
describe('game/ 与 routes/ 不许绕过 ConfigLoader 直接 require 配置', () => {
    const DIRECT = /require\(\s*['"][^'"]*config\/([A-Za-z0-9_-]+)\.json['"]\s*\)/g;

    // 只扫真正会执行的代码：修好之后的注释里会提到旧写法（本文件自己的说明就是），不该被算成命中
    const stripComments = (text) => text.replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\/[^\n]*$/gm, '');

    function scan(text) {
        return [...stripComments(text).matchAll(DIRECT)].map(m => m[1]);
    }

    test('一处都没有', () => {
        const offenders = [];
        for (const file of walkJs([path.join(serverRoot, 'game'), path.join(serverRoot, 'routes')])) {
            for (const name of scan(fs.readFileSync(file, 'utf8'))) {
                offenders.push(`${path.relative(serverRoot, file).split(path.sep).join('/')} → ${name}.json`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('检测器本身不是空转：能认出旧的直接 require 写法', () => {
        expect(scan("const c = require('../../config/sect_data.json');")).toEqual(['sect_data']);
        expect(scan("const c = require('./config/sparring_woodman.json')")).toEqual(['sparring_woodman']);
        expect(scan("const db = require('../../config/database');")).toEqual([]);
    });
});

describe('内容主键不许在代码里枚举', () => {
    // 这些数据集里出现字面 id 是正常写法（发道具、按 metric 名取数、档位名、属性名），不在本闸范围内。
    // taoism_gate_data 特别说明：它的 dao_paths 键名恰好就是五行元素名，代码里那份是元素表，不是道途清单。
    const EXEMPT = new Set([
        'item_data', 'resource_data', 'stat_definitions', 'combat_formulas',
        'effect_vocabulary', 'talents', 'titles', 'achievement_data', 'drop_data',
        'artifact_deep_lines', 'taoism_gate_data'
    ]);
    const KEY_FIELDS = ['id', 'key', 'type_key', 'beast_key', 'boss_key', 'item_id', 'code', 'name',
        'concubine_key', 'level', 'floor', 'stage', 'tier'];

    function contentKeys(dataset) {
        const file = path.join(configDir, `${dataset}.json`);
        if (!fs.existsSync(file)) return null;
        const data = readJson(file);
        const spec = DATASET_SPECS[dataset];
        const keys = new Set();
        const at = (name) => name.split('.').reduce(
            (cursor, seg) => (cursor && typeof cursor === 'object' ? cursor[seg] : undefined), data);
        for (const [name, collection] of Object.entries(spec.collections)) {
            const raw = collection.root ? data : at(name);
            if (Array.isArray(raw)) {
                const keyField = collection.key
                    || KEY_FIELDS.find(f => raw.every(x => x && typeof x === 'object' && x[f] !== undefined));
                for (const entry of raw) {
                    if (entry && typeof entry === 'object' && entry[keyField] !== undefined) keys.add(String(entry[keyField]));
                }
            } else if (raw && typeof raw === 'object') {
                Object.keys(raw).forEach(k => keys.add(k));
            }
        }
        return keys;
    }

    test('game/ 与 routes/ 里不许出现"整份内容主键清单"的字面数组', () => {
        const sets = [];
        for (const dataset of Object.keys(DATASET_SPECS)) {
            if (EXEMPT.has(dataset)) continue;
            const keys = contentKeys(dataset);
            if (keys && keys.size >= 3) sets.push([dataset, keys]);
        }

        /**
         * 副本变量列名也当一份清单来盯。它不是数据集主键，但被手抄成白名单的后果一模一样：
         * 资料片加的变量在 GM 面板里调不动。2026-09-21 前 `routes/admin_multi_dungeon.js` 与
         * `gmAdjustVariable` 各抄了一份（19 个 / 24  个），而实例上真有 40 个变量列 ——
         * 控制跑（把清单换回旧的 19 个）时 `smoke_multi_dungeon.js` 的 X9/X11 红，这条闸也会红。
         * 现在两份都从内容派生（`MultiDungeonService.adjustableVariables()`）。
         */
        const md = readJson(path.join(configDir, 'multi_dungeon_data.json'));
        const varKeys = new Set(Object.keys((md.global && md.global.variable_labels) || {}));
        for (const dungeon of Object.values(md.dungeons || {})) {
            for (const group of ['instance_vars', 'member_vars']) {
                Object.keys((dungeon && dungeon[group]) || {}).forEach(k => varKeys.add(k));
            }
        }
        varKeys.delete('_note');
        if (varKeys.size >= 3) sets.push(['multi_dungeon_data 变量列', varKeys]);

        // 允许数组里多出 1 个哨兵值（例如 'all'），但整份清单必须来自同一个数据集
        const literalList = /\[\s*(?:'[^'\n]+'|"[^"\n]+")(?:\s*,\s*(?:'[^'\n]+'|"[^"\n]+")){2,}\s*\]/g;
        const violations = [];
        for (const file of walkJs([path.join(serverRoot, 'game'), path.join(serverRoot, 'routes')])) {
            // 注释里提到旧清单是正常写法（本文件自己的说明就是），只扫真正会执行的代码；
            // 块注释按字符抹平但保留换行，这样报出来的行号仍然对得上
            const text = fs.readFileSync(file, 'utf8')
                .replace(/\r\n/g, '\n')
                .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
                .replace(/^\s*\/\/.*$/gm, '');
            for (const match of text.matchAll(literalList)) {
                const tokens = [...new Set([...match[0].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]))];
                for (const [dataset, keys] of sets) {
                    const inside = tokens.filter(t => keys.has(t));
                    if (inside.length >= 3 && tokens.length - inside.length <= 1) {
                        const line = (text.slice(0, match.index).match(/\n/g) || []).length + 1;
                        const where = path.relative(serverRoot, file).split(path.sep).join('/');
                        violations.push(`${where}:${line} ${dataset}: ${inside.join(', ')}`);
                    }
                }
            }
        }
        expect(violations).toEqual([]);
    });

    /**
     * 「按内容主键分支、但只做赋值」= 本该是数据的东西写在了代码里。
     * 2026-09-20 清掉的例子：多人副本的专属变量初始化原本是 14 处
     * `if (dungeonKey === 'kunwu') { instanceData.mountain_seal = … }`，分布在创建实例/队长入队/队员加入三处，
     * 资料片加一个带自己变量的副本就得改三个地方。现在声明在 dungeons[<key>].instance_vars / .member_vars。
     * 真正的玩法分支（里面有 return/条件/调用）不在本规则射程内，允许留在代码里。
     */
    const perKeyInitRe = /\n([ \t]*)if \([\w.$]+ === '([a-z][a-z0-9_]+)'\) \{\n((?:\1 {4}(?:\/\/ .*|[\w$]+\.[\w$]+ = .*|const [\w$]+ = [\w.$]+;)\n|\s*\n)+)\1\}/g;

    test('检测器本身不是空转：能认出样例里的按键名赋值分支', () => {
        const sample = [
            '    static x() {',
            '        if (dungeonKey === \'kunwu\') {',
            '            instanceData.mountain_seal = cfg.init_mountain_seal ?? 30;',
            '        }',
            '    }'
        ].join('\n');
        expect([...sample.matchAll(perKeyInitRe)].length).toBe(1);
        // 反例：带 return 的玩法分支不该被算进来
        const behavior = [
            '    static y() {',
            '        if (instance.instance_key === \'xuese\') {',
            '            const hp = row.blood_qi_avg;',
            '            if (hp <= 0) return { success: false };',
            '        }',
            '    }'
        ].join('\n');
        expect([...behavior.matchAll(perKeyInitRe)].length).toBe(0);
    });

    test('不许出现"按内容主键分支只为赋值"的写法（这类东西应该声明进内容）', () => {
        const sets = [];
        for (const dataset of Object.keys(DATASET_SPECS)) {
            if (EXEMPT.has(dataset)) continue;
            const keys = contentKeys(dataset);
            if (keys && keys.size) sets.push([dataset, keys]);
        }
        const found = [];
        for (const file of walkJs([path.join(serverRoot, 'game'), path.join(serverRoot, 'routes')])) {
            const text = fs.readFileSync(file, 'utf8')
                .replace(/\r\n/g, '\n')
                .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
                .replace(/^\s*\/\/.*$/gm, '');
            for (const match of text.matchAll(perKeyInitRe)) {
                const literal = match[2];
                for (const [dataset, keys] of sets) {
                    if (keys.has(literal)) {
                        const line = (text.slice(0, match.index).match(/\n/g) || []).length + 1;
                        found.push(`${path.relative(serverRoot, file).split(path.sep).join('/')}:${line} ${dataset} 的条目 ${literal} 用分支初始化变量`);
                    }
                }
            }
        }
        expect(found).toEqual([]);
    });
});

/**
 * 抽灵根的概率表 ↔ 灵根声明（role_init）。
 * 这两套键以前互不校验：键写错就是"那一档谁也抽不到"，加了灵根忘了加概率也一样静默。
 */
describe('灵根概率表与灵根声明必须对得上', () => {
    function registryWithRoleInit(roleInit) {
        const content = new ContentRegistry({ configPath: configDir, packDir, statRegistry: new StatRegistry() });
        content.load();
        // 换的是**合并视图**（content.datasets），不是 _loadBase：校验器读的就是合并后的 role_init
        // （这样资料片加的灵根才会被同一条闸判到）。上一版在这里 patch `_loadBase` 且放在 load 之后，
        // 合成内容根本没进校验器，"概率表写错名字"那条测试其实是假绿 —— 这次它先红了一次，才被抓出来。
        content.datasets.set('role_init', roleInit);
        return content;
    }

    test('概率表里有没声明过的灵根名 → 抛并点名那一条', () => {
        const content = registryWithRoleInit({
            spirit_roots: [{ name: '金' }, { name: '木' }],
            spiritRootProbabilities: { '金': 0.5, '雷': 0.5 }
        });
        expect(() => content._validateSpiritRootRoll()).toThrow(/雷/);
    });

    test('每条灵根都有概率与加成时不抛也不警告（现网这份内容也走这一条，但没概率的雷/冰/风是有意的）', () => {
        // 加成条目是 2026-09-22 新加的一条规则（"声明了灵根却没配加成 = 抽到它等于白抽"），
        // 所以合法样本必须带上它；六条完整规则的覆盖与逐条控制跑在 tests/SpiritRootExtensibility.test.js。
        const content = registryWithRoleInit({
            spirit_roots: [{ name: '金' }, { name: '雷' }],
            spiritRootProbabilities: { '金': 0.7, '雷': 0.3 },
            spiritRootBonuses: { '金': { atk: 4 }, '雷': { atk: 6, speed: 1 } }
        });
        const warns = [];
        const spy = jest.spyOn(console, 'warn').mockImplementation(msg => warns.push(String(msg)));
        try {
            expect(() => content._validateSpiritRootRoll()).not.toThrow();
        } finally {
            spy.mockRestore();
        }
        expect(warns.filter(w => w.includes('spiritRootProbabilities'))).toEqual([]);
    });

    test('真实配置装得起来：现网这份灵根表不触发新校验（校验器不是只会抛）', () => {
        const content = new ContentRegistry({ configPath: configDir, packDir, statRegistry: new StatRegistry() });
        expect(() => content.load()).not.toThrow();
        const roleInit = content._loadBase('role_init');
        const roots = (roleInit.spirit_roots || []).map(r => r.name);
        expect(roots.length).toBeGreaterThanOrEqual(5);
        expect(Object.keys(roleInit.spiritRootProbabilities)).toEqual(expect.arrayContaining(['金', '木', '水', '火', '土']));
    });
});

describe('历练事件的 rewards 键：服务读不到的那些只许减少，不许增加', () => {
    // 服务真正消费的键只有 exp / mp / spirit_stones / items（base_* 是 completeAdventure 自己透传的）。
    // 其余键是"内容里写了、玩家永远拿不到"的存量：要么接进发放器（推荐按属性注册表通用应用，
    // 这样资料片加一种奖励维度不用回来改代码），要么把内容删掉。再新增一个没接的键 = 直接红。
    const HANDLED = new Set(['exp', 'mp', 'spirit_stones', 'items', 'base_exp', 'base_spirit_stones']);
    const DEAD_YET = new Set([
        'wisdom', 'realm_insight', 'treasure', 'information',
        'technique_hint', 'trade_opportunity', 'ancient_knowledge', 'array_insight'
    ]);

    function adventureEventFiles() {
        const out = [path.join(serverRoot, 'config', 'adventure_event_data.json')];
        const packs = path.join(serverRoot, 'content', 'packs');
        if (fs.existsSync(packs)) {
            for (const d of fs.readdirSync(packs)) {
                const f = path.join(packs, d, 'adventure_event_data.json');
                if (fs.existsSync(f)) out.push(f);
            }
        }
        return out;
    }

    function unhandledKeys() {
        const found = new Set();
        for (const f of adventureEventFiles()) {
            const data = JSON.parse(fs.readFileSync(f, 'utf8'));
            for (const e of data.events || []) {
                for (const k of Object.keys(e.rewards || {})) if (!HANDLED.has(k)) found.add(k);
            }
        }
        return found;
    }

    test('扫得到真事件（防"一个都没扫到也算通过"）', () => {
        let events = 0;
        for (const f of adventureEventFiles()) {
            events += (JSON.parse(fs.readFileSync(f, 'utf8')).events || []).length;
        }
        if (events < 10) throw new Error(`只扫到 ${events} 条历练事件，扫描范围不对`);
        if (unhandledKeys().size < 5) {
            throw new Error(`只认出 ${unhandledKeys().size} 个未接线键 —— 清单变了先去核对，别让它悄悄空转`);
        }
    });

    test('未接线的奖励键清单只许减不许增', () => {
        const found = unhandledKeys();
        const added = [...found].filter(k => !DEAD_YET.has(k)).sort();
        const gone = [...DEAD_YET].filter(k => !found.has(k)).sort();
        const problems = [];
        if (added.length) {
            problems.push(`新增了两头都没接的奖励键：${added.join(', ')} —— `
                + '内容里写了玩家也拿不到；要么接进 AdventureEventService.grantRewards，要么从内容里删。');
        }
        if (gone.length) {
            problems.push(`这些键已经不再被裸写（接上了或删掉了），把 DEAD_YET 里对应几行删掉：${gone.join(', ')}`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });
});
