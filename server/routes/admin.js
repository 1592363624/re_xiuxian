/**
 * 管理员路由
 * 提供GM管理功能，包括玩家管理、系统配置、物品发放等
 */
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const Player = require('../models/player');
const SystemConfig = require('../models/system_config');
const AdminLog = require('../models/admin_log');
const Item = require('../models/item');
const auth = require('../middleware/auth');
// 修复：统一通过 modules/index.js 导出引用 ConfigLoader，避免路径混乱
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const fs = require('fs');
const path = require('path');

const LifespanService = require('../game/core/LifespanService');
const webSocketNotificationService = require('../game/services/WebSocketNotificationService');

const SECLUSION_CONFIG_FILE = path.join(__dirname, '../config/seclusion.json');

const SECLUSION_CONFIG_KEYS = [
    'seclusion_cooldown',
    'seclusion_exp_rate',
    'cultivate_interval',
    'deep_seclusion_exp_rate',
    'deep_seclusion_interval'
];

/**
 * 保存闭关配置到JSON文件
 */
function saveSeclusionConfig(key, value) {
    try {
        let config = { settings: {} };
        if (fs.existsSync(SECLUSION_CONFIG_FILE)) {
            const content = fs.readFileSync(SECLUSION_CONFIG_FILE, 'utf-8');
            config = JSON.parse(content);
        }
        if (!config.settings[key]) {
            config.settings[key] = { value: value, displayName: key };
        } else {
            config.settings[key].value = value;
        }
        config.lastUpdated = new Date().toISOString();
        fs.writeFileSync(SECLUSION_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
        configLoader.hotUpdateConfig('seclusion');
        return true;
    } catch (err) {
        console.error('保存闭关配置失败:', err);
        return false;
    }
}

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
            return res.status(400).json({ code: 400, message: '无效的时间参数 (years)' });
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
            code: 200,
            message, 
            data: {
                userDied,
                dead_count: result?.deadCount || 0
            }
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '时间加速失败', error: error.message });
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
        const sortBy = req.query.sortBy || 'last_online';
        const sortOrder = (req.query.sortOrder || 'DESC').toUpperCase();

        const allowedSortFields = ['id', 'username', 'nickname', 'realm', 'lifespan_current', 'createdAt', 'last_online', 'total_online_time'];
        const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'last_online';
        const validSortOrder = ['ASC', 'DESC'].includes(sortOrder) ? sortOrder : 'DESC';

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
            order: [[validSortBy, validSortOrder]]
        });

        // 后端权威判断在线状态：以 WebSocket 连接表（onlineUsers）为准
        // 避免前端用"5 分钟阈值"猜测在线状态导致误判
        const players = rows.map(p => {
            const data = p.toJSON();
            data.is_online = webSocketNotificationService.isPlayerOnline(p.id);
            return data;
        });

        res.json({
            code: 200,
            players,
            currentPage: page,
            totalPages: Math.ceil(count / limit),
            total: count
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取玩家列表失败', error: error.message });
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
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        res.json({
            code: 200,
            data: player
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取玩家详情失败', error: error.message });
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
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        // 字段白名单，防止恶意字段更新
        const allowedFields = [
            'nickname', 'role', 'realm', 'exp', 'spirit_stones',
            'hp_current', 'hp_max', 'mp_current', 'mp_max',
            'attributes', 'lifespan_current', 'lifespan_max',
            'is_secluded', 'seclusion_end_time', 'is_banned',
            'ban_reason', 'ban_expire_time'
        ];

        const updates = {};
        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        });

        const oldData = player.toJSON();
        await player.update(updates);
        
        await logAdminAction(req.player.id, 'modify_player', { 
            target_id: player.id, 
            changes: Object.keys(updates) 
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(player.id, 'gm_modify', {
            modifiedFields: Object.keys(updates)
        });

        res.json({ 
            code: 200,
            message: '玩家信息更新成功', 
            player 
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '更新失败', error: error.message });
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
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        if (player.role === 'admin') {
            return res.status(400).json({ code: 400, message: '无法封禁管理员账号' });
        }

        const bannedUntil = days > 0 
            ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) 
            : null;

        player.role = 'banned';
        player.ban_expire_time = bannedUntil;
        player.ban_reason = reason;
        await player.save();

        await logAdminAction(req.player.id, 'ban_player', {
            target_id: player.id,
            reason,
            days,
            ban_expire_time: bannedUntil
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(player.id, 'gm_ban', {
            reason,
            bannedUntil
        });

        res.json({
            code: 200,
            message: days > 0 ? `玩家已封禁，解封时间：${bannedUntil.toLocaleString()}` : '玩家已永久封禁'
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '封禁失败', error: error.message });
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
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        if (player.role !== 'banned') {
            return res.status(400).json({ code: 400, message: '该玩家未被封禁' });
        }

        player.role = 'user';
        player.ban_expire_time = null;
        player.ban_reason = null;
        await player.save();

        await logAdminAction(req.player.id, 'unban_player', { target_id: player.id }, req);

        webSocketNotificationService.notifyPlayerUpdate(player.id, 'gm_unban');

        res.json({
            code: 200,
            message: '玩家已解封'
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '解封失败', error: error.message });
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
            return res.status(400).json({ code: 400, message: '参数错误' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ code: 404, message: '目标玩家不存在' });
        }

        const item = await Item.create({
            player_id: playerId,
            item_key: itemId,
            quantity
        });

        await logAdminAction(req.player.id, 'give_item', {
            target_id: playerId,
            item_id: itemId,
            quantity
        }, req);

        // 推送物品发放通知，目标玩家前端据此刷新背包数据
        try {
            webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_give_item', {
                item_key: itemId,
                quantity
            });
            webSocketNotificationService.sendToPlayer(playerId, {
                type: 'gm_give_item',
                title: '收到物品',
                content: `管理员向你发放了 ${quantity} 个 ${itemId}`,
                priority: 'info'
            });
        } catch (e) {
            console.warn('[Admin] 推送物品发放通知失败:', e.message);
        }

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
            return res.status(400).json({ code: 400, message: '参数错误' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ code: 404, message: '目标玩家不存在' });
        }

        player.spirit_stones = (BigInt(player.spirit_stones) + BigInt(amount)).toString();
        await player.save();

        await logAdminAction(req.player.id, 'give_spirit_stones', {
            target_id: playerId,
            amount
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_give_spirit_stones', {
            amount
        });

        res.json({
            code: 200,
            message: '灵石发放成功',
            data: {
                current_balance: player.spirit_stones
            }
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '发放失败', error: error.message });
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
            return res.status(400).json({ code: 400, message: '参数错误' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ code: 404, message: '目标玩家不存在' });
        }

        player.exp = (BigInt(player.exp) + BigInt(amount)).toString();
        await player.save();

        await logAdminAction(req.player.id, 'add_exp', {
            target_id: playerId,
            amount
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_add_exp', {
            amount
        });

        res.json({
            code: 200,
            message: '修为增加成功',
            data: {
                current_exp: player.exp
            }
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '增加失败', error: error.message });
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
            return res.status(404).json({ code: 404, message: '玩家不存在' });
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

        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_reset', {
            keepItems
        });

        res.json({
            code: 200,
            message: '玩家已重置为初始状态'
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '重置失败', error: error.message });
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
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        player.realm = targetRealm;
        await player.save();

        await logAdminAction(req.player.id, 'force_breakthrough', {
            target_id: playerId,
            target_realm: targetRealm
        }, req);

        webSocketNotificationService.notifyPlayerUpdate(playerId, 'gm_breakthrough', {
            newRealm: targetRealm
        });

        res.json({
            code: 200,
            message: `已将玩家境界修改为 ${targetRealm}`,
            data: {
                new_realm: player.realm
            }
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '操作失败', error: error.message });
    }
});

/**
 * 获取系统配置
 * GET /api/admin/config
 * 合并JSON文件和数据库的配置
 */
router.get('/config', auth, adminCheck, async (req, res) => {
    try {
        const dbConfigs = await SystemConfig.findAll();
        const dbConfigMap = new Map(dbConfigs.map(c => [c.key, c]));

        const result = [];
        
        // 添加数据库配置
        for (const config of dbConfigs) {
            result.push({
                key: config.key,
                value: config.value,
                description: config.description,
                source: 'database'
            });
        }

        // 添加JSON配置（如果不在数据库中）
        if (configLoader && configLoader.hasConfig('seclusion')) {
            try {
                const seclusionConfig = configLoader.getConfig('seclusion');
                if (seclusionConfig && seclusionConfig.settings) {
                    for (const [key, setting] of Object.entries(seclusionConfig.settings)) {
                        if (!dbConfigMap.has(key)) {
                            result.push({
                                key: key,
                                value: setting.value,
                                description: setting.displayName || '',
                                source: 'json'
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('获取闭关配置文件失败:', err);
            }
        }

        res.json({
            code: 200,
            data: result
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '获取配置失败', error: error.message });
    }
});

/**
 * 保存系统配置
 * POST /api/admin/config
 * 闭关相关配置保存到JSON文件，其他配置保存到数据库
 */
router.post('/config', auth, adminCheck, async (req, res) => {
    try {
        const { key, value, description } = req.body;
        
        if (!key || value === undefined) {
            return res.status(400).json({ code: 400, message: '配置键和值不能为空' });
        }

        // 判断是否是闭关相关配置
        if (SECLUSION_CONFIG_KEYS.includes(key)) {
            const success = saveSeclusionConfig(key, value);
            if (success) {
                await logAdminAction(req.player.id, 'update_config', { key, value, target: 'json' }, req);
                res.json({
                    code: 200,
                    message: '配置保存成功（已写入JSON文件）',
                    data: { key, value, source: 'json' }
                });
            } else {
                res.status(500).json({ code: 500, message: '保存配置失败' });
            }
            return;
        }

        // 其他配置保存到数据库（向后兼容）
        let config = await SystemConfig.findByPk(key);
        if (config) {
            config.value = value;
            if (description) config.description = description;
            await config.save();
        } else {
            config = await SystemConfig.create({ key, value, description });
        }

        await logAdminAction(req.player.id, 'update_config', { key, value, target: 'database' }, req);

        res.json({
            code: 200,
            message: '配置保存成功',
            data: config
        });
    } catch (error) {
        res.status(500).json({ code: 500, message: '保存配置失败', error: error.message });
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

        await Item.destroy({ where: { player_id: req.params.id } });
        await AdminLog.destroy({ where: { admin_id: player.id } });

        webSocketNotificationService.notifyPlayerUpdate(req.params.id, 'gm_delete');

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

/**
 * 删除通知
 * DELETE /api/admin/notifications/:id
 */
router.delete('/notifications/:id', auth, adminCheck, async (req, res) => {
    try {
        const { id } = req.params;
        
        const SystemNotification = require('../models/system_notification');
        const notification = await SystemNotification.findByPk(id);
        
        if (!notification) {
            return res.status(404).json({ message: '通知不存在' });
        }

        await notification.destroy();

        await logAdminAction(req.player.id, 'delete_notification', {
            notification_id: id,
            notification_title: notification.title
        }, req);

        res.json({
            code: 200,
            message: '通知删除成功'
        });
    } catch (error) {
        res.status(500).json({ message: '删除失败', error: error.message });
    }
});

/**
 * 获取状态清理调度器监控指标
 * GET /api/admin/state-cleaner/metrics
 *
 * 返回 StateCleanerService 的运行指标，用于运维监控：
 *   - lastRunAt: 上次执行时间
 *   - lastRunDurationMs: 上次执行耗时
 *   - totalRuns: 累计执行次数
 *   - totalErrors: 累计错误次数
 *   - errorRate: 错误率
 *   - totalItemsCleaned: 累计清理项数
 *   - registeredStates: 已注册的状态处理器列表
 *
 * 当 errorRate > 0.1 时建议告警（清理失败率超 10%）
 */
router.get('/state-cleaner/metrics', auth, adminCheck, async (req, res) => {
    try {
        const StateCleanerService = require('../game/services/StateCleanerService');
        const metrics = StateCleanerService.getMetrics();
        res.json({
            code: 200,
            data: metrics,
            // 健康度评估：错误率 < 5% 为 healthy，5%-10% 为 warning，> 10% 为 critical
            health: metrics.errorRate < 0.05 ? 'healthy' : (metrics.errorRate < 0.1 ? 'warning' : 'critical')
        });
    } catch (error) {
        res.status(500).json({ message: '获取监控指标失败', error: error.message });
    }
});

/**
 * 手动触发一次状态清理扫描
 * POST /api/admin/state-cleaner/run
 *
 * 用于运维手动触发清理（如修复线上遗留状态后立即清理）
 */
router.post('/state-cleaner/run', auth, adminCheck, async (req, res) => {
    try {
        const StateCleanerService = require('../game/services/StateCleanerService');
        // GM 手动触发时强制所有状态执行，忽略 per-state interval
        const stats = await StateCleanerService.runCleanup({ forceAll: true });
        // 记录 GM 操作日志
        await AdminLog.create({
            admin_id: req.player.id,
            admin_name: req.player.nickname,
            action: 'manual_state_cleanup',
            target_type: 'system',
            target_id: null,
            details: JSON.stringify({ stats }),
            ip_address: req.ip
        });
        res.json({
            code: 200,
            message: '状态清理已触发',
            data: stats
        });
    } catch (error) {
        res.status(500).json({ message: '触发清理失败', error: error.message });
    }
});

/**
 * 获取玩家状态转移日志
 * GET /api/admin/state-logs
 *
 * 查询参数：
 *   - player_id: 按玩家ID筛选（可选）
 *   - action: 按动作类型筛选（enter/exit/transition/auto_clean/error）
 *   - state_type: 按状态类型筛选（seclusion/combat/adventure/moving/ban）
 *   - page: 页码（默认1）
 *   - limit: 每页条数（默认20，最大100）
 *
 * 用于运维追溯玩家状态变更历史，排查异常状态问题
 */
router.get('/state-logs', auth, adminCheck, async (req, res) => {
    try {
        const StateLogService = require('../game/services/StateLogService');
        const playerId = req.query.player_id ? parseInt(req.query.player_id) : undefined;
        const action = req.query.action || undefined;
        const stateType = req.query.state_type || undefined;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        const result = await StateLogService.queryLogs({
            playerId,
            action,
            stateType,
            page,
            limit
        });

        res.json({
            code: 200,
            data: {
                logs: result.logs.map(log => log.toJSON()),
                total: result.total,
                currentPage: result.currentPage,
                totalPages: result.totalPages
            }
        });
    } catch (error) {
        res.status(500).json({ message: '获取状态日志失败', error: error.message });
    }
});

module.exports = router;
