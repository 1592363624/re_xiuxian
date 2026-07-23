/**
 * 大衍诀修炼系统路由（玩家端 + GM 运维接口）
 *
 * 提供大衍诀修炼玩法的 HTTP 接口：
 * 1. GET  /api/dayan/config     : 获取大衍诀配置（5层/残篇/参悟参数，无需鉴权）
 * 2. GET  /api/dayan/status     : 获取玩家大衍诀状态（层数/经验/参悟次数/冷却/突破条件）
 * 3. POST /api/dayan/meditate   : 参悟大衍诀（消耗修为，获得经验）
 * 4. POST /api/dayan/breakthrough : 突破层数（消耗残篇，成功率判定）
 * 5. GET  /api/dayan/ascension-check : 检查飞升前置条件（大衍诀五层·衍神）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 DayanService 中
 * 统一响应格式：{ code: 200, message, data }
 *
 * 玩法文档对照：xiuxian_game_guide.md 第23节·大衍诀与傀儡路线
 *   `.参悟大衍诀` / `.大衍诀` / `.修炼大衍诀` 查看和推进层数
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const DayanService = require('../game/services/DayanService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

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
 * GET /api/dayan/config
 * 获取大衍诀系统配置（无需鉴权，供前端展示规则说明）
 *
 * 返回：5层配置/5种残篇/参悟参数/突破参数/飞升前置
 */
router.get('/config', (req, res, next) => {
    try {
        const config = DayanService.getDayanConfig();
        res.json({
            code: 200,
            data: config
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/dayan/status
 * 获取玩家大衍诀修炼状态（需鉴权）
 *
 * 返回：当前层数/经验/参悟次数/冷却/突破条件/神识倍率/飞升前置
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const status = await DayanService.getDayanStatus(req.player.id);
        res.json({
            code: 200,
            data: status
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * POST /api/dayan/meditate
 * 参悟大衍诀（需鉴权）
 *
 * 业务规则：
 *   - 玩家境界 rank ≥ min_realm_rank（默认15=炼气期）
 *   - 今日参悟次数未超限（默认3次/日）
 *   - 冷却已结束（默认10分钟）
 *   - 修为充足（消耗随层数递增）
 *   - 大衍诀未达最高层
 *
 * 返回：参悟结果（获得经验/是否可突破/剩余次数/修为余额）
 */
router.post('/meditate', auth, async (req, res, next) => {
    try {
        const result = await DayanService.meditate(req.player.id);
        res.json({
            code: 200,
            message: result.message,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * POST /api/dayan/breakthrough
 * 突破大衍诀层数（需鉴权）
 *
 * 业务规则：
 *   - 经验已满当前层上限
 *   - 持有对应层数的残篇（突破时扣除）
 *   - 成功率随层数递减（80%→70%→60%→50%→40%，下限30%）
 *   - 失败时残篇损耗，经验保留
 *
 * 返回：突破结果（成功/失败/新层数/神识倍率/是否满足飞升前置）
 */
router.post('/breakthrough', auth, async (req, res, next) => {
    try {
        const result = await DayanService.breakthrough(req.player.id);
        res.json({
            code: 200,
            message: result.message,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

/**
 * GET /api/dayan/ascension-check
 * 检查飞升前置条件（需鉴权）
 *
 * 返回：required_level/current_level/met/message
 */
router.get('/ascension-check', auth, async (req, res, next) => {
    try {
        const result = await DayanService.checkAscensionRequirement(req.player.id);
        res.json({
            code: 200,
            data: result
        });
    } catch (err) {
        handleError(err, res, next);
    }
});

module.exports = router;
