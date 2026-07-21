/**
 * 太一门引道路由
 *
 * 对应玩法文档第25节"太一门引道"——五行道途+神识联动+多人共鸣
 * 路由前缀：/api/taoism-gate
 *
 * 接口列表（8个，全部需要 auth 鉴权）：
 *   1. GET  /profile       - 获取道途面板
 *   2. POST /choose        - 选择道途（首次选择，免费）
 *   3. POST /switch        - 切换道途（每月1次免费，之后消耗法则碎片）
 *   4. POST /cultivate     - 引道修炼（消耗神识获得道途经验）
 *   5. POST /skill         - 使用道途技能
 *   6. GET  /tasks         - 获取今日任务
 *   7. POST /tasks/claim   - 领取任务奖励
 *   8. GET  /ranking       - 获取道途排行榜
 *   9. GET  /resonance     - 查询道途共鸣状态
 *
 * 设计要点：
 *   - 所有接口必须 auth 鉴权，业务逻辑全部在 TaoismGateService 中实现
 *   - 路由层只做参数提取与转发，不处理业务逻辑
 *   - 错误响应统一：{ code, success:false, message }
 *   - 成功响应统一：{ code:200, message, data }
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const TaoismGateService = require('../game/services/TaoismGateService');
const { ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一响应包装：将 Service 返回的 {success:false,message} 转为 400 响应
 * 将 {data} 转为 200 响应
 * @param {object} res - express response 对象
 * @param {object} result - Service 返回的结果
 */
function sendServiceResult(res, result) {
    if (result.success === false) {
        return res.status(result.code || 400).json({
            code: result.code || 400,
            success: false,
            message: result.message
        });
    }
    return res.status(200).json({
        code: 200,
        message: result.message || 'success',
        ...result
    });
}

// ==================== 道途管理接口 ====================

/**
 * GET /api/taoism-gate/profile
 * 获取道途面板（道途/等级/经验/技能/任务/共鸣信息）
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await TaoismGateService.getProfile(req.player);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 获取道途面板失败:', e);
        next(e);
    }
});

/**
 * POST /api/taoism-gate/choose
 * 选择道途（首次选择，免费）
 * Body: { dao_path: 'metal'|'wood'|'water'|'fire'|'earth' }
 * 校验：
 *   - 玩家境界达到元婴期（rank 18）
 *   - 神识达到200
 *   - 尚未选择过道途
 */
router.post('/choose', auth, async (req, res, next) => {
    try {
        const { dao_path } = req.body;
        if (!dao_path || typeof dao_path !== 'string') {
            return res.status(400).json({
                code: 400,
                success: false,
                message: '参数不完整：需要 dao_path（metal/wood/water/fire/earth）'
            });
        }

        const result = await TaoismGateService.choosePath(req.player, dao_path);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 选择道途失败:', e);
        next(e);
    }
});

/**
 * POST /api/taoism-gate/switch
 * 切换道途（每月1次免费，之后消耗100五行法则碎片，7天冷却）
 * Body: { dao_path: 'metal'|'wood'|'water'|'fire'|'earth' }
 * 切换后等级重置为1，保留50%经验
 */
router.post('/switch', auth, async (req, res, next) => {
    try {
        const { dao_path } = req.body;
        if (!dao_path || typeof dao_path !== 'string') {
            return res.status(400).json({
                code: 400,
                success: false,
                message: '参数不完整：需要 dao_path'
            });
        }

        const result = await TaoismGateService.switchPath(req.player, dao_path);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 切换道途失败:', e);
        next(e);
    }
});

/**
 * POST /api/taoism-gate/cultivate
 * 引道修炼（消耗50神识获得道途经验，每日5次上限）
 * 返回：获得经验/新等级/剩余神识
 */
router.post('/cultivate', auth, async (req, res, next) => {
    try {
        const result = await TaoismGateService.cultivate(req.player);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 引道修炼失败:', e);
        next(e);
    }
});

/**
 * POST /api/taoism-gate/skill
 * 使用道途技能（消耗神识，按道途不同有不同效果）
 * Body: { target_player_id?: number, target_beast_id?: number }
 *   - 金道/土道：需 target_player_id + target_beast_id
 *   - 木道：需 target_beast_id（自己灵兽）
 *   - 水道：无需参数
 *   - 火道：需 target_player_id
 */
router.post('/skill', auth, async (req, res, next) => {
    try {
        const targetPlayerId = req.body.target_player_id ? parseInt(req.body.target_player_id) : null;
        const targetBeastId = req.body.target_beast_id ? parseInt(req.body.target_beast_id) : null;

        const result = await TaoismGateService.useSkill(req.player, targetPlayerId, targetBeastId);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 使用技能失败:', e);
        next(e);
    }
});

/**
 * GET /api/taoism-gate/tasks
 * 获取今日任务（每日3个，跨日重置）
 */
router.get('/tasks', auth, async (req, res, next) => {
    try {
        const result = await TaoismGateService.getDailyTasks(req.player);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 获取任务失败:', e);
        next(e);
    }
});

/**
 * POST /api/taoism-gate/tasks/claim
 * 领取任务奖励
 * Body: { task_index: number }
 */
router.post('/tasks/claim', auth, async (req, res, next) => {
    try {
        const taskIndex = parseInt(req.body.task_index);
        if (isNaN(taskIndex) || taskIndex < 0) {
            return res.status(400).json({
                code: 400,
                success: false,
                message: '参数不完整：需要 task_index（非负整数）'
            });
        }

        const result = await TaoismGateService.claimTaskReward(req.player, taskIndex);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 领取任务奖励失败:', e);
        next(e);
    }
});

/**
 * GET /api/taoism-gate/ranking
 * 获取道途排行榜
 * Query: category=dao_level|total_skill_use|total_resonance, page=1, page_size=20
 */
router.get('/ranking', auth, async (req, res, next) => {
    try {
        const category = req.query.category || 'dao_level';
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 20));

        const result = await TaoismGateService.getRanking(category, page, pageSize);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 获取排行榜失败:', e);
        next(e);
    }
});

/**
 * GET /api/taoism-gate/resonance
 * 查询道途共鸣状态（同道途玩家数+共鸣加成+相克目标）
 */
router.get('/resonance', auth, async (req, res, next) => {
    try {
        const result = await TaoismGateService.getResonance(req.player);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[太一门] 获取共鸣状态失败:', e);
        next(e);
    }
});

module.exports = router;
