/**
 * 服务端入口文件
 * 负责启动 Express 服务器，初始化数据库连接
 */
const express = require('express');
const cors = require('cors');
const sequelize = require('./config/database');
require('dotenv').config();

// 引入模型以确保同步
require('./models/player');
require('./models/chat');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/player', require('./routes/player'));
app.use('/api/chat', require('./routes/chat'));

// 路由测试
app.get('/', (req, res) => {
    res.send('重生之凡人修仙传 API Server Running...');
});

app.get('/api/status', async (req, res) => {
    try {
        await sequelize.authenticate();
        res.json({ 
            status: 'ok', 
            message: '服务器正常运行，数据库连接成功', 
            timestamp: new Date() 
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: '数据库连接失败', 
            error: error.message 
        });
    }
});

// 启动服务器
const startServer = async () => {
    // 尝试连接数据库，但不阻塞服务器启动
    try {
        await sequelize.authenticate();
        console.log('数据库连接成功。');
        // 同步模型（仅开发环境使用，生产环境建议使用 migration）
        await sequelize.sync({ alter: true });
    } catch (error) {
        console.error('无法连接到数据库 (但不影响服务器启动):', error.message);
    }

    app.listen(PORT, () => {
        console.log(`服务器运行在 http://localhost:${PORT}`);
    });
};

startServer();
