/**
 * PVP 斗法服务
 *
 * 提供玩家间斗法的核心业务逻辑：
 * 1. getStatus：获取 PVP 状态快照（段位/次数/冷却/虚弱/进行中战斗）
 * 2. challenge：发起 PVP 挑战（含状态互斥、每日次数、冷却、虚弱、灵石消耗、避世校验）
 * 3. executeAction：执行一回合战斗（攻击/技能/防御）
 * 4. flee：逃跑（判负）
 * 5. _settleBattle：内部结算方法（段位分/荣誉值/灵石/经验/因果值/掉落）
 * 6. cleanExpiredBattles：清理过期 PVP 战斗（供 StateCleanerService 调用）
 * 7. getLeaderboard：获取段位排行榜
 * 8. getBattleHistory：获取战斗历史
 * 9. setPvpMode/getPvpMode：切换/查询避世入世模式（避世时免疫 PVP 挑战）
 * 10. getCombatPower/compareCombatPower：战力查询与对比（基于 pvp_extended.combat_power 权重）
 * 11. sparringWithDummy：切磋木人（零惩罚训练，获得经验奖励，复用战斗逻辑模拟）
 *
 * 设计原则：
 * - 所有可变参数从 game_balance.json pvp / pvp_extended 段读取，禁止硬编码
 * - 多表/多字段变更使用事务 + 行级锁（player + pvp_battle_records + pvp_rankings）
 * - 战斗记录使用 pvp_battle_records 表（status: ongoing/finished/cancelled）
 * - 段位积分冗余存储于 players.pvp_score，便于排行榜查询
 * - 切磋木人为零惩罚训练，不写入 pvp_battle_records，仅记录于 player.stats JSON
 * - WebSocket 推送通过 WebSocketNotificationService.notifyPlayerUpdate
 * - 不直接操作 HTTP 响应，由路由层处理
 */
'use strict';

const Player = require('../../models/player');
const PvpBattleRecord = require('../../models/pvpBattleRecord');
const PvpRanking = require('../../models/pvpRanking');
const Item = require('../../models/item');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const { infrastructure } = require('../../modules');
// 阵法系统服务（懒加载，避免循环依赖）
const FormationService = require('./FormationService');

const configLoader = infrastructure.ConfigLoader;

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

class PvpService {
    /**
     * 读取 PVP 配置
     * @returns {Object} PVP 配置对象
     */
    static getPvpConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.pvp || {};
    }

    /**
     * 获取或创建玩家段位记录（pvp_rankings 表，每玩家一条）
     * 注意：调用方必须已传入事务（若需要在事务内使用）
     * @param {number} playerId - 玩家ID
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} PvpRanking 实例
     */
    static async _getOrCreateRanking(playerId, t) {
        // 行级锁查询，防止并发挑战创建重复记录
        let ranking = await PvpRanking.findOne({
            where: { player_id: playerId },
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!ranking) {
            // 新玩家初始化段位记录：score=0，rank_tier=散修
            ranking = await PvpRanking.create({
                player_id: playerId,
                score: 0,
                rank_tier: '散修',
                season_wins: 0,
                season_losses: 0,
                season_draws: 0,
                win_streak: 0,
                max_win_streak: 0,
                daily_challenge_count: 0,
                daily_defend_count: 0,
                last_challenge_date: null,
                last_battle_time: null,
                total_battles: 0
            }, { transaction: t });
        }
        return ranking;
    }

    /**
     * 跨日重置每日次数（基于 last_challenge_date）
     * 注意：DATEONLY 字段，比较 YYYY-MM-DD 字符串
     * @param {Object} ranking - PvpRanking 实例
     */
    static _resetDailyCountersIfNewDay(ranking) {
        const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
        const lastDate = ranking.last_challenge_date
            ? new Date(ranking.last_challenge_date).toISOString().slice(0, 10)
            : null;
        if (lastDate !== today) {
            ranking.daily_challenge_count = 0;
            ranking.daily_defend_count = 0;
            ranking.last_challenge_date = today;
        }
    }

    /**
     * 计算玩家战力
     * 战力公式：atk * 2 + def * 1.5 + speed * 1.2 + hp_max * 0.1 + realm_rank * 100
     * 权重说明：攻击双倍权重（输出为斗法主导），防御 1.5 倍（决定生存），
     *           速度 1.2 倍（影响先手），气血最大值 0.1 倍（防爆发秒杀），
     *           境界排名 * 100（境界差距应显著影响战力，避免低境界乱虐高境界）
     * @param {Object} player - 玩家实例
     * @returns {number} 战力值
     */
    static _calculatePower(player) {
        const attrs = player.attributes || {};
        // 统一 Number 转换，防御 JSON 中可能为字符串的情况
        const atk = Number(attrs.atk) || 0;
        const def = Number(attrs.def) || 0;
        const speed = Number(attrs.speed) || 0;
        const hpMax = Number(attrs.hp_max) || 0;
        const realmRank = Number(player.realm_rank) || 0;
        return Math.floor(atk * 2 + def * 1.5 + speed * 1.2 + hpMax * 0.1 + realmRank * 100);
    }

    /**
     * 根据积分返回段位名称
     * 从配置 pvp.ranks 数组查找（min_score <= score <= max_score）
     * @param {number} score - PVP 段位积分
     * @returns {string} 段位名称（如 散修/道子/真传/长老/宗主/大能）
     */
    static _getRankName(score) {
        const cfg = this.getPvpConfig();
        const ranks = cfg.ranks || [];
        for (const r of ranks) {
            if (score >= r.min_score && score <= r.max_score) {
                return r.name;
            }
        }
        // 兜底：未匹配到配置，返回最低段位
        return ranks[0]?.name || '散修';
    }

    /**
     * 获取 PVP 状态快照（前端展示用）
     * 返回：当前是否在 PVP 战斗、段位/次数/冷却/虚弱等
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 状态快照
     */
    static async getStatus(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getPvpConfig();
        const now = Date.now();

        // 查询进行中的 PVP 战斗（玩家作为攻击方或防守方）
        const ongoingBattle = await PvpBattleRecord.findOne({
            where: {
                [Op.and]: [
                    { status: 'ongoing' },
                    {
                        [Op.or]: [
                            { attacker_id: playerId },
                            { defender_id: playerId }
                        ]
                    }
                ]
            },
            order: [['started_at', 'DESC']]
        });

        // 查询段位记录（只读，无需事务）
        let ranking = await PvpRanking.findOne({
            where: { player_id: playerId }
        });
        if (!ranking) {
            // 内存中初始化一份默认值，避免空指针
            ranking = {
                score: 0,
                rank_tier: '散修',
                season_wins: 0,
                season_losses: 0,
                season_draws: 0,
                win_streak: 0,
                max_win_streak: 0,
                daily_challenge_count: 0,
                daily_defend_count: 0,
                last_challenge_date: null,
                last_battle_time: null,
                total_battles: 0
            };
        } else {
            // 跨日重置展示（仅内存层面，不持久化；持久化由下次 challenge 触发）
            const today = new Date().toISOString().slice(0, 10);
            const lastDate = ranking.last_challenge_date
                ? new Date(ranking.last_challenge_date).toISOString().slice(0, 10)
                : null;
            if (lastDate !== today) {
                ranking = {
                    ...ranking.toJSON(),
                    daily_challenge_count: 0,
                    daily_defend_count: 0
                };
            }
        }

        // 计算冷却剩余秒数：基于 last_battle_time + cooldown_seconds
        let cooldownRemaining = 0;
        if (ranking.last_battle_time) {
            const lastMs = new Date(ranking.last_battle_time).getTime();
            const cooldownMs = (cfg.cooldown_seconds || 300) * 1000;
            const elapsedMs = now - lastMs;
            if (elapsedMs < cooldownMs) {
                cooldownRemaining = Math.ceil((cooldownMs - elapsedMs) / 1000);
            }
        }

        // 计算虚弱剩余秒数：基于 weakness_end_time
        let weaknessRemaining = 0;
        if (player.weakness_end_time) {
            const endMs = new Date(player.weakness_end_time).getTime();
            if (endMs > now) {
                weaknessRemaining = Math.ceil((endMs - now) / 1000);
            }
        }

        // 拼装战斗信息（含双方基础信息，供前端展示对手资料）
        let battleInfo = null;
        if (ongoingBattle) {
            const isAttacker = ongoingBattle.attacker_id === playerId;
            const opponentId = isAttacker ? ongoingBattle.defender_id : ongoingBattle.attacker_id;
            const opponent = await Player.findByPk(opponentId, {
                attributes: ['id', 'nickname', 'realm', 'realm_rank', 'pvp_score', 'pvp_rank']
            });
            battleInfo = {
                battle_id: ongoingBattle.id,
                is_attacker: isAttacker,
                opponent: opponent ? {
                    id: opponent.id,
                    nickname: opponent.nickname,
                    realm: opponent.realm,
                    realm_rank: opponent.realm_rank,
                    pvp_score: opponent.pvp_score,
                    pvp_rank: opponent.pvp_rank
                } : null,
                battle_type: ongoingBattle.battle_type,
                total_rounds: ongoingBattle.total_rounds,
                started_at: ongoingBattle.started_at,
                // 解析战斗日志，供前端回合展示
                battle_log: ongoingBattle.battle_log ? JSON.parse(ongoingBattle.battle_log) : []
            };
        }

        return {
            is_in_pvp_battle: !!ongoingBattle,
            battle_info: battleInfo,
            ranking: {
                score: ranking.score,
                rank_tier: ranking.rank_tier,
                season_wins: ranking.season_wins,
                season_losses: ranking.season_losses,
                season_draws: ranking.season_draws,
                win_streak: ranking.win_streak,
                max_win_streak: ranking.max_win_streak,
                daily_challenge_count: ranking.daily_challenge_count,
                daily_defend_count: ranking.daily_defend_count,
                total_battles: ranking.total_battles
            },
            // 每日剩余挑战次数（后端权威计算）
            daily_remaining: Math.max(0, (cfg.daily_challenge_limit || 10) - ranking.daily_challenge_count),
            daily_limit: cfg.daily_challenge_limit || 10,
            cooldown_remaining: cooldownRemaining,
            cooldown_seconds: cfg.cooldown_seconds || 300,
            weakness_remaining: weaknessRemaining,
            weakness_end_time: player.weakness_end_time,
            honor: safeBigInt(player.honor).toString(),
            karma: player.karma || 0,
            pvp_score: player.pvp_score || 0,
            pvp_rank: player.pvp_rank || '散修',
            server_time: now
        };
    }

    /**
     * 发起 PVP 挑战
     * 校验：
     * - 状态互斥（IN_PVP_BATTLE 与其他 exclusive 状态互斥）
     * - 每日次数上限
     * - 冷却时间
     * - 虚弱状态限制
     * - 灵石消耗
     * - 不可挑战自己
     * - 目标玩家存在
     * 创建 pvp_battle_records 记录 status='ongoing'
     * 扣减发起方灵石、累加每日次数、更新 last_battle_time
     * @param {number} playerId - 发起挑战玩家ID
     * @param {number} targetPlayerId - 目标玩家ID
     * @param {string} battleType - 战斗类型：normal/match/bounty
     * @returns {Promise<Object>} 挑战结果
     */
    static async challenge(playerId, targetPlayerId, battleType = 'normal') {
        const cfg = this.getPvpConfig();

        // 全局开关
        if (cfg.enabled === false) {
            throw new AppError('PVP 斗法系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验
        if (!targetPlayerId) {
            throw new AppError('目标玩家ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const allowedTypes = ['normal', 'match', 'bounty'];
        if (!allowedTypes.includes(battleType)) {
            throw new AppError(`无效的战斗类型：${battleType}，可选值：${allowedTypes.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 不可挑战自己
        if (Number(playerId) === Number(targetPlayerId)) {
            throw new AppError('不可挑战自己', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 状态机互斥校验：PVP 战斗与其他 exclusive 状态互斥（闭关/移动/战斗/悟道等）
        const stateCheck = await PlayerStateMachine.canStart(
            playerId,
            PlayerStateMachine.PlayerState.IN_PVP_BATTLE,
            { source: 'route', stateType: 'pvp' }
        );
        if (!stateCheck.allowed) {
            throw new AppError(stateCheck.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 事务包裹：玩家行 + 段位记录 + 战斗记录 原子性
        const t = await sequelize.transaction();
        try {
            // 行级锁发起方玩家
            const attacker = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!attacker) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 死亡玩家不可挑战
            if (attacker.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 被封禁玩家不可挑战
            if (attacker.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁，无法挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 避世状态校验：避世清修中不可发起挑战，需先入世方可斗法
            if (attacker.pvp_mode === 'recluse') {
                await t.commit();
                throw new AppError('避世清修中，无法发起挑战，请先入世', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 虚弱状态校验：虚弱期不可发起挑战（防止虚弱期间滥用 PVP 获取荣誉）
            const now = new Date();
            if (attacker.weakness_end_time && new Date(attacker.weakness_end_time) > now) {
                await t.commit();
                throw new AppError('虚弱状态中，无法发起挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁目标玩家
            const defender = await Player.findByPk(targetPlayerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!defender) {
                await t.commit();
                throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (defender.is_dead) {
                await t.commit();
                throw new AppError('目标已身死道消，不可挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (defender.is_banned) {
                await t.commit();
                throw new AppError('目标已封禁，不可挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 避世状态校验：避世清修中的玩家免疫 PVP 挑战
            if (defender.pvp_mode === 'recluse') {
                await t.commit();
                throw new AppError('目标已避世清修，不可挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 二次校验：防止发起方进行中的 PVP 战斗（并发场景）
            const attackerOngoing = await PvpBattleRecord.findOne({
                where: {
                    [Op.and]: [
                        { status: 'ongoing' },
                        {
                            [Op.or]: [
                                { attacker_id: playerId },
                                { defender_id: playerId }
                            ]
                        }
                    ]
                },
                transaction: t
            });
            if (attackerOngoing) {
                await t.commit();
                throw new AppError('已有进行中的斗法，无法重复挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 目标进行中战斗校验
            const defenderOngoing = await PvpBattleRecord.findOne({
                where: {
                    [Op.and]: [
                        { status: 'ongoing' },
                        {
                            [Op.or]: [
                                { attacker_id: targetPlayerId },
                                { defender_id: targetPlayerId }
                            ]
                        }
                    ]
                },
                transaction: t
            });
            if (defenderOngoing) {
                await t.commit();
                throw new AppError('目标玩家正在进行斗法，请稍后再试', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 获取或创建发起方段位记录
            const attackerRanking = await this._getOrCreateRanking(playerId, t);
            this._resetDailyCountersIfNewDay(attackerRanking);

            // 每日挑战次数校验
            const dailyLimit = cfg.daily_challenge_limit || 10;
            if (attackerRanking.daily_challenge_count >= dailyLimit) {
                await t.commit();
                throw new AppError(`今日挑战次数已达上限（${dailyLimit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 冷却校验：基于 last_battle_time
            const cooldown = cfg.cooldown_seconds || 300;
            if (attackerRanking.last_battle_time) {
                const elapsed = (Date.now() - new Date(attackerRanking.last_battle_time).getTime()) / 1000;
                if (elapsed < cooldown) {
                    await t.commit();
                    const remain = Math.ceil(cooldown - elapsed);
                    throw new AppError(`斗法冷却中，请 ${remain} 秒后再试`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // 灵石消耗：cost_per_battle_base + cost_multiplier_per_realm * realm_rank
            const costBase = cfg.cost_per_battle_base || 100;
            const costMul = cfg.cost_multiplier_per_realm || 100;
            const realmRank = Number(attacker.realm_rank) || 0;
            const totalCost = costBase + costMul * realmRank;
            const attackerStones = safeBigInt(attacker.spirit_stones);
            if (attackerStones < BigInt(totalCost)) {
                await t.commit();
                throw new AppError(`灵石不足，本次挑战需消耗 ${totalCost} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 获取或创建防守方段位记录（用于累加每日被挑战次数）
            const defenderRanking = await this._getOrCreateRanking(targetPlayerId, t);
            this._resetDailyCountersIfNewDay(defenderRanking);

            // 每日被挑战次数校验
            const dailyDefendLimit = cfg.daily_defend_limit || 5;
            if (defenderRanking.daily_defend_count >= dailyDefendLimit) {
                await t.commit();
                throw new AppError(`目标今日已被挑战 ${dailyDefendLimit} 次，请明日再战`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 扣减发起方灵石
            attacker.spirit_stones = attackerStones - BigInt(totalCost);

            // 累加发起方每日挑战次数、防守方每日被挑战次数
            attackerRanking.daily_challenge_count += 1;
            attackerRanking.last_battle_time = now;
            defenderRanking.daily_defend_count += 1;

            // 计算双方战力（用于结算奖励）
            const attackerPower = this._calculatePower(attacker);
            const defenderPower = this._calculatePower(defender);

            // 战力差距欺凌校验：若差距超过 power_gap_bullying_threshold，提示但允许
            // 此处不阻断，仅用于 karma 累加判断（在 _settleBattle 中处理）

            // 先手判定：基于速度，速度快者先攻；速度相同则随机
            const attackerSpeed = Number(attacker.attributes?.speed) || 0;
            const defenderSpeed = Number(defender.attributes?.speed) || 0;
            let firstAttacker;  // 'attacker' | 'defender'
            if (attackerSpeed > defenderSpeed) {
                firstAttacker = 'attacker';
            } else if (defenderSpeed > attackerSpeed) {
                firstAttacker = 'defender';
            } else {
                firstAttacker = Math.random() < 0.5 ? 'attacker' : 'defender';
            }

            // 创建 PVP 战斗记录
            // 初始 battle_log 包含基本信息（含 first_attacker），后续回合追加
            const initLog = [{
                round: 0,
                event: 'battle_start',
                attacker_id: playerId,
                defender_id: targetPlayerId,
                attacker_power: attackerPower,
                defender_power: defenderPower,
                first_attacker: firstAttacker,  // 记录先手，供 executeAction 推导当前回合的 actor
                timestamp: now.toISOString()
            }];

            const battleRecord = await PvpBattleRecord.create({
                attacker_id: playerId,
                defender_id: targetPlayerId,
                battle_type: battleType,
                winner_id: null,
                total_rounds: 0,
                attacker_score_change: 0,
                defender_score_change: 0,
                attacker_honor_gain: 0,
                defender_honor_gain: 0,
                spirit_stone_reward: 0,
                drop_item_key: null,
                drop_item_quantity: 0,
                karma_change: 0,
                battle_log: JSON.stringify(initLog),
                status: 'ongoing',
                started_at: now,
                finished_at: null
            }, { transaction: t });

            // 更新玩家与段位表
            await attacker.save({ transaction: t });
            await attackerRanking.save({ transaction: t });
            await defenderRanking.save({ transaction: t });

            await t.commit();

            // 异步推送：通知防守方被挑战
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, 'pvp_challenged', {
                    battle_id: battleRecord.id,
                    attacker_id: playerId,
                    attacker_nickname: attacker.nickname,
                    first_attacker: firstAttacker
                });
            } catch (e) { /* 推送失败不阻塞 */ }

            return {
                battle_id: battleRecord.id,
                battle_type: battleType,
                opponent_info: {
                    id: defender.id,
                    nickname: defender.nickname,
                    realm: defender.realm,
                    realm_rank: defender.realm_rank,
                    pvp_score: defender.pvp_score,
                    pvp_rank: defender.pvp_rank
                },
                attacker_power: attackerPower,
                defender_power: defenderPower,
                first_attacker: firstAttacker,
                spirit_stone_cost: totalCost,
                started_at: now.toISOString()
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 执行一回合战斗（攻击方调用）
     * 行动类型：
     * - attack：基础攻击，伤害 = max(1, attacker_atk - defender_def + random_range)
     * - skill：技能攻击，伤害 × skill_damage_multiplier (1.5)，扣 MP 20
     * - defend：本回合受到伤害减半，MP +10
     *
     * 回合机制：双方交替行动，攻击方为当前回合的 actor
     * 累加 total_rounds，写入 battle_log
     * 判断胜负：HP <= 0 或 total_rounds >= max_rounds
     * 胜利时调用 _settleBattle 结算
     *
     * @param {number} playerId - 执行行动的玩家ID
     * @param {string} action - 行动类型：attack/skill/defend
     * @param {number} skillIndex - 技能索引（保留扩展，暂未使用）
     * @returns {Promise<Object>} 回合结果
     */
    static async executeAction(playerId, action, skillIndex) {
        const cfg = this.getPvpConfig();

        // 参数校验
        const allowedActions = ['attack', 'skill', 'defend'];
        if (!allowedActions.includes(action)) {
            throw new AppError(`无效的行动类型：${action}，可选值：${allowedActions.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家进行中的战斗
            const battle = await PvpBattleRecord.findOne({
                where: {
                    [Op.and]: [
                        { status: 'ongoing' },
                        {
                            [Op.or]: [
                                { attacker_id: playerId },
                                { defender_id: playerId }
                            ]
                        }
                    ]
                },
                lock: t.LOCK.UPDATE,
                transaction: t,
                order: [['started_at', 'DESC']]
            });
            if (!battle) {
                await t.commit();
                throw new AppError('没有正在进行的斗法', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
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

            // 当前回合的 actor：双方交替行动
            // 偶数回合由 first_attacker 行动，奇数回合由另一方行动
            // 此处简化为：当前 actor 由 total_rounds 推导
            // total_rounds 0 -> first_attacker, 1 -> 另一方, 2 -> first_attacker, ...
            const battleLog = battle.battle_log ? JSON.parse(battle.battle_log) : [];
            const startEntry = battleLog.find(e => e.event === 'battle_start');
            const firstAttacker = startEntry?.first_attacker || 'attacker';
            // 当前回合的 actor 角色（'attacker' 或 'defender'）
            const currentRound = battle.total_rounds || 0;
            const isAttackerTurn = (firstAttacker === 'attacker')
                ? (currentRound % 2 === 0)
                : (currentRound % 2 === 1);
            const actorRole = isAttackerTurn ? 'attacker' : 'defender';
            const actor = isAttackerTurn ? attacker : defender;
            const target = isAttackerTurn ? defender : attacker;

            // 校验调用方是否为当前 actor
            if (Number(actor.id) !== Number(playerId)) {
                await t.commit();
                throw new AppError('未轮到你的回合', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 读取双方战斗属性（attributes 中存储的当前 HP/MP/ATK/DEF/SPEED）
            const actorAttrs = { ...(actor.attributes || {}) };
            const targetAttrs = { ...(target.attributes || {}) };

            const actorAtk = Number(actorAttrs.atk) || 10;
            const targetDef = Number(targetAttrs.def) || 5;
            const actorHpMax = Number(actorAttrs.hp_max) || 100;
            const targetHpMax = Number(targetAttrs.hp_max) || 100;

            // 初始化双方当前 HP/MP（取 attributes 中的 hp_current/mp_current）
            // 注意：PVP 战斗中 HP 变化保存在 attributes 中，避免污染 players.hp_current（怪物战斗字段）
            let actorHp = Number(actorAttrs.hp_current);
            if (!Number.isFinite(actorHp) || actorHp <= 0) actorHp = actorHpMax;
            let actorMp = Number(actorAttrs.mp_current) || 0;
            let targetHp = Number(targetAttrs.hp_current);
            if (!Number.isFinite(targetHp) || targetHp <= 0) targetHp = targetHpMax;
            let targetMp = Number(targetAttrs.mp_current) || 0;

            // 读取伤害相关配置
            const combatConfig = configLoader.getConfig('game_balance')?.combat || {};
            const dmgRange = combatConfig.damage_random_range ?? 15;
            const dmgOffset = combatConfig.damage_random_offset ?? 7;
            const skillDamageMul = combatConfig.skill_damage_multiplier ?? 1.5;
            const skillMpCost = combatConfig.skill_mp_cost ?? 20;

            // 计算伤害
            let damage = 0;
            let actualAction = action;
            if (action === 'attack') {
                // 基础攻击：max(1, atk - def + random_range)
                damage = Math.max(1, actorAtk - targetDef + Math.floor(Math.random() * dmgRange) - dmgOffset);
            } else if (action === 'skill') {
                // 技能攻击：需消耗 MP，否则降级为普通攻击
                if (actorMp >= skillMpCost) {
                    actorMp -= skillMpCost;
                    damage = Math.max(1, Math.floor((actorAtk - targetDef + Math.floor(Math.random() * dmgRange) - dmgOffset) * skillDamageMul));
                } else {
                    // MP 不足，降级为普通攻击
                    actualAction = 'attack';
                    damage = Math.max(1, actorAtk - targetDef + Math.floor(Math.random() * dmgRange) - dmgOffset);
                }
            } else if (action === 'defend') {
                // 防御：本回合不造成伤害，但受到伤害减半，恢复少量 MP
                actorMp = Math.min(actorMp + 10, Number(actorAttrs.mp_max) || 0);
                damage = 0;
            }

            // 应用伤害到目标（注意：若目标上一回合选择 defend，则伤害减半）
            // 检查上一回合 target 是否 defend
            const lastEntry = battleLog[battleLog.length - 1];
            const targetDefendedLast = lastEntry && lastEntry.actor_role !== actorRole && lastEntry.action === 'defend';
            let actualDamage = damage;
            if (targetDefendedLast && action !== 'defend') {
                actualDamage = Math.floor(damage / 2);
            }

            // 应用伤害
            targetHp = Math.max(0, targetHp - actualDamage);
            // 同步回写到目标 attributes（注意：attributes 是 getter/setter，必须重新 set 整个对象）
            targetAttrs.hp_current = targetHp;
            targetAttrs.mp_current = targetMp;
            target.attributes = targetAttrs;

            // 同步回写 actor 的 MP 与 HP
            actorAttrs.hp_current = actorHp;
            actorAttrs.mp_current = actorMp;
            actor.attributes = actorAttrs;

            // 累加回合数
            battle.total_rounds = currentRound + 1;

            // 写入战斗日志
            battleLog.push({
                round: battle.total_rounds,
                actor: actorRole,
                actor_id: actor.id,
                actor_nickname: actor.nickname,
                action: actualAction,
                damage: actualDamage,
                actor_hp: actorHp,
                defender_hp: targetHp,
                timestamp: new Date().toISOString()
            });
            battle.battle_log = JSON.stringify(battleLog);  // 重新 set 整个字符串触发更新

            // 判断胜负
            // HP <= 0：目标死亡，actor 胜
            // total_rounds >= max_rounds：进入结算，HP 高者胜，相等则平局
            const maxRounds = cfg.max_rounds || 30;
            let battleEnded = false;
            let winnerId = null;
            let isDraw = false;
            if (targetHp <= 0) {
                battleEnded = true;
                winnerId = actor.id;
            } else if (battle.total_rounds >= maxRounds) {
                battleEnded = true;
                // HP 高者胜，相等则平局
                if (actorHp > targetHp) {
                    winnerId = actor.id;
                } else if (targetHp > actorHp) {
                    winnerId = target.id;
                } else {
                    isDraw = true;
                }
            }

            // 持久化双方玩家与战斗记录
            await actor.save({ transaction: t });
            await target.save({ transaction: t });

            if (battleEnded) {
                // 调用内部结算
                const settleResult = await this._settleBattle(battle, winnerId, t, { is_draw: isDraw });
                await t.commit();
                return {
                    battle_id: battle.id,
                    round: battle.total_rounds,
                    actor: actorRole,
                    action: actualAction,
                    damage: actualDamage,
                    actor_hp: actorHp,
                    defender_hp: targetHp,
                    battle_ended: true,
                    winner_id: winnerId,
                    is_draw: isDraw,
                    settle: settleResult
                };
            }

            await battle.save({ transaction: t });
            await t.commit();

            return {
                battle_id: battle.id,
                round: battle.total_rounds,
                actor: actorRole,
                action: actualAction,
                damage: actualDamage,
                actor_hp: actorHp,
                defender_hp: targetHp,
                battle_ended: false,
                next_actor: actorRole === 'attacker' ? 'defender' : 'attacker'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 逃跑（攻击方主动放弃，判负）
     * 逃跑方判负，扣段位分（rank_score_lose_same），不获得荣誉值
     * @param {number} playerId - 逃跑玩家ID
     * @returns {Promise<Object>} 逃跑结果
     */
    static async flee(playerId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁查询进行中的战斗
            const battle = await PvpBattleRecord.findOne({
                where: {
                    [Op.and]: [
                        { status: 'ongoing' },
                        {
                            [Op.or]: [
                                { attacker_id: playerId },
                                { defender_id: playerId }
                            ]
                        }
                    ]
                },
                lock: t.LOCK.UPDATE,
                transaction: t,
                order: [['started_at', 'DESC']]
            });
            if (!battle) {
                await t.commit();
                throw new AppError('没有正在进行的斗法', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 逃跑方判负：胜者为对方
            const winnerId = Number(battle.attacker_id) === Number(playerId)
                ? battle.defender_id
                : battle.attacker_id;

            // 调用结算（标记为 flee，逃跑方不获得荣誉值，胜方仍按 rank_score_win_same 得分）
            const settleResult = await this._settleBattle(battle, winnerId, t, { is_flee: true, fleer_id: playerId });

            await t.commit();

            return {
                battle_id: battle.id,
                fled: true,
                winner_id: winnerId,
                settle: settleResult
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 内部方法：结算战斗
     * - 计算段位分变化（基于双方段位差距，参考 pvp.rank_score_win_same 等）
     * - 计算荣誉值奖励（pvp.honor_reward_win/lose）
     * - 计算灵石奖励（pvp.win_stone_ratio × loser_power）
     * - 计算经验奖励（pvp.win_exp_reward_ratio × avg_power × loser_exp）
     * - 判断是否跨境界欺凌（attacker_realm_rank > defender_realm_rank + 2，累加 karma）
     * - 失败方设置 weakness_end_time（now + weakness_duration_minutes）
     * - 掉落物品判断（pvp.drop_rate_normal_item，从败方背包随机非绑定普通材料）
     * - 更新 pvp_battle_records.status='finished'、winner_id、各字段
     * - 更新双方 pvp_rankings（score/wins/losses/win_streak）
     * - 更新双方 players 表（pvp_score/pvp_rank/honor/karma/weakness_end_time/exp/spirit_stones）
     * - 通过 WebSocket 推送 pvp:result 事件给双方
     * - 记录 admin_logs（GM 审计）
     *
     * 注意：调用方必须已对 battle、双方玩家加行级锁，并传入事务
     * @param {Object} battle - PvpBattleRecord 实例（已加锁）
     * @param {number|null} winnerId - 胜者ID（null 表示平局）
     * @param {Object} t - 事务实例
     * @param {Object} options - 选项 { is_draw, is_flee, fleer_id }
     * @returns {Promise<Object>} 结算结果
     */
    static async _settleBattle(battle, winnerId, t, options = {}) {
        const cfg = this.getPvpConfig();
        const now = new Date();

        // 获取双方玩家（事务内行级锁）
        const attacker = await Player.findByPk(battle.attacker_id, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        const defender = await Player.findByPk(battle.defender_id, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!attacker || !defender) {
            throw new AppError('玩家数据异常', 404, ErrorCodes.NOT_FOUND);
        }

        // 获取或创建双方段位记录
        const attackerRanking = await this._getOrCreateRanking(attacker.id, t);
        const defenderRanking = await this._getOrCreateRanking(defender.id, t);

        // 战力计算（基于属性）
        const attackerPower = this._calculatePower(attacker);
        const defenderPower = this._calculatePower(defender);

        // 判断境界差距：attacker_realm_rank - defender_realm_rank
        const attackerRealmRank = Number(attacker.realm_rank) || 0;
        const defenderRealmRank = Number(defender.realm_rank) || 0;
        const realmDiff = attackerRealmRank - defenderRealmRank;
        const isBullying = realmDiff > 2;  // 跨境界欺凌：攻击方境界比防守方高 2 阶以上

        // 段位分变化计算
        // 同境界差距：rank_score_win_same / rank_score_lose_same
        // 跨境界差距：rank_score_win_cross / rank_score_lose_cross
        // 防守方胜利：rank_score_win_defender
        // 平局：rank_score_draw
        const isCrossRealm = Math.abs(realmDiff) > 2;
        let attackerScoreChange = 0;
        let defenderScoreChange = 0;
        let attackerHonorGain = 0;
        let defenderHonorGain = 0;

        const isDraw = options.is_draw === true || winnerId === null;
        const isAttackerWin = Number(winnerId) === Number(attacker.id);
        const isDefenderWin = Number(winnerId) === Number(defender.id);

        if (isDraw) {
            attackerScoreChange = cfg.rank_score_draw || 0;
            defenderScoreChange = cfg.rank_score_draw || 0;
            // 平局荣誉值：取 lose 的较小值
            attackerHonorGain = Math.floor((cfg.honor_reward_lose || 10) / 2);
            defenderHonorGain = Math.floor((cfg.honor_reward_lose || 10) / 2);
        } else if (isAttackerWin) {
            // 攻击方胜（含防守方逃跑判负的场景）
            attackerScoreChange = isCrossRealm
                ? (cfg.rank_score_win_cross || 25)
                : (cfg.rank_score_win_same || 15);
            // 攻击方欺凌：胜方得分减半（防止刷分），并累加 karma
            if (isBullying) {
                attackerScoreChange = Math.floor(attackerScoreChange / 2);
            }
            defenderScoreChange = isCrossRealm
                ? -(cfg.rank_score_lose_cross || 15)
                : -(cfg.rank_score_lose_same || 10);
            attackerHonorGain = cfg.honor_reward_win || 50;
            // 逃跑场景：防守方逃跑判负时，逃跑方（防守方）不获得荣誉值
            if (options.is_flee && Number(options.fleer_id) === Number(defender.id)) {
                defenderHonorGain = 0;
            } else {
                // 被欺凌的防守方仍获得荣誉值（失败补偿）
                defenderHonorGain = cfg.honor_reward_lose || 10;
            }
        } else if (isDefenderWin) {
            // 防守方胜（含攻击方逃跑判负的场景）
            defenderScoreChange = cfg.rank_score_win_defender || (cfg.rank_score_win_same || 15);
            attackerScoreChange = -(cfg.rank_score_lose_defender || (cfg.rank_score_lose_same || 10));
            defenderHonorGain = cfg.honor_reward_win || 50;
            // 逃跑场景：攻击方逃跑判负时，逃跑方（攻击方）不获得荣誉值
            if (options.is_flee && Number(options.fleer_id) === Number(attacker.id)) {
                attackerHonorGain = 0;
            } else {
                attackerHonorGain = cfg.honor_reward_lose || 10;
            }
        }

        // 因果值（karma）变化：跨境界欺凌累加 karma
        let karmaChange = 0;
        if (isBullying && isAttackerWin && !isDraw) {
            karmaChange = cfg.karma_penalty_per_bullying || 20;
        }

        // 灵石奖励：胜方获得 win_stone_ratio × loser_power
        let spiritStoneReward = 0;
        if (!isDraw) {
            const winnerPower = isAttackerWin ? attackerPower : defenderPower;
            const loserPower = isAttackerWin ? defenderPower : attackerPower;
            spiritStoneReward = Math.floor((cfg.win_stone_ratio || 10) * loserPower);
        }

        // 经验奖励：胜方获得 win_exp_reward_ratio × avg_power × loser_exp
        let attackerExpGain = 0;
        let defenderExpGain = 0;
        if (!isDraw) {
            const avgPower = Math.floor((attackerPower + defenderPower) / 2);
            const ratio = cfg.win_exp_reward_ratio || 0.05;
            if (isAttackerWin) {
                // 攻击方胜，按防守方修为计算
                const loserExp = Number(defender.exp) || 0;
                attackerExpGain = Math.floor(avgPower * ratio * Math.max(1, Math.log10(loserExp + 10)));
            } else {
                const loserExp = Number(attacker.exp) || 0;
                defenderExpGain = Math.floor(avgPower * ratio * Math.max(1, Math.log10(loserExp + 10)));
            }
        }

        // 败方保底奖励（b2-6 新增）：避免玩家因失败而退出 PVP，提供少量灵石和经验作为参与奖
        // 逃跑判负的败方不享受保底（逃跑是主动放弃，不应奖励）
        // 平局双方都不算败方，不享受保底
        let loserConsolationStone = 0;
        let loserConsolationExp = 0;
        if (!isDraw && !options.is_flee) {
            const consolationStoneRatio = cfg.lose_consolation_stone_ratio || 0;
            const consolationExpRatio = cfg.lose_consolation_exp_ratio || 0;
            if (consolationStoneRatio > 0 || consolationExpRatio > 0) {
                // 败方战力作为保底基数（败方越强，保底越多，鼓励挑战强者）
                const loserPower = isAttackerWin ? defenderPower : attackerPower;
                // 胜方修为作为经验基数（胜方越强，败方学到的越多）
                const winnerExp = isAttackerWin ? Number(attacker.exp) : Number(defender.exp);
                const avgPower = Math.floor((attackerPower + defenderPower) / 2);
                loserConsolationStone = Math.floor(consolationStoneRatio * loserPower);
                loserConsolationExp = Math.floor(avgPower * consolationExpRatio * Math.max(1, Math.log10(winnerExp + 10)));
            }
        }

        // 虚弱状态：失败方设置 weakness_end_time（now + weakness_duration_minutes）
        const weaknessMinutes = cfg.weakness_duration_minutes || 30;
        const weaknessEnd = new Date(now.getTime() + weaknessMinutes * 60 * 1000);
        if (!isDraw) {
            if (isAttackerWin) {
                defender.weakness_end_time = weaknessEnd;
            } else {
                attacker.weakness_end_time = weaknessEnd;
            }
        }

        // 掉落物品判断：从败方背包随机非绑定普通材料
        let dropItemKey = null;
        let dropItemQuantity = 0;
        if (!isDraw) {
            const dropRate = cfg.drop_rate_normal_item || 0.05;
            if (Math.random() < dropRate) {
                const loserId = isAttackerWin ? defender.id : attacker.id;
                const droppedItem = await this._tryDropItem(loserId, t);
                if (droppedItem) {
                    dropItemKey = droppedItem.item_key;
                    dropItemQuantity = droppedItem.quantity;
                    // 转移物品：从败方扣除，加到胜方
                    await this._transferDropItem(loserId, winnerId, dropItemKey, dropItemQuantity, t);
                }
            }
        }

        // 更新双方段位积分与统计
        // 攻击方
        attackerRanking.score = Math.max(0, (attackerRanking.score || 0) + attackerScoreChange);
        attackerRanking.rank_tier = this._getRankName(attackerRanking.score);
        attackerRanking.total_battles = (attackerRanking.total_battles || 0) + 1;
        if (!isDraw) {
            if (isAttackerWin) {
                attackerRanking.season_wins = (attackerRanking.season_wins || 0) + 1;
                attackerRanking.win_streak = (attackerRanking.win_streak || 0) + 1;
                attackerRanking.max_win_streak = Math.max(attackerRanking.max_win_streak || 0, attackerRanking.win_streak);
            } else {
                attackerRanking.season_losses = (attackerRanking.season_losses || 0) + 1;
                attackerRanking.win_streak = 0;
            }
        } else {
            attackerRanking.season_draws = (attackerRanking.season_draws || 0) + 1;
        }

        // 防守方
        defenderRanking.score = Math.max(0, (defenderRanking.score || 0) + defenderScoreChange);
        defenderRanking.rank_tier = this._getRankName(defenderRanking.score);
        defenderRanking.total_battles = (defenderRanking.total_battles || 0) + 1;
        if (!isDraw) {
            if (isDefenderWin) {
                defenderRanking.season_wins = (defenderRanking.season_wins || 0) + 1;
                defenderRanking.win_streak = (defenderRanking.win_streak || 0) + 1;
                defenderRanking.max_win_streak = Math.max(defenderRanking.max_win_streak || 0, defenderRanking.win_streak);
            } else {
                defenderRanking.season_losses = (defenderRanking.season_losses || 0) + 1;
                defenderRanking.win_streak = 0;
            }
        } else {
            defenderRanking.season_draws = (defenderRanking.season_draws || 0) + 1;
        }

        // 更新双方 players 表（冗余字段便于排行榜查询）
        attacker.pvp_score = attackerRanking.score;
        attacker.pvp_rank = attackerRanking.rank_tier;
        defender.pvp_score = defenderRanking.score;
        defender.pvp_rank = defenderRanking.rank_tier;

        // 荣誉值累加（BIGINT）
        attacker.honor = safeBigInt(attacker.honor) + BigInt(attackerHonorGain);
        defender.honor = safeBigInt(defender.honor) + BigInt(defenderHonorGain);

        // 因果值累加（仅攻击方跨境界欺凌时累加 karma）
        if (karmaChange > 0) {
            attacker.karma = (attacker.karma || 0) + karmaChange;
        }

        // 修为奖励（BIGINT）
        if (attackerExpGain > 0) {
            attacker.exp = safeBigInt(attacker.exp) + BigInt(attackerExpGain);
        }
        if (defenderExpGain > 0) {
            defender.exp = safeBigInt(defender.exp) + BigInt(defenderExpGain);
        }

        // 灵石奖励：胜方获得 spiritStoneReward
        if (spiritStoneReward > 0) {
            if (isAttackerWin) {
                attacker.spirit_stones = safeBigInt(attacker.spirit_stones) + BigInt(spiritStoneReward);
            } else if (isDefenderWin) {
                defender.spirit_stones = safeBigInt(defender.spirit_stones) + BigInt(spiritStoneReward);
            }
        }

        // 败方保底奖励应用（b2-6 新增）：败方获得少量灵石和经验作为参与奖
        if (loserConsolationStone > 0 || loserConsolationExp > 0) {
            if (isAttackerWin) {
                // 防守方败：保底发给防守方
                if (loserConsolationStone > 0) {
                    defender.spirit_stones = safeBigInt(defender.spirit_stones) + BigInt(loserConsolationStone);
                }
                if (loserConsolationExp > 0) {
                    defender.exp = safeBigInt(defender.exp) + BigInt(loserConsolationExp);
                }
            } else if (isDefenderWin) {
                // 攻击方败：保底发给攻击方
                if (loserConsolationStone > 0) {
                    attacker.spirit_stones = safeBigInt(attacker.spirit_stones) + BigInt(loserConsolationStone);
                }
                if (loserConsolationExp > 0) {
                    attacker.exp = safeBigInt(attacker.exp) + BigInt(loserConsolationExp);
                }
            }
        }

        // 更新战斗记录
        battle.status = 'finished';
        battle.winner_id = winnerId;
        battle.finished_at = now;
        battle.attacker_score_change = attackerScoreChange;
        battle.defender_score_change = defenderScoreChange;
        battle.attacker_honor_gain = attackerHonorGain;
        battle.defender_honor_gain = defenderHonorGain;
        battle.spirit_stone_reward = spiritStoneReward;
        battle.drop_item_key = dropItemKey;
        battle.drop_item_quantity = dropItemQuantity;
        battle.karma_change = karmaChange;

        // 持久化
        await attacker.save({ transaction: t });
        await defender.save({ transaction: t });
        await attackerRanking.save({ transaction: t });
        await defenderRanking.save({ transaction: t });
        await battle.save({ transaction: t });

        // 异步推送：通知双方斗法结果
        const resultPayload = {
            battle_id: battle.id,
            winner_id: winnerId,
            is_draw: isDraw,
            attacker_score_change: attackerScoreChange,
            defender_score_change: defenderScoreChange,
            attacker_honor_gain: attackerHonorGain,
            defender_honor_gain: defenderHonorGain,
            attacker_exp_gain: attackerExpGain,
            defender_exp_gain: defenderExpGain,
            spirit_stone_reward: spiritStoneReward,
            // 败方保底奖励（b2-6 新增）：败方获得的少量灵石和经验，前端可展示为"参与奖"
            loser_consolation_stone: loserConsolationStone,
            loser_consolation_exp: loserConsolationExp,
            loser_id: (!isDraw && !options.is_flee) ? (isAttackerWin ? defender.id : attacker.id) : null,
            drop_item_key: dropItemKey,
            drop_item_quantity: dropItemQuantity,
            karma_change: karmaChange,
            finished_at: now.toISOString()
        };
        try {
            const WebSocketNotificationService = require('./WebSocketNotificationService');
            WebSocketNotificationService.notifyPlayerUpdate(attacker.id, 'pvp_result', resultPayload);
            WebSocketNotificationService.notifyPlayerUpdate(defender.id, 'pvp_result', resultPayload);
        } catch (e) { /* 推送失败不阻塞 */ }

        // 记录 admin_logs（审计）
        try {
            const AdminLog = require('../../models/admin_log');
            await AdminLog.create({
                admin_id: 0,  // 系统自动结算，无 GM 操作人
                action: 'pvp_settle',
                target_id: battle.id,
                details: JSON.stringify({
                    attacker_id: attacker.id,
                    defender_id: defender.id,
                    winner_id: winnerId,
                    is_draw: isDraw,
                    is_flee: options.is_flee === true,
                    attacker_score_change: attackerScoreChange,
                    defender_score_change: defenderScoreChange,
                    spirit_stone_reward: spiritStoneReward,
                    karma_change: karmaChange
                }),
                ip: null
            }, { transaction: t });
        } catch (e) { /* 审计日志失败不阻塞主流程 */ }

        return resultPayload;
    }

    /**
     * 内部方法：尝试从败方背包随机掉落非绑定普通材料
     * 筛选规则：type=material 且 quality=common 的物品（普通材料，非绑定）
     * @param {number} loserId - 败方玩家ID
     * @param {Object} t - 事务实例
     * @returns {Promise<Object|null>} 掉落物品 { item_key, quantity }，无可用物品返回 null
     */
    static async _tryDropItem(loserId, t) {
        // 查询败方所有物品记录
        const loserItems = await Item.findAll({
            where: { player_id: loserId },
            transaction: t
        });
        if (loserItems.length === 0) return null;

        // 加载物品配置，筛选可掉落的普通材料
        const itemDataConfig = configLoader.getConfig('item_data')?.items || [];
        const droppableKeys = new Set(
            itemDataConfig
                .filter(i => i.type === 'material' && (i.quality || 'common') === 'common')
                .map(i => i.id)
        );

        // 与败方持有的物品取交集
        const candidates = loserItems.filter(i => droppableKeys.has(i.item_key) && i.quantity > 0);
        if (candidates.length === 0) return null;

        // 随机选择一个
        const picked = candidates[Math.floor(Math.random() * candidates.length)];
        const dropQuantity = Math.min(picked.quantity, 1);  // 单次掉落 1 个，避免过大损失
        return {
            item_key: picked.item_key,
            quantity: dropQuantity
        };
    }

    /**
     * 内部方法：转移掉落物品（从败方扣除，加到胜方）
     * @param {number} loserId - 败方玩家ID
     * @param {number} winnerId - 胜方玩家ID
     * @param {string} itemKey - 物品 key
     * @param {number} quantity - 转移数量
     * @param {Object} t - 事务实例
     */
    static async _transferDropItem(loserId, winnerId, itemKey, quantity, t) {
        // 从败方扣除
        const loserItem = await Item.findOne({
            where: { player_id: loserId, item_key: itemKey },
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!loserItem || loserItem.quantity < quantity) return;

        loserItem.quantity -= quantity;
        if (loserItem.quantity <= 0) {
            await loserItem.destroy({ transaction: t });
        } else {
            await loserItem.save({ transaction: t });
        }

        // 加到胜方（若已有则累加，否则新建）
        const winnerItem = await Item.findOne({
            where: { player_id: winnerId, item_key: itemKey },
            transaction: t
        });
        if (winnerItem) {
            winnerItem.quantity += quantity;
            await winnerItem.save({ transaction: t });
        } else {
            await Item.create({
                player_id: winnerId,
                item_key: itemKey,
                quantity
            }, { transaction: t });
        }
    }

    /**
     * 清理过期 PVP 战斗（供 StateCleanerService 调用）
     * 超时阈值：started_at + max_rounds * round_timeout_seconds + 60s 宽限
     * 超时自动判平（双方均不得分），更新 status='cancelled'
     * @param {Object} ctx - 清理上下文 { batchSize, notify }
     * @returns {Promise<Object>} 清理统计 { scanned, cleaned, failed }
     */
    static async cleanExpiredBattles(ctx = {}) {
        const stats = { scanned: 0, cleaned: 0, failed: 0 };
        const cfg = this.getPvpConfig();
        const batchSize = ctx.batchSize || 100;

        // 超时阈值：max_rounds * round_timeout_seconds + 60s 宽限
        const maxRounds = cfg.max_rounds || 30;
        const roundTimeout = cfg.round_timeout_seconds || 60;
        const graceSeconds = 60;
        const totalTimeoutMs = (maxRounds * roundTimeout + graceSeconds) * 1000;

        const now = new Date();
        const thresholdTime = new Date(now.getTime() - totalTimeoutMs);

        try {
            // 查询超时的进行中战斗
            const expiredBattles = await PvpBattleRecord.findAll({
                where: {
                    status: 'ongoing',
                    started_at: { [Op.lt]: thresholdTime }
                },
                limit: batchSize,
                order: [['started_at', 'ASC']]
            });

            stats.scanned = expiredBattles.length;

            for (const battle of expiredBattles) {
                try {
                    const t = await sequelize.transaction();
                    try {
                        // 行级锁战斗记录，防止与 executeAction/flee 并发
                        const locked = await PvpBattleRecord.findByPk(battle.id, {
                            lock: t.LOCK.UPDATE,
                            transaction: t
                        });
                        if (!locked || locked.status !== 'ongoing') {
                            await t.commit();
                            continue;
                        }

                        // 超时自动判平：winner_id=null，status='cancelled'
                        // 双方均不得分，仅记录 cancelled 状态供查询
                        locked.status = 'cancelled';
                        locked.winner_id = null;
                        locked.finished_at = now;
                        // 追加超时日志
                        const log = locked.battle_log ? JSON.parse(locked.battle_log) : [];
                        log.push({
                            round: locked.total_rounds,
                            event: 'timeout_cancelled',
                            reason: '回合超时自动判平',
                            timestamp: now.toISOString()
                        });
                        locked.battle_log = JSON.stringify(log);
                        await locked.save({ transaction: t });

                        // 通知双方战斗被取消
                        if (ctx.notify) {
                            try {
                                ctx.notify(locked.attacker_id, 'pvp_cancelled', {
                                    battle_id: locked.id,
                                    reason: 'timeout'
                                });
                                ctx.notify(locked.defender_id, 'pvp_cancelled', {
                                    battle_id: locked.id,
                                    reason: 'timeout'
                                });
                            } catch (e) { /* 推送失败不影响清理 */ }
                        }

                        await t.commit();
                        stats.cleaned += 1;
                    } catch (err) {
                        if (!t.finished) await t.rollback();
                        stats.failed += 1;
                        console.warn(`[PvpService] 清理过期战斗 ${battle.id} 失败:`, err.message);
                    }
                } catch (err) {
                    stats.failed += 1;
                    console.warn(`[PvpService] 清理过期战斗 ${battle.id} 失败:`, err.message);
                }
            }
        } catch (err) {
            console.warn('[PvpService] 清理过期战斗查询失败:', err.message);
            stats.failed += 1;
        }

        return stats;
    }

    /**
     * 获取段位排行榜
     * 返回前 N 名玩家（按 score 降序）
     * 设计说明：Player 与 PvpRanking 之间未在模型层定义关联，
     *           使用分两步查询（先查段位表，再批量查玩家基础信息），避免 N+1 查询
     * @param {number} limit - 返回数量
     * @returns {Promise<Array>} 排行榜列表
     */
    static async getLeaderboard(limit = 50) {
        const safeLimit = Math.min(Math.max(1, limit), 100);  // 限制 1-100

        // 第一步：查询段位表，按 score 降序
        const rankings = await PvpRanking.findAll({
            order: [['score', 'DESC'], ['season_wins', 'DESC']],
            limit: safeLimit
        });

        if (rankings.length === 0) return [];

        // 第二步：批量查询对应玩家基础信息
        const playerIds = rankings.map(r => r.player_id);
        const players = await Player.findAll({
            where: { id: playerIds },
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        const playerMap = new Map(players.map(p => [p.id, p]));

        return rankings.map((r, idx) => {
            const p = playerMap.get(r.player_id);
            return {
                rank: idx + 1,
                player_id: r.player_id,
                nickname: p?.nickname || '未知',
                realm: p?.realm || '凡人',
                realm_rank: p?.realm_rank || 0,
                score: r.score,
                rank_tier: r.rank_tier,
                season_wins: r.season_wins,
                season_losses: r.season_losses,
                win_streak: r.win_streak,
                max_win_streak: r.max_win_streak
            };
        });
    }

    /**
     * 获取战斗历史
     * 分页查询玩家参与的战斗记录（攻击方或防守方）
     * @param {number} playerId - 玩家ID
     * @param {Object} options - 分页参数 { page, limit }
     * @returns {Promise<Object>} 战斗历史列表
     */
    static async getBattleHistory(playerId, { page = 1, limit = 20 } = {}) {
        const safePage = Math.max(1, page);
        const safeLimit = Math.min(Math.max(1, limit), 100);
        const offset = (safePage - 1) * safeLimit;

        const { count, rows } = await PvpBattleRecord.findAndCountAll({
            where: {
                [Op.or]: [
                    { attacker_id: playerId },
                    { defender_id: playerId }
                ]
            },
            order: [['started_at', 'DESC']],
            limit: safeLimit,
            offset
        });

        // 批量查询对手玩家信息（避免 N+1 查询）
        const opponentIds = new Set();
        for (const r of rows) {
            if (r.attacker_id !== playerId) opponentIds.add(r.attacker_id);
            if (r.defender_id !== playerId) opponentIds.add(r.defender_id);
        }
        const opponentIdArray = Array.from(opponentIds);
        const opponents = opponentIdArray.length > 0
            ? await Player.findAll({
                where: { id: opponentIdArray },
                attributes: ['id', 'nickname', 'realm', 'realm_rank', 'pvp_score', 'pvp_rank']
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
                battle_id: r.id,
                battle_type: r.battle_type,
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
                score_change: isAttacker ? r.attacker_score_change : r.defender_score_change,
                honor_gain: isAttacker ? r.attacker_honor_gain : r.defender_honor_gain,
                spirit_stone_reward: r.spirit_stone_reward,
                drop_item_key: r.drop_item_key,
                drop_item_quantity: r.drop_item_quantity,
                karma_change: r.karma_change,
                started_at: r.started_at,
                finished_at: r.finished_at
            };
        });

        return {
            list,
            total: count,
            page: safePage,
            page_size: safeLimit
        };
    }

    // ==================== PVP 扩展功能 ====================

    /**
     * 切换 PVP 模式（避世/入世）
     * - active=入世：可正常发起和接受 PVP 挑战
     * - recluse=避世：免疫 PVP 挑战，但自身也无法发起挑战
     * 校验：玩家存在、未死亡、无进行中战斗
     * @param {number} playerId - 玩家ID
     * @param {string} mode - PVP 模式：active/recluse
     * @returns {Promise<Object>} 更新后的模式信息
     */
    static async setPvpMode(playerId, mode) {
        // 参数校验：仅允许 active / recluse
        const allowedModes = ['active', 'recluse'];
        if (!allowedModes.includes(mode)) {
            throw new AppError(
                `无效的 PVP 模式：${mode}，可选值：${allowedModes.join('/')}`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 死亡玩家不可切换模式
            if (player.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法切换 PVP 模式', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 进行中的 PVP 战斗不可切换模式（避免战斗中途变为避世）
            const ongoingBattle = await PvpBattleRecord.findOne({
                where: {
                    [Op.and]: [
                        { status: 'ongoing' },
                        {
                            [Op.or]: [
                                { attacker_id: playerId },
                                { defender_id: playerId }
                            ]
                        }
                    ]
                },
                transaction: t
            });
            if (ongoingBattle) {
                await t.commit();
                throw new AppError('斗法进行中，无法切换 PVP 模式', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 更新 PVP 模式
            player.pvp_mode = mode;
            await player.save({ transaction: t });
            await t.commit();

            return {
                player_id: player.id,
                pvp_mode: mode,
                mode_name: mode === 'active' ? '入世' : '避世'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 获取玩家当前 PVP 模式
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} PVP 模式信息
     */
    static async getPvpMode(playerId) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'pvp_mode', 'realm', 'realm_rank']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const mode = player.pvp_mode || 'active';
        return {
            player_id: player.id,
            nickname: player.nickname,
            realm: player.realm,
            realm_rank: player.realm_rank,
            pvp_mode: mode,
            mode_name: mode === 'active' ? '入世' : '避世'
        };
    }

    /**
     * 查询玩家战力
     * 战力公式（权重来自 game_balance.json -> pvp_extended.combat_power）：
     *   战力 = hp_max * hp_weight + atk * atk_weight + def * def_weight
     *          + speed * speed_weight + sense * sense_weight
     *          + realm_rank * realm_rank_multiplier
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 战力数值与属性明细
     */
    static async getCombatPower(playerId) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank', 'attributes', 'active_formation_id']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 读取战力计算配置
        const fullConfig = configLoader.getConfig('game_balance');
        const cpCfg = fullConfig?.pvp_extended?.combat_power || {};

        // 读取玩家基础属性
        const attrs = player.attributes || {};
        const atk = Number(attrs.atk) || 0;
        const def = Number(attrs.def) || 0;
        const hpMax = Number(attrs.hp_max) || 0;
        const speed = Number(attrs.speed) || 0;
        const sense = Number(attrs.sense) || 0;
        const realmRank = Number(player.realm_rank) || 0;

        // 读取权重（带兜底默认值）
        const hpWeight = cpCfg.base_hp_weight ?? 1.0;
        const atkWeight = cpCfg.base_atk_weight ?? 5.0;
        const defWeight = cpCfg.base_def_weight ?? 3.0;
        const speedWeight = cpCfg.base_speed_weight ?? 2.0;
        const senseWeight = cpCfg.base_sense_weight ?? 1.5;
        const realmMul = cpCfg.realm_rank_multiplier ?? 100;
        const maxDecimals = cpCfg.max_display_decimals ?? 0;

        // 计算战力
        const rawPower = (hpMax * hpWeight)
            + (atk * atkWeight)
            + (def * defWeight)
            + (speed * speedWeight)
            + (sense * senseWeight)
            + (realmRank * realmMul);

        // 阵法战力加成（从 FormationService 获取当前激活阵法效果）
        let formationBonus = 0;
        let formationInfo = null;
        try {
            formationBonus = await FormationService.calculateCombatPowerBonus(player, { atk, def, hp_max: hpMax, speed, sense });
            if (formationBonus > 0) {
                const formationEffect = await FormationService.getActiveFormationEffect(player);
                formationInfo = {
                    formation_id: formationEffect.formation_id,
                    formation_name: formationEffect.formation_name,
                    category: formationEffect.category,
                    proficiency: formationEffect.proficiency,
                    effects: formationEffect.effects,
                    bonus_power: formationBonus
                };
            }
        } catch (e) {
            // 阵法系统异常不应影响战力计算主流程
            console.error('[PvpService.getCombatPower] 阵法加成计算失败:', e.message);
        }

        // 按配置精度截断
        const factor = Math.pow(10, maxDecimals);
        const combatPower = Math.floor((rawPower + formationBonus) * factor) / factor;

        return {
            player_id: player.id,
            nickname: player.nickname,
            realm: player.realm,
            realm_rank: realmRank,
            combat_power: combatPower,
            details: {
                atk,
                def,
                hp_max: hpMax,
                speed,
                sense,
                realm_rank: realmRank,
                weights: {
                    hp_weight: hpWeight,
                    atk_weight: atkWeight,
                    def_weight: defWeight,
                    speed_weight: speedWeight,
                    sense_weight: senseWeight,
                    realm_rank_multiplier: realmMul
                },
                base_power: Math.floor(rawPower * factor) / factor,
                formation_bonus: formationBonus,
                formation: formationInfo
            }
        };
    }

    /**
     * 对比两个玩家的战力
     * @param {number} playerIdA - 玩家A的ID
     * @param {number} playerIdB - 玩家B的ID
     * @returns {Promise<Object>} 双方战力对比结果
     */
    static async compareCombatPower(playerIdA, playerIdB) {
        // 并行查询双方战力
        const [powerA, powerB] = await Promise.all([
            this.getCombatPower(playerIdA),
            this.getCombatPower(playerIdB)
        ]);

        const diff = powerA.combat_power - powerB.combat_power;

        // 判断战力优势方
        let advantage;
        if (diff > 0) {
            advantage = 'player_a';
        } else if (diff < 0) {
            advantage = 'player_b';
        } else {
            advantage = 'equal';
        }

        return {
            player_a: powerA,
            player_b: powerB,
            power_difference: Math.abs(diff),
            advantage
        };
    }

    /**
     * 切磋木人（零惩罚训练）
     * 生成一个木人对手，属性按 pvp_extended.sparring 基础值 + 境界加成
     * 木人属性 = base * (1 + targetRealmRank * 0.5)（每个境界递增50%）
     * 复用 executeAction 的战斗逻辑进行模拟战斗，但零惩罚：
     *   - 不扣灵石、不加虚弱、不掉物品、不影响段位分
     *   - 仅获得经验奖励
     * 限制：每日次数（daily_limit）、冷却时间（cooldown_seconds）
     * 记录：player.stats JSON 中的 sparring_count / last_sparring_date / last_sparring_time
     *
     * @param {number} playerId - 玩家ID
     * @param {number} targetRealmRank - 目标境界排名（决定木人强度）
     * @returns {Promise<Object>} 切磋结果（含战斗日志、经验奖励、次数信息）
     */
    static async sparringWithDummy(playerId, targetRealmRank) {
        // 读取配置
        const fullConfig = configLoader.getConfig('game_balance');
        const sparringCfg = fullConfig?.pvp_extended?.sparring || {};
        const combatCfg = fullConfig?.combat || {};
        const pvpCfg = fullConfig?.pvp || {};

        // 全局开关
        if (sparringCfg.enabled === false) {
            throw new AppError('切磋木人功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验：目标境界排名必须为有效数字
        const targetRank = Number(targetRealmRank);
        if (!Number.isFinite(targetRank)) {
            throw new AppError('target_realm_rank 参数无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const minRank = sparringCfg.min_realm_rank ?? 1;
        const maxRank = sparringCfg.max_realm_rank ?? 10;
        if (targetRank < minRank || targetRank > maxRank) {
            throw new AppError(
                `目标境界排名超出范围，允许 ${minRank}-${maxRank}`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法切磋', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁，无法切磋', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 读取玩家 stats 中的切磋记录
            const stats = { ...(player.stats || {}) };
            const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
            let sparringCount = Number(stats.sparring_count) || 0;
            const lastSparringDate = stats.last_sparring_date || null;

            // 跨日重置每日次数
            if (lastSparringDate !== today) {
                sparringCount = 0;
            }

            // 每日次数校验
            const dailyLimit = sparringCfg.daily_limit ?? 20;
            if (sparringCount >= dailyLimit) {
                await t.commit();
                throw new AppError(
                    `今日切磋次数已达上限（${dailyLimit} 次）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 冷却校验：基于 last_sparring_time
            const cooldown = sparringCfg.cooldown_seconds ?? 10;
            const lastSparringTimeMs = stats.last_sparring_time
                ? new Date(stats.last_sparring_time).getTime()
                : 0;
            if (lastSparringTimeMs > 0) {
                const elapsed = (Date.now() - lastSparringTimeMs) / 1000;
                if (elapsed < cooldown) {
                    await t.commit();
                    const remain = Math.ceil(cooldown - elapsed);
                    throw new AppError(
                        `切磋冷却中，请 ${remain} 秒后再试`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 生成木人属性：base * (1 + targetRealmRank * 0.5)
            // 每个境界排名递增 50% 基础属性
            const baseHp = sparringCfg.wooden_dummy_base_hp ?? 500;
            const baseAtk = sparringCfg.wooden_dummy_base_atk ?? 20;
            const baseDef = sparringCfg.wooden_dummy_base_def ?? 10;
            const baseSpeed = sparringCfg.wooden_dummy_base_speed ?? 10;
            const dummyMultiplier = 1 + targetRank * 0.5;
            const dummyAttrs = {
                hp_max: Math.floor(baseHp * dummyMultiplier),
                atk: Math.floor(baseAtk * dummyMultiplier),
                def: Math.floor(baseDef * dummyMultiplier),
                speed: Math.floor(baseSpeed * dummyMultiplier)
            };

            // 读取玩家属性（使用副本，零惩罚不持久化 HP/MP 变化）
            const playerAttrsRaw = player.attributes || {};
            const playerAtk = Number(playerAttrsRaw.atk) || 10;
            const playerDef = Number(playerAttrsRaw.def) || 5;
            const playerHpMax = Number(playerAttrsRaw.hp_max) || 100;
            const playerSpeed = Number(playerAttrsRaw.speed) || 10;
            const playerMpMax = Number(playerAttrsRaw.mp_max) || 0;

            // 模拟战斗（复用 executeAction 的伤害公式，全程内存计算不落库）
            const maxRounds = pvpCfg.max_rounds || 30;
            const battleResult = this._simulateSparringBattle(
                {
                    atk: playerAtk,
                    def: playerDef,
                    hp_max: playerHpMax,
                    speed: playerSpeed,
                    mp_max: playerMpMax
                },
                dummyAttrs,
                maxRounds,
                combatCfg
            );

            // 计算经验奖励 = exp_reward_base + |targetRealmRank - playerRealmRank| * exp_reward_per_realm_gap
            const playerRealmRank = Number(player.realm_rank) || 0;
            const expBase = sparringCfg.exp_reward_base ?? 50;
            const expPerGap = sparringCfg.exp_reward_per_realm_gap ?? 20;
            const realmGap = Math.abs(targetRank - playerRealmRank);
            const expReward = expBase + realmGap * expPerGap;

            // 更新玩家 stats（切磋次数和冷却记录）
            stats.sparring_count = sparringCount + 1;
            stats.last_sparring_date = today;
            stats.last_sparring_time = new Date().toISOString();
            player.stats = stats;

            // 累加经验（BIGINT 安全运算）
            if (expReward > 0) {
                player.exp = safeBigInt(player.exp) + BigInt(expReward);
            }

            await player.save({ transaction: t });
            await t.commit();

            return {
                player_id: player.id,
                target_realm_rank: targetRank,
                dummy_attributes: dummyAttrs,
                battle: {
                    winner: battleResult.winner,
                    is_draw: battleResult.isDraw,
                    rounds: battleResult.rounds,
                    final_player_hp: battleResult.finalPlayerHp,
                    final_dummy_hp: battleResult.finalDummyHp,
                    battle_log: battleResult.battleLog
                },
                exp_reward: expReward,
                sparring_count_today: stats.sparring_count,
                daily_limit: dailyLimit,
                daily_remaining: Math.max(0, dailyLimit - stats.sparring_count),
                cooldown_seconds: cooldown,
                zero_penalty: true  // 零惩罚标记：无灵石/虚弱/掉落/段位分变动
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 内部方法：模拟切磋木人战斗
     * 复用 executeAction 的伤害公式（attack/skill），在内存中完成整场战斗
     * 木人仅使用普通攻击（无法术），玩家自动决策：MP 足够时用技能，否则普通攻击
     * 先手判定基于速度，速度快者先攻；速度相同则随机
     *
     * @param {Object} playerAttrs - 玩家战斗属性 { atk, def, hp_max, speed, mp_max }
     * @param {Object} dummyAttrs - 木人战斗属性 { atk, def, hp_max, speed }
     * @param {number} maxRounds - 最大回合数
     * @param {Object} combatConfig - 战斗配置（伤害随机范围等）
     * @returns {Object} 战斗结果 { winner, isDraw, rounds, battleLog, finalPlayerHp, finalDummyHp }
     */
    static _simulateSparringBattle(playerAttrs, dummyAttrs, maxRounds, combatConfig) {
        // 先手判定：基于速度
        const playerSpeed = Number(playerAttrs.speed) || 0;
        const dummySpeed = Number(dummyAttrs.speed) || 0;
        let firstAttacker;
        if (playerSpeed > dummySpeed) {
            firstAttacker = 'player';
        } else if (dummySpeed > playerSpeed) {
            firstAttacker = 'dummy';
        } else {
            firstAttacker = Math.random() < 0.5 ? 'player' : 'dummy';
        }

        // 初始化双方 HP/MP（使用副本，零惩罚不回写玩家数据）
        let playerHp = Number(playerAttrs.hp_max) || 100;
        let playerMp = Number(playerAttrs.mp_max) || 0;
        let dummyHp = Number(dummyAttrs.hp_max) || 500;

        // 读取伤害相关配置
        const dmgRange = combatConfig.damage_random_range ?? 15;
        const dmgOffset = combatConfig.damage_random_offset ?? 7;
        const skillDamageMul = combatConfig.skill_damage_multiplier ?? 1.5;
        const skillMpCost = combatConfig.skill_mp_cost ?? 20;

        const battleLog = [];
        let round = 0;
        let winner = null;
        let isDraw = false;

        // 回合循环：双方交替行动
        while (round < maxRounds) {
            // 当前回合的 actor：偶数回合由 first_attacker 行动
            const isPlayerTurn = (firstAttacker === 'player')
                ? (round % 2 === 0)
                : (round % 2 === 1);

            if (isPlayerTurn) {
                // 玩家行动：MP 足够时使用技能（伤害 × skill_damage_multiplier），否则普通攻击
                let action = 'attack';
                let damage;
                if (playerMp >= skillMpCost) {
                    action = 'skill';
                    playerMp -= skillMpCost;
                    damage = Math.max(1, Math.floor(
                        (playerAttrs.atk - dummyAttrs.def + Math.floor(Math.random() * dmgRange) - dmgOffset)
                        * skillDamageMul
                    ));
                } else {
                    damage = Math.max(1, playerAttrs.atk - dummyAttrs.def
                        + Math.floor(Math.random() * dmgRange) - dmgOffset);
                }
                dummyHp = Math.max(0, dummyHp - damage);
                battleLog.push({
                    round: round + 1,
                    actor: 'player',
                    action,
                    damage,
                    player_hp: playerHp,
                    dummy_hp: dummyHp
                });

                // 木人 HP 归零，玩家胜
                if (dummyHp <= 0) {
                    winner = 'player';
                    break;
                }
            } else {
                // 木人行动：仅普通攻击（木人无法术）
                const damage = Math.max(1, dummyAttrs.atk - playerAttrs.def
                    + Math.floor(Math.random() * dmgRange) - dmgOffset);
                playerHp = Math.max(0, playerHp - damage);
                battleLog.push({
                    round: round + 1,
                    actor: 'dummy',
                    action: 'attack',
                    damage,
                    player_hp: playerHp,
                    dummy_hp: dummyHp
                });

                // 玩家 HP 归零，木人胜
                if (playerHp <= 0) {
                    winner = 'dummy';
                    break;
                }
            }
            round++;
        }

        // 达到最大回合数仍未分出胜负：HP 高者胜，相等则平局
        if (!winner) {
            if (playerHp > dummyHp) {
                winner = 'player';
            } else if (dummyHp > playerHp) {
                winner = 'dummy';
            } else {
                isDraw = true;
            }
        }

        return {
            winner,
            isDraw,
            rounds: round + 1,
            battleLog,
            finalPlayerHp: playerHp,
            finalDummyHp: dummyHp
        };
    }
}

module.exports = PvpService;
