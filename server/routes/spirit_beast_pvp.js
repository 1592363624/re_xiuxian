/**
 * 灵兽PVP竞技场路由
 *
 * 对应玩法文档第8节"灵兽PVP对战"和第9节"战斗与风险"
 * 路由前缀：/api/spirit-beast/pvp
 *
 * 接口列表（8个，全部需要 auth 鉴权）：
 *   1. GET  /profile          - 获取玩家PVP档案（段位/胜点/战绩/今日挑战次数）
 *   2. GET  /ranking          - 获取赛季排行榜
 *   3. GET  /history          - 获取对局历史
 *   4. GET  /season           - 获取当前赛季信息
 *   5. POST /challenge        - 发起挑战（核心接口）
 *   6. GET  /tactics          - 获取可用战术列表
 *   7. GET  /tiers            - 获取段位信息
 *   8. GET  /match/:matchId   - 获取对局详情（含战斗日志）
 */
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const SpiritBeastPvpService = require('../game/services/SpiritBeastPvpService');

/**
 * 统一响应包装：将 Service 返回的 {success:false,message} 转为 400 响应
 * 将 {data} 转为 200 响应
 */
function sendServiceResult(res, result) {
    if (result.success === false) {
        return res.status(400).json({
            code: 400,
            success: false,
            message: result.message
        });
    }
    return res.status(200).json({
        code: 200,
        ...result
    });
}

// ==================== 玩家接口 ====================

/**
 * GET /api/spirit-beast/pvp/profile
 * 获取玩家PVP档案
 * 返回：当前赛季信息 + 玩家段位/胜点/战绩/今日挑战次数
 */
router.get('/profile', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastPvpService.getProfile(req.player);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽PVP] 获取档案失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pvp/ranking
 * 获取赛季排行榜
 * Query: page=1, page_size=20
 */
router.get('/ranking', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 20));
        const result = await SpiritBeastPvpService.getRanking(req.player, page, pageSize);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽PVP] 获取排行榜失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pvp/history
 * 获取对局历史
 * Query: page=1, page_size=10
 */
router.get('/history', auth, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 10));
        const result = await SpiritBeastPvpService.getHistory(req.player, page, pageSize);
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽PVP] 获取历史失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pvp/season
 * 获取当前赛季信息
 */
router.get('/season', auth, async (req, res, next) => {
    try {
        const result = await SpiritBeastPvpService.getSeasonInfo();
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽PVP] 获取赛季信息失败:', e);
        next(e);
    }
});

/**
 * POST /api/spirit-beast/pvp/challenge
 * 发起挑战（核心接口）
 * Body:
 *   - target_player_id: number  目标玩家ID（必填）
 *   - beast_id: number          挑战方灵兽ID（必填）
 *   - tactic: string            战术 all_out/balanced/counter（默认 balanced）
 *   - bet_spirit_stones: number 押注灵石（0=友谊赛）
 *   - is_friendly: boolean      是否友谊赛（默认 false）
 */
router.post('/challenge', auth, async (req, res, next) => {
    try {
        const { target_player_id, beast_id, tactic, bet_spirit_stones, is_friendly } = req.body;
        if (!target_player_id) {
            return res.status(400).json({ code: 400, success: false, message: '缺少 target_player_id' });
        }
        if (!beast_id) {
            return res.status(400).json({ code: 400, success: false, message: '缺少 beast_id' });
        }
        const result = await SpiritBeastPvpService.challenge(
            req.player,
            Number(target_player_id),
            Number(beast_id),
            tactic || 'balanced',
            Number(bet_spirit_stones) || 0,
            Boolean(is_friendly)
        );
        return sendServiceResult(res, result);
    } catch (e) {
        console.error('[灵兽PVP] 发起挑战失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pvp/tactics
 * 获取可用战术列表
 */
router.get('/tactics', auth, async (req, res, next) => {
    try {
        const config = SpiritBeastPvpService.config;
        if (!config) {
            return res.status(500).json({ code: 500, message: '服务未初始化' });
        }
        const tactics = Object.entries(config.tactics.options).map(([key, val]) => ({
            key,
            name: val.name,
            description: val.description,
            atk_multiplier: val.atk_multiplier,
            def_multiplier: val.def_multiplier,
            hit_penalty: val.hit_penalty || 0,
            crit_bonus: val.crit_bonus || 0,
            counter_chance: val.counter_chance || 0,
            counter_damage_ratio: val.counter_damage_ratio || 0
        }));
        return res.status(200).json({ code: 200, data: { tactics } });
    } catch (e) {
        console.error('[灵兽PVP] 获取战术列表失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pvp/tiers
 * 获取段位信息
 */
router.get('/tiers', auth, async (req, res, next) => {
    try {
        const config = SpiritBeastPvpService.config;
        if (!config) {
            return res.status(500).json({ code: 500, message: '服务未初始化' });
        }
        const tiers = config.tiers.map(t => ({
            key: t.key,
            name: t.name,
            min_points: t.min_points,
            max_points: t.max_points,
            color: t.color,
            season_reward_spirit_stones: t.season_reward_spirit_stones
        }));
        return res.status(200).json({ code: 200, data: { tiers } });
    } catch (e) {
        console.error('[灵兽PVP] 获取段位信息失败:', e);
        next(e);
    }
});

/**
 * GET /api/spirit-beast/pvp/match/:matchId
 * 获取对局详情（含战斗日志）
 */
router.get('/match/:matchId', auth, async (req, res, next) => {
    try {
        const SpiritBeastPvpMatch = require('../models/spiritBeastPvpMatch');
        const { Op } = require('sequelize');
        const match = await SpiritBeastPvpMatch.findByPk(req.params.matchId);
        if (!match) {
            return res.status(404).json({ code: 404, success: false, message: '对局不存在' });
        }
        // 仅允许参与者查看
        if (match.challenger_player_id !== req.player.id && match.defender_player_id !== req.player.id) {
            return res.status(403).json({ code: 403, success: false, message: '无权查看他人对局' });
        }
        return res.status(200).json({
            code: 200,
            data: {
                match_id: match.id,
                season_id: match.season_id,
                challenger_player_id: match.challenger_player_id,
                challenger_beast: match.challenger_beast_snapshot,
                challenger_tactic: match.challenger_tactic,
                defender_player_id: match.defender_player_id,
                defender_beast: match.defender_beast_snapshot,
                defender_tactic: match.defender_tactic,
                bet_spirit_stones: match.bet_spirit_stones.toString(),
                is_friendly: match.is_friendly,
                status: match.status,
                winner_player_id: match.winner_player_id,
                winner_side: match.winner_side,
                total_rounds: match.total_rounds,
                final_challenger_hp: match.final_challenger_hp.toString(),
                final_defender_hp: match.final_defender_hp.toString(),
                battle_log: match.battle_log,
                points_change: match.points_change,
                created_at: match.created_at,
                finished_at: match.finished_at
            }
        });
    } catch (e) {
        console.error('[灵兽PVP] 获取对局详情失败:', e);
        next(e);
    }
});

module.exports = router;
