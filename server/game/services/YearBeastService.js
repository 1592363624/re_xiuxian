/**
 * 年兽大作战（天道活动）
 *
 * 玩法：先破盾，后输出。
 *   集结队伍 → 放爆竹破【岁除之盾】→ 护盾归零后集火 200% 暴击
 *   未在回合内击杀则年兽吞噬全队修为
 *
 * 状态落库：year_beast_parties / year_beast_members（重启不丢）
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

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch (_) { return 0n; }
}

class YearBeastService {
    static config() { return cfg(); }

    static async _loadParty(partyId, { lock = false, transaction = null } = {}) {
        const YearBeastParty = require('../../models/yearBeastParty');
        const party = await YearBeastParty.findByPk(partyId, {
            lock: lock ? transaction.LOCK.UPDATE : undefined,
            transaction
        });
        if (!party) throw new AppError('讨伐队伍不存在', 404, ErrorCodes.NOT_FOUND);
        return party;
    }

    static async _members(partyId, transaction = null) {
        const YearBeastMember = require('../../models/yearBeastMember');
        return YearBeastMember.findAll({ where: { party_id: partyId }, transaction });
    }

    static async _log(party, entry, transaction) {
        const list = Array.isArray(party.battle_log) ? party.battle_log : [];
        list.push({ ...entry, at: new Date().toISOString() });
        party.battle_log = list.slice(-50);
        if (transaction) await party.save({ transaction });
    }

    static async createParty(leaderId) {
        const YearBeastParty = require('../../models/yearBeastParty');
        const YearBeastMember = require('../../models/yearBeastMember');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const party = await YearBeastParty.create({
                leader_id: Number(leaderId),
                status: 'forming',
                shield: Number(c.shield_layers) || 20,
                max_shield: Number(c.shield_layers) || 20,
                battle_log: [{ type: 'create', msg: '集结讨伐年兽！' }]
            }, { transaction: t });
            await YearBeastMember.create({
                party_id: party.id,
                player_id: Number(leaderId),
                role: 'leader'
            }, { transaction: t });
            await t.commit();
            return this._snapshot(party, await this._members(party.id));
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    static async joinParty(partyId, playerId) {
        const YearBeastMember = require('../../models/yearBeastMember');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const party = await this._loadParty(partyId, { lock: true, transaction: t });
            if (party.status !== 'forming') {
                await t.rollback();
                throw new AppError('战斗已开始或已结束', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const existing = await this._members(party.id, t);
            if (existing.length >= (Number(c.max_party) || 10)) {
                await t.rollback();
                throw new AppError('队伍已满', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const pid = Number(playerId);
            if (!existing.some(m => Number(m.player_id) === pid)) {
                await YearBeastMember.create({ party_id: party.id, player_id: pid, role: 'member' }, { transaction: t });
            }
            await this._log(party, { type: 'join', msg: `玩家#${pid} 加入讨伐` }, t);
            await t.commit();
            return this._snapshot(party, await this._members(party.id));
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    static async startParty(partyId, leaderId) {
        const sequelize = require('../../config/database');
        const t = await sequelize.transaction();
        try {
            const party = await this._loadParty(partyId, { lock: true, transaction: t });
            if (Number(party.leader_id) !== Number(leaderId)) {
                await t.rollback();
                throw new AppError('只有队长可开始讨伐', 403, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (party.status !== 'forming') {
                await t.rollback();
                throw new AppError('当前状态无法开始', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            party.status = 'fighting';
            party.started_at = new Date();
            await this._log(party, { type: 'start', msg: '年兽降临！先破盾，后输出！' }, t);
            await t.commit();
            return this._snapshot(party, await this._members(party.id));
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 放爆竹：消耗特制爆竹，破 1 层盾 */
    static async firecracker(partyId, playerId) {
        const InventoryService = require('./InventoryService');
        const YearBeastMember = require('../../models/yearBeastMember');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const party = await this._loadParty(partyId, { lock: true, transaction: t });
            if (party.status !== 'fighting') {
                await t.rollback();
                throw new AppError('讨伐未在进行中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const ok = await InventoryService.removeItem(
                playerId, c.firecracker_item_key || 'special_firecracker', 1, t
            );
            if (!ok) {
                await t.rollback();
                throw new AppError('没有特制爆竹，请先到商城购买', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            party.shield = Math.max(0, party.shield - (Number(c.shield_damage_per_cracker) || 1));
            party.turns += 1;
            const member = await YearBeastMember.findOne({
                where: { party_id: party.id, player_id: playerId },
                transaction: t
            });
            if (member) {
                member.firecrackers_used += 1;
                await member.save({ transaction: t });
            }
            await this._log(party, {
                type: 'cracker',
                msg: `玩家#${playerId} 放爆竹，护盾 → ${party.shield}`
            }, t);
            // 年兽反击：回合末回盾
            const before = party.shield;
            party.shield = Math.min(
                party.max_shield,
                party.shield + (Number(c.shield_regen_per_turn) || 2)
            );
            if (party.shield !== before) {
                await this._log(party, { type: 'regen', msg: `年兽回盾 ${before} → ${party.shield}` }, t);
            }
            await t.commit();
            return this._snapshot(party, await this._members(party.id));
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 集火：护盾未破伤害 0；归零后 200% 暴击 */
    static async focusFire(partyId, playerId) {
        const YearBeastMember = require('../../models/yearBeastMember');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const party = await this._loadParty(partyId, { lock: true, transaction: t });
            if (party.status !== 'fighting') {
                await t.rollback();
                throw new AppError('讨伐未在进行中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            let damage = 0;
            if (party.shield > 0) {
                await this._log(party, {
                    type: 'focus',
                    msg: `玩家#${playerId} 集火，但护盾未破，伤害为 0！`
                }, t);
            } else {
                // 用成员贡献度放大伤害，让组队有意义
                const members = await this._members(party.id, t);
                const my = members.find(m => Number(m.player_id) === Number(playerId));
                const base = 8000 + (Number(my?.firecrackers_used) || 0) * 500;
                damage = Math.floor(base * (Number(c.crit_damage_multiplier) || 2));
                party.damage_dealt += damage;
                party.turns += 1;
                if (my) {
                    my.focus_count += 1;
                    my.damage += damage;
                    await my.save({ transaction: t });
                }
                await this._log(party, {
                    type: 'focus',
                    msg: `玩家#${playerId} 集火！惊恐状态 200% 暴击，造成 ${damage}`
                }, t);

                const killDamage = 30000 * Math.max(1, members.length);
                if (party.damage_dealt >= killDamage) {
                    party.status = 'victory';
                    party.finished_at = new Date();
                    await this._log(party, { type: 'win', msg: '年兽被击退！讨伐成功！' }, t);
                } else if (party.turns >= 12) {
                    party.status = 'defeat';
                    party.finished_at = new Date();
                    await this._log(party, { type: 'lose', msg: '年兽凶性大发，吞噬全队修为！' }, t);
                }
            }
            await t.commit();
            return this._snapshot(party, await this._members(party.id), { damage });
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 领取本场奖励（首胜/助战），一人一次 */
    static async settle(playerId, partyId) {
        const Player = require('../../models/player');
        const YearBeastMember = require('../../models/yearBeastMember');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const party = await this._loadParty(partyId, { transaction: t });
            const member = await YearBeastMember.findOne({
                where: { party_id: party.id, player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!member) {
                await t.rollback();
                throw new AppError('你不在本场讨伐中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (member.settled) {
                await t.rollback();
                throw new AppError('本场奖励已领取', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (party.status !== 'victory') {
                await t.rollback();
                throw new AppError('讨伐未胜利，无法领赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            const attrs = player.attributes || {};
            const yb = attrs.year_beast || {};
            const now = Date.now();
            const last = yb.last_first_win ? new Date(yb.last_first_win).getTime() : 0;
            const cooldownMs = (Number(c.first_win_cooldown_hours) || 20) * 3600000;
            const isAssist = last && now - last < cooldownMs;

            let exp = 0;
            let contribution = 0;
            let redPacket = 0;
            let badge = false;

            if (isAssist) {
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
                player.spirit_stones = safeBigInt(player.spirit_stones) + BigInt(redPacket);
            }
            // 宗门贡献若列存在
            if ('sect_contribution' in player && contribution > 0) {
                player.sect_contribution = (Number(player.sect_contribution) || 0) + contribution;
            }
            player.attributes = { ...attrs, year_beast: yb };
            member.settled = true;
            await member.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();
            return { exp, contribution, red_packet: redPacket, badge, badge_title: badge ? c.first_win_badge_title : null, is_assist: isAssist };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    static async getParty(partyId) {
        const party = await this._loadParty(partyId);
        return this._snapshot(party, await this._members(party.id));
    }

    static async listActive() {
        const YearBeastParty = require('../../models/yearBeastParty');
        const rows = await YearBeastParty.findAll({
            where: { status: ['forming', 'fighting'] },
            order: [['id', 'DESC']],
            limit: 10
        });
        const out = [];
        for (const p of rows) {
            out.push(this._snapshot(p, await this._members(p.id)));
        }
        return out;
    }

    static _snapshot(party, members, extra = {}) {
        return {
            party_id: Number(party.id),
            leader_id: Number(party.leader_id),
            status: party.status,
            shield: party.shield,
            max_shield: party.max_shield,
            turns: party.turns,
            damage_dealt: party.damage_dealt,
            members: members.map(m => ({
                player_id: Number(m.player_id),
                role: m.role,
                firecrackers_used: m.firecrackers_used,
                focus_count: m.focus_count,
                damage: m.damage,
                settled: m.settled
            })),
            log: (party.battle_log || []).slice(-12),
            ...extra
        };
    }
}

module.exports = YearBeastService;
