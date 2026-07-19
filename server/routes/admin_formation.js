/**
 * GM 后台阵法系统管理路由
 *
 * 提供以下接口：
 * 1. GET    /stats：获取阵法全局统计（学习人数、激活人数、最近学习记录）
 * 2. GET    /player/:playerId：查询指定玩家已学阵法列表
 * 3. POST   /grant：给玩家发放阵法（不消耗灵石，GM特权）
 * 4. DELETE /player/:playerId/:formationId：剥夺玩家阵法（强制遗忘）
 * 5. POST   /player/:playerId/activate：GM强制激活玩家阵法（不消耗灵石、无冷却）
 * 6. POST   /player/:playerId/deactivate：GM强制撤阵（无冷却）
 * 7. PUT    /config：热更新阵法全局配置（持续时间/冷却/熟练度参数等）
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作必须记录 admin_logs 表（操作人、操作类型、目标、详情）
 *
 * 对应玩法文档：第17章（战力、阵法与日常试刀）
 */
'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Player = require('../models/player');
const PlayerFormation = require('../models/playerFormation');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const FormationService = require('../game/services/FormationService');
const { infrastructure } = require('../modules');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 管理员权限中间件
 * 校验 req.player.role === 'admin'，否则拒绝访问
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 记录管理员操作日志（审计）
 * 注意：日志写入失败不阻塞主流程，仅打印告警
 * @param {number} adminId - 管理员ID
 * @param {string} action - 操作类型
 * @param {Object} details - 操作详情
 * @param {Object} req - 请求对象（用于获取 IP）
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            details: JSON.stringify(details),
            ip: req.ip || req.connection?.remoteAddress
        });
    } catch (error) {
        console.error('记录管理员日志失败:', error);
    }
}

/**
 * GET /api/admin/formation/stats
 * 获取阵法全局统计（学习人数、激活人数、最近学习记录）
 * 查询参数：?limit=100（最近学习记录条数，最多500）
 */
router.get('/stats', auth, adminCheck, async (req, res, next) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
        const stats = await FormationService.gmGetFormationStats(limit);
        res.json({ code: 200, data: stats });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/formation/player/:playerId
 * 查询指定玩家已学阵法列表
 */
router.get('/player/:playerId', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId, 10);
        if (!playerId || isNaN(playerId)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'playerId 必须为数字'
            });
        }

        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'active_formation_id', 'formation_activated_at', 'last_formation_deactivate_time']
        });
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        const formations = await PlayerFormation.findAll({
            where: { player_id: playerId },
            order: [['learned_at', 'ASC']]
        });

        // 组装响应：包含阵法配置详情
        const cfg = infrastructure.ConfigLoader.getConfig('formation_data') || { global: {}, formations: [] };
        const formationList = formations.map(pf => {
            const f = cfg.formations?.find(x => x.id === pf.formation_id);
            return {
                formation_id: pf.formation_id,
                formation_name: f?.name || pf.formation_id,
                category: f?.category,
                category_display: f ? (cfg.global.category_display_names?.[f.category] || f.category) : null,
                grade: f?.grade,
                grade_display: f ? (cfg.global.grade_display_names?.[f.grade] || f.grade) : null,
                proficiency: pf.proficiency,
                learned_at: pf.learned_at,
                is_active: player.active_formation_id === pf.formation_id
            };
        });

        res.json({
            code: 200,
            data: {
                player: {
                    id: player.id,
                    nickname: player.nickname,
                    realm: player.realm,
                    active_formation_id: player.active_formation_id,
                    formation_activated_at: player.formation_activated_at,
                    last_formation_deactivate_time: player.last_formation_deactivate_time
                },
                formations: formationList
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/formation/grant
 * 给玩家发放阵法（GM特权，不消耗灵石）
 * 请求体：{ player_id: number, formation_id: string }
 */
router.post('/grant', auth, adminCheck, async (req, res, next) => {
    try {
        const { player_id, formation_id } = req.body;
        if (!player_id || typeof player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'player_id 必填且必须为数字'
            });
        }
        if (!formation_id || typeof formation_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'formation_id 必填且必须为字符串'
            });
        }

        const result = await FormationService.gmGrantFormation(player_id, formation_id);
        if (result.success) {
            await logAdminAction(req.player.id, 'formation_grant', {
                player_id,
                formation_id,
                admin_message: result.message
            }, req);
        }
        res.json({
            code: 200,
            success: result.success,
            message: result.message,
            data: result.data || null,
            error_code: result.success ? undefined : (result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR)
        });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/admin/formation/player/:playerId/:formationId
 * 剥夺玩家阵法（强制遗忘）
 * 注意：若该阵法正在激活，需先撤阵
 */
router.delete('/player/:playerId/:formationId', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId, 10);
        const formationId = req.params.formationId;

        if (!playerId || isNaN(playerId)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'playerId 必须为数字'
            });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        // 若正在激活该阵法，先撤阵
        if (player.active_formation_id === formationId) {
            player.active_formation_id = null;
            player.formation_activated_at = null;
            await player.save();
        }

        // 删除学习记录
        const deleted = await PlayerFormation.destroy({
            where: { player_id: playerId, formation_id: formationId }
        });

        if (deleted === 0) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家未学习该阵法'
            });
        }

        await logAdminAction(req.player.id, 'formation_revoke', {
            player_id: playerId,
            formation_id: formationId,
            player_nickname: player.nickname
        }, req);

        res.json({
            code: 200,
            message: `已剥夺玩家 ${player.nickname} 的阵法：${formationId}`,
            data: { player_id: playerId, formation_id: formationId }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/formation/player/:playerId/activate
 * GM强制激活玩家阵法（不消耗灵石、无冷却）
 * 请求体：{ formation_id: string }
 */
router.post('/player/:playerId/activate', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId, 10);
        const { formation_id } = req.body;

        if (!playerId || isNaN(playerId)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'playerId 必须为数字'
            });
        }
        if (!formation_id || typeof formation_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'formation_id 必填且必须为字符串'
            });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        // 校验已学习
        const playerFormation = await PlayerFormation.findOne({
            where: { player_id: playerId, formation_id }
        });
        if (!playerFormation) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.BUSINESS_LOGIC_ERROR,
                message: '玩家未学习该阵法，无法激活'
            });
        }

        // GM 强制激活（不消耗灵石、无冷却）
        player.active_formation_id = formation_id;
        player.formation_activated_at = new Date();
        await player.save();

        await logAdminAction(req.player.id, 'formation_force_activate', {
            player_id: playerId,
            formation_id,
            player_nickname: player.nickname
        }, req);

        res.json({
            code: 200,
            message: `已强制激活玩家 ${player.nickname} 的阵法：${formation_id}`,
            data: {
                player_id: playerId,
                formation_id,
                activated_at: player.formation_activated_at
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/formation/player/:playerId/deactivate
 * GM强制撤阵（无冷却）
 */
router.post('/player/:playerId/deactivate', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId, 10);
        if (!playerId || isNaN(playerId)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'playerId 必须为数字'
            });
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            return res.status(404).json({
                code: 404,
                error_code: ErrorCodes.NOT_FOUND,
                message: '玩家不存在'
            });
        }

        if (!player.active_formation_id) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.BUSINESS_LOGIC_ERROR,
                message: '玩家当前无激活阵法'
            });
        }

        const deactivatedFormationId = player.active_formation_id;
        // GM 强制撤阵（无冷却，不设置 last_formation_deactivate_time）
        player.active_formation_id = null;
        player.formation_activated_at = null;
        await player.save();

        await logAdminAction(req.player.id, 'formation_force_deactivate', {
            player_id: playerId,
            formation_id: deactivatedFormationId,
            player_nickname: player.nickname
        }, req);

        res.json({
            code: 200,
            message: `已强制撤阵玩家 ${player.nickname} 的阵法：${deactivatedFormationId}`,
            data: { player_id: playerId, formation_id: deactivatedFormationId }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/admin/formation/config
 * 热更新阵法全局配置（持续时间/冷却/熟练度参数等）
 * 请求体：{ global: { active_duration_seconds?, deactivate_cooldown_seconds?, ... } }
 * 注意：此接口直接修改 formation_data.json 文件并触发热重载
 */
router.put('/config', auth, adminCheck, async (req, res, next) => {
    try {
        const { global: newGlobal } = req.body;
        if (!newGlobal || typeof newGlobal !== 'object') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '请求体必须包含 global 对象'
            });
        }

        const configPath = path.join(__dirname, '..', 'config', 'formation_data.json');
        const fileContent = fs.readFileSync(configPath, 'utf-8');
        const configData = JSON.parse(fileContent);

        // 合并配置（仅允许更新 global 字段，formations 列表不允许通过此接口修改）
        const oldGlobal = { ...configData.global };
        configData.global = { ...configData.global, ...newGlobal };

        // 写入文件
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf-8');

        // 触发热重载
        await infrastructure.ConfigLoader.hotUpdateConfig('formation_data');

        await logAdminAction(req.player.id, 'formation_config_update', {
            old_global: oldGlobal,
            new_global: configData.global
        }, req);

        res.json({
            code: 200,
            message: '阵法全局配置已更新并热重载',
            data: { global: configData.global }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
