/**
 * 玩家状态写入层：杜绝"旧快照覆盖新快照"导致的丢数据。
 *
 * 问题来源（现网实测）：players.attributes 是 TEXT 列 + getter 每次 JSON.parse 返回新对象，
 * 所以任何局部修改都必须整块回写；而全服务有 36 处这样整块读写，读与写之间往往还夹着几个 await。
 * 结果：A 请求读到 {sense:100} → B 请求读到 {sense:100} → A 写回 {sense:90, hp_bonus:5}
 *       → B 写回 {sense:80}，A 那笔 hp_bonus 就这么无声消失了。
 *       表现永远像"玩家数据不对"，而不是报错，所以这类 bug 存活了很久。
 *
 * 规则：
 *   1. 要改玩家状态，走本文件的补丁式写入：在行锁内重新读出最新 blob，
 *      只把补丁点名的键写回去，调用方手里那个（可能已经陈旧的）实例快照不参与写库。
 *   2. 数值型资源（灵石/修为/气血/灵力/寿元/丹毒）用列上的原子自增，
 *      或在原子自增前用 WHERE 做条件判定（扣费不够就直接 0 行受影响），不做"读-改-写"。
 *   3. state_version 每次写入 +1，给"这张快照是新还是旧"一个可比对的单调标记；
 *      标记的判定绑在 players 的保存路径上（game/persistence/blobWriteGuard.js），
 *      不依赖调用方自觉 —— 忘了比对一次就是一次无声丢数据。
 */
'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../config/database');
const Player = require('../../models/player');

class PlayerNotFoundError extends Error {}
class InsufficientResourceError extends Error {
    constructor(resource, need, have) {
        super(`${resource} 不足（需要 ${need}，当前 ${have}）`);
        this.name = 'InsufficientResourceError';
        this.code = 'INSUFFICIENT';
        this.resource = resource;
        this.need = need;
        this.have = have;
    }
}

/** 允许原子增减的数值列（白名单，绝不允许外部传入列名） */
const AMOUNT_COLUMNS = new Set([
    'spirit_stones', 'exp', 'hp_current', 'mp_current', 'lifespan_current',
    'toxicity', 'attribute_points', 'honor', 'pvp_score', 'karma',
    'incense_balance', 'law_points', 'divine_sense_balance', 'border_military_merit_available'
]);

/** 同时存在于"标量列"和"attributes blob"里的键：以标量列为准，写入时同步镜像到 blob，
 *  这样还在读 blob 的老代码（战斗/副本等）不会读到过期值 */
const MIRRORED_COLUMNS = new Set([
    'hp_current', 'mp_current', 'exp', 'spirit_stones', 'lifespan_current', 'lifespan_max', 'toxicity'
]);

/** 需要单独守卫的列：身份凭据与版本号不经由补丁写入 */
const PROTECTED_COLUMNS = new Set(['id', 'password', 'token_version', 'state_version']);

/** 整块回写的 JSON 列 */
const BLOB_COLUMNS = {
    attributes: 'attributes',
    stats: 'stats',
    time_system_data: 'timeSystemData',
    spirit_roots: 'spiritRoots',
    titles: 'titles'
};

function parseBlob(raw) {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) || {};
        } catch {
            return {};
        }
    }
    return typeof raw === 'object' ? raw : {};
}

/**
 * 标量列镜像进 attributes blob 前的取值收敛。
 * BIGINT 列（hp_current/exp/spirit_stones…）读出来是 BigInt 或字符串数字，
 * 而 JSON.stringify(BigInt) 会直接抛 "Do not know how to serialize a BigInt"，
 * 所以镜像只落 Number；老代码读这些键时本来就走 Number()/safeBigInt()。
 */
function toBlobMirror(value) {
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
    return value;
}

/** 取一个安全的 BIGINT 字面量（只接受有限数值/整数字符串，杜绝任何 SQL 注入面） */
function bigintLiteral(value, label) {
    let big;
    if (typeof value === 'bigint') big = value;
    else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`${label} 数值非法: ${value}`);
        big = BigInt(Math.trunc(value));
    } else {
        const text = String(value).trim();
        if (!/^-?\d+$/.test(text)) throw new Error(`${label} 必须是整数: ${value}`);
        big = BigInt(text);
    }
    return big;
}

/**
 * 把一个补丁合并进最新读到的 blob。
 * 值语义：普通值 = 覆盖；null = 删除该键；{ $add: n } = 在锁内对数值键做增量。
 */
function mergeBlobPatch(current, patch) {
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            delete next[key];
            continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value) && '$add' in value) {
            const before = Number(next[key]) || 0;
            const delta = Number(value.$add);
            if (!Number.isFinite(delta)) throw new Error(`${key} 的 $add 增量非法: ${value.$add}`);
            let after = before + delta;
            // $min / $max 让"不能扣成负数 / 不能超过上限"这类规则留在行锁内判定：
            // 调用方拿到的 before 可能已经是旧快照，在它上面钳制等于没钳。
            if (value.$min !== undefined) {
                const min = Number(value.$min);
                if (!Number.isFinite(min)) throw new Error(`${key} 的 $min 非法: ${value.$min}`);
                after = Math.max(min, after);
            }
            if (value.$max !== undefined) {
                const max = Number(value.$max);
                if (!Number.isFinite(max)) throw new Error(`${key} 的 $max 非法: ${value.$max}`);
                after = Math.min(max, after);
            }
            next[key] = after;
            continue;
        }
        next[key] = value;
    }
    return next;
}

/**
 * 补丁式写入玩家状态。在同一个事务里 SELECT ... FOR UPDATE，
 * 对锁内新鲜读出的行应用补丁，然后写回。
 *
 * @param {number|string} playerId
 * @param {Object} patch
 * @param {Object} [patch.attributes]      players.attributes blob 的键级补丁
 * @param {Object} [patch.stats]           players.stats blob 的键级补丁
 * @param {Object} [patch.timeSystemData]  players.time_system_data blob 的键级补丁
 * @param {Object} [patch.columns]         标量列的绝对值（会镜像 MIRRORED_COLUMNS 到 attributes）
 * @param {Object} [patch.amounts]         标量列增量（列上原子累加，不读旧值）
 * @param {Object} [options]               { transaction } 复用调用方事务
 * @returns {Promise<Player>} 写库后的最新实例
 */
async function patchPlayerState(playerId, patch = {}, options = {}) {
    const { attributes, stats, timeSystemData, spiritRoots, titles, columns, amounts } = patch;
    const scalarEntries = Object.entries(columns || {});
    const amountEntries = Object.entries(amounts || {});

    for (const [column] of amountEntries) {
        if (!AMOUNT_COLUMNS.has(column)) throw new Error(`不允许增减的列: ${column}`);
    }
    for (const [column] of scalarEntries) {
        // 只要求"是 players 的真实列，且不是需要单独守卫的身份/版本列"。
        // 拿模型的 rawAttributes 当白名单，而不是另抄一份清单——清单一定会和 136 个列漂移，
        // 漂移的结果要么是该写的写不了，要么是悄悄放开整行覆盖。
        if (PROTECTED_COLUMNS.has(column) || !Object.prototype.hasOwnProperty.call(Player.rawAttributes, column)) {
            throw new Error(`不允许写入的列: ${column}`);
        }
    }

    const apply = async (t) => {
        const fresh = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!fresh) throw new PlayerNotFoundError(`玩家不存在: ${playerId}`);

        const hasBlobPatch = attributes || stats || timeSystemData || spiritRoots || titles;
        let nextAttributes = null;
        if (attributes) nextAttributes = mergeBlobPatch(parseBlob(fresh.getDataValue('attributes')), attributes);

        if (stats) fresh.stats = mergeBlobPatch(parseBlob(fresh.getDataValue('stats')), stats);
        if (timeSystemData) fresh.time_system_data = mergeBlobPatch(parseBlob(fresh.getDataValue('time_system_data')), timeSystemData);
        if (spiritRoots) fresh.spirit_roots = mergeBlobPatch(parseBlob(fresh.getDataValue('spirit_roots')), spiritRoots);
        if (Array.isArray(titles)) fresh.titles = titles;

        for (const [column, value] of scalarEntries) {
            fresh[column] = value;
            if (MIRRORED_COLUMNS.has(column)) {
                nextAttributes = nextAttributes || mergeBlobPatch(parseBlob(fresh.getDataValue('attributes')), {});
                nextAttributes[column] = toBlobMirror(value);
            }
        }

        for (const [column, delta] of amountEntries) {
            const step = bigintLiteral(delta, column);
            const before = bigintLiteral(fresh.getDataValue(column) || 0, column);
            const after = before + step;
            // 资源不允许被写成负数（并发到账时以 0 兜底，宁可少扣不可多扣）
            fresh[column] = Number(after < 0n ? 0n : after);
            if (MIRRORED_COLUMNS.has(column)) {
                nextAttributes = nextAttributes || mergeBlobPatch(parseBlob(fresh.getDataValue('attributes')), {});
                nextAttributes[column] = toBlobMirror(fresh[column]);
            }
        }

        if (nextAttributes) fresh.attributes = nextAttributes;

        fresh.setDataValue('state_version', bigintLiteral(fresh.getDataValue('state_version') || 0, 'state_version') + 1n);
        await fresh.save({ transaction: t });
        return fresh;
    };

    if (options.transaction) return apply(options.transaction);
    return sequelize.transaction(apply);
}

/**
 * 在调用方事务里以 FOR UPDATE 读出"锁内新鲜"的玩家实例。
 * 需要"先读当前值、再算钳制/账本"的流程用它，然后仍用 patchPlayerState 回写，
 * 这样参与写库的永远是锁内那份，而不是调用方请求开始时拿到的那份。
 */
async function readForUpdate(playerId, options = {}) {
    if (!options.transaction) throw new Error('readForUpdate 必须传入 transaction（否则拿不到行锁）');
    const fresh = await Player.findByPk(playerId, { transaction: options.transaction, lock: options.transaction.LOCK.UPDATE });
    if (!fresh) throw new PlayerNotFoundError(`玩家不存在: ${playerId}`);
    return fresh;
}

/** 开一个事务（调用方不必自己 require sequelize） */
function withTransaction(fn) {
    return sequelize.transaction(fn);
}

/**
 * "锁内读 → 算 → 补丁写"的组合原语。
 *
 * 现网大量流程的形状是：先拿玩家当前值、按它算出新值（恢复量、钳制、账本、
 * 年龄累加），再把结果写回去。只要这份"当前值"来自请求开始时的实例，
 * 写回就会覆盖掉这段时间里别的流程的改动。用这个原语改写后，
 * 参与计算和写库的永远是行锁内的最新一行。
 *
 * @param {number|string} playerId
 * @param {(player: Player, t: Transaction) => Promise<Object>|Object} fn
 *        收到锁内新鲜实例；返回一个 patch（同 patchPlayerState 的形状）即写库，
 *        返回 null/undefined 表示本次不写。
 * @param {Object} [options] { transaction } 复用调用方事务
 * @returns {Promise<Player>} 写入后的行（未写入时就是锁内那份）
 */
async function mutatePlayer(playerId, fn, options = {}) {
    const body = async (t) => {
        const fresh = await readForUpdate(playerId, { transaction: t });
        const patch = await fn(fresh, t);
        if (!patch) return fresh;
        return patchPlayerState(playerId, patch, { transaction: t });
    };
    return options.transaction ? body(options.transaction) : sequelize.transaction(body);
}

/**
 * 原子扣减（带余额判定）：一条 UPDATE ... WHERE balance >= cost，
 * 而不是"读出来、在 JS 里减、再写回去"。返回 false 表示余额不足或被并发抢先扣走。
 *
 * @param {number|string} playerId
 * @param {string} column 白名单内的数值列
 * @param {number|string|bigint} amount 正数
 * @param {Object} [options] { transaction }
 */
async function spendAmount(playerId, column, amount, options = {}) {
    if (!AMOUNT_COLUMNS.has(column)) throw new Error(`不允许扣减的列: ${column}`);
    const cost = bigintLiteral(amount, column);
    if (cost <= 0n) throw new Error(`${column} 扣减量必须为正数`);

    const run = async (t) => {
        const [affected] = await Player.update(
            { [column]: sequelize.literal(`\`${column}\` - ${cost}`) },
            { where: { id: playerId, [column]: { [Op.gte]: cost } }, transaction: t }
        );
        return affected > 0;
    };

    if (options.transaction) return run(options.transaction);
    return sequelize.transaction(run);
}

/** 原子发放（可叠加，互不覆盖） */
async function grantAmount(playerId, column, amount, options = {}) {
    if (!AMOUNT_COLUMNS.has(column)) throw new Error(`不允许增加的列: ${column}`);
    const gain = bigintLiteral(amount, column);
    if (gain <= 0n) throw new Error(`${column} 增加量必须为正数`);

    const run = async (t) => {
        await Player.update(
            { [column]: sequelize.literal(`\`${column}\` + ${gain}`) },
            { where: { id: playerId }, transaction: t }
        );
        // BIGINT 列在 MySQL 里 unsigned 会拒绝负值；这里允许被扣到 0 以下时由列定义兜住
        return true;
    };

    if (options.transaction) return run(options.transaction);
    return sequelize.transaction(run);
}

/**
 * "这张快照是新还是旧"的判定不在这里，而是写在保存路径上：
 * models/player.js 的 beforeSave 钩子 → blobWriteGuard.assertBlobWriteAllowed。
 * 理由：判定只有绑在"整块写回"这一步才不会漏；放在调用方则每处都要记得用，
 * 用错一次就是无声丢数据。
 */

/**
 * 把"补丁已在锁内落库"的结果镜像回调用方手上的实例，并且不把这些列标成待写。
 *
 * 写成 `player.attributes = updated.attributes` 也能同步内存，但会让这一列进入
 * "待整块写回"状态：之后这个实例的任何一次 save()（哪怕只是想更新 last_online）
 * 都会拿这份快照去覆盖这期间别的流程写进 attributes 的键。blobWriteGuard 现在会
 * 当场拦下（补丁已经把 state_version +1，手上那份就"比库里旧"了）—— 报错是对的，
 * 但正确形状本来是：库只写一次（锁内那份），内存只跟着读，不参与写。
 *
 * @param {Player} instance - 调用方手上的实例
 * @param {Player} updated - patchPlayerState 返回的、已落库的那份
 * @param {string[]} [columns] - 需要镜像的整块列，默认只镜像 attributes
 */
function mirrorPatchedBlob(instance, updated, columns = ['attributes']) {
    if (!instance || !updated) return instance;
    for (const column of columns) {
        instance.setDataValue(column, updated.getDataValue(column));
        instance.changed(column, false);
    }
    return instance;
}

module.exports = {
    patchPlayerState,
    readForUpdate,
    mutatePlayer,
    withTransaction,
    mergeBlobPatch,
    toBlobMirror,
    mirrorPatchedBlob,
    spendAmount,
    grantAmount,
    Player,
    PlayerNotFoundError,
    InsufficientResourceError,
    AMOUNT_COLUMNS,
    MIRRORED_COLUMNS
};
