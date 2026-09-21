'use strict';
/**
 * 取锁次序普查 + 存量债务闸门。
 *
 * 为什么要有这条：InnoDB 逐行加锁，两个事务各持一行再去要对方那行就是 ABBA 死锁。
 * 同一个玩家的两个面板同时点，天然就是这个形状。本会话已经在这种事上真翻过 5 次
 * （宗门战、放养偷菜、封神台 setDefense、太一门互放技能、灵兽PVP 对局 vs 结算），
 * 每次都是"读一个文件改一处"。这里把它变成全局可见、只许减不许增的清单。
 *
 * 口径在 game/persistence/lockOrder.js。清单外的每一对都必须只有一种次序。
 *
 * 分析器本身也要自证（两次翻车都记在这里，别再犯）：
 *   ① 判得太松 → 全是假对，清单长到没人看（第一版把 switch 的两个互斥 case 当成"先锁 A 再锁 B"）；
 *   ② 判得太严 → **把真对吃掉**，比假阳更致命（第二版按"外层块头不同即互斥"，
 *      连 CombatService.encounter 那个确凿的 player→activeBattle 都丢了）。
 * 所以判定 fail-open：只认两种能证明的互斥（同一 switch 的不同 case、if 与它的 else），其余一律照报。
 */
const fs = require('fs');
const path = require('path');

const { LOCK_PRECEDENCE, rankOf, lockRowsInOrder } = require('../game/persistence/lockOrder');

const serverRoot = path.join(__dirname, '..');
const MODEL_NAMES = new Set(fs.readdirSync(path.join(serverRoot, 'models'))
    .filter(n => n.endsWith('.js')).map(n => n.replace(/\.js$/, '')));
const LOWER_TO_MODEL = new Map();
for (const m of MODEL_NAMES) if (!LOWER_TO_MODEL.has(m.toLowerCase())) LOWER_TO_MODEL.set(m.toLowerCase(), m);
const normModel = raw => LOWER_TO_MODEL.get(String(raw).toLowerCase()) || String(raw);

const SRC_DIRS = ['game', 'routes', 'modules'];
const HEAD = /^\s{0,8}(?!\b(?:if|for|while|switch|catch|return|else|do|try)\b)(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
const LOCKED_FETCH = /\b([A-Z][A-Za-z0-9_]*)\s*\.\s*(?:findByPk|findOne|findAll|findAndCountAll)\s*\(([\s\S]{0,400}?)LOCK\.UPDATE/g;
const HELPER_CALL = /this\._(lock[A-Za-z0-9_]+)\s*\(/g;
// lockOrder.js 的升序批锁助手：`lockRowsByIdsAsc(t, Player, [ids])`。
// 不认这一条的话，"改对了"的方法会从普查里**消失**（它没有 Model.findByPk 那种写法了），
// 于是存量清单会因为"看不见"而变短 —— 那是假清零。控制跑（往 accept 塞回反向补读必须红）压的就是这条。
const BATCH_LOCK_CALL = /\blockRowsByIdsAsc\s*\(\s*[^,()]*,\s*([A-Z][A-Za-z0-9_]*)\s*,/g;

function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') sourceFiles(p, out); }
        else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
}
const sources = SRC_DIRS.flatMap(d => sourceFiles(path.join(serverRoot, d)))
    .map(f => ({ rel: path.relative(serverRoot, f).replace(/\\/g, '/'), src: fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') }))
    .filter(s => /LOCK\.UPDATE/.test(s.src));

function methodsOf(src) {
    const lines = src.split('\n');
    const out = [];
    lines.forEach((l, i) => {
        const m = HEAD.exec(l);
        if (!m) return;
        let depth = 0, end = i;
        for (let j = i; j < lines.length; j++) {
            depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
            if (depth <= 0 && j > i) { end = j; break; }
        }
        out.push({ name: m[1], line: i + 1, body: lines.slice(i, end + 1).join('\n') });
    });
    return out;
}

function modelsOfAlias(src) {
    const map = new Map();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\('[^']*models\/([A-Za-z0-9_]+)'\)/g)) {
        map.set(m[1], m[2]);
    }
    return map;
}

/**
 * 逐字符处理括号，不用"这行开了几个 / 关了几个"做算术 ——
 * `}, { transaction: t });` 这种一行里 关-开-关 的写法，按数量算必然错位
 * （第一版就是这样把 switch 帧提前弹掉，互斥 case 反而判成"可同时执行"）。
 * 每条语句记录它**行首时刻**的栈快照：switchGroup/label/branchGroup。
 * 判不准就往"可能同时执行"那侧倒（假阳有人读，假阴没人发现）。
 */
function analyzeBody(bodyLines) {
    const stack = [];      // {kind, group, label, branchGroup}
    const info = [];
    let groupSeq = 0;
    let lastClosedIf = null;   // 刚被 `}` 闭合的那个 if 帧的分支组号（后面紧跟 else 时继承它）

    for (let i = 0; i < bodyLines.length; i++) {
        const raw = bodyLines[i];
        const t = raw.trim();
        const switchFrame = [...stack].reverse().find(x => x.kind === 'switch');
        const branch = [...stack].reverse().find(x => x.branchGroup);
        info[i] = {
            switchGroup: switchFrame ? switchFrame.group : null,
            label: switchFrame ? switchFrame.label : null,
            branchGroup: branch ? branch.branchGroup : null
        };

        const isCaseLabel = /^case\b|^default\b/.test(t);
        let openedIf = /^\s*if\b/.test(t) || /^}\s*else\s+if\b/.test(t);
        let openedElse = /^}\s*else\b|^\s*else\b/.test(t) && !/else\s+if\b/.test(t);
        let openedSwitch = false;

        for (let c = 0; c < raw.length; c++) {
            const ch = raw[c];
            if (ch === '}') {
                const popped = stack.pop();
                if (popped && popped.kind === 'if') lastClosedIf = popped.branchGroup;
            } else if (ch === '{') {
                const group = ++groupSeq;
                const kind = openedSwitch || /\bswitch\b\s*\(/.test(raw.slice(0, c + 1)) ? 'switch'
                    : openedElse ? 'else'
                        : openedIf ? 'if' : 'other';
                if (kind === 'switch') openedSwitch = true;
                stack.push({
                    kind,
                    group,
                    label: null,
                    // else 继承它闭合的那个 if 的组号：if 支与 else 支里的两处才会被判互斥。
                    // try / for / 方法体这些一律 null —— 它们不构成互斥。
                    branchGroup: kind === 'else' ? (lastClosedIf || group) : (kind === 'if' ? group : null)
                });
                lastClosedIf = null;
                openedIf = false; openedElse = false;
            }
        }
        if (isCaseLabel) {
            for (let k = stack.length - 1; k >= 0; k--) {
                if (stack[k].kind === 'switch') { stack[k].label = t.replace(/\s*:\s*$/, ''); break; }
            }
        }
    }
    return info;
}

function exclusive(a, b) {
    if (!a || !b) return false;
    if (a.switchGroup !== null && a.switchGroup === b.switchGroup && a.label !== b.label) return true;
    if (a.branchGroup !== null && b.branchGroup !== null && a.branchGroup !== b.branchGroup) return true;
    return false;
}

function lockSites(body) {
    const info = analyzeBody(body.split('\n'));
    // 一个方法体里可以先后开两笔事务（股市 buy/sell 就是：主事务出清、提交后再开 t2 只推价格）。
    // 两笔事务各持各的锁，互相等不成环，所以**句柄名不同**的两处不算同一条锁链。
    // 只认"名字确实等于一次 sequelize.transaction() 的返回值"的句柄；
    // 别名（const t2 = t）不算证据 —— 判不准时照报，宁多一个假阳，不许吃掉真对。
    const declared = new Set([...body.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?sequelize\.transaction\s*\(/g)].map(m => m[1]));
    const sites = [];
    for (const x of body.matchAll(LOCKED_FETCH)) {
        const handle = /transaction:\s*([A-Za-z_$][\w$]*)/.exec(x[2] || '');
        sites.push({
            at: x.index, model: x[1],
            tx: handle && declared.has(handle[1]) ? handle[1] : null,
            ctx: info[body.slice(0, x.index).split('\n').length - 1]
        });
    }
    for (const h of body.matchAll(HELPER_CALL)) {
        sites.push({
            at: h.index, helper: '_' + h[1],
            ctx: info[body.slice(0, h.index).split('\n').length - 1]
        });
    }
    for (const b of body.matchAll(BATCH_LOCK_CALL)) {
        // 批锁的句柄是位置参数（第一个），拿不到事务名 → tx 记 null（判不准时照报，宁多一个假阳）
        sites.push({
            at: b.index, batchModel: b[1],
            ctx: info[body.slice(0, b.index).split('\n').length - 1]
        });
    }
    return sites.sort((a, b) => a.at - b.at);
}

/** 全仓：模型对 → 该对出现过的次序（`a>b` / `b>a`）与出处 */
function scan() {
    const pairOrders = new Map();
    let multiLockMethods = 0;
    for (const { rel, src } of sources) {
        const alias = modelsOfAlias(src);
        const methods = methodsOf(src);
        const helpers = new Map();
        for (const m of methods) {
            if (!/^_lock/.test(m.name)) continue;
            helpers.set(m.name, [...m.body.matchAll(LOCKED_FETCH)].map(x => normModel(alias.get(x[1]) || x[1])));
        }
        for (const m of methods) {
            const sites = lockSites(m.body);
            if (sites.length < 2) continue;
            multiLockMethods++;
            const resolved = sites.map(s => {
                const models = s.helper
                    ? (helpers.get(s.helper) || [])
                    : [normModel(alias.get(s.batchModel || s.model) || (s.batchModel || s.model))];
                return { ctx: s.ctx, tx: s.tx || null, models: models.filter(x => MODEL_NAMES.has(x)) };
            });
            for (let i = 0; i < resolved.length; i++) {
                for (let j = i + 1; j < resolved.length; j++) {
                    if (exclusive(resolved[i].ctx, resolved[j].ctx)) continue;
                    if (resolved[i].tx && resolved[j].tx && resolved[i].tx !== resolved[j].tx) continue;
                    for (const a of resolved[i].models) for (const b of resolved[j].models) {
                        if (a === b) continue;
                        const key = [a, b].sort().join('|');
                        if (!pairOrders.has(key)) pairOrders.set(key, new Map());
                        const dir = a + '>' + b;
                        if (!pairOrders.get(key).has(dir)) pairOrders.get(key).set(dir, []);
                        const where = `${rel}:${m.line} ${m.name}`;
                        if (!pairOrders.get(key).get(dir).includes(where)) pairOrders.get(key).get(dir).push(where);
                    }
                }
            }
        }
    }
    return { pairOrders, multiLockMethods };
}

/**
 * 存量债务：这些表对目前在不同方法里次序不一致，**已读到、还没逐个压成死锁**。
 * 只许减不许增：改好一对就把那行删掉（留着会在它真的被统一时反而报红）。
 * 新增一对 = 有人引入了新的取锁次序，闸门直接红。
 */
const LOCK_ORDER_DEBT = [
];

const scanned = scan();
const inconsistent = [...scanned.pairOrders.entries()].filter(([, dirs]) => dirs.size >= 2).map(([k]) => k).sort();

describe('取锁次序普查（ABBA 死锁这一类的闭合清单）', () => {
    test('分析器确实在看真代码：多锁方法与模型对的数量级对得上（防空跑）', () => {
        if (sources.length < 30) throw new Error(`只读到 ${sources.length} 个带 LOCK.UPDATE 的文件，扫描范围不对`);
        if (scanned.multiLockMethods < 120) {
            throw new Error(`只认出 ${scanned.multiLockMethods} 个"一处以上加锁"的方法 —— 取锁写法变了，先去修检测器再谈闸门`);
        }
        if (scanned.pairOrders.size < 60) {
            throw new Error(`只认出 ${scanned.pairOrders.size} 个模型对，多半是 LOCKED_FETCH 或别名解析断了`);
        }
    });

    test('分析器两头都不能错：互斥 case 要丢弃，同路径的真对不许丢', () => {
        const temple = sources.find(s => s.rel === 'game/services/DivineTempleService.js');
        const exchange = methodsOf(temple.src).find(m => m.name === 'exchangeOffering');
        if (!exchange) throw new Error('找不到 exchangeOffering —— 判例失效');
        const sites = lockSites(exchange.body);
        const sense = sites.find(s => s.model === 'PlayerDivineSense');
        const law = sites.find(s => s.model === 'PlayerLaw');
        if (!sense || !law) throw new Error('exchangeOffering 里认不出神识/法则两处加锁 —— 判例失效');
        if (!exclusive(sense.ctx, law.ctx)) {
            throw new Error('把同一个 switch 的两个互斥 case 当成能同时执行了 —— 清单会被假对灌满');
        }

        const combat = sources.find(s => s.rel === 'game/services/CombatService.js');
        const encounter = methodsOf(combat.src).find(m => m.name === 'encounter');
        if (!encounter) throw new Error('找不到 encounter —— 判例失效');
        const eSites = lockSites(encounter.body);
        const p = eSites.find(s => s.model === 'Player');
        const b = eSites.find(s => s.model === 'ActiveBattle');
        if (!p || !b) throw new Error('encounter 里认不出 players/active_battle 两处加锁 —— 判例失效');
        if (exclusive(p.ctx, b.ctx)) {
            throw new Error('把 CombatService.encounter 的真对（player→activeBattle，同一条路径）判成互斥了 —— 假阴比假阳致命');
        }

        // 第三条判例：同一个方法里先后开两笔事务，不能接成一条锁链
        //（股市 buy/sell 就是主事务出清、提交后再开 t2 只推一次价格）
        const stock = sources.find(s => s.rel === 'game/services/StockMarketService.js');
        const buy = methodsOf(stock.src).find(m => m.name === 'buy');
        if (!buy) throw new Error('找不到 StockMarketService.buy —— 双事务判例失效');
        const txNames = new Set(lockSites(buy.body).map(s => s.tx).filter(Boolean));
        if (!(txNames.has('t') && txNames.has('t2'))) {
            throw new Error(`buy 里没认出两笔事务句柄（实际=${[...txNames].join(',')}）—— `
                + '会把 t2 的锁接回主事务那条链上，凭空多出反向对');
        }
        if ((scanned.pairOrders.get('stock|stockHolding') || new Map()).size !== 1) {
            throw new Error('stock|stockHolding 仍被认出两种次序 —— 两笔事务还是被当成了一条链');
        }
    });

    test('次序不一致的模型对：只能比存量清单少，不能多', () => {
        const debt = [...LOCK_ORDER_DEBT].sort();
        const added = inconsistent.filter(k => !debt.includes(k));
        const gone = debt.filter(k => !inconsistent.includes(k));
        const problems = [];
        if (added.length) {
            problems.push(`新出现次序不一致的表对：${added.join(', ')}\n`
                + added.map(k => [...scanned.pairOrders.get(k).entries()]
                    .map(([dir, where]) => `  ${dir}  ${where.slice(0, 3).join(' | ')}`).join('\n')).join('\n')
                + '\n按 game/persistence/lockOrder.js 的口径统一取锁次序（能走 lockRowsInOrder 就走），别再加一种次序。');
        }
        if (gone.length) {
            problems.push(`这些对其实已经统一了，把 LOCK_ORDER_DEBT 里的行删掉（留着下次真被改回去就没人发现了）：${gone.join(', ')}`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });

    test('lockOrder 登记的表名都是真模型（打字错会让次序静默失效）', () => {
        const unknown = LOCK_PRECEDENCE.filter(m => !MODEL_NAMES.has(m));
        if (unknown.length) throw new Error(`LOCK_PRECEDENCE 里这些名字对不上 models/ 下的任何模型：${unknown.join(', ')}`);
        if (Number.isFinite(rankOf('绝对不存在的表'))) throw new Error('rankOf 对未知表不该给出有限次序');
    });

    test('lockRowsInOrder 必须一句一句按次序来（并发就等于没有次序）', async () => {
        const events = [];
        const t = { LOCK: { UPDATE: 'UPDATE' } };
        const spec = (model, name) => ({ model, lock: async () => { events.push(`start:${name}`); await null; events.push(`end:${name}`); } });
        // player 先，activeBattle 后 —— 故意把顺序反着传进去
        await lockRowsInOrder(t, [spec('activeBattle', 'battle'), spec('player', 'player')]);
        if (events.join(',') !== 'start:player,end:player,start:battle,end:battle') {
            throw new Error(`取锁次序没有真的串行：${events.join(',')}`);
        }
        await expect(lockRowsInOrder(t, [{ model: '没登记的表', lock: async () => {} }])).rejects.toThrow(/未登记/);
    });
});

/**
 * 同一张表内多行的加锁次序（上面那条跨表普查**看不见**这一类）
 *
 * 口径要求：同一张表的多行按主键升序一次锁齐。一个方法里对 players 连做两次 FOR UPDATE 单行读时，
 * 加锁次序就由业务参数决定（"先锁自己、再锁对方"），而对面那个人跑的正好是"先锁自己、再锁对方"
 * —— 两个真人各点自己那一头就是 ABBA，连"一个人开两个面板"都不需要。
 * 上面那条闸按"模型对"聚合，players|players 凑不成对，所以这类站点必须单列一道闸。
 *
 * 清单同样只许减不许增。划掉一行要自己压出环：scripts/smoke_lock_order_matrix.js 的 hammerPair
 * 支持两张表相同的情形（'stocks 同表两行' 那条就是模板），正序必须只排队、反序必须 deadlock。
 * 这是文本扫描，会把"外层方法套内层方法"重复计入，所以清单是**站点计数**不是判决书 ——
 * 划之前先读一遍那个方法，确认真有两行 players 在被逐个加锁。
 */
const PLAYERS_LOCK_ONE_BY_ONE = /\bPlayer\s*\.\s*(?:findByPk|findOne)\s*\([\s\S]{0,200}?LOCK\.UPDATE/g;
const ASC_BATCH_LOCK = /\.sort\(\(a, b\) => a - b\)|lockRowsByIdsAsc|findAll\(\s*\{[\s\S]{0,120}?id:\s*\[[\s\S]{0,60}?\][\s\S]{0,120}?ORDER|lockPlayersInOrder/i;

function sameTableSites() {
    const hits = [];
    let totalPlayerLockSites = 0;
    const filesWithSites = new Set();
    for (const { rel, src } of sources) {
        for (const m of methodsOf(src)) {
            const n = (m.body.match(PLAYERS_LOCK_ONE_BY_ONE) || []).length;
            if (n) { totalPlayerLockSites += n; filesWithSites.add(rel); }
            // 已经按升序一次锁齐的方法，门槛更严：批锁之后再夹任何一处单行 players FOR UPDATE 都要被看到
            //（"批锁 + 后面又逐笔补读"正是最容易偷偷回潮的形状 —— 控制跑压的就是这条）
            const batched = ASC_BATCH_LOCK.test(m.body);
            if (n >= (batched ? 1 : 2)) hits.push(`${rel}#${m.name}${batched ? '（批锁之后仍有单行补读）' : ''}`);
        }
    }
    return { hits: hits.sort(), totalPlayerLockSites, filesWithSites: filesWithSites.size };
}

const SAME_TABLE_DEBT = [
    // 2026-09-21：这一类已经全部清零（拍卖一族 / 洞府鉴赏 / 洞天寻宝 / 悬赏发布 / 兽潮结算），
    // 清单留空之后**它仍然是增量护栏**，因为下面那条"扫描器还看得见多少锁站点"的底线（120 处 / 25 个文件）
    // 与"走助手的方法不该被认成逐个加锁"的自检会先红 —— 空清单不等于没在看。
    // 新代码里再出现"同一方法对 players 连做两次单行 FOR UPDATE"就会红在这里。
    // 洞府社交两条都改完了：鉴赏（§37，互鉴 4 轮 4 次 Deadlock → 0）与寻宝（§38，配额校验也一起挪进事务、
    // 锁住寻宝者之后再数；并发证据与"每轮清日志绕冷却"的办法见 smoke_cave_social T2/T3/T4）
    // 道侣两条通路全部改完（seek/accept/propose/respond/互动/解除/双修都走批锁），这里只剩别的系统
    // PVP 这一类里 DuelService 三处（两个真人互相发起最易真撞）已改走 lockRowsByIdsAsc，见本 describe 的自检
];

describe('同表多行逐个加锁的站点（players|players 这一类跨表普查的盲区）', () => {
    const scan = sameTableSites();
    const found = scan.hits;

    test('扫描器确实在看真代码：看得见全仓这批锁站点，且本会话改过的站点不在清单里（防空跑）', () => {
        // 底线放在"扫描器还能看见多少锁站点"上，不放"还剩几处债务"上。
        // 2026-09-21 实测：players 单行加锁读全仓 220 处、分布在 54 个文件，其中只有 10 处构成"同表逐个加锁"。
        // 以前写成 `found.length < 10`，债务每清一批就离红线近一步 —— 那会逼人把数字调小，
        // 而不是真防住"扫描器瞎了"；债务清零本来是好消息，不该被一条数字判成异常。
        if (scan.totalPlayerLockSites < 120) {
            throw new Error(`全仓只认出 ${scan.totalPlayerLockSites} 处 players 单行加锁读（实测 220），扫描范围或正则已失效`);
        }
        if (scan.filesWithSites < 25) {
            throw new Error(`这些锁站点只分布在 ${scan.filesWithSites} 个文件（实测 54），扫描范围不对`);
        }
        // 这四条是本次按口径改过的：批量升序锁齐之后就不该再被认出。认出来 = 判定条件是摆设。
        for (const done of ['game/services/CompanionService.js#seek', 'game/services/CompanionService.js#accept',
            'game/services/DaoCompanionService.js#propose', 'game/services/DaoCompanionService.js#respond']) {
            if (found.includes(done)) throw new Error(`${done} 已经改成升序批锁了，不该还在清单里 —— 判定没有真的识别 ASC 写法`);
        }
        // 这一组走的是 lockOrder.lockRowsByIdsAsc 助手（不带 .sort((a,b)=>a-b) 字样）：
        // 判定认不得助手调用，等于以后所有走助器的新方法都会被误报成债务，闸就会被人整个关掉。
        for (const viaHelper of ['game/services/PvpService.js#challenge',
            'game/services/PvpService.js#executeAction', 'game/services/PvpService.js#_settleBattle',
            'game/services/MultiDungeonService.js#_settleRewards',
            'game/services/DivineDuelService.js#challenge', 'game/services/DivineDuelService.js#_settleDuel',
            'game/services/CompanionService.js#dualCultivate', 'game/services/CompanionService.js#warmNourish',
            'game/services/CompanionService.js#pluckSupplement',
            'game/services/DaoCompanionService.js#interact', 'game/services/DaoCompanionService.js#breakCompanion',
            'game/services/CompanionService.js#breakCompanion', 'game/services/CompanionService.js#gmBreakDaoCompanion',
            'game/services/DaoCompanionService.js#dualCultivate',
            'game/services/DuelService.js#challenge', 'game/services/DuelService.js#executeDuelAction',
            'game/services/DuelService.js#rejectDuel',
            'game/services/DaoCompanionService.js#condenseHeartImprint',
            'game/services/SectWarService.js#attackPlayer',
            'game/services/AuctionService.js#placeBid', 'game/services/AuctionService.js#cancelAuction',
            'game/services/AuctionService.js#_settleOneAuction',
            'game/services/CaveSocialService.js#appreciateExhibit',
            'game/services/CaveSocialService.js#treasureHunt',
            'game/services/BountyService.js#publishBounty',
            'game/services/BeastInvasionService.js#_settleDefeat']) {
            if (found.includes(viaHelper)) throw new Error(`${viaHelper} 已经走 lockRowsByIdsAsc 了，判定却还把它算成逐个加锁`);
        }
    });

    test('同表逐个加锁的站点：只能比存量清单少，不能多', () => {
        const extra = found.filter(x => !SAME_TABLE_DEBT.includes(x));
        const gone = SAME_TABLE_DEBT.filter(x => !found.includes(x));
        const problems = [];
        if (extra.length) problems.push(`新增"同表逐个加锁"站点 ${extra.length} 处（要么改成按 id 升序一次锁齐，要么在闸里说明为什么安全）：\n  ${extra.join('\n  ')}`);
        if (gone.length) problems.push(`这些站点其实已经统一了，把 SAME_TABLE_DEBT 里的行删掉：${gone.join(', ')}`);
        if (problems.length) throw new Error(problems.join('\n'));
    });
});
