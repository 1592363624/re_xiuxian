/**
 * 小世界系统玩家路由
 *
 * 提供玩家端小世界系统的 HTTP 接口：
 *   1. GET  /api/small-world/profile：获取小世界面板
 *   2. POST /api/small-world/create：开辟小世界
 *   3. POST /api/small-world/manifest：显灵回应祈愿
 *   4. POST /api/small-world/miracle：神迹干预（赈灾/布道）
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 SmallWorldService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第4.3.1节（小世界开辟与产出）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SmallWorldService = require('../game/services/SmallWorldService');
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
 * GET /api/small-world/profile
 * 获取小世界面板数据（人口/信仰/稳定度/香火产出/神庙等级）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await SmallWorldService.getProfile(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/small-world/create
 * 开辟小世界（化神期 + 灵石消耗 500000）
 * 请求体：{ world_name: string }
 */
router.post('/create', auth, async (req, res, next) => {
    try {
        const { world_name } = req.body;
        if (!world_name || typeof world_name !== 'string' || world_name.trim().length === 0) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'world_name 必填且必须为非空字符串'
            });
        }
        if (world_name.length > 50) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'world_name 长度不能超过 50 个字符'
            });
        }
        const result = await SmallWorldService.create(req.player.id, world_name.trim());
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/small-world/manifest
 * 显灵回应祈愿（消耗 100 香火，获得信仰+5/稳定+3/灵石回馈）
 * 无请求体参数
 */
router.post('/manifest', auth, async (req, res, next) => {
    try {
        const result = await SmallWorldService.manifest(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/small-world/miracle
 * 神迹干预（赈灾/布道，每日次数限制）
 * 请求体：{ type: 'relieve_disaster' | 'preach' }
 */
router.post('/miracle', auth, async (req, res, next) => {
    try {
        const { type } = req.body;
        if (!['relieve_disaster', 'preach'].includes(type)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'type 必须为 relieve_disaster(赈灾) 或 preach(布道)'
            });
        }
        const result = await SmallWorldService.miracle(req.player.id, type);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
