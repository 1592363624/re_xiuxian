/**
 * 剑诀线服务
 *
 * 玩法文档对照：xiuxian_game_guide.md 第30节·剑诀线
 *   `.合成剑诀` `.参悟剑诀` `.炼剑` `.参悟剑阵` `.布下剑阵`
 *
 * 纯玩法设计：
 *   - 合成：残卷 → 剑诀；参悟：耗修为涨 insight；炼剑：分阶推进 sword_stage
 *   - 剑阵：满足条件后布下，仅展示状态（本批不接战斗数值链路）
 *   - 加成字段一律 display_bonus_only，面板可展示但不进属性管线
 */
'use strict';

const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerSwordArt = require('../../models/playerSwordArt');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

function getConfig() {
    const config = configLoader.getConfig('sword_art_data');
    if (!config) throw new Error('剑诀配置 sword_art_data 未加载');
    return config;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch { return BigInt(0); }
}

function findManual(config, id) {
    return (config.manuals || []).find(m => m.id === id);
}

function findFormation(config, id) {
    return (config.formations || []).find(f => f.id === id);
}

class SwordArtService {
    static getInfo() {
        const config = getConfig();
        return {
            global: config.global,
            manuals: config.manuals,
            formations: config.formations
        };
    }

    static async _rollDaily(row) {
        const today = todayStr();
        if (row.count_date !== today) {
            row.count_date = today;
            row.today_comprehend = 0;
            row.today_refine = 0;
            row.today_insight = 0;
            row.today_form = 0;
        }
    }

    static async getOrCreate(playerId, manualId, transaction = null, useLock = false) {
        const options = {};
        if (transaction) options.transaction = transaction;
        if (useLock && transaction) options.lock = transaction.LOCK.UPDATE;
        let row = await PlayerSwordArt.findOne({
            where: { player_id: playerId, manual_id: manualId },
            ...options
        });
        if (!row) {
            row = await PlayerSwordArt.create({
                player_id: playerId,
                manual_id: manualId
            }, transaction ? { transaction } : {});
        }
        return row;
    }

    static async getStatus(playerId) {
        const config = getConfig();
        const rows = await PlayerSwordArt.findAll({ where: { player_id: playerId } });
        for (const r of rows) await this._rollDaily(r);
        await Promise.all(rows.map(r => r.save()));
        return {
            global: config.global,
            arts: rows.map(r => {
                const manual = findManual(config, r.manual_id) || {};
                const formationOn = r.active_formation_id
                    && r.formation_until
                    && new Date(r.formation_until) > new Date();
                return {
                    manual_id: r.manual_id,
                    name: manual.name || r.manual_id,
                    grade: manual.grade,
                    grade_name: manual.grade_name,
                    description: manual.description,
                    element: manual.element,
                    insight: r.insight,
                    max_insight: manual.max_insight,
                    sword_stage: r.sword_stage,
                    max_stage: (manual.refine_stages || []).length,
                    next_stage: (manual.refine_stages || []).find(s => s.stage === r.sword_stage + 1) || null,
                    display_bonus: manual.refine_stages?.find(s => s.stage === r.sword_stage)?.sword_atk_bonus || 0,
                    display_bonus_only: true,
                    today_comprehend: r.today_comprehend,
                    today_refine: r.today_refine,
                    active_formation_id: formationOn ? r.active_formation_id : null,
                    formation_until: formationOn ? r.formation_until : null
                };
            }),
            formations: (config.formations || []).map(f => ({
                ...f,
                unlocked_by: rows.some(r =>
                    r.manual_id === f.required_manual
                    && r.insight >= f.required_insight
                    && r.sword_stage >= f.required_sword_stage
                )
            }))
        };
    }

    /**
     * 合成剑诀：消耗残卷 + 灵石
     */
    static async compose(playerId, manualId) {
        const config = getConfig();
        const manual = findManual(config, manualId);
        if (!manual) throw new AppError('剑诀不存在', 404, ErrorCodes.NOT_FOUND);
        const g = config.global;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

            const existing = await PlayerSwordArt.findOne({
                where: { player_id: playerId, manual_id: manualId },
                transaction: t
            });
            if (existing) throw new AppError('已掌握该剑诀，不可重复合成', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const fragItem = g.compose_fragment_item;
            const need = g.compose_fragment_need || 3;
            const has = await InventoryService.getItemQuantity(playerId, fragItem);
            if (has < need) {
                throw new AppError(`残卷不足：需要「${g.compose_fragment_name || fragItem}」×${need}，当前 ${has}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            await InventoryService.removeItem(playerId, fragItem, need, t);

            const cost = safeBigInt(g.compose_cost_spirit_stones || 200);
            const stones = safeBigInt(player.spirit_stones);
            if (stones < cost) throw new AppError('灵石不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            player.spirit_stones = (stones - cost).toString();
            await player.save({ transaction: t });

            await PlayerSwordArt.create({
                player_id: playerId,
                manual_id: manualId
            }, { transaction: t });
            await t.commit();

            return {
                success: true,
                manual_id: manualId,
                name: manual.name,
                message: `残卷合璧，你悟出「${manual.name}」！`,
                cost: { items: [{ item_key: fragItem, quantity: need }], spirit_stones: cost.toString() }
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 参悟剑诀：涨 insight
     */
    static async comprehend(playerId, manualId) {
        const config = getConfig();
        const manual = findManual(config, manualId);
        if (!manual) throw new AppError('剑诀不存在', 404, ErrorCodes.NOT_FOUND);
        const g = config.global;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const row = await this.getOrCreate(playerId, manualId, t, true);
            await this._rollDaily(row);

            if (row.today_comprehend >= (g.comprehend_daily_limit || 5)) {
                throw new AppError('今日参悟次数已用尽', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (row.last_comprehend_at) {
                const elapsed = (Date.now() - new Date(row.last_comprehend_at).getTime()) / 1000;
                if (elapsed < (g.comprehend_cooldown_sec || 60)) {
                    throw new AppError('参悟冷却中，请稍候', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }
            if (row.insight >= (manual.max_insight || 10)) {
                throw new AppError('剑意已圆满，可尝试布阵或炼剑', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const expCost = safeBigInt(g.comprehend_exp_cost_base || 200);
            const exp = safeBigInt(player.exp);
            if (exp < expCost) throw new AppError('修为不足，无法参悟', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const rate = manual.comprehend_success_rate ?? 0.8;
            const ok = Math.random() < rate;
            row.today_comprehend += 1;
            row.last_comprehend_at = new Date();

            let gained = 0;
            if (ok) {
                player.exp = (exp - expCost).toString();
                gained = manual.insight_per_comprehend || 2;
                const before = row.insight;
                row.insight = Math.min(manual.max_insight || 10, row.insight + gained);
                gained = row.insight - before;
            } else {
                // 失败仍消耗一半修为作为「心力」
                player.exp = (exp - expCost / 2n).toString();
            }

            await player.save({ transaction: t });
            await row.save({ transaction: t });
            await t.commit();

            return {
                success: ok,
                manual_id: manualId,
                name: manual.name,
                insight: row.insight,
                max_insight: manual.max_insight,
                insight_gained: gained,
                exp_cost: (ok ? expCost : expCost / 2n).toString(),
                message: ok
                    ? `参悟有得，「${manual.name}」剑意 +${gained}`
                    : '心神涣散，此次参悟未得要领。'
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 炼剑：推进 sword_stage
     */
    static async refine(playerId, manualId) {
        const config = getConfig();
        const manual = findManual(config, manualId);
        if (!manual) throw new AppError('剑诀不存在', 404, ErrorCodes.NOT_FOUND);
        const g = config.global;
        const stages = manual.refine_stages || [];
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const row = await this.getOrCreate(playerId, manualId, t, true);
            await this._rollDaily(row);

            if (row.today_refine >= (g.refine_daily_limit || 3)) {
                throw new AppError('今日炼剑次数已用尽', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (row.last_refine_at) {
                const elapsed = (Date.now() - new Date(row.last_refine_at).getTime()) / 1000;
                if (elapsed < (g.refine_cooldown_sec || 300)) {
                    throw new AppError('炼剑冷却中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            const next = stages.find(s => s.stage === row.sword_stage + 1);
            if (!next) throw new AppError('剑已大成，无更高阶可炼', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const cost = safeBigInt(next.cost_spirit_stones);
            const stones = safeBigInt(player.spirit_stones);
            if (stones < cost) throw new AppError('灵石不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            if (next.cost_item) {
                const need = next.cost_item_qty || 1;
                const has = await InventoryService.getItemQuantity(playerId, next.cost_item);
                if (has < need) {
                    throw new AppError(`材料不足：需要 ${next.cost_item}×${need}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                await InventoryService.removeItem(playerId, next.cost_item, need, t);
            }

            player.spirit_stones = (stones - cost).toString();
            row.today_refine += 1;
            row.last_refine_at = new Date();

            const ok = Math.random() < (next.success_rate ?? 0.8);
            let insightLost = 0;
            if (ok) {
                row.sword_stage = next.stage;
            } else if (manual.risk_note) {
                // 高风险剑诀失败损剑意
                if (row.insight > 0) {
                    row.insight -= 1;
                    insightLost = 1;
                }
            }

            await player.save({ transaction: t });
            await row.save({ transaction: t });
            await t.commit();

            return {
                success: ok,
                manual_id: manualId,
                name: manual.name,
                stage: row.sword_stage,
                stage_name: ok ? next.name : (stages.find(s => s.stage === row.sword_stage)?.name || '—'),
                attempt_stage: next.stage,
                attempt_stage_name: next.name,
                display_bonus: stages.find(s => s.stage === row.sword_stage)?.sword_atk_bonus || 0,
                display_bonus_only: true,
                insight_lost: insightLost,
                exp_note: '剑诀加成为展示向，本批不接入战斗数值链路',
                message: ok
                    ? `炼剑成功！「${manual.name}」晋入「${next.name}」`
                    : `炼剑失败${insightLost ? '，剑意受损 -1' : ''}。`
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    /**
     * 参悟剑阵：检查是否满足布阵条件（展示向）
     */
    static async inspectFormation(playerId, formationId) {
        const config = getConfig();
        const formation = findFormation(config, formationId);
        if (!formation) throw new AppError('剑阵不存在', 404, ErrorCodes.NOT_FOUND);
        const row = await PlayerSwordArt.findOne({
            where: { player_id: playerId, manual_id: formation.required_manual }
        });
        const insight = row?.insight || 0;
        const stage = row?.sword_stage || 0;
        const unlocked = insight >= formation.required_insight && stage >= formation.required_sword_stage;
        return {
            formation,
            current_insight: insight,
            current_sword_stage: stage,
            unlocked,
            display_bonus_only: true,
            message: unlocked
                ? `已悟透「${formation.name}」，可布阵。`
                : `尚需剑意 ${formation.required_insight} / 炼剑 ${formation.required_sword_stage} 阶。`
        };
    }

    /**
     * 布下剑阵
     */
    static async deployFormation(playerId, formationId) {
        const config = getConfig();
        const formation = findFormation(config, formationId);
        if (!formation) throw new AppError('剑阵不存在', 404, ErrorCodes.NOT_FOUND);
        const g = config.global;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const row = await this.getOrCreate(playerId, formation.required_manual, t, true);
            await this._rollDaily(row);

            if (row.today_form >= (g.form_daily_limit || 1)) {
                throw new AppError('今日布阵次数已用尽', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (row.insight < formation.required_insight || row.sword_stage < formation.required_sword_stage) {
                throw new AppError('剑意或炼剑阶数不足，无法布阵', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const cost = safeBigInt(formation.cost_spirit_stones || 0);
            const stones = safeBigInt(player.spirit_stones);
            if (stones < cost) throw new AppError('灵石不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            player.spirit_stones = (stones - cost).toString();

            const hours = g.form_duration_hours || 4;
            row.active_formation_id = formationId;
            row.formation_until = new Date(Date.now() + hours * 3600 * 1000);
            row.today_form += 1;

            await player.save({ transaction: t });
            await row.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                formation_id: formationId,
                name: formation.name,
                formation_until: row.formation_until,
                display_bonus_only: true,
                buff_note: formation.buff_note,
                message: `剑阵「${formation.name}」已布下，${hours} 小时内剑意护持。`
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }
}

module.exports = SwordArtService;
