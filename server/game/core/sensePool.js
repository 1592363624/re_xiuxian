/**
 * 「神识」这一份余额：一处读、一处增减（2026-09-23）
 *
 * 为什么要收成一份（这一族第三次做同样的事，前两次的产物是 `game/core/deathPenalty.js`
 * 与 `game/stats/beastRarity.js`）：神识不是任何单一玩法的私有资源，它住在 `players.attributes.sense`
 * 这一个键上，而**七个以上**的地方各自实现过它 ——
 *   飞升（AscensionService）与第二元神（SecondSoulService）各自抄了一模一样的
 *   `getDivineSense` + `consumeDivineSense`（那两份已经是键级补丁，形状正确但重复）；
 *   阵法（FormationService）、轮回（ReincarnationService）各抄一份读法；
 *   元婴出窍（NascentSoulService）四条流程各自"摊平整份 attributes → 改 sense → 赋回实例 → save 整行"，
 *   并且**四份兜底各不相同**：`attrs.sense || baseSense`（境界基数）、`|| 10`、`|| 10`、`Number() || 0`。
 * 神识是这种"一个键被多个玩法同时动"的资源，所以任何一份实现被改动（或有人新加一条链时抄错一份），
 * 后果都是玩家身上的余额与回执不一致，而不是某一个面板显示不对。
 *
 * 顺手修掉的那一族老毛病（`x || 默认值` 吃掉 0）：
 * 旧写法把 **0 当成"这个键不存在"**。神识是可以被正常花光的（`currentSense < cost` 时拒绝，
 * 等于就通过 → 正好扣到 0），于是"把神识用光的人"下一次进这些流程会白拿到一份兜底余额
 * （出窍那条按境界基数，另两条按 10），先花掉一份本不属于他的余额，再被扣成 兜底 − 消耗。
 * 现在 0 是一个合法余额，只有"键不存在或不是数"才用兜底（兜底由调用点显式传，语义留在调用点）。
 * 这条改动会让"余额恰好为 0 的账号"少一次免费使用 —— 是要的，但记进 docs/待业主拍板清单.md。
 *
 * 写库口径与既有两份 helper 完全一致：`patchPlayerState` 的键级 `$add` + `$min: 0`
 * （"不能扣成负数"这一步必须在行锁内判定，调用方手上那份可能已经是旧快照），
 * 落库后把新值镜像回调用方那份实例且**不标脏**，所以它后面再 save() 也不会把这一笔盖掉。
 */
'use strict';

const PlayerStateStore = require('../persistence/PlayerStateStore');

const KEY = 'sense';

function attributesOf(player) {
    if (!player) return {};
    const raw = player.attributes;
    if (typeof raw === 'string') {
        try { return JSON.parse(raw) || {}; } catch { return {}; }
    }
    return raw || {};
}

/**
 * 读神识余额。
 * @param {Object} player - 玩家实例（或任何带 attributes 的对象）
 * @param {number} [fallback=0] - **仅在键缺失/非数值时**用的兜底（境界基数这类由调用点传进来）
 * @returns {number} 非负整数
 */
function senseOf(player, fallback = 0) {
    const value = Number(attributesOf(player)[KEY]);
    if (!Number.isFinite(value)) {
        const base = Number(fallback);
        return Number.isFinite(base) && base > 0 ? Math.floor(base) : 0;
    }
    return Math.max(0, Math.floor(value));
}

/** 够不够花（0 余额是"不够"，不是"按兜底重来一次"） */
function canSpend(player, cost, fallback = 0) {
    const amount = Number(cost) || 0;
    return amount >= 0 && senseOf(player, fallback) >= amount;
}

async function spendSense(player, cost, options = {}) {
    return applySenseDelta(player, -(Number(cost) || 0), options);
}

async function grantSense(player, gain, options = {}) {
    return applySenseDelta(player, Number(gain) || 0, options);
}

/**
 * 增减一笔神识并返回变化。
 *
 * 三个数的口径要分清楚（这一条是 S8a 用八路并发实测出来的，不是抠字抠出来的）：
 *   · `after`  = 库里落库之后的真值 → **外发回执、面板、对账都用它**；
 *   · `before` = **调用方手上那份快照**上的值，并发下它可能已经是旧的；
 *   · `delta`  = after − before，于是只是一笔"相对我自己那份"的变化，
 *                多条腿同时扣时各腿的 delta 加起来必然对不上库里那一段（八份 1000 的快照各报 -100…-800）。
 *                要"这一段时间库里少了我这一笔没有"，判 `after` 那一条链上的前后两次读数，别加 delta。
 * @returns {Promise<{before:number, after:number, delta:number}>}
 */
async function applySenseDelta(player, delta, options = {}) {
    if (!player || player.id === undefined || player.id === null) {
        throw new Error('spendSense/grantSense 需要玩家实例（要把新值镜像回去）');
    }
    const amount = Math.floor(Number(delta) || 0);
    const before = senseOf(player, 0);
    if (!Number.isFinite(amount) || amount === 0) return { before, after: before, delta: 0 };
    const { transaction } = options;
    const updated = await PlayerStateStore.patchPlayerState(
        player.id,
        { attributes: { [KEY]: { $add: amount, $min: 0 } } },
        { transaction }
    );
    PlayerStateStore.mirrorPatchedBlob(player, updated);
    const after = senseOf(updated, 0);
    return { before, after, delta: after - before };
}

module.exports = { KEY, senseOf, canSpend, spendSense, grantSense };
