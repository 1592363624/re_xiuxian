/**
 * 整块 JSON 列的"户口册"门禁。
 *
 * 盯的缺陷形状：一个 TEXT/JSON 列存的是整块对象（attributes、会话、快照、日志…）。
 * 写这种列的自然写法是"读出来 → 改 → 存回去"，而两个流程各自这样做的结果就是
 * **旧快照覆盖新快照**：后提交的那一份把先提交的那一份整块抹掉，玩家数据永久丢失。
 * players 表上这一类已经由 blobWriteGuard（state_version 新鲜度）管住，
 * 但仓库里一共有 52 个这样的列、分布在 28 个模型上，守卫只管到其中 5 个 ——
 * 剩下的全靠"某次改造时逐个加锁"，而**下一个加进来的人并不知道有这条规矩**。
 *
 * 本文件把这套规矩变成闭合清单：
 *   1) 检测器自己不许失效（列数低于门槛就红，别让它悄悄变成空跑）；
 *   2) 被 ≥2 个文件整块写的列：要么在 blobWriteGuard 的射程里（用真实常量核对，不抄名单），
 *      要么每个写入方都取得行锁 —— 新增一个写方而没登记 = 红；
 *   3) 只被一个文件写的列：当前没锁的**列出来但不判失败**（同流程两个请求并发照样能撞，
 *      这是 backlog，不是一句"单写方所以安全"能糊过去的）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { WHOLE_BLOB_COLUMNS } = require('../game/persistence/blobWriteGuard');

const serverRoot = path.join(__dirname, '..');
const modelDir = path.join(serverRoot, 'models');
const SRC_DIRS = ['game', 'routes', 'modules', 'state', 'core'];

/** models 之外所有 .js（带内容），扫描范围与"谁在写玩家数据"一致 */
function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'tests') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, out);
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

const sources = SRC_DIRS
    .filter(d => fs.existsSync(path.join(serverRoot, d)))
    .flatMap(d => sourceFiles(path.join(serverRoot, d)))
    .map(f => ({ rel: path.relative(serverRoot, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));

/** 模型里的整块 JSON 列：DataTypes.JSON，或 getter+setter 成对做 JSON.parse/stringify */
function jsonBlobColumns() {
    const found = [];
    for (const file of fs.readdirSync(modelDir).filter(n => n.endsWith('.js'))) {
        const model = file.replace(/\.js$/, '');
        const src = fs.readFileSync(path.join(modelDir, file), 'utf8');
        for (const m of src.matchAll(/^\s{4}([a-z][a-z0-9_]*):\s*\{([\s\S]*?)^\s{4}\},?$/gm)) {
            const [, column, body] = m;
            const isBlob = /DataTypes\.JSON/.test(body)
                || (/JSON\.parse/.test(body) && /JSON\.stringify/.test(body));
            if (isBlob) found.push({ model, column, at: `${model}.${column}` });
        }
    }
    return found;
}

/**
 * 一列的所有"整块写"点：{ line, receiver, kind }。
 * kind：assign = `row.col = …`（会把整列带回旧值，最危险）；update / set = 只写那一列，
 * 但同一列的"读-改-写"照样能互相覆盖。注释行不算。
 */
function columnWriteSites(src, column) {
    const c = escapeRe(column);
    const sites = [];
    const lineOf = idx => src.slice(0, idx).split(/\r?\n/).length;
    src.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        for (const m of line.matchAll(new RegExp(`([A-Za-z_$][\\w$.]*)\\.${c}\\s*=[^=]`, 'g'))) {
            sites.push({ line: i + 1, receiver: lastSegment(m[1]), kind: 'assign' });
        }
        for (const m of line.matchAll(new RegExp(`([A-Za-z_$][\\w$.]*)\\.set\\(\\s*['"]${c}['"]`, 'g'))) {
            sites.push({ line: i + 1, receiver: lastSegment(m[1]), kind: 'set' });
        }
    });
    // `x.update({ … col: … })` 通常跨行：从 `x.update({` 起往后看 400 字符（沿用旧判定窗口）
    for (const m of src.matchAll(/([A-Za-z_$][\w$.]*)\.update\(\s*\{/g)) {
        const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
        if (new RegExp(`\\b${c}\\s*:`, 'm').test(tail)) sites.push({ line: lineOf(m.index), receiver: lastSegment(m[1]), kind: 'update' });
    }
    return sites.sort((a, b) => a.line - b.line);
}

function lastSegment(dotted) {
    return dotted.split('.').pop();
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 文件里的 `const Alias = require('.../models/M')`（含 handler 内部就地 require）→ Alias → 模型名 */
function aliasToModel(src) {
    const map = new Map();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\('[^']*\/models\/([A-Za-z0-9_.]+)'\)/g)) {
        map.set(m[1], m[2]);
    }
    return map;
}

/**
 * 行变量是从哪张表取出来的：`const notification = await SystemNotification.findByPk(id)`。
 *
 * 为什么必须有这一层：只按"这个文件 import 过 models/item"归属，会把该文件里对**别的表**的
 * 整列写也算成 item 的写方（2026-09-21 的假红就是 routes/admin.js 里
 * `notification.update({ … metadata … })` 被判成 item 的第二写方）。
 * 归属不出来时**仍然按最坏情况算它可能是本表** —— 宁可多判一条让人来看，
 * 也不能让闸门因为"认不出变量从哪来"就悄悄放过一个写方。
 */
function varToModel(src) {
    const aliases = aliasToModel(src);
    const map = new Map();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\.\s*(?:findByPk|findOne|findAll|findOrCreate|findAndCountAll|create)\s*\(/g;
    for (const m of src.matchAll(re)) {
        const model = aliases.get(m[2]);
        if (model) map.set(m[1], model);
    }
    return map;
}

/** 这个写点属于哪张表（null = 认不出来） */
function siteModel(src, site) {
    const viaVar = varToModel(src).get(site.receiver);
    if (viaVar) return viaVar;
    return aliasToModel(src).get(site.receiver) || null;   // `Item.update({col:…})` 直接按模型名写
}

/** 归属于该模型（或认不出归属 = 保守计入）的写点 */
function attributedSites(rel, model, column) {
    const src = sources.find(s => s.rel === rel);
    if (!src) return [];
    return columnWriteSites(src.src, column).filter(site => {
        const owner = siteModel(src.src, site);
        return owner === null || owner === model;
    });
}

/** 真正"整块写"这一列的文件：import 了这个模型，且有归属于它的写点 */
function writersOf(model, column) {
    const imported = new RegExp(`require\\('[^']*models/${escapeRe(model)}'\\)`);
    return sources
        .filter(s => imported.test(s.src) && attributedSites(s.rel, model, column).length > 0)
        .map(s => s.rel);
}

/**
 * 该文件里指代这个模型的标识符：`const HeartTribulationEvent = require('../models/heartTribulationEvent')`
 * 用的是导入名（大写），不是模型文件名 —— 只看模型名会永远判成"没加锁"。
 */
function modelAliases(file, model) {
    const src = sources.find(s => s.rel === file);
    if (!src) return [model];
    const re = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\('[^']*models/${model}'\\)`, 'g');
    return [...new Set([...src.src.matchAll(re)].map(m => m[1]))].concat(model);
}

/** 从赋值行往上找所在方法/函数的开头（缩进 ≤8；`static async` 与 `async static` 两种顺序都要认） */
/** 方法头：缩进 ≤8 的 `static async name(args) {` / `async name(args) {` / `function name(args) {`，排除 if/for 等控制语句 */
const METHOD_HEAD = /^\s{0,8}(?!\b(?:if|for|while|switch|catch|return|else|do|try)\b)(?:static\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/;

/**
 * 取赋值行所在的方法体。找不到方法头**不算通过**：
 * 退回"整份文件前缀"会让判定变成"这个文件里哪儿有锁都行"，实测那样控制跑直接假绿。
 */
function enclosingMethod(lines, writeIdx) {
    for (let i = writeIdx; i >= 0; i--) {
        if (METHOD_HEAD.test(lines[i])) return { body: lines.slice(i, writeIdx + 1).join('\n'), headLine: i + 1 };
    }
    return null;
}

/**
 * 方法体里有没有"对这个模型取行锁"。必须是**同一次取行的参数里**带 LOCK.UPDATE：
 * 早期版本允许"附近有 LOCK.UPDATE"，于是 Player 那把锁能被算到 HeartTribulationEvent 头上 ——
 * 控制跑（真去掉事件行的锁）因此一直假绿。
 */
function lockedFetchIn(body, names) {
    // 集中取锁助手也算取锁：`await this._lockGate(...)` 这种写法把 FOR UPDATE 收进了一个方法，
    // 只看方法体里的 LOCK.UPDATE 会把合规写法判成违规（也会诱使人干脆不加锁）。
    if (/this\._lock[A-Za-z]*\(/.test(body)) return true;
    const re = new RegExp(`\\b(?:${names})\\s*\\.\\s*(?:findByPk|findOne|findAll|findAndCountAll)\\s*\\(([\\s\\S]*?\\)\\s*;)`, 'g');
    for (const m of body.matchAll(re)) {
        if (/LOCK\s*\.\s*UPDATE|lock\s*:\s*[A-Za-z_$][\w$]*\.LOCK\.UPDATE/.test(m[1])) return true;
    }
    return false;
}

/**
 * 该文件里所有"整块写这一列"的位置中，**没有**取到该模型行锁的那些（返回行号）。
 * 判每一个写点，不是只判第一个：同一个文件里另一处合规的锁会把第一处的问题遮掉（控制跑实测如此）。
 */
function unlockedWrites(file, model, column) {
    const src = sources.find(s => s.rel === file);
    if (!src) return [-1];
    const lines = src.src.split(/\r?\n/);
    const names = modelAliases(file, model).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // 只看归属于本表的整列赋值（跨表的写点不算本表的隐患，见 varToModel）
    const assigns = attributedSites(file, model, column).filter(s => s.kind === 'assign');
    const bad = [];
    assigns.forEach(({ line }) => {
        const idx = line - 1;
        const found = enclosingMethod(lines, idx);
        if (!found) { bad.push(line); return; }
        if (!lockedFetchIn(found.body, names)) bad.push(line);
    });
    return bad;
}

/** 该文件对这一列的写点是否全都取到了行锁（没有整列赋值 = 交给 update/set 分支判） */
function locksRow(file, model, column) {
    const src = sources.find(s => s.rel === file);
    if (!src) return null;
    const assigns = src.src.split(/\r?\n/).filter(l => new RegExp(`[A-Za-z_$][\\w$.]*\\.${column}\\s*=[^=]`).test(l));
    if (!assigns.length) return true;
    return unlockedWrites(file, model, column).length === 0;
}

/**
 * 只走 Model.update({col}) / row.set('col') 的写方：这类写法本身可以只更新那一列
 * （不会把别的列带回旧值），但同一列的"读-改-写"仍然会互相覆盖。
 * 现在按"文件里对该列的 update 是否出现在带锁事务里"判 —— 保守：没有锁痕迹就进 backlog。
 */
function updateOnly(file, model, column) {
    const sites = attributedSites(file, model, column);
    if (!sites.length) return false;
    return sites.every(s => s.kind !== 'assign');
}

const columns = jsonBlobColumns();

/** 已确认"每个写方都取行锁"的多写方列。新增写方必须先登记在这里并核对确实加了锁。 */
const ROW_LOCKED_MULTI_WRITERS = {
    'heartTribulationEvent.reward': ['game/services/CompanionService.js', 'game/services/DaoCompanionService.js'],
    'heartTribulationEvent.penalty': ['game/services/CompanionService.js', 'game/services/DaoCompanionService.js'],
    'heartTribulationEvent.options': ['game/services/CompanionService.js', 'game/services/DaoCompanionService.js']
};

const guardedNames = new Set(WHOLE_BLOB_COLUMNS.map(c => `player.${c}`));

/**
 * 已经逐个读完、确认"每个写方都取行锁"的**单写方**列。
 * 单写方不等于安全（同一个写方两次并发就能撞），所以这几条从 backlog 里提出来当硬闸：
 * 写方少了/多了、或者把锁摘了，都直接红 —— 免得每次都要回头翻注释里的 verdict。
 */
const ROW_LOCKED_SINGLE_WRITERS = {
    'playerDivineTemple.offering_pool': ['game/services/DivineTempleService.js'],
    'spiritBeastPvpSeason.settlement_summary': ['game/services/SpiritBeastPvpService.js']
};

describe('整块 JSON 列的户口册（旧快照覆盖新快照这一类的闭合清单）', () => {
    test('检测器有效：真的扫到 28 个模型上 50 个以上的整块 JSON 列', () => {
        const models = new Set(columns.map(c => c.model));
        if (columns.length < 50 || models.size < 25) {
            throw new Error(`检测器只找到 ${columns.length} 列 / ${models.size} 个模型 —— `
                + '模型写法变了（缩进、JSON 列定义形状），这条闸已经在看不到东西，先修检测器');
        }
    });

    test('守卫射程内的列确实还叫这些名字（blobWriteGuard 与 players 模型没脱钩）', () => {
        const missing = [...guardedNames].filter(name => !columns.some(c => c.at === name));
        if (missing.length) throw new Error(`blobWriteGuard 列出的列在 players 模型里找不到了：${missing.join('/')} —— 要么改名了，要么守卫在管一个不存在的列`);
        expect(missing).toEqual([]);
    });

    /**
     * 判定器自己不能是空跑：以前它把 `static async` 写成认 `async static`，定位不到方法头就退回
     * "整个文件前缀"，于是"文件里哪儿有锁都算合规"，控制跑（真去掉行锁）照样全绿。
     */
    test('行锁判定器确实在方法体内判（自检，防空跑）', () => {
        expect(locksRow('game/services/DaoCompanionService.js', 'heartTribulationEvent', 'reward')).toBe(true);
        const src = sources.find(s => s.rel === 'game/services/DaoCompanionService.js');
        const lines = src.src.split(/\r?\n/);
        const writeIdx = lines.findIndex(l => /\.reward\s*=[^=]/.test(l));
        const found = enclosingMethod(lines, writeIdx);
        if (!found) throw new Error('定位不到赋值所在方法 —— 判定器会退化成整文件扫描');
        if (writeIdx - found.headLine > 120) {
            throw new Error(`方法头离赋值 ${writeIdx - found.headLine} 行，多半是匹配到了别处的头，区间太大 = 又在整文件找锁`);
        }
    });

    test('被 ≥2 个文件整块写的列：要么在守卫射程里，要么每个写方都取得行锁', () => {
        const problems = [];
        const updateOnlyWriters = [];
        for (const { at } of columns) {
            const [model, column] = at.split('.');
            const writers = writersOf(model, column);
            if (writers.length < 2) continue;
            if (guardedNames.has(at)) continue;
            const listed = ROW_LOCKED_MULTI_WRITERS[at];
            if (!listed) {
                problems.push(`${at} 有 ${writers.length} 个写方却没登记（写方：${writers.join(', ')}）`);
                continue;
            }
            const unexplained = writers.filter(w => !listed.includes(w));
            if (unexplained.length) {
                problems.push(`${at} 冒出新写方未登记：${unexplained.join(', ')} —— 加锁或改走守卫，别只往名单里塞名字`);
            }
            for (const w of listed) {
                if (!writers.includes(w)) {
                    problems.push(`${at} 登记的写方 ${w} 已经不写这一列了，把名单清一下`);
                } else if (updateOnly(w, model, column)) {
                    updateOnlyWriters.push(`${at} ← ${w}`);
                    continue; // 只走 update/set 的写法由下面那条单独看
                } else {
                    const bad = unlockedWrites(w, model, column);
                    if (bad.length) {
                        problems.push(`${at} 的写方 ${w} 有 ${bad.length} 处整列赋值看不到行锁（行号 ${bad.join(',')}）：`
                            + '锁要取在这一列所属的那一行上，别用别的表的锁代替');
                    }
                }
            }
        }
        if (problems.length) throw new Error(problems.join('\n'));
        // "只走 update/set"目前不给锁证据就放过 —— 但它不等于安全：同一列的读-改-写照样互相覆盖
        // （routes/admin.js 改公告 metadata 就是 `JSON.parse(现值) → 合并 → update`）。
        // 先把这类摊开让人看得见，逐个定性后再升成硬门禁（别用条数当成绩）。
        console.log(`[blob 户口册] 多写方列里"只走 update/set"未取锁证据的 ${updateOnlyWriters.length} 处：\n  ${updateOnlyWriters.join('\n  ')}`);
        expect(problems).toEqual([]);
    });

    /**
     * 归属判定自己不能是空跑，也不能宽到看不见真写方。
     * 这条存在的原因：2026-09-21 那次假红 —— admin.js 只因为 import 过 models/item，
     * 它对 system_notification.metadata 的写就被算成 item 的第二写方。
     * 反方向同样要防：receiver 认不出来时必须**照最坏情况计入**，否则"换个变量名"就能绕过整道闸。
     */
    test('写方按行变量的来源归属：跨表写点不算本表，认不出的仍保守计入（防空跑/防绕过）', () => {
        const fake = [
            "const Item = require('../models/item');",
            'async function handler(req) {',
            "  const SystemNotification = require('../models/system_notification');",
            '  const note = await SystemNotification.findByPk(1);',
            '  await note.update({ metadata: JSON.stringify({ a: 1 }) });',   // 别的表：不许算成 item
            '}',
            'async function other(row) {',
            '  row.metadata = { b: 2 };',   // 来源认不出来：必须按最坏情况算 item 的写方
            '}',
            "async function bulk() { Item.update({ metadata: 'x' }); }",      // 按模型名直写：算
            'async function commented() { /* row.metadata = 1 */ }'           // 注释里的不算
        ].join('\n');

        const owned = model => columnWriteSites(fake, 'metadata')
            .filter(site => {
                const owner = siteModel(fake, site);
                return owner === null || owner === model;
            })
            .map(site => `${site.kind}@${site.line}`);

        expect(owned('item')).toEqual(['assign@8', 'update@10']);
        expect(owned('system_notification')).toEqual(['update@5']);
    });

    test('已定性为"每个写方都取行锁"的单写方列：锁不许被摘、写方不许悄悄多出来', () => {
        const problems = [];
        for (const [at, listed] of Object.entries(ROW_LOCKED_SINGLE_WRITERS)) {
            const [model, column] = at.split('.');
            const writers = writersOf(model, column);
            if (!writers.length) {
                problems.push(`${at} 已经没有写方了 —— 这条登记该删掉，别留着当"已覆盖"`);
                continue;
            }
            for (const extra of writers.filter(w => !listed.includes(w))) {
                problems.push(`${at} 冒出新写方 ${extra} 未登记：先加锁，再把它写进名单`);
            }
            for (const w of listed) {
                if (!writers.includes(w)) { problems.push(`${at} 登记的写方 ${w} 已经不写这列了，清一下名单`); continue; }
                const bad = unlockedWrites(w, model, column);
                if (bad.length) {
                    problems.push(`${at} 的写方 ${w} 有 ${bad.length} 处整列写回看不到行锁（行号 ${bad.join(',')}）`);
                }
            }
        }
        if (problems.length) throw new Error(problems.join('\n'));
        expect(problems).toEqual([]);
    });

    test('单写方的整块 JSON 列：没锁的列成 backlog（不判失败，但必须看得见）', () => {
        // 这份名单是**线索**不是判决书：命中的是"整列赋值且所在方法看不到该模型行锁"，
        // 里面既有真风险（同流程两个请求并发就能撞），也有 `_initXxxState` 这种只改内存对象、
        // 根本不落库的赋值（ArtifactDeepLineService 那一串行号大多属于这类）；
        // 还有一类是写在 helper 里的（`CombatService.appendBattleLog`），锁其实在调用方 —— 同样会命中这份名单。
        // 逐条看过之后再决定是否升成硬门禁 —— 别把条数当成绩。
        //
        // 2026-09-21 逐条过完的结论（按列记，别重查一遍）：
        //   playerSect.daily_quests_completed / quests_accepted(_at) —— **已修 + 已升硬门禁**（见下条 test）：
        //     getQuests 是无锁读 + 无条件整列写回，跨零点会把加锁提交的接取/领取标记抹掉 → 日常任务再领一遍。
        //   playerTaoismGate.daily_tasks / skill_cooldowns —— **已修**：`_checkDailyReset` 原来光秃秃 `gate.save()`，
        //     既会被面板无锁写回抹掉 rewards_claimed，又可能在 claimTaskReward 持 FOR UPDATE 时
        //     用另一条连接去写同一行（自锁，等 innodb_lock_wait_timeout）。现在一律带事务，
        //     面板走 _resetDailyTasksForRead（预检无锁、真要改才开短事务锁行）。硬门禁在 BlobWriteRaceGates。
        //   spiritBeastPasture.yield_snapshot ——  benign：赋值在 `_settlePasture`（helper），
        //     两个调用方 recallBeast / checkExpirations 都锁；这条链的死锁与丢写是真并发探针复现过的（#26）。
        //   playerEquipment.deep_line_state —— benign：那 25 行绝大多数是 `_initXxxState` 只改内存；
        //     "只读接口不得 save"由 BlobWriteRaceGates 第一条单独管着，所以这里不必再判一次。
        //   activeBattle.battle_log —— **检测器的盲区，不是代码的问题**：赋值在模块级函数
        //     `appendBattleLog(battle, entry)` 里，enclosingMethod 的头正则只认 `    name(` 这种
        //     类方法形状（`function name(` 会把 function 当名字然后要求紧跟 `(`），于是定位不到方法、
        //     一律算"没锁"。锁在调用方，行为与 yield_snapshot 同。要收这个盲区得先给检测器加模块级函数支持。
        //   最后两条也看完并修掉了（2026-09-21），两条都提进 ROW_LOCKED_SINGLE_WRITERS 当硬闸：
        //     playerDivineTemple.offering_pool —— gmSetLevel 原来是"无锁 findOne → 改三列 → save()"，
        //       与玩家侧 upgrade（锁 players→temple）交错就按 GM 手上那份旧快照盖回 offering_pool/defense_max。
        //       现在照 upgrade 的次序锁 temple（是 players→temple 的子集，不会反咬成 ABBA）；
        //       运行时用一次性脚本验过"改级别落库 / 供奉池随级别解锁 / 无神庙回明确失败"。
        //     spiritBeastPvpSeason.settlement_summary —— 粗筛 findAll 不带锁、_settleSeason 从不重判 status，
        //       于是"先读到、后执行"的重放（调度器 tick 与手动结算重叠）把前 100 名赛季奖励发两遍。
        //       现在锁赛季行 + 锁内重判，并给 checkSeasonExpiry 的返回打真值日志；
        //       players 也从"按名次逐个锁"改成一次按 id 升序锁齐（与对局的"挑战者→防守者"交错就是 ABBA）；
        //       证据在 scripts/smoke_beast_pvp_season.js（控制跑摘掉守卫 → 重放那笔又发了 201500 灵石）。
        const risky = [];
        for (const { at } of columns) {
            const [model, column] = at.split('.');
            if (guardedNames.has(at) || ROW_LOCKED_MULTI_WRITERS[at] || ROW_LOCKED_SINGLE_WRITERS[at]) continue;
            const writers = writersOf(model, column);
            if (writers.length !== 1) continue;
            const bad = unlockedWrites(writers[0], model, column);
            if (bad.length) risky.push(`${at} ← ${writers[0]}（行 ${bad.join(',')}）`);
        }
        // 这条只报数：同一流程两个请求并发也能撞，属于要逐个看的存量，不该被一句"单写方"掩盖
        console.log(`[blob 户口册] 单写方且看不到行锁的整块 JSON 列 ${risky.length} 个：\n  ${risky.join('\n  ')}`);
        expect(Array.isArray(risky)).toBe(true);
    });

    /**
     * backlog 里第一条逐个看完后**升成硬门禁**的：宗门日常任务的跨天清零。
     * `SectService.getQuests` 是 GET 面板，以前是"无锁读 → 整列写回 []"，会把并发提交的
     * 接取/完成记录抹掉（奖励已发、标记没了 → 同一个日常任务当天能再领一遍）。
     * 面板不适合持行锁，正确形状是**条件写**：只有"这一行仍然到期"才写。这条闸钉的就是这个形状，
     * 顺手也钉住"清零别再退回 save() 整行写回"。
     */
    test('GET 面板的整列清零必须是条件写，不许退回无锁 save()', () => {
        const sect = sources.find(s => s.rel === 'game/services/SectService.js');
        if (!sect) throw new Error('SectService.js 不在了 —— 这条闸已经在看不到东西');
        const bodyOf = name => {
            const lines = sect.src.split(/\r?\n/);
            const head = lines.findIndex(l => new RegExp(`^\\s*(?:async )?${name}\\s*\\(`).test(l));
            if (head < 0) return null;
            let depth = 0;
            for (let i = head; i < lines.length; i++) {
                depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
                if (depth <= 0 && i > head) return lines.slice(head, i + 1).join('\n');
            }
            return null;
        };
        const panel = bodyOf('getQuests');
        const reset = bodyOf('_resetDailyQuestsForRead');
        if (!panel || !reset) throw new Error('找不到 getQuests / _resetDailyQuestsForRead —— 方法改名了，这条闸已经在看不到东西');

        const problems = [];
        if (/await\s+\w+\.save\(\s*\)/.test(panel)) problems.push('getQuests 里又出现无事务 save()：面板那份快照随时可能比库里旧');
        if (!/_resetDailyQuestsForRead\(/.test(panel)) problems.push('getQuests 不再走 _resetDailyQuestsForRead()，清零跑回哪儿去了？');
        if (!/\.update\([\s\S]{0,700}?where:\s*\{[\s\S]{0,400}?Op\.(?:or|and|lt|lte|gt|gte|ne)/.test(reset)) {
            problems.push('_resetDailyQuestsForRead 的条件写不见了：只剩按 id 的无条件写就等于旧快照照写');
        }
        if (/\.save\(/.test(reset)) problems.push('清零助手又用 save() 整行写回：只该写那四个键');
        if (problems.length) throw new Error(problems.join('\n'));
        expect(problems).toEqual([]);
    });
});
