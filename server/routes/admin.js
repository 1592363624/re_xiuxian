/**
 * 管理员路由
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const SystemConfig = require('../models/system_config');
const auth = require('../middleware/auth');

const LifespanService = require('../services/LifespanService');

// 管理员权限中间件
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: '权限不足：需要管理员权限' });
    }
};

// 时间加速 (GM命令)
router.post('/time-travel', auth, adminCheck, async (req, res) => {
    try {
        const { years } = req.body;
        if (!years || isNaN(years) || years <= 0) {
            return res.status(400).json({ message: '无效的时间参数 (years)' });
        }

        const seconds = years * LifespanService.SECONDS_PER_YEAR;
        console.log(`[Admin] Triggering time travel: +${years} years (+${seconds}s)`);
        
        const result = await LifespanService.updateLifespan(seconds);

        let message = `时光飞逝，转眼已过 ${years} 载。`;
        let userDied = false;
        let deathLog = null;

        if (result && result.deadCount > 0) {
            message += ` 岁月无情，共有 ${result.deadCount} 位道友寿元耗尽。`;
            
            // Check if current user died
            const myDeath = result.deadPlayers.find(p => p.id === req.player.id);
            if (myDeath) {
                userDied = true;
                deathLog = `你寿元已尽，身死道消！`;
                // If we had the drop info we could add it, but currently handleDeath modifies the player object in place.
                // The returned player object in deadPlayers has the NEW realm.
                // We can just tell the frontend to refresh.
            }
        }

        res.json({ 
            message, 
            userDied,
            deathLog
        });
    } catch (error) {
        res.status(500).json({ message: '时间加速失败', error: error.message });
    }
});

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
