/**
 * 管理员路由
 * 提供GM管理功能，包括玩家管理、系统配置、物品发放等
 */
const express = require('express');
const router = express.Router();
const { Op, sequelize } = require('../config/database');
const Player = require('../models/player');
const SystemConfig = require('../models/system_config');
const AdminLog = require('../models/admin_log');
const Item = require('../models/item');
const auth = require('../middleware/auth');

const LifespanService = require('../services/LifespanService');

/**
 * 记录管理员操作日志
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            details: JSON.stringify(details),
            ip: req.ip || req.connection.remoteAddress
        });
    } catch (error) {
        console.error('记录管理员日志失败:', error);
    }
}

/**
 * 管理员权限中间件
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: '权限不足：需要管理员权限' });
    }
};

/**
 * 时间加速 (GM命令)
 * POST /api/admin/time-travel
 */
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

        if (result && result.deadCount > 0) {
            message += ` 岁月无情，共有 ${result.deadCount} 位道友寿元耗尽。`;
            
            const myDeath = result.deadPlayers.find(p => p.id === req.player.id);
            if (myDeath) {
                userDied = true;
                message += ' 你也因寿元耗尽而身死道消！';
            }
        }

        await logAdminAction(req.player.id, 'time_travel', { years, deadCount: result?.deadCount || 0 }, req);

        res.json({ 
            message, 
            userDied,
            dead_count: result?.deadCount || 0
        });
    } catch (error) {
        res.status(500).json({ message: '时间加速失败', error: error.message });
    }
});

/**
 * 获取所有玩家列表 (分页)
 * GET /api/admin/players
 */
router.get('/players', auth, adminCheck, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const realm = req.query.realm || '';
        const status = req.query.status || '';

        const whereClause = {};
        
        if (search) {
            whereClause[Op.or] = [
                { username: { [Op.like]: `%${search}%` } },
                { nickname: { [Op.like]: `%${search}%` } }
            ];
        }
        
        if (realm) {
            whereClause.realm = realm;
        }
        
        if (status === 'active') {
            whereClause.role = 'user';
        } else if (status === 'banned') {
            whereClause.role = 'banned';
        } else if (status === 'dead') {
            whereClause.is_dead = true;
        }

        const { count, rows } = await Player.findAndCountAll({
            attributes: { exclude: ['password'] },
            where: whereClause,
            limit,
            offset,
            order: [['createdAt', 'DESC']]
        });

        res.json({
            code: 200,
            data: {
                total: count,
                totalPages: Math.ceil(count / limit),
                currentPage: page,
                players: rows
            }
        });
    } catch (error) {
        res.status(500).json({ message: '获取玩家列表失败', error: error.message });
    }
});

/**
 * 获取单个玩家详情
 * GET /api/admin/players/:id
 */
router.get('/players/:id', auth, adminCheck, async (req, res) => {
    try {
        const player = await Player.findByPk(req.params.id, {
            attributes: { exclude: ['password'] }
        });

        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        res.json({
            code: 200,
            data: player
        });
    } catch (error) {
        res.status(500).json({ message: '获取玩家详情失败', error: error.message });
    }
});

/**
 * 修改玩家信息 (GM操作)
 * PUT /api/admin/players/:id
 */
router.put('/players/:id', auth, adminCheck, async (req, res) => {
    try {
        const player = await Player.findByPk(req.params.id);
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        const updates = req.body;
        delete updates.id;
        delete updates.password;
        delete updates.username;

        await player.update(updates);
        
        await logAdminAction(req.player.id, 'modify_player', { 
            target_id: player.id, 
            changes: Object.keys(updates) 
        }, req);

        res.json({ 
            code: 200,
            message: '玩家信息更新成功', 
            player 
        });
    } catch (error) {
        res.status(500).json({ message: '更新失败', error: error.message });
    }
});

/**
 * 封禁玩家
 * POST /api/admin/players/:id/ban
 */
router.post('/players/:id/ban', auth, adminCheck, async (req, res) => {
    try {
        const { reason, days = -1 } = req.body;
        const player = await Player.findByPk(req.params.id);

        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        if (player.role === 'admin') {
            return res.status(400).json({ message: '无法封禁管理员账号' });
        }

        const bannedUntil = days > 0 
            ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) 
            : null;

        player.role = 'banned';
        player.banned_until = bannedUntil;
        player.ban_reason = reason;
        await player.save();

        await logAdminAction(req.player.id, 'ban_player', {
            target_id: player.id,
            reason,
            days,
            banned_until: bannedUntil
        }, req);

        res.json({
            code: 200,
            message: days > 0 ? `玩家已封禁，解封时间：${bannedUntil.toLocaleString()}` : '玩家已永久封禁'
        });
    } catch (error) {
        res.status(500).json({ message: '封禁失败', error: error.message });
    }
});

/**
 * 解封玩家
 * POST /api/admin/players/:id/unban
 */
router.post('/players/:id/unban', auth, adminCheck, async (req, res) => {
    try {
        const player = await Player.findByPk(req.params.id);

        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        if (player.role !== 'banned') {
            return res.status(400).json({ message: '该玩家未被封禁' });
        }

        player.role = 'user';
        player.banned_until = null;
        player.ban_reason = null;
        await player.save();

        await logAdminAction(req.player.id, 'unban_player', { target_id: player.id }, req);

        res.json({
            code: 200,
            message: '玩家已解封'
        });
    } catch (error) {
        res.status(500).json({ message: '解封失败', error: error.message });
    }
});

/**
 * 发放物品
 * POST /api/admin/give-item
 */
router.post('/give-item', auth, adminCheck, async (req, res) => {
    try {
        const { playerId, itemId, quantity = 1 } = req.body;

        if (!playerId || !itemId || quantity < 1) {
            return res.status(400).json({ message: '参数错误' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ message: '目标玩家不存在' });
        }

        const item = await Item.create({
            player_id: playerId,
            item_id: itemId,
            quantity
        });

        await logAdminAction(req.player.id, 'give_item', {
            target_id: playerId,
            item_id: itemId,
            quantity
        }, req);

        res.json({
            code: 200,
            message: '物品发放成功',
            data: {
                item_id: item.id,
                item_key: itemId,
                quantity
            }
        });
    } catch (error) {
        res.status(500).json({ message: '发放失败', error: error.message });
    }
});

/**
 * 发放灵石
 * POST /api/admin/give-spirit-stones
 */
router.post('/give-spirit-stones', auth, adminCheck, async (req, res) => {
    try {
        const { playerId, amount } = req.body;

        if (!playerId || !amount || BigInt(amount) <= 0n) {
            return res.status(400).json({ message: '参数错误' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ message: '目标玩家不存在' });
        }

        player.spirit_stones = (BigInt(player.spirit_stones) + BigInt(amount)).toString();
        await player.save();

        await logAdminAction(req.player.id, 'give_spirit_stones', {
            target_id: playerId,
            amount
        }, req);

        res.json({
            code: 200,
            message: '灵石发放成功',
            data: {
                current_balance: player.spirit_stones
            }
        });
    } catch (error) {
        res.status(500).json({ message: '发放失败', error: error.message });
    }
});

/**
 * 增加修为
 * POST /api/admin/add-exp
 */
router.post('/add-exp', auth, adminCheck, async (req, res) => {
    try {
        const { playerId, amount } = req.body;

        if (!playerId || !amount || BigInt(amount) <= 0n) {
            return res.status(400).json({ message: '参数错误' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ message: '目标玩家不存在' });
        }

        player.exp = (BigInt(player.exp) + BigInt(amount)).toString();
        await player.save();

        await logAdminAction(req.player.id, 'add_exp', {
            target_id: playerId,
            amount
        }, req);

        res.json({
            code: 200,
            message: '修为增加成功',
            data: {
                current_exp: player.exp
            }
        });
    } catch (error) {
        res.status(500).json({ message: '增加失败', error: error.message });
    }
});

/**
 * 重置玩家
 * POST /api/admin/reset-player
 */
router.post('/reset-player', auth, adminCheck, async (req, res) => {
    try {
        const { playerId, keepItems = false } = req.body;

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        if (!keepItems) {
            await Item.destroy({ where: { player_id: playerId } });
        }

        player.realm = '凡人';
        player.exp = '0';
        player.spirit_stones = '0';
        player.hp_current = 100n;
        player.mp_current = 0n;
        player.lifespan_current = 16;
        player.lifespan_max = 60;
        player.toxicity = 0;
        player.attributes = JSON.stringify({
            hp_max: 100,
            mp_max: 0,
            atk: 10,
            def: 5,
            speed: 10,
            sense: 10
        });
        player.is_secluded = false;
        player.seclusion_start_time = null;
        player.current_map_id = 1;
        await player.save();

        await logAdminAction(req.player.id, 'reset_player', {
            target_id: playerId,
            keep_items: keepItems
        }, req);

        res.json({
            code: 200,
            message: '玩家已重置为初始状态'
        });
    } catch (error) {
        res.status(500).json({ message: '重置失败', error: error.message });
    }
});

/**
 * 强制突破境界
 * POST /api/admin/breakthrough
 */
router.post('/breakthrough', auth, adminCheck, async (req, res) => {
    try {
        const { playerId, targetRealm } = req.body;

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        player.realm = targetRealm;
        await player.save();

        await logAdminAction(req.player.id, 'force_breakthrough', {
            target_id: playerId,
            target_realm: targetRealm
        }, req);

        res.json({
            code: 200,
            message: `已将玩家境界修改为 ${targetRealm}`,
            data: {
                new_realm: player.realm
            }
        });
    } catch (error) {
        res.status(500).json({ message: '操作失败', error: error.message });
    }
});

/**
 * 获取系统配置
 * GET /api/admin/config
 */
router.get('/config', auth, adminCheck, async (req, res) => {
    try {
        const configs = await SystemConfig.findAll();
        res.json({
            code: 200,
            data: configs
        });
    } catch (error) {
        res.status(500).json({ message: '获取配置失败', error: error.message });
    }
});

/**
 * 保存系统配置
 * POST /api/admin/config
 */
router.post('/config', auth, adminCheck, async (req, res) => {
    try {
        const { key, value, description } = req.body;
        
        if (!key || value === undefined) {
            return res.status(400).json({ message: '配置键和值不能为空' });
        }

        let config = await SystemConfig.findByPk(key);
        if (config) {
            config.value = value;
            if (description) config.description = description;
            await config.save();
        } else {
            config = await SystemConfig.create({ key, value, description });
        }

        await logAdminAction(req.player.id, 'update_config', { key, value }, req);

        res.json({
            code: 200,
            message: '配置保存成功',
            data: config
        });
    } catch (error) {
        res.status(500).json({ message: '保存配置失败', error: error.message });
    }
});

/**
 * 获取服务器统计信息
 * GET /api/admin/stats
 */
router.get('/stats', auth, adminCheck, async (req, res) => {
    try {
        const totalPlayers = await Player.count();
        const adminCount = await Player.count({ where: { role: 'admin' } });
        const bannedCount = await Player.count({ where: { role: 'banned' } });

        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const onlinePlayers = await Player.count({
            where: {
                last_online: { [Op.gte]: fiveMinutesAgo }
            }
        });

        const realmStats = await Player.findAll({
            attributes: [
                'realm',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            group: ['realm'],
            order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']],
            limit: 10
        });

        res.json({
            code: 200,
            data: {
                total_players: totalPlayers,
                admin_count: adminCount,
                banned_count: bannedCount,
                online_players: Math.max(1, onlinePlayers),
                realm_distribution: realmStats,
                server_uptime: Math.floor(process.uptime())
            }
        });
    } catch (error) {
        res.status(500).json({ message: '获取统计信息失败', error: error.message });
    }
});

/**
 * 获取操作日志
 * GET /api/admin/logs
 */
router.get('/logs', auth, adminCheck, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = (page - 1) * limit;
        const adminId = req.query.adminId;
        const action = req.query.action;

        const whereClause = {};
        if (adminId) whereClause.admin_id = adminId;
        if (action) whereClause.action = action;

        const { count, rows } = await AdminLog.findAndCountAll({
            where: whereClause,
            limit,
            offset,
            order: [['createdAt', 'DESC']]
        });

        res.json({
            code: 200,
            data: {
                total: count,
                totalPages: Math.ceil(count / limit),
                currentPage: page,
                logs: rows
            }
        });
    } catch (error) {
        res.status(500).json({ message: '获取日志失败', error: error.message });
    }
});

/**
 * 删除玩家
 * DELETE /api/admin/players/:id
 */
router.delete('/players/:id', auth, adminCheck, async (req, res) => {
    try {
        const player = await Player.findByPk(req.params.id);

        if (!player) {
            return res.status(404).json({ message: '玩家不存在' });
        }

        if (player.role === 'admin') {
            return res.status(400).json({ message: '无法删除管理员账号' });
        }

        await Item.destroy({ where: { player_id: player.id } });
        await AdminLog.destroy({ where: { admin_id: player.id } });
        await player.destroy();

        await logAdminAction(req.player.id, 'delete_player', { target_id: req.params.id }, req);

        res.json({
            code: 200,
            message: '玩家删除成功'
        });
    } catch (error) {
        res.status(500).json({ message: '删除失败', error: error.message });
    }
});

module.exports = router;
