/**
 * 标量数值列的写回守卫（players 的钱袋子，与 spirit_beasts 的修为/忠诚/体力 —— 同一套机制）。
 *
 * 与 blobWriteGuard 同族、同一个洞的另一半：
 *   blobWriteGuard 管的是"一个字符串装一整个对象"的整块列（旧快照整块写回 → 别人的键永久消失）；
 *   本文件管的是**标量数值列**（spirit_stones / exp / loyalty / …）。
 *   那些列同样是"读出来 → 在 JS 里加减 → 整值写回"，只是覆盖单位从"一坨键"变成"一列"：
 *   `player.spirit_stones = BigInt(player.spirit_stones) + gain; player.save()`
 *   在这一行读和别人提交之间只要夹了一个 await，另一条流程刚扣掉的钱就被这里原样写回去了 ——
 *   少的那笔钱不会报错，也不会自愈。players 上这样的自引用赋值实测 **176 处 / 47 个文件**
 *   （普查口径：同一行 `\.col =` 且右值里又出现同一个 col；其中 8 处写在灵兽行上，
 *    players 行上 168 处），灵兽行上另有 ~17 处（exp / loyalty / stamina / star_level）。
 *
 * 为什么不逐点改成"列上原子自增"就完事：PlayerStateStore 的 grantAmount/spendAmount 是对的，
 * 但 176 处里绝大多数还带"扣到不能为负""按上限钳制""给对手也加一份"的判断，
 * 那些判断要读当前值。逐点重排风险高、且**新增的第 177 处照样裸奔**。
 * 所以这里做 blobWriteGuard 已经验证过的那件事：**把判定绑在写回这一步**，
 * 写之前比一次"我这行是从哪个值算出来的"和"库里现在是多少"，不一致就说明前提已经没了：
 *   - 在事务里 → 带 FOR UPDATE 读（这一读就把对手挡在锁外，判定与后续 UPDATE 之间没有窗口）；
 *   - 不在事务里 → 普通读，判定仍然成立，只是窗口从"整个请求"缩到"一次 SELECT 到 UPDATE 之间"
 *     （这一档是**探测器不是证明**：它能把现网真实形状的丢钱变成响的错误，
 *      要真正无窗口就得走事务 + 行锁，报错文案里就是这么指引的）。
 *
 * 两档强度（每张表各两个环境变量，见 createNumericWriteGuard）：
 *   wallet —— 钱与积分：判定不过就**拒绝写回**（players 默认 throw）。
 *   vital  —— hp_current / mp_current：默认只 warn。
 *     原因不是它们不重要，而是恢复/战斗这类路径的写法本来就是"按上限整值重设"
 *     （`hp_current = maxHp`、AttributeService 的属性刷新），这类写回在语义上就是最后一份说了算；
 *     先量清"库里已经变了还要整值写回"到底发生在谁身上，再决定要不要一起硬拦。
 *   灵兽那一表整体先挂在 warn 上量（见 models/spiritBeast.js），0 响才升 throw。
 *
 * 代价（如实记着，别当免费）：只要某次 save 带着这些列，就多半一次按主键的 SELECT
 * （事务里那次还是 FOR UPDATE）。不脏这些列时一次都不查（有测试钉）。
 * 真正不想付这笔的是"发钱/扣钱"这类高频路径 —— 它们本来就该走 grantAmount / spendAmount
 * 的列上原子写（bulk 路径，压根不触发 beforeSave），既没有额外读也没有覆盖风险。
 */
'use strict';

// 只依赖 logOnce：不 require config/database、不 require models/*，
// 那两条路都会绕回本文件的调用方（模型文件正是这里的挂载点）。
const { logOnce } = require('../../utils/logOnce');

/**
 * 值是不是"让数据库自己算"的表达式（literal / fn / col 这类 SequelizeMethod 都带字符串 val）。
 * 这一类写法本来就是列上原子写，没有"读旧值再整值写回"这件事，守卫要直接放行。
 */
function isDatabaseSideExpression(value) {
    return !!value && typeof value === 'object' && typeof value.val === 'string';
}

/** 数值列的"当前值"回形态：BigInt / 字符串数字 / Number（BIGINT 列经 mysql2 回来是字符串或 BigInt） */
function numOf(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        return Number.isInteger(value) ? BigInt(value) : value;
    }
    const text = String(value).trim();
    if (/^-?\d+$/.test(text)) return BigInt(text);
    const asNumber = Number(text);
    return Number.isFinite(asNumber) ? asNumber : null;
}

/** 两个数值是否等价（BigInt 与 Number 混着比，小数按极差判定） */
function sameNumber(a, b) {
    if (a === null || b === null) return false;
    if (typeof a === 'bigint' && typeof b === 'bigint') return a === b;
    return Math.abs(Number(a) - Number(b)) < 1e-9;
}

/**
 * 数值快照过期 = **并发冲突**，不是"服务器坏了"。
 *
 * 两条口径分开写，是因为这个错误会被很多种人读到：
 *   - `message` 给玩家：一句"请稍后重试"，**不含表名/列名/调用点/修法**；
 *     现网几十处路由写的是 `res.status(500).json({ message: 'xx失败', error: error.message })`，
 *     所以只要内部细节进了 `message`，它就一定会漏到玩家眼前（分成两个字段是唯一靠得住的挡法）。
 *   - `detail` 给开发：表名、行号、读出来时是多少、库里现在是多少、该怎么改；抛之前先 logOnce，
 *     免得有人只看到"请重试"而这条冲突永远查不到。
 * `statusCode=409 + errorCode=CONCURRENT_UPDATE`：让前端能精确识别"重试就行"，而不是当成 500 去报障。
 */
class StaleNumericWriteError extends Error {
    constructor(userMessage, detail = '') {
        super(userMessage);
        this.name = 'StaleNumericWriteError';
        this.code = 'STALE_NUMERIC_WRITE';
        this.isOperational = true;
        this.statusCode = 409;
        this.errorCode = 'CONCURRENT_UPDATE';
        this.detail = detail;
    }
}

/**
 * 调用点提示：取守卫自身与 Sequelize/模型钩子之外的头两帧，用来把冲突归到具体业务代码上。
 * 不过滤这几层的话，报出来永远是模型的 beforeSave 钩子与 sequelize/lib/hooks.js —— 那是守卫自己
 * 站的地方，不是写钱的人站的地方（第一版就吃了这个亏：真库探针指不到业务站点，只能靠翻栈）。
 * @returns {string} 形如 game/services/X.js:12 <- routes/y.js:3
 */
function callerHint() {
    const frames = String(new Error().stack || '').split('\n')
        .map(line => line.trim().replace(/^at\s+/, ''))
        .filter(line => /\.js/.test(line) && !/(numericWriteGuard|blobWriteGuard|sequelize[\\/]lib|models[\\/][A-Za-z_]+\.js|node:internal|async hooks|process\.processTicks)/.test(line));
    const short = frames.slice(0, 2).map(line => {
        const m = /(?:[\\/]|^)(?:server|re_xiuxian)[\\/](.*)$/.exec(line);
        return (m ? m[1] : line).replace(/\)?$/, '');
    });
    return short.join(' <- ') || '未知调用点';
}

function envMode(name, fallback) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    return ['off', 'warn', 'throw'].includes(raw) ? raw : fallback;
}

/**
 * 给一张表造一套数值写回守卫。
 * @param {Object} cfg
 * @param {string} cfg.label                报错里出现的表名
 * @param {string[]} cfg.wallet             硬拦档（钱、积分、修为这类累加值）
 * @param {string[]} cfg.vital              观察档（"按上限整值重设"那一类）
 * @param {{wallet?:string, vital?:string}} [cfg.defaults]  默认强度
 * @param {{wallet?:string, vital?:string}} [cfg.env]       切档用的环境变量名
 * @param {string} [cfg.versionColumn]      这张表上"快照新旧"的版本列；没有就别传
 * @param {string} [cfg.fixHint]            事务外那笔该怎么改（每张表的正规入口不一样）
 * @param {string} [cfg.lockHint]           事务内那笔该怎么改
 */
function createNumericWriteGuard(cfg) {
    const { label, wallet, vital, versionColumn = null, fixHint, lockHint } = cfg;
    const defaults = { wallet: 'throw', vital: 'warn', ...(cfg.defaults || {}) };
    const env = { wallet: `WALLET_${label.toUpperCase()}_GUARD`, vital: `VITAL_${label.toUpperCase()}_GUARD`, ...cfg.env };
    const columns = [...wallet, ...vital];
    // 锚点按表分符号：同一行实例只会被一张表的守卫盯，但分开存能让"哪张表记过锚点"这件事可查。
    const LOADED = Symbol(`numericWriteGuard.loaded.${label}`);

    /** 每次调用都现读环境变量：探针要能在同一进程里切档对照（"关守卫→真丢钱"那一半靠它） */
    function modes() {
        return { wallet: envMode(env.wallet, defaults.wallet), vital: envMode(env.vital, defaults.vital) };
    }

    /**
     * 判定计数。**"没报冲突"本身不是证据** —— 得能回答"这一路到底判过几次、判的是哪一列"，
     * 否则一次全绿的压测可能只是压根没写到这些列（vital 档要不要升成硬拦，等的就是这个数）。
     * checks=判定过的列次、dbReads=为此付的按主键 SELECT、conflicts/rejected/warned 分别对应三种结局。
     */
    const stats = {
        checks: 0, dbReads: 0, conflicts: 0, rejected: 0, warned: 0, unreadable: 0,
        byColumn: {}, conflictByColumn: {}
    };
    function noteCheck(column) {
        stats.checks++;
        stats.byColumn[column] = (stats.byColumn[column] || 0) + 1;
    }
    function statsSnapshot() {
        return {
            label,
            modes: modes(),
            ...stats,
            byColumn: { ...stats.byColumn },
            conflictByColumn: { ...stats.conflictByColumn }
        };
    }
    function resetStats() {
        stats.checks = 0; stats.dbReads = 0; stats.conflicts = 0;
        stats.rejected = 0; stats.warned = 0; stats.unreadable = 0;
        stats.byColumn = {}; stats.conflictByColumn = {};
        return stats;
    }

    function snapshotNumeric(instance) {
        if (!instance || instance.isNewRecord) return instance;
        const store = {};
        for (const column of columns) {
            const value = instance.getDataValue ? instance.getDataValue(column) : instance[column];
            if (value !== undefined) store[column] = value;
        }
        Object.defineProperty(instance, LOADED, { value: store, writable: true, enumerable: false, configurable: true });
        return instance;
    }

    /** afterFind：批量与单条都要覆盖（Sequelize 传进来的可能是数组、实例、或 null） */
    function rememberLoaded(rows) {
        if (!rows) return rows;
        if (Array.isArray(rows)) {
            for (const row of rows) snapshotNumeric(row);
            return rows;
        }
        if (typeof rows.getDataValue === 'function') snapshotNumeric(rows);
        return rows;
    }

    /** afterSave / afterCreate：这一行真的落库了，写进去的那些列的"读出来那份"就是现在这份 */
    function refreshLoaded(instance, options = {}) {
        if (!instance || instance.isNewRecord) return instance;
        const store = instance[LOADED];
        if (!store) return snapshotNumeric(instance);
        for (const column of columns) {
            if (!Array.isArray(options.fields) || options.fields.includes(column)) {
                store[column] = instance.getDataValue ? instance.getDataValue(column) : instance[column];
            }
        }
        return instance;
    }

    /**
     * 取"这一行是从哪个值算出来的"。
     *
     * **不能用 `instance.previous(col)` 当锚点**（本文件第一版就是这么写的，被真库探针当场打回）：
     * Sequelize 的 `set()` 每次赋值都会把 `_previousDataValues[key]` 改写成"赋值前 dataValues 里那份"
     * （model.js:2288），于是**同一列被写第二次时 previous 已经不是读出来那份**。现网恰好有这个形状：
     * CaveSocialService.treasureHunt 先 `spirit_stones -= 手续费`、再 `+= 借取量`，
     * 结果守卫把一笔完全正确的写回判成"快照过期"（假警报）。锚点因此改成自己存。
     */
    function previousValue(instance, column) {
        const store = instance[LOADED];
        if (store && column in store) return store[column];
        if (typeof instance.previous === 'function') return instance.previous(column);
        return instance._previousDataValues ? instance._previousDataValues[column] : undefined;
    }

    /**
     * 脏掉的数值列。三种"看着脏其实不用管"的情况一并排掉：
     *   - 新建记录：没有并发对手可被覆盖；
     *   - 值是 `literal('`col` + 100')`：那本来就是数据库端原子写，不存在读旧值；
     *   - 所属档位被调成 off（探针要能只开一档对照）。
     */
    function dirtyColumns(instance, options = {}) {
        if (!instance || instance.isNewRecord) return [];
        const fields = options.fields;
        const mode = options.modes || modes();
        return columns.filter((column) => {
            const tier = vital.includes(column) ? mode.vital : mode.wallet;
            if (tier === 'off') return false;
            if (instance.changed(column) === false) return false;
            if (Array.isArray(fields) && !fields.includes(column)) return false;
            return !isDatabaseSideExpression(instance.getDataValue(column));
        });
    }

    /**
     * @param {Object} instance - Sequelize 实例
     * @param {Object} options - save 的 options（看 transaction / fields）
     * @param {Object} [model] - 本表的模型；没传就只报脏列、不查库（单测与不连库的复用路径）
     * @throws {StaleNumericWriteError} 库里这一列已经不是我读到的那个值了
     */
    async function assertWriteAllowed(instance, options = {}, model = null) {
        const mode = options.numericGuardModes || modes();
        const dirty = dirtyColumns(instance, { ...options, modes: mode });
        if (!dirty.length) return [];
        if (!model) return dirty;

        const id = typeof instance.getDataValue === 'function'
            ? instance.getDataValue('id') : (options.where && options.where.id);
        if (id === undefined || id === null) return dirty;

        const transaction = options.transaction;
        const lock = transaction && transaction.LOCK && transaction.LOCK.UPDATE;
        stats.dbReads++;
        for (const column of dirty) noteCheck(column);
        const current = await model.findByPk(id, {
            ...(transaction ? { transaction } : {}),
            // 只取要点名的那几列（+ 版本列，如果这张表上有）：别顺手把整行读出来
            attributes: versionColumn ? dirty.concat(versionColumn) : dirty,
            ...(lock ? { lock } : {})
        });
        if (!current) return dirty; // 行已经不在：交给随后的 UPDATE 去响，不在这里编故事

        const conflicts = [];
        for (const column of dirty) {
            const loaded = numOf(previousValue(instance, column));
            const now = numOf(current.getDataValue ? current.getDataValue(column) : current[column]);
            const next = numOf(instance.getDataValue(column));
            if (loaded === null || now === null || next === null) {
                // 读不到数（列没被 select、或值不是数字）—— 判定不了就放行，但必须响一次：
                // 这一档要是沉默，守卫又会退化成"看着还在、其实只剩一半"。
                logOnce(`${label}.numericGuard.unreadable:${column}:${callerHint()}`,
                    `${label}#${id} 要写回数值列 ${column}，但读不到可比对的当前值（手上=${
                        String(previousValue(instance, column))}，库里=${String(current[column])}）`
                    + `。调用点=${callerHint()}`);
                stats.unreadable++;
                continue;
            }
            if (sameNumber(loaded, now)) continue;
            // "这一列在我手上变了"只是**必要条件**，不是结论：要是要写回去的值本来就等于库里那份，
            // 这次写回对这一列就是个幂等操作，覆盖不掉任何东西。这一条不是放宽 ——
            // 现网确实有"从权威那份把标量列镜像回手上实例"的正规写法
            // （AttributeService.allocatePoints:386 就是），把它判成冲突等于给正确代码塞一个假警报。
            if (sameNumber(next, now)) continue;
            conflicts.push({ column, loaded, now, next });
            stats.conflicts++;
            stats.conflictByColumn[column] = (stats.conflictByColumn[column] || 0) + 1;
        }
        if (!conflicts.length) return dirty;

        const perColumn = conflicts
            .map(c => `${c.column}：我这行读出来时是 ${c.loaded}，要写回 ${c.next}，库里现在却是 ${c.now}`)
            .join('；');
        const detail = `${label}#${id} 的数值列快照已过期（${perColumn}）——`
            + '这一列在我读出来之后已经被别的流程写过，此刻整值写回会把对方那笔加减永久抹掉'
            + '（钱/修为/气血既不报错也不自愈）。'
            + (transaction
                ? (lockHint || '请在同一笔事务里带 lock: t.LOCK.UPDATE 重读这一行，再改再存（读的那一份要参与写库）。')
                : (fixHint || '请改用列上原子自增（不要读旧值再整值写回）。'))
            + ` 调用点=${callerHint()}`;
        // 玩家能读到的只有这一句：不带表名、列名、调用点，也不带"该怎么改代码"
        const userMessage = '这一步没有赶上：相关数值刚被另一处操作改动过，请稍后再试一次。';

        // 档位按冲突列所属的那一档取：全是观察档冲突时走 vital 档，掺进累加值就按 wallet 档
        const tier = conflicts.every(c => vital.includes(c.column)) ? mode.vital : mode.wallet;
        if (tier === 'off') return dirty;
        if (tier === 'warn') {
            stats.warned++;
            logOnce(`${label}.numericGuard.conflict:${callerHint()}`, `[warn] ${detail}`);
            return dirty;
        }
        stats.rejected++;
        // 抛出去的那份只带玩家可读的一句，细节在这里先落一次日志（同一调用点只响一次，不刷屏）——
        // 不然以后用户只看到"请稍后再试"，这次冲突在系统里查无此处。
        logOnce(`${label}.numericGuard.rejected:${callerHint()}`, `[拒绝写回] ${detail}`);
        throw new StaleNumericWriteError(userMessage, detail);
    }

    return {
        label, columns, wallet, vital, LOADED,
        modes, assertWriteAllowed, dirtyColumns,
        snapshotNumeric, rememberLoaded, refreshLoaded, previousValue,
        stats: statsSnapshot, resetStats
    };
}

/* ==================== players：钱袋子 ==================== */

/** 钱与积分：写回必须建立在"我读到的那份值"仍然有效的前提上 */
const WALLET_COLUMNS = [
    'spirit_stones', 'exp', 'honor', 'pvp_score', 'karma', 'attribute_points',
    'divine_sense_balance', 'law_points', 'incense_balance', 'border_military_merit_available',
    'toxicity', 'lifespan_current'
];

/** 气血 / 灵力：形状是"按上限整值重设"，先观察不硬拦（见文件头） */
const VITAL_COLUMNS = ['hp_current', 'mp_current'];

/** players 盯的全部数值列 —— 也就是"允许在列上做原子增减的白名单"，与 PlayerStateStore 共用一份 */
const CAS_COLUMNS = [...WALLET_COLUMNS, ...VITAL_COLUMNS];

const PLAYER_GUARD = createNumericWriteGuard({
    label: 'players',
    wallet: WALLET_COLUMNS,
    vital: VITAL_COLUMNS,
    env: { wallet: 'PLAYER_NUMERIC_GUARD', vital: 'PLAYER_VITAL_GUARD' },
    versionColumn: 'state_version',
    fixHint: '请改用 PlayerStateStore.grantAmount / spendAmount（列上原子写，不读旧值），'
        + '或 PlayerStateStore.patchPlayerState({amounts})（锁内重读后原子累加）。',
    lockHint: '请在同一笔事务里先 PlayerStateStore.readForUpdate 再改再存（读的那一份要参与写库）。'
});

/** 各表登记的守卫：闸门与探针按 label 取，不重复抄列名 */
const GUARDS = new Map([[PLAYER_GUARD.label, PLAYER_GUARD]]);
function registerGuard(guard) {
    GUARDS.set(guard.label, guard);
    return guard;
}
registerGuard(PLAYER_GUARD);

/**
 * 全部守卫的判定计数（探针压测完拿这个数说"判过 N 次、其中 vital 列 M 次、冲突 0"）。
 * 只有"没红"是不够的：**没判到**和**判了没问题**是两件事，前者不能当成后者的证据。
 */
function statsSummary() {
    return [...GUARDS.values()].map(guard => guard.stats());
}
function resetAllStats() {
    for (const guard of GUARDS.values()) guard.resetStats();
}

/**
 * 让任何一条探针/一次真实启动都能自己交代"判过没有"：
 * `NUMERIC_GUARD_STATS=1` 时在进程退出前打一行 JSON（各表 checks / conflicts / rejected / byColumn）。
 * 没有这一条，"压了一百个探针 0 冲突"完全可能只是"一百个探针都没写到那一列"。
 */
if (String(process.env.NUMERIC_GUARD_STATS || '').trim() && !process.env.JEST_WORKER_ID) {
    process.once('exit', () => {
        try {
            // 用同步写而不是 console.log：探针普遍以 process.exit() 收尾，而管道下 console.log 是**异步写**，
            // 会被截断成半行 JSON（survey 收集端就解析失败过）。writeSync 也可能只写进一部分（管道里前面
            // 还压着没刷完的输出），所以要循环到写完。
            const fs = require('fs');
            const buf = Buffer.from(`[numericWriteGuard.stats] ${JSON.stringify(statsSummary())}\n`, 'utf8');
            let offset = 0;
            while (offset < buf.length) offset += fs.writeSync(1, buf, offset, buf.length - offset);
        } catch (_) { /* 退出钩子里不许再把进程弄崩 */ }
    });
}

module.exports = {
    createNumericWriteGuard,
    registerGuard,
    guardFor: (label) => GUARDS.get(label),
    allGuards: () => [...GUARDS.values()],
    statsSummary,
    resetAllStats,
    PLAYER_GUARD,
    // —— players 那一套的原名（模型钩子与既有测试都按这些名字用）——
    assertNumericWriteAllowed: (instance, options, model) => PLAYER_GUARD.assertWriteAllowed(instance, options, model),
    dirtyNumericColumns: (instance, options) => PLAYER_GUARD.dirtyColumns(instance, options),
    rememberLoaded: (rows) => PLAYER_GUARD.rememberLoaded(rows),
    refreshLoaded: (instance, options) => PLAYER_GUARD.refreshLoaded(instance, options),
    snapshotNumeric: (instance) => PLAYER_GUARD.snapshotNumeric(instance),
    previousValue: (instance, column) => PLAYER_GUARD.previousValue(instance, column),
    LOADED: PLAYER_GUARD.LOADED,
    modes: () => PLAYER_GUARD.modes(),
    isDatabaseSideExpression,
    StaleNumericWriteError,
    WALLET_COLUMNS,
    VITAL_COLUMNS,
    CAS_COLUMNS,
    numOf,
    sameNumber
};
