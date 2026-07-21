/**
 * 道侣/双修系统玩家路由
 *
 * 提供玩家端道侣系统的 10 个 HTTP 接口（路由前缀 /api/dao-companion）：
 *   1.  POST /api/dao-companion/propose                       - 求婚
 *   2.  POST /api/dao-companion/respond                        - 响应求婚（accept/refuse）
 *   3.  GET  /api/dao-companion/my                             - 我的道侣信息
 *   4.  POST /api/dao-companion/interact                       - 道侣互动（每日问安）
 *   5.  POST /api/dao-companion/dual-cultivation               - 双修
 *   6.  POST /api/dao-companion/break                          - 解除道侣关系
 *   7.  GET  /api/dao-companion/proposals                      - 我收到的求婚列表
 *   8.  POST /api/dao-companion/heart-tribulation/respond      - 心劫抉择
 *   9.  GET  /api/dao-companion/heart-tribulation/status       - 心劫状态
 *  10.  POST /api/dao-companion/heart-imprint                  - 凝聚心印
 *
 * 设计原则：
 *   - 路由层仅做参数校验与调用 Service，业务逻辑在 DaoCompanionService 中
 *   - 所有接口必须通过 auth 中间件鉴权
 *   - 统一响应格式 { code, message, data }
 *   - 业务错误用 AppError + ErrorCodes，统一通过 sendServiceResult 包装
 *   - 禁止使用浏览器原生弹窗，所有提示通过返回值传递给前端
 *
 * 与 server/routes/companion.js 区别：
 *   - 旧 companion 路由用于批次3 道侣/侍妾系统（寻侣/双修/温养/采补/立誓/心契/心劫）
 *   - 新 dao_companion 路由用于"道侣/双修系统"重做版（求婚/响应/互动/双修/解除/心劫/心印）
 *   - 数据表分离：旧表 dao_companion（无 intimacy），新表 dao_companions（含 intimacy 0-100）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const DaoCompanionService = require('../game/services/DaoCompanionService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * 统一包装 Service 返回结果为 HTTP 响应
 * 业务失败仍返回 HTTP 200，由 code/success 区分（与 spirit_beast.js 路由保持一致）
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
 * 1. POST /api/dao-companion/propose
 * 求婚：创建 pending 状态的 dao_companions 记录
 * 请求体：{ target_player_id: number }
 * 校验：境界最低 rank 15（结丹期）/双方无活跃道侣/外发求婚≤1/解除冷却期7天
 */
router.post('/propose', auth, async (req, res, next) => {
    try {
        const targetPlayerId = Number(req.body.target_player_id);
        if (!targetPlayerId || Number.isNaN(targetPlayerId)) {
            throw new AppError('target_player_id 必填且必须为数字', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await DaoCompanionService.propose(req.player.id, targetPlayerId);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 2. POST /api/dao-companion/respond
 * 响应求婚：accept 时 status → accepted 并设置初始亲密度
 * 请求体：{ proposal_id: number, action: 'accept' | 'refuse' }
 */
router.post('/respond', auth, async (req, res, next) => {
    try {
        const proposalId = Number(req.body.proposal_id);
        const action = req.body.action;
        if (!proposalId || Number.isNaN(proposalId)) {
            throw new AppError('proposal_id 必填且必须为数字', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!['accept', 'refuse'].includes(action)) {
            throw new AppError('action 必须为 accept 或 refuse', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await DaoCompanionService.respond(req.player.id, proposalId, action);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 3. GET /api/dao-companion/my
 * 我的道侣信息：道侣详情 + 对方玩家信息 + 双修加成比例 + 各项冷却剩余
 * 无道侣时返回 has_companion=false + 境界是否满足求婚要求
 */
router.get('/my', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.getMyCompanion(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 4. POST /api/dao-companion/interact
 * 道侣互动（每日问安/灵力反哺）
 * 24 小时冷却，亲密度+2，双方各获得少量修为
 */
router.post('/interact', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.interact(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 5. POST /api/dao-companion/dual-cultivation
 * 双修（双人闭关）
 * 双方必须都在线，且未闭关/未战斗/未双修
 * 收益公式：duration × base_exp_rate × 1.5 × (1 + intimacy/200) × realmMultiplier × (1 + heart_contract_level × 0.05)
 */
router.post('/dual-cultivation', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.dualCultivate(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 6. POST /api/dao-companion/break
 * 解除道侣关系
 * 单方面解除，亲密度-20 惩罚，7 天冷却期不能再次求婚
 */
router.post('/break', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.breakCompanion(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 7. GET /api/dao-companion/proposals
 * 我收到的求婚列表：返回 pending 状态的求婚记录 + 求婚方玩家信息
 */
router.get('/proposals', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.getProposals(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 8. POST /api/dao-companion/heart-tribulation/respond
 * 心劫抉择
 * 请求体：{ event_id: number, option: 'trust' | 'doubt' | 'trial' }
 * 三选项含不同成功率与奖惩，影响亲密度和心契等级
 */
router.post('/heart-tribulation/respond', auth, async (req, res, next) => {
    try {
        const eventId = Number(req.body.event_id);
        const option = req.body.option;
        if (!eventId || Number.isNaN(eventId)) {
            throw new AppError('event_id 必填且必须为数字', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!['trust', 'doubt', 'trial'].includes(option)) {
            throw new AppError('option 必须为 trust / doubt / trial 之一', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await DaoCompanionService.respondHeartTribulation(req.player.id, eventId, option);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 9. GET /api/dao-companion/heart-tribulation/status
 * 心劫状态查询：返回当前是否有 pending 心劫事件 + 选项详情
 */
router.get('/heart-tribulation/status', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.getHeartTribulationStatus(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 10. POST /api/dao-companion/heart-imprint
 * 凝聚心印
 * 亲密度>=80 时可凝聚，消耗双方各 1000 修为
 * heart_imprint_count+1，每 3 个心印提升 1 级心契（上限 9 级）
 */
router.post('/heart-imprint', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.condenseHeartImprint(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 11. GET /api/dao-companion/protect-logs
 * 查询护道日志（设计文档 5.6.1 心契 L2 解锁护道机制）
 *
 * 查询参数：
 *   - page: 页码（默认 1）
 *   - limit: 每页条数（默认 10，上限 50）
 *   - role: 角色（all/defender/protector，默认 all）
 *
 * 返回：玩家作为 defender（被护道）或 protector（护道他人）的护道历史
 */
router.get('/protect-logs', auth, async (req, res, next) => {
    try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 10;
        const role = req.query.role || 'all';
        // 参数校验
        if (!['all', 'defender', 'protector'].includes(role)) {
            throw new AppError('role 参数必须为 all / defender / protector', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const result = await DaoCompanionService.getProtectLogs(req.player.id, { page, limit, role });
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

/**
 * 12. GET /api/dao-companion/protect-stats
 * 查询护道统计（玩家作为被护道方/护道方的综合数据）
 *
 * 返回：
 *   - as_defender: 被护道次数、累计分担伤害、累计反击伤害、最后护道时间
 *   - as_protector: 护道他人次数、累计分担伤害、累计反击伤害、最后护道时间
 */
router.get('/protect-stats', auth, async (req, res, next) => {
    try {
        const result = await DaoCompanionService.getProtectStats(req.player.id);
        sendServiceResult(result, res);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
