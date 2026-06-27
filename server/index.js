/**
 * 服务端入口文件
 * 负责启动 Express 服务器，初始化数据库连接和配置加载模块
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const sequelize = require('./config/database');
require('dotenv').config();

// 解决 BigInt 序列化问题
BigInt.prototype.toJSON = function() {
  return this.toString();
};

// 检查 JWT_SECRET 环境变量（安全要求）
if (!process.env.JWT_SECRET) {
  console.error('[安全错误] 未配置 JWT_SECRET 环境变量');
  console.error('请在 .env 文件中设置 JWT_SECRET，或设置环境变量后启动服务');
  process.exit(1);
}

// 引入模型以确保同步
require('./models/player');
require('./models/chat');
require('./models/system_config');
require('./models/system_notification');
require('./models/playerMapPosition');
require('./models/playerGathering');
require('./models/playerCombat');
require('./models/playerMovement');
require('./models/playerAdventure');
require('./models/activeBattle');
require('./models/item');
require('./models/realm');
require('./models/admin_log');
require('./models/map');

const http = require('http');
const socketIo = require('socket.io');
const { infrastructure } = require('./modules');
const game = require('./game');
const WebSocketNotificationService = require('./game/services/WebSocketNotificationService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

// 在线用户跟踪（使用Socket.IO连接状态）
const onlineUsers = new Map();

// 从配置文件读取时间间隔常量（通过 ConfigLoader 支持热更新）
// 使用懒加载函数，避免模块加载时配置未初始化的问题
function getTimeIntervals() {
    return configLoader.getConfig('game_balance')?.time_intervals || {};
}

// 提供配置访问函数，而非立即获取配置值
const UPDATE_INTERVAL_MS = () => getTimeIntervals().lifespan_update_interval_ms || 600000;
const UPDATE_INTERVAL_SEC = () => getTimeIntervals().lifespan_update_interval_sec || 600;
const MOVE_CHECK_INTERVAL_MS = () => getTimeIntervals().move_check_interval_ms || 5000;

// CORS 配置 - 生产环境应配置白名单域名
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*', // 生产环境建议配置具体域名，如 'https://yourdomain.com'
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// 中间件
app.use(cors(corsOptions));
app.use(express.json());

// 将 io 实例挂载到 app 上，供路由使用
app.set('io', io);

// 初始化配置加载器
async function initializeConfigLoader() {
    try {
        const { initializeModules } = require('./modules');
        const result = await initializeModules();
        // configLoader 已在第 60 行声明，这里直接赋值
        configLoader = result.configLoader || require('./modules').infrastructure.ConfigLoader;
        console.log('配置加载器初始化成功，已加载配置:', configLoader.getLoadedConfigNames());
        return true;
    } catch (error) {
        console.error('配置加载器初始化失败:', error.message);
        return false;
    }
}

// 初始化游戏核心服务
async function initializeCoreServices(configLoader) {
    try {
        const { initializeGameServices } = require('./game');
        // initializeGameServices 是异步函数，需要等待
        await initializeGameServices(configLoader);
        console.log('游戏核心服务模块初始化成功');
        return true;
    } catch (error) {
        console.error('游戏核心服务初始化失败:', error.message);
        return false;
    }
}

// 监听配置热更新事件
if (infrastructure.EventBus) {
    infrastructure.EventBus.subscribe('configHotUpdated', (event) => {
        console.log(`配置热更新: ${event.configName}`);
    });
}

// 启动服务器
const startServer = async () => {
    // 初始化配置加载器
    const configInitResult = await initializeConfigLoader();
    
    // 初始化核心服务
    if (configInitResult) {
        await initializeCoreServices(configLoader);
    }

    // 初始化历练探索服务（AI大模型事件生成）
    try {
        const { initializeAdventureService } = require('./routes/map');
        await initializeAdventureService(configLoader);
        console.log('历练探索服务初始化完成');
    } catch (error) {
        console.warn('历练探索服务初始化失败:', error.message);
    }

    // 尝试连接数据库，但不阻塞服务器启动
    try {
        await sequelize.authenticate();
        console.log('数据库连接成功。');
        
        if (process.env.DB_NAME) {
            try {
                await sequelize.query(`USE \`${process.env.DB_NAME}\``);
                console.log(`已选择数据库: ${process.env.DB_NAME}`);
            } catch (err) {
                console.warn('手动选择数据库失败 (可能是权限问题或无需选择):', err.message);
            }
        }

        // 执行数据库迁移（必须在 sequelize.sync() 之前）
        console.log('检查数据库迁移...');
        const { migrate } = require('./scripts/migration_manager');
        const migrationResult = await migrate();
        
        if (migrationResult.success && migrationResult.migrated > 0) {
            console.log(`✅ 数据库迁移完成: ${migrationResult.migrated} 个新迁移已执行`);
        }
        
        // 迁移失败时阻止服务器启动
        if (!migrationResult.success) {
            console.error('');
            console.error('═══════════════════════════════════════════');
            console.error('❌ 数据库迁移失败！服务器无法启动');
            console.error('═══════════════════════════════════════════');
            console.error(`错误: ${migrationResult.error || migrationResult.error}`);
            console.error('');
            console.error('请修复问题后重启服务器');
            console.error('═══════════════════════════════════════════');
            console.error('');
            process.exit(1);
        }
        
        // 同步数据库模型
        await sequelize.sync({ alter: true });
    } catch (error) {
        console.error('无法连接到数据库 (但不影响服务器启动):', error.message);
    }

    // 启动定时任务
    setInterval(async () => {
        try {
            await game.LifespanService.updateLifespan(UPDATE_INTERVAL_SEC());
        } catch (error) {
            console.error('寿命更新失败:', error.message);
        }
    }, UPDATE_INTERVAL_MS());
    console.log('寿命更新定时任务已启动');

    // 移动完成检查定时任务
    setInterval(async () => {
        try {
            const Player = require('./models/player');
            const MapConfigLoader = require('./game/services/MapConfigLoader');
            
            const movingPlayers = await Player.findAll({
                where: {
                    is_moving: true
                }
            });
            
            const now = new Date();
            
            for (const player of movingPlayers) {
                if (player.move_end_time && new Date(player.move_end_time) <= now) {
                    console.log(`玩家 ${player.id} 移动完成，自动到达目的地`);
                    
                    const targetMapId = player.moving_to_map_id;
                    const targetMap = MapConfigLoader.getMap(targetMapId);
                    
                    player.current_map_id = targetMapId;
                    player.last_map_move_time = now;
                    player.is_moving = false;
                    player.moving_from_map_id = null;
                    player.moving_to_map_id = null;
                    player.move_start_time = null;
                    player.move_end_time = null;
                    await player.save();
                    
                    // 通过 WebSocket 通知前端
                    const playerSocketId = onlineUsers.get(player.id.toString());
                    if (playerSocketId?.socketId) {
                        io.to(playerSocketId.socketId).emit('move:completed', {
                            player_id: player.id,
                            map_id: targetMapId,
                            map_name: targetMap?.name || '未知'
                        });
                    }
                }
            }
        } catch (error) {
            console.error('移动检查失败:', error.message);
        }
    }, MOVE_CHECK_INTERVAL_MS());
    console.log('移动完成检查定时任务已启动 (每5秒检查一次)');

    // 路由
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/player', require('./routes/player'));
    app.use('/api/chat', require('./routes/chat'));
    app.use('/api/admin', require('./routes/admin'));
    app.use('/api/system', require('./routes/system'));
    app.use('/api/seclusion', require('./routes/seclusion'));
    app.use('/api/breakthrough', require('./routes/breakthrough'));
    app.use('/api/map', require('./routes/map').router);
    app.use('/api/gather', require('./routes/gather'));
    app.use('/api/combat', require('./routes/combat'));
    app.use('/api/config', require('./routes/config'));
    app.use('/api/attribute', require('./routes/attribute'));
    app.use('/api/time', require('./routes/time'));
    app.use('/api/notifications', require('./routes/notifications'));

    // 全局404路由处理（API路由之后）
    app.use('/api/*', (req, res) => {
        res.status(404).json({
            code: 404,
            message: 'API接口不存在',
            path: req.originalUrl
        });
    });

    // 全局错误处理中间件（必须在所有路由和404处理之后）
    const { errorHandler } = require('./middleware/errorHandler');
    app.use(errorHandler);

    // Socket.IO在线用户跟踪
    io.on('connection', (socket) => {
        const playerId = socket.handshake.query.playerId || socket.handshake.auth.playerId;
        if (playerId) {
            if (!onlineUsers.has(playerId)) {
                onlineUsers.set(playerId, {
                    socketId: socket.id,
                    connectedAt: new Date(),
                    lastSavedAt: new Date()
                });
            } else {
                // 更新 socketId，保留连接时间
                const info = onlineUsers.get(playerId);
                info.socketId = socket.id;
                onlineUsers.set(playerId, info);
            }
            console.log(`玩家 ${playerId} 已连接，SocketID: ${socket.id}`);
        }

        socket.on('disconnect', async () => {
            if (playerId) {
                const userInfo = onlineUsers.get(playerId);
                if (userInfo && userInfo.socketId === socket.id) {
                    // 计算并保存时长
                    const now = new Date();
                    const lastSaved = userInfo.lastSavedAt || userInfo.connectedAt;
                    const duration = now - lastSaved;

                    if (duration > 0) {
                        try {
                            const Player = require('./models/player');
                            const player = await Player.findByPk(playerId);
                            if (player) {
                                player.total_online_time = BigInt(player.total_online_time || 0) + BigInt(duration);
                                await player.save();
                                console.log(`玩家 ${playerId} 下线，增加在线时长 ${duration}ms`);
                            }
                        } catch (err) {
                            console.error(`保存玩家 ${playerId} 在线时长失败:`, err);
                        }
                    }

                    onlineUsers.delete(playerId);
                    console.log(`玩家 ${playerId} 已断开连接`);
                }
            }
        });
    });
    
    // 定时保存在线时长 (每分钟) - 优化为批量查询
    setInterval(async () => {
        if (onlineUsers.size === 0) return;
        
        const Player = require('./models/player');
        const now = new Date();
        const playerIds = Array.from(onlineUsers.keys());
        
        try {
            // 批量查询所有在线玩家
            const players = await Player.findAll({
                where: { id: playerIds }
            });
            
            // 创建玩家映射
            const playerMap = new Map(players.map(p => [p.id, p]));
            
            // 批量更新在线时长
            for (const [playerId, info] of onlineUsers.entries()) {
                const lastSaved = info.lastSavedAt || info.connectedAt;
                const duration = now - lastSaved;
                
                if (duration > 5000) { // 至少5秒才保存
                    const player = playerMap.get(playerId);
                    if (player) {
                        player.total_online_time = BigInt(player.total_online_time || 0) + BigInt(duration);
                        await player.save();
                        
                        // 更新保存时间
                        info.lastSavedAt = now;
                        onlineUsers.set(playerId, info);
                    }
                }
            }
        } catch (err) {
            console.error('批量保存玩家在线时长失败:', err);
        }
    }, 60 * 1000);

    // 初始化WebSocket通知服务
    WebSocketNotificationService.initialize(io);
    console.log('WebSocket通知服务已初始化');

    // 将onlineUsers挂载到app
    app.set('onlineUsers', onlineUsers);

    // 3000端口仅提供API服务，不托管前端静态文件
    // 前端游戏客户端和管理后台需单独部署

    server.listen(PORT, () => {
        console.log(`API服务运行在 http://localhost:${PORT}`);
        console.log(`注意：此端口仅提供API服务，前端请通过开发服务器访问`);
    });
};

startServer();

module.exports = { app, server, io };
