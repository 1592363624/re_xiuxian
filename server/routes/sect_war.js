/**
 * 宗门战玩家路由
 *
 * 提供宗门战/领地争夺系统的玩家侧接口（参考 docs/批次2_多人玩法设计方案.md 第三章）：
 *   1. GET    /season/current        - 获取当前赛季信息
 *   2. GET    /season/ranking        - 获取赛季宗门排行（query: season_id, limit）
 *   3. GET    /territories           - 获取所有资源点列表（含归属/占领状态）
 *   4. GET    /mysect                - 获取我的宗门战信息（成员/资金/战绩）
 *   5. GET    /wars                  - 获取战役列表（query: status=all|preparing|announced|active|settled）
 *   6. GET    /wars/:warId           - 获取战役详情（双方信息/参战名单/资源点状态）
 *   7. POST   /wars                  - 宣战（宗主权限，body: defender_sect_id, target_territory_id?）
 *   8. POST   /wars/:warId/join      - 加入战役（自动分配阵营）
 *   9. POST   /wars/:warId/leave     - 离开战役（仅 preparing/announced 阶段可离开）
 *  10. POST   /wars/:warId/attack    - 攻击敌方玩家（body: target_player_id, action=attack|skill|defend）
 *  11. POST   /wars/:warId/capture   - 占领资源点（body: territory_id，30秒计时）
 *  12. POST   /wars/:warId/surrender - 投降（认输，对方获胜）
 *  13. GET    /myrecords             - 获取我的历史战役记录（query: page, limit）
 *
 * 权限：所有接口需要 auth 中间件验证 JWT
 * 设计：路由层只做参数提取与响应包装，业务逻辑全部在 SectWarService 中
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SectWarService = require('../game/services/SectWarService');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

/**
 * GET /api/sect-war/season/current
 * 获取当前宗门战赛季信息
 * 返回：赛季ID/名称/起止日期/状态/总战役数
 */
router.get('/season/current', auth, async (req, res, next) => {
    try {
        const result = await SectWarService.getCurrentSeason();
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/sect-war/season/ranking
 * 获取赛季宗门排行
 * query: season_id（可选，默认当前赛季）, limit=100（最大500）
 */
router.get('/season/ranking', auth, async (req, res, next) => {
    try {
        const seasonId = parseInt(req.query.season_id);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 100), 500);

        // season_id 缺省时自动取当前赛季
        let targetSeasonId = seasonId;
        if (!targetSeasonId) {
            const current = await SectWarService.getCurrentSeason();
            if (!current) {
                return res.json({ code: 200, data: { ranking: [], season: null } });
            }
            targetSeasonId = current.season_id || current.id;
        }

        const result = await SectWarService.getSeasonRanking(targetSeasonId, limit);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/sect-war/territories
 * 获取所有资源点列表
 * 返回：每个资源点的归属宗门/占领状态/产出/防御等级
 */
router.get('/territories', auth, async (req, res, next) => {
    try {
        const result = await SectWarService.getTerritories();
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/sect-war/mysect
 * 获取我的宗门战信息
 * 返回：宗门ID/名称/角色/资金/成员数/赛季战绩
 */
router.get('/mysect', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const result = await SectWarService.getMySectInfo(playerId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/sect-war/wars
 * 获取战役列表
 * query: status=all|preparing|announced|active|settled（默认 all）, page=1, limit=20
 */
router.get('/wars', auth, async (req, res, next) => {
    try {
        const allowedStatus = ['all', 'preparing', 'announced', 'active', 'settled'];
        const status = allowedStatus.includes(req.query.status) ? req.query.status : 'all';
        const page = Math.min(Math.max(1, parseInt(req.query.page) || 1), 100);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);

        const result = await SectWarService.getWarList(status, page, limit);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/sect-war/wars/:warId
 * 获取战役详情
 * 包含：基础信息/双方宗门/参战名单/资源点占领状态/战斗记录
 */
router.get('/wars/:warId', auth, async (req, res, next) => {
    try {
        const warId = parseInt(req.params.warId);
        if (!warId || warId <= 0) {
            throw new AppError('战役ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectWarService.getWarDetail(warId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/sect-war/wars
 * 宣战（宗主权限）
 * body: { defender_sect_id: string, target_territory_id?: number }
 * 返回：宣战结果（战役ID/扣款金额/战斗开始时间）
 */
router.post('/wars', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const defenderSectId = req.body.defender_sect_id;
        const targetTerritoryId = req.body.target_territory_id
            ? parseInt(req.body.target_territory_id)
            : null;

        // 参数校验
        if (!defenderSectId) {
            throw new AppError('防守方宗门ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 防注入：defenderSectId 限定为字符串格式校验
        if (typeof defenderSectId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(defenderSectId)) {
            throw new AppError('防守方宗门ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // target_territory_id 可选，但若提供必须为正整数
        if (targetTerritoryId !== null && (!Number.isInteger(targetTerritoryId) || targetTerritoryId <= 0)) {
            throw new AppError('目标资源点ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectWarService.declareWar(playerId, defenderSectId, targetTerritoryId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/sect-war/wars/:warId/join
 * 加入战役
 * 自动分配阵营：攻方宗门成员→attacker，守方宗门成员→defender
 */
router.post('/wars/:warId/join', auth, async (req, res, next) => {
    try {
        const warId = parseInt(req.params.warId);
        if (!warId || warId <= 0) {
            throw new AppError('战役ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const result = await SectWarService.joinWar(playerId, warId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/sect-war/wars/:warId/leave
 * 离开战役
 * 仅 preparing/announced 阶段可离开；active 阶段离开视为逃跑（视配置扣荣誉）
 */
router.post('/wars/:warId/leave', auth, async (req, res, next) => {
    try {
        const warId = parseInt(req.params.warId);
        if (!warId || warId <= 0) {
            throw new AppError('战役ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const result = await SectWarService.leaveWar(playerId, warId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/sect-war/wars/:warId/attack
 * 攻击敌方玩家
 * body: { target_player_id: number, action: 'attack'|'skill'|'defend' }
 * 返回：伤害/对方反击/是否击杀/获得荣誉等
 */
router.post('/wars/:warId/attack', auth, async (req, res, next) => {
    try {
        const warId = parseInt(req.params.warId);
        if (!warId || warId <= 0) {
            throw new AppError('战役ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const attackerId = req.player.id;
        const targetPlayerId = parseInt(req.body.target_player_id);
        const action = req.body.action || 'attack';

        if (!targetPlayerId || targetPlayerId <= 0) {
            throw new AppError('目标玩家ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectWarService.attackPlayer(attackerId, warId, targetPlayerId, action);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/sect-war/wars/:warId/capture
 * 占领资源点
 * body: { territory_id: number }
 * 返回：占领开始（30秒倒计时）/占领完成/被中断
 */
router.post('/wars/:warId/capture', auth, async (req, res, next) => {
    try {
        const warId = parseInt(req.params.warId);
        if (!warId || warId <= 0) {
            throw new AppError('战役ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const territoryId = parseInt(req.body.territory_id);
        if (!territoryId || territoryId <= 0) {
            throw new AppError('资源点ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const result = await SectWarService.captureTerritory(playerId, warId, territoryId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/sect-war/wars/:warId/surrender
 * 投降（认输）
 * 仅攻方宗主可调用，对方获胜获得 war_chest
 */
router.post('/wars/:warId/surrender', auth, async (req, res, next) => {
    try {
        const warId = parseInt(req.params.warId);
        if (!warId || warId <= 0) {
            throw new AppError('战役ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const playerId = req.player.id;
        const result = await SectWarService.surrender(playerId, warId);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/sect-war/myrecords
 * 获取我的历史战役记录
 * query: page=1, limit=20
 * 返回：玩家参与过的战役列表（含个人战绩）
 */
router.get('/myrecords', auth, async (req, res, next) => {
    try {
        const playerId = req.player.id;
        const page = Math.min(Math.max(1, parseInt(req.query.page) || 1), 100);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);

        const result = await SectWarService.getMyWarRecords(playerId, page, limit);
        res.json({ code: 200, data: result });
    } catch (err) {
        next(err);
    }
});

module.exports = router;


