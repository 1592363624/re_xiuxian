/**
 * 落云宗·云梦灵眼定脉服务
 *
 * 玩法文档对照：xiuxian_game_guide.md 第25节·落云宗灵眼之树·定脉
 *   `.灵树定脉` `.定脉 注灵|固脉|净浊|冲脉`
 *
 * 纯玩法设计：
 *   - 个人进度落 player_dingmai；宗门树全局状态（成熟/浊息/脉稳）落 system_configs
 *   - 与旧「灵树灌溉」并存，不改战斗数值
 */
'use strict';

const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerSect = require('../../models/playerSect');
const PlayerDingmai = require('../../models/playerDingmai');
const SystemConfig = require('../../models/system_config');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

const TREE_STATE_KEY = 'dingmai_tree_state';

function getConfig() {
    const config = configLoader.getConfig('dingmai_data');
    if (!config) throw new Error('定脉配置 dingmai_data 未加载');
    return config;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch { return BigInt(0); }
}

const ELEMENTS = ['metal', 'wood', 'water', 'fire', 'earth'];
const ELEMENT_NAMES = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土' };

class DingmaiService {
    static getInfo() {
        const config = getConfig();
        return {
            global: config.global,
            vein_types: config.vein_types,
            actions: config.actions,
            root_type_modifiers: config.root_type_modifiers,
            boards: config.boards,
            elements: ELEMENTS.map(id => ({ id, name: ELEMENT_NAMES[id] }))
        };
    }

    static async _getTreeState() {
        const [row] = await SystemConfig.findOrCreate({
            where: { key: TREE_STATE_KEY },
            defaults: {
                key: TREE_STATE_KEY,
                value: JSON.stringify({
                    growth: 0,
                    pollution: 0,
                    vein_stability: 50,
                    last_vein: 'calm',
                    date: todayStr()
                }),
                description: '落云宗灵眼之树定脉全局状态'
            }
        });
        let state = {};
        try { state = JSON.parse(row.value || '{}'); } catch { state = {}; }
        return { row, state };
    }

    static async _rollVeinDaily(state) {
        const today = todayStr();
        if (state.date !== today) {
            const veins = getConfig().vein_types || [];
            const weights = { main: 20, aux: 30, reverse: 20, calm: 30 };
            const pool = [];
            for (const v of veins) {
                const w = weights[v.id] || 10;
                for (let i = 0; i < w; i++) pool.push(v.id);
            }
            state.last_vein = pool[Math.floor(Math.random() * pool.length)] || 'calm';
            state.date = today;
            state.pollution = Math.max(0, (state.pollution || 0) - 5);
        }
        return state;
    }

    static async _requireLuoyun(playerId) {
        const member = await PlayerSect.findOne({ where: { player_id: playerId } });
        if (!member || member.sect_id !== 'luoyun') {
            throw new AppError('定脉为落云宗专属玩法', 403, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        return member;
    }

    static async _getOrCreate(playerId, transaction = null, useLock = false) {
        const options = {};
        if (transaction) options.transaction = transaction;
        if (useLock && transaction) options.lock = transaction.LOCK.UPDATE;
        let row = await PlayerDingmai.findOne({ where: { player_id: playerId }, ...options });
        if (!row) {
            row = await PlayerDingmai.create({ player_id: playerId }, transaction ? { transaction } : {});
        }
        const today = todayStr();
        if (row.count_date !== today) {
            row.count_date = today;
            row.today_orders = 0;
            row.today_charges = 0;
        }
        return row;
    }

    /** 粗判灵根类型：从 player.spirit_root / attributes 取（纯玩法，不接完整 SpiritRoot 管线） */
    static _rootTypeOf(player) {
        const sr = player.spirit_root;
        if (!sr || typeof sr !== 'object') return 'multi';
        const keys = Object.keys(sr).filter(k => !k.startsWith('_'));
        if (keys.length === 0) return 'false';
        if (keys.length === 1) return 'single';
        if (keys.length <= 3) return 'multi';
        return 'false';
    }

    static async getStatus(playerId) {
        await this._requireLuoyun(playerId);
        const config = getConfig();
        const { row: treeRow, state: raw } = await this._getTreeState();
        const state = await this._rollVeinDaily(raw);
        treeRow.value = JSON.stringify(state);
        await treeRow.save();

        const row = await this._getOrCreate(playerId);
        await row.save();
        const player = await Player.findByPk(playerId);
        const rootType = this._rootTypeOf(player);

        // 榜单（内存 Top10，纯玩法）
        const meritTop = await PlayerDingmai.findAll({
            order: [['total_merit', 'DESC'], ['updated_at', 'ASC']],
            limit: 10
        });
        const purifyTop = await PlayerDingmai.findAll({
            order: [['total_purify', 'DESC'], ['updated_at', 'ASC']],
            limit: 10
        });
        const ids = [...new Set([...meritTop, ...purifyTop].map(r => r.player_id))];
        const players = ids.length ? await Player.findAll({ where: { id: ids }, attributes: ['id', 'nickname', 'username', 'realm_rank'] }) : [];
        const byId = new Map(players.map(p => [p.id, p]));

        const mapBoard = (list) => list.map((r, i) => {
            const p = byId.get(r.player_id) || {};
            const include = (p.realm_rank || 0) <= (config.boards.branch.max_realm_rank_for_entry ?? 22);
            return {
                rank: i + 1,
                player_id: r.player_id,
                nickname: p.nickname || p.username || '道友',
                merit: r.total_merit,
                purify: r.total_purify,
                counted_on_branch: include
            };
        });

        return {
            global: config.global,
            tree: {
                growth: state.growth || 0,
                pollution: state.pollution || 0,
                vein_stability: state.vein_stability ?? 50,
                today_vein: state.last_vein || 'calm',
                today_vein_name: (config.vein_types || []).find(v => v.id === state.last_vein)?.name || '平脉',
                pollution_level: (state.pollution || 0) >= config.global.pollution_critical_threshold ? 'critical'
                    : (state.pollution || 0) >= config.global.pollution_high_threshold ? 'high' : 'normal'
            },
            me: {
                today_orders: row.today_orders,
                daily_limit: config.global.daily_order_limit,
                today_charges: row.today_charges,
                max_charge_per_day: config.global.max_charge_per_day,
                total_merit: row.total_merit,
                total_purify: row.total_purify,
                root_type: rootType,
                last_action: row.last_action
            },
            boards: {
                branch: mapBoard(meritTop),
                purify: mapBoard(purifyTop)
            },
            actions: config.actions,
            vein_types: config.vein_types
        };
    }

    static async act(playerId, actionId, element = null) {
        await this._requireLuoyun(playerId);
        const config = getConfig();
        const actionCfg = (config.actions || []).find(a => a.id === actionId);
        if (!actionCfg) throw new AppError('未知定脉动作', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

            const row = await this._getOrCreate(playerId, t, true);
            const { row: treeRow, state: raw } = await this._getTreeState();
            const state = await this._rollVeinDaily(raw);

            if (row.today_orders >= config.global.daily_order_limit) {
                throw new AppError('今日定脉令已用尽', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (actionId === 'charge') {
                if (row.today_charges >= config.global.max_charge_per_day) {
                    throw new AppError('今日冲脉次数已用尽', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                if ((state.vein_stability ?? 50) < config.global.vein_stability_min_for_charge) {
                    throw new AppError(`脉稳不足（需 ≥${config.global.vein_stability_min_for_charge}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            let elem = null;
            if (actionCfg.uses_element) {
                if (!element || !ELEMENTS.includes(element)) {
                    throw new AppError('请指定五行之一：金/木/水/火/土', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                elem = element;
            }

            // 命中今日脉象？
            const vein = (config.vein_types || []).find(v => v.id === state.last_vein) || { match_bonus: 0.9, pollution_on_miss: 1 };
            const isMainish = state.last_vein === 'main' || state.last_vein === 'aux';
            const match = actionCfg.uses_element ? isMainish : true;
            const rootType = this._rootTypeOf(player);
            const rootMod = (config.root_type_modifiers || {})[rootType] || { match_mult: 1, mismatch_mult: 0.8 };

            let mult = match ? (vein.match_bonus || 1) * (rootMod.match_mult || 1)
                : (rootMod.mismatch_mult || 0.8);
            if (actionId === 'charge' && state.last_vein === 'main' && rootType === 'single') {
                mult *= 1.5;
            }

            // 冲脉耗修为
            if (actionCfg.exp_cost) {
                const exp = safeBigInt(player.exp);
                const need = safeBigInt(actionCfg.exp_cost);
                if (exp < need) throw new AppError('修为不足，无法冲脉', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                player.exp = (exp - need).toString();
            }

            const growthGain = Math.round((actionCfg.growth || 0) * mult);
            const meritGain = Math.round((actionCfg.merit || 0) * mult);
            const purifyGain = Math.round((actionCfg.purify || 0) + ((rootMod.purify_bonus || 0) * (actionId === 'purify' ? 1 : 0)));

            state.growth = (state.growth || 0) + growthGain;
            state.vein_stability = Math.max(0, Math.min(100, (state.vein_stability ?? 50) + (actionCfg.vein_stability_change || 0)));
            let pollutionDelta = 0;
            if (!match && actionCfg.pollution_risk_on_mismatch) {
                pollutionDelta = actionCfg.pollution_risk_on_mismatch;
            }
            if (actionId === 'charge' && !match) {
                pollutionDelta += (vein.pollution_on_miss || 0);
            }
            if (purifyGain > 0) pollutionDelta -= purifyGain;
            state.pollution = Math.max(0, Math.min(100, (state.pollution || 0) + pollutionDelta));

            row.today_orders += 1;
            if (actionId === 'charge') row.today_charges += 1;
            row.total_merit += Math.max(0, meritGain);
            row.total_purify += Math.max(0, purifyGain);
            row.last_action = actionId;
            row.last_action_at = new Date();

            treeRow.value = JSON.stringify(state);
            await treeRow.save({ transaction: t });
            await row.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                action: actionId,
                action_name: actionCfg.name,
                element: elem,
                element_name: elem ? ELEMENT_NAMES[elem] : null,
                match,
                today_vein: state.last_vein,
                root_type: rootType,
                growth_gain: growthGain,
                merit_gain: meritGain,
                purify_gain: purifyGain,
                pollution_delta: pollutionDelta,
                tree: {
                    growth: state.growth,
                    pollution: state.pollution,
                    vein_stability: state.vein_stability
                },
                message: `${actionCfg.name}完成${elem ? `（${ELEMENT_NAMES[elem]}）` : ''}：成熟 +${growthGain}，功绩 +${meritGain}${purifyGain ? `，净化 +${purifyGain}` : ''}${pollutionDelta > 0 ? `，浊息 +${pollutionDelta}` : ''}`
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }
}

module.exports = DingmaiService;
