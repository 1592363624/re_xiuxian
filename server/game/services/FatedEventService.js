/**
 * 事件奇遇服务
 *
 * 玩法文档对照：xiuxian_game_guide.md 第22节·隐藏/事件式命令
 *   `.献上魂魄` `.收敛气息` `.作答` `.答` `.献祭法则` `.交换` `.换取` `.赎罪` `.卜筮问天`
 *
 * 纯玩法设计：
 *   - 事件按权重随机触发，也可由历练自动触发
 *   - 进行中事件一人一条，超时自动消散
 *   - 抉择成功/失败发奖走 grantItems，诚实记账
 */
'use strict';

const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerFatedEvent = require('../../models/playerFatedEvent');
const InventoryService = require('./InventoryService');
const { grantItems } = require('../items/itemGrant');
const { withItemNames } = require('../items/itemNaming');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

function getConfig() {
    const config = configLoader.getConfig('fated_event_data');
    if (!config) throw new Error('奇遇配置 fated_event_data 未加载');
    return config;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch { return BigInt(0); }
}

function findEvent(config, id) {
    return (config.events || []).find(e => e.id === id);
}

function pickWeighted(events) {
    const pool = events.filter(e => (e.trigger_weight || 0) > 0);
    const total = pool.reduce((s, e) => s + (e.trigger_weight || 0), 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const e of pool) {
        roll -= (e.trigger_weight || 0);
        if (roll <= 0) return e;
    }
    return pool[pool.length - 1];
}

class FatedEventService {
    static getInfo() {
        const config = getConfig();
        return {
            global: config.global,
            events: config.events.map(e => ({
                id: e.id,
                name: e.name,
                command_hints: e.command_hints,
                min_realm_rank: e.min_realm_rank,
                description: e.description,
                has_quiz: !!e.quiz,
                choices: (e.choices || []).map(c => ({ id: c.id, label: c.label, description: c.description }))
            }))
        };
    }

    static async getActive(playerId) {
        const now = new Date();
        let active = await PlayerFatedEvent.findOne({
            where: { player_id: playerId, status: 'pending' },
            order: [['created_at', 'DESC']]
        });
        if (active && active.expires_at && new Date(active.expires_at) < now) {
            active.status = 'expired';
            active.result = 'expired';
            active.resolved_at = now;
            await active.save();
            active = null;
        }
        return active;
    }

    static async _rollDaily(row) {
        const today = todayStr();
        if (row.count_date !== today) {
            row.count_date = today;
            row.today_count = 0;
        }
    }

    /**
     * 触发一次奇遇（命令触发或历练自动触发）
     */
    static async trigger(playerId, { forceEventId = null, source = 'manual' } = {}) {
        const config = getConfig();
        const g = config.global;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

            const existing = await this.getActive(playerId);
            if (existing) {
                await t.rollback();
                return {
                    success: true,
                    triggered: false,
                    reason: 'has_active',
                    active: await this._viewEvent(existing),
                    message: '你已有一桩未决奇遇，请先做出抉择。'
                };
            }

            const last = await PlayerFatedEvent.findOne({
                where: { player_id: playerId },
                order: [['created_at', 'DESC']]
            });
            const cooldown = g.trigger_cooldown_sec || 600;
            if (last && source === 'manual') {
                const elapsed = (Date.now() - new Date(last.created_at).getTime()) / 1000;
                if (elapsed < cooldown) {
                    await t.rollback();
                    throw new AppError(`天机未至，请 ${Math.ceil(cooldown - elapsed)} 秒后再试`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            let todayCount = 0;
            if (last) {
                await this._rollDaily(last);
                todayCount = last.today_count;
                await last.save({ transaction: t });
            }
            if (todayCount >= (g.daily_event_limit || 8)) {
                await t.rollback();
                throw new AppError('今日奇遇次数已用尽', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const realmRank = player.realm_rank || 0;
            const eligible = (config.events || []).filter(e => realmRank >= (e.min_realm_rank || 0));
            if (!eligible.length) {
                await t.rollback();
                throw new AppError('当前境界尚无天机垂青', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            let eventCfg = forceEventId ? findEvent(config, forceEventId) : pickWeighted(eligible);
            if (!eventCfg || realmRank < (eventCfg.min_realm_rank || 0)) {
                await t.rollback();
                return {
                    success: true,
                    triggered: false,
                    reason: 'no_event',
                    message: '天机混沌，此次未有所得。'
                };
            }

            const row = await PlayerFatedEvent.create({
                player_id: playerId,
                event_id: eventCfg.id,
                event_name: eventCfg.name,
                status: 'pending',
                payload: JSON.stringify({
                    source,
                    quiz: eventCfg.quiz ? {
                        question: eventCfg.quiz.question,
                        options: eventCfg.quiz.options.map(o => ({ id: o.id, label: o.label }))
                    } : null
                }),
                today_count: todayCount + 1,
                count_date: todayStr(),
                expires_at: new Date(Date.now() + (g.event_expire_sec || 1800) * 1000)
            }, { transaction: t });

            await t.commit();
            return {
                success: true,
                triggered: true,
                active: await this._viewEvent(row, eventCfg),
                message: eventCfg.description
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    static async _viewEvent(row, eventCfg = null) {
        const config = getConfig();
        const cfg = eventCfg || findEvent(config, row.event_id) || {};
        let payload = {};
        try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
        return {
            id: row.id,
            event_id: row.event_id,
            name: row.event_name,
            status: row.status,
            description: cfg.description,
            command_hints: cfg.command_hints || [],
            expires_at: row.expires_at,
            created_at: row.created_at,
            quiz: payload.quiz || null,
            choices: (cfg.choices || []).map(c => ({
                id: c.id,
                label: c.label,
                description: c.description,
                cost: c.cost || {},
                success_rate: c.success_rate
            }))
        };
    }

    static async getStatus(playerId) {
        const active = await this.getActive(playerId);
        const recent = await PlayerFatedEvent.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: 10
        });
        return {
            active: active ? await this._viewEvent(active) : null,
            recent: recent.map(r => ({
                event_id: r.event_id,
                event_name: r.event_name,
                status: r.status,
                result: r.result,
                choice_id: r.choice_id,
                rewards_summary: r.rewards_summary,
                created_at: r.created_at,
                resolved_at: r.resolved_at
            }))
        };
    }

    /**
     * 作出抉择（含答题）
     */
    static async choose(playerId, choiceId) {
        const config = getConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

            const row = await PlayerFatedEvent.findOne({
                where: { player_id: playerId, status: 'pending' },
                order: [['created_at', 'DESC']],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!row) throw new AppError('当前没有未决奇遇', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            if (row.expires_at && new Date(row.expires_at) < new Date()) {
                row.status = 'expired';
                row.result = 'expired';
                row.resolved_at = new Date();
                await row.save({ transaction: t });
                await t.commit();
                throw new AppError('奇遇已消散', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const cfg = findEvent(config, row.event_id);
            if (!cfg) throw new AppError('事件配置丢失', 500, ErrorCodes.BUSINESS_LOGIC_ERROR);

            // 答题型
            if (cfg.quiz) {
                const opt = (cfg.quiz.options || []).find(o => o.id === choiceId || o.label === choiceId);
                if (!opt) throw new AppError('无效选项', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                const correct = !!opt.correct;
                const rewardBlock = correct ? cfg.quiz.correct_rewards : cfg.quiz.wrong_rewards;
                const applied = await this._applyRewards(player, rewardBlock || {}, t);
                row.status = 'resolved';
                row.choice_id = opt.id;
                row.result = correct ? 'correct' : 'wrong';
                row.rewards_summary = JSON.stringify(applied);
                row.resolved_at = new Date();
                await row.save({ transaction: t });
                await t.commit();
                return {
                    success: true,
                    result: row.result,
                    correct,
                    rewards: applied,
                    message: correct
                        ? `答对了！${(cfg.quiz.correct_rewards?.message) || '问心台金光一闪。'}`
                        : (cfg.quiz.wrong_rewards?.message || '答非所问。')
                };
            }

            // 抉择型
            const choice = (cfg.choices || []).find(c => c.id === choiceId || c.label === choiceId);
            if (!choice) throw new AppError('无效抉择', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            // 先扣代价
            const costNote = await this._applyCost(player, choice.cost || {}, t);
            const rate = choice.success_rate ?? 1;
            const ok = Math.random() < rate;
            const rewardBlock = ok ? choice.success_rewards : choice.fail_penalty;
            const applied = await this._applyRewards(player, rewardBlock || {}, t);

            row.status = 'resolved';
            row.choice_id = choice.id;
            row.result = ok ? 'success' : 'fail';
            row.rewards_summary = JSON.stringify({ cost: costNote, rewards: applied, ok });
            row.resolved_at = new Date();
            await row.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                result: row.result,
                choice_id: choice.id,
                cost: costNote,
                rewards: applied,
                message: ok ? (choice.success_message || '机缘已至。') : (choice.fail_message || '天机弄人。')
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    static async _applyCost(player, cost, t) {
        const note = {};
        if (cost.exp) {
            const exp = safeBigInt(player.exp);
            const need = safeBigInt(cost.exp);
            if (exp < need) throw new AppError('修为不足，无法作出该抉择', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            player.exp = (exp - need).toString();
            note.exp = need.toString();
        }
        if (cost.spirit_stones) {
            const stones = safeBigInt(player.spirit_stones);
            const need = safeBigInt(cost.spirit_stones);
            if (stones < need) throw new AppError('灵石不足，无法作出该抉择', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            player.spirit_stones = (stones - need).toString();
            note.spirit_stones = need.toString();
        }
        if (cost.law_points) {
            // 法则点挂在 attributes.law_points（展示/后期资源，本批只扣记账）
            const attrs = player.attributes || {};
            const have = Number(attrs.law_points || 0);
            const need = Number(cost.law_points || 0);
            if (have < need) throw new AppError('法则点不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            attrs.law_points = have - need;
            player.attributes = attrs;
            note.law_points = need;
        }
        return note;
    }

    static async _applyRewards(player, block, t) {
        const applied = { exp: '0', spirit_stones: '0', items: [], message: block.message || null };
        if (block.exp) {
            const exp = safeBigInt(player.exp) + safeBigInt(block.exp);
            player.exp = exp.toString();
            applied.exp = safeBigInt(block.exp).toString();
        }
        if (block.spirit_stones) {
            const stones = safeBigInt(player.spirit_stones) + safeBigInt(block.spirit_stones);
            player.spirit_stones = stones.toString();
            applied.spirit_stones = safeBigInt(block.spirit_stones).toString();
        }
        if (block.items?.length) {
            const { granted, failed } = await grantItems(player.id, block.items, t, { label: 'fated_event' });
            applied.items = granted;
            if (failed.length) applied.failed_items = failed;
        }
        await player.save({ transaction: t });
        return applied;
    }
}

module.exports = FatedEventService;
