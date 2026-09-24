/**
 * 试炼古塔（琉璃塔）
 *
 * 帖「试炼古塔 ------ 挑战极限」：
 *   .闯塔 / .继续闯塔 / .退出古塔 / .琉璃塔榜 / .重置古塔
 *   每日一次免费挑战；精英层(5的倍数)与首领层(10的倍数)首次通关丰厚奖励；全服首杀公告。
 *
 * 进度住在 players.attributes.trial_tower blob（无需新表）：
 *   { floor, best_floor, daily_attempts, last_attempt_date, first_clears: number[], last_result }
 */
'use strict';

const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');

function towerConfig() {
    const fs = require('fs');
    const path = require('path');
    try {
        const viaLoader = infrastructure.ConfigLoader.getConfig?.('trial_tower');
        const cfg = viaLoader?.trial_tower || viaLoader;
        if (cfg && cfg.max_floor) return cfg;
    } catch (_) { /* 未加载时回落读盘 */ }
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'trial_tower.json'), 'utf8'));
    return raw.trial_tower || raw;
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

function progressOf(player) {
    const attrs = player.attributes || {};
    const p = attrs.trial_tower || {};
    return {
        floor: Number(p.floor) || 0,
        best_floor: Number(p.best_floor) || 0,
        daily_attempts: Number(p.daily_attempts) || 0,
        last_attempt_date: p.last_attempt_date || null,
        first_clears: Array.isArray(p.first_clears) ? p.first_clears.map(Number) : [],
        last_result: p.last_result || null
    };
}

function isElite(floor, cfg) {
    return floor > 0 && floor % (cfg.elite_every || 5) === 0 && floor % (cfg.boss_every || 10) !== 0;
}
function isBoss(floor, cfg) {
    return floor > 0 && floor % (cfg.boss_every || 10) === 0;
}

function floorPower(floor, cfg) {
    const d = cfg.floor_difficulty || {};
    const base = Number(d.base_power) || 800;
    const per = Number(d.power_per_floor) || 120;
    let power = base + per * floor;
    if (isBoss(floor, cfg)) power *= Number(d.boss_multiplier) || 1.8;
    else if (isElite(floor, cfg)) power *= Number(d.elite_multiplier) || 1.35;
    return Math.floor(power);
}

class TrialTowerService {
    static getConfig() { return towerConfig(); }

    /** 状态：进度、今日次数、下一层信息 */
    static async getStatus(playerId) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const cfg = towerConfig();
        const p = progressOf(player);
        const day = today();
        const attemptsToday = p.last_attempt_date === day ? p.daily_attempts : 0;
        const nextFloor = Math.min(p.floor + 1, cfg.max_floor || 100);
        const freeLeft = Math.max(0, (cfg.daily_free_attempts || 1) - attemptsToday);

        return {
            floor: p.floor,
            best_floor: p.best_floor,
            max_floor: cfg.max_floor || 100,
            attempts_today: attemptsToday,
            free_attempts_left: freeLeft,
            reset_cost_exp: cfg.reset_cost_exp || 500,
            next_floor: nextFloor <= (cfg.max_floor || 100) ? {
                floor: nextFloor,
                kind: isBoss(nextFloor, cfg) ? 'boss' : (isElite(nextFloor, cfg) ? 'elite' : 'normal'),
                power: floorPower(nextFloor, cfg),
                first_clear: !p.first_clears.includes(nextFloor)
            } : null,
            first_clears: p.first_clears,
            last_result: p.last_result
        };
    }

    /**
     * 挑战下一层。free=true 用免费次数；否则消耗修为重置/加次数。
     * @param {number} playerId
     * @param {Object} playerPower - { power } 玩家战力
     */
    static async challenge(playerId, playerPower) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        function safeBigInt(value) {
            try { return BigInt(value ?? 0); } catch (_) { return 0n; }
        }
        const NotificationService = require('./NotificationService');

        const cfg = towerConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法闯塔', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const p = progressOf(player);
            const day = today();
            const attemptsToday = p.last_attempt_date === day ? p.daily_attempts : 0;
            const freeLeft = Math.max(0, (cfg.daily_free_attempts || 1) - attemptsToday);

            if (freeLeft <= 0) {
                // 额外次数：消耗修为（.重置古塔 语义）
                const cost = Number(cfg.reset_cost_exp) || 500;
                const exp = Number(player.exp) || 0;
                if (exp < cost) {
                    await t.rollback();
                    throw new AppError(`今日免费次数已用完，重置需消耗 ${cost} 修为`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                player.exp = exp - cost;
            }

            const nextFloor = p.floor + 1;
            const maxFloor = cfg.max_floor || 100;
            if (nextFloor > maxFloor) {
                await t.rollback();
                throw new AppError('已登顶古塔', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const need = floorPower(nextFloor, cfg);
            const have = Math.floor(Number(playerPower) || 0);
            const win = have >= need * (0.85 + Math.random() * 0.3); // 85%~115% 浮动判定

            const kind = isBoss(nextFloor, cfg) ? 'boss' : (isElite(nextFloor, cfg) ? 'elite' : 'normal');
            const realmBonus = (Number(player.realm_rank) || 0) >= (cfg.realm_bonus_threshold_rank || 12)
                ? (Number(cfg.realm_bonus_multiplier) || 1.5)
                : 1;

            let expGain = 0;
            let stoneGain = 0;
            let firstClear = false;
            let serverFirst = false;

            if (win) {
                expGain = Math.floor((Number(cfg.base_exp_per_floor) || 80) * nextFloor * realmBonus);
                stoneGain = Math.floor((Number(cfg.base_stones_per_floor) || 30) * nextFloor * realmBonus);
                if (!p.first_clears.includes(nextFloor)) {
                    firstClear = true;
                    p.first_clears.push(nextFloor);
                    if (kind === 'elite') {
                        stoneGain += Number(cfg.elite_first_clear_stones) || 500;
                        expGain += Number(cfg.elite_first_clear_exp) || 800;
                    } else if (kind === 'boss') {
                        stoneGain += Number(cfg.boss_first_clear_stones) || 1500;
                        expGain += Number(cfg.boss_first_clear_exp) || 2000;
                    }
                    // 全服首杀：无任何 first_clear 记录里含此 boss 层 —— 用 last_result 简化为「首次登顶该层即广播」
                    if (kind === 'boss') serverFirst = true;
                }
                p.floor = nextFloor;
                p.best_floor = Math.max(p.best_floor, nextFloor);
                player.exp = (Number(player.exp) || 0) + expGain;
                player.spirit_stones = safeBigInt(player.spirit_stones) + BigInt(stoneGain);
            }

            p.daily_attempts = attemptsToday + 1;
            p.last_attempt_date = day;
            p.last_result = {
                floor: nextFloor,
                kind,
                win,
                power: have,
                required: need,
                exp_gain: expGain,
                stone_gain: stoneGain,
                first_clear: firstClear,
                at: new Date().toISOString()
            };
            player.attributes = { ...(player.attributes || {}), trial_tower: p };
            await player.save({ transaction: t });
            await t.commit();

            if (serverFirst) {
                try {
                    await NotificationService.sendAnnouncement?.(
                        '试炼古塔全服首杀',
                        `${player.nickname || `玩家#${player.id}`} 首通试炼古塔第 ${nextFloor} 层（首领层）！`
                    );
                } catch (_) { /* 公告失败不影响闯塔 */ }
            }

            return {
                win,
                floor: nextFloor,
                kind,
                power: have,
                required: need,
                exp_gain: expGain,
                stone_gain: stoneGain,
                first_clear: firstClear,
                server_first: serverFirst,
                now_floor: p.floor,
                best_floor: p.best_floor
            };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 扫榜：按 best_floor 降序（读 players.attributes 太重，这里给 top 从 last_result 近似 —— 真排行用后续 ranking 表） */
    static async getRanking(limit = 20) {
        const Player = require('../../models/player');
        const players = await Player.findAll({
            attributes: ['id', 'nickname', 'realm', 'attributes'],
            limit: 200,
            raw: true
        });
        const rows = players.map(p => {
            const tw = (p.attributes && p.attributes.trial_tower) || {};
            return {
                player_id: p.id,
                nickname: p.nickname,
                realm: p.realm,
                best_floor: Number(tw.best_floor) || 0,
                floor: Number(tw.floor) || 0
            };
        }).filter(r => r.best_floor > 0)
            .sort((a, b) => b.best_floor - a.best_floor)
            .slice(0, limit);
        return { list: rows };
    }
}

module.exports = TrialTowerService;
