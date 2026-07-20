/**
 * 香火系统玩家路由
 *
 * 提供玩家端香火系统的 HTTP 接口：
 *   1. POST /api/incense/harvest：收割香火
 *   2. GET  /api/incense/logs：分页查询香火流水
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 IncenseService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第4.3.2节（香火产出与流水）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const IncenseService = require('../game/services/IncenseService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
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
 * POST /api/incense/harvest
 * 收割香火（按公式计算累计产出，更新玩家 incense_balance）
 * 同步结算小世界人口/信仰/稳定度变化
 * 无请求体参数
 */
router.post('/harvest', auth, async (req, res, next) => {
    try {
        const result = await IncenseService.harvest(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/incense/logs
 * 分页查询香火流水
 * 查询参数：?page=1&page_size=10
 */
router.get('/logs', auth, async (req, res, next) => {
    try {
        const page = req.query.page ? parseInt(req.query.page, 10) : 1;
        const pageSize = req.query.page_size ? parseInt(req.query.page_size, 10) : 10;
        if (!Number.isInteger(page) || page < 1) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'page 必须为 >=1 的整数'
            });
        }
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'page_size 必须为 1-100 之间的整数'
            });
        }
        const result = await IncenseService.getLogs(req.player.id, page, pageSize);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router