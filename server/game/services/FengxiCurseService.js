/**
 * 乱星海秘闻 · 风希的诅咒
 *
 * 持有【风雷翅】的修士可能被风希分神锁定：
 *   1. 神识锁定 → 全服天机警示
 *   2. 分神追猎（限时窗口）→ .逃亡 或 .迎战
 *   3. 风元紊乱冷却；战胜获得【风之祝福】提高逃生率
 *
 * 状态存 players.attributes.fengxi_curse：
 *   { hunted_until, cooldown_until, blessing_until, last_hunt_at, hunt_count }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('fengxi_curse')?.fengxi_curse
            || infrastructure.ConfigLoader.getConfig?.('fengxi_curse');
        if (c && c.enabled !== undefined) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'fengxi_curse.json'), 'utf8')).fengxi_curse;
}

function stateOf(player) {
    const s = (player.attributes || {}).fengxi_curse || {};
    return {
        hunted_until: s.hunted_until || null,
        cooldown_until: s.cooldown_until || null,
        blessing_until: s.blessing_until || null,
        hunt_count: Number(s.hunt_count) || 0,
        last_result: s.last_result || null
    };
}

class FengxiCurseService {
    static config() { return cfg(); }

    /** 背包/装备里是否持有风雷翅 */
    static async hasWindWings(playerId) {
        const keys = cfg().required_item_keys || [];
        try {
            const InventoryService = require('./InventoryService');
            const map = await InventoryService.getItemQuantities(playerId, keys);
            for (const qty of map.values()) {
                if (Number(qty) > 0) return true;
            }
        } catch (_) { /* ignore */ }
        try {
            const EquipmentService = require('./EquipmentService');
            const bonus = await EquipmentService.getEquipmentBonus(playerId);
            // 装备键名或 item_key 命中
            const text = JSON.stringify(bonus || {});
            return keys.some(k => text.includes(k));
        } catch (_) { /* ignore */ }
        return false;
    }

    /**
     * 惰性/主动触发：有风雷翅才可能被锁定
     * 在 PVP 结算、闭关结算、查看状态时调用
     */
    static async maybeTrigger(playerId) {
        const has = await this.hasWindWings(playerId);
        return this.tryTriggerHunt(playerId, has);
    }

    static async getStatus(playerId) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        // 查看状态时顺带掷一次触发（低概率）
        await this.maybeTrigger(playerId).catch(() => null);
        const fresh = await Player.findByPk(playerId);
        const c = cfg();
        const s = stateOf(fresh || player);
        const now = Date.now();
        return {
            ...s,
            has_wings: await this.hasWindWings(playerId),
            is_hunted: s.hunted_until && new Date(s.hunted_until).getTime() > now,
            in_cooldown: s.cooldown_until && new Date(s.cooldown_until).getTime() > now,
            has_blessing: s.blessing_until && new Date(s.blessing_until).getTime() > now,
            wind_blessing_escape_bonus: c.wind_blessing_escape_bonus || 0.2
        };
    }

    /**
     * 尝试触发追猎（由定时任务/玩家行为调用；无风雷翅则跳过）
     * @returns {null|{hunt_until:string}}
     */
    static async tryTriggerHunt(playerId, hasWings) {
        if (!hasWings) return null;
        const c = cfg();
        if (c.enabled === false) return null;
        if (Math.random() > (Number(c.trigger_chance_per_hour) || 0.04)) return null;

        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) { await t.rollback(); return null; }
            const s = stateOf(player);
            const now = Date.now();
            if (s.hunted_until && new Date(s.hunted_until).getTime() > now) { await t.rollback(); return null; }
            if (s.cooldown_until && new Date(s.cooldown_until).getTime() > now) { await t.rollback(); return null; }

            const huntUntil = new Date(now + (Number(c.hunt_window_minutes) || 30) * 60000).toISOString();
            player.attributes = {
                ...(player.attributes || {}),
                fengxi_curse: { ...s, hunted_until: huntUntil, hunt_count: s.hunt_count + 1 }
            };
            await player.save({ transaction: t });
            await t.commit();

            try {
                const NotificationService = require('./NotificationService');
                await NotificationService.sendAnnouncement?.(
                    '天机警示',
                    `风希神识已锁定一名持有风雷翅的修士！分神正在跨海追猎…`
                );
            } catch (_) { /* ignore */ }

            return { hunt_until: huntUntil };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 亡命奔逃 */
    static async escape(playerId) {
        return this._resolve(playerId, 'escape');
    }

    /** 奋力一搏 */
    static async fight(playerId) {
        return this._resolve(playerId, 'fight');
    }

    static async _resolve(playerId, mode) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const s = stateOf(player);
            const now = Date.now();
            if (!s.hunted_until || new Date(s.hunted_until).getTime() <= now) {
                await t.rollback();
                throw new AppError('当前没有被风希追猎', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const rank = Number(player.realm_rank) || 0;
            let win = false;
            let expDelta = 0;
            let message = '';

            if (mode === 'escape') {
                let chance = Number(c.escape_base_chance) || 0.4;
                chance += rank * (Number(c.escape_rank_bonus_per_rank) || 0.02);
                if (s.blessing_until && new Date(s.blessing_until).getTime() > now) {
                    chance += Number(c.wind_blessing_escape_bonus) || 0.2;
                }
                chance = Math.min(0.95, chance);
                win = Math.random() < chance;
                if (win) {
                    message = '九死一生，你催动风雷遁走，毫发无伤。';
                } else {
                    expDelta = -Math.floor((Number(player.exp) || 0) * (Number(c.escape_fail_exp_loss_rate) || 0.08));
                    message = '在劫难逃，被分神击伤，损失部分修为。';
                }
            } else {
                const chance = Math.min(0.35, (Number(c.fight_win_chance_base) || 0.05) + rank * 0.01);
                win = Math.random() < chance;
                if (win) {
                    expDelta = Number(c.fight_win_exp_gain) || 50000;
                    message = '逆天之举！你竟击溃了风希分神，获得海量修为与风之祝福！';
                } else {
                    expDelta = -Math.floor((Number(player.exp) || 0) * (Number(c.fight_lose_exp_loss_rate) || 0.2));
                    message = '螳臂当车，被重创，损失大量修为。';
                }
            }

            player.exp = Math.max(0, (Number(player.exp) || 0) + expDelta);
            const cooldownUntil = new Date(now + (Number(c.cooldown_hours_after) || 4) * 3600000).toISOString();
            const next = {
                ...s,
                hunted_until: null,
                cooldown_until: cooldownUntil,
                blessing_until: (mode === 'fight' && win)
                    ? new Date(now + (Number(c.wind_blessing_hours) || 12) * 3600000).toISOString()
                    : s.blessing_until,
                last_result: { mode, win, exp_delta: expDelta, message, at: new Date().toISOString() }
            };
            player.attributes = { ...(player.attributes || {}), fengxi_curse: next };
            await player.save({ transaction: t });
            await t.commit();

            return { mode, win, exp_delta: expDelta, message, cooldown_until: cooldownUntil };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }
}

module.exports = FengxiCurseService;
