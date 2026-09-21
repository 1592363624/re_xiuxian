/**
 * players 整块 JSON 列的写入守卫。
 *
 * players 上 attributes / stats / time_system_data / titles / spirit_roots 是
 * "一个字符串装着一整个对象"，Sequelize 的保存语义是整块覆盖：
 * 只要写的人手上那份快照读在别人提交之后，被覆盖掉的那些键就永久丢了，
 * 既不报错也不自愈 —— 这正是"旧快照覆盖新快照"的成因。
 *
 * 这里挡两类：
 *   1. 根本没有事务的整块写回 —— 没有任何串行化，必然能丢。历史上造成实际丢数据的
 *      登录离线恢复就属于这一类。
 *   2. 事务内、但手上那份快照已经比库里的旧 —— "在事务里"不等于"读的是锁内最新一行"：
 *      REPEATABLE READ 下事务开头读到的快照，期间别人提交过就作废了，而 UPDATE 照样
 *      会把它整块写回去（丢失更新）。写回前按主键锁读一次 state_version 比对，
 *      版本号落后即拒绝，把这一类从"靠人自觉"变成运行期硬拦截。
 *
 * 需要整块写回的正规做法是 PlayerStateStore.patchPlayerState（键级补丁 + state_version 自增），
 * 或在同一事务内先 readForUpdate / findByPk + LOCK.UPDATE 再改再存。
 */
'use strict';

// 从 sequelize 包本身拿 literal：不 require config/database（那条路会绕回 models/player.js，
// 而 player.js 正是本文件的调用方）。
const { literal } = require('sequelize');
const { logOnce } = require('../../utils/logOnce');

const WHOLE_BLOB_COLUMNS = ['attributes', 'stats', 'time_system_data', 'titles', 'spirit_roots'];

/** 实例上此刻脏掉的整块列（新建记录不算：没有并发对手可覆盖） */
function dirtyBlobColumns(instance) {
    if (!instance || instance.isNewRecord) return [];
    return WHOLE_BLOB_COLUMNS.filter(column => instance.changed(column) !== false);
}

/** state_version 落后于库里的当前值 —— 手上这份快照已经不能整块写回 */
class StalePlayerSnapshotError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StalePlayerSnapshotError';
        this.code = 'STALE_SNAPSHOT';
    }
}

/**
 * BIGINT 列经 Sequelize 回来可能是 BigInt / 字符串 / 数字，统一成 BigInt 才能比对。
 * 拿不到（列没被 select、或值不是整数）返回 null，表示"无从判定"，调用方据此放行。
 */
function versionOf(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value;
    const text = String(value).trim();
    return /^-?\d+$/.test(text) ? BigInt(text) : null;
}

/**
 * 调用点提示：取本文件之外的头两帧，用来把"无版本整块写回"归到具体业务代码上。
 * @returns {string} 形如 game/services/X.js:12 <- routes/y.js:3
 */
function callerHint() {
    const frames = String(new Error().stack || '').split('\n')
        .map(line => line.trim().replace(/^at\s+/, ''))
        .filter(line => /\.js/.test(line) && !line.includes('blobWriteGuard'));
    const short = frames.slice(0, 2).map(line => {
        const m = /(?:[\\/]|^)(?:server|re_xiuxian)[\\/](.*)$/.exec(line);
        return (m ? m[1] : line).replace(/\)?$/, '');
    });
    return short.join(' <- ') || '未知调用点';
}

/**
 * @param {Object} instance - Sequelize 实例（需要 changed()/isNewRecord）
 * @param {Object} options - save 的 options，看有没有 transaction
 * @param {Object} [model] - 玩家模型（传了才能做版本比对；单测里可省）
 * @throws {Error} 整块 JSON 列要写回、且不在任何事务里
 * @throws {StalePlayerSnapshotError} 在事务里，但快照比库里的旧
 */
async function assertBlobWriteAllowed(instance, options = {}, model = null) {
    const dirty = dirtyBlobColumns(instance);
    if (!dirty.length) return;

    const columns = dirty.join(', ');
    if (!options.transaction) {
        throw new Error(
            `players 整块 JSON 列 [${columns}] 不能在事务外写回：` +
            '没有行锁的读-改-写会覆盖并发写入的键。' +
            '请改用 PlayerStateStore.patchPlayerState 做键级补丁，' +
            '或在同一事务内先 readForUpdate 再保存。'
        );
    }

    const id = typeof instance.getDataValue === 'function' ? instance.getDataValue('id') : instance.id;
    if (!model || id === undefined || id === null) return;

    const transaction = options.transaction;
    const lock = transaction.LOCK && transaction.LOCK.UPDATE;
    const current = await model.findByPk(id, {
        transaction,
        attributes: ['state_version'],
        ...(lock ? { lock } : {})
    });
    if (!current) return;

    const mine = versionOf(instance.getDataValue('state_version'));
    const now = versionOf(current.getDataValue('state_version'));
    // 只有"手上比库里旧"才是丢数据：相等是锁内新鲜，更大是自己刚 +1（patchPlayerState 的形状）。
    // 取不到版本号说明这一列没被 select —— 不在这里拦，免得把只读投影的用法一并打断；
    // 但这条放行必须是**响的**：整块写回而手上没有版本号的代码，是要能被查出来的，
    // 所以留一条带调用栈的一次性告警（同一个调用点只报一次，不刷屏）。
    if (mine === null) {
        logOnce(`blobWriteGuard.unversioned_write:${callerHint()}`,
            `players#${id} 在事务内整块写回 [${columns}]，但读出来的那一行没有 state_version —— `
            + `库里当前是 ${now === null ? '未知' : now}，无法判定这份快照新旧。`
            + `若这条日志出现在真实写路径上，说明那里缺了"锁内重读"。调用点=${callerHint()}`);
    }
    if (mine === null || now === null || mine >= now) return;

    throw new StalePlayerSnapshotError(
        `players#${id} 的整块 JSON 列 [${columns}] 快照已过期：state_version ${mine} 落后于库里的 ${now}，` +
        '说明这期间有别的写入已经提交，此刻整块写回会把对方写进去的键永久覆盖掉。' +
        '请在事务内重新读出该行（readForUpdate / findByPk + LOCK.UPDATE）后再改，' +
        '或改用 PlayerStateStore.patchPlayerState 做键级补丁。'
    );
}

/**
 * 整块 JSON 列经 Model.update() 这条 bulk 路径写回时的同一道规则。
 *
 * 为什么单独写：bulk 更新不触发 beforeSave，上面那份守卫对它一点管不到；而
 * `Player.update({ attributes: {...} })` 恰恰是最顺手的一种写法 —— 一次 WHERE 命中
 * 多少行就整块覆盖多少行，既没有读也没有锁。规则与实例路径一致（必须在事务里），
 * 另外替调用方把 state_version +1：这个版本号是"整块状态写过几次"的标记，
 * bulk 路径不涨它的话，beforeSave 那道新鲜度判定就会跟着失真。
 *
 * @param {Object} options - beforeBulkUpdate 收到的 options（含 fields / attributes）
 * @throws {Error} 要整块写回、且不在任何事务里
 */
function assertBulkBlobWriteAllowed(options = {}) {
    const fields = options.fields || [];
    const dirty = WHOLE_BLOB_COLUMNS.filter(column => fields.includes(column));
    if (!dirty.length) return;

    if (!options.transaction) {
        throw new Error(
            `players 整块 JSON 列 [${dirty.join(', ')}] 不能用 Player.update 在事务外整块覆盖：` +
            '一次 WHERE 命中的每一行都会被这份快照替换，读到的和写回去之间没有任何串行化。' +
            '请改用 PlayerStateStore.patchPlayerState 做键级补丁（锁内合并，只动点名的键）。'
        );
    }
    if (!options.attributes || fields.includes('state_version')) return;

    options.attributes.state_version = literal('`state_version` + 1');
    options.fields = fields.concat('state_version');
}

module.exports = {
    assertBlobWriteAllowed,
    assertBulkBlobWriteAllowed,
    dirtyBlobColumns,
    versionOf,
    StalePlayerSnapshotError,
    WHOLE_BLOB_COLUMNS
};
