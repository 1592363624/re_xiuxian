/**
 * 年兽大作战（天道活动）
 *
 * 玩法：先破盾，后输出。
 *   集结队伍 → 放爆竹破【岁除之盾】→ 护盾归零后集火 200% 暴击
 *   未破盾则年兽吞噬全队修为
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('year_beast')?.year_beast
            || infrastructure.ConfigLoader.getConfig?.('year_beast');
        if (c && c.shield_layers !== undefined) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'year_beast.json'), 'utf8')).year_beast;
}

/** 内存态战场（演示；生产可落库） */
const parties = new Map();
let nextPartyId = 1;

class YearBeastService {
    static config() { return cfg(); }

    static createParty(leaderId) {
        const c = cfg();
        const id = nextPartyId++;
        const party = {
            id,
            leader_id: Number(leaderId),
            members: [Number(leaderId)],
            shield: Number(c.shield_layers) || 20,
            started: false,
            finished: false,
            turns: 0,
            log: []
        };
        parties.set(id, party);
        return party;
    }

    static joinParty(partyId, playerId) {
        const p = parties.get(Number(partyId));
        if (!p || p.finished) throw new AppError('讨伐队伍不存在或已结束', 404, ErrorCodes.NOT_FOUND);
        if (p.started) throw new AppError('战斗已开始', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        if (p.members.length >= (Number(cfg().max_party) || 10)) {
            throw new AppError('队伍已满', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const pid = Number(playerId);
        if (!p.members.includes(pid)) p.members.push(pid);
        return p;
    }

    static startParty(partyId, leaderId) {
        const p = parties.get(Number(partyId));
        if (!p) throw new AppError('队伍不存在', 404, ErrorCodes.NOT_FOUND);
        if (Number(p.leader_id) !== Number(leaderId)) throw new AppError('只有队长可开始讨伐', 403, ErrorCodes.BUSINESS_LOGIC_ERROR);
        p.started = true;
        p.log.push('年兽降临！先破盾，后输出！');
        return p;
    }

    /** 放爆竹：消耗一个特制爆竹，破 1 层盾 */
    static async firecracker(partyId, playerId) {
        const p = parties.get(Number(partyId));
        if (!p || !p.started || p.finished) throw new AppError('讨伐未在进行中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        const InventoryService = require('./InventoryService');
        const c = cfg();
        const ok = await InventoryService.removeItem(playerId, c.firecracker_item_key || 'special_firecracker', 1);
        if (!ok) throw new AppError('没有特制爆竹', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        p.shield = Math.max(0, p.shield - (Number(c.shield_damage_per_cracker) || 1));
        p.log.push(`玩家#${playerId} 放爆竹，护盾 → ${p.shield}`);
        p.turns += 1;
        this._regen(p);
        return this._snapshot(p);
    }

    /** 集火 */
    static focusFire(partyId, playerId) {
        const p = parties.get(Number(partyId));
        if (!p || !p.started || p.finished) throw new AppError('讨伐未在进行中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        const c = cfg();
        let damage = 0;
        if (p.shield > 0) {
            p.log.push(`玩家#${playerId} 集火，但护盾未破，伤害为 0！`);
        } else {
            const crit = true; // 破盾后必然 200% 暴击（帖：本回合所有集火造成 200% 暴击伤害）
            damage = Math.floor(10000 * (Number(c.crit_damage_multiplier) || 2));
            p.log.push(`玩家#${playerId} 集火！${crit ? '惊恐状态 200% 暴击' : ''} 造成 ${damage} 伤害`);
            if (damage >= 50000 || p.turns >= 5) {
                p.finished = true;
                p.win = true;
                p.log.push('年兽被击退！讨伐成功！');
            }
        }
        p.turns += 1;
        if (!p.finished) this._regen(p);
        return this._snapshot(p, { damage });
    }

    static _regen(p) {
        const c = cfg();
        p.shield = Math.min(Number(c.shield_layers) || 20, p.shield + (Number(c.shield_regen_per_turn) || 2));
    }

    static _snapshot(p, extra = {}) {
        return {
            party_id: p.id,
            leader_id: p.leader_id,
            members: p.members,
            shield: p.shield,
            max_shield: Number(cfg().shield_layers) || 20,
            started: p.started,
            finished: p.finished,
            win: !!p.win,
            turns: p.turns,
            log: p.log.slice(-10),
            ...extra
        };
    }

    static getParty(partyId) {
        const p = parties.get(Number(partyId));
        if (!p) throw new AppError('队伍不存在', 404, ErrorCodes.NOT_FOUND);
        return this._snapshot(p);
    }

    /** 结算首胜奖 / 助战奖 */
    static async settle(playerId, { isAssist = false } = {}) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            const attrs = player.attributes || {};
            const yb = attrs.year_beast || {};
            const now = Date.now();
            const last = yb.last_first_win ? new Date(yb.last_first_win).getTime() : 0;
            const cooldownMs = (Number(c.first_win_cooldown_hours) || 20) * 3600000;

            let exp = 0;
            let contribution = 0;
            let redPacket = 0;
            let badge = false;

            if (isAssist || (last && now - last < cooldownMs)) {
                contribution = Number(c.assist_contribution) || 200;
            } else {
                exp = Number(c.first_win_exp) || 50000;
                contribution = Number(c.first_win_contribution) || 2000;
                badge = true;
                if (Math.random() < (Number(c.red_packet_chance) || 0.5)) {
                    const min = Number(c.red_packet_min_stones) || 888;
                    const max = Number(c.red_packet_max_stones) || 8888;
                    redPacket = min + Math.floor(Math.random() * (max - min + 1));
                }
                yb.last_first_win = new Date(now).toISOString();
            }

            player.exp = (Number(player.exp) || 0) + exp;
            if (redPacket > 0) {
                player.spirit_stones = BigInt(player.spirit_stones ?? 0) + BigInt(redPacket);
            }
            player.attributes = { ...attrs, year_beast: yb };
            await player.save({ transaction: t });
            await t.commit();
            return { exp, contribution, red_packet: redPacket, badge, badge_title: badge ? c.first_win_badge_title : null };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }
}

module.exports = YearBeastService;
