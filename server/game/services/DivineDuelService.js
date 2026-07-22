/**
 * 神识对决服务
 *
 * 实现玩法文档第18节"神识对决"的全部业务逻辑：
 *   1. challenge：发起挑战（境界/神识/赌注校验，扣除入场神识+赌注）
 *   2. accept：接受挑战（pending -> active，初始化护盾和回合）
 *   3. action：执行行动（凝神 focus / 固元 stabilize），双方都提交后结算
 *   4. getActiveDuel：查询当前进行中的对局
 *   5. getHistory：查询历史对局
 *   6. surrender：投降（立即结算，对手胜）
 *   7. checkTimeouts：超时检查（对局创建超时取消 / 操作超时自动固元）
 *
 * 核心设计：
 *   - 同时选择博弈：双方都提交行动后才结算，第一方提交后等待对方
 *   - 结算矩阵（A 行 / B 列）：
 *       凝神 vs 凝神：A -15护盾 + 受20伤害, B -15护盾 + 受20伤害
 *       凝神 vs 固元：A -15护盾 + 受10伤害(减半), B +10护盾 + 受20伤害
 *       固元 vs 凝神：A +10护盾 + 受20伤害, B -15护盾 + 受10伤害(减半)
 *       固元 vs 固元：A +5护盾(减半), B +5护盾(减半)
 *   - 初始护盾 100，护盾上限 100，回合上限 20
 *   - 胜负判定：护盾 <= 0 失败；20 回合后护盾高者胜；相同则平局
 *   - 赌注机制：发起时扣除赌注，结算时发放给胜者（平局退还一半）
 *
 * 设计原则：
 *   - 所有阈值/比例从 late_stage_data.json -> divine_duel 读取，禁止硬编码
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁（player + duel）
 *   - WebSocket 推送在事务提交后，避免数据回滚不一致
 *   - 单例导出，便于调度器调用 checkTimeouts
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/divine_sense_balance/divine_duel_*_date）
 *   - PlayerDivineDuel: 对局记录表
 *   - PlayerDivineSense: 神识表（用于神识赌注的扣减/恢复）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerDivineDuel = require('../../models/playerDivineDuel');
const PlayerDivineSense = require('../../models/playerDivineSense');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');
// 大五行幻世轮服务（神识对决结算后积累悟印，未装备时静默返回）
const ArtifactDeepLineService = require('./ArtifactDeepLineService');

// 单例状态
let _initialized = false;
let _config = null;
let _realmService = null;

/**
 * 工具函数：今日日期字符串 YYYY-MM-DD
 * @returns {string}
 */
function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 工具函数：BigInt 安全转换（用于灵石运算）
 * @param {string|number|bigint|null|undefined} value
 * @returns {bigint}
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    return BigInt(String(value));
}

class DivineDuelService {
    /**
     * 初始化服务：加载配置与 RealmService
     * 防御性配置加载：包裹 try/catch，配置缺失时仅警告不阻塞
     * @param {Object} configLoaderInstance - 配置加载器实例
     */
    initialize(configLoaderInstance) {
        if (_initialized) return;
        try {
            const loader = configLoaderInstance || configLoader;
            _config = loader.getConfig('late_stage_data')?.divine_duel;
        } catch (e) {
            console.warn('[DivineDuelService] 配置 late_stage_data.divine_duel 未加载，服务不可用:', e.message);
            return;
        }
        if (!_config) {
            console.warn('[DivineDuelService] 配置 divine_duel 为空，服务不可用');
            return;
        }
        // 延迟获取 RealmService（避免循环依赖）
        try {
            const game = require('../index');
            _realmService = game.RealmService;
        } catch (e) {
            console.warn('[DivineDuelService] RealmService 加载失败:', e.message);
        }
        _initialized = true;
        console.log('[DivineDuelService] 神识对决服务初始化完成');
    }

    /**
     * 获取配置
     * 防御性加载：未初始化时尝试重新加载，失败返回 null
     * @returns {Object|null}
     */
    getConfig() {
        if (!_initialized || !_config) {
            try {
                _config = configLoader.getConfig('late_stage_data')?.divine_duel;
                _initialized = !!_config;
            } catch (e) {
                return null;
            }
        }
        return _config;
    }

    /**
     * 境界校验：玩家需达到化神初期（rank >= 23）
     * @param {Object} player - 玩家对象
     * @returns {{ met: boolean, reason?: string }}
     */
    _checkRealm(player) {
        const config = this.getConfig();
        if (!config) return { met: false, reason: '神识对决配置未加载' };
        const minRealmName = config.min_realm_name || '化神期';
        if (!_realmService) {
            // 兜底：直接用 realm_rank 数值比较
            const playerRank = Number(player.realm_rank) || 0;
            const requiredRank = Number(config.min_realm_rank) || 23;
            if (playerRank < requiredRank) {
                return { met: false, reason: `境界不足，需达到 ${minRealmName}（rank ${requiredRank}）` };
            }
            return { met: true };
        }
        const realmCheck = _realmService.meetsRealmRequirement(player, minRealmName);
        if (!realmCheck.met) {
            return { met: false, reason: realmCheck.reason };
        }
        return { met: true };
    }

    /**
     * 校验赌注类型与金额
     * @param {string} betType - spirit_stone / divine_sense
     * @param {number} betAmount - 赌注金额
     * @returns {{ valid: boolean, message?: string }}
     */
    _validateBet(betType, betAmount) {
        const config = this.getConfig();
        if (!config) return { valid: false, message: '神识对决配置未加载' };
        const betTypes = config.bet_types || {};
        const betCfg = betTypes[betType];
        if (!betCfg) {
            return { valid: false, message: `赌注类型无效：${betType}（仅支持 spirit_stone/divine_sense）` };
        }
        const amount = Number(betAmount);
        if (!Number.isInteger(amount) || amount <= 0) {
            return { valid: false, message: '赌注金额必须为正整数' };
        }
        const min = Number(betCfg.min);
        const max = Number(betCfg.max);
        if (amount < min || amount > max) {
            return { valid: false, message: `赌注金额需在 ${min} ~ ${max} 之间（${betType}）` };
        }
        return { valid: true };
    }

    /**
     * 跨日重置每日挑战次数（基于 divine_duel_challenge_date）
     * @param {Object} player - 玩家对象
     * @returns {number} 今日已挑战次数（跨日返回 0）
     */
    _getTodayChallengeCount(player) {
        const today = todayStr();
        const lastDate = player.divine_duel_challenge_date;
        if (!lastDate || String(lastDate).slice(0, 10) !== today) {
            return 0;
        }
        // 由于未单独存次数字段，通过查询今日已发起的对局数量获得
        return -1; // -1 表示需要查询数据库
    }

    /**
     * 查询玩家今日已发起的对局数
     * @param {number} playerId
     * @returns {Promise<number>}
     */
    async _countTodayChallenges(playerId) {
        const today = todayStr();
        // 由于 created_at 是 DATETIME，需用区间查询
        const startOfDay = new Date(`${today}T00:00:00`);
        const endOfDay = new Date(`${today}T23:59:59`);
        const count = await PlayerDivineDuel.count({
            where: {
                challenger_id: playerId,
                created_at: { [Op.between]: [startOfDay, endOfDay] }
            }
        });
        return count;
    }

    /**
     * 查询玩家今日已接受的对局数
     * @param {number} playerId
     * @returns {Promise<number>}
     */
    async _countTodayAccepts(playerId) {
        const today = todayStr();
        const startOfDay = new Date(`${today}T00:00:00`);
        const endOfDay = new Date(`${today}T23:59:59`);
        // 已接受的对局 status 为 active/finished，且 defender_id 为该玩家
        // 通过 updated_at 判断接受时间（pending -> active 时 updated_at 更新）
        const count = await PlayerDivineDuel.count({
            where: {
                defender_id: playerId,
                status: { [Op.in]: ['active', 'finished'] },
                updated_at: { [Op.between]: [startOfDay, endOfDay] }
            }
        });
        return count;
    }

    /**
     * 检查玩家是否有进行中的对局
     * @param {number} playerId
     * @param {Object} [transaction] - 事务实例
     * @returns {Promise<Object|null>} 进行中的对局或 null
     */
    async _findActiveDuel(playerId, transaction) {
        return await PlayerDivineDuel.findOne({
            where: {
                status: { [Op.in]: ['pending', 'active'] },
                [Op.or]: [
                    { challenger_id: playerId },
                    { defender_id: playerId }
                ]
            },
            transaction,
            lock: transaction ? transaction.LOCK.UPDATE : undefined
        });
    }

    /**
     * 发起挑战
     *
     * 业务流程：
     *   1. 校验配置/境界/赌注/每日次数
     *   2. 校验发起方神识余额（>= entry_divine_sense_cost）
     *   3. 校验发起方赌注余额（>= bet_amount）
     *   4. 扣除入场神识（50 点，存入 divine_sense_balance）
     *   5. 扣除赌注（灵石或神识）
     *   6. 创建对局记录（status=pending）
     *   7. WebSocket 通知目标玩家
     *
     * @param {Object} challenger - 发起方玩家对象（含 realm_rank）
     * @param {number} defenderId - 目标玩家ID
     * @param {string} betType - 赌注类型：spirit_stone/divine_sense
     * @param {number} betAmount - 赌注金额
     * @returns {Promise<Object>} { success, message, data }
     */
    async challenge(challenger, defenderId, betType, betAmount) {
        // 配置校验
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '神识对决配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        // 参数校验
        const defenderIdNum = Number(defenderId);
        if (!Number.isFinite(defenderIdNum) || defenderIdNum <= 0) {
            return { success: false, message: '目标玩家ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (Number(challenger.id) === Number(defenderIdNum)) {
            return { success: false, message: '不可对自己发起神识对决', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        // 赌注校验
        const betCheck = this._validateBet(betType, betAmount);
        if (!betCheck.valid) {
            return { success: false, message: betCheck.message, error_code: ErrorCodes.VALIDATION_ERROR };
        }

        // 境界校验
        const realmCheck = this._checkRealm(challenger);
        if (!realmCheck.met) {
            return { success: false, message: realmCheck.reason, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁发起方玩家
            const challengerLocked = await Player.findByPk(challenger.id, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!challengerLocked) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }
            if (challengerLocked.is_banned) {
                await t.rollback();
                return { success: false, message: '账号已封禁，无法发起神识对决' };
            }
            if (challengerLocked.is_dead) {
                await t.rollback();
                return { success: false, message: '已身死道消，无法发起神识对决' };
            }

            // 行级锁目标玩家
            const defender = await Player.findByPk(defenderIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!defender) {
                await t.rollback();
                return { success: false, message: '目标玩家不存在' };
            }
            if (defender.is_banned) {
                await t.rollback();
                return { success: false, message: '目标已封禁，不可对决' };
            }
            if (defender.is_dead) {
                await t.rollback();
                return { success: false, message: '目标已身死道消，不可对决' };
            }

            // 目标境界校验
            const defenderRealmCheck = this._checkRealm(defender);
            if (!defenderRealmCheck.met) {
                await t.rollback();
                return { success: false, message: `目标${defenderRealmCheck.reason}` };
            }

            // 双方进行中对局校验
            const challengerActive = await this._findActiveDuel(challengerLocked.id, t);
            if (challengerActive) {
                await t.rollback();
                return { success: false, message: '你已有进行中的神识对决，请先完成或投降' };
            }
            const defenderActive = await this._findActiveDuel(defender.id, t);
            if (defenderActive) {
                await t.rollback();
                return { success: false, message: '目标玩家已有进行中的神识对决，请稍后再试' };
            }

            // 每日发起次数校验
            const todayChallengeCount = await this._countTodayChallenges(challengerLocked.id);
            const challengeLimit = Number(config.challenge_daily_limit) || 3;
            if (todayChallengeCount >= challengeLimit) {
                await t.rollback();
                return { success: false, message: `今日发起神识对决次数已达上限（${challengeLimit} 次/日）` };
            }

            // 入场神识消耗校验（50 点）
            // 注意：神识余额存在双源（players.divine_sense_balance + player_divine_senses.divine_sense_current）
            //       此前先以 player_divine_senses 表为准同步到 players 表，避免读到旧值
            const entryCost = Number(config.entry_divine_sense_cost) || 50;
            const challengerDivineSense = await this._refreshDivineSenseBalance(challengerLocked, t);
            if (challengerDivineSense < entryCost) {
                await t.rollback();
                return { success: false, message: `神识不足，发起对决需消耗 ${entryCost} 神识（当前 ${challengerDivineSense}）` };
            }

            // 赌注余额校验与扣除
            const betAmountNum = Number(betAmount);
            if (betType === 'spirit_stone') {
                const challengerStones = safeBigInt(challengerLocked.spirit_stones);
                const betBig = BigInt(betAmountNum);
                if (challengerStones < betBig) {
                    await t.rollback();
                    return { success: false, message: `灵石不足，赌注需 ${betAmountNum}（当前 ${challengerStones.toString()}）` };
                }
                challengerLocked.spirit_stones = challengerStones - betBig;
            } else if (betType === 'divine_sense') {
                // 神识赌注：从 divine_sense_balance 扣除（与入场消耗叠加）
                const totalCost = entryCost + betAmountNum;
                if (challengerDivineSense < totalCost) {
                    await t.rollback();
                    return { success: false, message: `神识不足，发起对决需消耗 ${entryCost}（入场）+ ${betAmountNum}（赌注）= ${totalCost} 神识（当前 ${challengerDivineSense}）` };
                }
                // 同时扣除入场消耗和赌注
                challengerLocked.divine_sense_balance = challengerDivineSense - totalCost;
                // 同步神识表（用于后续恢复/统计）
                await this._syncDivineSenseTable(challengerLocked.id, challengerLocked.divine_sense_balance, t);
            }

            // 灵石赌注的入场神识扣除（独立于赌注）
            if (betType === 'spirit_stone') {
                challengerLocked.divine_sense_balance = challengerDivineSense - entryCost;
                await this._syncDivineSenseTable(challengerLocked.id, challengerLocked.divine_sense_balance, t);
            }

            // 更新挑战日期标记
            challengerLocked.divine_duel_challenge_date = todayStr();

            await challengerLocked.save({ transaction: t });

            // 创建对局记录
            const initShield = Number(config.init_shield) || 100;
            const challengeTimeoutSec = Number(config.challenge_timeout_seconds) || 60;
            const challengeDeadline = new Date(Date.now() + challengeTimeoutSec * 1000);

            const duel = await PlayerDivineDuel.create({
                challenger_id: challengerLocked.id,
                defender_id: defender.id,
                bet_type: betType,
                bet_amount: betAmountNum,
                status: 'pending',
                winner_id: null,
                challenger_shield: initShield,
                defender_shield: initShield,
                challenger_action: null,
                defender_action: null,
                round_number: 0,
                action_deadline: challengeDeadline,  // pending 阶段复用为接受截止时间
                settle_reason: null,
                finished_at: null
            }, { transaction: t });

            await t.commit();

            // 事务提交后推送通知（避免回滚不一致）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(defender.id, 'divine_duel_challenged', {
                    duel_id: duel.id,
                    challenger_id: challengerLocked.id,
                    challenger_nickname: challengerLocked.nickname,
                    bet_type: betType,
                    bet_amount: betAmountNum,
                    challenge_deadline: challengeDeadline
                });
            } catch (e) {
                console.warn('[DivineDuelService] 推送挑战通知失败:', e.message);
            }

            return {
                success: true,
                message: `已向 ${defender.nickname} 发起神识对决（赌注：${betAmountNum} ${betType === 'spirit_stone' ? '灵石' : '神识'}），等待对方接受（${challengeTimeoutSec}秒内未接受自动取消）`,
                data: {
                    duel_id: duel.id,
                    status: 'pending',
                    bet_type: betType,
                    bet_amount: betAmountNum,
                    challenger_shield: initShield,
                    defender_shield: initShield,
                    challenge_deadline: challengeDeadline,
                    entry_divine_sense_cost: entryCost
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineDuelService] challenge 异常:', err);
            throw err;
        }
    }

    /**
     * 同步神识表（player_divine_sense）的当前值
     * 用于在神识赌注扣减后保持两张表数据一致
     * @param {number} playerId - 玩家ID
     * @param {number} newSenseValue - 新的神识值
     * @param {Object} transaction - 事务实例
     */
    async _syncDivineSenseTable(playerId, newSenseValue, transaction) {
        try {
            const sense = await PlayerDivineSense.findOne({
                where: { player_id: playerId },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (sense) {
                sense.divine_sense_current = Math.max(0, Number(newSenseValue));
                sense.total_consumed = Number(sense.total_consumed || 0) + 0; // 已在调用方扣减，此处仅同步
                await sense.save({ transaction });
            }
        } catch (e) {
            console.warn('[DivineDuelService] 同步神识表失败:', e.message);
        }
    }

    /**
     * 从 player_divine_senses 表同步神识余额到 players.divine_sense_balance
     *
     * 背景：神识余额存在双源（players.divine_sense_balance + player_divine_senses.divine_sense_current）
     *   - DivineSenseService（淬炼/GM 发放/自然恢复）写入 player_divine_senses 表
     *   - DuelService 读取 players.divine_sense_balance
     * 这会导致 DuelService 读到旧值（如淬炼后 player_divine_senses 已增加，但 players 表未同步）
     *
     * 修复策略：DuelService 在读取神识余额前，先以 player_divine_senses.divine_sense_current 为权威源
     *           同步到 players.divine_sense_balance，再做后续校验与扣减
     *
     * @param {Object} playerLocked - 已加锁的 Player 实例
     * @param {Object} transaction - 事务实例
     * @returns {Promise<number>} 同步后的神识余额（即 player.divine_sense_balance 的新值）
     */
    async _refreshDivineSenseBalance(playerLocked, transaction) {
        try {
            const sense = await PlayerDivineSense.findOne({
                where: { player_id: playerLocked.id },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (!sense) {
                // 神识表无记录，保持 players.divine_sense_balance 原值
                return Number(playerLocked.divine_sense_balance || 0);
            }
            const authoritative = Number(sense.divine_sense_current || 0);
            const current = Number(playerLocked.divine_sense_balance || 0);
            if (authoritative !== current) {
                // 数据不一致：以 player_divine_senses 表为准
                playerLocked.divine_sense_balance = authoritative;
                await playerLocked.save({ transaction });
                console.log(`[DivineDuelService] 神识余额双源同步：玩家 ${playerLocked.id} ${current} → ${authoritative}`);
            }
            return authoritative;
        } catch (e) {
            console.warn('[DivineDuelService] 同步神识余额失败:', e.message);
            return Number(playerLocked.divine_sense_balance || 0);
        }
    }

    /**
     * 接受挑战
     *
     * 业务流程：
     *   1. 校验对局状态为 pending
     *   2. 校验接受方为对局的 defender
     *   3. 校验接受方赌注余额（>= bet_amount）
     *   4. 扣除接受方赌注
     *   5. 状态转为 active，初始化第一回合
     *   6. WebSocket 通知双方
     *
     * @param {Object} player - 接受方玩家对象
     * @param {number} duelId - 对局ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async accept(player, duelId) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '神识对决配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        const duelIdNum = Number(duelId);
        if (!Number.isFinite(duelIdNum) || duelIdNum <= 0) {
            return { success: false, message: '对局ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const playerLocked = await Player.findByPk(player.id, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!playerLocked) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 行级锁对局记录
            const duel = await PlayerDivineDuel.findByPk(duelIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!duel) {
                await t.rollback();
                return { success: false, message: '对局不存在' };
            }
            if (duel.status !== 'pending') {
                await t.rollback();
                return { success: false, message: `对局状态为 ${duel.status}，无法接受` };
            }
            if (duel.defender_id !== playerLocked.id) {
                await t.rollback();
                return { success: false, message: '你不是该对局的应战方' };
            }

            // 接受截止时间校验
            if (duel.action_deadline && new Date() > duel.action_deadline) {
                // 标记为 cancelled（让 checkTimeouts 统一处理退款）
                duel.status = 'cancelled';
                duel.settle_reason = 'timeout';
                duel.finished_at = new Date();
                await duel.save({ transaction: t });
                await t.commit();
                return { success: false, message: '对局已超时，自动取消' };
            }

            // 每日接受次数校验
            const todayAcceptCount = await this._countTodayAccepts(playerLocked.id);
            const acceptLimit = Number(config.accept_daily_limit) || 5;
            if (todayAcceptCount >= acceptLimit) {
                await t.rollback();
                return { success: false, message: `今日接受神识对决次数已达上限（${acceptLimit} 次/日）` };
            }

            // 赌注余额校验与扣除
            // 神识赌注前先以 player_divine_senses 表为准同步（与 challenge 一致）
            const betType = duel.bet_type;
            const betAmount = Number(duel.bet_amount);
            if (betType === 'spirit_stone') {
                const stones = safeBigInt(playerLocked.spirit_stones);
                const betBig = BigInt(betAmount);
                if (stones < betBig) {
                    await t.rollback();
                    return { success: false, message: `灵石不足，赌注需 ${betAmount}（当前 ${stones.toString()}）` };
                }
                playerLocked.spirit_stones = stones - betBig;
            } else if (betType === 'divine_sense') {
                const sense = await this._refreshDivineSenseBalance(playerLocked, t);
                if (sense < betAmount) {
                    await t.rollback();
                    return { success: false, message: `神识不足，赌注需 ${betAmount}（当前 ${sense}）` };
                }
                playerLocked.divine_sense_balance = sense - betAmount;
                await this._syncDivineSenseTable(playerLocked.id, playerLocked.divine_sense_balance, t);
            }

            // 更新接受日期标记
            playerLocked.divine_duel_accept_date = todayStr();
            await playerLocked.save({ transaction: t });

            // 对局状态转为 active，初始化第一回合
            const actionTimeoutSec = Number(config.action_timeout_seconds) || 60;
            const actionDeadline = new Date(Date.now() + actionTimeoutSec * 1000);
            duel.status = 'active';
            duel.round_number = 1;
            duel.challenger_action = null;
            duel.defender_action = null;
            duel.action_deadline = actionDeadline;
            await duel.save({ transaction: t });

            await t.commit();

            // 事务提交后通知双方
            try {
                WebSocketNotificationService.notifyPlayerUpdate(duel.challenger_id, 'divine_duel_accepted', {
                    duel_id: duel.id,
                    defender_id: playerLocked.id,
                    defender_nickname: playerLocked.nickname,
                    round_number: 1,
                    action_deadline: actionDeadline
                });
                WebSocketNotificationService.notifyPlayerUpdate(duel.defender_id, 'divine_duel_started', {
                    duel_id: duel.id,
                    challenger_id: duel.challenger_id,
                    round_number: 1,
                    action_deadline: actionDeadline
                });
            } catch (e) {
                console.warn('[DivineDuelService] 推送接受通知失败:', e.message);
            }

            return {
                success: true,
                message: `已接受神识对决，第 1 回合开始，请在 ${actionTimeoutSec} 秒内选择行动（凝神/固元）`,
                data: {
                    duel_id: duel.id,
                    status: 'active',
                    round_number: 1,
                    challenger_shield: duel.challenger_shield,
                    defender_shield: duel.defender_shield,
                    action_deadline: actionDeadline
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineDuelService] accept 异常:', err);
            throw err;
        }
    }

    /**
     * 执行行动（凝神/固元）
     *
     * 业务流程：
     *   1. 校验对局状态为 active
     *   2. 校验玩家为对局参与方
     *   3. 幂等性校验：本回合是否已提交过行动
     *   4. 记录行动，判断是否双方都已提交
     *   5. 若双方都已提交，触发 _settleRound 结算本回合
     *   6. 若仅一方提交，等待对方（推送等待通知）
     *
     * @param {Object} player - 玩家对象
     * @param {number} duelId - 对局ID
     * @param {string} action - 行动类型：focus/stabilize
     * @returns {Promise<Object>} { success, message, data }
     */
    async action(player, duelId, action) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '神识对决配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        // 行动类型校验
        if (!['focus', 'stabilize'].includes(action)) {
            return { success: false, message: '行动类型无效，仅支持 focus（凝神）/ stabilize（固元）', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const duelIdNum = Number(duelId);
        if (!Number.isFinite(duelIdNum) || duelIdNum <= 0) {
            return { success: false, message: '对局ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁对局记录
            const duel = await PlayerDivineDuel.findByPk(duelIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!duel) {
                await t.rollback();
                return { success: false, message: '对局不存在' };
            }
            if (duel.status !== 'active') {
                await t.rollback();
                return { success: false, message: `对局状态为 ${duel.status}，无法执行行动` };
            }

            // 判断玩家角色
            const playerId = Number(player.id);
            const isChallenger = duel.challenger_id === playerId;
            const isDefender = duel.defender_id === playerId;
            if (!isChallenger && !isDefender) {
                await t.rollback();
                return { success: false, message: '你不是该对局的参与方' };
            }

            // 幂等性校验：本回合是否已提交过行动
            const actionField = isChallenger ? 'challenger_action' : 'defender_action';
            if (duel[actionField]) {
                await t.rollback();
                return { success: false, message: `本回合已提交过行动（${duel[actionField]}），等待对方行动` };
            }

            // 记录行动
            duel[actionField] = action;
            await duel.save({ transaction: t });

            // 判断是否双方都已提交
            const bothSubmitted = duel.challenger_action && duel.defender_action;

            if (!bothSubmitted) {
                // 仅一方提交，等待对方
                await t.commit();
                try {
                    const opponentId = isChallenger ? duel.defender_id : duel.challenger_id;
                    WebSocketNotificationService.notifyPlayerUpdate(opponentId, 'divine_duel_opponent_acted', {
                        duel_id: duel.id,
                        round_number: duel.round_number,
                        message: '对手已提交行动，请尽快选择你的行动'
                    });
                } catch (e) {
                    console.warn('[DivineDuelService] 推送对手行动通知失败:', e.message);
                }

                return {
                    success: true,
                    message: `已提交行动：${action === 'focus' ? '凝神' : '固元'}，等待对方行动`,
                    data: {
                        duel_id: duel.id,
                        round_number: duel.round_number,
                        your_action: action,
                        waiting_opponent: true,
                        action_deadline: duel.action_deadline
                    }
                };
            }

            // 双方都已提交，触发结算
            const settleResult = await this._settleRound(duel, t);
            await t.commit();

            // 大五行幻世轮：神识对决结算后双方自动积累悟印（未装备时静默返回）
            // 仅在对局真正结束时触发（_settleRound 可能只是进入下一回合）
            if (settleResult.roundResult && settleResult.roundResult.duel_finished) {
                await Promise.all([
                    ArtifactDeepLineService.safeAddInsightExp(duel.challenger_id, {
                        battle_type: 'pvp',
                        is_win: duel.winner_id && Number(duel.winner_id) === Number(duel.challenger_id)
                    }),
                    ArtifactDeepLineService.safeAddInsightExp(duel.defender_id, {
                        battle_type: 'pvp',
                        is_win: duel.winner_id && Number(duel.winner_id) === Number(duel.defender_id)
                    })
                ]);
            }

            // 事务提交后推送回合结算结果
            try {
                const roundResult = settleResult.roundResult;
                WebSocketNotificationService.notifyPlayerUpdate(duel.challenger_id, 'divine_duel_round_settled', roundResult);
                WebSocketNotificationService.notifyPlayerUpdate(duel.defender_id, 'divine_duel_round_settled', roundResult);
            } catch (e) {
                console.warn('[DivineDuelService] 推送回合结算通知失败:', e.message);
            }

            return {
                success: true,
                message: settleResult.message,
                data: settleResult.data
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineDuelService] action 异常:', err);
            throw err;
        }
    }

    /**
     * 结算回合（内部方法）
     *
     * 结算矩阵（A=challenger, B=defender）：
     *   凝神 vs 凝神：A -15护盾 + 受20伤害, B -15护盾 + 受20伤害
     *   凝神 vs 固元：A -15护盾 + 受10伤害(减半), B +10护盾 + 受20伤害
     *   固元 vs 凝神：A +10护盾 + 受20伤害, B -15护盾 + 受10伤害(减半)
     *   固元 vs 固元：A +5护盾(减半), B +5护盾(减半)
     *
     * 结算后判断：
     *   - 任一方护盾 <= 0：对局结束（shield_zero）
     *   - 回合数 >= max_rounds：对局结束（rounds_limit）
     *   - 否则进入下一回合，重置行动和截止时间
     *
     * @param {Object} duel - 对局实例（已加锁）
     * @param {Object} transaction - 事务实例
     * @returns {Promise<Object>} { message, data, roundResult }
     */
    async _settleRound(duel, transaction) {
        const config = this.getConfig();
        const focusCost = Number(config.focus_cost) || 15;
        const focusDamage = Number(config.focus_damage) || 20;
        const stabilizeRecover = Number(config.stabilize_recover) || 10;
        const stabilizeReduceFactor = Number(config.stabilize_reduce_factor) || 0.5;
        const bothStabilizeFactor = Number(config.both_stabilize_recover_factor) || 0.5;
        const shieldMax = Number(config.shield_max) || 100;
        const maxRounds = Number(config.max_rounds) || 20;
        const actionTimeoutSec = Number(config.action_timeout_seconds) || 60;

        const aAction = duel.challenger_action;
        const bAction = duel.defender_action;

        // 计算双方护盾变化
        let aShieldChange = 0;
        let bShieldChange = 0;
        let aDamageTaken = 0;
        let bDamageTaken = 0;

        // A 的行动成本/恢复
        if (aAction === 'focus') {
            aShieldChange -= focusCost;  // 凝神消耗自身护盾
        } else if (aAction === 'stabilize') {
            aShieldChange += stabilizeRecover;  // 固元恢复护盾（后续受击减半）
        }

        // B 的行动成本/恢复
        if (bAction === 'focus') {
            bShieldChange -= focusCost;
        } else if (bAction === 'stabilize') {
            bShieldChange += stabilizeRecover;
        }

        // 计算伤害（双方都凝神时，互相伤害）
        if (aAction === 'focus' && bAction === 'focus') {
            // 互相伤害
            aDamageTaken = focusDamage;
            bDamageTaken = focusDamage;
        } else if (aAction === 'focus' && bAction === 'stabilize') {
            // A 凝神攻击 B，B 固元减伤
            bDamageTaken = Math.floor(focusDamage * stabilizeReduceFactor);
        } else if (aAction === 'stabilize' && bAction === 'focus') {
            // B 凝神攻击 A，A 固元减伤
            aDamageTaken = Math.floor(focusDamage * stabilizeReduceFactor);
        } else if (aAction === 'stabilize' && bAction === 'stabilize') {
            // 双方都固元：恢复量减半
            aShieldChange = Math.floor(stabilizeRecover * bothStabilizeFactor);
            bShieldChange = Math.floor(stabilizeRecover * bothStabilizeFactor);
        }

        // 应用护盾变化（不超过上限，不低于 0）
        let newChallengerShield = Math.max(0, Math.min(shieldMax, Number(duel.challenger_shield) + aShieldChange - aDamageTaken));
        let newDefenderShield = Math.max(0, Math.min(shieldMax, Number(duel.defender_shield) + bShieldChange - bDamageTaken));

        duel.challenger_shield = newChallengerShield;
        duel.defender_shield = newDefenderShield;

        // 构建回合结果（用于推送和返回）
        const roundResult = {
            duel_id: duel.id,
            round_number: duel.round_number,
            challenger_action: aAction,
            defender_action: bAction,
            challenger_shield_change: aShieldChange - aDamageTaken,
            defender_shield_change: bShieldChange - bDamageTaken,
            challenger_shield: newChallengerShield,
            defender_shield: newDefenderShield,
            challenger_damage_taken: aDamageTaken,
            defender_damage_taken: bDamageTaken,
            settled: true,
            duel_finished: false,
            winner_id: null,
            settle_reason: null
        };

        // 判断对局是否结束
        let duelFinished = false;
        let settleReason = null;
        let winnerId = null;

        if (newChallengerShield <= 0 || newDefenderShield <= 0) {
            // 护盾归零
            duelFinished = true;
            settleReason = 'shield_zero';
            if (newChallengerShield <= 0 && newDefenderShield <= 0) {
                // 同时归零，平局
                winnerId = null;
            } else if (newChallengerShield <= 0) {
                winnerId = duel.defender_id;
            } else {
                winnerId = duel.challenger_id;
            }
        } else if (duel.round_number >= maxRounds) {
            // 回合上限
            duelFinished = true;
            settleReason = 'rounds_limit';
            if (newChallengerShield > newDefenderShield) {
                winnerId = duel.challenger_id;
            } else if (newDefenderShield > newChallengerShield) {
                winnerId = duel.defender_id;
            } else {
                winnerId = null;  // 平局
            }
        }

        if (duelFinished) {
            // 对局结束，触发对局结算
            duel.status = 'finished';
            duel.winner_id = winnerId;
            duel.settle_reason = settleReason;
            duel.finished_at = new Date();
            duel.challenger_action = null;
            duel.defender_action = null;
            duel.action_deadline = null;
            await duel.save({ transaction });

            // 发放赌注
            const settleResult = await this._settleDuel(duel, transaction);
            roundResult.duel_finished = true;
            roundResult.winner_id = winnerId;
            roundResult.settle_reason = settleReason;
            roundResult.bet_settlement = settleResult.bet_settlement;

            return {
                message: `第 ${duel.round_number} 回合结算完毕，对局结束！${winnerId ? '胜者：' + (winnerId === duel.challenger_id ? '发起方' : '应战方') : '平局'}`,
                data: roundResult,
                roundResult
            };
        }

        // 进入下一回合
        duel.round_number = duel.round_number + 1;
        duel.challenger_action = null;
        duel.defender_action = null;
        duel.action_deadline = new Date(Date.now() + actionTimeoutSec * 1000);
        await duel.save({ transaction });

        roundResult.next_round = duel.round_number;
        roundResult.next_action_deadline = duel.action_deadline;

        return {
            message: `第 ${duel.round_number - 1} 回合结算完毕，进入第 ${duel.round_number} 回合`,
            data: roundResult,
            roundResult
        };
    }

    /**
     * 结算对局（内部方法）
     *
     * 发放赌注规则：
     *   - 有胜者：胜者获得 2 * bet_amount（双方赌注总和，配置 reward_factor_winner=1.0）
     *   - 平局：双方各退还 bet_amount * reward_factor_draw（0.5，即退还一半）
     *
     * @param {Object} duel - 对局实例（已加锁，status=finished）
     * @param {Object} transaction - 事务实例
     * @returns {Promise<Object>} { bet_settlement }
     */
    async _settleDuel(duel, transaction) {
        const config = this.getConfig();
        const winnerFactor = Number(config.reward_factor_winner) || 1.0;
        const drawFactor = Number(config.reward_factor_draw) || 0.5;
        const betType = duel.bet_type;
        const betAmount = Number(duel.bet_amount);

        const betSettlement = {
            bet_type: betType,
            bet_amount: betAmount,
            winner_id: duel.winner_id,
            settle_reason: duel.settle_reason
        };

        if (duel.winner_id) {
            // 有胜者：胜者获得双方赌注总和 * winnerFactor
            const totalReward = Math.floor(betAmount * 2 * winnerFactor);
            const winner = await Player.findByPk(duel.winner_id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (winner) {
                if (betType === 'spirit_stone') {
                    winner.spirit_stones = safeBigInt(winner.spirit_stones) + BigInt(totalReward);
                } else if (betType === 'divine_sense') {
                    winner.divine_sense_balance = Number(winner.divine_sense_balance || 0) + totalReward;
                    await this._syncDivineSenseTable(winner.id, winner.divine_sense_balance, transaction);
                }
                await winner.save({ transaction });
            }
            betSettlement.winner_reward = totalReward;
        } else {
            // 平局：双方各退还 betAmount * drawFactor
            const refund = Math.floor(betAmount * drawFactor);
            const challenger = await Player.findByPk(duel.challenger_id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            const defender = await Player.findByPk(duel.defender_id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            for (const p of [challenger, defender]) {
                if (!p) continue;
                if (betType === 'spirit_stone') {
                    p.spirit_stones = safeBigInt(p.spirit_stones) + BigInt(refund);
                } else if (betType === 'divine_sense') {
                    p.divine_sense_balance = Number(p.divine_sense_balance || 0) + refund;
                    await this._syncDivineSenseTable(p.id, p.divine_sense_balance, transaction);
                }
                await p.save({ transaction });
            }
            betSettlement.draw_refund = refund;
        }

        return { bet_settlement: betSettlement };
    }

    /**
     * 查询玩家当前进行中的对局
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} { success, data }
     */
    async getActiveDuel(player) {
        const duel = await PlayerDivineDuel.findOne({
            where: {
                status: { [Op.in]: ['pending', 'active'] },
                [Op.or]: [
                    { challenger_id: player.id },
                    { defender_id: player.id }
                ]
            },
            order: [['created_at', 'DESC']]
        });

        if (!duel) {
            return {
                success: true,
                data: null
            };
        }

        // 查询双方昵称
        const challenger = await Player.findByPk(duel.challenger_id, { attributes: ['id', 'nickname', 'realm'] });
        const defender = await Player.findByPk(duel.defender_id, { attributes: ['id', 'nickname', 'realm'] });

        return {
            success: true,
            data: {
                duel_id: duel.id,
                status: duel.status,
                bet_type: duel.bet_type,
                bet_amount: duel.bet_amount,
                round_number: duel.round_number,
                challenger: challenger ? { id: challenger.id, nickname: challenger.nickname, realm: challenger.realm } : null,
                defender: defender ? { id: defender.id, nickname: defender.nickname, realm: defender.realm } : null,
                challenger_shield: duel.challenger_shield,
                defender_shield: duel.defender_shield,
                your_action: duel.challenger_id === player.id ? duel.challenger_action : duel.defender_action,
                opponent_action: duel.challenger_id === player.id ? duel.defender_action : duel.challenger_action,
                action_deadline: duel.action_deadline,
                settle_reason: duel.settle_reason,
                created_at: duel.created_at
            }
        };
    }

    /**
     * 查询玩家历史对局
     * @param {Object} player - 玩家对象
     * @param {number} page - 页码（1-based）
     * @param {number} pageSize - 每页条数
     * @returns {Promise<Object>} { success, data }
     */
    async getHistory(player, page, pageSize) {
        const pageNum = Math.max(1, Number(page) || 1);
        const size = Math.min(50, Math.max(1, Number(pageSize) || 10));
        const offset = (pageNum - 1) * size;

        const { rows, count } = await PlayerDivineDuel.findAndCountAll({
            where: {
                [Op.or]: [
                    { challenger_id: player.id },
                    { defender_id: player.id }
                ]
            },
            order: [['created_at', 'DESC']],
            limit: size,
            offset
        });

        // 批量查询相关玩家昵称
        const playerIds = new Set();
        rows.forEach(d => {
            playerIds.add(d.challenger_id);
            playerIds.add(d.defender_id);
        });
        const players = await Player.findAll({
            where: { id: Array.from(playerIds) },
            attributes: ['id', 'nickname']
        });
        const playerMap = new Map(players.map(p => [p.id, p.nickname]));

        return {
            success: true,
            data: {
                total: count,
                page: pageNum,
                page_size: size,
                duels: rows.map(d => ({
                    duel_id: d.id,
                    status: d.status,
                    bet_type: d.bet_type,
                    bet_amount: d.bet_amount,
                    round_number: d.round_number,
                    challenger: { id: d.challenger_id, nickname: playerMap.get(d.challenger_id) || '未知' },
                    defender: { id: d.defender_id, nickname: playerMap.get(d.defender_id) || '未知' },
                    winner_id: d.winner_id,
                    is_winner: d.winner_id === player.id,
                    is_draw: d.status === 'finished' && d.winner_id === null,
                    settle_reason: d.settle_reason,
                    challenger_shield: d.challenger_shield,
                    defender_shield: d.defender_shield,
                    created_at: d.created_at,
                    finished_at: d.finished_at
                }))
            }
        };
    }

    /**
     * 投降
     *
     * 业务流程：
     *   1. 校验对局状态为 active
     *   2. 校验玩家为对局参与方
     *   3. 标记对手为胜者，settle_reason='surrender'
     *   4. 触发 _settleDuel 发放赌注
     *   5. WebSocket 通知双方
     *
     * @param {Object} player - 玩家对象
     * @param {number} duelId - 对局ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async surrender(player, duelId) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '神识对决配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        const duelIdNum = Number(duelId);
        if (!Number.isFinite(duelIdNum) || duelIdNum <= 0) {
            return { success: false, message: '对局ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const duel = await PlayerDivineDuel.findByPk(duelIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!duel) {
                await t.rollback();
                return { success: false, message: '对局不存在' };
            }
            if (duel.status !== 'active') {
                await t.rollback();
                return { success: false, message: `对局状态为 ${duel.status}，无法投降` };
            }

            const playerId = Number(player.id);
            if (duel.challenger_id !== playerId && duel.defender_id !== playerId) {
                await t.rollback();
                return { success: false, message: '你不是该对局的参与方' };
            }

            // 对手胜
            const winnerId = duel.challenger_id === playerId ? duel.defender_id : duel.challenger_id;
            duel.status = 'finished';
            duel.winner_id = winnerId;
            duel.settle_reason = 'surrender';
            duel.finished_at = new Date();
            duel.challenger_action = null;
            duel.defender_action = null;
            duel.action_deadline = null;
            await duel.save({ transaction: t });

            // 发放赌注
            const settleResult = await this._settleDuel(duel, t);
            await t.commit();

            // 大五行幻世轮：神识对决结算后双方自动积累悟印（未装备时静默返回）
            await Promise.all([
                ArtifactDeepLineService.safeAddInsightExp(duel.challenger_id, {
                    battle_type: 'pvp',
                    is_win: duel.winner_id && Number(duel.winner_id) === Number(duel.challenger_id)
                }),
                ArtifactDeepLineService.safeAddInsightExp(duel.defender_id, {
                    battle_type: 'pvp',
                    is_win: duel.winner_id && Number(duel.winner_id) === Number(duel.defender_id)
                })
            ]);

            // 推送通知
            try {
                const notifyData = {
                    duel_id: duel.id,
                    winner_id: winnerId,
                    loser_id: playerId,
                    settle_reason: 'surrender',
                    bet_settlement: settleResult.bet_settlement
                };
                WebSocketNotificationService.notifyPlayerUpdate(duel.challenger_id, 'divine_duel_finished', notifyData);
                WebSocketNotificationService.notifyPlayerUpdate(duel.defender_id, 'divine_duel_finished', notifyData);
            } catch (e) {
                console.warn('[DivineDuelService] 推送投降通知失败:', e.message);
            }

            return {
                success: true,
                message: `已投降，对手获得胜利`,
                data: {
                    duel_id: duel.id,
                    status: 'finished',
                    winner_id: winnerId,
                    settle_reason: 'surrender',
                    bet_settlement: settleResult.bet_settlement
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DivineDuelService] surrender 异常:', err);
            throw err;
        }
    }

    /**
     * 超时检查（可被定时器调用）
     *
     * 检查两类超时：
     *   1. 对局创建超时：pending 状态且 action_deadline 过期，自动取消并退还发起方赌注+入场神识
     *   2. 操作超时：active 状态且 action_deadline 过期，自动为本回合未行动方执行固元
     *
     * 设计要点：
     *   - 每次最多处理 20 条，避免单次执行过长
     *   - 事务包裹，避免并发问题
     *   - 异常捕获，单条失败不影响其他对局
     */
    async checkTimeouts() {
        const config = this.getConfig();
        if (!config) return;

        const now = new Date();
        let processedCount = 0;

        try {
            // 1. 处理 pending 超时（对局创建超时）
            const pendingTimeouts = await PlayerDivineDuel.findAll({
                where: {
                    status: 'pending',
                    action_deadline: { [Op.lt]: now }
                },
                limit: 20
            });

            for (const duel of pendingTimeouts) {
                if (processedCount >= 20) break;
                try {
                    await this._cancelPendingDuel(duel);
                    processedCount++;
                } catch (e) {
                    console.error(`[DivineDuelService] 取消 pending 对局 ${duel.id} 失败:`, e.message);
                }
            }

            // 2. 处理 active 超时（操作超时，自动固元）
            const activeTimeouts = await PlayerDivineDuel.findAll({
                where: {
                    status: 'active',
                    action_deadline: { [Op.lt]: now }
                },
                limit: 20
            });

            for (const duel of activeTimeouts) {
                if (processedCount >= 40) break;
                try {
                    await this._handleActionTimeout(duel);
                    processedCount++;
                } catch (e) {
                    console.error(`[DivineDuelService] 处理 active 对局 ${duel.id} 超时失败:`, e.message);
                }
            }
        } catch (err) {
            console.error('[DivineDuelService] checkTimeouts 异常:', err.message);
        }
    }

    /**
     * 取消 pending 超时的对局（内部方法）
     * 退还发起方赌注和入场神识
     * @param {Object} duel - 对局实例
     */
    async _cancelPendingDuel(duel) {
        const t = await sequelize.transaction();
        try {
            // 重新加锁查询
            const duelLocked = await PlayerDivineDuel.findByPk(duel.id, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!duelLocked || duelLocked.status !== 'pending') {
                await t.rollback();
                return;
            }

            // 退还发起方赌注和入场神识
            const challenger = await Player.findByPk(duelLocked.challenger_id, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (challenger) {
                const betType = duelLocked.bet_type;
                const betAmount = Number(duelLocked.bet_amount);
                const entryCost = Number(this.getConfig().entry_divine_sense_cost) || 50;

                if (betType === 'spirit_stone') {
                    challenger.spirit_stones = safeBigInt(challenger.spirit_stones) + BigInt(betAmount);
                    challenger.divine_sense_balance = Number(challenger.divine_sense_balance || 0) + entryCost;
                    await this._syncDivineSenseTable(challenger.id, challenger.divine_sense_balance, t);
                } else if (betType === 'divine_sense') {
                    // 神识赌注：退还赌注 + 入场消耗
                    challenger.divine_sense_balance = Number(challenger.divine_sense_balance || 0) + betAmount + entryCost;
                    await this._syncDivineSenseTable(challenger.id, challenger.divine_sense_balance, t);
                }
                await challenger.save({ transaction: t });
            }

            duelLocked.status = 'cancelled';
            duelLocked.settle_reason = 'timeout';
            duelLocked.finished_at = new Date();
            duelLocked.action_deadline = null;
            await duelLocked.save({ transaction: t });

            await t.commit();

            // 通知发起方
            try {
                WebSocketNotificationService.notifyPlayerUpdate(duelLocked.challenger_id, 'divine_duel_cancelled', {
                    duel_id: duelLocked.id,
                    reason: 'timeout',
                    message: '对方未在规定时间内接受挑战，对局已取消，赌注与入场神识已退还'
                });
            } catch (e) {
                console.warn('[DivineDuelService] 推送取消通知失败:', e.message);
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 处理操作超时（内部方法）
     * 为未行动方自动执行固元，若双方都未行动则双方都固元
     * @param {Object} duel - 对局实例
     */
    async _handleActionTimeout(duel) {
        const t = await sequelize.transaction();
        try {
            const duelLocked = await PlayerDivineDuel.findByPk(duel.id, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!duelLocked || duelLocked.status !== 'active') {
                await t.rollback();
                return;
            }
            // 再次检查是否真的超时（避免并发误判）
            if (!duelLocked.action_deadline || new Date() <= duelLocked.action_deadline) {
                await t.rollback();
                return;
            }

            // 为未行动方自动固元
            if (!duelLocked.challenger_action) {
                duelLocked.challenger_action = 'stabilize';
            }
            if (!duelLocked.defender_action) {
                duelLocked.defender_action = 'stabilize';
            }
            await duelLocked.save({ transaction: t });

            // 触发结算
            const settleResult = await this._settleRound(duelLocked, t);
            await t.commit();

            // 大五行幻世轮：神识对决结算后双方自动积累悟印（未装备时静默返回）
            // 仅在对局真正结束时触发（_settleRound 可能只是进入下一回合）
            if (settleResult.roundResult && settleResult.roundResult.duel_finished) {
                await Promise.all([
                    ArtifactDeepLineService.safeAddInsightExp(duelLocked.challenger_id, {
                        battle_type: 'pvp',
                        is_win: duelLocked.winner_id && Number(duelLocked.winner_id) === Number(duelLocked.challenger_id)
                    }),
                    ArtifactDeepLineService.safeAddInsightExp(duelLocked.defender_id, {
                        battle_type: 'pvp',
                        is_win: duelLocked.winner_id && Number(duelLocked.winner_id) === Number(duelLocked.defender_id)
                    })
                ]);
            }

            // 推送通知
            try {
                const roundResult = settleResult.roundResult;
                roundResult.timeout_auto_stabilize = true;
                WebSocketNotificationService.notifyPlayerUpdate(duelLocked.challenger_id, 'divine_duel_round_settled', roundResult);
                WebSocketNotificationService.notifyPlayerUpdate(duelLocked.defender_id, 'divine_duel_round_settled', roundResult);
            } catch (e) {
                console.warn('[DivineDuelService] 推送超时结算通知失败:', e.message);
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }
}

// 单例导出：便于调度器调用 checkTimeouts
module.exports = new DivineDuelService();
