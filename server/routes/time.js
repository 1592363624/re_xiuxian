/**
 * 双时间系统相关路由
 * 处理天道时间、红尘时间、活动时间消耗等接口
 *
 * 安全说明：客户端只发送意图（activity_type / activity_id / 期望年数），
 * 活动定义、年数区间、完成时点全部由服务端 config/time_system.json 与服务器时钟决定；
 * 客户端提交的 activity_config 不再被读取或存储，避免把任意结构写进 time_system_data。
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const game = require('../game');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const authMiddleware = require('../middleware/auth');

/**
 * 获取时间系统状态
 * GET /api/time/status
 */
router.get('/status', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        // 获取时间系统全局状态
        const timeSystemStatus = game.DualTimeService.getTimeSystemStatus();
        
        // 计算玩家寿元信息
        const lifespanInfo = game.DualTimeService.getLifespanSummary(player);
        
        const responseData = {
            code: 200,
            data: {
                // 天道时间信息
                heavenly_time: {
                    current_year: timeSystemStatus.heavenly_time.current_year,
                    current_time: timeSystemStatus.heavenly_time.current_time,
                    next_events: timeSystemStatus.heavenly_time.next_events
                },
                // 玩家时间信息
                player_time: {
                    total_age: lifespanInfo.total_age,
                    heavenly_age: lifespanInfo.heavenly_age,
                    mortal_age: lifespanInfo.mortal_age,
                    max_lifespan: lifespanInfo.max_lifespan,
                    remaining_lifespan: lifespanInfo.remaining_lifespan,
                    lifespan_percentage: lifespanInfo.lifespan_percentage
                },
                // 可用活动（服务端配置的活动类型）
                available_activities: game.DualTimeService.getAvailableActivities(player)
            }
        };

        res.json(responseData);
    } catch (error) {
        console.error('获取时间系统状态失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '获取时间系统状态失败' 
        });
    }
});

/**
 * 开始红尘时间活动（闭关突破、秘境历练、参悟功法等）
 * POST /api/time/start_activity
 * body: { activity_type, years? }  // years 为期望消耗年数，仅用于在服务端区间内收敛
 */
router.post('/start_activity', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        const { activity_type, years } = req.body;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        if (!activity_type || typeof activity_type !== 'string') {
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：activity_type' 
            });
        }

        // 处理红尘时间消耗（活动类型未配置时返回 null）
        const timeResult = game.DualTimeService.processMortalTimeConsumption(player, activity_type, years);
        if (!timeResult) {
            return res.status(400).json({
                code: 400,
                message: '当前无法进行该活动'
            });
        }

        // 进行中活动数量与同名活动唯一性校验（均取自服务端配置与玩家自身数据）
        const availableActivities = game.DualTimeService.getAvailableActivities(player);
        if (!availableActivities.includes(activity_type)) {
            return res.status(400).json({
                code: 400,
                message: '进行中活动已达上限或该活动已在进行中'
            });
        }

        const newActivity = {
            id: crypto.randomUUID(),
            activity_type: timeResult.activity_type,
            name: timeResult.name,
            start_time: new Date().toISOString(),
            time_cost_years: timeResult.time_cost_years,
            wait_seconds: timeResult.wait_seconds,
            completion_time: timeResult.completion_time
        };

        // 追加活动 + 累加天年在同一个行锁内完成。
        // 旧实现是在无锁的 req.player 上"读整块 time_system_data → push → 整块写回"：
        // 连点两次会各读到同一份旧数组，后写的把先写的那条活动直接抹掉（玩家表现为
        // "活动凭空消失、寿元白扣"），而 /complete_activity 那边是加了锁的，两边不对称。
        const rejected = { reason: null };
        await PlayerStateStore.mutatePlayer(player.id, (fresh) => {
            const currentData = { ...(fresh.time_system_data || {}) };
            const pending = Array.isArray(currentData.pending_activities) ? currentData.pending_activities : [];

            // 加锁后二次校验：同名活动唯一 + 并发上限（compare-then-act 必须在锁内）
            const freshAvailable = game.DualTimeService.getAvailableActivities(fresh);
            if (!freshAvailable.includes(timeResult.activity_type)) {
                rejected.reason = '进行中活动已达上限或该活动已在进行中';
                return null;
            }

            return {
                timeSystemData: { pending_activities: pending.concat([newActivity]) },
                columns: {
                    heavenly_age: (Number(fresh.heavenly_age) || 0) + timeResult.heavenly_time_elapsed
                }
            };
        });

        if (rejected.reason) {
            return res.status(400).json({ code: 400, message: rejected.reason });
        }

        res.json({
            code: 200,
            data: {
                activity: timeResult.activity_type,
                time_cost_years: timeResult.time_cost_years,
                age_increase: timeResult.age_increase,
                completion_time: timeResult.completion_time,
                heavenly_time_elapsed: timeResult.heavenly_time_elapsed,
                message: '活动开始成功，时间加速流逝中...'
            }
        });
    } catch (error) {
        console.error('开始活动失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '开始活动失败' 
        });
    }
});

/**
 * 完成红尘时间活动
 * POST /api/time/complete_activity
 * body: { activity_id }
 */
router.post('/complete_activity', authMiddleware, async (req, res) => {
    // 事务 + 行锁只用于摘除活动：并发重复提交同一 activity_id 时，
    // 只有先拿到锁的请求能摘到该活动，后到的请求查不到即返回 404
    let activity = null;
    let activityClaimed = false;
    const t = await sequelize.transaction();
    try {
        const lockedPlayer = await Player.findByPk(req.user.id, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });

        if (!lockedPlayer) {
            await t.rollback();
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const { activity_id } = req.body;
        if (!activity_id || typeof activity_id !== 'string') {
            await t.rollback();
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：activity_id' 
            });
        }

        const currentTimeData = { ...(lockedPlayer.time_system_data || {}) };
        const pendingActivities = Array.isArray(currentTimeData.pending_activities)
            ? currentTimeData.pending_activities
            : [];
        
        // 查找活动
        const activityIndex = pendingActivities.findIndex(act => act.id === activity_id);
        if (activityIndex === -1) {
            await t.rollback();
            return res.status(404).json({ 
                code: 404, 
                message: '未找到该活动' 
            });
        }

        activity = pendingActivities[activityIndex];

        // 检查活动是否已完成（服务器时钟，客户端无法提前领取）
        const completionAt = new Date(activity.completion_time).getTime();
        if (!Number.isFinite(completionAt) || Date.now() < completionAt) {
            await t.rollback();
            return res.status(400).json({ 
                code: 400, 
                message: '活动尚未完成' 
            });
        }

        // 先摘除活动再结算，避免结算异常时同一活动被重复领取
        pendingActivities.splice(activityIndex, 1);
        currentTimeData.pending_activities = pendingActivities;
        await lockedPlayer.update({ time_system_data: currentTimeData }, { transaction: t });

        await t.commit();
        activityClaimed = true;

        // 结算交由服务实例自身落库（不并入上面的事务，避免跨事务混用同一实例）
        const result = await game.DualTimeService.processActivityCompletion(req.player, activity);

        res.json({
            code: 200,
            data: {
                activity: activity.activity_type,
                result: result,
                message: '活动完成成功'
            }
        });
    } catch (error) {
        if (!activityClaimed) {
            await t.rollback();
        }
        console.error('完成活动失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '完成活动失败' 
        });
    }
});

/**
 * 获取玩家待完成的活动列表
 * GET /api/time/pending_activities
 */
router.get('/pending_activities', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const now = Date.now();
        const filteredActivities = game.DualTimeService.getPendingActivities(player)
            .filter(activity => activity && typeof activity.id === 'string')
            .map(activity => {
                const completionAt = new Date(activity.completion_time).getTime();
                const isCompleted = Number.isFinite(completionAt) && now >= completionAt;
                return {
                    id: activity.id,
                    activity_type: activity.activity_type,
                    name: activity.name,
                    start_time: activity.start_time,
                    time_cost_years: activity.time_cost_years,
                    completion_time: activity.completion_time,
                    time_remaining: isCompleted ? 0 : Math.max(0, completionAt - now),
                    is_completed: isCompleted
                };
            });

        res.json({
            code: 200,
            data: {
                pending_activities: filteredActivities
            }
        });
    } catch (error) {
        console.error('获取待完成活动失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '获取待完成活动失败' 
        });
    }
});

/**
 * 获取世界级事件信息
 * GET /api/time/world_events
 */
router.get('/world_events', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const timeSystemStatus = game.DualTimeService.getTimeSystemStatus();
        const worldEventParticipation = player.time_system_data?.world_event_participation || {};

        const worldEvents = timeSystemStatus.heavenly_time.next_events.map(event => ({
            event: event.event,
            name: event.name,
            next_occurrence: event.next_occurrence,
            years_until: event.years_until,
            player_participation: worldEventParticipation[event.event] === true
        }));

        res.json({
            code: 200,
            data: {
                world_events: worldEvents
            }
        });
    } catch (error) {
        console.error('获取世界事件失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '获取世界事件失败' 
        });
    }
});

module.exports = router;
