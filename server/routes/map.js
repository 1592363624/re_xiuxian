/**
 * 地图系统路由
 * 
 * 静态配置从 map_data.json 读取，动态数据从数据库读取
 * 支持即时移动和延时移动两种模式
 * 包含历练探索系统，支持 AI 大模型生成事件
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const PlayerMapPosition = require('../models/playerMapPosition');
const MapConfigLoader = require('../services/MapConfigLoader');
const AdventureEventService = require('../services/AdventureEventService');
const MapService = require('../modules/core/MapService');
const auth = require('../middleware/auth');

const mapConfig = MapConfigLoader;
let adventureService = null;

/**
 * 获取当前地图信息
 */
router.get('/info', auth, async (req, res) => {
    try {
        const result = await MapService.getMapInfo(req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Map Info Error:', error);
        res.status(500).json({ error: error.message || 'Server error' });
    }
});

/**
 * 开始移动到目标地图（延时模式）
 * 
 * 设置玩家为移动状态，扣除灵力，记录移动历史
 */
router.post('/start-move', auth, async (req, res) => {
    try {
        const { targetMapId } = req.body;
        if (!targetMapId) return res.status(400).json({ error: '目标地图ID不能为空' });

        const result = await MapService.startMove(req.user.id, targetMapId);

        res.json({
            code: 200,
            message: `开始移动，预计需要 ${formatTime(result.travelCostInfo.time)}`,
            data: {
                from_map_id: result.currentMapConfig.id,
                to_map_id: result.targetMapConfig.id,
                from_map_name: result.currentMapConfig.name,
                to_map_name: result.targetMapConfig.name,
                start_time: result.now.toISOString(),
                end_time: result.endTime.toISOString(),
                total_seconds: result.travelCostInfo.time,
                remaining_seconds: result.travelCostInfo.time
            }
        });

    } catch (error) {
        console.error('Start Move Error:', error);
        const status = error.message.includes('灵力不足') || 
                      error.message.includes('移动中') || 
                      error.message.includes('境界不足') || 
                      error.message.includes('已经在') ? 400 : 500;
        res.status(status).json({ error: error.message || 'Server error' });
    }
});

/**
 * 查询移动状态
 */
router.get('/move-status', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: '玩家不存在' });

        if (!player.is_moving) {
            return res.json({
                code: 200,
                is_moving: false
            });
        }

        const now = new Date();
        const endTime = new Date(player.move_end_time);
        const remainingMs = endTime - now;
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));

        const fromMap = mapConfig.getMap(player.moving_from_map_id);
        const toMap = mapConfig.getMap(player.moving_to_map_id);

        res.json({
            code: 200,
            is_moving: true,
            from_map_id: player.moving_from_map_id,
            to_map_id: player.moving_to_map_id,
            from_map_name: fromMap?.name || '未知',
            to_map_name: toMap?.name || '未知',
            start_time: player.move_start_time,
            end_time: player.move_end_time,
            remaining_seconds: remainingSeconds,
            total_seconds: Math.ceil((endTime - new Date(player.move_start_time)) / 1000)
        });
    } catch (error) {
        console.error('Move Status Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 取消移动（可选功能）
 */
router.post('/cancel-move', auth, async (req, res) => {
    try {
        await MapService.cancelMove(req.user.id);

        res.json({
            code: 200,
            message: '移动已取消，已退回起点'
        });
    } catch (error) {
        console.error('Cancel Move Error:', error);
        const status = error.message.includes('当前没有在移动中') ? 400 : 500;
        res.status(status).json({ error: error.message || 'Server error' });
    }
});

/**
 * 完成移动（供内部调用或定时任务）
 */
router.post('/complete-move-internal', auth, async (req, res) => {
    try {
        const result = await MapService.completeMove(req.user.id);

        res.json({
            code: 200,
            message: `已到达 ${result.targetMapConfig?.name || '目标地图'}`,
            new_map: result.targetMapConfig,
            mp_current: result.player.mp_current.toString()
        });
    } catch (error) {
        console.error('Complete Move Error:', error);
        const status = error.message.includes('不在移动中') ? 400 : 500;
        res.status(status).json({ error: error.message || 'Server error' });
    }
});

/**
 * 辅助函数：格式化时间
 */
function formatTime(seconds) {
    if (seconds < 60) return `${seconds}秒`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}分钟`;
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    if (hours < 24) return `${hours}小时${remainingMins}分钟`;
    const days = Math.floor(hours / 24);
    return `${days}天${hours % 24}小时`;
}

/**
 * 获取地图静态配置列表
 */
router.get('/config', async (req, res) => {
    try {
        const allMaps = mapConfig.getAllMaps();
        res.json({
            maps: allMaps.map(m => ({
                id: m.id,
                name: m.name,
                type: m.type,
                environment: m.environment,
                x: m.x,
                y: m.y,
                requiredRealm: m.requiredRealm,
                danger_level: m.danger_level,
                travel_time: m.travel_time,
                description: m.description,
                connections: m.connections
            }))
        });
    } catch (error) {
        console.error('Map Config Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 验证地图配置
 */
router.get('/validate', auth, async (req, res) => {
    try {
        const validation = mapConfig.validate();
        res.json(validation);
    } catch (error) {
        console.error('Map Validate Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 开始历练探索
 * 
 * 在当前地图开始历练，生成随机事件
 */
router.post('/explore/start', auth, async (req, res) => {
    try {
        const { duration } = req.body;
        
        if (!adventureService) {
            return res.status(503).json({ 
                error: '历练服务暂不可用',
                message: '请稍后再试或联系管理员'
            });
        }

        const result = await adventureService.startAdventure(req.user.id, { duration });
        
        if (result.success) {
            res.json({
                code: 200,
                message: '历练已开始',
                data: {
                    adventure_id: result.adventure?.id,
                    event: result.event
                }
            });
        } else {
            res.status(400).json({
                code: 400,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Start Explore Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 获取当前历练事件
 * 
 * 获取正在进行的历练事件详情
 */
router.get('/explore/event', auth, async (req, res) => {
    try {
        if (!adventureService) {
            return res.status(503).json({ error: '历练服务暂不可用' });
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ error: '玩家不存在' });

        const currentMap = mapConfig.getMap(player.current_map_id);
        
        res.json({
            code: 200,
            data: {
                map: currentMap ? {
                    id: currentMap.id,
                    name: currentMap.name,
                    environment: currentMap.environment
                } : null,
                time_of_day: adventureService.getTimeOfDay(),
                weather: adventureService.getWeather()
            }
        });
    } catch (error) {
        console.error('Get Explore Event Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 完成历练
 * 
 * 结束当前历练并领取奖励
 */
router.post('/explore/complete', auth, async (req, res) => {
    try {
        if (!adventureService) {
            return res.status(503).json({ error: '历练服务暂不可用' });
        }

        const result = await adventureService.completeAdventure(req.user.id);
        
        if (result.success) {
            res.json({
                code: 200,
                message: result.message,
                data: {
                    rewards: result.rewards
                }
            });
        } else {
            res.status(400).json({
                code: 400,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Complete Explore Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 生成战斗遭遇
 * 
 * 在历练过程中触发战斗事件
 */
router.post('/explore/combat', auth, async (req, res) => {
    try {
        if (!adventureService) {
            return res.status(503).json({ error: '历练服务暂不可用' });
        }

        const result = await adventureService.generateCombatEncounter(req.user.id);
        
        if (result.success) {
            res.json({
                code: 200,
                message: '遭遇怪物',
                data: result
            });
        } else {
            res.status(400).json({
                code: 400,
                error: result.error
            });
        }
    } catch (error) {
        console.error('Generate Combat Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 获取 AI 服务状态
 * 
 * 查看 AI 大模型服务是否可用
 */
router.get('/explore/ai-status', auth, async (req, res) => {
    try {
        if (!adventureService) {
            return res.json({
                code: 200,
                data: {
                    available: false,
                    reason: '历练服务未初始化'
                }
            });
        }

        const aiStatus = adventureService.getAIStatus();
        
        res.json({
            code: 200,
            data: aiStatus
        });
    } catch (error) {
        console.error('Get AI Status Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * 初始化历练服务
 * @param {Object} configLoader - 配置加载器
 */
async function initializeAdventureService(configLoader) {
    try {
        adventureService = await AdventureEventService.initialize(configLoader);
        console.log('[Map Routes] 历练事件服务初始化成功');
        return true;
    } catch (error) {
        console.warn('[Map Routes] 历练事件服务初始化失败:', error.message);
        return false;
    }
}

module.exports = { router, initializeAdventureService };
