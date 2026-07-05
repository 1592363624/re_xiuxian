/**
 * 当铺管理路由（GM 后台）
 *
 * 提供以下接口：
 *   1. GET    /metrics                  - 统计指标（活跃当票数、今日典当总额、逾期数）
 *   2. GET    /list                     - 分页查询所有当票（支持 player_id 与 status 筛选）
 *   3. GET    /:listingId               - 查询指定当票详情
 *   4. POST   /:listingId/force-redeem  - 强制赎回（GM 代赎，不扣玩家灵石）
 *   5. POST   /:listingId/cancel        - 强制取消（物品归还玩家，不扣灵石）
 *   6. PUT    /credit/:playerId         - 调整玩家当铺信用额度
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证 + admin 权限（auth + adminCheck 双层中间件）
 *   - 业务逻辑调用 PawnshopService，使用事务保证数据一致性
 *   - 所有写操作记录到 admin_logs 表，便于审计追溯
 *   - 使用 AppError + ErrorCodes 抛错，由全局 errorHandler 统一处理
 *   - 阈值（分页大小、查询上限）从 game_balance.admin 读取，不硬编码
 *
 * 路由顺序说明：
 *   静态路径（/metrics、/list）必须定义在动态参数路由 /:listingId 之前，避免被误匹配。
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');

// 中间件、模型与基础设施
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const Player = require('../models/player');
const PawnshopListing = require('../models/pawnshopListing');
const PawnshopHistory = require('../models/pawnshopHistory');
const PawnshopService = require('../game/services/PawnshopService');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 通过 ConfigLoader 获取 game_balance 配置（支持热更新，避免硬编码阈值）
const configLoader = infrastructure.ConfigLoader;

/**
 * 读取 game_balance.admin 配置节
 * @returns {Object} admin 配置对象（若未加载则返回空对象，调用方使用默认值兜底）
 */
function getAdminConfig() {
    return configLoader?.getConfig('game_balance')?.admin || {};
}

/**
 * GM 权限校验中间件
 * 复用 admin_cave.js 中的 adminCheck 逻辑：检查 req.player.role === 'admin'
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
        // 日志写入失败不应阻塞主流程，仅打印警告
        console.error('[admin_pawnshop] 写入操作日志失败:', e.message);
    }
}

/**
 * GET /api/admin/pawnshop/metrics
 * 统计指标
 * 返回：活跃当票数、今日典当总额、逾期数、总信用分布
 */
router.get('/metrics', auth, adminCheck, async (req, res, next) => {
    try {
        // 活跃当票数
        const activeCount = await PawnshopListing.count({ where: { status: 'active' } });
        // 已逾期当票数
        const overdueCount = await PawnshopListing.count({ where: { status: 'overdue' } });
        // 已赎回当票数
        const redeemedCount = await PawnshopListing.count({ where: { status: 'redeemed' } });

        // 今日典当总额（聚合查询）
        const today = new Date().toISOString().slice(0, 10);
        const todayPawnRecords = await PawnshopHistory.findAll({
            where: {
                action_type: 'pawn',
                created_at: { [Op.gte]: new Date(`${today}T00:00:00`) }
            },
            attributes: ['amount'],
            raw: true
        });
        // 今日典当总灵石（BIGINT 兼容：用 BigInt 求和后转字符串）
        const todayPawnTotal = todayPawnRecords.reduce(
            (sum, r) => sum + BigInt(r.amount || 0),
            BigInt(0)
        ).toString();
        const todayPawnCount = todayPawnRecords.length;

        // 今日赎回总额
        const todayRedeemRecords = await PawnshopHistory.findAll({
            where: {
                action_type: 'redeem',
                created_at: { [Op.gte]: new Date(`${today}T00:00:00`) }
            },
            attributes: ['amount'],
            raw: true
        });
        const todayRedeemTotal = todayRedeemRecords.reduce(
            (sum, r) => sum + BigInt(r.amount || 0),
            BigInt(0)
        ).toString();
        const todayRedeemCount = todayRedeemRecords.length;

        // 总信用分布：信用额度 > 0 的玩家数 + 平均信用额度
        const playersWithCredit = await Player.count({
            where: { pawnshop_credit: { [Op.gt]: 0 } }
        });
        const totalPlayers = await Player.count();
        // 计算平均信用额度（用 SQL 聚合避免拉全表）
        const avgResult = await Player.findAll({
            attributes: [
                [require('sequelize').fn('AVG', require('sequelize').col('pawnshop_credit')), 'avg_credit']
            ],
            raw: true
        });
        const avgCredit = avgResult[0]?.avg_credit ? Math.round(Number(avgResult[0].avg_credit) * 100) / 100 : 0;

        res.json({
            code: 200,
            message: 'success',
            data: {
                listings: {
                    active: activeCount,
                    overdue: overdueCount,
                    redeemed: redeemedCount,
                    total: activeCount + overdueCount + redeemedCount
                },
                today: {
                    pawn_count: todayPawnCount,
                    pawn_total_amount: todayPawnTotal,
                    redeem_count: todayRedeemCount,
                    redeem_total_amount: todayRedeemTotal
                },
                credit: {
                    players_with_credit: playersWithCredit,
                    total_players: totalPlayers,
                    avg_credit: avgCredit
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/pawnshop/list
 * 分页查询所有当票（支持 player_id 与 status 筛选）
 * query: { page, limit, player_id, status }
 * 返回：{ list, total, page, page_size, total_pages }
 */
router.get('/list', auth, adminCheck, async (req, res, next) => {
    try {
        const adminConfig = getAdminConfig();
        const pageSize = Math.min(
            parseInt(req.query.limit) || adminConfig.cave_list_page_size || 20,
            adminConfig.cave_list_max_page_size || 100
        );
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const offset = (page - 1) * pageSize;

        // 构造查询条件
        const where = {};
        if (req.query.player_id) {
            const pid = parseInt(req.query.player_id);
            if (!isNaN(pid) && pid > 0) where.player_id = pid;
        }
        // 状态白名单校验（防 SQL 注入）
        const allowedStatus = ['active', 'redeemed', 'overdue', 'auctioned'];
        if (req.query.status && allowedStatus.includes(req.query.status)) {
            where.status = req.query.status;
        }

        const { count, rows } = await PawnshopListing.findAndCountAll({
            where,
            order: [['pawned_at', 'DESC']],
            limit: pageSize,
            offset,
            raw: true
        });

        // 批量查询玩家信息（昵称），避免 N+1
        const playerIds = [...new Set(rows.map(r => r.player_id))];
        let playerMap = new Map();
        if (playerIds.length > 0) {
            const players = await Player.findAll({
                attributes: ['id', 'nickname', 'realm'],
                where: { id: playerIds }
            });
            playerMap = new Map(players.map(p => [p.id, p]));
        }

        // 组装返回数据（金额字段统一转 Number，BIGINT 兼容）
        const list = rows.map(r => {
            const player = playerMap.get(r.player_id);
            return {
                id: r.id,
                player_id: r.player_id,
                player_nickname: player?.nickname || '未知道友',
                player_realm: player?.realm || '凡人',
                item_key: r.item_key,
                item_name: r.item_name,
                item_quality: r.item_quality,
                quantity: r.quantity,
                base_price: Number(r.base_price),
                valuation: Number(r.valuation),
                pawn_amount: Number(r.pawn_amount),
                redeem_amount: Number(r.redeem_amount),
                pawn_fee: Number(r.pawn_fee),
                pawned_at: r.pawned_at,
                redeem_deadline: r.redeem_deadline,
                redeemed_at: r.redeemed_at,
                redeemed_by: r.redeemed_by,
                status: r.status,
                created_at: r.created_at,
                updated_at: r.updated_at
            };
        });

        res.json({
            code: 200,
            message: 'success',
            data: {
                list,
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/pawnshop/:listingId
 * 查询指定当票详情
 * 返回：当票全部字段 + 玩家基础信息
 */
router.get('/:listingId', auth, adminCheck, async (req, res, next) => {
    try {
        const listingId = parseInt(req.params.listingId);
        if (isNaN(listingId) || listingId <= 0) {
            throw new AppError('当票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 查询当票
        const listing = await PawnshopListing.findByPk(listingId, { raw: true });
        if (!listing) {
            throw new AppError('当票不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 单独查询玩家信息（无关联关系）
        const player = await Player.findByPk(listing.player_id, {
            attributes: ['id', 'nickname', 'realm', 'pawnshop_credit', 'spirit_stones']
        });

        // 查询关联历史记录
        const histories = await PawnshopHistory.findAll({
            where: { listing_id: listingId },
            order: [['created_at', 'ASC']],
            raw: true
        });

        res.json({
            code: 200,
            message: 'success',
            data: {
                listing: {
                    id: listing.id,
                    player_id: listing.player_id,
                    item_key: listing.item_key,
                    item_name: listing.item_name,
                    item_quality: listing.item_quality,
                    quantity: listing.quantity,
                    base_price: Number(listing.base_price),
                    valuation: Number(listing.valuation),
                    pawn_amount: Number(listing.pawn_amount),
                    redeem_amount: Number(listing.redeem_amount),
                    pawn_fee: Number(listing.pawn_fee),
                    pawned_at: listing.pawned_at,
                    redeem_deadline: listing.redeem_deadline,
                    redeemed_at: listing.redeemed_at,
                    redeemed_by: listing.redeemed_by,
                    status: listing.status,
                    created_at: listing.created_at,
                    updated_at: listing.updated_at
                },
                player: player ? {
                    id: player.id,
                    nickname: player.nickname,
                    realm: player.realm,
                    pawnshop_credit: player.pawnshop_credit,
                    spirit_stones: player.spirit_stones.toString()
                } : null,
                histories: histories.map(h => ({
                    ...h,
                    amount: Number(h.amount)
                }))
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/pawnshop/:listingId/force-redeem
 * 强制赎回（GM 代玩家赎回，不扣玩家灵石）
 * body: { player_id, reason }
 * 说明：必须传入 player_id 用于校验当票归属（防止跨玩家操作）
 */
router.post('/:listingId/force-redeem', auth, adminCheck, async (req, res, next) => {
    try {
        const listingId = parseInt(req.params.listingId);
        if (isNaN(listingId) || listingId <= 0) {
            throw new AppError('当票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const playerId = parseInt(req.body.player_id);
        if (isNaN(playerId) || playerId <= 0) {
            throw new AppError('玩家 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const reason = req.body.reason || '';

        const result = await PawnshopService.gmForceRedeem(
            req.player.id,
            playerId,
            listingId,
            reason
        );

        // 记录管理员操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'pawnshop_force_redeem',
            targetId: playerId,
            detail: `GM 强制赎回当票 #${listingId}，玩家 ${playerId}，原因: ${reason}`,
            req
        });

        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/admin/pawnshop/:listingId/cancel
 * 强制取消当票（物品归还玩家，不扣灵石）
 * body: { reason }
 * 说明：cancel 用于误操作回滚，已发放的灵石不退还
 */
router.post('/:listingId/cancel', auth, adminCheck, async (req, res, next) => {
    try {
        const listingId = parseInt(req.params.listingId);
        if (isNaN(listingId) || listingId <= 0) {
            throw new AppError('当票 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const reason = req.body.reason || '';

        const result = await PawnshopService.gmCancelListing(
            req.player.id,
            listingId,
            reason
        );

        // 记录管理员操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'pawnshop_cancel_listing',
            targetId: result.player_id,
            detail: `GM 强制取消当票 #${listingId}，玩家 ${result.player_id}，原因: ${reason}`,
            req
        });

        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/pawnshop/credit/:playerId
 * 调整玩家当铺信用额度
 * body: { credit, reason }
 * 校验：credit 必须为 0 - credit_max 之间的整数
 */
router.put('/credit/:playerId', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId);
        if (isNaN(playerId) || playerId <= 0) {
            throw new AppError('玩家 ID 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const credit = req.body.credit;
        const reason = req.body.reason || '';

        const result = await PawnshopService.gmUpdateCredit(
            req.player.id,
            playerId,
            credit,
            reason
        );

        // 记录管理员操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'pawnshop_update_credit',
            targetId: playerId,
            detail: `GM 调整玩家 ${playerId} 的当铺信用额度：${result.old_credit} -> ${result.new_credit}，原因: ${reason}`,
            req
        });

        res.json({ code: 200, ...result });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
