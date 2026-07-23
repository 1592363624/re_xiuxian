/**
 * 拍卖系统路由（玩家端 + GM 运维接口）
 *
 * 提供拍卖竞价博弈玩法的 HTTP 接口：
 * 1. GET    /api/auction/config        : 获取拍卖配置（无需鉴权，展示规则）
 * 2. GET    /api/auction/list          : 拍卖列表（分页 + 筛选 status/quality/keyword）
 * 3. GET    /api/auction/:id           : 拍卖详情（含竞价历史 + 最小加价）
 * 4. POST   /api/auction/create        : 创建拍卖（body: item_key, quantity, starting_price, duration_hours）
 * 5. POST   /api/auction/:id/bid       : 出价（body: bid_price）
 * 6. POST   /api/auction/:id/cancel    : 撤销拍卖（body: reason）
 * 7. GET    /api/auction/my            : 我的拍卖（query: status）
 * 8. GET    /api/auction/my-bids       : 我的竞价（含领先/得标/落标状态）
 * 9. POST   /api/auction/gm/settle     : [GM] 手动触发到期拍卖结算
 * 10. GET   /api/auction/gm/scheduler  : [GM] 查看调度器状态
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 AuctionService 中
 * 统一响应格式：{ code: 200, message, data }
 *
 * 玩法文档对照：xiuxian_game_guide.md 第27节·市场、股市与资产路线
 *   `.拍卖` 查看拍卖列表，`.竞拍 <编号> <价格>` 出价
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const AuctionService = require('../game/services/AuctionService');
const AuctionSchedulerService = require('../game/services/AuctionSchedulerService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const AdminLog = require('../models/admin_log');

/**
 * GM 权限校验中间件
 * 必须登录（auth 已校验 JWT）且 role='admin'
 * 校验失败统一返回 403，避免暴露具体原因
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        return res.status(403).json({
            code: 403,
            error_code: ErrorCodes.BUSINESS_LOGIC_ERROR,
            message: '权限不足：需要管理员权限'
        });
    }
};

/**
 * 记录 GM 操作日志（异步，失败不影响主流程）
 * @param {number} adminId - 管理员玩家ID
 * @param {string} action - 操作类型
 * @param {Object} details - 操作详情
 * @param {Object} req - Express 请求对象（用于获取 IP）
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
        console.error('[Auction] 记录管理员日志失败:', error.message);
    }
}

/**
 * 统一错误处理辅助函数
 * 业务错误（AppError）按 statusCode 返回；其他错误交给全局 errorHandler
 * @param {Error} err - 异常对象
 * @param {Object} res - Express 响应对象
 * @param {Function} next - Express next 函数
 */
function handleError(err, res, next) {
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            code: err.statusCode,
            error_code: err.errorCode,
            message: err.message
        });
    }
    next(err);
}

/**
 * GET /api/auction/config
 * 获取拍卖系统配置（无需鉴权，供前端展示规则说明）
 *
 * 返回：duration_hours / starting_price / bid / fee_rate / anti_snipe / seller / bidder 等
 */
router.get('/config', (req, res, next) => {
    try {
        const config = AuctionService.getAuctionConfig();
        res.json({
            code: 200,
            data: config
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/auction/list
 * 拍卖列表（分页 + 筛选，无需鉴权可浏览，但竞价需登录）
 *
 * 查询参数：
 *   - page:     页码（默认 1）
 *   - page_size: 每页数量（默认 20，上限 100）
 *   - status:   状态筛选（open/closed/cancelled，默认 open）
 *   - quality:  品质筛选（common/uncommon/rare/epic/legendary/mythic）
 *   - keyword:  关键词（模糊匹配 item_name）
 *   - sort:     排序字段（end_at_asc 默认 / current_price_desc / current_price_asc）
 */
router.get('/list', async (req, res, next) => {
    try {
        const filters = {
            page: parseInt(req.query.page, 10) || 1,
            page_size: parseInt(req.query.page_size, 10) || 20,
            status: req.query.status || 'open',
            quality: req.query.quality || null,
            keyword: req.query.keyword || null,
            sort: req.query.sort || 'end_at_asc'
        };

        const result = await AuctionService.listAuctions(filters);
        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/auction/my
 * 我的拍卖（需鉴权）
 *
 * 查询参数：
 *   - status: 状态筛选（open/closed/cancelled，默认全部）
 */
router.get('/my', auth, async (req, res, next) => {
    try {
        const status = req.query.status || null;
        const result = await AuctionService.getMyAuctions(req.player.id, status);
        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/auction/my-bids
 * 我的竞价记录（需鉴权）
 *
 * 返回：包含每个竞价的 leading/won/lost 状态标记
 */
router.get('/my-bids', auth, async (req, res, next) => {
    try {
        const result = await AuctionService.getMyBids(req.player.id);
        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/auction/:id
 * 拍卖详情（无需鉴权可查看，但 can_bid 字段需登录才有意义）
 *
 * 路径参数：
 *   - id: 拍卖ID
 *
 * 返回：拍卖详情 + 竞价历史 + 最小加价 + 当前用户是否可出价
 */
router.get('/:id', async (req, res, next) => {
    try {
        const auctionId = parseInt(req.params.id, 10);
        if (!auctionId || auctionId < 1) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '拍卖ID无效'
            });
        }

        // 未登录用户 viewerId 为 null
        const viewerId = req.player?.id || null;
        const result = await AuctionService.getAuctionDetail(auctionId, viewerId);
        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * POST /api/auction/create
 * 创建拍卖（需鉴权）
 *
 * 请求体：
 *   - item_key:       物品键名（必填）
 *   - quantity:       数量（默认 1）
 *   - starting_price: 起拍价（必填，单位灵石）
 *   - duration_hours: 拍卖时长（小时，默认 6）
 *
 * 业务规则：
 *   - 玩家境界 rank ≥ seller.min_level_rank
 *   - 同时进行中的拍卖数 ≤ seller.max_concurrent_auctions
 *   - 起拍价在 starting_price.min ~ max 范围内
 *   - 时长在 duration_hours.min ~ max 范围内
 *   - 物品数量充足（创建时即扣除，结算时发给得标者或退回）
 */
router.post('/create', auth, async (req, res, next) => {
    try {
        const { item_key, quantity, starting_price, duration_hours } = req.body;

        // 参数校验
        if (!item_key || typeof item_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '物品键名 item_key 必填'
            });
        }
        const qty = parseInt(quantity, 10) || 1;
        if (qty < 1) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '数量必须大于 0'
            });
        }
        const startPrice = parseInt(starting_price, 10);
        if (!startPrice || startPrice < 1) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '起拍价 starting_price 必填且必须为正整数'
            });
        }
        const duration = parseFloat(duration_hours) || 6;

        const result = await AuctionService.createAuction(
            req.player.id,
            item_key,
            qty,
            startPrice,
            duration
        );

        res.json({
            code: 200,
            message: '拍卖已发布，等待竞价',
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * POST /api/auction/:id/bid
 * 出价（需鉴权）
 *
 * 路径参数：
 *   - id: 拍卖ID
 *
 * 请求体：
 *   - bid_price: 出价金额（单位灵石，必须 ≥ 当前价 + 最小加价）
 *
 * 业务规则：
 *   - 拍卖状态为 open
 *   - 出价人境界 rank ≥ bidder.min_level_rank
 *   - 出价人同时领先竞价数 ≤ bidder.max_concurrent_bids
 *   - 出价人灵石充足（竞价时冻结，被超越时退还）
 *   - 触发防秒杀机制：结束前 60s 内出价自动延长 60s
 */
router.post('/:id/bid', auth, async (req, res, next) => {
    try {
        const auctionId = parseInt(req.params.id, 10);
        if (!auctionId || auctionId < 1) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '拍卖ID无效'
            });
        }

        const { bid_price } = req.body;
        const bidPrice = parseInt(bid_price, 10);
        if (!bidPrice || bidPrice < 1) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '出价 bid_price 必须为正整数'
            });
        }

        const result = await AuctionService.placeBid(req.player.id, auctionId, bidPrice);

        res.json({
            code: 200,
            message: '出价成功',
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * POST /api/auction/:id/cancel
 * 撤销拍卖（需鉴权）
 *
 * 路径参数：
 *   - id: 拍卖ID
 *
 * 请求体：
 *   - reason: 撤销原因（可选，便于审计）
 *
 * 业务规则：
 *   - 只有卖家本人可撤销
 *   - 拍卖状态为 open
 *   - 已有人竞价时撤销需支付补偿费（cancel_fee_when_bidded 比例 × 当前价）
 *   - 物品退回卖家储物袋
 */
router.post('/:id/cancel', auth, async (req, res, next) => {
    try {
        const auctionId = parseInt(req.params.id, 10);
        if (!auctionId || auctionId < 1) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: '拍卖ID无效'
            });
        }

        const reason = (req.body?.reason || '').toString().slice(0, 120);
        const result = await AuctionService.cancelAuction(req.player.id, auctionId, reason);

        res.json({
            code: 200,
            message: '拍卖已撤销',
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

// ==================== GM 运维接口 ====================

/**
 * POST /api/auction/gm/settle
 * [GM] 手动触发到期拍卖结算
 *
 * 用途：调试或紧急清理遗留到期拍卖，无需等待调度器周期
 *
 * 返回：{ settled, failed, details }
 */
router.post('/gm/settle', auth, adminCheck, async (req, res, next) => {
    try {
        const result = await AuctionService.settleExpiredAuctions();

        await logAdminAction(req.player.id, 'auction_gm_settle', {
            settled: result.settled,
            failed: result.failed
        }, req);

        res.json({
            code: 200,
            message: `结算完成：成功 ${result.settled}，失败 ${result.failed}`,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/auction/gm/scheduler
 * [GM] 查看拍卖调度器状态
 *
 * 返回：{ running, busy, interval_ms }
 */
router.get('/gm/scheduler', auth, adminCheck, (req, res, next) => {
    try {
        const status = AuctionSchedulerService.getStatus();
        res.json({
            code: 200,
            data: status
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

module.exports = router;
