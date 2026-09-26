/**
 * 管理员「立即完成」路由（GM 测试加速专用）
 *
 * 用途：
 *   闭关 / 静思悟道 / 历练 这三种「需要等一会儿」的挂机操作，测试时逐个等满时长非常耗时。
 *   本路由提供一个仅管理员可用的「时间加速」入口：把当前管理员自己正在进行中的耗时操作
 *   的时间戳前推，使其在结算时「看起来已经自然坐满了计划时长」。
 *
 * 设计原则（关键：不得影响本次操作的流程与结果）：
 *   1. 本路由**只调整时钟，不做任何结算**。奖励、状态流转、HP/MP 变化等一律仍由玩家侧原有的
 *      结算入口完成（闭关走 /api/seclusion/end，历练走 /api/explore/complete，
 *      悟道走 /api/admin/meditation/:playerId/force-settle）。
 *      这样「自然到点结算」与「加速后结算」走的是同一条代码路径，结果完全一致，不存在两套公式。
 *   2. 加速方式与自然完成对齐：
 *      - 闭关/悟道：结算按（now - start_time）计算实际时长，故把 start_time 前移到
 *        「now - 计划时长」，使实际时长 == 计划时长（深度闭关也因此不会触发强行出关惩罚）。
 *      - 历练：结算按（now < end_time）判定是否提前结束，故把 end_time 置为当前时间，
 *        使其等同于「已到点」，不再按比例折扣。
 *   3. 只作用于发起请求的管理员本人（req.player.id），不涉及任何其他玩家数据。
 *   4. 双层权限校验（auth + adminCheck）+ 操作日志审计。
 *
 * 接口列表：
 *   POST /api/admin/quick-finish  加速当前管理员自己进行中的耗时操作（仅调时钟）
 */
'use strict';

const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const PlayerAdventure = require('../models/playerAdventure');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const sequelize = require('../config/database');

/**
 * 管理员权限中间件（与 admin_meditation.js 保持一致的口径）
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 记录管理员操作日志（失败不影响主流程）
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            details: JSON.stringify(details),
            ip: req.ip || req.connection?.remoteAddress
        });
    } catch (error) {
        console.error('记录管理员日志失败:', error);
    }
}

/** 支持加速的耗时操作白名单，与前端顶部「进行中」计时条覆盖的范围一致 */
const SUPPORTED_STATES = ['seclusion', 'meditation', 'adventure'];

/**
 * 解析某项耗时操作的「计划时长」（秒）
 *
 * 优先取落库的计划时长字段；缺失时回退为「结束时间 - 开始时间」，
 * 两者都拿不到时返回 0（调用方据此跳过，避免把 start_time 前推到未知位置）。
 *
 * @param {string|Date|null} startTime - 开始时间
 * @param {string|Date|null} endTime - 结束时间
 * @param {number|string|null} plannedDuration - 落库的计划时长（秒）
 * @returns {number} 计划时长秒数，无法解析时为 0
 */
function resolvePlannedSeconds(startTime, endTime, plannedDuration) {
    const planned = Number(plannedDuration) || 0;
    if (planned > 0) return planned;

    const startMs = startTime ? new Date(startTime).getTime() : 0;
    const endMs = endTime ? new Date(endTime).getTime() : 0;
    if (startMs && endMs && endMs > startMs) {
        return Math.floor((endMs - startMs) / 1000);
    }
    return 0;
}

/**
 * POST /api/admin/quick-finish
 * 加速当前管理员自己进行中的耗时操作（闭关 / 悟道 / 历练）
 *
 * Request Body（可选）：
 *   { state?: 'seclusion' | 'meditation' | 'adventure' }
 *   不传时，自动加速当前所有进行中的耗时操作。
 *
 * Response：
 *   { code, message, data: { finished: [{ state, planned_seconds?, mode?, adventure_id? }], server_time } }
 *
 * @access Private（仅管理员）
 */
router.post('/quick-finish', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = req.player.id;
        const wanted = req.body?.state ? String(req.body.state) : null;

        // 参数校验：只允许白名单内的状态，避免误加速未知玩法
        if (wanted && !SUPPORTED_STATES.includes(wanted)) {
            await t.rollback();
            return res.status(400).json({
                code: 400,
                message: `不支持的操作类型：${wanted}（可选：${SUPPORTED_STATES.join(' / ')}）`
            });
        }

        const now = new Date();
        const finished = [];

        // 行级锁：防止与结算入口（/seclusion/end、force-settle）并发修改同一行
        const player = await Player.findByPk(playerId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!player) {
            await t.rollback();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        // ── 闭关：把 start_time 前移到「now - 计划时长」，使结算时实际时长 == 计划时长 ──
        if ((!wanted || wanted === 'seclusion') && player.is_secluded) {
            const planned = resolvePlannedSeconds(
                player.seclusion_start_time, player.seclusion_end_time, player.seclusion_duration
            );
            if (planned > 0) {
                // 注意：只改 start_time，不动 end_time —— 若把 end_time 也置为过去，
                // StateCleanerService 可能抢先自动结算，导致随后的 /seclusion/end 报「未在闭关中」
                player.seclusion_start_time = new Date(now.getTime() - planned * 1000);
                finished.push({
                    state: 'seclusion',
                    planned_seconds: planned,
                    mode: player.seclusion_mode || 'normal'
                });
            }
        }

        // ── 悟道：同闭关，前移 start_time，结算时完成度为 100% ──
        if ((!wanted || wanted === 'meditation') && player.is_meditating) {
            const planned = resolvePlannedSeconds(
                player.meditation_start_time, player.meditation_end_time, player.meditation_duration
            );
            if (planned > 0) {
                player.meditation_start_time = new Date(now.getTime() - planned * 1000);
                finished.push({
                    state: 'meditation',
                    planned_seconds: planned,
                    mode: player.meditation_mode || 'normal'
                });
            }
        }

        // 玩家表字段有变动才落库，避免无意义 UPDATE
        if (finished.length > 0 && (finished.some(f => f.state === 'seclusion' || f.state === 'meditation'))) {
            await player.save({ transaction: t });
        }

        // ── 历练：把 end_time 置为当前时间，结算时 now >= end_time，不再按提前结束折扣 ──
        if (!wanted || wanted === 'adventure') {
            const adventure = await PlayerAdventure.findOne({
                where: { player_id: playerId, status: 'in_progress' },
                order: [['createdAt', 'DESC']],
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (adventure) {
                adventure.end_time = now;
                await adventure.save({ transaction: t });
                finished.push({
                    state: 'adventure',
                    adventure_id: adventure.id,
                    event_type: adventure.event_type || null
                });
            }
        }

        await t.commit();

        // 无进行中操作时直接返回，前端据此提示（不算错误）
        if (finished.length === 0) {
            return res.json({
                code: 200,
                message: '当前没有可加速的耗时操作',
                data: { finished: [], server_time: now.toISOString() }
            });
        }

        await logAdminAction(playerId, 'quick_finish', { finished }, req);

        res.json({
            code: 200,
            message: `已加速 ${finished.length} 项耗时操作，请照常完成结算即可获得与自然到点一致的收益`,
            data: {
                finished,
                server_time: now.toISOString()
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

module.exports = router;