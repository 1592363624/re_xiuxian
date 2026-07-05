/**
 * 装备管理路由（GM 后台）
 *
 * 提供以下接口：
 *   1. GET    /api/admin/equipment/list                    - 查询所有玩家装备列表（分页，支持按玩家ID/昵称筛选）
 *   2. GET    /api/admin/equipment/:playerId               - 查询指定玩家所有装备
 *   3. PUT    /api/admin/equipment/:playerId/record/:id    - 修改装备记录（耐久/祭炼等级/排序/本命标记）
 *   4. POST   /api/admin/equipment/:playerId/record/:id/reset - 重置装备记录（恢复初始耐久/祭炼等级清零/取消本命）
 *   5. POST   /api/admin/equipment/:playerId/repair-all    - GM 一键修理所有装备（无消耗）
 *   6. DELETE /api/admin/equipment/:playerId/record/:id     - 删除装备记录（强制卸下）
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证 + admin 权限（auth + adminCheck 双层中间件）
 *   - 业务逻辑直接基于 PlayerEquipment / Player 模型实现，使用事务保证数据一致性
 *   - 所有操作记录到 admin_logs 表，便于审计追溯
 *   - 字段值范围校验（耐久 0~999、祭炼等级 0~15、排序 0~99）防越权写入
 *   - 使用 AppError + ErrorCodes 抛错，由全局 errorHandler 统一处理
 *   - 阈值（分页大小、字段范围）从 game_balance 读取，不硬编码
 *
 * 路由顺序说明：
 *   静态路径（/list）定义在动态参数路由 /:playerId 之前，避免被 /:playerId 误匹配。
 */

const express = require('express');
const router = express.Router();

// Sequelize 操作符，用于构造 OR 查询
const { Op } = require('sequelize');

// 中间件、模型与基础设施
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const Player = require('../models/player');
const PlayerEquipment = require('../models/playerEquipment');
const sequelize = require('../config/database');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 通过 ConfigLoader 获取 game_balance 配置（支持热更新，避免硬编码阈值）
const configLoader = infrastructure.ConfigLoader;

/**
 * 读取 game_balance 配置（用于分页大小、字段范围校验）
 * @returns {Object} game_balance 配置对象
 */
function getGameBalanceConfig() {
    return configLoader?.getConfig('game_balance') || {};
}

/**
 * GM 权限校验中间件
 * 检查 req.player.role === 'admin'
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 写入管理员操作日志（封装，避免代码重复）
 * 日志写入失败不应阻塞主流程，仅打印警告
 * @param {Object} params - { adminId, action, targetId, detail, req }
 */
async function logAdminAction({ adminId, action, targetId = null, detail = '', req = null }) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action: action,
            target_id: targetId,
            details: JSON.stringify({ detail }),
            ip: req?.ip || req?.connection?.remoteAddress || null
        });
    } catch (e) {
        console.error('[admin_equipment] 写入操作日志失败:', e.message);
    }
}

/**
 * 查询所有玩家装备列表（分页）
 * GET /api/admin/equipment/list?keyword=&slot=&is_benming=&page=&pageSize=
 *
 * 查询参数：
 *   - keyword: 玩家 ID 或昵称（模糊匹配）
 *   - slot: 装备槽位筛选（weapon/armor/accessory/boots/dharma）
 *   - is_benming: 是否本命法器（true/false）
 *   - page: 页码（默认 1）
 *   - pageSize: 每页数量（默认 20，上限 100）
 */
router.get('/list', auth, adminCheck, async (req, res, next) => {
    try {
        const gameBalance = getGameBalanceConfig();
        const maxPageSize = gameBalance?.admin?.max_page_size || 100;
        const defaultPageSize = gameBalance?.admin?.default_page_size || 20;

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(maxPageSize, Math.max(1, parseInt(req.query.pageSize, 10) || defaultPageSize));
        const { keyword, slot, is_benming } = req.query;

        // 构造查询条件
        const where = {};
        if (slot) where.slot = slot;
        if (is_benming === 'true' || is_benming === 'false') {
            where.is_benming = is_benming === 'true';
        }

        // 关联玩家查询（按玩家 ID 或昵称筛选）
        const playerWhere = {};
        if (keyword) {
            // 数字则按 ID 匹配，否则按昵称模糊匹配
            const isNumeric = /^\d+$/.test(keyword);
            playerWhere[isNumeric ? 'id' : 'nickname'] = isNumeric
                ? parseInt(keyword, 10)
                : { [Op.like]: `%${keyword}%` };
        }

        // 查询装备（关联玩家）
        const { rows, count } = await PlayerEquipment.findAndCountAll({
            where,
            include: [{
                model: Player,
                as: 'player',
                where: playerWhere,
                attributes: ['id', 'nickname', 'realm', 'realm_rank'],
                required: true
            }],
            order: [['createdAt', 'DESC']],
            limit: pageSize,
            offset: (page - 1) * pageSize,
            subQuery: false
        }).catch(err => {
            // 关联可能未定义，回退到不关联查询
            console.warn('[admin_equipment] 关联查询失败，回退到不关联查询:', err.message);
            return PlayerEquipment.findAndCountAll({
                where,
                order: [['createdAt', 'DESC']],
                limit: pageSize,
                offset: (page - 1) * pageSize
            });
        });

        // 如果不关联查询且有关键字，需要手工过滤
        let filteredRows = rows;
        if (keyword && !rows[0]?.player) {
            const playerIds = (await Player.findAll({
                where: playerWhere,
                attributes: ['id']
            })).map(p => p.id);
            filteredRows = rows.filter(r => playerIds.includes(r.player_id));
        }

        res.json({
            code: 200,
            data: {
                list: filteredRows,
                total: count,
                page,
                pageSize
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 查询指定玩家所有装备
 * GET /api/admin/equipment/:playerId
 */
router.get('/:playerId', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId, 10);
        if (!playerId) {
            throw new AppError('无效的玩家 ID', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查询玩家基本信息
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank', 'spirit_stones']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询玩家所有装备
        const equipments = await PlayerEquipment.findAll({
            where: { player_id: playerId },
            order: [['sort_order', 'ASC'], ['createdAt', 'DESC']]
        });

        res.json({
            code: 200,
            data: {
                player,
                equipments,
                count: equipments.length
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * 修改装备记录
 * PUT /api/admin/equipment/:playerId/record/:id
 * body: { durability?, max_durability?, refine_level?, sort_order?, is_benming?, is_summoned?, spirit_power? }
 *
 * 字段范围校验：
 *   - durability: 0~999
 *   - max_durability: 1~999
 *   - refine_level: 0~15
 *   - sort_order: 0~99
 *   - spirit_power: 0~9999
 */
router.put('/:playerId/record/:id', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId, 10);
        const recordId = parseInt(req.params.id, 10);
        if (!playerId || !recordId) {
            throw new AppError('无效的玩家 ID 或记录 ID', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 字段范围校验
        const gameBalance = getGameBalanceConfig();
        const maxRefineLevel = gameBalance?.equipment?.refine?.max_level ?? 15;
        const {
            durability, max_durability, refine_level, sort_order, is_benming, is_summoned, spirit_power
        } = req.body;

        if (durability !== undefined && (typeof durability !== 'number' || durability < 0 || durability > 999)) {
            throw new AppError('耐久度范围为 0~999', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (max_durability !== undefined && (typeof max_durability !== 'number' || max_durability < 1 || max_durability > 999)) {
            throw new AppError('最大耐久度范围为 1~999', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (refine_level !== undefined && (typeof refine_level !== 'number' || refine_level < 0 || refine_level > maxRefineLevel)) {
            throw new AppError(`祭炼等级范围为 0~${maxRefineLevel}`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (sort_order !== undefined && (typeof sort_order !== 'number' || sort_order < 0 || sort_order > 99)) {
            throw new AppError('排序值范围为 0~99', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (spirit_power !== undefined && (typeof spirit_power !== 'number' || spirit_power < 0 || spirit_power > 9999)) {
            throw new AppError('法力值范围为 0~9999', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查询装备记录（加锁）
        const equipment = await PlayerEquipment.findOne({
            where: { id: recordId, player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!equipment) {
            throw new AppError('装备记录不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 应用变更
        const changes = {};
        if (durability !== undefined) { equipment.durability = durability; changes.durability = durability; }
        if (max_durability !== undefined) { equipment.max_durability = max_durability; changes.max_durability = max_durability; }
        if (refine_level !== undefined) { equipment.refine_level = refine_level; changes.refine_level = refine_level; }
        if (sort_order !== undefined) { equipment.sort_order = sort_order; changes.sort_order = sort_order; }
        if (is_benming !== undefined) { equipment.is_benming = !!is_benming; changes.is_benming = !!is_benming; }
        if (is_summoned !== undefined) { equipment.is_summoned = !!is_summoned; changes.is_summoned = !!is_summoned; }
        if (spirit_power !== undefined) { equipment.spirit_power = spirit_power; changes.spirit_power = spirit_power; }

        await equipment.save({ transaction: t });

        // 写入操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'equipment_update',
            targetId: playerId,
            detail: { recordId, changes },
            req
        });

        await t.commit();

        res.json({
            code: 200,
            message: '装备记录已更新',
            data: equipment
        });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        next(error);
    }
});

/**
 * 重置装备记录（恢复初始值）
 * POST /api/admin/equipment/:playerId/record/:id/reset
 *
 * 重置内容：
 *   - durability = max_durability（恢复满耐久）
 *   - max_durability = 配置的 initial_max（恢复初始最大耐久）
 *   - refine_level = 0
 *   - is_benming = false, benming_slot = null, spirit_power = 0
 *   - is_summoned = false
 *   - sort_order 保持不变（不影响显示顺序）
 */
router.post('/:playerId/record/:id/reset', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId, 10);
        const recordId = parseInt(req.params.id, 10);
        if (!playerId || !recordId) {
            throw new AppError('无效的玩家 ID 或记录 ID', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const gameBalance = getGameBalanceConfig();
        const initialMax = gameBalance?.equipment?.durability?.initial_max ?? 100;

        const equipment = await PlayerEquipment.findOne({
            where: { id: recordId, player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!equipment) {
            throw new AppError('装备记录不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 重置字段
        equipment.durability = initialMax;
        equipment.max_durability = initialMax;
        equipment.refine_level = 0;
        equipment.is_benming = false;
        equipment.benming_slot = null;
        equipment.spirit_power = 0;
        equipment.is_summoned = false;
        await equipment.save({ transaction: t });

        await logAdminAction({
            adminId: req.player.id,
            action: 'equipment_reset',
            targetId: playerId,
            detail: { recordId, reset_to: { durability: initialMax, max_durability: initialMax, refine_level: 0 } },
            req
        });

        await t.commit();

        res.json({
            code: 200,
            message: '装备记录已重置',
            data: equipment
        });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        next(error);
    }
});

/**
 * GM 一键修理指定玩家所有装备（无消耗）
 * POST /api/admin/equipment/:playerId/repair-all
 *
 * 与玩家侧 repair-all 的区别：
 *   - 不消耗灵石
 *   - 不扣减 max_durability 上限
 *   - 直接恢复 durability = max_durability
 */
router.post('/:playerId/repair-all', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId, 10);
        if (!playerId) {
            throw new AppError('无效的玩家 ID', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询所有需要修理的装备
        const equipments = await PlayerEquipment.findAll({
            where: { player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        const repaired = [];
        for (const eq of equipments) {
            if (eq.durability < eq.max_durability || eq.max_durability <= 0) {
                // 恢复 max_durability 到初始值（若已降至 0 或异常值）
                const gameBalance = getGameBalanceConfig();
                const initialMax = gameBalance?.equipment?.durability?.initial_max ?? 100;
                if (eq.max_durability <= 0) {
                    eq.max_durability = initialMax;
                }
                eq.durability = eq.max_durability;
                await eq.save({ transaction: t });
                repaired.push({ id: eq.id, slot: eq.slot, durability: eq.durability, max_durability: eq.max_durability });
            }
        }

        await logAdminAction({
            adminId: req.player.id,
            action: 'equipment_repair_all',
            targetId: playerId,
            detail: { repaired_count: repaired.length },
            req
        });

        await t.commit();

        res.json({
            code: 200,
            message: `GM 一键修理完成，共修理 ${repaired.length} 件装备`,
            data: { repaired, count: repaired.length }
        });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        next(error);
    }
});

/**
 * 删除装备记录（强制卸下，归还物品到背包）
 * DELETE /api/admin/equipment/:playerId/record/:id
 */
router.delete('/:playerId/record/:id', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parseInt(req.params.playerId, 10);
        const recordId = parseInt(req.params.id, 10);
        if (!playerId || !recordId) {
            throw new AppError('无效的玩家 ID 或记录 ID', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const equipment = await PlayerEquipment.findOne({
            where: { id: recordId, player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!equipment) {
            throw new AppError('装备记录不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 归还物品到玩家背包（通过 InventoryService 延迟加载避免循环依赖）
        const InventoryService = require('../game/services/InventoryService');
        await InventoryService.addItem(playerId, equipment.item_key, 1, t);

        // 删除记录
        const slot = equipment.slot;
        const itemKey = equipment.item_key;
        await equipment.destroy({ transaction: t });

        await logAdminAction({
            adminId: req.player.id,
            action: 'equipment_delete',
            targetId: playerId,
            detail: { recordId, slot, itemKey },
            req
        });

        await t.commit();

        res.json({
            code: 200,
            message: `已强制卸下 ${slot} 槽位装备并归还物品`
        });
    } catch (error) {
        if (t && !t.finished) await t.rollback();
        next(error);
    }
});

module.exports = router;
