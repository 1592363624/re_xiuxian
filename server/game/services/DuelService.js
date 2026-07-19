/**
 * 决斗服务（PVP 决斗系统）
 *
 * 提供玩家间正式 1v1 决斗的核心业务逻辑：
 * 1. challenge：发起决斗（境界/赌注/入世状态/每日次数/冷却校验，冻结赌注）
 * 2. acceptDuel：接受决斗（pending -> active）
 * 3. rejectDuel：拒绝决斗（退还赌注，cancelled）
 * 4. executeDuelAction：出招（神通/防御/蓄力，三方相克，回合结算）
 * 5. getDuelStatus：查询决斗状态
 * 6. getDuelHistory：决斗历史
 *
 * 设计原则：
 * - 所有可变参数从 game_balance.json -> pvp_extended.duel 读取，禁止硬编码
 * - 复用 pvp_battle_records 表（battle_type='duel'），不创建新表
 * - 多表/多字段变更使用事务 + 行级锁（player + pvp_battle_records）
 * - spirit_stones 使用 BigInt 运算，避免精度丢失
 * - 决斗不可逃跑（玩法文档明确要求）
 * - 出招相克：神通克蓄力，蓄力克防御，防御克神通
 * - WebSocket 推送通过 WebSocketNotificationService.notifyPlayerUpdate
 * - 每日次数和冷却记录在 player.stats JSON 字段中
 *
 * 状态流转：pending（待接受）-> active（进行中）-> finished（已结束）/ cancelled（已取消）
 */
'use strict';

const Player = require('../../models/player');
const PvpBattleRecord = require('../../models/pvpBattleRecord');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const { infrastructure } = require('../../modules');

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * 直接 BigInt(null) 会抛 TypeError: Cannot convert null to a BigInt，导致接口 500
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined 返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    // 统一转字符串再转 BigInt，避免 number 精度丢失
    return BigInt(String(value));
}

class DuelService {
    /**
     * 构造函数：初始化配置加载器
     * 默认使用全局 infrastructure.ConfigLoader，也可通过 initialize 注入
     */
    constructor() {
        this.configLoader = infrastructure.ConfigLoader;
    }

    /**
     * 初始化方法：接受配置注入（供测试或自定义配置源使用）
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 读取决斗配置
     * 从 game_balance.json -> pvp_extended.duel 读取
     * @returns {Object} 决斗配置对象
     */
    getDuelConfig() {
        const config = this.configLoader.getConfig('game_balance');
        return config?.pvp_extended?.duel || {};
    }

    /**
     * 跨日重置每日决斗次数（基于 stats.duel_last_date）
     * stats 字段为 JSON，存储 duel_count/duel_last_date/duel_last_time
     * @param {Object} stats - 玩家 stats 对象
     */
    _resetDailyDuelCountIfNewDay(stats) {
        const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
        const lastDate = stats.duel_last_date || null;
        if (lastDate !== today) {
            stats.duel_count = 0;
            stats.duel_last_date = today;
        }
    }

    /**
     * 发起决斗
     * 校验：
     * - 双方境界 >= min_realm_rank(3)
     * - 赌注金额在 min_bet_amount ~ max_bet_amount 之间
     * - 双方 pvp_mode='active'（入世状态）
     * - 每日决斗次数 < daily_duel_limit(3)
     * - 冷却时间（cooldown_seconds=600）
     * - 双方无进行中的 PVP/决斗
     * 冻结赌注：从双方扣除赌注金额到临时池（结算时分配给胜方）
     * 创建决斗记录（pvp_battle_records，battle_type='duel'，status='pending'）
     * 通过 WebSocket 通知目标玩家
     * @param {number} playerId - 发起决斗玩家ID
     * @param {number} targetId - 目标玩家ID
     * @param {number} betAmount - 赌注金额（灵石）
     * @returns {Promise<Object>} 决斗信息 { duel_id, status, bet_amount, ... }
     */
    async challenge(playerId, targetId, betAmount) {
        const cfg = this.getDuelConfig();

        // 全局开关
        if (cfg.enabled === false) {
            throw new AppError('决斗系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验
        if (!targetId) {
            throw new AppError('目标玩家ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const targetIdNum = Number(targetId);
        if (!Number.isFinite(targetIdNum) || targetIdNum <= 0) {
            throw new AppError('目标玩家ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 不可决斗自己
        if (Number(playerId) === Number(targetIdNum)) {
            throw new AppError('不可决斗自己', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        // 赌注金额校验
        const betNum = Number(betAmount);
        if (!Number.isFinite(betNum) || betNum <= 0) {
            throw new AppError('赌注金额无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const minBet = cfg.min_bet_amount || 50;
        const maxBet = cfg.max_bet_amount || 50000;
        if (betNum < minBet || betNum > maxBet) {
            throw new AppError(`赌注金额需在 ${minBet} ~ ${maxBet} 灵石之间`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        // 赌注必须为整数（灵石最小单位为 1）
        if (!Number.isInteger(betNum)) {
            throw new AppError('赌注金额必须为整数', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const minRealmRank = cfg.min_realm_rank || 3;

        // 事务包裹：双方玩家行 + 决斗记录 原子性
        const t = await sequelize.transaction();
        try {
            // 行级锁发起方玩家
            const challenger = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!challenger) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (challenger.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁，无法发起决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (challenger.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法发起决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 境界校验：决斗需达到最低境界要求
            const challengerRealmRank = Number(challenger.realm_rank) || 0;
            if (challengerRealmRank < minRealmRank) {
                await t.commit();
                throw new AppError(`境界不足，需达到境界排名 ${minRealmRank} 以上方可决斗`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 入世状态校验：避世状态不可参与决斗
            if (challenger.pvp_mode !== 'active') {
                await t.commit();
                throw new AppError('当前处于避世状态，无法发起决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁目标玩家
            const target = await Player.findByPk(targetIdNum, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!target) {
                await t.commit();
                throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (target.is_banned) {
                await t.commit();
                throw new AppError('目标已封禁，不可决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (target.is_dead) {
                await t.commit();
                throw new AppError('目标已身死道消，不可决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const targetRealmRank = Number(target.realm_rank) || 0;
            if (targetRealmRank < minRealmRank) {
                await t.commit();
                throw new AppError(`目标境界不足，需达到境界排名 ${minRealmRank} 以上`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (target.pvp_mode !== 'active') {
                await t.commit();
                throw new AppError('目标处于避世状态，不可决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 双方进行中 PVP 战斗校验（含普通斗法 ongoing）
            // 使用 PvpBattleRecord 表，battle_type 不限，status 为 ongoing/pending/active 均视为进行中
            const challengerOngoing = await PvpBattleRecord.findOne({
                where: {
                    status: { [Op.in]: ['ongoing', 'pending', 'active'] },
                    [Op.or]: [
                        { attacker_id: playerId },
                        { defender_id: playerId }
                    ]
                },
                transaction: t
            });
            if (challengerOngoing) {
                await t.commit();
                throw new AppError('你已有进行中的战斗，无法发起决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const targetOngoing = await PvpBattleRecord.findOne({
                where: {
                    status: { [Op.in]: ['ongoing', 'pending', 'active'] },
                    [Op.or]: [
                        { attacker_id: targetIdNum },
                        { defender_id: targetIdNum }
                    ]
                },
                transaction: t
            });
            if (targetOngoing) {
                await t.commit();
                throw new AppError('目标玩家正在进行战斗，请稍后再试', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 发起方每日决斗次数与冷却校验（记录在 player.stats JSON 中）
            const challengerStats = { ...challenger.stats };
            this._resetDailyDuelCountIfNewDay(challengerStats);
            const dailyLimit = cfg.daily_duel_limit || 3;
            const dailyCount = Number(challengerStats.duel_count) || 0;
            if (dailyCount >= dailyLimit) {
                await t.commit();
                throw new AppError(`今日决斗次数已达上限（${dailyLimit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 冷却校验：基于 stats.duel_last_time
            const cooldown = cfg.cooldown_seconds || 600;
            if (challengerStats.duel_last_time) {
                const lastTime = new Date(challengerStats.duel_last_time).getTime();
                const elapsed = (Date.now() - lastTime) / 1000;
                if (elapsed < cooldown) {
                    await t.commit();
                    const remain = Math.ceil(cooldown - elapsed);
                    throw new AppError(`决斗冷却中，请 ${remain} 秒后再试`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // 双方灵石余额校验（赌注冻结）
            const challengerStones = safeBigInt(challenger.spirit_stones);
            const targetStones = safeBigInt(target.spirit_stones);
            const betBig = BigInt(betNum);
            if (challengerStones < betBig) {
                await t.commit();
                throw new AppError(`灵石不足，本次决斗赌注需 ${betNum} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (targetStones < betBig) {
                await t.commit();
                throw new AppError(`目标灵石不足，无法匹配赌注 ${betNum} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 冻结赌注：从双方扣除赌注金额（结算时分配给胜方）
            challenger.spirit_stones = challengerStones - betBig;
            target.spirit_stones = targetStones - betBig;

            // 更新发起方 stats（每日次数累加、冷却时间记录）
            challengerStats.duel_count = dailyCount + 1;
            challengerStats.duel_last_time = new Date().toISOString();
            challenger.stats = challengerStats;

            // 读取双方初始 HP/MP（用于决斗战斗，记录在 battle_log 中）
            const chAttrs = challenger.attributes || {};
            const tgAttrs = target.attributes || {};
            const initHp1 = Number(chAttrs.hp_max) || 100;
            const initMp1 = Number(chAttrs.mp_max) || 0;
            const initHp2 = Number(tgAttrs.hp_max) || 100;
            const initMp2 = Number(tgAttrs.mp_max) || 0;

            // 创建决斗记录（复用 pvp_battle_records 表，battle_type='duel'）
            // 初始 status='pending'，等待目标接受
            const now = new Date();
            const initLog = {
                event: 'duel_start',
                attacker_id: playerId,
                defender_id: targetIdNum,
                attacker_nickname: challenger.nickname,
                defender_nickname: target.nickname,
                bet_amount: betNum,
                // 双方初始 HP/MP（决斗战斗专用，不修改 player.attributes 中的当前值）
                attacker_init_hp: initHp1,
                attacker_init_mp: initMp1,
                defender_init_hp: initHp2,
                defender_init_mp: initMp2,
                // 第 1 回合状态（等待双方出招）
                round_state: {
                    round: 1,
                    attacker_hp: initHp1,
                    defender_hp: initHp2,
                    attacker_action: null,
                    defender_action: null,
                    attacker_acted: false,
                    defender_acted: false
                },
                // 已完成回合的历史记录
                rounds_history: [],
                timestamp: now.toISOString()
            };

            const battleRecord = await PvpBattleRecord.create({
                attacker_id: playerId,
                defender_id: targetIdNum,
                battle_type: 'duel',
                winner_id: null,
                total_rounds: 0,
                attacker_score_change: 0,
                defender_score_change: 0,
                attacker_honor_gain: 0,
                defender_honor_gain: 0,
                // 赌注金额暂存于 spirit_stone_reward（结算时更新为实际奖励）
                spirit_stone_reward: betNum,
                drop_item_key: null,
                drop_item_quantity: 0,
                karma_change: 0,
                battle_log: JSON.stringify(initLog),
                // 决斗状态：pending -> active -> finished/cancelled
                status: 'pending',
                started_at: now,
                finished_at: null
            }, { transaction: t });

            await challenger.save({ transaction: t });
            await target.save({ transaction: t });

            await t.commit();

            // 异步推送：通知目标玩家被挑战
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(targetIdNum, 'duel_challenged', {
                    duel_id: battleRecord.id,
                    challenger_id: playerId,
                    challenger_nickname: challenger.nickname,
                    bet_amount: betNum
                });
            } catch (e) { /* 推送失败不阻塞主流程 */ }

            return {
                duel_id: battleRecord.id,
                status: 'pending',
                bet_amount: betNum,
                challenger: {
                    id: challenger.id,
                    nickname: challenger.nickname,
                    realm: challenger.realm,
                    realm_rank: challenger.realm_rank
                },
                target: {
                    id: target.id,
                    nickname: target.nickname,
                    realm: target.realm,
                    realm_rank: target.realm_rank
                },
                attacker_hp: initHp1,
                attacker_mp: initMp1,
                defender_hp: initHp2,
                defender_mp: initMp2,
                accepted: false,
                started_at: now.toISOString()
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 接受决斗（目标玩家调用）
     * 校验决斗状态为 pending，更新为 active
     * @param {number} playerId - 接受决斗玩家ID（须为目标方）
     * @param {number} duelId - 决斗ID
     * @returns {Promise<Object>} 决斗信息
     */
    async acceptDuel(playerId, duelId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁决斗记录
            const battle = await PvpBattleRecord.findByPk(duelId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!battle) {
                await t.commit();
                throw new AppError('决斗记录不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (battle.battle_type !== 'duel') {
                await t.commit();
                throw new AppError('该记录不是决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 校验调用方为目标方
            if (Number(battle.defender_id) !== Number(playerId)) {
                await t.commit();
                throw new AppError('只有被挑战方可以接受决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 校验状态为 pending
            if (battle.status !== 'pending') {
                await t.commit();
                throw new AppError(`决斗当前状态为 ${battle.status}，无法接受`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 更新状态为 active（进行中）
            battle.status = 'active';

            // 确保 battle_log 中的 round_state 已初始化（challenge 时已创建，此处兜底）
            const battleLog = battle.battle_log ? JSON.parse(battle.battle_log) : {};
            if (!battleLog.round_state) {
                // 兜底初始化（正常情况 challenge 时已创建）
                battleLog.round_state = {
                    round: 1,
                    attacker_hp: battleLog.attacker_init_hp || 100,
                    defender_hp: battleLog.defender_init_hp || 100,
                    attacker_action: null,
                    defender_action: null,
                    attacker_acted: false,
                    defender_acted: false
                };
            }
            battle.battle_log = JSON.stringify(battleLog);

            await battle.save({ transaction: t });
            await t.commit();

            // 异步推送：通知挑战方决斗已被接受
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(battle.attacker_id, 'duel_accepted', {
                    duel_id: battle.id,
                    defender_id: playerId
                });
            } catch (e) { /* 推送失败不阻塞 */ }

            return {
                duel_id: battle.id,
                status: 'active',
                message: '决斗已开始，请出招'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 拒绝决斗（目标玩家调用）
     * 退还双方赌注，更新状态为 cancelled
     * @param {number} playerId - 拒绝决斗玩家ID（须为目标方）
     * @param {number} duelId - 决斗ID
     * @returns {Promise<Object>} 拒绝结果
     */
    async rejectDuel(playerId, duelId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁决斗记录
            const battle = await PvpBattleRecord.findByPk(duelId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!battle) {
                await t.commit();
                throw new AppError('决斗记录不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (battle.battle_type !== 'duel') {
                await t.commit();
                throw new AppError('该记录不是决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 校验调用方为目标方
            if (Number(battle.defender_id) !== Number(playerId)) {
                await t.commit();
                throw new AppError('只有被挑战方可以拒绝决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 校验状态为 pending（已开始/已结束的决斗不可拒绝）
            if (battle.status !== 'pending') {
                await t.commit();
                throw new AppError(`决斗当前状态为 ${battle.status}，无法拒绝`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 退还赌注：双方各取回赌注金额
            const betAmount = Number(battle.spirit_stone_reward) || 0;
            const betBig = BigInt(betAmount);

            // 行级锁双方玩家（退还灵石）
            const attacker = await Player.findByPk(battle.attacker_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            const defender = await Player.findByPk(battle.defender_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!attacker || !defender) {
                await t.commit();
                throw new AppError('玩家数据异常', 404, ErrorCodes.NOT_FOUND);
            }

            attacker.spirit_stones = safeBigInt(attacker.spirit_stones) + betBig;
            defender.spirit_stones = safeBigInt(defender.spirit_stones) + betBig;

            // 更新决斗状态为 cancelled
            const now = new Date();
            battle.status = 'cancelled';
            battle.finished_at = now;
            // 重置 spirit_stone_reward 为 0（赌注已退还，无奖励）
            battle.spirit_stone_reward = 0;

            // 追加拒绝日志
            const battleLog = battle.battle_log ? JSON.parse(battle.battle_log) : {};
            if (!Array.isArray(battleLog.rounds_history)) {
                battleLog.rounds_history = [];
            }
            battleLog.rounds_history.push({
                event: 'duel_rejected',
                rejector_id: playerId,
                bet_refunded: betAmount,
                timestamp: now.toISOString()
            });
            battle.battle_log = JSON.stringify(battleLog);

            await attacker.save({ transaction: t });
            await defender.save({ transaction: t });
            await battle.save({ transaction: t });

            await t.commit();

            // 异步推送：通知挑战方决斗被拒绝
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(battle.attacker_id, 'duel_rejected', {
                    duel_id: battle.id,
                    defender_id: playerId,
                    bet_refunded: betAmount
                });
            } catch (e) { /* 推送失败不阻塞 */ }

            return {
                duel_id: battle.id,
                status: 'cancelled',
                bet_refunded: betAmount,
                message: '决斗已拒绝，赌注已退还'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 出招（双方各调用一次，双方都出招后结算回合）
     * 三种出招相克关系：神通(skill)克蓄力(charge)，蓄力(charge)克防御(defend)，防御(defend)克神通(skill)
     * 伤害计算：
     * - 赢方对输方造成伤害（基于赢方攻击力 - 输方防御力 + 随机浮动）
     * - 平局双方互相造成减半伤害
     * - 蓄力赢得回合时，下一回合使用神通可获蓄力加成
     * 胜负判定：HP 归零或达到最大回合数(max_rounds)
     * 胜方获得赌注（双方赌注总额）+ 荣誉值(honor_reward_win)
     * 败方获得少量荣誉值(honor_reward_lose)
     * 决斗不可逃跑
     * @param {number} playerId - 出招玩家ID
     * @param {number} duelId - 决斗ID
     * @param {string} action - 出招类型：skill(神通)/defend(防御)/charge(蓄力)
     * @returns {Promise<Object>} 出招结果（含回合结算信息或等待对手提示）
     */
    async executeDuelAction(playerId, duelId, action) {
        // 参数校验
        const allowedActions = ['skill', 'defend', 'charge'];
        if (!allowedActions.includes(action)) {
            throw new AppError(`无效的出招类型：${action}，可选值：${allowedActions.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁决斗记录（并发安全：双方同时出招时，后到者等待前者的回合更新完成）
            const battle = await PvpBattleRecord.findByPk(duelId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!battle) {
                await t.commit();
                throw new AppError('决斗记录不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (battle.battle_type !== 'duel') {
                await t.commit();
                throw new AppError('该记录不是决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (battle.status !== 'active') {
                await t.commit();
                throw new AppError(`决斗当前状态为 ${battle.status}，无法出招`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 校验调用方为决斗参与方
            const isAttacker = Number(battle.attacker_id) === Number(playerId);
            const isDefender = Number(battle.defender_id) === Number(playerId);
            if (!isAttacker && !isDefender) {
                await t.commit();
                throw new AppError('你不是该决斗的参与方', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁双方玩家
            const attacker = await Player.findByPk(battle.attacker_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            const defender = await Player.findByPk(battle.defender_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!attacker || !defender) {
                await t.commit();
                throw new AppError('玩家数据异常', 404, ErrorCodes.NOT_FOUND);
            }

            // 解析战斗日志，获取当前回合状态
            const battleLog = battle.battle_log ? JSON.parse(battle.battle_log) : {};
            let roundState = battleLog.round_state;
            // 兜底：round_state 不存在时初始化为第 1 回合
            if (!roundState) {
                roundState = {
                    round: 1,
                    attacker_hp: battleLog.attacker_init_hp || 100,
                    defender_hp: battleLog.defender_init_hp || 100,
                    attacker_action: null,
                    defender_action: null,
                    attacker_acted: false,
                    defender_acted: false
                };
            }
            const roundsHistory = Array.isArray(battleLog.rounds_history) ? battleLog.rounds_history : [];

            // 校验当前玩家是否已出招
            const playerRole = isAttacker ? 'attacker' : 'defender';
            if (roundState[`${playerRole}_acted`]) {
                await t.commit();
                throw new AppError('你本回合已出招，等待对手出招', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 记录当前玩家出招
            roundState[`${playerRole}_action`] = action;
            roundState[`${playerRole}_acted`] = true;

            // 判断是否双方都已出招（本回合可结算）
            const bothActed = roundState.attacker_acted && roundState.defender_acted;

            if (!bothActed) {
                // 仅一方出招，等待对方出招
                battleLog.round_state = roundState;
                battle.battle_log = JSON.stringify(battleLog);

                await battle.save({ transaction: t });
                await t.commit();

                // 异步推送：通知对方出招
                try {
                    const WebSocketNotificationService = require('./WebSocketNotificationService');
                    const opponentId = isAttacker ? battle.defender_id : battle.attacker_id;
                    WebSocketNotificationService.notifyPlayerUpdate(opponentId, 'duel_action_pending', {
                        duel_id: battle.id,
                        round: roundState.round,
                        actor_id: playerId,
                        actor_role: playerRole
                    });
                } catch (e) { /* 推送失败不阻塞 */ }

                return {
                    duel_id: battle.id,
                    round: roundState.round,
                    your_action: action,
                    your_role: playerRole,
                    resolved: false,
                    message: '已出招，等待对手出招'
                };
            }

            // 双方都已出招，结算本回合
            const resolveResult = this._resolveRound(
                battle, attacker, defender,
                roundState.attacker_action, roundState.defender_action,
                roundState, roundsHistory, t
            );

            // 更新 battle_log
            battleLog.round_state = resolveResult.nextRoundState;
            battleLog.rounds_history = resolveResult.roundsHistory;
            battle.battle_log = JSON.stringify(battleLog);
            battle.total_rounds = resolveResult.round;

            if (resolveResult.battleEnded) {
                // 决斗结束，调用结算方法
                const settleResult = await this._settleDuel(
                    battle, attacker, defender,
                    resolveResult.winnerId, resolveResult.isDraw, t
                );
                await t.commit();

                // 异步推送：通知双方决斗结果
                try {
                    const WebSocketNotificationService = require('./WebSocketNotificationService');
                    WebSocketNotificationService.notifyPlayerUpdate(battle.attacker_id, 'duel_result', settleResult);
                    WebSocketNotificationService.notifyPlayerUpdate(battle.defender_id, 'duel_result', settleResult);
                } catch (e) { /* 推送失败不阻塞 */ }

                return {
                    duel_id: battle.id,
                    round: resolveResult.round,
                    your_action: action,
                    your_role: playerRole,
                    resolved: true,
                    round_result: resolveResult.roundEntry,
                    battle_ended: true,
                    winner_id: resolveResult.winnerId,
                    is_draw: resolveResult.isDraw,
                    settle: settleResult
                };
            }

            // 回合结束，决斗继续
            await battle.save({ transaction: t });
            await t.commit();

            // 异步推送：通知对方回合结算结果
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                const opponentId = isAttacker ? battle.defender_id : battle.attacker_id;
                WebSocketNotificationService.notifyPlayerUpdate(opponentId, 'duel_round_resolved', {
                    duel_id: battle.id,
                    round: resolveResult.round,
                    round_result: resolveResult.roundEntry,
                    battle_ended: false
                });
            } catch (e) { /* 推送失败不阻塞 */ }

            return {
                duel_id: battle.id,
                round: resolveResult.round,
                your_action: action,
                your_role: playerRole,
                resolved: true,
                round_result: resolveResult.roundEntry,
                battle_ended: false,
                next_round: resolveResult.nextRoundState.round,
                message: '回合已结算，请继续出招'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 内部方法：结算一回合
     * 根据双方出招判定胜负，计算伤害，更新 HP，判断决斗是否结束
     * 相克关系：神通(skill)克蓄力(charge)，蓄力(charge)克防御(defend)，防御(defend)克神通(skill)
     * @param {Object} battle - 决斗记录实例（已加锁）
     * @param {Object} attacker - 攻击方玩家实例（已加锁）
     * @param {Object} defender - 防守方玩家实例（已加锁）
     * @param {string} action1 - 攻击方出招
     * @param {string} action2 - 防守方出招
     * @param {Object} roundState - 当前回合状态
     * @param {Array} roundsHistory - 已完成回合历史
     * @param {Object} t - 事务实例
     * @returns {Object} 结算结果 { round, winnerId, isDraw, battleEnded, roundEntry, nextRoundState, roundsHistory }
     */
    _resolveRound(battle, attacker, defender, action1, action2, roundState, roundsHistory, t) {
        const cfg = this.getDuelConfig();

        // 读取双方战斗属性
        const attackerAttrs = attacker.attributes || {};
        const defenderAttrs = defender.attributes || {};
        const atk1 = Number(attackerAttrs.atk) || 10;
        const def1 = Number(attackerAttrs.def) || 5;
        const atk2 = Number(defenderAttrs.atk) || 10;
        const def2 = Number(defenderAttrs.def) || 5;

        // 读取伤害随机浮动配置
        const combatConfig = this.configLoader.getConfig('game_balance')?.combat || {};
        const dmgRange = combatConfig.damage_random_range ?? 15;
        const dmgOffset = combatConfig.damage_random_offset ?? 7;

        // 判定回合胜负（相克关系）
        const outcome = this._determineOutcome(action1, action2);

        // 蓄力加成：若上一回合蓄力，本回合使用神通时伤害加成 1.5 倍
        const lastRound = roundsHistory.length > 0 ? roundsHistory[roundsHistory.length - 1] : null;
        const attackerChargedLast = lastRound && lastRound.attacker_action === 'charge';
        const defenderChargedLast = lastRound && lastRound.defender_action === 'charge';

        // 计算双方伤害
        let damage1 = 0;  // 攻击方对防守方造成的伤害
        let damage2 = 0;  // 防守方对攻击方造成的伤害

        if (outcome === 'draw') {
            // 平局：双方互相造成减半伤害
            damage1 = Math.max(1, Math.floor((atk1 - def2 + Math.floor(Math.random() * dmgRange) - dmgOffset) / 2));
            damage2 = Math.max(1, Math.floor((atk2 - def1 + Math.floor(Math.random() * dmgRange) - dmgOffset) / 2));
        } else if (outcome === 'p1_win') {
            // 攻击方赢：对防守方造成伤害，自身不受伤害
            let baseDmg = Math.max(1, atk1 - def2 + Math.floor(Math.random() * dmgRange) - dmgOffset);
            // 蓄力加成：上回合蓄力 + 本回合神通 = 1.5 倍伤害
            if (attackerChargedLast && action1 === 'skill') {
                baseDmg = Math.floor(baseDmg * 1.5);
            }
            damage1 = baseDmg;
        } else {
            // 防守方赢（p2_win）：对攻击方造成伤害，自身不受伤害
            let baseDmg = Math.max(1, atk2 - def1 + Math.floor(Math.random() * dmgRange) - dmgOffset);
            // 蓄力加成：上回合蓄力 + 本回合神通 = 1.5 倍伤害
            if (defenderChargedLast && action2 === 'skill') {
                baseDmg = Math.floor(baseDmg * 1.5);
            }
            damage2 = baseDmg;
        }

        // 更新双方 HP（HP 不低于 0）
        const newAttackerHp = Math.max(0, roundState.attacker_hp - damage2);
        const newDefenderHp = Math.max(0, roundState.defender_hp - damage1);
        roundState.attacker_hp = newAttackerHp;
        roundState.defender_hp = newDefenderHp;

        // 判决胜负：HP 归零或达到最大回合数
        const maxRounds = cfg.max_rounds || 20;
        let battleEnded = false;
        let winnerId = null;
        let isDraw = false;

        if (newAttackerHp <= 0 || newDefenderHp <= 0) {
            // HP 归零判定
            battleEnded = true;
            if (newAttackerHp <= 0 && newDefenderHp <= 0) {
                // 双方同时归零，判平局
                isDraw = true;
            } else if (newAttackerHp <= 0) {
                winnerId = defender.id;
            } else {
                winnerId = attacker.id;
            }
        } else if (roundState.round >= maxRounds) {
            // 达到最大回合数，HP 高者胜，相等则平局
            battleEnded = true;
            if (newAttackerHp > newDefenderHp) {
                winnerId = attacker.id;
            } else if (newDefenderHp > newAttackerHp) {
                winnerId = defender.id;
            } else {
                isDraw = true;
            }
        }

        // 构建回合记录
        const roundEntry = {
            round: roundState.round,
            attacker_action: action1,
            defender_action: action2,
            outcome: outcome,  // p1_win/p2_win/draw
            damage_to_defender: damage1,
            damage_to_attacker: damage2,
            attacker_hp_after: newAttackerHp,
            defender_hp_after: newDefenderHp,
            timestamp: new Date().toISOString()
        };
        roundsHistory.push(roundEntry);

        // 若决斗未结束，初始化下一回合状态
        let nextRoundState;
        if (!battleEnded) {
            nextRoundState = {
                round: roundState.round + 1,
                attacker_hp: newAttackerHp,
                defender_hp: newDefenderHp,
                attacker_action: null,
                defender_action: null,
                attacker_acted: false,
                defender_acted: false
            };
        } else {
            // 决斗结束，清空 round_state
            nextRoundState = null;
        }

        return {
            round: roundState.round,
            winnerId,
            isDraw,
            battleEnded,
            roundEntry,
            nextRoundState,
            roundsHistory
        };
    }

    /**
     * 内部方法：判定回合胜负
     * 相克关系：神通(skill)克蓄力(charge)，蓄力(charge)克防御(defend)，防御(defend)克神通(skill)
     * @param {string} action1 - 攻击方出招
     * @param {string} action2 - 防守方出招
     * @returns {string} 胜负结果：p1_win(攻击方胜)/p2_win(防守方胜)/draw(平局)
     */
    _determineOutcome(action1, action2) {
        // 同招平局
        if (action1 === action2) return 'draw';
        // 相克关系映射：key 克 value
        const counters = {
            skill: 'charge',    // 神通克蓄力
            charge: 'defend',   // 蓄力克防御
            defend: 'skill'     // 防御克神通
        };
        // 攻击方克防守方
        if (counters[action1] === action2) return 'p1_win';
        // 防守方克攻击方
        if (counters[action2] === action1) return 'p2_win';
        // 兜底（理论上不会走到这里）
        return 'draw';
    }

    /**
     * 内部方法：决斗结算（决斗结束时调用）
     * - 胜方获得赌注（双方赌注总额 = bet_amount * 2）+ 荣誉值(honor_reward_win)
     * - 败方获得少量荣誉值(honor_reward_lose)
     * - 平局：退还双方赌注，双方各得荣誉值均值
     * - 更新决斗记录 status='finished'、winner_id、荣誉收益
     * - 重置双方 attributes 中的 hp_current/mp_current 为最大值（决斗结束恢复正常状态）
     * @param {Object} battle - 决斗记录实例（已加锁）
     * @param {Object} attacker - 攻击方玩家实例（已加锁）
     * @param {Object} defender - 防守方玩家实例（已加锁）
     * @param {number|null} winnerId - 胜者ID（null 表示平局）
     * @param {boolean} isDraw - 是否平局
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} 结算结果
     */
    async _settleDuel(battle, attacker, defender, winnerId, isDraw, t) {
        const cfg = this.getDuelConfig();
        const now = new Date();

        // 读取赌注金额（challenge 时暂存于 spirit_stone_reward）
        const betAmount = Number(battle.spirit_stone_reward) || 0;
        // 胜方获得双方赌注总额（bet_amount * 2）
        const totalReward = betAmount * 2;

        // 荣誉值奖励
        const honorWin = cfg.honor_reward_win || 30;
        const honorLose = cfg.honor_reward_lose || 5;

        let attackerHonorGain = 0;
        let defenderHonorGain = 0;
        let attackerStoneGain = 0;
        let defenderStoneGain = 0;

        if (isDraw || winnerId === null) {
            // 平局：退还双方赌注，荣誉值各取均值
            attackerStoneGain = betAmount;
            defenderStoneGain = betAmount;
            attackerHonorGain = Math.floor((honorWin + honorLose) / 2);
            defenderHonorGain = Math.floor((honorWin + honorLose) / 2);
        } else if (Number(winnerId) === Number(attacker.id)) {
            // 攻击方胜：获得赌注总额 + 胜方荣誉值
            attackerStoneGain = totalReward;
            attackerHonorGain = honorWin;
            defenderHonorGain = honorLose;
        } else {
            // 防守方胜：获得赌注总额 + 胜方荣誉值
            defenderStoneGain = totalReward;
            defenderHonorGain = honorWin;
            attackerHonorGain = honorLose;
        }

        // 更新双方灵石（BigInt 运算）
        attacker.spirit_stones = safeBigInt(attacker.spirit_stones) + BigInt(attackerStoneGain);
        defender.spirit_stones = safeBigInt(defender.spirit_stones) + BigInt(defenderStoneGain);

        // 更新双方荣誉值（BigInt 运算）
        attacker.honor = safeBigInt(attacker.honor) + BigInt(attackerHonorGain);
        defender.honor = safeBigInt(defender.honor) + BigInt(defenderHonorGain);

        // 重置双方 attributes 中的 hp_current/mp_current 为最大值
        // 决斗期间 HP 变化记录在 battle_log 中，不影响 player.attributes
        // 决斗结束后恢复满血状态（避免影响其他玩法）
        const attackerAttrs = { ...(attacker.attributes || {}) };
        const defenderAttrs = { ...(defender.attributes || {}) };
        attackerAttrs.hp_current = Number(attackerAttrs.hp_max) || 100;
        attackerAttrs.mp_current = Number(attackerAttrs.mp_max) || 0;
        defenderAttrs.hp_current = Number(defenderAttrs.hp_max) || 100;
        defenderAttrs.mp_current = Number(defenderAttrs.mp_max) || 0;
        attacker.attributes = attackerAttrs;
        defender.attributes = defenderAttrs;

        // 更新决斗记录
        battle.status = 'finished';
        battle.winner_id = winnerId;
        battle.finished_at = now;
        battle.attacker_honor_gain = attackerHonorGain;
        battle.defender_honor_gain = defenderHonorGain;
        // spirit_stone_reward 记录胜方实际获得的灵石（平局为 0）
        battle.spirit_stone_reward = isDraw ? 0 : totalReward;

        // 追加结算日志
        const battleLog = battle.battle_log ? JSON.parse(battle.battle_log) : {};
        if (!Array.isArray(battleLog.rounds_history)) {
            battleLog.rounds_history = [];
        }
        battleLog.rounds_history.push({
            event: 'duel_settled',
            winner_id: winnerId,
            is_draw: isDraw,
            attacker_honor_gain: attackerHonorGain,
            defender_honor_gain: defenderHonorGain,
            spirit_stone_reward: isDraw ? 0 : totalReward,
            timestamp: now.toISOString()
        });
        battle.battle_log = JSON.stringify(battleLog);

        // 持久化
        await attacker.save({ transaction: t });
        await defender.save({ transaction: t });
        await battle.save({ transaction: t });

        // 记录 admin_logs（审计）
        try {
            const AdminLog = require('../../models/admin_log');
            await AdminLog.create({
                admin_id: 0,  // 系统自动结算，无 GM 操作人
                action: 'duel_settle',
                target_id: battle.id,
                details: JSON.stringify({
                    attacker_id: attacker.id,
                    defender_id: defender.id,
                    winner_id: winnerId,
                    is_draw: isDraw,
                    bet_amount: betAmount,
                    attacker_honor_gain: attackerHonorGain,
                    defender_honor_gain: defenderHonorGain,
                    spirit_stone_reward: isDraw ? 0 : totalReward
                }),
                ip: null
            }, { transaction: t });
        } catch (e) { /* 审计日志失败不阻塞主流程 */ }

        return {
            duel_id: battle.id,
            winner_id: winnerId,
            is_draw: isDraw,
            bet_amount: betAmount,
            attacker_honor_gain: attackerHonorGain,
            defender_honor_gain: defenderHonorGain,
            spirit_stone_reward: isDraw ? 0 : totalReward,
            finished_at: now.toISOString()
        };
    }

    /**
     * 查询决斗状态
     * @param {number} playerId - 玩家ID（须为决斗参与方）
     * @param {number} duelId - 决斗ID
     * @returns {Promise<Object>} 决斗状态信息
     */
    async getDuelStatus(playerId, duelId) {
        const battle = await PvpBattleRecord.findByPk(duelId);
        if (!battle) {
            throw new AppError('决斗记录不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (battle.battle_type !== 'duel') {
            throw new AppError('该记录不是决斗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        // 校验调用方为决斗参与方
        const isAttacker = Number(battle.attacker_id) === Number(playerId);
        const isDefender = Number(battle.defender_id) === Number(playerId);
        if (!isAttacker && !isDefender) {
            throw new AppError('你不是该决斗的参与方', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 解析战斗日志
        const battleLog = battle.battle_log ? JSON.parse(battle.battle_log) : {};

        // 查询双方玩家信息（避免 N+1 查询）
        const [attacker, defender] = await Promise.all([
            Player.findByPk(battle.attacker_id, {
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            }),
            Player.findByPk(battle.defender_id, {
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            })
        ]);

        return {
            duel_id: battle.id,
            status: battle.status,
            bet_amount: Number(battle.spirit_stone_reward) || 0,
            is_attacker: isAttacker,
            attacker: attacker ? {
                id: attacker.id,
                nickname: attacker.nickname,
                realm: attacker.realm,
                realm_rank: attacker.realm_rank
            } : null,
            defender: defender ? {
                id: defender.id,
                nickname: defender.nickname,
                realm: defender.realm,
                realm_rank: defender.realm_rank
            } : null,
            total_rounds: battle.total_rounds,
            winner_id: battle.winner_id,
            current_round: battleLog.round_state?.round || 0,
            attacker_hp: battleLog.round_state?.attacker_hp ?? battleLog.attacker_init_hp ?? 0,
            defender_hp: battleLog.round_state?.defender_hp ?? battleLog.defender_init_hp ?? 0,
            // 你的出招状态（本回合是否已出招）
            your_acted: isAttacker
                ? (battleLog.round_state?.attacker_acted ?? false)
                : (battleLog.round_state?.defender_acted ?? false),
            your_action: isAttacker
                ? (battleLog.round_state?.attacker_action ?? null)
                : (battleLog.round_state?.defender_action ?? null),
            rounds_history: battleLog.rounds_history || [],
            started_at: battle.started_at,
            finished_at: battle.finished_at
        };
    }

    /**
     * 获取决斗历史
     * 分页查询玩家参与的决斗记录（battle_type='duel'）
     * @param {number} playerId - 玩家ID
     * @param {number} page - 页码（从 1 开始）
     * @param {number} pageSize - 每页数量
     * @returns {Promise<Object>} 决斗历史列表 { list, total, page, page_size }
     */
    async getDuelHistory(playerId, page = 1, pageSize = 20) {
        const safePage = Math.max(1, page);
        const safePageSize = Math.min(Math.max(1, pageSize), 100);
        const offset = (safePage - 1) * safePageSize;

        const { count, rows } = await PvpBattleRecord.findAndCountAll({
            where: {
                battle_type: 'duel',
                [Op.or]: [
                    { attacker_id: playerId },
                    { defender_id: playerId }
                ]
            },
            order: [['started_at', 'DESC']],
            limit: safePageSize,
            offset
        });

        // 批量查询对手玩家信息（避免 N+1 查询）
        const opponentIds = new Set();
        for (const r of rows) {
            if (Number(r.attacker_id) !== Number(playerId)) opponentIds.add(r.attacker_id);
            if (Number(r.defender_id) !== Number(playerId)) opponentIds.add(r.defender_id);
        }
        const opponentIdArray = Array.from(opponentIds);
        const opponents = opponentIdArray.length > 0
            ? await Player.findAll({
                where: { id: opponentIdArray },
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            })
            : [];
        const opponentMap = new Map(opponents.map(p => [p.id, p]));

        const list = rows.map(r => {
            const isAttacker = Number(r.attacker_id) === Number(playerId);
            const opponentId = isAttacker ? r.defender_id : r.attacker_id;
            const opponent = opponentMap.get(opponentId);
            const isWin = r.winner_id !== null && Number(r.winner_id) === Number(playerId);
            const isDraw = r.winner_id === null && r.status === 'finished';
            return {
                duel_id: r.id,
                status: r.status,
                is_attacker: isAttacker,
                opponent: opponent ? {
                    id: opponent.id,
                    nickname: opponent.nickname,
                    realm: opponent.realm,
                    realm_rank: opponent.realm_rank
                } : null,
                winner_id: r.winner_id,
                is_win: isWin,
                is_draw: isDraw,
                total_rounds: r.total_rounds,
                bet_amount: Number(r.spirit_stone_reward) || 0,
                honor_gain: isAttacker ? Number(r.attacker_honor_gain) : Number(r.defender_honor_gain),
                started_at: r.started_at,
                finished_at: r.finished_at
            };
        });

        return {
            list,
            total: count,
            page: safePage,
            page_size: safePageSize
        };
    }
}

// 导出单例实例（符合任务要求的单例模式）
module.exports = new DuelService();
