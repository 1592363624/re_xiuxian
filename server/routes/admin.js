/**
 * 管理员路由
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const SystemConfig = require('../models/system_config');
const auth = require('../middleware/auth');

// 管理员权限中间件
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: '权限不足：需要管理员权限' });
    }
};

// 获取所有玩家列表 (分页)
router.get('/players', auth, adminCheck, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const { count, rows } = await Player.findAndCountAll({
            attributes: { exclude: ['password'] }, // 不返回密码
            limit,
            offset,
            order: [['createdAt', 'DESC']]
        });

        res.json({
            total: count,
            totalPages: Math.ceil(count / limit),
            currentPage: page,
            players: rows
        });
    } catch (error) {
        res.status(500).json({ message: '获取玩家列表失败', error: error.message });
    }
});

// 修改玩家信息 (GM操作)
router.put('/players/:id', auth, adminCheck, async (req, res) => {
    try {
        const player = await Player.findByPk(req.params.id);
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        // 允许管理员修改任意字段 (除ID和密码)
        const updates = req.body;
        delete updates.id;
        delete updates.password;
        
        // 如果修改了 attributes，需要确保是 JSON 字符串 (如果前端传的是对象，Sequelize setter 会处理，但这里为了安全再次确认)
        if (updates.attributes && typeof updates.attributes === 'object') {
            // Sequelize model 会自动处理 JSON stringify，只要符合 setter 逻辑
        }

        await player.update(updates);
        res.json({ message: '玩家信息更新成功', player });
    } catch (error) {
        res.status(500).json({ message: '更新失败', error: error.message });
    }
});

// 获取系统配置
router.get('/config', auth, adminCheck, async (req, res) => {
    try {
        const configs = await SystemConfig.findAll();
        res.json(configs);
    } catch (error) {
        res.status(500).json({ message: '获取配置失败', error: error.message });
    }
});

// 保存系统配置
router.post('/config', auth, adminCheck, async (req, res) => {
    try {
        const { key, value, description } = req.body;
        
        let config = await SystemConfig.findByPk(key);
        if (config) {
            config.value = value;
            if (description) config.description = description;
            await config.save();
        } else {
            config = await SystemConfig.create({ key, value, description });
        }
        
        res.json({ message: '配置保存成功', config });
    } catch (error) {
        res.status(500).json({ message: '保存配置失败', error: error.message });
    }
});

module.exports = router;
