/**
 * 灵兽系统玩家路由
 *
 * 提供玩家端灵兽系统的 11 个 HTTP 接口：
 *   1. GET  /api/spirit-beast/types                       - 获取所有灵兽种类（图鉴）
 *   2. GET  /api/spirit-beast/list                        - 获取我的灵兽列表
 *   3. GET  /api/spirit-beast/:beastId                    - 灵兽详情
 *   4. POST /api/spirit-beast/catch                       - 寻觅/捕获灵兽 { beast_key }
 *   5. POST /api/spirit-beast/:beastId/feed               - 喂养灵兽
 *   6. POST /api/spirit-beast/:beastId/interact           - 互动灵兽
 *   7. POST /api/spirit-beast/:beastId/set-active         - 设置出战
 *   8. POST /api/spirit-beast/:beastId/release            - 放生灵兽
 *   9. GET  /api/spirit-beast/daily-status                - 获取今日捕获次数等信息
 *  10. GET  /api/spirit-beast/:beastId/upgrade-preview    - 升星预览（消耗+成功率+招牌特性）
 *  11. POST /api/spirit-beast/:beastId/upgrade-star       - 灵兽通灵升星（玩法文档第8节）
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 SpiritBeastService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *   - 业务错误用 AppError + ErrorCodes，统一通过 sendServiceResult 包装
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SpiritBeastService = require('../game/services/SpiritBeastService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * 业务失败仍返回 HTTP 200，由 code/success 区分（与 companion.js 路由保持一致）
 * @param {Object} result - Service 返回的 { success, message, data }
 * @param {Object} res - Express 响应对象
 */
function sendServiceResult(result, res) {
    if (result.success) {
        return res.json({
            code: 200,
            message: result.message || 'success',
            data: result.data || null
        });
    }
    return res.json({
        code: 200,
        success: false,
        message: result.message,
        data: result.data || null,
        error_code: result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR
    });
}

/**
 * GET /api/spirit-beast/types
 * 获取所有灵兽种类（图鉴）
 * 返回配置中的全部灵兽种类 + 玩家已捕获标记 + 元素/稀有度配置
 */
router.get('/types', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastService.getBeastTypes(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/list
 * 获取我的灵兽列表
 * 按 出战 > 星级 > 等级 > 捕获时间 排序
 */
router.get('/list', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastService.getMyBeasts(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/daily-status
 * 获取今日捕获状态：今日次数/上限/剩余/灵兽背包容量
 * 必须放在 /:beastId 路由之前，否则会被识别为 beastId
 */
router.get('/daily-status', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastService.getDailyStatus(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/:beastId
 * 灵兽详情：完整属性 + 战力 + 元素相克 + 冷却剩余
 */
router.get('/:beastId', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.getBeastDetail(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/catch
 * 寻觅/捕获灵兽
 * 请求体：{ beast_key: string }
 */
router.post('/catch', auth, async (req, res, next) => {
    try {
        const { beast_key } = req.body;
        if (!beast_key || typeof beast_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beast_key 必填且必须为字符串'
            });
        }
        const result = await SpiritBeastService.catchBeast(req.player.id, beast_key);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/feed
 * 喂养灵兽：消耗灵石，增加经验/忠诚度，1 小时冷却
 */
router.post('/:beastId/feed', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.feedBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/interact
 * 互动灵兽：增加忠诚度+经验，10 分钟冷却，无消耗
 */
router.post('/:beastId/interact', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.interactBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/set-active
 * 设置出战灵兽：同时仅 1 只出战
 */
router.post('/:beastId/set-active', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.setActiveBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/release
 * 放生灵兽：返还部分灵石，删除灵兽记录
 */
router.post('/:beastId/release', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.releaseBeast(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/spirit-beast/:beastId/upgrade-preview
 * 灵兽升星预览（玩法文档第8节）
 *
 * 返回内容（不执行实际升星，仅展示给玩家确认）：
 *   - beast: 灵兽详情
 *   - current_star / target_star: 当前星级 / 目标星级
 *   - cost: 升星消耗（beast_soul / yaodan / spirit_stones，含持有量）
 *   - success_rate: 升星成功率（0-1）
 *   - trait_unlocked: 升星后激活的招牌特性（3星/5星时为非空）
 *   - can_upgrade: 是否可立即升星（false 时 reason 给出原因）
 *
 * 用途：前端确认弹窗展示"升星需要什么、成功率多少、激活什么特性"，
 *       玩家点击确认后才调用 POST /api/spirit-beast/:beastId/upgrade-star
 */
router.get('/:beastId/upgrade-preview', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.getUpgradePreview(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/spirit-beast/:beastId/upgrade-star
 * 灵兽通灵升星（玩法文档第8节）
 *
 * 业务流程：
 *   1. 前置校验：冷却/状态/材料/星级上限
 *   2. 事务内消耗材料（beast_soul 字段 + yaodan 物品 + spirit_stones）
 *   3. 按 success_rate 概率判定升星成功/失败
 *   4. 成功：star_level+1，重算属性，3星/5星激活招牌特性
 *   5. 失败：材料全损 + 忠诚度-5~15（不降级，保护玩家体验）
 *
 * 无请求体参数（beastId 在 URL 中）
 *
 * 返回内容：
 *   - beast_id / beast_key: 灵兽标识
 *   - old_star / new_star: 升星前后星级（失败时相同）
 *   - upgrade_success: 升星是否成功
 *   - trait_unlocked: 升星激活的招牌特性（成功且达 3/5 星时为非空）
 *   - cost: 实际消耗（beast_soul / yaodan / spirit_stones）
 *   - loyalty_change: 忠诚度变化（成功 +5 / 失败 -5~-15）
 *   - new_beast_soul / new_spirit_stones / new_star_level / new_atk / new_def / new_hp_max / new_speed / new_loyalty
 */
router.post('/:beastId/upgrade-star', auth, async (req, res, next) => {
    try {
        const beastId = Number(req.params.beastId);
        if (!beastId || beastId <= 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'beastId 必须为正整数'
            });
        }
        const result = await SpiritBeastService.upgradeStar(req.player.id, beastId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
