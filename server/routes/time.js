/**
 * 双时间系统相关路由
 * 处理天道时间、红尘时间、活动时间消耗等接口
 */
const express = require('express');
const router = express.Router();
const { core } = require('../modules');
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
        const timeSystemStatus = core.DualTimeService.getTimeSystemStatus();
        
        // 计算玩家寿元信息
        const lifespanInfo = core.DualTimeService.calculateRemainingLifespan(player);
        
        const responseData = {
            code: 200,
            data: {
                // 天道时间信息
                heavenly_time: {
                    current_year: timeSystemStatus.heavenly_time.current_year,
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
                // 可用活动
                available_activities: core.DualTimeService.getAvailableActivities(player)
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
 */
router.post('/start_activity', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        const { activity_type, activity_config } = req.body;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        if (!activity_type) {
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：activity_type' 
            });
        }

        // 验证活动类型是否可用
        const availableActivities = core.DualTimeService.getAvailableActivities(player);
        if (!availableActivities.includes(activity_type)) {
            return res.status(400).json({ 
                code: 400, 
                message: '当前无法进行该活动' 
            });
        }

        // 处理红尘时间消耗
        const timeResult = core.DualTimeService.processMortalTimeConsumption(
            player, 
            activity_type, 
            activity_config || {}
        );

        // 更新玩家时间数据
        const currentTimeData = player.time_system_data || {};
        currentTimeData.pending_activities = currentTimeData.pending_activities || [];
        currentTimeData.pending_activities.push({
            activity_type: activity_type,
            start_time: Date.now(),
            time_cost: timeResult.time_cost_years,
            completion_time: timeResult.completion_time,
            config: activity_config
        });

        await player.update({
            mortal_age: (player.mortal_age || 0) + timeResult.age_increase,
            time_system_data: currentTimeData
        });

        res.json({
            code: 200,
            data: {
                activity: activity_type,
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
 */
router.post('/complete_activity', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        const { activity_id } = req.body;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        if (!activity_id) {
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：activity_id' 
            });
        }

        const currentTimeData = player.time_system_data || {};
        const pendingActivities = currentTimeData.pending_activities || [];
        
        // 查找并完成活动
        const activityIndex = pendingActivities.findIndex(act => act.id === activity_id);
        if (activityIndex === -1) {
            return res.status(404).json({ 
                code: 404, 
                message: '未找到该活动' 
            });
        }

        const activity = pendingActivities[activityIndex];
        
        // 检查活动是否已完成
        if (Date.now() < new Date(activity.completion_time).getTime()) {
            return res.status(400).json({ 
                code: 400, 
                message: '活动尚未完成' 
            });
        }

        // 根据活动类型处理结果
        const activityResult = await core.DualTimeService.processActivityCompletion(
            player, 
            activity
        );

        // 移除已完成的活动
        pendingActivities.splice(activityIndex, 1);
        currentTimeData.pending_activities = pendingActivities;

        await player.update({
            time_system_data: currentTimeData
        });

        res.json({
            code: 200,
            data: {
                activity: activity.activity_type,
                result: activityResult,
                message: '活动完成成功'
            }
        });
    } catch (error) {
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

        const currentTimeData = player.time_system_data || {};
        const pendingActivities = currentTimeData.pending_activities || [];
        
        // 过滤出已完成的活动的
        const now = Date.now();
        const filteredActivities = pendingActivities.map(activity => ({
            id: activity.id,
            activity_type: activity.activity_type,
            start_time: activity.start_time,
            time_cost_years: activity.time_cost,
            completion_time: activity.completion_time,
            time_remaining: Math.max(0, new Date(activity.completion_time).getTime() - now),
            is_completed: now >= new Date(activity.completion_time).getTime(),
            config: activity.config
        }));

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

        const timeSystemStatus = core.DualTimeService.getTimeSystemStatus();
        const currentTimeData = player.time_system_data || {};
        const worldEventParticipation = currentTimeData.world_event_participation || {};

        const worldEvents = timeSystemStatus.heavenly_time.next_events.map(event => ({
            event: event.event,
            name: event.name,
            next_occurrence: event.next_occurrence,
            years_until: event.years_until,
            player_participation: worldEventParticipation[event.event] || false
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