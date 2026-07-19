/**
 * 副本系统路由
 *
 * 提供玩家端副本挑战玩法的 HTTP 接口：
 * 1. GET    /api/dungeon/config：获取副本全局配置与章节列表（前端展示规则用）
 * 2. GET    /api/dungeon/status：查询玩家副本状态总览（进行中进度、通关记录、冷却、次数）
 * 3. POST   /api/dungeon/start：开始副本挑战（章节ID + 难度）
 * 4. GET    /api/dungeon/current-node：获取当前节点内容（剧情/战斗/解谜/BOSS/奖励）
 * 5. POST   /api/dungeon/choose-option：解谜节点选项选择
 * 6. POST   /api/dungeon/advance：推进 story/reward 节点
 * 7. POST   /api/dungeon/battle：执行 battle/boss 节点战斗
 * 8. POST   /api/dungeon/interrupt：主动中断副本（按失败结算，补偿50%修为）
 * 9. POST   /api/dungeon/sweep：扫荡已三星通关的副本（按比例发放奖励）
 * 10. GET   /api/dungeon/history：查询通关历史记录
 *
 * 设计原则：路由层仅做参数校验与调用 Service，业务逻辑在 DungeonService 中
 * 互斥校验由 PlayerStateMachine 统一处理，本路由在 startDungeon 内部通过 Service 调用 canStart 检查
 *
 * 对应玩法文档：第6章（副本系统）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const DungeonService = require('../game/services/DungeonService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * @param {Object} result - Service 返回的 { success, message, data, error_code }
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
 * GET /api/dungeon/config
 * 获取副本全局配置与章节列表
 * 该接口为只读操作，不需要状态机校验，未登录也可查看（用于展示规则）
 */
router.get('/config', async (req, res, next) => {
    try {
        const config = DungeonService.getConfig();
        res.json({
            code: 200,
            data: config
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/dungeon/status
 * 查询玩家副本状态总览（进行中进度、通关记录、冷却、次数）
 * 该接口为只读操作，不需要状态机互斥校验
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const status = await DungeonService.getStatus(req.player);
        res.json({
            code: 200,
            data: status
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/dungeon/start
 * 开始副本挑战
 * 请求体：{ chapter_id: string, difficulty: 'normal' | 'hard' | 'nightmare' }
 *
 * 状态机校验：在 Service 内部通过 PlayerStateMachine.canStart(IN_DUNGEON) 校验
 * 确保与闭关/战斗/历练/移动/悟道/PVP/元婴出窍等状态互斥
 */
router.post('/start', auth, async (req, res, next) => {
    try {
        const { chapter_id, difficulty } = req.body;

        // 参数校验
        if (!chapter_id || typeof chapter_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'chapter_id 必填且必须为字符串'
            });
        }
        const validDifficulties = ['normal', 'hard', 'nightmare'];
        if (!difficulty || !validDifficulties.includes(difficulty)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `difficulty 必填，可选值：${validDifficulties.join('/')}`
            });
        }

        const result = await DungeonService.startDungeon(req.player, chapter_id, difficulty);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/dungeon/current-node
 * 获取当前关卡节点内容（剧情/战斗/解谜/BOSS/奖励）
 * 玩家在副本中时调用，返回当前节点的渲染内容
 */
router.get('/current-node', auth, async (req, res, next) => {
    try {
        const result = await DungeonService.getCurrentNode(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/dungeon/choose-option
 * 解谜节点选项选择
 * 请求体：{ option_id: string }
 * 根据玩家选择的选项，应用 HP/MP 变化与奖励，并推进到下一节点
 */
router.post('/choose-option', auth, async (req, res, next) => {
    try {
        const { option_id } = req.body;
        if (!option_id || typeof option_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'option_id 必填且必须为字符串'
            });
        }

        const result = await DungeonService.chooseOption(req.player, option_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/dungeon/advance
 * 推进 story/reward 节点
 * - story 节点：阅读剧情后推进到下一节点
 * - reward 节点：领取奖励后推进到下一节点
 * - battle/boss/puzzle 节点：返回错误（需先调用对应接口完成节点）
 */
router.post('/advance', auth, async (req, res, next) => {
    try {
        const result = await DungeonService.advanceNode(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/dungeon/battle
 * 执行 battle/boss 节点战斗
 * 简化回合制战斗，根据玩家属性与怪物属性计算结果
 * 战斗结果直接更新玩家在副本中的 HP，胜利则推进到下一节点
 */
router.post('/battle', auth, async (req, res, next) => {
    try {
        const result = await DungeonService.battleNode(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/dungeon/interrupt
 * 主动中断副本
 * 玩家放弃挑战时调用，按失败结算，补偿50%积累修为
 * 不发放物品与灵石，避免刷奖励
 */
router.post('/interrupt', auth, async (req, res, next) => {
    try {
        const result = await DungeonService.interruptDungeon(req.player);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/dungeon/sweep
 * 扫荡已三星通关的副本
 * 请求体：{ chapter_id: string, difficulty: 'normal' | 'hard' | 'nightmare' }
 * 三星通关后可扫荡，奖励按 sweep_reward_ratio 比例发放
 */
router.post('/sweep', auth, async (req, res, next) => {
    try {
        const { chapter_id, difficulty } = req.body;
        if (!chapter_id || typeof chapter_id !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'chapter_id 必填且必须为字符串'
            });
        }
        const validDifficulties = ['normal', 'hard', 'nightmare'];
        if (!difficulty || !validDifficulties.includes(difficulty)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: `difficulty 必填，可选值：${validDifficulties.join('/')}`
            });
        }

        const result = await DungeonService.sweepDungeon(req.player, chapter_id, difficulty);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/dungeon/history
 * 查询通关历史记录
 * 查询参数：?limit=20（最多50条）
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const result = await DungeonService.getHistory(req.player, limit);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
