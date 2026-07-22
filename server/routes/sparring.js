/**
 * 切磋木人系统路由（玩家端 + GM 运维接口）
 *
 * 提供切磋木人战力测试玩法的 HTTP 接口：
 * 1. GET  /api/sparring/info：获取切磋木人配置（5个档次木人 + 全局参数）
 * 2. GET  /api/sparring/status：获取玩家切磋状态（今日次数/冷却/首次击败/最高分）
 * 3. POST /api/sparring/start：开始切磋（body: woodman_key）
 * 4. GET  /api/sparring/history：切磋历史（query: limit=20, offset=0）
 * 5. GET  /api/sparring/ranking：排行榜（query: type=daily|all_time|tier, tier, limit=10）
 * 6. POST /api/sparring/settle：[GM] 手动触发每日排行榜结算（body: target_date='YYYY-MM-DD'，可选）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 SparringService 中
 * 统一响应格式：{ code: 200, message, data }
 *
 * 玩法文档对照：xiuxian_game_guide.md 第17节·战力与阵法
 *   `.切磋木人 [境界]` 用于检查战斗准备，是战力测试功能
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SparringService = require('../game/services/SparringService');
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
        console.error('[Sparring] 记录管理员日志失败:', error.message);
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
 * GET /api/sparring/info
 * 获取切磋木人配置信息（无需鉴权，方便玩家查看规则）
 *
 * 返回内容：
 *   - global: 全局参数（每日次数/冷却/评分参数等）
 *   - woodmen: 5个档次木人配置（炼气/筑基/结丹/元婴/化神）
 */
router.get('/info', async (req, res, next) => {
    try {
        const info = SparringService.getInfo();

        res.json({
            code: 200,
            data: info
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/sparring/status
 * 获取玩家切磋状态（需鉴权）
 *
 * 返回内容：
 *   - daily_limit/daily_used/daily_remaining: 每日次数限制与剩余
 *   - cooldown_remaining_sec: 冷却剩余秒数（0 表示可切磋）
 *   - can_sparring: 是否可立即切磋
 *   - first_clears: 各档次首次击败记录
 *   - best_score/best_score_tier: 历史最高分
 *   - today_records: 今日切磋记录
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const status = await SparringService.getStatus(req.player.id);

        res.json({
            code: 200,
            data: status
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * POST /api/sparring/start
 * 开始切磋木人（需鉴权）
 *
 * 请求体：
 *   - woodman_key: 木人键（qi_refining/foundation/core_formation/nascent_soul/spirit_severing）
 *
 * 校验规则：
 *   - woodman_key 必填且必须为有效值
 *   - 玩家境界 rank ≥ 全局 min_realm_rank
 *   - 今日切磋次数未超限
 *   - 冷却已结束
 *
 * 返回内容：
 *   - record_id: 切磋记录ID
 *   - woodman: 木人信息
 *   - battle: 战斗结果（result/rounds/HP/MP/伤害/完美/log）
 *   - score: 战力评分
 *   - rewards: 奖励（exp/spirit_stones/title/is_first_clear）
 *   - daily_remaining: 今日剩余次数
 */
router.post('/start', auth, async (req, res, next) => {
    try {
        const { woodman_key } = req.body;

        // 参数校验：woodman_key 必填
        if (!woodman_key || typeof woodman_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'woodman_key 参数无效（必填，字符串类型）'
            });
        }

        // 防御性：trim 防止前后空格
        const woodmanKey = woodman_key.trim();

        // 调用服务层开始切磋
        const result = await SparringService.startSparring(req.player.id, woodmanKey);

        res.json({
            code: 200,
            message: result.battle.result === 'win'
                ? `切磋胜利！战力评分：${result.score}`
                : (result.battle.result === 'lose' ? '切磋失败，木人实力强劲，再接再厉' : '切磋超时，回合数耗尽'),
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/sparring/history
 * 获取切磋历史（需鉴权）
 *
 * 查询参数：
 *   - limit: 返回条数（默认20，最大100）
 *   - offset: 偏移量（默认0，用于分页）
 *
 * 返回内容：
 *   - total: 历史记录总数
 *   - limit/offset: 实际查询参数
 *   - records: 切磋记录列表
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        // limit 范围限制 1-100，默认 20
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
        // offset 范围限制 ≥0，默认 0
        const offset = Math.max(0, parseInt(req.query.offset) || 0);

        const result = await SparringService.getHistory(req.player.id, limit, offset);

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/sparring/ranking
 * 获取切磋排行榜（需鉴权）
 *
 * 查询参数：
 *   - type: 排行榜类型（daily=今日榜, all_time=历史榜, tier=按档次榜）
 *   - tier: 木人档次（1-5，仅 type=tier 时有效）
 *   - limit: 返回条数（默认10，最大50）
 *
 * 返回内容：
 *   - type/tier: 实际查询参数
 *   - ranking: 排行榜列表（rank/player_id/nickname/best_score/best_tier/best_woodman/latest_time）
 */
router.get('/ranking', auth, async (req, res, next) => {
    try {
        // type 范围限制，默认 daily
        const validTypes = ['daily', 'all_time', 'tier'];
        const type = validTypes.includes(req.query.type) ? req.query.type : 'daily';

        // tier 范围限制 1-5，仅 type=tier 时有效
        let tier = null;
        if (type === 'tier') {
            const tierNum = parseInt(req.query.tier);
            if (tierNum >= 1 && tierNum <= 5) {
                tier = tierNum;
            }
        }

        // limit 范围限制 1-50，默认 10
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);

        const result = await SparringService.getRanking(type, tier, limit);

        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * POST /api/sparring/settle
 * [GM 接口] 手动触发每日排行榜结算（双层鉴权：auth + adminCheck）
 *
 * 使用场景：
 *   - 调度器未到点但需要立即结算（如紧急修复后补结算昨日数据）
 *   - 测试环境验证结算逻辑
 *   - 服务长时间宕机后补结算某日数据
 *
 * 请求体（可选）：
 *   - target_date: 目标结算日期，格式 'YYYY-MM-DD'（如 '2026-07-20'）
 *     - 不传：默认结算昨日（与调度器行为一致）
 *     - 传入日期：结算指定日期的排行榜
 *
 * 幂等性保证：
 *   - Service 层通过 settled_at 字段防重入
 *   - 已结算的日期再次调用会返回 already_settled=true，不会重复发放奖励
 *
 * 返回内容：
 *   - settle_date: 实际结算日期（YYYY-MM-DD）
 *   - already_settled: 是否已结算过（true 表示跳过，未发放奖励）
 *   - settled_count: 上榜玩家数
 *   - rewards: 各名次奖励发放详情
 *   - message: 结算结果描述
 */
router.post('/settle', auth, adminCheck, async (req, res, next) => {
    try {
        const { target_date } = req.body;

        // 参数校验：target_date 可选，但传入时必须是 'YYYY-MM-DD' 格式
        let targetDate = null;
        if (target_date !== undefined && target_date !== null && target_date !== '') {
            if (typeof target_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(target_date)) {
                return res.status(400).json({
                    code: 400,
                    error_code: ErrorCodes.VALIDATION_ERROR,
                    message: 'target_date 参数无效，需为 YYYY-MM-DD 格式字符串'
                });
            }
            // 校验日期有效性：
            // new Date('YYYY-MM-DD') 按 ECMAScript 规范以 UTC 解析，
            // 非法日期如 '2026-02-30' 会被回滚为 '2026-03-02'，通过比对 toISOString 校验
            const parsed = new Date(target_date);
            if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== target_date) {
                return res.status(400).json({
                    code: 400,
                    error_code: ErrorCodes.VALIDATION_ERROR,
                    message: 'target_date 参数无效，不是合法日期'
                });
            }
            targetDate = target_date;
        }

        // 调用 Service 执行结算
        const result = await SparringService.settleDailyRanking(targetDate);

        // 记录 GM 操作日志（异步，不阻塞响应）
        await logAdminAction(req.player.id, 'sparring_settle', {
            target_date: targetDate,
            settle_date: result.settle_date,
            already_settled: result.already_settled,
            settled_count: result.settled_count
        }, req);

        res.json({
            code: 200,
            message: result.message,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

module.exports = router;
