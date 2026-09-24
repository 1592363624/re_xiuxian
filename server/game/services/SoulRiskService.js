/**
 * 神魂动荡 / 神魂陨落
 *
 * 帖「斗法/决斗」新法则：
 *   1. 落败可能触发【神魂动荡】（同阶 20% / 高阶 50%），10 分钟内战力 -30%
 *   2. 动荡中再败 → 【神魂陨落】：大境界跌一重、当前境界修为清零、掉 50% 材料与一件法宝
 *   3. 【道心破碎】24h：闭关收益减半、不可主动斗法
 *   4. 免死丹可抵消一次陨落惩罚（仍有道心破碎）
 *   5. 今日神念 10 次斗法上限；同目标日胜 5 次；仇敌复仇 +5% 战力
 *
 * 状态存 players.attributes.soul_risk：
 *   { unstable_until, heartbreak_until, duel_date, duel_count, win_map: {targetId: n}, enemies: number[] }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('soul_risk')?.soul_risk
            || infrastructure.ConfigLoader.getConfig?.('soul_risk');
        if (c && c.unstable_chance_same_rank !== undefined) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'soul_risk.json'), 'utf8')).soul_risk;
}

function today() { return new Date().toISOString().slice(0, 10); }

function stateOf(player) {
    const s = (player.attributes || {}).soul_risk || {};
    return {
        unstable_until: s.unstable_until || null,
        heartbreak_until: s.heartbreak_until || null,
        duel_date: s.duel_date || null,
        duel_count: Number(s.duel_count) || 0,
        win_map: s.win_map && typeof s.win_map === 'object' ? s.win_map : {},
        enemies: Array.isArray(s.enemies) ? s.enemies.map(Number) : [],
        last_result: s.last_result || null
    };
}

class SoulRiskService {
    static config() { return cfg(); }

    static async getStatus(playerId) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        const s = stateOf(player);
        const now = Date.now();
        const c = cfg();
        return {
            ...s,
            is_unstable: !!(s.unstable_until && new Date(s.unstable_until).getTime() > now),
            heartbroken: !!(s.heartbreak_until && new Date(s.heartbreak_until).getTime() > now),
            duel_used_today: s.duel_date === today() ? s.duel_count : 0,
            duel_limit: c.daily_duel_limit || 10,
            unstable_power_penalty: c.unstable_power_penalty || 0.3,
            revenge_power_bonus: c.revenge_power_bonus || 0.05
        };
    }

    /** 今日是否还能发起斗法 */
    static async canStartDuel(playerId) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        const s = stateOf(player);
        const c = cfg();
        const now = Date.now();
        if (s.heartbreak_until && new Date(s.heartbreak_until).getTime() > now) {
            return { allowed: false, reason: '道心破碎中，不可主动发起斗法' };
        }
        const used = s.duel_date === today() ? s.duel_count : 0;
        if (used >= (c.daily_duel_limit || 10)) {
            return { allowed: false, reason: '今日神念已耗尽，不可再斗法' };
        }
        return { allowed: true, remaining: (c.daily_duel_limit || 10) - used };
    }

    /** 同目标今日还能赢几次 */
    static canWinAgainst(s, targetId) {
        const c = cfg();
        const used = Number(s.win_map?.[String(targetId)]) || 0;
        return used < (c.daily_win_per_target_limit || 5);
    }

    static async recordDuelStart(playerId) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            const s = stateOf(player);
            const day = today();
            const count = s.duel_date === day ? s.duel_count + 1 : 1;
            player.attributes = {
                ...(player.attributes || {}),
                soul_risk: { ...s, duel_date: day, duel_count: count }
            };
            await player.save({ transaction: t });
            await t.commit();
            return { duel_count: count };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /**
     * 斗法结算后的风险处理
     * @param {Object} loser
     * @param {Object} winner
     * @param {boolean} loserWasUnstable
     * @returns {Promise<Object>} 事件描述
     */
    static async onDuelResult(loser, winner, { loserWasUnstable = false, winnerRank, loserRank } = {}) {
        const Player = require('../../models/player');
        const InventoryService = require('./InventoryService');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const loserInst = await Player.findByPk(loser.id, { lock: t.LOCK.UPDATE, transaction: t });
            const winnerInst = await Player.findByPk(winner.id, { lock: t.LOCK.UPDATE, transaction: t });
            const now = Date.now();
            const ls = stateOf(loserInst);
            const ws = stateOf(winnerInst);

            // 胜者记仇敌 + 神念/胜场
            const day = today();
            const winMap = { ...ws.win_map };
            const tKey = String(loser.id);
            winMap[tKey] = (Number(winMap[tKey]) || 0) + 1;

            const events = [];

            if (loserWasUnstable) {
                // 神魂陨落
                const hasPill = await InventoryService.getItemCount?.(loserInst.id, c.immortal_pill_item_key, t)
                    || 0;
                if (hasPill > 0) {
                    await InventoryService.removeItem(loserInst.id, c.immortal_pill_item_key, 1, t);
                    events.push({ type: 'immortal_pill_saved' });
                } else {
                    // 跌一重大境界
                    const newRank = Math.max(c.min_realm_rank_after_fall || 1, (Number(loserInst.realm_rank) || 1) - 3);
                    // 近似：realm_rank 一次掉一小重（3 为一大重的粗算）；若项目有 realm 表可再精化
                    loserInst.realm_rank = newRank;
                    loserInst.exp = 0;
                    // 掉材料
                    try {
                        const items = await InventoryService.listItems?.(loserInst.id, t) || [];
                        const materials = items.filter(i => i.type === 'material' || i.item_type === 'material');
                        for (const m of materials) {
                            const drop = Math.floor((Number(m.quantity) || 0) * (c.death_drop_material_rate || 0.5));
                            if (drop > 0) await InventoryService.removeItem(loserInst.id, m.item_key, drop, t);
                        }
                    } catch (_) { /* 背包结构差异时跳过掉宝，保留跌境 */ }
                    events.push({ type: 'soul_fall', new_rank: newRank });
                }
                // 道心破碎（免死丹也吃）
                const heartUntil = new Date(now + (Number(c.heartbreak_duration_hours) || 24) * 3600000).toISOString();
                playerAttrsSet(loserInst, { ...ls, unstable_until: null, heartbreak_until: heartUntil, last_result: { type: 'soul_fall_or_saved', at: new Date().toISOString() } });
            } else {
                // 落败叠动荡
                const wr = Number(winnerRank ?? winner.realm_rank) || 0;
                const lr = Number(loserRank ?? loser.realm_rank) || 0;
                const chance = wr > lr
                    ? (Number(c.unstable_chance_higher_rank) || 0.5)
                    : (Number(c.unstable_chance_same_rank) || 0.2);
                if (Math.random() < chance) {
                    const until = new Date(now + (Number(c.unstable_duration_minutes) || 10) * 60000).toISOString();
                    playerAttrsSet(loserInst, { ...ls, unstable_until: until, last_result: { type: 'unstable', at: new Date().toISOString() } });
                    events.push({ type: 'unstable', until });
                } else {
                    playerAttrsSet(loserInst, ls);
                }
            }

            // 胜者：记录仇敌（把败者加入 enemies 供复仇加成；帖里是败者记仇，这里双向记录）
            const enemies = new Set([...ws.enemies, Number(loser.id)]);
            playerAttrsSet(winnerInst, { ...ws, win_map: winMap, enemies: [...enemies], duel_date: day, duel_count: ws.duel_date === day ? ws.duel_count : ws.duel_count });

            await loserInst.save({ transaction: t });
            await winnerInst.save({ transaction: t });
            await t.commit();
            return { events };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 复仇战力加成 */
    static revengePowerBonus(player, targetId) {
        const s = stateOf(player);
        return s.enemies.includes(Number(targetId)) ? (Number(cfg().revenge_power_bonus) || 0.05) : 0;
    }
}

function playerAttrsSet(inst, soulRisk) {
    inst.attributes = { ...(inst.attributes || {}), soul_risk: soulRisk };
}

module.exports = SoulRiskService;
