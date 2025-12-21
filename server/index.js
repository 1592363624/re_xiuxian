/**
 * 服务端入口文件
 * 负责启动 Express 服务器，初始化数据库连接
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
const LifespanService = require('./services/LifespanService');
const MapService = require('./services/MapService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // 允许跨域
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// 定时任务：每10分钟 (600秒) 更新一次寿命
const UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const UPDATE_INTERVAL_SEC = 10 * 60;

setInterval(() => {
    LifespanService.updateLifespan(UPDATE_INTERVAL_SEC);
    MapService.processEnvironmentConsumption(UPDATE_INTERVAL_SEC);
}, UPDATE_INTERVAL_MS);

// 立即执行一次检查 (可选，用于启动时同步)
// LifespanService.updateLifespan(0); 

// 中间件
app.use(cors());
app.use(express.json());

// 将 io 实例挂载到 app 上，供路由使用
app.set('io', io);

// 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/player', require('./routes/player'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/system', require('./routes/system'));
app.use('/api/seclusion', require('./routes/seclusion'));
app.use('/api/breakthrough', require('./routes/breakthrough'));
app.use('/api/map', require('./routes/map'));

// 生产环境静态资源托管 (必须放在 API 路由之后)
// 如果 client/dist 目录存在，则提供静态文件服务
const clientDistPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));

// 所有非 API 请求返回 index.html (支持前端路由)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'API Not Found' });
    }
    res.sendFile(path.join(clientDistPath, 'index.html'), (err) => {
        if (err) {
            // 如果没有构建前端，或者是开发环境，返回简单的提示
            res.status(500).send('Server is running. For frontend, please run "npm run client" or build the project.');
        }
    });
});

// 启动服务器
const startServer = async () => {
    // 尝试连接数据库，但不阻塞服务器启动
    try {
        await sequelize.authenticate();
        console.log('数据库连接成功。');
        
        // 强制选择数据库，防止 No database selected 错误
        if (process.env.DB_NAME) {
            try {
                await sequelize.query(`USE \`${process.env.DB_NAME}\``);
                console.log(`已选择数据库: ${process.env.DB_NAME}`);
            } catch (err) {
                console.warn('手动选择数据库失败 (可能是权限问题或无需选择):', err.message);
            }
        }

        // 同步模型（仅开发环境使用，生产环境建议使用 migration）
        await sequelize.sync({ alter: true });
    } catch (error) {
        console.error('无法连接到数据库 (但不影响服务器启动):', error.message);
    }

    server.listen(PORT, () => {
        console.log(`服务器运行在 http://localhost:${PORT}`);
    });
};

startServer();
