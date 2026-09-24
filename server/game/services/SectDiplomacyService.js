/**
 * 宗门外交与掌门
 *
 * 帖「天道异动 · 宗门外交篇」：
 *   - 每日天明自动任命各宗「结丹后期+」修为最高者为掌门
 *   - 掌门可 .示好 / .敌对 / .结盟 / .解除
 *   - 斗法因果：友好掉率-5%；敌对夺 15% 修为/贡献；结盟全员战力+5%
 *   - 所有修士可 .天下大势 查看公开盟约/敌对
 *
 * 状态存 players.attributes.sect_diplomacy：
 *   { is_leader, leader_since }
 * 关系存 system_config JSON（或内存+落库到 system_config）：
 *   sect_diplomacy.relations[`${a}|${b}`] = { status, since, by }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('sect_diplomacy')?.sect_diplomacy
            || infrastructure.ConfigLoader.getConfig?.('sect_diplomacy');
        if (c && c.relations) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'sect_diplomacy.json'), 'utf8')).sect_diplomacy;
}

function pairKey(a, b) {
    return [String(a), String(b)].sort().join('|');
}

function playerSect(player) {
    return player.sect_name || player.sect || (player.attributes && player.attributes.sect_name) || null;
}

class SectDiplomacyService {
    static config() { return cfg(); }

    /** 查看我的宗门外交版图 / 天下大势 */
    static async getBoard(playerId, { publicOnly = false } = {}) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        const SystemConfig = require('../../models/system_config');
        const row = await SystemConfig.findOne({ where: { key: 'sect_diplomacy_relations' } });
        const relations = (row && row.value && (typeof row.value === 'string' ? JSON.parse(row.value) : row.value)) || {};
        const mySect = playerSect(player);
        const list = Object.entries(relations).map(([key, v]) => {
            const [a, b] = key.split('|');
            return { sects: [a, b], ...v };
        }).filter(r => !publicOnly || r.status === 'allied' || r.status === 'hostile' || (mySect && r.sects.includes(mySect)));

        const attrs = player.attributes || {};
        return {
            my_sect: mySect,
            is_leader: !!attrs.sect_diplomacy?.is_leader,
            relations: list,
            bonuses: {
                friendly_loot_penalty: cfg().friendly_loot_penalty,
                hostile_bonus_exp_rate: cfg().hostile_bonus_exp_rate,
                alliance_power_bonus: cfg().alliance_power_bonus
            }
        };
    }

    static async _loadRelations(SystemConfig) {
        const row = await SystemConfig.findOne({ where: { key: 'sect_diplomacy_relations' } });
        if (!row) {
            const created = await SystemConfig.create({ key: 'sect_diplomacy_relations', value: {} });
            return { row: created, relations: {} };
        }
        const relations = (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) || {};
        return { row, relations };
    }

    static async _saveRelations(row, relations, t) {
        row.value = relations;
        await row.save({ transaction: t });
    }

    static async _assertLeader(player) {
        const attrs = player.attributes || {};
        if (!attrs.sect_diplomacy?.is_leader) {
            throw new AppError('只有掌门可施展外交敕令', 403, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
    }

    /**
     * @param {number} playerId
     * @param {'friendly'|'hostile'|'allied'|'break'} action
     * @param {string} targetSect
     */
    static async changeRelation(playerId, action, targetSect) {
        const Player = require('../../models/player');
        const SystemConfig = require('../../models/system_config');
        const sequelize = require('../../config/database');
        const c = cfg();

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            await this._assertLeader(player);
            const mySect = playerSect(player);
            if (!mySect) throw new AppError('你尚未加入宗门', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            if (!targetSect || targetSect === mySect) throw new AppError('目标宗门无效', 400, ErrorCodes.VALIDATION_ERROR);

            const { row, relations } = await this._loadRelations(SystemConfig);
            const key = pairKey(mySect, targetSect);
            const now = Date.now();
            const current = relations[key] || { status: 'neutral', since: null, by: null };
            const lastChange = current.since ? new Date(current.since).getTime() : 0;
            const cooldownMs = (Number(c.relation_change_cooldown_hours) || 24) * 3600000;
            if (lastChange && now - lastChange < cooldownMs && action !== 'break') {
                await t.rollback();
                throw new AppError('24 小时内不可对同一宗门反复更改态度', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            let status = current.status;
            if (action === 'friendly') status = 'friendly';
            else if (action === 'hostile') status = 'hostile';
            else if (action === 'allied') {
                if (current.status !== 'friendly') {
                    await t.rollback();
                    throw new AppError('对方须先对我方处于友好状态才能结盟', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                status = 'allied';
            } else if (action === 'break') {
                if (current.status === 'allied') {
                    // 背信：72h 内无法新结盟（记在本条关系的 block_until）
                    status = 'neutral';
                    relations[key] = {
                        status,
                        since: new Date(now).toISOString(),
                        by: mySect,
                        alliance_broken_at: new Date(now).toISOString(),
                        alliance_block_until: new Date(now + (Number(c.break_alliance_block_hours) || 72) * 3600000).toISOString()
                    };
                    await this._saveRelations(row, relations, t);
                    await t.commit();
                    return { ok: true, status, key, note: '解除盟约，72 小时内无法缔结新盟约' };
                }
                status = 'neutral';
            } else {
                await t.rollback();
                throw new AppError('未知外交指令', 400, ErrorCodes.VALIDATION_ERROR);
            }

            relations[key] = {
                status,
                since: new Date(now).toISOString(),
                by: mySect,
                ...(relations[key]?.alliance_block_until ? { alliance_block_until: relations[key].alliance_block_until } : {})
            };
            await this._saveRelations(row, relations, t);
            await t.commit();
            return { ok: true, status, key, sects: [mySect, targetSect] };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /**
     * 每日任命掌门：各宗「结丹后期+」修为最高者
     * @returns {Array<{sect, leader_id}>}
     */
    static async appointLeaders() {
        const Player = require('../../models/player');
        const c = cfg();
        const minRank = Number(c.leader_min_realm_rank) || 15;
        const players = await Player.findAll({
            where: { is_dead: false },
            raw: true
        });
        const bySect = new Map();
        for (const p of players) {
            const sect = playerSect(p);
            if (!sect) continue;
            if ((Number(p.realm_rank) || 0) < minRank) continue;
            const exp = Number(p.exp) || 0;
            const prev = bySect.get(sect);
            if (!prev || exp > prev.exp) bySect.set(sect, { id: p.id, exp, nickname: p.nickname });
        }

        const PlayerModel = require('../../models/player');
        const appointed = [];
        for (const [sect, best] of bySect) {
            // 清掉该宗旧掌门
            const members = players.filter(p => playerSect(p) === sect);
            for (const m of members) {
                const attrs = (m.attributes && typeof m.attributes === 'object') ? m.attributes : {};
                const wasLeader = !!attrs.sect_diplomacy?.is_leader;
                const shouldLead = Number(m.id) === Number(best.id);
                if (wasLeader === shouldLead) continue;
                const inst = await PlayerModel.findByPk(m.id);
                if (!inst) continue;
                inst.attributes = {
                    ...(inst.attributes || {}),
                    sect_diplomacy: {
                        ...(inst.attributes?.sect_diplomacy || {}),
                        is_leader: shouldLead,
                        leader_since: shouldLead ? new Date().toISOString() : null
                    }
                };
                await inst.save();
            }
            appointed.push({ sect, leader_id: best.id, leader_name: best.nickname });
        }
        return appointed;
    }

    /** 斗法因果：双方宗门关系 → 加成/惩罚 */
    static async resolvePvpModifiers(attackerPlayer, defenderPlayer) {
        const aSect = playerSect(attackerPlayer);
        const dSect = playerSect(defenderPlayer);
        if (!aSect || !dSect || aSect === dSect) return { loot_penalty: 0, exp_bonus: 0, power_bonus: 0, relation: 'neutral' };

        const SystemConfig = require('../../models/system_config');
        const { relations } = await this._loadRelations(SystemConfig);
        const rel = relations[pairKey(aSect, dSect)]?.status || 'neutral';
        const c = cfg();
        if (rel === 'friendly') {
            return { loot_penalty: Number(c.friendly_loot_penalty) || 0.05, exp_bonus: 0, power_bonus: 0, relation: rel };
        }
        if (rel === 'hostile') {
            return {
                loot_penalty: 0,
                exp_bonus: Number(c.hostile_bonus_exp_rate) || 0.15,
                contribution_bonus: Number(c.hostile_bonus_contribution_rate) || 0.15,
                power_bonus: 0,
                relation: rel
            };
        }
        if (rel === 'allied') {
            return { loot_penalty: 0, exp_bonus: 0, power_bonus: Number(c.alliance_power_bonus) || 0.05, relation: rel };
        }
        return { loot_penalty: 0, exp_bonus: 0, power_bonus: 0, relation: 'neutral' };
    }
}

module.exports = SectDiplomacyService;
