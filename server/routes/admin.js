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
const RealmService = require('../game/core/RealmService');
const webSocketNotificationService = require('../game/services/WebSocketNotificationService');
// 用于 give-item 接口：通过 InventoryService.addItem 合并到已有记录，避免重复创建同 item_key 的记录
const InventoryService = require('../game/services/InventoryService');

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

        // 修复 B42：LifespanService 是单例实例（module.exports = new LifespanService()），
        // 实例上没有 SECONDS_PER_YEAR 静态 getter，导致 seconds = NaN，updateLifespan 直接返回不处理
        // 修复方案：直接从配置读取 seconds_per_year（与 LifespanService.SECONDS_PER_YEAR getter 逻辑一致）
        const gameBalanceConfig = require('../modules').infrastructure.ConfigLoader.getConfig('game_balance');
        const secondsPerYear = gameBalanceConfig?.lifespan?.seconds_per_year || 31536000;
        const seconds = years * secondsPerYear;
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

        // 修复：通过 InventoryService.addItem 合并到已有记录，避免直接 Item.create 创建重复 item_key 记录
        // 原实现 Item.create 会绕过容量检查并创建多条同 item_key 记录，导致背包数据混乱
        let itemRecordId = null;
        try {
            await InventoryService.addItem(playerId, itemId, quantity);
            // 查询刚写入的记录用于日志记录
            const created = await Item.findOne({
                where: { player_id: playerId, item_key: itemId },
                order: [['id', 'DESC']]
            });
            itemRecordId = created?.id || null;
        } catch (addError) {
            // 容量不足或其他业务错误，直接返回 400
            return res.status(400).json({
                code: 400,
                error_code: 'BUSINESS_LOGIC_ERROR',
                message: addError.message || '物品发放失败（可能储物袋容量不足）'
            });
        }

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
                item_id: itemRecordId,
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

        // 修复 B23：所有初始数值从 role_init 配置读取，禁止硬编码
        // 这样调整凡人初始属性/寿元/年龄只需改 config/role_init.json，无需改代码
        const roleInitConfig = configLoader.getConfig('role_init') || {};
        const initialAge = roleInitConfig.initialAge ?? 16;
        const initialLifespan = roleInitConfig.initialLifespan ?? 60;
        const initialSpiritStones = roleInitConfig.initialSpiritStones ?? 0;
        const initialAttrs = roleInitConfig.initialAttributes || {
            hp_max: 100, mp_max: 0, atk: 10, def: 5, speed: 10, sense: 10
        };

        player.realm = '凡人';
        // 修复 B45：同步重置 realm_rank，避免 realm 与 realm_rank 数据不一致
        // （否则 meetsRealmRequirement 会按 realm="凡人" 当低境界处理，
        //  但 realm_rank 仍是高境界数值，导致业务判断错乱）
        player.realm_rank = RealmService.getRealmRank('凡人');
        player.exp = '0';
        player.spirit_stones = String(initialSpiritStones);
        player.hp_current = BigInt(initialAttrs.hp_max || 100);
        player.mp_current = BigInt(initialAttrs.mp_max || 0);
        player.lifespan_current = initialAge;
        player.lifespan_max = initialLifespan;
        player.toxicity = 0;
        player.attributes = JSON.stringify(initialAttrs);
        // 同步重置死亡相关字段（避免重置后仍处于死亡状态）
        player.is_dead = false;
        player.death_reason = null;
        player.death_time = null;
        player.is_secluded = false;
        player.seclusion_start_time = null;
        player.seclusion_end_time = null;
        player.seclusion_mode = 'normal';
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
        // 修复 B45：同步更新 realm_rank，避免 realm 与 realm_rank 不一致
        // （admin 强制突破只改 realm 不改 realm_rank，会导致 meetsRealmRequirement
        //   按新 realm 名解析 rank 时与实际 realm_rank 数值不一致）
        player.realm_rank = RealmService.getRealmRank(targetRealm);
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

// ============================================================================
// 状态清理调度器配置管理（GM 可视化编辑 interval_ms / enable / auto_settle 等）
// ============================================================================

// game_balance.json 文件路径（用于读写 state_cleaner 段）
const GAME_BALANCE_CONFIG_FILE = path.join(__dirname, '../config/game_balance.json');
// 配置备份目录
const CONFIG_BACKUP_DIR = path.join(__dirname, '../config/backup');

/**
 * 备份 game_balance.json 到 backup 目录（带时间戳）
 * @param {string} filePath - 原配置文件路径
 * @returns {string|null} 备份文件路径，失败返回 null
 */
function backupGameBalanceConfig(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        if (!fs.existsSync(CONFIG_BACKUP_DIR)) {
            fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true });
        }
        const basename = path.basename(filePath, '.json');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(CONFIG_BACKUP_DIR, `${basename}_${timestamp}.json`);
        fs.copyFileSync(filePath, backupPath);
        return backupPath;
    } catch (err) {
        console.error(`备份 game_balance.json 失败:`, err);
        return null;
    }
}

/**
 * 校验单个状态的清理配置
 * @param {string} stateType - 状态类型（如 seclusion/combat/adventure/moving/ban）
 * @param {object} stateConfig - 待校验配置
 * @throws {Error} 校验失败时抛出错误
 */
function validateStateCleanerConfig(stateType, stateConfig) {
    if (!stateConfig || typeof stateConfig !== 'object') {
        throw new Error(`状态 ${stateType} 配置格式错误：必须为对象`);
    }
    // interval_ms: 整数，1-3600000ms（1ms~1小时），低于 1000ms 会被服务端兜底为 1000ms
    if (stateConfig.interval_ms !== undefined) {
        const v = Number(stateConfig.interval_ms);
        if (!Number.isInteger(v) || v < 1 || v > 3600000) {
            throw new Error(`状态 ${stateType} 的 interval_ms 必须为整数且在 1-3600000 之间`);
        }
    }
    // enable: 布尔
    if (stateConfig.enable !== undefined && typeof stateConfig.enable !== 'boolean') {
        throw new Error(`状态 ${stateType} 的 enable 必须为布尔值`);
    }
    // auto_settle: 布尔
    if (stateConfig.auto_settle !== undefined && typeof stateConfig.auto_settle !== 'boolean') {
        throw new Error(`状态 ${stateType} 的 auto_settle 必须为布尔值`);
    }
    // auto_complete: 布尔
    if (stateConfig.auto_complete !== undefined && typeof stateConfig.auto_complete !== 'boolean') {
        throw new Error(`状态 ${stateType} 的 auto_complete 必须为布尔值`);
    }
    // log_each: 布尔
    if (stateConfig.log_each !== undefined && typeof stateConfig.log_each !== 'boolean') {
        throw new Error(`状态 ${stateType} 的 log_each 必须为布尔值`);
    }
}

/**
 * GET /api/admin/state-cleaner/config
 * 获取状态清理调度器当前配置
 *
 * 返回内容：
 *   - masterTickMs: 主调度间隔（取所有状态中最小 interval_ms）
 *   - enabled: 调度器总开关
 *   - batchSize: 单次扫描批量大小
 *   - states: 各状态配置详情（含 displayName/intervalMs/enable/autoSettle/autoComplete/logEach/lastCleanedAt）
 */
router.get('/state-cleaner/config', auth, adminCheck, async (req, res) => {
    try {
        const StateCleanerService = require('../game/services/StateCleanerService');
        const status = StateCleanerService.getSchedulerStatus();
        res.json({
            code: 200,
            data: status
        });
    } catch (error) {
        console.error('获取状态清理配置失败:', error);
        res.status(500).json({ code: 500, message: '获取配置失败', error: error.message });
    }
});

/**
 * POST /api/admin/state-cleaner/config
 * 更新状态清理调度器配置（热重载，无需重启服务）
 *
 * 入参（部分更新，仅传需要修改的字段）：
 *   {
 *     "enable": true,                  // 可选，调度器总开关
 *     "batch_size": 100,               // 可选，单次扫描批量大小（1-1000）
 *     "states": {                      // 可选，各状态配置
 *       "seclusion": {
 *         "interval_ms": 5000,          // 清理间隔（毫秒）
 *         "enable": true,               // 是否启用该状态清理
 *         "auto_settle": true,          // 是否自动结算
 *         "log_each": false             // 是否记录每次清理日志
 *       },
 *       "combat": { "interval_ms": 5000 },
 *       "adventure": { "interval_ms": 5000, "auto_complete": false },
 *       "moving": { "interval_ms": 5000 },
 *       "ban": { "interval_ms": 5000 }
 *     }
 *   }
 *
 * 响应：
 *   - code: 200 表示成功
 *   - data: { masterTickMs, reloaded: true, message }
 *   - 修改后立即调用 reloadScheduler() 热重载定时器，无需重启服务
 */
router.post('/state-cleaner/config', auth, adminCheck, async (req, res) => {
    try {
        const { enable, batch_size, states } = req.body || {};

        // 1. 校验顶层参数
        if (enable !== undefined && typeof enable !== 'boolean') {
            return res.status(400).json({ code: 400, message: 'enable 必须为布尔值' });
        }
        if (batch_size !== undefined) {
            const v = Number(batch_size);
            if (!Number.isInteger(v) || v < 1 || v > 1000) {
                return res.status(400).json({ code: 400, message: 'batch_size 必须为整数且在 1-1000 之间' });
            }
        }

        // 2. 校验 states 各子项
        if (states !== undefined) {
            if (!states || typeof states !== 'object') {
                return res.status(400).json({ code: 400, message: 'states 必须为对象' });
            }
            // 允许的状态类型白名单（与 StateRegistry 中注册的一致）
            const allowedStates = ['seclusion', 'combat', 'adventure', 'moving', 'ban'];
            for (const stateType of Object.keys(states)) {
                if (!allowedStates.includes(stateType)) {
                    return res.status(400).json({
                        code: 400,
                        message: `未知状态类型: ${stateType}，允许: ${allowedStates.join(', ')}`
                    });
                }
                validateStateCleanerConfig(stateType, states[stateType]);
            }
        }

        // 3. 备份原配置
        backupGameBalanceConfig(GAME_BALANCE_CONFIG_FILE);

        // 4. 读取现有配置
        const oldConfig = JSON.parse(fs.readFileSync(GAME_BALANCE_CONFIG_FILE, 'utf-8'));
        if (!oldConfig.state_cleaner || typeof oldConfig.state_cleaner !== 'object') {
            oldConfig.state_cleaner = {};
        }
        const oldStateCleaner = oldConfig.state_cleaner;

        // 5. 应用顶层更新
        const changes = [];
        if (enable !== undefined) {
            oldStateCleaner.enable = enable;
            changes.push(`enable=${enable}`);
        }
        if (batch_size !== undefined) {
            oldStateCleaner.batch_size = Number(batch_size);
            changes.push(`batch_size=${batch_size}`);
        }

        // 6. 应用各状态更新（字段白名单过滤）
        if (states) {
            const allowedFields = ['interval_ms', 'enable', 'auto_settle', 'auto_complete', 'log_each'];
            for (const [stateType, stateConfig] of Object.entries(states)) {
                if (!oldStateCleaner[stateType] || typeof oldStateCleaner[stateType] !== 'object') {
                    oldStateCleaner[stateType] = {};
                }
                for (const field of allowedFields) {
                    if (stateConfig[field] !== undefined) {
                        // 数值字段转 Number，布尔字段保持布尔
                        const value = (field === 'interval_ms' || field === 'batch_size')
                            ? Number(stateConfig[field])
                            : stateConfig[field];
                        oldStateCleaner[stateType][field] = value;
                        changes.push(`${stateType}.${field}=${value}`);
                    }
                }
            }
        }

        // 7. 写回配置文件
        oldConfig.lastUpdated = new Date().toISOString();
        fs.writeFileSync(GAME_BALANCE_CONFIG_FILE, JSON.stringify(oldConfig, null, 2), 'utf-8');

        // 8. 热更新配置缓存（ConfigLoader）
        await configLoader.hotUpdateConfig('game_balance');

        // 9. 热重载调度器（清除旧定时器，以新间隔启动）
        const StateCleanerService = require('../game/services/StateCleanerService');
        const reloadResult = await StateCleanerService.reloadScheduler();

        // 10. 记录 GM 操作日志
        await AdminLog.create({
            admin_id: req.player.id,
            admin_name: req.player.nickname,
            action: 'update_state_cleaner_config',
            target_type: 'system',
            target_id: null,
            details: JSON.stringify({
                changes,
                masterTickMs: reloadResult.masterTickMs
            }),
            ip_address: req.ip
        });

        console.log(`[Admin] GM ${req.player.username} 更新状态清理配置: ${changes.join(', ')}`);

        res.json({
            code: 200,
            message: '配置已更新并热重载',
            data: {
                reloaded: true,
                masterTickMs: reloadResult.masterTickMs,
                changes,
                message: reloadResult.message
            }
        });
    } catch (error) {
        console.error('更新状态清理配置失败:', error);
        res.status(500).json({
            code: 500,
            message: '更新配置失败: ' + error.message,
            error: error.message
        });
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

/**
 * 合并玩家重复物品记录（运维工具）
 * POST /api/admin/merge-duplicate-items
 *
 * 业务场景：
 *   早期 give-item 接口直接 Item.create 创建新记录，未合并同 item_key 的已有记录，
 *   导致同一物品出现多条 Item 记录，引发背包容量计算异常、显示混乱等问题。
 *   本接口扫描指定玩家的物品表，对同 item_key 的多条记录合并为一条，并清理空记录。
 *
 * 权限：管理员（auth + adminCheck）
 *
 * 请求体：
 *   - playerId: 目标玩家 ID（必填）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
router.post('/merge-duplicate-items', auth, adminCheck, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const { playerId } = req.body;
        if (!playerId) {
            return res.status(400).json({ code: 400, message: 'playerId 不能为空' });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({ code: 404, message: '目标玩家不存在' });
        }

        // 查询该玩家所有物品记录，按 item_key 分组
        const allItems = await Item.findAll({
            where: { player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        const groupedByKey = {};
        for (const it of allItems) {
            if (!groupedByKey[it.item_key]) groupedByKey[it.item_key] = [];
            groupedByKey[it.item_key].push(it);
        }

        let mergedCount = 0;       // 合并的记录数
        let deletedCount = 0;      // 删除的空记录数
        let totalQuantityNormalized = 0;  // 规范化后的总数量

        for (const [itemKey, records] of Object.entries(groupedByKey)) {
            if (records.length <= 1) {
                // 单条记录：但仍需检查 quantity<=0 的情况
                if (records.length === 1 && records[0].quantity <= 0) {
                    await records[0].destroy({ transaction: t });
                    deletedCount += 1;
                } else if (records.length === 1) {
                    totalQuantityNormalized += records[0].quantity;
                }
                continue;
            }

            // 多条记录：累加数量到第一条，删除其余记录
            const firstRecord = records[0];
            let totalQty = 0;
            for (const r of records) {
                totalQty += r.quantity;
            }

            // 删除非首条记录
            for (let i = 1; i < records.length; i++) {
                await records[i].destroy({ transaction: t });
                mergedCount += 1;
            }

            // 更新首条记录的 quantity
            if (totalQty <= 0) {
                // 总数量 <= 0，删除首条记录
                await firstRecord.destroy({ transaction: t });
                deletedCount += 1;
            } else {
                firstRecord.quantity = totalQty;
                await firstRecord.save({ transaction: t });
                totalQuantityNormalized += totalQty;
            }
        }

        await logAdminAction(req.player.id, 'merge_duplicate_items', {
            target_id: playerId,
            merged_count: mergedCount,
            deleted_count: deletedCount,
            total_quantity_after: totalQuantityNormalized
        }, req);

        await t.commit();

        res.json({
            code: 200,
            message: `合并完成：合并 ${mergedCount} 条重复记录，删除 ${deletedCount} 条空记录`,
            data: {
                player_id: playerId,
                merged_count: mergedCount,
                deleted_count: deletedCount,
                total_quantity_after: totalQuantityNormalized
            }
        });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        res.status(500).json({
            code: 500,
            message: '合并失败',
            error: error.message
        });
    }
});

module.exports = router;
