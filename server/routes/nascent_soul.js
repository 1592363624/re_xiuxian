/**
 * 元婴出窍与高阶境界玩法路由
 *
 * 提供玩家端元婴出窍、问道、法相天地、探寻裂缝、夺舍重生等玩法的 HTTP 接口：
 * 1. GET  /api/nascent-soul/status：查询元婴系统状态总览
 * 2. POST /api/nascent-soul/soul-out/start：开始元婴出窍
 * 3. POST /api/nascent-soul/soul-out/end：主动召回元婴
 * 4. POST /api/nascent-soul/ask-dao：向天道问道
 * 5. POST /api/nascent-soul/dharma-form/cultivate：凝聚法相天地
 * 6. POST /api/nascent-soul/fracture/explore：探寻虚空裂缝
 * 7. POST /api/nascent-soul/reincarnate：夺舍重生
 * 8. POST /api/nascent-soul/tianji-revert：天机回溯（清除虚弱+恢复残魂）
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 NascentSoulService 中
 * 互斥校验由 PlayerStateMachine 统一处理，本路由调用前需通过 canStart 检查
 *
 * 对应玩法文档：第3章（境界体系）、第18章（元婴出窍与高阶境界）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const NascentSoulService = require('../game/services/NascentSoulService');
const PlayerStateMachine = require('../game/state/PlayerStateMachine');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * @param {Object} result - Service 返回的 { success, message, data }
 * @param {Object} res - Express 响应对象
 */
function sendServiceResult(result, res) {
    if (result.success) {
        return res.json({
            code: 200,
            message: result.message,
            data: result.data || null
        });
    }
    // 业务失败返回 200 + success:false，便于前端按业务提示处理
    return res.json({
        code: 200,
        success: false,
        message: result.message,
        data: result.data || null,
        error_code: result.error_code || ErrorCodes.BUSINESS_LOGIC_ERROR
    });
}

/**
 * GET /api/nascent-soul/status
 * 查询元婴系统状态总览（出窍、问道、法相、裂缝、虚弱、残魂、夺舍）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const status = NascentSoulService.getStatus(req.player);
        res.json({
            code: 200,
            data: status
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nascent-soul/soul-out/start
 * 开始元婴出窍
 * 请求体：{ target: 'explore' | 'scout' | 'cultivate', duration_sec?: number }
 *
 * 状态机校验：开始出窍前需通过 canStart(SOUL_OUT) 校验，确保无其他激活状态
 */
router.post('/soul-out/start', auth, async (req, res, next) => {
    try {
        const { target, duration_sec } = req.body;
        const playerId = req.player.id;

        // 参数校验
        const validTargets = ['explore', 'scout', 'cultivate'];
        if (target && !validTargets.includes(target)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `无效的出窍目标：${target}，可选值：${validTargets.join('/')}`
            });
        }

        // 时长校验（可选参数，若提供必须为正整数且在合理范围）
        let durationSec = null;
        if (duration_sec !== undefined && duration_sec !== null) {
            const parsed = Number(duration_sec);
            if (!Number.isInteger(parsed) || parsed < 300 || parsed > 7200) {
                return res.status(400).json({
                    code: 400,
                    error_code: ErrorCodes.VALIDATION_ERROR,
                    message: 'duration_sec 必须为 300-7200 之间的整数（秒）'
                });
            }
            durationSec = parsed;
        }

        // 状态机互斥校验：出窍与一切状态互斥
        const stateCheck = await PlayerStateMachine.canStart(playerId, PlayerStateMachine.PlayerState.SOUL_OUT, {
            source: 'route',
            stateType: 'nascent_soul'
        });
        if (!stateCheck.allowed) {
            return res.json({
                code: 200,
                success: false,
                message: stateCheck.reason,
                error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
            });
        }

        const result = await NascentSoulService.startSoulOut(playerId, target || 'explore', durationSec);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nascent-soul/soul-out/end
 * 主动召回元婴（提前结束出窍，按完成率折减收益）
 * 该操作不需要状态机校验，因为它是结束当前 SOUL_OUT 状态
 */
router.post('/soul-out/end', auth, async (req, res, next) => {
    try {
        const result = await NascentSoulService.endSoulOut(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nascent-soul/ask-dao
 * 向天道问道，积累感悟值用于突破加成
 * 问道不是持续状态，但仍需校验当前是否处于出窍等互斥状态（业务层校验）
 */
router.post('/ask-dao', auth, async (req, res, next) => {
    try {
        const result = await NascentSoulService.askDao(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nascent-soul/dharma-form/cultivate
 * 凝聚法相天地（消耗修为与神识提升法相等级，每级提供 5% 属性加成）
 * 凝聚操作不进入状态机持续状态，但需校验当前未处于出窍状态
 */
router.post('/dharma-form/cultivate', auth, async (req, res, next) => {
    try {
        const result = await NascentSoulService.cultivateDharmaForm(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nascent-soul/fracture/explore
 * 探寻虚空裂缝（消耗神识与残魂，有几率获得稀有材料）
 */
router.post('/fracture/explore', auth, async (req, res, next) => {
    try {
        const result = await NascentSoulService.exploreFracture(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nascent-soul/reincarnate
 * 夺舍重生（残魂过低时可尝试夺舍，成功则境界降为元婴初期保留30%修为）
 * 高风险操作，前端应进行二次确认
 */
router.post('/reincarnate', auth, async (req, res, next) => {
    try {
        const result = await NascentSoulService.reincarnate(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/nascent-soul/tianji-revert
 * 天机回溯（清除虚弱+恢复残魂，每日1次，消耗灵石+神识）
 * 仅在虚弱中或残魂<50时可用，与飞升专用 AscensionService.revert 区别：
 *   - AscensionService.revert：仅飞升失败状态可回溯，重置飞升进度
 *   - NascentSoulService.tianjiRevert：仅元婴后期虚弱/残魂过低时可用，不重置任何进度，只清状态
 */
router.post('/tianji-revert', auth, async (req, res, next) => {
    try {
        const result = await NascentSoulService.tianjiRevert(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
