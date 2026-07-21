/**
 * GM 后台妖兽入侵管理路由
 *
 * 提供妖兽入侵系统的 GM 管理接口（参考 xiuxian_game_guide.md 第16节 妖兽入侵）：
 *   1. GET    /metrics              - 统计指标（活跃事件数/总击杀数/总逃脱数）
 *   2. GET    /beasts               - 分页查询所有妖兽入侵事件（含已结束）
 *   3. GET    /config               - 获取当前妖兽入侵配置（含妖兽静态数据列表）
 *   4. POST   /spawn                - 手动开启妖兽入侵（body: beast_key, hours?）
 *   5. POST   /:invasionId/expire   - 强制结束事件（GM 介入）
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作记录 admin_logs 表（操作人/操作类型/目标/详情/IP）
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const BeastInvasion = require('../models/beastInvasion');
const BeastInvasionAttack = require('../models/beastInvasionAttack');
const BeastInvasionDonation = require('../models/beastInvasionDonation');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const BeastInvasionService = require('../game/services/BeastInvasionService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

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
 * GET /api/admin/beast-invasion/metrics
 * 统计指标
 */
router.get('/metrics', auth, adminCheck, async (req, res, next) => {
    try {
        // 当前活跃妖兽入侵事件数
        const activeCount = await BeastInvasion.count({
            where: { status: 'active' }
        });

        // 历史总击杀妖兽数
        const totalDefeated = await BeastInvasion.count({ where: { status: 'defeated' } });

        // 历史总逃脱妖兽数
        const totalEscaped = await BeastInvasion.count({ where: { status: 'escaped' } });

        // 历史总散去妖兽数（捐献未达标）
        const totalExpired = await BeastInvasion.count({ where: { status: 'expired' } });

        // 今日参与妖兽入侵的玩家数（去重）
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        const todayParticipants = await BeastInvasionAttack.count({
            where: {
                created_at: { [Op.between]: [todayStart, todayEnd] }
            },
            distinct: true,
            col: 'player_id'
        });

        // 今日总伤害（聚合）
        const todayDamageResult = await BeastInvasionAttack.findAll({
            where: {
                created_at: { [Op.between]: [todayStart, todayEnd] }
            },
            attributes: [
                [BeastInvasionAttack.sequelize.fn('SUM', BeastInvasionAttack.sequelize.col('damage')), 'total_damage']
            ],
            raw: true
        });
        const todayTotalDamage = todayDamageResult[0]?.total_damage?.toString() || '0';

        // 当前配置
        const cfg = BeastInvasionService.getBeastInvasionConfig();

        // 妖兽静态数据数量
        const beastsCount = BeastInvasionService.getAllBeastStaticData().length;

        res.json({
            code: 200,
            data: {
                active_count: activeCount,
                total_defeated: totalDefeated,
                total_escaped: totalEscaped,
                total_expired: totalExpired,
                today_participants: todayParticipants,
                today_total_damage: todayTotalDamage,
                beasts_count: beastsCount,
                config: {
                    enabled: cfg.enabled !== false,
                    donation_phase_minutes: cfg.donation_phase_minutes,
                    battle_phase_minutes: cfg.battle_phase_minutes,
                    attack_cooldown_seconds: cfg.attack_cooldown_seconds,
                    aggregation_window_ms: cfg.aggregation_window_ms,
                    max_attack_count_per_battle: cfg.max_attack_count_per_battle,
                    state_cleaner_interval_ms: cfg.state_cleaner_interval_ms
                }
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/beast-invasion/beasts
 * 分页查询所有妖兽入侵事件（含已结束）
 * query: status=active|defeated|escaped|expired（可选过滤），limit=20（最大100），offset=0
 */
router.get('/beasts', auth, adminCheck, async (req, res, next) => {
    try {
        const filter = {
            status: req.query.status,
            limit: parseInt(req.query.limit, 10) || 20,
            offset: parseInt(req.query.offset, 10) || 0
        };
        const result = await BeastInvasionService.listInvasions(filter);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/beast-invasion/config
 * 获取当前妖兽入侵配置（含妖兽静态数据列表）
 */
router.get('/config', auth, adminCheck, async (req, res, next) => {
    try {
        const cfg = BeastInvasionService.getBeastInvasionConfig();
        const beasts = BeastInvasionService.getAllBeastStaticData().map(b => ({
            beast_key: b.beast_key,
            name: b.name,
            description: b.description,
            realm_rank_min: b.realm_rank_min,
            base_hp: b.base_hp,
            base_atk: b.base_atk,
            base_def: b.base_def,
            base_speed: b.base_speed,
            counter_rate: b.counter_rate,
            counter_damage_multiplier: b.counter_damage_multiplier,
            donation_target: b.donation_target,
            donation_items: b.donation_items,
            rewards: b.rewards,
            skills: b.skills
        }));
        res.json({ code: 200, data: { config: cfg, beasts } });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/beast-invasion/spawn
 * 手动开启妖兽入侵
 * body: { beast_key: string, hours?: number }
 *  - beast_key: 妖兽配置键（必填，参考 beast_invasion_data.json）
 *  - hours: 自定义事件总时长（小时，可选，未传则使用配置默认 30+60 分钟）
 */
router.post('/spawn', auth, adminCheck, async (req, res, next) => {
    try {
        const { beast_key, hours } = req.body || {};

        if (!beast_key || typeof beast_key !== 'string') {
            throw new AppError('beast_key 不能为空且必须为字符串', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // hours 安全校验：若提供必须为正数（最多 24 小时，避免误操作）
        let customHours = null;
        if (hours !== undefined && hours !== null) {
            customHours = parseFloat(hours);
            if (isNaN(customHours) || customHours <= 0 || customHours > 24) {
                throw new AppError('hours 必须为正数且不超过 24 小时', 400, ErrorCodes.VALIDATION_ERROR);
            }
        }

        const result = await BeastInvasionService.spawnInvasion(beast_key, customHours);

        // 审计日志
        await logAdminAction(req.player.id, 'beast_invasion_spawn', {
            beast_key,
            invasion_id: result.invasion_id,
            beast_name: result.beast_name,
            hours: customHours
        }, req);

        res.json({ code: 200, data: result, message: '妖兽入侵事件已开启' });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/beast-invasion/:invasionId/expire
 * 强制结束妖兽入侵事件（GM 介入）
 */
router.post('/:invasionId/expire', auth, adminCheck, async (req, res, next) => {
    try {
        const invasionId = parseInt(req.params.invasionId, 10);
        if (isNaN(invasionId) || invasionId <= 0) {
            throw new AppError('事件ID必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await BeastInvasionService.expireInvasion(invasionId);

        // 审计日志
        await logAdminAction(req.player.id, 'beast_invasion_expire', {
            invasion_id: invasionId,
            beast_name: result.beast_name
        }, req);

        res.json({ code: 200, data: result, message: '妖兽入侵事件已被强制结束' });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
