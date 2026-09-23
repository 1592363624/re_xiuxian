/**
 * 整块 JSON 列的"户口册"门禁。
 *
 * 盯的缺陷形状：一个 TEXT/JSON 列存的是整块对象（attributes、会话、快照、日志…）。
 * 写这种列的自然写法是"读出来 → 改 → 存回去"，而两个流程各自这样做的结果就是
 * **旧快照覆盖新快照**：后提交的那一份把先提交的那一份整块抹掉，玩家数据永久丢失。
 * players 表上这一类已经由 blobWriteGuard（state_version 新鲜度）管住，
 * 但仓库里一共有 65 个这样的列（53 个声明上是整块 + 12 个 TEXT 却按整块 JSON 读写）、
 * 分布在 30 多个模型上，守卫只管到其中 5 个 ——
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

/**
 * 整块列清单 = 声明上就是整块的（DataTypes.JSON / 成对 parse+stringify）
 *              + 声明是 TEXT/STRING 但代码里确实按整块 JSON 读写的（公告 metadata、历练 event_data、
 *                切磋与 PvP 的 battle_log 等）。
 * 第二类必须算进来：这一族缺陷与列的声明类型无关，只按类型检测就会给出一份**看起来闭合、其实漏了
 * 十几个列**的清单（2026-09-21 量出来 12 个）。
 */
const { modelJsonColumns, pseudoJsonColumns } = require('./helpers/blobColumns');

function jsonBlobColumns() {
    const declared = modelJsonColumns();
    const pseudo = pseudoJsonColumns(modelDir, sources).map(c => ({ model: c.model, column: c.column, at: c.at }));
    const seen = new Set(declared.map(c => c.at));
    return [...declared, ...pseudo.filter(c => !seen.has(c.at))];
}

/**
 * 抹掉注释但**保留换行与列位置**，这样命中行号仍然准。
 * 注释里的 `row.metadata = …` 不是写方（旧版没剥注释，被注释掉的代码会凭空多出写方）。
 */
function stripComments(src) {
    return src
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^|\s)\/\/.*$/gm, '$1');
}

/**
 * 一列的所有"整块写"点：{ line, receiver, kind }。
 * kind：assign = `row.col = …`（会把整列带回旧值，最危险）；update / set = 只写那一列，
 * 但同一列的"读-改-写"照样能互相覆盖。
 */
function columnWriteSites(src, column) {
    const code = stripComments(src);
    const c = escapeRe(column);
    const sites = [];
    const lineOf = idx => code.slice(0, idx).split('\n').length;
    code.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(`([A-Za-z_$][\\w$.]*)\\.${c}\\s*=[^=]`, 'g'))) {
            sites.push({ line: i + 1, receiver: lastSegment(m[1]), kind: 'assign' });
        }
        for (const m of line.matchAll(new RegExp(`([A-Za-z_$][\\w$.]*)\\.set\\(\\s*['"]${c}['"]`, 'g'))) {
            sites.push({ line: i + 1, receiver: lastSegment(m[1]), kind: 'set' });
        }
    });
    // `x.update({ … col: … })` 通常跨行：从 `x.update({` 起往后看 400 字符（沿用旧判定窗口）
    for (const m of code.matchAll(/([A-Za-z_$][\w$.]*)\.update\(\s*\{/g)) {
        const tail = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
        if (new RegExp(`\\b${c}\\s*:`, 'm').test(tail)) {
            sites.push({ line: lineOf(m.index), receiver: lastSegment(m[1]), kind: 'update' });
        }
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
    for (const m of stripComments(src).matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\('[^']*\/models\/([A-Za-z0-9_.]+)'\)/g)) {
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
    for (const m of stripComments(src).matchAll(re)) {
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

/**
 * 只写"序列化副本"的变量：`const plain = row.toJSON()` / `const obj = JSON.parse(...)`。
 * 往它们身上赋同名列**不是数据库写入**，所以不算这一列的写方。
 * （2026-09-21 的活样本：`AdventureEventService.getLastAdventureEvent` 里
 *  `plainData.event_data = JSON.parse(...)` 被当成"无锁整块写" —— 那是出参装配。）
 *
 * 这个排除看不见的形状：`copy = row.toJSON()` → 改 copy → `Object.assign(row, copy)` → save。
 * 那种写法绕不过本闸的另一半（players 的 blobWriteGuard 在运行时拦整块脏写），
 * 但要知道：这里放过的只是"对副本的赋值"，不是"对行的赋值"。
 */
function plainCopyVars(src) {
    const out = new Set();
    const code = stripComments(src);
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.toJSON\s*\(/g)) out.add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?JSON\.parse\s*\(/g)) out.add(m[1]);
    return out;
}

/** 归属于该模型（或认不出归属 = 保守计入）的写点 */
function attributedSites(rel, model, column) {
    const src = sources.find(s => s.rel === rel);
    if (!src) return [];
    const copies = plainCopyVars(src.src);
    return columnWriteSites(src.src, column).filter(site => {
        if (copies.has(site.receiver)) return false;      // 写的是序列化副本，不落库
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

/**
 * 方法头：缩进 ≤8 的 `static async name(args) {` / `async name(args) {` / `name(args) {`，排除 if/for 等控制语句。
 * 必须同时认**独立函数**（`function appendBattleLog(battle, entry) {` / `async function x() {`）：
 * 早先的正则只认 `name(args) {` 这种类方法形状，`function` 这个词把标识符吃掉后就再也配不上，
 * 于是所有模块级函数都"定位不到作用域"→ 一律判成没锁（户口册里那条 `activeBattle.battle_log` 的
 * "检测器盲区"备注就是这么来的，其实是判定式的洞，2026-09-21 修）。
 */
const METHOD_HEAD = /^\s{0,8}(?!\b(?:if|for|while|switch|catch|return|else|do|try)\b)(?:static\s+)?(?:async\s+)?(?:function\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/;
/**
 * 匿名函数头（routes/ 里 handler 全是这个形状）：`… async (req, res, next) => {`。
 * 不认它的话，路由里每个赋值都会因为"定位不到所在函数"被判成没锁 —— 那是检测器的盲区，不是代码的问题
 * （2026-09-21 admin_pvp 那条就是这样误报的：取行明明带 FOR UPDATE）。
 */
const ARROW_HEAD = /(?:\([^)]*\)\s*=>\s*\{|function\s*\([^)]*\)\s*\{)\s*$/;

/**
 * 赋值行所在的所有作用域（由近到远）。
 *
 * 必须**按大括号配平**判断"这一行真的在那个函数体内"：只要"往上找到的任意一个函数头"就放行，
 * 判定会退化成"这个文件里哪儿有锁都行"（本文件早先的控制跑就是被这种写法骗到假绿的）。
 * 找不到任何包含它的函数头也不算通过。
 */
function enclosingScopes(lines, writeIdx) {
    const out = [];
    for (let i = writeIdx; i >= 0; i--) {
        if (!METHOD_HEAD.test(lines[i]) && !ARROW_HEAD.test(lines[i])) continue;
        let depth = 0;
        let end = -1;
        for (let k = i; k < lines.length; k++) {
            depth += (lines[k].match(/\{/g) || []).length - (lines[k].match(/\}/g) || []).length;
            if (depth <= 0 && k > i) { end = k; break; }
        }
        if (end < 0) continue;                       // 配不平 = 这个头不是真的函数起点
        if (end < writeIdx) continue;                // 这块在赋值行之前就结束了：不相干
        out.push({ body: lines.slice(i, writeIdx + 1).join('\n'), headLine: i + 1, endLine: end + 1 });
    }
    return out;
}

/**
 * 取赋值行所在的方法体（最近的一个头）。保留给自检用。
 */
function enclosingMethod(lines, writeIdx) {
    const scopes = enclosingScopes(lines, writeIdx);
    return scopes.length ? scopes[0] : null;
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
    const helpers = CALLER_LOCKED_HELPERS.filter(h => h.file === file && h.model === model);
    const bad = [];
    assigns.forEach(({ line }) => {
        const idx = line - 1;
        // 登记过的"锁在调用方"helper：整列赋值发生在助手内，行是调用方 FOR UPDATE 后传进来的。
        // 这种跨函数事实静态判不准，所以只在登记表点名允许，并由下面那条专门用例查登记是否还成立。
        if (helpers.some(h => callerLockedHelperLines(file, h).includes(idx + 1))) return;
        const scopes = enclosingScopes(lines, idx);
        if (!scopes.length) { bad.push(line); return; }
        // 从最近的作用域往外看：锁可能取在外层 handler 里（路由就是这个形状）
        if (scopes.some(sc => lockedFetchIn(sc.body, names))) return;
        bad.push(line);
    });
    return bad;
}

/**
 * 登记"锁在调用方"的整块写 helper：赋值发生在助手内部，行是调用方 FOR UPDATE 之后当参数传进来的。
 * 这种跨函数的事实静态判不准（判成违规会逼人多包一层锁，判成合规又等于放过），
 * 所以只允许点名登记，并由下面那条专门用例复查"登记仍然成立"：谁把那句锁摘掉就会红。
 *
 * 2026-09-21 逐条取证（脚本量每个调用方方法体里那一行是不是带锁取出来的）：
 *   CombatService.appendBattleLog        调用方 attack/monsterTurn/flee/useSkill 都 `ActiveBattle.findOne(… LOCK.UPDATE)`
 *   SectService._checkAndResetDailyQuests dailyCheckIn/submitQuest/acceptQuest 三处都锁（GET 面板走另一条条件写，不调这个 helper）
 *   TaoismGateService._checkDailyReset / _updateTaskProgress / _executeWaterMirror / _executeFireEye
 *                                        gate 一律经集中取锁助手 `_lockGate/_lockGatesByPlayerIdAsc`（本文件注释就写着"写路径都要先过这里"）
 *   BeastPastureService._settlePasture   recallBeast / checkExpirations 都先锁 pasture 再传进来（#26 那条锁顺序契约）
 *   DuelService._settleDuel              见下面单独一条（控制跑验过：摘掉 FOR UPDATE 两条用例同时红）
 */
const CALLER_LOCKED_HELPERS = [
    {
        file: 'game/services/DuelService.js', model: 'pvpBattleRecord',
        helper: '_settleDuel', rowParam: 'battle',
        reason: '结算助手不自己读行：battle 由出招那一步 PvpBattleRecord.findByPk(…, lock: t.LOCK.UPDATE) 锁好后传进来'
    },
    {
        file: 'game/services/CombatService.js', model: 'activeBattle',
        helper: 'appendBattleLog', rowParam: 'battle',
        reason: '战斗日志追加只改传进来的行；attack/useSkill/monsterTurn/flee 四个入口都是 ActiveBattle.findOne(…, lock: t.LOCK.UPDATE) 之后才调它'
    },
    {
        file: 'game/services/SectService.js', model: 'playerSect',
        helper: '_checkAndResetDailyQuests', rowParam: 'playerSect',
        reason: '跨天清零只改传进来的实例；dailyCheckIn/submitQuest/acceptQuest 都是 PlayerSect.findOne(…, LOCK.UPDATE) 之后才调；面板那条走 _resetDailyQuestsForRead 的条件写，不调这个 helper'
    },
    {
        file: 'game/services/TaoismGateService.js', model: 'playerTaoismGate',
        helper: '_checkDailyReset', rowParam: 'gate',
        reason: '道途行的 daily_tasks/skill_cooldowns 是整块列，本文件规定写路径必须先过集中取锁助手 _lockGate（同文件注释），helper 只改传进来的那份'
    },
    {
        file: 'game/services/TaoismGateService.js', model: 'playerTaoismGate',
        helper: '_updateTaskProgress', rowParam: 'gate',
        reason: '同上：进度累加发生在 helper 内，行由调用方经 _lockGate 锁好后传入'
    },
    {
        file: 'game/services/TaoismGateService.js', model: 'playerTaoismGate',
        helper: '_executeWaterMirror', rowParam: 'gate',
        reason: '水镜决技能冷却写回发生在 helper 内；调用入口先 _lockGate 拿行再传进来'
    },
    {
        file: 'game/services/TaoismGateService.js', model: 'playerTaoismGate',
        helper: '_executeFireEye', rowParam: 'gate',
        reason: '火眼窥技同上一条形状（行由调用方锁好后传入）'
    },
    {
        file: 'game/services/BeastPastureService.js', model: 'spiritBeastPasture',
        helper: '_settlePasture', rowParam: 'pasture',
        reason: '锁顺序契约 SpiritBeast → SpiritBeastPasture → PlayerGarden：结算不自己读放养行，由 recallBeast / checkExpirations 锁好后传进来（#26，真库并发探针复现过丢写与死锁）'
    }
];

/** 找出某个函数/方法的起止行（大括号配平；找不到返回 null） */
function helperRange(file, helper) {
    const src = sources.find(s => s.rel === file);
    if (!src) return null;
    const lines = src.src.split(/\r?\n/);
    // 三种形状都要认：类方法 `name(...) {`、模块级 `function name(...) {`、`const name = (…) => {`
    const headRe = new RegExp(`^\\s*(?:(?:static|async)\\s+)*(?:function\\s+)?${helper}\\s*\\(|^\\s*(?:const|let|var)\\s+${helper}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(`);
    const head = lines.findIndex(l => headRe.test(l));
    if (head < 0) return null;
    let depth = 0;
    for (let i = head; i < lines.length; i++) {
        depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
        if (depth <= 0 && i > head) return { start: head + 1, end: i + 1, headLine: lines[head] };
    }
    return { start: head + 1, end: lines.length, headLine: lines[head] };
}

/** 这个登记项覆盖的行号区间（helper 函数体内部） */
function callerLockedHelperLines(file, entry) {
    const range = helperRange(file, entry.helper);
    if (!range) return [];
    return Array.from({ length: range.end - range.start + 1 }, (_, k) => range.start + k);
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
    'pvpBattleRecord.battle_log': ['game/services/DuelService.js', 'game/services/PvpService.js', 'routes/admin_pvp.js'],
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

/**
 * 单写方、看不到行锁的整块列：**每条都要有结论**（下面那条用例逐条查）。
 * 写不出结论就去修（条件写 / 加锁 / 登记"锁在调用方"），不要把条目删掉了事。
 */
const SINGLE_WRITER_LEDGER = {
    'playerEquipment.deep_line_state ← game/services/ArtifactDeepLineService.js': {
        count: 25, verdict: 'accepted_by_design',
        reason: '逐条定性完（2026-09-21）：25 处赋值分属 19 个方法，15 个业务方法都经 '
            + 'this._findXxxEquipment(playerId, t, true) 带 FOR UPDATE 读行后再整块写回；'
            + '另外 4 处是 _init…State(equipment) 只给传进来的行补默认值、自己不 save。'
            + '这条不变量由 tests/DeepLineLockOrder.test.js 钉住（含"助手收到 lock=true 必须真的加锁"与'
            + '"初始化器里不许出现 save/update"两条，控制跑：把一个调用点改成无锁立刻红）'
    },
    'spiritBeast.stat_block ← game/services/SpiritBeastService.js': {
        count: 1, verdict: 'accepted_by_design',
        reason: '值恒等于 computeStats 对内容的整块重算（applyComputedStats 唯一入口），灵兽行只有主人和 GM 会写；'
            + '并发时丢的是 GM 那一笔手工值，不会丢玩家进度。给灵兽加一档属性不再需要改表，所以这一列长期存在'
    },
    'system_config.value ← routes/admin.js': {
        count: 1, verdict: 'accepted_by_design',
        reason: 'GM 保存配置是"把调用方给的完整配置文档整个覆盖这一个键的行"（`config.value = value`，'
            + '不读旧值、不做局部合并），语义等同重写一个文件：两个管理员同时编辑同一个键，后写的赢，'
            + '但不会吃掉别的键、也不会吃掉本行别的时间写的东西。现网只有一个管理员。'
            + '**什么时候必须重判**：如果后台改成"只改一个字段"的局部编辑（读出来 merge 再整块写回），'
            + '这里就要改成带行锁的读-改-写或键级补丁'
    },
};

/**
 * "写方只走 update/set"那一桶的结论（2026-09-22 逐条看完）。
 * 这一类的形状与上面不同：它不整列覆盖别的列，所以赋值型检测器看不见它，
 * 但**同一列的读-改-写照样互相覆盖** —— 系统公告的 metadata 就真是这么丢过键（见 cas_merged 那条）。
 */
const UPDATE_SET_LEDGER = {
    'beastInvasion.aggregated_battle_log': {
        writers: ['game/services/BeastInvasionService.js'], verdict: 'accepted_by_design',
        reason: '整块值由 beast_invasion_attacks 的 COUNT/SUM 现算（aggregateBattleReport 第 1837–1868 行），'
            + '从不读旧的那一份再合并 —— 战报是**派生快照**，两个窗口同时跑谁后写谁显示，下一轮自然重算回来。'
            + '这一列里没有任何玩家资产或累计账。真正会丢东西的是老写法"无锁读整行 → save()"把别人正在扣的'
            + 'hp_current 原样写回去，那一处已改成只写自己算出来的这一列（文件里第 1870–1876 行的注释记着这段）'
    },
    'playerAdventure.rewards': {
        writers: ['game/services/AdventureEventService.js'], verdict: 'accepted_by_design',
        reason: '只有一个写方：完成历练那笔事务里写自己算出的 result.granted（第 515–526 行），'
            + 'where 带 status:in_progress 且玩家/历练行已在事务内 FOR UPDATE。'
            + 'rewards 不是"读出来加一笔再写回"的累计账（granted 只装这一次真发到的东西，见 game/items/itemGrant.js），'
            + '重复结算进不来，所以这里没有可丢的增量；其余几处 PlayerAdventure.update 都只写 status/end_time 这类标量列'
    },
    'system_notification.metadata': {
        writers: ['game/services/NotificationService.js'], verdict: 'cas_merged',
        reason: '两个互不知晓的写方合并同一块 JSON：GM 编辑公告写 imageUrls / 清 notice_pushed，'
            + '调度器写 notice_pushed / pushed_at。改造前两条都是"无锁读 → 内存合并 → 整块 update"，'
            + '交错时确实互相抹键（控制跑里 GM 刚写的配图被抹成 []，或推送标记被抹掉 → 同一张公告又全服弹一次）。'
            + '现在两处都走 mergeMetadataCas：写回的 where 带上"我读到的那份原值"，撞 0 行就重读最新那份再合，'
            + '重试用尽抛错而不是静默盲写。形状由下面那条硬闸钉，运行时证据 scripts/smoke_notification_race.js（4/4）'
            + '+ tests/NotificationScheduling.test.js 的 CAS 撞车/不重复写用例'
    },
};

/**
 * cas_merged 的依据要能在代码里查到：这个文件里必须存在"把本列原值写进 where"的条件写回。
 * 只认这个形状，不接受"我看过了应该没事"。
 */
function casMergedWrite(file, column) {
    const src = sources.find(s => s.rel === file);
    if (!src) return false;
    const code = stripComments(src.src);
    return new RegExp(`where:\\s*\\{[^}]*\\b${column}:\\s*[A-Za-z_$][\\w$]*\\s*\\}`).test(code)
        && /update\(/.test(code);
}

describe('整块 JSON 列的户口册（旧快照覆盖新快照这一类的闭合清单）', () => {
    test('检测器有效：39 个模型上扫到 60 个以上整块列（含 TEXT 当 JSON 用的那些）', () => {
        const models = new Set(columns.map(c => c.model));
        // 2026-09-21 实测 65 条（声明上就是整块的 53 + 代码里确实按整块 JSON 读写的 TEXT 12）。
        // 门槛写 60：将来再往模型里塞整块列，这一条不会悄悄少看。
        if (columns.length < 60 || models.size < 25) {
            throw new Error(`检测器只找到 ${columns.length} 列 / ${models.size} 个模型 —— `
                + '模型写法变了（缩进、JSON 列定义形状、或伪 JSON 的判据失配），这条闸已经在看不到东西，先修检测器');
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
                    continue;   // 只走 update/set 的写方由下面那条 backlog 统一摊开
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
        /**
         * "只走 update/set"的那一桶：上面两条硬闸只看得到"整列赋值"，
         * 这一类不整列覆盖别的列，但**同一列的读-改-写照样互相覆盖**
         * （例：改公告 metadata 是 `JSON.parse(现值) → 合并 → update`）。
         * 现在按"全部写方都只走 update/set"摊出来让人看得见；逐个定性之后再升硬门禁（别把条数当成绩）。
         */
        const updateOnlyBacklog = [];
        for (const { at } of columns) {
            if (guardedNames.has(at)) continue;
            const [model, column] = at.split('.');
            const ws = writersOf(model, column);
            if (!ws.length || !ws.every(w => updateOnly(w, model, column))) continue;
            updateOnlyBacklog.push(`${at} ← ${ws.join(', ')}`);
        }
        console.log(`[blob 户口册] 写方只走 update/set（不进锁判定）的整块 JSON 列 ${updateOnlyBacklog.length} 个：\n  ${updateOnlyBacklog.join('\n  ')}`);

        /**
         * 2026-09-22：这一桶逐条定性完毕，改成与上面两条硬闸同样的双向台账 ——
         * 少一处（修好了）与多一处（新隐患）都会红，`cas_merged` 还要静态证明那个形状还在。
         * verdict 的含义：
         *   accepted_by_design —— 整块值本来就恒为"现算/覆盖语义正确"，没有可丢的增量
         *   cas_merged         —— 读-改-写真的存在，但写回带上了"我读到的原值"这一条件（见 mergeMetadataCas）
         *   known_risk_pending_triage —— 承认还没看完，处数钉死
         */
        const updateOnlyProblems = [];
        const seenUpdateOnly = new Set();
        for (const { at } of columns) {
            if (guardedNames.has(at)) continue;
            const [model, column] = at.split('.');
            const ws = writersOf(model, column);
            if (!ws.length || !ws.every(w => updateOnly(w, model, column))) continue;
            seenUpdateOnly.add(at);
            const entry = UPDATE_SET_LEDGER[at];
            if (!entry) {
                updateOnlyProblems.push(`${at}（写方 ${ws.join(', ')}）没有定性结论 —— 逐条看完给出 verdict + 依据，或改成行锁/条件写`);
                continue;
            }
            if (entry.writers.slice().sort().join(',') !== ws.slice().sort().join(',')) {
                updateOnlyProblems.push(`${at} 登记的写方是 ${entry.writers.join(', ')}，现在扫到的是 ${ws.join(', ')}：多出来的要先定性，少掉的要回来改结论`);
            }
            if (!['accepted_by_design', 'cas_merged', 'known_risk_pending_triage'].includes(entry.verdict)) {
                updateOnlyProblems.push(`${at} 的 verdict=${entry.verdict} 不合法`);
            }
            if (!entry.reason || entry.reason.length < 40) updateOnlyProblems.push(`${at} 的依据太短（要能在代码里查到）`);
            if (entry.verdict === 'cas_merged') {
                for (const w of entry.writers) {
                    if (!casMergedWrite(w, column)) {
                        updateOnlyProblems.push(`${at} 的写方 ${w} 里找不到"${column} 的条件写回"了 —— CAS 被摘掉就等于退回旧快照覆盖新快照`);
                    }
                }
            }
        }
        for (const at of Object.keys(UPDATE_SET_LEDGER)) {
            if (!seenUpdateOnly.has(at)) {
                updateOnlyProblems.push(`${at} 已经不在这一桶里了 —— 把结论删掉，并写清是怎么修的（换成了行锁？还是不再整块写？）`);
            }
        }
        if (updateOnlyProblems.length) throw new Error(updateOnlyProblems.join('\n'));
        expect(problems).toEqual([]);
    });

    /**
     * 公告 metadata 那两路的 CAS 形状（把 verdict 里"写回带原值条件"这句话钉成可执行的）。
     *
     * 为什么单独立一条：`system_notifications.metadata` 是 TEXT 里装 JSON 的整块列，
     * 两个写入方（GM 编辑公告 / 调度器打 notice_pushed）互相不知道对方存在，
     * 摘掉原值条件就退回"拿旧快照盖新快照"—— 玩家侧的表现是公告少一张配图，
     * 或者同一张公告下一轮又全服弹一次。运行时证据在 scripts/smoke_notification_race.js
     * （控制跑：把 where 里的原值删掉 → N1 直接报 `imageUrls:[]`，N2 12 轮里红 3 轮）。
     */
    test('公告 metadata 的写回必须带"我读到的原值"这个条件，撞车要重读再合、不许静默退回盲写', () => {
        const svc = sources.find(s => s.rel === 'game/services/NotificationService.js');
        if (!svc) throw new Error('NotificationService.js 不在了 —— 这条闸已经在看不到东西');
        const code = stripComments(svc.src);
        // 按大括号配平取整个函数体：`[\s\S]*?\n\s*\}` 这种非贪婪会在函数里第一个缩进的 `}` 处停下，
        // 于是三条检查都只看到函数开头几行 —— 那种"看着在判、其实判的是半截代码"的闸最坏，
        // 它会在新加的 helper 上稳定报红，却永远看不见真正的盲写。
        const bodyOf = name => {
            const lines = code.split(/\r?\n/);
            const head = lines.findIndex(l => new RegExp(`^async function ${name}\\s*\\(`).test(l));
            if (head < 0) return null;
            let depth = 0;
            for (let i = head; i < lines.length; i++) {
                depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
                if (depth <= 0 && i > head) return lines.slice(head, i + 1).join('\n');
            }
            return null;
        };
        const body = bodyOf('mergeMetadataCas');
        const problems = [];
        if (!body) {
            problems.push('找不到 mergeMetadataCas（整函数）—— metadata 的合并写回又散回两个调用点了？');
        } else {
            if (!/where:\s*\{\s*id,\s*metadata:\s*previous\s*\}/.test(body)) {
                problems.push('mergeMetadataCas 的写回没有把原值放进 where（=盲写整块，两个写方会互相抹键）');
            }
            if (!/previous\s*=\s*undefined/.test(body)) {
                problems.push('CAS 撞车后没有把 previous 清回去重读 —— 拿同一份旧值重试永远不会成功，最后只会抛错或硬盖');
            }
            if (!/throw new Error/.test(body)) {
                problems.push('重试次数用尽后没有抛错 —— 静默放弃等于"这次的修改没了"，玩家看不到任何提示');
            }
        }
        // 整块写 metadata 的地方只能有一处（helper 内部）；实例式 update 一律算倒退
        const blindWrites = code.split(/\r?\n/)
            .map((line, i) => ({ line, n: i + 1 }))
            .filter(({ line }) => /\.update\(\s*\{[^)]*\bmetadata\s*:/.test(line) && !/where/.test(line));
        if (blindWrites.length) {
            problems.push(`又出现"整块写 metadata 却不带条件"的写点（行 ${blindWrites.map(b => b.n).join(',')}）`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });

    /**
     * 归属判定自己不能是空跑，也不能宽到看不见真写方。
     * 这条存在的原因：2026-09-21 那次假红 —— admin.js 只因为 import 过 models/item，
     * 它对 system_notification.metadata 的写就被算成 item 的第二写方。
     * 反方向同样要防：receiver 认不出来时必须**照最坏情况计入**，否则"换个变量名"就能绕过整道闸。
     */
    /**
     * "写序列化副本"不能算成这一列的写方，但也不能借这条躲掉真正的行写：
     * 夹具里第 4 行写的是 toJSON() 的副本（不算），第 8 行写的是 findByPk 拿到的行（必须算）。
     */
    test('写方归属区分"数据库行"与"序列化副本"（既不误报，也不给真写点开脱）', () => {
        const fake = [
            "const Item = require('../models/item');",
            'async function assemblesResponse(id) {',
            '  const row = await Item.findByPk(id);',
            '  const plain = row.toJSON();',
            '  plain.some_blob = JSON.parse(plain.some_blob);',   // 副本：不算写方
            '  return plain;',
            '}',
            'async function writesRow(id) {',
            '  const row = await Item.findByPk(id);',
            '  row.some_blob = \'{"a":1}\';',                      // 行：必须算
            '}',
            'async function parsesIntoFreshVar(rawJson) {',
            '  const parsed = JSON.parse(rawJson);',
            '  parsed.some_blob = 1;',                            // 刚 parse 出来的普通对象：不算写方
            '  return parsed;',
            '}'
        ].join('\n');
        const lineOwners = (text) => {
            const copies = plainCopyVars(text);
            return columnWriteSites(text, 'some_blob')
                .filter(s => !copies.has(s.receiver))
                .map(s => s.line);
        };
        expect(lineOwners(fake)).toEqual([10]);                   // 只有第 10 行那一次是真的写行
        expect([...plainCopyVars(fake)].sort()).toEqual(['parsed', 'plain']);
    });

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
        // 认不出来源的那条（assign@8）同时计入 system_notification：**这正是保守方向** ——
        // 归属只用来排除"明确属于别的表"的写点，绝不用来放过来源不明的写点。
        expect(owned('system_notification')).toEqual(['update@5', 'assign@8']);
    });

    /**
     * 作用域判定不能退化成"文件里哪儿有锁都行"：
     * 下面这份夹具里两个函数形状一样，只有第一个真的在取行时带了 LOCK.UPDATE，
     * 第二个用的是无锁读 —— 如果判定器把第一个的锁算到第二个头上，这条就红。
     */
    test('行锁判定按大括号配平的作用域判，不会把别的函数里的锁算过来（防空跑/防放宽）', () => {
        const fixture = [
            "const Foo = require('../models/foo');",
            'async function withLock(t) {',
            "  const row = await Foo.findByPk(1, { transaction: t, lock: t.LOCK.UPDATE });",
            '  row.blob_col = {};',
            '}',
            'async function withoutLock(t) {',
            '  const other = await Foo.findByPk(2, { transaction: t });',
            '  other.blob_col = {};',
            '}'
        ];
        const names = 'Foo';
        const lockedAt = enclosingScopes(fixture, 3).some(sc => lockedFetchIn(sc.body, names));
        const unlockedAt = enclosingScopes(fixture, 7).some(sc => lockedFetchIn(sc.body, names));
        expect(lockedAt).toBe(true);
        expect(unlockedAt).toBe(false);
        // 顺带钉住"找不到作用域"不会被当成通过
        expect(enclosingScopes(['  orphan.blob_col = {};'], 0)).toEqual([]);
    });

    /**
     * "锁在调用方"的登记必须能被查：helper 确实收那两个参数、调用方确实带 FOR UPDATE 取这一行、
     * 并且真的把那个变量传进去了。谁把那句锁摘了，这条就红（而不是像以前一样只写在注释里）。
     */
    test('"锁在调用方"的登记要逐条复查仍然成立', () => {
        for (const entry of CALLER_LOCKED_HELPERS) {
            const src = sources.find(s => s.rel === entry.file);
            if (!src) throw new Error(`${entry.file} 不在了 —— 这条登记该删`);
            const range = helperRange(entry.file, entry.helper);
            if (!range) throw new Error(`${entry.file} 里找不到 ${entry.helper}() —— 登记已过期`);
            expect(range.headLine).toContain(entry.rowParam);
            if (entry.reason.length <= 20) throw new Error(`${entry.file}::${entry.helper} 的登记依据太短`);

            const aliases = modelAliases(entry.file, entry.model).map(a => escapeRe(a)).join('|');
            // 两种"取行就锁"的合规形状：
            //   a) 直接 `row = await Model.findByPk/findOne(… LOCK.UPDATE …)`
            //   b) 走本仓的集中取锁助手 `row = await this._lock…(`（锁收在一个方法里）
            const lockedFetch = new RegExp(
                `(?:const|let|var)\\s+${escapeRe(entry.rowParam)}\\s*=\\s*await\\s*(?:`
                + `(?:${aliases})\\s*\\.\\s*(?:findByPk|findOne)\\s*\\([\\s\\S]{0,240}?LOCK\\s*\\.\\s*UPDATE`
                + `|this\\._lock[A-Za-z]*\\()`
            );
            if (!lockedFetch.test(src.src)) {
                throw new Error(`${entry.file} 里 ${entry.rowParam} 不再是"带行锁的取行"（直接 FOR UPDATE 或集中取锁助手都没有了）—— `
                    + `${entry.helper}() 的整块写回又变成"旧快照覆盖新快照"了，先把锁加回来`);
            }
            // 调用点形状有两种：类方法 `this._settlePasture(pasture, …)`、模块级函数 `appendBattleLog(battle, …)`；
            // 行参数也不一定在第一位（`this._executeWaterMirror(player, gate, t)`），所以在整个实参表里找。
            const passesTheRow = new RegExp(`(?:this\\.)?${escapeRe(entry.helper)}\\([^)]*\\b${escapeRe(entry.rowParam)}\\b`);
            if (!passesTheRow.test(src.src)) {
                throw new Error(`${entry.file} 里再没有把 ${entry.rowParam} 传给 ${entry.helper}() 的调用 —— 检查是不是换了取法`);
            }
        }
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
        //   activeBattle.battle_log —— 2026-09-21 更正：以前记成"检测器盲区（模块级函数认不出）"，
        //     那是错的 —— 是 METHOD_HEAD 正则不认 `function name(args) {`，现已修。
        //     它仍在名单里是因为锁真的在调用方（appendBattleLog(battle, entry) 只改传进来的行，
        //     自己不加锁）；要让它离开名单，得像 DuelService._settleDuel 那样登记"锁在调用方"并让人复查。
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
            if (bad.length) risky.push({ at, file: writers[0], lines: bad, key: `${at} ← ${writers[0]}` });
        }
        console.log(`[blob 户口册] 单写方且看不到行锁的整块 JSON 列 ${risky.length} 个：\n  ${risky.map(r => `${r.key}（行 ${r.lines.join(',')}）`).join('\n  ')}`);

        /**
         * 上面那条日志不再是"看看而已"：每一条都必须在这里有一个结论。
         * verdict 只有三种，各自含义写死，不许用"单写方所以安全"糊过去：
         *   accepted_by_design         —— 值恒为整块重算/覆盖语义本就是对的，写清丢了会怎样
         *   known_risk_pending_triage  —— 承认定性没做完，处数钉死：多一处红（防止边改边扩）
         *   caller_locked            —— 锁在调用方，去 CALLER_LOCKED_HELPERS 登记（不归这里）
         */
        const problems = [];
        const seen = new Set();
        for (const r of risky) {
            seen.add(r.key);
            const entry = SINGLE_WRITER_LEDGER[r.key];
            if (!entry) { problems.push(`${r.key}（行 ${r.lines.join(',')}）没有定性结论 —— 给出 verdict + 依据，或修成条件写/加锁`); continue; }
            if (entry.count !== r.lines.length) {
                problems.push(`${r.key} 命中 ${r.lines.length} 处，登记的是 ${entry.count} 处：多一处是新隐患，少一处是真修掉了，回来改结论`);
            }
            if (!['accepted_by_design', 'known_risk_pending_triage'].includes(entry.verdict)) {
                problems.push(`${r.key} 的 verdict=${entry.verdict} 不合法（只允许 accepted_by_design / known_risk_pending_triage；锁在调用方请登记 CALLER_LOCKED_HELPERS）`);
            }
            if (!entry.reason || entry.reason.length < 20) problems.push(`${r.key} 的依据太短`);
        }
        for (const key of Object.keys(SINGLE_WRITER_LEDGER)) {
            if (!seen.has(key)) problems.push(`${key} 已经不在名单里了 —— 把结论删掉，并说明是怎么修/怎么验的`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
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
