/**
 * 闭关修炼系统路由（重构版）
 *
 * 区分常规闭关与深度闭关两种修炼方式：
 *   - 常规闭关（normal）：短时挂机，单次最长 30 分钟，每日 3 次，冷却 5 分钟，基础收益
 *   - 深度闭关（deep）：长线挂机 4-8 小时，每日 1 次，2 倍收益，需筑基期以上，
 *                      未达最短时长结束时按强行出关处理，损失 50% 收益
 *
 * 设计依据：参考修仙游戏指南文档第 4 节"修炼方式"
 *   常规修炼使用 .闭关修炼，适合日常获取修为；
 *   高阶或长线挂机可使用 .深度闭关，之后通过 .查看闭关 查看进度，必要时 .强行出关
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const Realm = require('../models/realm');
const sequelize = require('../config/database');
const authenticateToken = require('../middleware/auth');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
// 境界服务：统一封装"大境界名→rank"解析与境界比较，替代历史 REALM_ORDER.indexOf 字符串比较
// 修复 B1 bug：化神期及以上玩家境界（如"化神中期"）不在旧版 REALM_ORDER 中，
//            导致 indexOf 返回 -1，被深度闭关错误拦截。
const RealmService = require('../game/core/RealmService');

/**
 * 读取常规闭关配置
 * @returns {Object} 常规闭关配置 { max_duration, daily_limit, cooldown, exp_rate }
 */
function getNormalSeclusionConfig() {
    try {
        const config = configLoader.getConfig('seclusion');
        const settings = config?.settings?.normal_seclusion?.value;
        if (settings) return settings;
    } catch (e) {
        console.warn('读取常规闭关配置失败:', e.message);
    }
    // 默认值兜底，避免配置缺失导致服务不可用
    return { max_duration: 1800, daily_limit: 3, cooldown: 300, exp_rate: 1 };
}

/**
 * 读取深度闭关配置
 * @returns {Object} 深度闭关配置
 */
function getDeepSeclusionConfig() {
    try {
        const config = configLoader.getConfig('seclusion');
        const settings = config?.settings?.deep_seclusion?.value;
        if (settings) return settings;
    } catch (e) {
        console.warn('读取深度闭关配置失败:', e.message);
    }
    return {
        min_duration: 14400,
        max_duration: 28800,
        daily_limit: 1,
        cooldown: 3600,
        exp_rate: 2,
        min_realm: '筑基期',
        forced_penalty: 0.5
    };
}

/**
 * 读取闭关基础修为收益率（每秒）
 * @returns {number} 基础修为/秒
 */
function getBaseExpRate() {
    try {
        const config = configLoader.getConfig('seclusion');
        return parseFloat(config?.settings?.seclusion_exp_rate?.value) || 1;
    } catch (e) {
        return 1;
    }
}

/**
 * 获取境界加成倍率（境界越高收益越高）
 * @param {string} realmName - 境界名称
 * @returns {number} 境界加成倍率
 */
async function getRealmMultiplier(realmName) {
    try {
        const realm = await Realm.findOne({ where: { name: realmName } });
        if (realm) {
            // 每提升一个境界 rank，收益增加 10%
            return 1.0 + (realm.rank - 1) * 0.1;
        }
    } catch (err) {
        console.error('获取境界加成失败:', err);
    }
    return 1.0;
}

/**
 * 跨日重置每日闭关次数
 * 设计理念：每日闭关次数应在跨日后重置，保证每日额度独立计算
 * @param {Object} player - 玩家实例
 * @returns {Object} 重置后的玩家实例
 */
async function resetDailyCountIfNeeded(player) {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD 格式
    if (player.last_seclusion_date !== today) {
        // 跨日，重置每日闭关次数
        if (player.daily_seclusion_count !== 0 || player.daily_deep_seclusion_count !== 0) {
            player.daily_seclusion_count = 0;
            player.daily_deep_seclusion_count = 0;
            player.last_seclusion_date = today;
            await player.save();
            console.log(`[Seclusion] 跨日重置玩家 ${player.id} 每日闭关次数`);
        }
    }
    return player;
}

/**
 * @route POST /api/seclusion/start
 * @desc 开始闭关（支持 mode: normal/deep）
 * @access Private
 * @body {string} mode - 闭关模式 normal|deep（默认 normal）
 * @body {number} duration - 期望闭关时长（秒），深度闭关 4-8 小时，常规闭关最长 30 分钟
 */
router.post('/start', authenticateToken, async (req, res, next) => {
    // 事务包裹：开始闭关涉及状态变更 + 每日次数累加，必须原子性
    // 行级锁：防止双开 tab 并发开始闭关导致状态错乱
    const t = await sequelize.transaction();
    try {
        const playerId = req.user.id;
        const { mode = 'normal', duration } = req.body;

        // 状态机互斥校验：闭关与其他 exclusive 状态互斥（战斗/移动/历练/封禁）
        // 通过 StateRegistry 收集所有激活状态统一校验，避免散落判断
        // 传入 logCtx 以记录被拦截的转移尝试到 player_state_log 表
        const PlayerStateMachine = require('../game/state/PlayerStateMachine');
        const stateCheck = await PlayerStateMachine.canStart(
            playerId,
            PlayerStateMachine.PlayerState.SECLUDED,
            { source: 'route', stateType: 'seclusion' }
        );
        if (!stateCheck.allowed) {
            throw new AppError(stateCheck.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 行级锁：事务内查询并锁定玩家行，防止并发修改
        const player = await Player.findByPk(playerId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (player.is_secluded) {
            throw new AppError('玩家已在闭关中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (player.is_moving) {
            throw new AppError('移动中无法开始闭关', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 跨日重置每日次数（事务内）
        const today = new Date().toISOString().split('T')[0];
        if (player.last_seclusion_date !== today) {
            if (player.daily_seclusion_count !== 0 || player.daily_deep_seclusion_count !== 0) {
                player.daily_seclusion_count = 0;
                player.daily_deep_seclusion_count = 0;
                player.last_seclusion_date = today;
            }
        }

        const isDeep = mode === 'deep';
        const config = isDeep ? getDeepSeclusionConfig() : getNormalSeclusionConfig();

        // 境界检查（深度闭关需达到筑基期以上）
        // 修复 B1 bug：用 RealmService.meetsRealmRequirement 替代 REALM_ORDER.indexOf 比较
        // 旧逻辑用字符串 indexOf 比较，"化神中期"等子境界名不在旧版 REALM_ORDER 中，
        // 导致化神期玩家被错误拦截。新逻辑通过 rank 数值比较，正确支持所有境界。
        if (isDeep) {
            const realmCheck = RealmService.meetsRealmRequirement(player, config.min_realm);
            if (!realmCheck.met) {
                throw new AppError(
                    `深度闭关需达到 ${config.min_realm} 境界（${realmCheck.reason || '境界不达标'}）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
        }

        // 每日次数检查
        const todayCount = isDeep ? player.daily_deep_seclusion_count : player.daily_seclusion_count;
        if (todayCount >= config.daily_limit) {
            throw new AppError(
                `今日${isDeep ? '深度' : '常规'}闭关次数已用尽（每日 ${config.daily_limit} 次）`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 冷却时间检查
        if (player.last_seclusion_time) {
            const cooldown = config.cooldown;
            const now = new Date();
            const lastEnd = new Date(player.last_seclusion_time);
            const diffSeconds = Math.floor((now - lastEnd) / 1000);
            if (diffSeconds < cooldown) {
                const remainingSec = cooldown - diffSeconds;
                const remainingMin = Math.ceil(remainingSec / 60);
                throw new AppError(
                    `闭关冷却中，还需等待 ${remainingMin} 分钟`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
        }

        // 计算闭关时长
        const now = new Date();
        let seclusionDuration;
        if (isDeep) {
            // 深度闭关：4-8 小时，由玩家指定或默认最短时长
            const requested = duration ? parseInt(duration) : config.min_duration;
            seclusionDuration = Math.max(config.min_duration, Math.min(config.max_duration, requested));
        } else {
            // 常规闭关：最长 30 分钟，由玩家指定或默认最大时长
            const requested = duration ? parseInt(duration) : config.max_duration;
            seclusionDuration = Math.min(config.max_duration, Math.max(60, requested));
        }
        const endTime = new Date(now.getTime() + seclusionDuration * 1000);

        // 设置闭关状态
        player.is_secluded = true;
        player.seclusion_mode = isDeep ? 'deep' : 'normal';
        player.seclusion_start_time = now;
        player.seclusion_duration = seclusionDuration;
        player.seclusion_end_time = endTime;

        // 增加每日次数
        if (isDeep) {
            player.daily_deep_seclusion_count += 1;
        } else {
            player.daily_seclusion_count += 1;
        }
        player.last_seclusion_date = today;
        await player.save({ transaction: t });

        await t.commit();

        // 推送状态变更给前端（事务提交后再推送，避免回滚后误推）
        WebSocketNotificationService.notifyPlayerUpdate(playerId, 'seclusion_start', {
            is_secluded: true,
            seclusion_mode: player.seclusion_mode,
            seclusion_start_time: player.seclusion_start_time,
            seclusion_end_time: player.seclusion_end_time
        });

        // 记录状态转移日志（事务提交后异步记录，不影响主流程）
        PlayerStateMachine.logEnter(playerId, 'seclusion', PlayerStateMachine.PlayerState.SECLUDED, {
            source: 'route',
            details: { mode: player.seclusion_mode, duration: seclusionDuration }
        }).catch(() => { /* 日志失败不阻断 */ });

        res.json({
            code: 200,
            message: `进入${isDeep ? '深度' : '常规'}闭关状态`,
            data: {
                is_secluded: true,
                seclusion_mode: player.seclusion_mode,
                seclusion_start_time: player.seclusion_start_time,
                seclusion_end_time: player.seclusion_end_time,
                seclusion_duration: seclusionDuration
            }
        });
    } catch (error) {
        // 事务回滚前检查是否已结束，避免重复 rollback 抛错
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * 结束闭关核心处理函数
 *  - 常规闭关：可随时结束，按实际时长结算
 *  - 深度闭关：未达最短时长时按强行出关处理，损失 forced_penalty 比例收益
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @param {Function} next - 下一个中间件
 */
async function handleEndSeclusion(req, res, next) {
    // 事务包裹：结束闭关涉及修为增加 + 状态重置 + 冷却时间记录，必须原子性
    // 防止崩溃导致 exp 加了但 is_secluded 没清零（已发生过线上 bug）
    const t = await sequelize.transaction();
    try {
        const playerId = req.user.id;
        // 行级锁：防止与状态清理调度器（StateCleanerService）并发结算
        const player = await Player.findByPk(playerId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (!player.is_secluded) {
            throw new AppError('玩家未在闭关中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const startTime = new Date(player.seclusion_start_time);
        const now = new Date();
        const actualDuration = Math.max(0, Math.floor((now - startTime) / 1000));

        const isDeep = player.seclusion_mode === 'deep';
        const config = isDeep ? getDeepSeclusionConfig() : getNormalSeclusionConfig();
        const baseExpRate = getBaseExpRate();
        const realmMultiplier = await getRealmMultiplier(player.realm);
        const modeRate = config.exp_rate;

        // 判断是否属于强行出关（深度闭关未达最短时长）
        let forcedEnd = false;
        let penaltyRate = 1.0;
        if (isDeep && actualDuration < config.min_duration) {
            forcedEnd = true;
            // 损失 forced_penalty 比例，实际获得 (1 - forced_penalty)
            penaltyRate = 1 - config.forced_penalty;
        }

        // 计算收益：基础收益 × 境界加成 × 模式倍率 × 惩罚系数 × 实际时长
        const expGain = Math.floor(actualDuration * baseExpRate * realmMultiplier * modeRate * penaltyRate);

        // 更新玩家状态（事务内）
        player.exp = (BigInt(player.exp) + BigInt(expGain)).toString();
        player.is_secluded = false;
        player.seclusion_mode = 'normal';
        player.seclusion_start_time = null;
        player.seclusion_duration = 0;
        player.seclusion_end_time = null;
        player.last_seclusion_time = now;
        await player.save({ transaction: t });

        await t.commit();

        // 推送状态变更给前端（事务提交后再推送）
        WebSocketNotificationService.notifyPlayerUpdate(playerId, 'seclusion_end', {
            is_secluded: false,
            exp_gain: expGain,
            exp: player.exp,
            last_seclusion_time: player.last_seclusion_time,
            forced_end: forcedEnd
        });

        // 记录状态转移日志（事务提交后异步记录）
        const PlayerStateMachine = require('../game/state/PlayerStateMachine');
        PlayerStateMachine.logExit(playerId, 'seclusion', PlayerStateMachine.PlayerState.SECLUDED, {
            source: 'route',
            details: { mode: isDeep ? 'deep' : 'normal', exp_gain: expGain, forced_end: forcedEnd, duration: actualDuration }
        }).catch(() => { /* 日志失败不阻断 */ });

        // 拼装提示消息
        let message = `${isDeep ? '深度' : '常规'}闭关结束，本次获得修为 ${expGain} 点`;
        if (forcedEnd) {
            message += `（强行出关，损失 ${Math.round(config.forced_penalty * 100)}% 收益）`;
        }
        message += `。下次闭关需间隔 ${Math.floor(config.cooldown / 60)} 分钟。`;

        res.json({
            code: 200,
            message,
            data: {
                exp_gain: expGain,
                actual_duration: actualDuration,
                seclusion_mode: isDeep ? 'deep' : 'normal',
                forced_end: forcedEnd,
                penalty_rate: penaltyRate,
                cooldown_seconds: config.cooldown,
                player: {
                    exp: player.exp,
                    is_secluded: false,
                    last_seclusion_time: player.last_seclusion_time
                }
            }
        });
    } catch (error) {
        // 事务回滚前检查是否已结束，避免重复 rollback 抛错
        if (!t.finished) await t.rollback();
        next(error);
    }
}

/**
 * @route POST /api/seclusion/end
 * @desc 结束闭关（正常结算，深度闭关未达时长自动按强行出关处理）
 * @access Private
 */
router.post('/end', authenticateToken, handleEndSeclusion);

/**
 * @route POST /api/seclusion/force-end
 * @desc 强行出关（深度闭关专用快捷接口，逻辑等同 /end）
 * @access Private
 */
router.post('/force-end', authenticateToken, handleEndSeclusion);

/**
 * @route GET /api/seclusion/status
 * @desc 获取闭关状态，含模式、进度、每日剩余次数、配置
 * @access Private
 */
router.get('/status', authenticateToken, async (req, res, next) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 跨日重置每日次数
        await resetDailyCountIfNeeded(player);

        const baseExpRate = getBaseExpRate();
        const normalConfig = getNormalSeclusionConfig();
        const deepConfig = getDeepSeclusionConfig();

        const isDeep = player.seclusion_mode === 'deep';
        const config = isDeep ? deepConfig : normalConfig;

        let expGained = 0;
        let currentDuration = 0;
        let remainingTime = 0;
        let progress = 0;

        // 闭关中时计算实时进度与已获修为
        if (player.is_secluded && player.seclusion_start_time) {
            const startTime = new Date(player.seclusion_start_time);
            const now = new Date();
            currentDuration = Math.floor((now - startTime) / 1000);
            const realmMultiplier = await getRealmMultiplier(player.realm);

            // 修复 B14：深度闭关未达最短时长时，/status 显示的 expGained 未按强行出关惩罚打折，
            // 导致玩家看到的"已获修为"比 /end 实际结算的更多，产生"奖励数值不正确"的误解。
            // 现在与 /end 接口保持一致：未达最短时长时按 (1 - forced_penalty) 显示实时修为。
            let penaltyRate = 1.0;
            if (isDeep && currentDuration < config.min_duration) {
                penaltyRate = 1 - (config.forced_penalty ?? 0.5);
            }
            expGained = Math.floor(currentDuration * baseExpRate * realmMultiplier * config.exp_rate * penaltyRate);

            if (player.seclusion_end_time) {
                const endTime = new Date(player.seclusion_end_time);
                remainingTime = Math.max(0, Math.floor((endTime - now) / 1000));
                // 深度闭关按最短时长计算进度；常规闭关按总时长计算
                const progressBase = isDeep ? config.min_duration : player.seclusion_duration;
                progress = progressBase > 0 ? Math.min(100, Math.floor(currentDuration / progressBase * 100)) : 100;
            } else {
                progress = 100;
            }
        }

        // 计算两种模式的冷却剩余秒数（由后端权威计算，避免前端时钟漂移误差）
        // 公式：cooldown - (now - last_seclusion_time) / 1000，下限 0
        const nowForCooldown = new Date();
        const computeCooldownRemaining = (cfg) => {
            const cooldownSec = cfg?.cooldown || 0;
            if (cooldownSec <= 0) return 0;
            if (!player.last_seclusion_time) return 0;
            const lastTs = new Date(player.last_seclusion_time).getTime();
            if (isNaN(lastTs)) return 0;
            const elapsedSec = Math.floor((nowForCooldown.getTime() - lastTs) / 1000);
            return Math.max(0, cooldownSec - elapsedSec);
        };
        const normalCooldownRemaining = computeCooldownRemaining(normalConfig);
        const deepCooldownRemaining = computeCooldownRemaining(deepConfig);

        // 后端权威判断当前玩家是否达到深度闭关境界要求
        // 与 /start 接口的校验逻辑保持一致，避免前端重复实现境界判断
        // 前端仅依据此布尔值渲染按钮禁用状态，最终校验仍由后端 /start 完成
        // 修复 B1 bug：用 RealmService.meetsRealmRequirement 替代 REALM_ORDER.indexOf 比较
        let canDeep = false;
        try {
            const realmCheck = RealmService.meetsRealmRequirement(player, deepConfig.min_realm);
            canDeep = realmCheck.met;
        } catch (e) {
            console.warn('计算 can_deep 失败:', e.message);
            canDeep = false;
        }

        res.json({
            code: 200,
            data: {
                is_secluded: player.is_secluded,
                seclusion_mode: player.seclusion_mode,
                seclusion_start_time: player.seclusion_start_time,
                seclusion_end_time: player.seclusion_end_time,
                seclusion_duration: player.seclusion_duration,
                // 服务端当前时间戳（毫秒），供前端基于此 tick 计算实时冷却剩余
                server_time: nowForCooldown.getTime(),
                // 实时计算字段
                exp_rate: baseExpRate,
                exp_gained: expGained,
                current_duration: currentDuration,
                remaining_time: remainingTime,
                progress: progress,
                // 每日次数与剩余
                daily_seclusion_count: player.daily_seclusion_count,
                daily_deep_seclusion_count: player.daily_deep_seclusion_count,
                normal_remaining: Math.max(0, normalConfig.daily_limit - player.daily_seclusion_count),
                deep_remaining: Math.max(0, deepConfig.daily_limit - player.daily_deep_seclusion_count),
                // 冷却剩余秒数（由后端权威计算，前端直接展示，避免时钟漂移误差）
                normal_cooldown_remaining: normalCooldownRemaining,
                deep_cooldown_remaining: deepCooldownRemaining,
                // 是否可进行深度闭关（后端权威判断境界要求，前端直接据此渲染）
                can_deep: canDeep,
                // 配置信息（供前端展示）
                normal_config: normalConfig,
                deep_config: deepConfig,
                // 兼容旧字段
                cultivate_interval: 60,
                deep_seclusion_exp_rate: deepConfig.exp_rate,
                deep_seclusion_interval: deepConfig.min_duration
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
