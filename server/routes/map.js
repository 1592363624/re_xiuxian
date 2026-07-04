/**
 * 地图系统路由
 * 
 * 静态配置从 map_data.json 读取，动态数据从数据库读取
 * 支持即时移动和延时移动两种模式
 * 包含历练探索系统，支持 AI 大模型生成事件
 */
const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerMapPosition = require('../models/playerMapPosition');
const PlayerMovement = require('../models/playerMovement');
const MapConfigLoader = require('../game/services/MapConfigLoader');
const AdventureEventService = require('../game/services/AdventureEventService');
const Realm = require('../models/realm');
const auth = require('../middleware/auth');
const { Op } = require('sequelize');
const RealmService = require('../game/core/RealmService');
// 修复：统一在文件顶部引入 ConfigLoader，避免函数体内重复 require
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
// 修复：引入 MapService，将业务算法下沉到 Service 层
const MapService = require('../game/services/MapService');
// 引入 WebSocket 通知服务，用于历练关键节点主动推送玩家数据更新
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');

const mapConfig = MapConfigLoader;
let adventureService = null;

/**
 * 获取当前地图信息
 */
router.get('/info', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        let playerMapPos = await PlayerMapPosition.findOne({
            where: { player_id: player.id }
        });

        let mapId = player.current_map_id;

        if (!mapId) {
            const defaultMap = mapConfig.getDefaultMap();
            if (defaultMap) {
                mapId = defaultMap.id;
                player.current_map_id = mapId;
                await player.save();

                playerMapPos = await PlayerMapPosition.create({
                    player_id: player.id,
                    map_id: mapId
                });
            }
        }

        const mapConfigData = mapConfig.getMap(mapId);
        if (!mapConfigData) {
            const defaultMap = mapConfig.getDefaultMap();
            if (defaultMap) {
                player.current_map_id = defaultMap.id;
                await player.save();
                return res.json({ 
                    code: 200,
                    data: {
                        current_map: defaultMap, 
                        player_data: null,
                        connected_maps: [],
                        is_moving: false
                    }
                });
            }
            return res.status(404).json({ code: 404, message: '地图不存在' });
        }

        const connectedMaps = mapConfig.getConnectedMaps(mapId).map(m => {
            const costInfo = MapService.calculateTravelCost(m, player, mapConfigData);
            return {
                id: m.id,
                name: m.name,
                type: m.type,
                environment: m.environment,
                requiredRealm: m.requiredRealm,
                danger_level: m.danger_level,
                description: m.description,
                travel_time: m.travel_time,
                move_cost: costInfo.cost,
                move_time: costInfo.time,
                move_distance: costInfo.distance
            };
        });

        const responseData = {
            ...mapConfigData,
            player_data: playerMapPos ? {
                exploration_progress: playerMapPos.exploration_progress,
                visited_nodes: playerMapPos.visited_nodes,
                last_visit_time: playerMapPos.last_visit_time,
                resource_gather_count: playerMapPos.resource_gather_count,
                monster_defeat_count: playerMapPos.monster_defeat_count
            } : null
        };

        res.json({
            code: 200,
            data: {
                current_map: responseData,
                connected_maps: connectedMaps,
                is_moving: player.is_moving || false,
                // 返回玩家当前灵力，供前端展示判断
                player_mp_current: player.mp_current?.toString() || '0'
            }
        });
    } catch (error) {
        console.error('Map Info Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 计算移动到目标地图的消耗（供前端调用）
 * 业务算法委托 MapService.calculateTravelCost
 */
router.post('/calculate-move-cost', auth, async (req, res) => {
    try {
        const { targetMapId } = req.body;
        if (!targetMapId) return res.status(400).json({ code: 400, message: '目标地图ID不能为空' });

        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const currentMapId = player.current_map_id;
        const currentMapConfig = mapConfig.getMap(currentMapId);
        const targetMapConfig = mapConfig.getMap(targetMapId);

        if (!currentMapConfig || !targetMapConfig) {
            return res.status(404).json({ code: 404, message: '地图配置不存在' });
        }

        const travelCostInfo = MapService.calculateTravelCost(targetMapConfig, player, currentMapConfig);

        res.json({
            code: 200,
            data: {
                cost: travelCostInfo.cost,
                time: travelCostInfo.time,
                distance: travelCostInfo.distance,
                can_afford: player.mp_current >= travelCostInfo.cost
            }
        });
    } catch (error) {
        console.error('Calculate Move Cost Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 批量计算移动消耗（性能优化接口）
 *
 * 设计目的：FullMapList 全图浏览时需要展示所有地图的移动消耗，
 *   旧实现前端对每个地图发一次 /calculate-move-cost 请求，N 个地图会产生 N 次请求。
 *   本接口接收 targetMapIds 数组，一次性返回所有地图的移动消耗，减少 HTTP 往返。
 *
 * 请求体：{ targetMapIds: [1, 2, 3, ...] }
 * 返回：{ code: 200, data: { costs: { "1": {cost, time, distance, can_afford}, ... } } }
 */
router.post('/batch-calculate-move-cost', auth, async (req, res) => {
    try {
        const { targetMapIds } = req.body;
        if (!Array.isArray(targetMapIds) || targetMapIds.length === 0) {
            return res.status(400).json({ code: 400, message: 'targetMapIds 必须为非空数组' });
        }

        // 限制单次批量查询上限，防止恶意大请求
        const MAX_BATCH = 100;
        if (targetMapIds.length > MAX_BATCH) {
            return res.status(400).json({ code: 400, message: `单次批量查询上限 ${MAX_BATCH} 个地图` });
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const currentMapId = player.current_map_id;
        const currentMapConfig = mapConfig.getMap(currentMapId);

        if (!currentMapConfig) {
            return res.status(404).json({ code: 404, message: '当前地图配置不存在' });
        }

        // 批量计算所有目标地图的移动消耗
        const costs = {};
        for (const targetMapId of targetMapIds) {
            const targetMapConfig = mapConfig.getMap(targetMapId);
            if (!targetMapConfig) {
                // 配置不存在的地图跳过，不写入结果
                continue;
            }
            const travelCostInfo = MapService.calculateTravelCost(targetMapConfig, player, currentMapConfig);
            costs[targetMapId] = {
                cost: travelCostInfo.cost,
                time: travelCostInfo.time,
                distance: travelCostInfo.distance,
                can_afford: player.mp_current >= travelCostInfo.cost
            };
        }

        res.json({
            code: 200,
            data: { costs }
        });
    } catch (error) {
        console.error('Batch Calculate Move Cost Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
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
        if (!targetMapId) return res.status(400).json({ code: 400, message: '目标地图ID不能为空' });

        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        if (player.is_moving) {
            return res.status(400).json({ code: 400, message: '您正在移动中，请等待到达目的地' });
        }

        // 状态机互斥校验：移动与其他 exclusive 状态互斥（闭关/战斗/历练/封禁）
        const PlayerStateMachine = require('../game/state/PlayerStateMachine');
        const stateCheck = await PlayerStateMachine.canStart(
            req.user.id,
            PlayerStateMachine.PlayerState.MOVING,
            { source: 'route', stateType: 'moving' }
        );
        if (!stateCheck.allowed) {
            return res.status(400).json({ code: 400, message: stateCheck.reason });
        }

        const currentMapId = player.current_map_id;
        if (currentMapId == targetMapId) {
            return res.status(400).json({ code: 400, message: '您已经在目标地图' });
        }

        const currentMapConfig = mapConfig.getMap(currentMapId);
        const targetMapConfig = mapConfig.getMap(targetMapId);

        if (!currentMapConfig || !targetMapConfig) {
            return res.status(404).json({ code: 404, message: '地图配置不存在' });
        }

        const canEnter = mapConfig.canEnter(targetMapConfig, player.realm);
        if (!canEnter) {
            return res.status(403).json({ 
                code: 403,
                message: `境界不足，需达到 ${targetMapConfig.requiredRealm} 才能进入` 
            });
        }

        const travelCostInfo = MapService.calculateTravelCost(targetMapConfig, player, currentMapConfig);

        if (player.mp_current < travelCostInfo.cost) {
            return res.status(400).json({ 
                code: 400,
                message: `灵力不足，需要 ${travelCostInfo.cost} 点灵力` 
            });
        }

        const now = new Date();
        const endTime = new Date(now.getTime() + travelCostInfo.time * 1000);

        const t = await sequelize.transaction();
        try {
            player.mp_current = BigInt(player.mp_current) - BigInt(travelCostInfo.cost);
            player.is_moving = true;
            player.moving_from_map_id = currentMapId;
            player.moving_to_map_id = targetMapId;
            player.move_start_time = now;
            player.move_end_time = endTime;
            await player.save({ transaction: t });

            await PlayerMovement.create({
                player_id: player.id,
                from_map_id: currentMapId,
                from_map_name: currentMapConfig.name,
                to_map_id: targetMapId,
                to_map_name: targetMapConfig.name,
                distance: travelCostInfo.distance,
                mp_consumed: travelCostInfo.cost,
                duration_seconds: travelCostInfo.time,
                status: 'moving',
                started_at: now
            }, { transaction: t });

            await t.commit();

            // 记录状态转移日志（事务提交后异步记录）
            PlayerStateMachine.logEnter(req.user.id, 'moving', PlayerStateMachine.PlayerState.MOVING, {
                source: 'route',
                details: { from: currentMapConfig.name, to: targetMapConfig.name, duration: travelCostInfo.time }
            }).catch(() => { /* 日志失败不阻断 */ });

            res.json({
                code: 200,
                message: `开始移动，预计需要 ${MapService.formatTime(travelCostInfo.time)}`,
                data: {
                    from_map_id: currentMapId,
                    to_map_id: targetMapId,
                    from_map_name: currentMapConfig.name,
                    to_map_name: targetMapConfig.name,
                    start_time: now.toISOString(),
                    end_time: endTime.toISOString(),
                    total_seconds: travelCostInfo.time,
                    remaining_seconds: travelCostInfo.time
                }
            });
        } catch (e) {
            await t.rollback();
            throw e;
        }

    } catch (error) {
        console.error('Start Move Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 查询移动状态
 */
router.get('/move-status', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        if (!player.is_moving) {
            return res.json({
                code: 200,
                data: {
                    is_moving: false
                }
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
            data: {
                is_moving: true,
                from_map_id: player.moving_from_map_id,
                to_map_id: player.moving_to_map_id,
                from_map_name: fromMap?.name || '未知',
                to_map_name: toMap?.name || '未知',
                start_time: player.move_start_time,
                end_time: player.move_end_time,
                remaining_seconds: remainingSeconds,
                total_seconds: Math.ceil((endTime - new Date(player.move_start_time)) / 1000)
            }
        });
    } catch (error) {
        console.error('Move Status Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 取消移动（可选功能）
 */
router.post('/cancel-move', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        if (!player.is_moving) {
            return res.status(400).json({ code: 400, message: '您当前没有在移动中' });
        }

        player.is_moving = false;
        player.moving_from_map_id = null;
        player.moving_to_map_id = null;
        player.move_start_time = null;
        player.move_end_time = null;
        await player.save();

        const movement = await PlayerMovement.findOne({
            where: { 
                player_id: player.id, 
                status: 'moving' 
            },
            order: [['createdAt', 'DESC']]
        });

        if (movement) {
            movement.status = 'cancelled';
            movement.completed_at = new Date();
            await movement.save();
        }

        res.json({
            code: 200,
            message: '移动已取消，已退回起点'
        });
    } catch (error) {
        console.error('Cancel Move Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 完成移动（供内部调用或定时任务）
 */
router.post('/complete-move-internal', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        if (!player.is_moving) {
            return res.status(400).json({ code: 400, message: '玩家不在移动中' });
        }

        const targetMapId = player.moving_to_map_id;
        const targetMapConfig = mapConfig.getMap(targetMapId);

        player.current_map_id = targetMapId;
        player.last_map_move_time = new Date();
        player.is_moving = false;
        player.moving_from_map_id = null;
        player.moving_to_map_id = null;
        player.move_start_time = null;
        player.move_end_time = null;
        await player.save();

        await PlayerMapPosition.upsert({
            player_id: player.id,
            map_id: targetMapId,
            last_visit_time: new Date()
        });

        const movement = await PlayerMovement.findOne({
            where: { 
                player_id: player.id, 
                status: 'moving' 
            },
            order: [['createdAt', 'DESC']]
        });

        if (movement) {
            movement.status = 'completed';
            movement.completed_at = new Date();
            await movement.save();
        }

        res.json({
            code: 200,
            message: `已到达 ${targetMapConfig?.name || '目标地图'}`,
            data: {
                new_map: targetMapConfig,
                mp_current: player.mp_current.toString()
            }
        });
    } catch (error) {
        console.error('Complete Move Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 获取地图静态配置列表
 */
router.get('/config', auth, async (req, res) => {
    try {
        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

        const allMaps = mapConfig.getAllMaps();
        
        // 为每个地图计算是否可进入的状态
        const mapsWithStatus = allMaps.map(m => {
            const canEnter = mapConfig.canEnter(m, player.realm);
            return {
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
                connections: m.connections,
                can_enter: canEnter,
                player_realm: player.realm
            };
        });

        res.json({
            code: 200,
            data: {
                maps: mapsWithStatus
            }
        });
    } catch (error) {
        console.error('Map Config Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 获取境界配置（境界顺序列表）
 */
router.get('/realm-config', auth, async (req, res) => {
    try {
        const realms = await Realm.findAll({
            order: [['rank', 'ASC']]
        });
        
        const realmOrder = realms.map(r => ({
            name: r.name,
            rank: r.rank
        }));

        res.json({
            code: 200,
            data: {
                realms: realmOrder
            }
        });
    } catch (error) {
        console.error('Realm Config Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 验证地图配置
 */
router.get('/validate', auth, async (req, res) => {
    try {
        const validationResult = mapConfig.validate();
        res.json({
            code: 200,
            data: validationResult
        });
    } catch (error) {
        console.error('Map Validate Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 开始历练探索
 * 
 * 在当前地图开始历练，生成随机事件
 */
router.post('/explore/start', auth, async (req, res) => {
    try {
        // durationType: short/medium/long 时长分级；duration 向后兼容
        const { duration, durationType } = req.body;

        if (!adventureService) {
            return res.status(503).json({
                code: 503,
                message: '历练服务暂不可用',
                detail: '请稍后再试或联系管理员'
            });
        }

        // 状态机互斥校验：历练与其他 exclusive 状态互斥（闭关/战斗/移动/封禁）
        const PlayerStateMachine = require('../game/state/PlayerStateMachine');
        const stateCheck = await PlayerStateMachine.canStart(req.user.id, PlayerStateMachine.PlayerState.ADVENTURING);
        if (!stateCheck.allowed) {
            return res.status(400).json({ code: 400, message: stateCheck.reason });
        }

        const result = await adventureService.startAdventure(req.user.id, { duration, durationType });

        if (result.success) {
            // 推送历练开始事件，前端据此刷新状态（如 ActionBar 冷却、闭关状态）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(req.user.id, 'adventure_start', {
                    is_adventuring: true,
                    adventure_id: result.adventure?.id,
                    duration_type: durationType
                });
            } catch (e) {
                console.warn('[Map] 推送历练开始事件失败:', e.message);
            }
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
                message: result.error
            });
        }
    } catch (error) {
        console.error('Start Explore Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
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
            return res.status(503).json({ code: 503, message: '历练服务暂不可用' });
        }

        const player = await Player.findByPk(req.user.id);
        if (!player) return res.status(404).json({ code: 404, message: '玩家不存在' });

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
        res.status(500).json({ code: 500, message: '服务器错误' });
    }
});

/**
 * 获取当前历练状态（用于前端面板重开时恢复"历练中"状态）
 *
 * 业务计算下沉后端的核心体现：
 *   - 后端权威返回剩余时间、总时长、是否结束
 *   - 前端不再用本地缓存估算历练进度，避免关闭面板后状态丢失
 *   - 防止前端伪造历练状态
 *
 * 返回结构：
 *   {
 *     is_adventuring: boolean,
 *     adventure: { id, event_type, event_data, start_time, end_time, ... } | null,
 *     remaining_seconds: number,  // 后端权威剩余秒数
 *     total_seconds: number,      // 后端权威总时长
 *     is_expired: boolean,         // 是否已到结束时间（玩家应点击完成领取奖励）
 *     server_time: number          // 服务器当前时间戳（毫秒，用于前端时钟对齐）
 *   }
 */
router.get('/explore/status', auth, async (req, res) => {
    try {
        if (!adventureService) {
            return res.status(503).json({ code: 503, message: '历练服务暂不可用' });
        }

        // 查询玩家是否有进行中的历练
        const adventure = await adventureService.getLastAdventureEvent(req.user.id);

        if (!adventure) {
            return res.json({
                code: 200,
                data: {
                    is_adventuring: false,
                    adventure: null,
                    remaining_seconds: 0,
                    total_seconds: 0,
                    is_expired: false,
                    server_time: Date.now()
                }
            });
        }

        // 后端权威计算剩余时间与总时长
        const now = Date.now();
        const startMs = new Date(adventure.start_time).getTime();
        const endMs = new Date(adventure.end_time).getTime();
        const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
        const remainingSeconds = Math.max(0, Math.floor((endMs - now) / 1000));
        const isExpired = now >= endMs;

        res.json({
            code: 200,
            data: {
                is_adventuring: true,
                adventure,
                remaining_seconds: remainingSeconds,
                total_seconds: totalSeconds,
                is_expired: isExpired,
                server_time: now
            }
        });
    } catch (error) {
        console.error('Get Explore Status Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
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
            return res.status(503).json({ code: 503, message: '历练服务暂不可用' });
        }

        const result = await adventureService.completeAdventure(req.user.id);

        if (result.success) {
            // 推送历练完成事件，前端据此刷新玩家数据（修为/灵石/HP等变化）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(req.user.id, 'adventure_complete', {
                    is_adventuring: false,
                    rewards: result.rewards
                });
            } catch (e) {
                console.warn('[Map] 推送历练完成事件失败:', e.message);
            }
            res.json({
                code: 200,
                message: result.message,
                data: {
                    rewards: result.rewards
                }
            });
        } else {
            // 使用 code 和 message 字段，与 service 返回格式一致
            res.status(400).json({
                code: result.code || 400,
                message: result.message || '操作失败'
            });
        }
    } catch (error) {
        console.error('Complete Explore Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
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
            return res.status(503).json({ code: 503, message: '历练服务暂不可用' });
        }

        const result = await adventureService.generateCombatEncounter(req.user.id);

        if (result.success) {
            // 推送战斗遭遇事件，前端据此刷新状态（进入战斗模式）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(req.user.id, 'combat_encounter', {
                    in_combat: true,
                    monster: result.monster?.name
                });
            } catch (e) {
                console.warn('[Map] 推送战斗遭遇事件失败:', e.message);
            }
            res.json({
                code: 200,
                message: '遭遇怪物',
                data: result
            });
        } else {
            res.status(400).json({
                code: 400,
                message: result.error
            });
        }
    } catch (error) {
        console.error('Generate Combat Error:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
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
        res.status(500).json({ code: 500, message: '服务器错误' });
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
