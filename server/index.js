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

// 引入模型以确保同步
require('./models/player');
require('./models/chat');
require('./models/system_config');

const http = require('http');
const socketIo = require('socket.io');
const { infrastructure, core } = require('./modules');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// 在线用户跟踪（使用Socket.IO连接状态）
const onlineUsers = new Map();

// 定时任务：每10分钟 (600秒) 更新一次寿命
const UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_INTERVAL_SEC = 10 * 60;

// 中间件
app.use(cors());
app.use(express.json());

// 将 io 实例挂载到 app 上，供路由使用
app.set('io', io);

// 初始化配置加载器
let configLoader;
async function initializeConfigLoader() {
    try {
        const { initializeModules } = require('./modules');
        const result = await initializeModules();
        configLoader = result.configLoader || require('./modules').infrastructure.ConfigLoader;
        console.log('配置加载器初始化成功，已加载配置:', configLoader.getLoadedConfigNames());
        return true;
    } catch (error) {
        console.error('配置加载器初始化失败:', error.message);
        return false;
    }
}

// 初始化核心服务
async function initializeCoreServices(configLoader) {
    try {
        const { initializeCoreServices } = require('./modules').core;
        initializeCoreServices(configLoader);
        console.log('核心服务模块初始化成功');
        return true;
    } catch (error) {
        console.error('核心服务初始化失败:', error.message);
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

        await sequelize.sync({ alter: true });
    } catch (error) {
        console.error('无法连接到数据库 (但不影响服务器启动):', error.message);
    }

    // 启动定时任务
    setInterval(async () => {
        try {
            await core.LifespanService.updateLifespan(UPDATE_INTERVAL_SEC);
        } catch (error) {
            console.error('寿命更新失败:', error.message);
        }
    }, UPDATE_INTERVAL_MS);
    console.log('寿命更新定时任务已启动');

    // 路由
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/player', require('./routes/player'));
    app.use('/api/chat', require('./routes/chat'));
    app.use('/api/admin', require('./routes/admin'));
    app.use('/api/system', require('./routes/system'));
    app.use('/api/seclusion', require('./routes/seclusion'));
    app.use('/api/breakthrough', require('./routes/breakthrough'));
    app.use('/api/map', require('./routes/map'));
    app.use('/api/config', require('./routes/config'));
    app.use('/api/attribute', require('./routes/attribute'));
    app.use('/api/time', require('./routes/time'));

    // Socket.IO在线用户跟踪
    io.on('connection', (socket) => {
        const playerId = socket.handshake.query.playerId || socket.handshake.auth.playerId;
        if (playerId) {
            onlineUsers.set(playerId, {
                socketId: socket.id,
                connectedAt: new Date()
            });
            console.log(`玩家 ${playerId} 已连接，SocketID: ${socket.id}`);
        }

        socket.on('disconnect', () => {
            if (playerId) {
                const userInfo = onlineUsers.get(playerId);
                if (userInfo && userInfo.socketId === socket.id) {
                    onlineUsers.delete(playerId);
                    console.log(`玩家 ${playerId} 已断开连接`);
                }
            }
        });
    });

    // 将onlineUsers挂载到app
    app.set('onlineUsers', onlineUsers);

    // 生产环境静态资源托管
    const clientDistPath = path.join(__dirname, '../client/dist');
    app.use(express.static(clientDistPath));

    // 所有 index.html
    app.get('*', (req, res) => {
        if (req.path.startsWith('/api')) {
            return res.status(404).json({ code: 404, message: 'API Not Found' });
        }
        res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
            if (err) {
                res.status(500).json({ code: 500, message: 'Server is running. Please build the frontend first.' });
            }
        });
    });

    server.listen(PORT, () => {
        console.log(`服务器运行在 http://localhost:${PORT}`);
        console.log(`API文档: http://localhost:${PORT}/api-docs (如已配置)`);
    });
};

startServer();

module.exports = { app, server, io };
