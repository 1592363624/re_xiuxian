/**
 * 多人副本系统玩家路由
 *
 * 提供玩家端多人副本系统的 13 个 HTTP 接口：
 *   1. GET  /api/multi-dungeon/help：副本规则说明
 *   2. POST /api/multi-dungeon/create：队长开启副本
 *   3. POST /api/multi-dungeon/join：队员加入副本
 *   4. POST /api/multi-dungeon/enter：队长进入开打
 *   5. GET  /api/multi-dungeon/status：查看当前副本进度
 *   6. POST /api/multi-dungeon/choose：队长推进抉择
 *   7. POST /api/multi-dungeon/advance：队长触发自动决战（昆吾山第四幕专用）
 *   8. POST /api/multi-dungeon/throw-zongzi：端午投粽
 *   9. POST /api/multi-dungeon/dissolve：队长解散副本
 *  10. POST /api/multi-dungeon/kick：队长踢人
 *  11. GET  /api/multi-dungeon/rewards：查看奖励池
 *  12. GET  /api/multi-dungeon/history：历史副本记录
 *  13. GET  /api/multi-dungeon/cooldown：查询冷却状态
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 MultiDungeonService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *
 * 对应玩法文档：批次3设计文档第6.6节（多人副本 API 接口设计）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const MultiDungeonService = require('../game/services/MultiDungeonService');
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
 * GET /api/multi-dungeon/help
 * 副本规则说明：返回所有副本的玩法概要、前置条件、状态机
 * 该接口为只读操作
 */
router.get('/help', auth, async (req, res, next) => {
    try {
        const result = await MultiDungeonService.getHelp();
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/create
 * 队长开启副本
 * 请求体：{ dungeon_key: 'yanyue' | 'duanwu' | 'kunwu' | 'xutian' | 'xiaoji' | 'luoyun' | 'cangkun' | 'xuese' | 'zhuimo' | 'huanglong' }
 * 2026-07-21 扩展：新增 xutian（虚天殿）/ xiaoji（北冥小极宫）/ luoyun（落云秘圃）/ cangkun（苍坤洞府）/ xuese（血色试炼）/ zhuimo（坠魔谷）/ huanglong（黄龙山）
 */
router.post('/create', auth, async (req, res, next) => {
    try {
        const { dungeon_key } = req.body;
        // 2026-07-21 白名单扩展：支持 xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian', 'xiaoji', 'luoyun', 'cangkun', 'xuese', 'zhuimo', 'huanglong'].includes(dungeon_key)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'dungeon_key 必须为 yanyue(掩月抢亲) / duanwu(端午镇蛟) / kunwu(昆吾山·封魔塔) / xutian(虚天殿) / xiaoji(北冥小极宫) / luoyun(落云秘圃) / cangkun(苍坤洞府) / xuese(血色试炼) / zhuimo(坠魔谷) / huanglong(黄龙山)'
            });
        }
        const result = await MultiDungeonService.create(req.player.id, dungeon_key);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/join
 * 队员加入副本
 * 请求体：{ instance_id: number }
 */
router.post('/join', auth, async (req, res, next) => {
    try {
        const { instance_id } = req.body;
        if (!instance_id || typeof instance_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'instance_id 必填且必须为数字'
            });
        }
        const result = await MultiDungeonService.join(req.player.id, instance_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/enter
 * 队长进入开打（无请求体参数）
 * 端午副本需满 10 人 + 至少 1 个粽子；掩月需满足人数下限
 */
router.post('/enter', auth, async (req, res, next) => {
    try {
        const result = await MultiDungeonService.enter(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/multi-dungeon/status
 * 查看当前副本进度（变量、成员、当前幕抉择选项、历史抉择）
 */
router.get('/status', auth, async (req, res, next) => {
    try {
        const result = await MultiDungeonService.getStatus(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/choose
 * 队长推进抉择
 * 请求体：{ choice_key: string }
 * 昆吾山第三幕支持两种格式：
 *   - "baling_eye:suppress"（推荐，明确指定阵眼）
 *   - "suppress"（兼容写法，自动按阵眼顺序解析）
 */
router.post('/choose', auth, async (req, res, next) => {
    try {
        const { choice_key } = req.body;
        if (!choice_key || typeof choice_key !== 'string') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'choice_key 必填且必须为字符串'
            });
        }
        const result = await MultiDungeonService.choose(req.player.id, choice_key);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/advance
 * 队长触发自动决战（昆吾山第四幕 / 虚天殿第六幕 / 苍坤洞府第四幕 / 血色试炼第四幕 / 坠魔谷第四幕专用）
 * 请求体（可选）：{ escape_choice?: 'forced_breakout' | 'formation_escape' | 'stealth_escape' }
 *   - 苍坤洞府第四幕必须提供 escape_choice（脱身抉择），影响决战回合数与门票线索掉率
 *   - 其他副本无需该参数
 * 仅当前幕为 is_auto_advance 时允许调用
 * 一次性结算自动战斗回合，不可中途干预
 */
router.post('/advance', auth, async (req, res, next) => {
    try {
        const { escape_choice } = req.body || {};
        // 苍坤洞府脱身抉择参数校验（仅在调用时校验，最终是否必需由 Service 层根据副本类型判定）
        if (escape_choice !== undefined) {
            if (typeof escape_choice !== 'string' || !['forced_breakout', 'formation_escape', 'stealth_escape'].includes(escape_choice)) {
                return res.status(400).json({
                    code: 400,
                    error_code: ErrorCodes.VALIDATION_ERROR,
                    message: 'escape_choice 必须为 forced_breakout(强行突围) / formation_escape(借阵脱身) / stealth_escape(隐遁潜行)'
                });
            }
        }
        const result = await MultiDungeonService.advance(req.player.id, escape_choice);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/throw-zongzi
 * 端午投粽
 * 请求体：{ count: number(1-5) }
 */
router.post('/throw-zongzi', auth, async (req, res, next) => {
    try {
        const { count } = req.body;
        if (!Number.isInteger(count) || count < 1 || count > 5) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'count 必须为 1-5 之间的整数'
            });
        }
        const result = await MultiDungeonService.throwZongzi(req.player.id, count);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/dissolve
 * 队长解散副本（无请求体参数）
 * 幂等：已解散不报错
 */
router.post('/dissolve', auth, async (req, res, next) => {
    try {
        const result = await MultiDungeonService.dissolve(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/multi-dungeon/kick
 * 队长踢人
 * 请求体：{ target_player_id: number }
 */
router.post('/kick', auth, async (req, res, next) => {
    try {
        const { target_player_id } = req.body;
        if (!target_player_id || typeof target_player_id !== 'number') {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'target_player_id 必填且必须为数字'
            });
        }
        const result = await MultiDungeonService.kick(req.player.id, target_player_id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/multi-dungeon/rewards
 * 查看奖励池
 * 查询参数：?dungeon_key=yanyue|duanwu|kunwu|xutian|xiaoji|luoyun|cangkun|xuese|zhuimo|huanglong
 * 2026-07-21 扩展：新增 xutian（虚天殿）/ xiaoji（北冥小极宫）/ luoyun（落云秘圃）/ cangkun（苍坤洞府）/ xuese（血色试炼）/ zhuimo（坠魔谷）/ huanglong（黄龙山）
 */
router.get('/rewards', auth, async (req, res, next) => {
    try {
        const { dungeon_key } = req.query;
        // 2026-07-21 白名单扩展：支持 xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian', 'xiaoji', 'luoyun', 'cangkun', 'xuese', 'zhuimo', 'huanglong'].includes(dungeon_key)) {
            return res.status(400).json({
                code: 400,
                error_code: ErrorCodes.VALIDATION_ERROR,
                message: 'dungeon_key 必须为 yanyue / duanwu / kunwu / xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong'
            });
        }
        const result = await MultiDungeonService.getRewards(dungeon_key);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/multi-dungeon/history
 * 历史副本记录
 * 查询参数：?page=1&size=20
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const size = parseInt(req.query.size, 10) || 20;
        const result = await MultiDungeonService.getHistory(req.player.id, page, size);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/multi-dungeon/cooldown
 * 查询冷却状态
 * 2026-07-21 扩展：返回 yanyue / duanwu / kunwu / xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong 共10个副本键的当前冷却
 */
router.get('/cooldown', auth, async (req, res, next) => {
    try {
        const result = await MultiDungeonService.getCooldown(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
