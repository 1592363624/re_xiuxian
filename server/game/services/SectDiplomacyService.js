/**
 * 宗门外交服务
 *
 * 玩法文档对照：xiuxian_game_guide.md 第33节·宗门外交
 *   `.天下大势` `.示好` `.结盟` `.敌对` `.解除`
 *
 * 纯玩法设计：
 *   - 关系值 -100~100，分档展示
 *   - 仅宗主/长老可结盟/敌对/解除；成员可示好
 *   - 不改战斗数值，只做社交博弈与大势展示
 */
'use strict';

const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerSect = require('../../models/playerSect');
const SectDiplomacy = require('../../models/sectDiplomacy');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

function getConfig() {
    const config = configLoader.getConfig('sect_diplomacy_data');
    if (!config) throw new Error('宗门外交配置 sect_diplomacy_data 未加载');
    return config;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch { return BigInt(0); }
}

function pair(a, b) {
    return a < b ? [a, b] : [b, a];
}

function bandOf(relation, bands) {
    for (const b of bands || []) {
        if (relation >= b.min && relation <= b.max) return b;
    }
    return { id: 'neutral', name: '中立', color: 'stone' };
}

class SectDiplomacyService {
    static getInfo() {
        const config = getConfig();
        return {
            global: config.global,
            sects: config.sects
        };
    }

    static async _getRelation(sectA, sectB, transaction = null, useLock = false) {
        const [a, b] = pair(sectA, sectB);
        const options = {};
        if (transaction) options.transaction = transaction;
        if (useLock && transaction) options.lock = transaction.LOCK.UPDATE;
        let row = await SectDiplomacy.findOne({
            where: { sect_a_id: a, sect_b_id: b },
            ...options
        });
        if (!row) {
            row = await SectDiplomacy.create({
                sect_a_id: a,
                sect_b_id: b,
                relation: getConfig().global.initial_relation || 0,
                status: 'neutral'
            }, transaction ? { transaction } : {});
        }
        return row;
    }

    static async getWorldSituation() {
        const config = getConfig();
        const rows = await SectDiplomacy.findAll();
        const byPair = new Map(rows.map(r => [`${r.sect_a_id}|${r.sect_b_id}`, r]));
        const pairs = [];
        const sects = config.sects || [];
        for (let i = 0; i < sects.length; i++) {
            for (let j = i + 1; j < sects.length; j++) {
                const [a, b] = pair(sects[i].id, sects[j].id);
                const row = byPair.get(`${a}|${b}`);
                const relation = row?.relation ?? 0;
                pairs.push({
                    sect_a_id: a,
                    sect_a_name: sects.find(s => s.id === a)?.name || a,
                    sect_b_id: b,
                    sect_b_name: sects.find(s => s.id === b)?.name || b,
                    relation,
                    status: row?.status || 'neutral',
                    band: bandOf(relation, config.global.relation_bands),
                    note: row?.note || null,
                    updated_at: row?.updated_at || null
                });
            }
        }
        pairs.sort((x, y) => y.relation - x.relation);
        return {
            sects: sects.map(s => ({ ...s })),
            pairs,
            relation_bands: config.global.relation_bands,
            summary: {
                allies: pairs.filter(p => p.status === 'ally' || p.relation >= 60).length,
                hostiles: pairs.filter(p => p.status === 'hostile' || p.relation <= -60).length
            }
        };
    }

    static async _mySect(playerId) {
        const member = await PlayerSect.findOne({ where: { player_id: playerId } });
        if (!member || !member.sect_id) {
            throw new AppError('尚未拜入宗门，无法参与外交', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        return member;
    }

    static async getMySectRelations(playerId) {
        const member = await this._mySect(playerId);
        const config = getConfig();
        const situation = await this.getWorldSituation();
        const mine = situation.pairs.filter(p => p.sect_a_id === member.sect_id || p.sect_b_id === member.sect_id);
        return {
            my_sect_id: member.sect_id,
            my_sect_name: config.sects.find(s => s.id === member.sect_id)?.name || member.sect_id,
            my_role: member.role || 'member',
            relations: mine.map(p => {
                const otherId = p.sect_a_id === member.sect_id ? p.sect_b_id : p.sect_a_id;
                return {
                    other_sect_id: otherId,
                    other_sect_name: config.sects.find(s => s.id === otherId)?.name || otherId,
                    relation: p.relation,
                    status: p.status,
                    band: p.band
                };
            }),
            actions: config.global.diplomacy_actions
        };
    }

    static async act(playerId, targetSectId, action) {
        const config = getConfig();
        const actionCfg = (config.global.diplomacy_actions || {})[action];
        if (!actionCfg) throw new AppError('未知外交行动', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

        const member = await this._mySect(playerId);
        const mySect = member.sect_id;
        if (mySect === targetSectId) throw new AppError('不能对自己宗门采取外交行动', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        const target = (config.sects || []).find(s => s.id === targetSectId);
        if (!target) throw new AppError('目标宗门不存在', 404, ErrorCodes.NOT_FOUND);

        const role = member.role || 'member';
        if (actionCfg.requires_role && !actionCfg.requires_role.includes(role)) {
            throw new AppError(`该行动需 ${actionCfg.requires_role.join('/')} 权限`, 403, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const row = await this._getRelation(mySect, targetSectId, t, true);

            // 每日限制：挂在 relation 旁的简易计数（note 字段存 JSON）
            let meta = {};
            try { meta = JSON.parse(row.note || '{}'); } catch { meta = {}; }
            if (typeof meta !== 'object' || meta === null) meta = {};
            const today = todayStr();
            if (meta.date !== today) meta = { date: today, counts: {} };
            if (!meta.counts) meta.counts = {};
            const used = meta.counts[action] || 0;
            if (actionCfg.daily_limit && used >= actionCfg.daily_limit) {
                throw new AppError(`今日「${actionCfg.name}」次数已用尽`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 关系门槛
            if (actionCfg.min_relation !== undefined && row.relation < actionCfg.min_relation) {
                throw new AppError(`关系不足：需 ≥${actionCfg.min_relation}，当前 ${row.relation}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (actionCfg.max_relation !== undefined && row.relation > actionCfg.max_relation) {
                throw new AppError(`关系过高：需 ≤${actionCfg.max_relation}，当前 ${row.relation}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (actionCfg.min_relation_for_action !== undefined && row.relation < actionCfg.min_relation_for_action) {
                throw new AppError(`关系过低，对方不会接受「${actionCfg.name}」`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣灵石
            const cost = safeBigInt(actionCfg.cost_spirit_stones || 0);
            const stones = safeBigInt(player.spirit_stones);
            if (stones < cost) throw new AppError('灵石不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            player.spirit_stones = (stones - cost).toString();

            // 改关系
            const delta = actionCfg.relation_change || 0;
            row.relation = Math.max(-100, Math.min(100, row.relation + delta));
            if (action === 'ally') row.status = 'ally';
            else if (action === 'hostile') row.status = 'hostile';
            else if (action === 'break_relation') row.status = 'neutral';
            else row.status = row.status || 'neutral';

            meta.counts[action] = used + 1;
            row.note = JSON.stringify(meta);
            row.updated_by = playerId;

            await player.save({ transaction: t });
            await row.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                action,
                action_name: actionCfg.name,
                target_sect_id: targetSectId,
                target_sect_name: target.name,
                relation: row.relation,
                status: row.status,
                band: bandOf(row.relation, config.global.relation_bands),
                cost_spirit_stones: cost.toString(),
                message: `你代表宗门对「${target.name}」执行「${actionCfg.name}」，关系 ${delta >= 0 ? '+' : ''}${delta} → ${row.relation}`
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }
}

module.exports = SectDiplomacyService;
