/**
 * 静思悟道路由
 *
 * 提供玩家端悟道玩法的 HTTP 接口：
 * 1. POST /api/meditation/start：开始静思悟道（含时长类型选择）
 * 2. POST /api/meditation/interrupt：主动中断悟道（带惩罚）
 * 3. GET  /api/meditation/status：查询悟道状态与瓶颈进度
 * 4. GET  /api/meditation/config：查询悟道配置（供前端展示时长选项）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 MeditationService 中
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const MeditationService = require('../game/services/MeditationService');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const configLoader = infrastructure.ConfigLoader;

/**
 * POST /api/meditation/start
 * 开始静思悟道
 * 请求体：{ duration_type: 'short' | 'medium' | 'long' | 'deep' }
 */
router.post('/start', auth, async (req, res, next) => {
    try {
        const { duration_type } = req.body;

        // 参数校验
        if (!duration_type || typeof duration_type !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'duration_type 参数不能为空'
            });
        }

        const allowedTypes = ['short', 'medium', 'long', 'deep'];
        if (!allowedTypes.includes(duration_type)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `无效的时长类型：${duration_type}，可选值：${allowedTypes.join('/')}`
            });
        }

        const result = await MeditationService.startMeditation(req.player.id, duration_type);

        res.json({
            code: 200,
            message: result.message,
            data: result
        });
    } catch (err) {
        // AppError 由错误处理中间件统一处理
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * POST /api/meditation/interrupt
 * 主动中断悟道（带惩罚）
 */
router.post('/interrupt', auth, async (req, res, next) => {
    try {
        const result = await MeditationService.interruptMeditation(req.player.id);

        res.json({
            code: 200,
            message: result.message,
            data: result
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/meditation/status
 * 查询悟道状态与瓶颈进度
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const status = await MeditationService.getStatus(req.player.id);

        res.json({
            code: 200,
            data: status
        });
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                code: err.statusCode,
                error_code: err.errorCode,
                message: err.message
            });
        }
        next(err);
    }
});

/**
 * GET /api/meditation/config
 * 查询悟道配置（公开接口，供前端展示时长选项和说明）
 */
router.get('/config', auth, async (req, res, next) => {
    try {
        const cfg = MeditationService.getMeditationConfig();
        const btCfg = MeditationService.getBreakthroughConfig();

        // 仅返回前端展示所需字段，过滤内部参数
        const publicConfig = {
            duration_types: cfg.duration_types,
            deep: cfg.deep,
            daily_normal_limit: cfg.daily_normal_limit,
            daily_deep_limit: cfg.daily_deep_limit,
            cooldown_seconds: cfg.cooldown_seconds,
            bottleneck: {
                enabled: btCfg.bottleneck_enabled !== false,
                bottleneck_realms: btCfg.bottleneck_realms || [],
                max_failure_count: btCfg.bottleneck_max_failure_count || 3,
                broken_breakthrough_bonus: btCfg.broken_breakthrough_bonus || 30
            }
        };

        res.json({
            code: 200,
            data: publicConfig
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
