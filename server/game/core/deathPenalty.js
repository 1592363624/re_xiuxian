/**
 * 陨落扣修为 —— 全仓唯一一份算式与唯一一次写入（2026-09-23）。
 *
 * 为什么单独一个叶子模块：改造前仓里有 **5 份**"玩家死了扣多少修为"，各自算、各自写：
 *   · `CombatService`（野外/PVE 战斗身死）读 `game_balance.combat.death_exp_penalty_rate ?? 0.1`
 *   · `WorldBossService` / `BeastInvasionService` 各有一份**逐字相同**的 `_applyDeathExpPenalty`，
 *     读各自作用域的 `death_exp_penalty_rate`，率缺省时用 `|| 0.05`
 *   · `LifespanService.handleLifespanEnd`（寿元耗尽）读 `lifespan.death_exp_loss_rate ?? 0.1`
 *   · `PlayerService`（死亡重生）读 `lifespan.death_exp_loss_rate ?? combat.death_exp_penalty_rate ?? 0.1`
 * 五份的后果分三类，全都是"改一处忘四处"的形状：
 *   ① **精度不一致**：三份用 `round(rate×100)/100`（两位小数），两份用 `×10000/10000`。
 *      把率配成 2.5% 时，有两条链会把它当 2% 或 3% 算，另一条链按 2.5% 算。
 *      现在统一成四位（与旧的两位对现网所有配置值结果完全相同：combat/lifespan 0.1、
 *      world_boss/beast_invasion 0.05，都在两位内 —— 所以这条是零数值变化）。
 *   ② **`x || default` 会吃掉配置里的 0**：`Number(cfg.death_exp_penalty_rate) || 0.05`
 *      让玩家把"陨落不罚修为"配成 0 时照样被扣 5%。现在用 `??`（0 是合法值）。
 *   ③ **写法是"读旧值 → 算绝对值 → 整块写回"**：其中世界BOSS 与兽潮那两份还顺手把
 *      `attributes` 整块赋回去（旧快照覆盖新快照那一族），而寿元耗尽那一份连行锁都没有 ——
 *      同一时间别人给玩家加的修为会被它按几分钟前那份数抹回去。
 *      现在唯一一次写是列上的**原子减**（`patchPlayerState({amounts:{exp:-penalty}})`，
 *      锁内重读、下限 0、`attributes.exp` 镜像由 PlayerStateStore 统一维护），
 *      调用方手上那份实例不参与 exp 的写回。
 *
 * 作用域（scope）保留各自的率：BOSS 战 5% 与野外 10% 是刻意的设计差异，不是漂移；
 * 但"默认值"与"合法区间"只在这一个地方定义，要调哪个作用域就改内容里那一键。
 */
'use strict';

const { infrastructure } = require('../../modules');
const PlayerStateStore = require('../persistence/PlayerStateStore');

/** 内容里读率的键（按作用域），default 只在**这一份**表里出现 */
const RATE_KEYS = {
    combat: { path: 'combat', key: 'death_exp_penalty_rate', fallback: 0.1 },
    world_boss: { path: 'world_boss', key: 'death_exp_penalty_rate', fallback: 0.05 },
    beast_invasion: { path: 'beast_invasion', key: 'death_exp_penalty_rate', fallback: 0.05 },
    lifespan: { path: 'lifespan', key: 'death_exp_loss_rate', fallback: 0.1 }
};

/**
 * 这个作用域的惩罚率（0 合法 = 不罚）。
 * @returns {number} 0~1 之间；配置越界或非法时回 default 并点名（配错不该静默改变惩罚力度）
 */
function resolveExpPenaltyRate(scope) {
    const spec = RATE_KEYS[scope];
    if (!spec) throw new Error(`未知的陨落惩罚作用域: ${scope}（可用：${Object.keys(RATE_KEYS).join('/')}）`);
    const balance = infrastructure.ConfigLoader.getConfig('game_balance') || {};
    const raw = (balance[spec.path] || {})[spec.key];
    if (raw === undefined || raw === null) return spec.fallback;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        console.warn(`[deathPenalty] game_balance.${spec.path}.${spec.key}=${JSON.stringify(raw)} 不是 0~1 的数`
            + ` → 按默认 ${spec.fallback} 算（配置写错时宁可回默认，也不要静默把惩罚力度变成 NaN）`);
        return spec.fallback;
    }
    return rate;
}

/** 万分比整数 → 精确 BigInt 乘法：0.025 这种三位小数也不会先被圆到 2% 或 3% */
function penaltyOf(expBefore, rate) {
    const scaled = BigInt(Math.round(rate * 10000));
    return (BigInt(expBefore) * scaled) / 10000n;
}

/**
 * 扣一次陨落修为。
 *
 * @param {Object} params
 * @param {number|string} params.playerId
 * @param {'combat'|'world_boss'|'beast_invasion'|'lifespan'} params.scope 用哪个作用域的率
 * @param {number} [params.rate] 显式给率（测试与特殊玩法用）；不给就按 scope 读内容
 * @param {Object} [params.transaction] **调用方已经持有这一行锁时必须传**：
 *        新开一个事务去 FOR UPDATE 同一行会一直等到 50 秒锁超时（世界BOSS 领取那次就是这么挂的）
 * @param {string} [params.reason] 只进日志，用于排查"这次扣是哪条链扣的"
 * @returns {Promise<{scope:string, rate:number, exp_before:bigint, exp_after:bigint, penalty:bigint, skipped:boolean}>}
 */
async function applyExpPenalty({ playerId, scope, rate, transaction, reason = '' }) {
    const usedRate = rate === undefined || rate === null ? resolveExpPenaltyRate(scope) : Number(rate);
    if (!Number.isFinite(usedRate) || usedRate < 0 || usedRate > 1) {
        throw new Error(`陨落惩罚率非法: ${rate}（作用域 ${scope}）`);
    }
    const run = async (t) => {
        // 锁内读那一份才算惩罚基数：手上可能是请求开始时拿的旧快照
        const locked = await PlayerStateStore.readForUpdate(playerId, { transaction: t });
        const before = BigInt(locked.exp || 0);
        const penalty = usedRate > 0 ? penaltyOf(before, usedRate) : 0n;
        if (penalty <= 0n) {
            return {
                scope: scope || 'explicit', rate: usedRate, exp_before: before, exp_after: before,
                penalty: 0n, skipped: true
            };
        }
        const updated = await PlayerStateStore.patchPlayerState(
            playerId, { amounts: { exp: -penalty } }, { transaction: t }
        );
        return {
            scope: scope || 'explicit', rate: usedRate, exp_before: before,
            exp_after: BigInt(updated.exp || 0), penalty, skipped: false
        };
    };
    if (transaction) return run(transaction);
    // 没有调用方事务时自己开一个（里面第一件事就是 FOR UPDATE）——
    // 这比"无锁读一份快照再整块写回"安全，寿元耗尽那条链今天就是这个洞。
    return PlayerStateStore.withTransaction(run);
}

module.exports = {
    RATE_KEYS,
    resolveExpPenaltyRate,
    applyExpPenalty,
    penaltyOf
};
