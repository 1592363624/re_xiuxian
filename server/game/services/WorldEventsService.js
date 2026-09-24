/**
 * 天道世界事件 + 天道凶名称号
 *
 * - 每小时随机祥瑞/厄运并全服公告
 * - 杀戮值达到门槛自动授予凶名（血手人屠…），提供战力加成
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('world_events');
        if (c && c.world_events) return c;
        if (c && c.events) return { world_events: c, notorious_titles: c.notorious_titles };
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'world_events.json'), 'utf8'));
}

function pickEvent(events) {
    const total = events.reduce((s, e) => s + (Number(e.weight) || 1), 0);
    let r = Math.random() * total;
    for (const e of events) {
        r -= (Number(e.weight) || 1);
        if (r <= 0) return e;
    }
    return events[0];
}

class WorldEventsService {
    static config() { return cfg(); }

    /** 触发一次世界事件并广播 */
    static async trigger() {
        const c = cfg().world_events;
        if (c.enabled === false) return null;
        const event = pickEvent(c.events || []);
        const payload = {
            id: event.id,
            type: event.type,
            title: event.title,
            desc: event.desc,
            at: new Date().toISOString(),
            effects: {
                exp_bonus_rate: event.exp_bonus_rate || 0,
                stones: event.stones || 0,
                exp_loss_rate: event.exp_loss_rate || 0,
                seclusion_penalty_rate: event.seclusion_penalty_rate || 0
            }
        };
        try {
            const NotificationService = require('./NotificationService');
            await NotificationService.sendAnnouncement('天道法则', `【${event.title}】${event.desc}`);
        } catch (_) { /* ignore */ }
        return payload;
    }

    /** 按杀戮值评凶名 */
    static evaluateTitle(killCount) {
        const list = cfg().notorious_titles?.slayer_thresholds || [];
        let best = null;
        for (const row of list) {
            if ((Number(killCount) || 0) >= (Number(row.kills) || 0)) best = row;
        }
        return best;
    }

    /** 记一次杀戮并尝试授予凶名 */
    static async onKill(playerId) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            const attrs = player.attributes || {};
            const we = attrs.world_events || {};
            const kills = (Number(we.kills) || 0) + 1;
            const title = this.evaluateTitle(kills);
            player.attributes = {
                ...attrs,
                world_events: {
                    ...we,
                    kills,
                    notorious_title: title ? { id: title.title_id, name: title.name, power_bonus: title.power_bonus } : we.notorious_title
                }
            };
            // 杀戮值（若列存在）
            if ('kill_count' in player) player.kill_count = kills;
            await player.save({ transaction: t });
            await t.commit();
            return { kills, title: title || null };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /**
     * 按已有 kill_count 同步凶名（供 CombatService 在 bumpStat 之后调用，避免双计）
     * @param {Object} player - 已加锁/已持有的 Player 实例（会就地改 attributes）
     * @param {number} killCount
     * @param {Object} [opts]
     */
    static syncNotoriousTitle(player, killCount, { transaction = null } = {}) {
        const attrs = player.attributes || {};
        const we = attrs.world_events || {};
        const title = this.evaluateTitle(killCount);
        const prev = we.notorious_title || null;
        const next = title
            ? { id: title.title_id, name: title.name, power_bonus: title.power_bonus }
            : prev;
        player.attributes = {
            ...attrs,
            world_events: { ...we, kills: Number(killCount) || 0, notorious_title: next }
        };
        return { title: next, changed: !!title && (!prev || prev.id !== title.title_id) };
    }

    static async getStatus(playerId) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        const we = (player.attributes || {}).world_events || {};
        return {
            kills: Number(we.kills) || 0,
            notorious_title: we.notorious_title || null,
            thresholds: cfg().notorious_titles?.slayer_thresholds || [],
            event_pool: (cfg().world_events?.events || []).map(e => ({ id: e.id, title: e.title, type: e.type }))
        };
    }
}

module.exports = WorldEventsService;
