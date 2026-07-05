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
require('./models/playerEquipment');
require('./models/realm');
require('./models/admin_log');
require('./models/map');
// 玩家状态转移日志模型（优化3：状态变更追溯）
require('./models/playerStateLog');
// 洞府与药园模型（第一阶段新增玩法）
require('./models/playerCave');
require('./models/playerGarden');

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

// 修复：显式声明 configLoader，避免隐式全局变量污染
let configLoader = null;

// 从配置文件读取时间间隔常量（通过 ConfigLoader 支持热更新）
// 使用懒加载函数，避免模块加载时配置未初始化的问题
function getTimeIntervals() {
    return configLoader?.getConfig('game_balance')?.time_intervals || {};
}

// 提供配置访问函数，而非立即获取配置值
const UPDATE_INTERVAL_MS = () => getTimeIntervals().lifespan_update_interval_ms || 600000;
const UPDATE_INTERVAL_SEC = () => getTimeIntervals().lifespan_update_interval_sec || 600;
// 移动完成检查已迁移到 StateCleanerService（per-state interval 5s），无需独立定时任务
// 保留 move_check_interval_ms 配置项用于兼容，但本文件不再使用

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
        // 修复：configLoader 已在文件顶部声明（let configLoader = null），此处赋值即可
        configLoader = result.configLoader || require('./modules').infrastructure.ConfigLoader;
        console.log('配置加载器初始化成功，已加载配置:', configLoader.getLoadedConfigNames());
        return true;
    } catch (error) {
        console.error('配置加载器初始化失败:', error.message);
        return false;
    }
}

// 初始化游戏核心服务
async function initializeCoreServices(configLoaderInstance) {
    try {
        const { initializeGameServices } = require('./game');
        // initializeGameServices 是异步函数，需要等待
        await initializeGameServices(configLoaderInstance);
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

    // 统一状态清理调度器：定期清理过期闭关/战斗/历练/移动/封禁
    // 解决玩家非正常退出（关浏览器/断网/服务重启）导致状态卡死的问题
    // 架构：通过 StateRegistry 注册中心调度，新增玩法只需在 game/state/registrations/ 下新增注册文件
    // 说明：原 index.js 中的移动完成检查定时任务已迁移到 moving.js 的 cleanExpired，
    //       由 StateCleanerService 通过 per-state interval（5s）统一调度，保持架构一致
    try {
        // 1. 注册所有玩法状态处理器（闭关/战斗/历练/移动/封禁）
        const { registerAllStates } = require('./game/state');
        registerAllStates();
        // 2. 启动清理调度器（主调度间隔取所有状态中最小的 interval_ms，如移动 5s）
        const StateCleanerService = require('./game/services/StateCleanerService');
        StateCleanerService.start();
    } catch (err) {
        console.error('状态清理调度器启动失败:', err.message);
    }

    // 股市定时任务调度器：价格更新、强平检查、利息计算、分红派息
    // 由 StockSchedulerService 内部根据 game_balance.stock_market 配置调度周期
    try {
        const StockSchedulerService = require('./game/services/StockSchedulerService');
        // start() 是 async 方法但不阻塞主流程
        StockSchedulerService.start().catch(err => {
            console.error('股市调度器启动失败:', err.message);
        });
    } catch (err) {
        console.error('股市调度器加载失败:', err.message);
    }

    // 路由
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/player', require('./routes/player'));
    app.use('/api/chat', require('./routes/chat'));
    app.use('/api/admin', require('./routes/admin'));
    app.use('/api/admin/ai-config', require('./routes/admin_ai'));
    app.use('/api/admin/sect', require('./routes/admin_sect'));
    // 洞府管理（GM 后台）：玩家洞府列表查询、设施等级调整、洞府重置、药园地块数调整
    app.use('/api/admin/cave', require('./routes/admin_cave'));
    // 装备管理（GM 后台）：装备列表查询、记录修改、重置、强制卸下、GM 一键修理
    app.use('/api/admin/equipment', require('./routes/admin_equipment'));
    app.use('/api/admin/meditation', require('./routes/admin_meditation'));
    // 修炼配置管理（闭关 + 历练，支持热加载）
    app.use('/api/admin/cultivation', require('./routes/admin_cultivation'));
    app.use('/api/system', require('./routes/system'));
    app.use('/api/seclusion', require('./routes/seclusion'));
    app.use('/api/breakthrough', require('./routes/breakthrough'));
    app.use('/api/meditation', require('./routes/meditation'));
    app.use('/api/map', require('./routes/map').router);
    app.use('/api/gather', require('./routes/gather'));
    app.use('/api/combat', require('./routes/combat'));
    app.use('/api/config', require('./routes/config'));
    app.use('/api/attribute', require('./routes/attribute'));
    app.use('/api/time', require('./routes/time'));
    app.use('/api/notifications', require('./routes/notifications'));
    app.use('/api/inventory', require('./routes/inventory'));
    app.use('/api/sect', require('./routes/sect'));
    app.use('/api/market', require('./routes/market'));
    // PVP 斗法系统（第四阶段新增：玩家对战、段位排名、荣誉值）
    app.use('/api/pvp', require('./routes/pvp'));
    // PVP 管理（GM 后台）：段位调整、强制取消战斗、战斗记录查询
    app.use('/api/admin/pvp', require('./routes/admin_pvp'));
    // 当铺系统（第四阶段新增：典当、赎回、信用额度）
    app.use('/api/pawnshop', require('./routes/pawnshop'));
    // 当铺管理（GM 后台）：强制赎回、取消当票、调整信用
    app.use('/api/admin/pawnshop', require('./routes/admin_pawnshop'));
    // 股市系统（第四阶段新增：行情查询、买卖交易、融资融券、分红派息）
    app.use('/api/stock', require('./routes/stock'));
    // 股市管理（GM 后台）：调整股价、暂停交易、触发事件、强制平仓、手动分红
    app.use('/api/admin/stock', require('./routes/admin_stock'));
    app.use('/api/equipment', require('./routes/equipment'));
    // 洞府系统（开辟洞府、升级灵脉/静室/丹房/器室/大阵、领取灵石）
    app.use('/api/cave', require('./routes/cave'));
    // 药园系统（播种、采收、一键采收）
    app.use('/api/garden', require('./routes/garden'));

    // 健康检查接口（供部署脚本验证服务是否启动成功）
    // 设计目的：deploy.ps1 部署完成后 curl 此接口，确认服务真的起来了
    // 轻量级：不查数据库，只返回进程存活信号 + 基础运行信息
    app.get('/api/health', (req, res) => {
        res.json({
            code: 200,
            status: 'ok',
            uptime: process.uptime(),  // 进程运行秒数
            timestamp: Date.now(),
            version: process.env.npm_package_version || 'unknown'
        });
    });

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

    // Socket.IO 在线用户跟踪（与 WebSocketNotificationService 共享 JWT 鉴权）
    // 修复安全漏洞：禁止信任客户端传入的 playerId，必须通过 JWT 校验
    const jwt = require('jsonwebtoken');
    const Player = require('./models/player');

    async function authenticateSocket(socket) {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (!token) {
            socket.emit('auth_error', { message: '未提供认证令牌' });
            socket.disconnect(true);
            return null;
        }
        try {
            const decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
            const player = await Player.findByPk(decoded.id);
            if (!player || player.token_version !== decoded.v) {
                socket.emit('auth_error', { message: '认证失败，请重新登录' });
                socket.disconnect(true);
                return null;
            }
            return player.id;
        } catch (err) {
            socket.emit('auth_error', { message: '令牌无效或已过期' });
            socket.disconnect(true);
            return null;
        }
    }

    io.on('connection', async (socket) => {
        const playerId = await authenticateSocket(socket);
        if (!playerId) return;

        if (!onlineUsers.has(playerId.toString())) {
            onlineUsers.set(playerId.toString(), {
                socketId: socket.id,
                connectedAt: new Date(),
                lastSavedAt: new Date()
            });
        } else {
            // 更新 socketId，保留连接时间
            const info = onlineUsers.get(playerId.toString());
            info.socketId = socket.id;
            onlineUsers.set(playerId.toString(), info);
        }
        console.log(`玩家 ${playerId} 已连接，SocketID: ${socket.id}`);

        socket.on('disconnect', async () => {
            const userInfo = onlineUsers.get(playerId.toString());
            if (userInfo && userInfo.socketId === socket.id) {
                // 计算并保存时长
                const now = new Date();
                const lastSaved = userInfo.lastSavedAt || userInfo.connectedAt;
                const duration = now - lastSaved;

                if (duration > 0) {
                    try {
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

                onlineUsers.delete(playerId.toString());
                console.log(`玩家 ${playerId} 已断开连接`);
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
