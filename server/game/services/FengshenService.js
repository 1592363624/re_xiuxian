/**
 * 封神台服务（PVP 镜像排名竞技场）
 *
 * 提供封神台赛季制排名竞技的核心业务逻辑：
 * 1. getRanking：获取封神台排名榜（分页查询，标注当前玩家排名）
 * 2. setDefense：设置防守阵容（快照当前属性 + 前端传入装备/法宝配置）
 * 3. challengeRank：挑战指定排名的玩家（校验 + 模拟战斗 + 排名交换/积分变动）
 * 4. getMyRanking：获取自己的封神台信息
 * 5. getDefense：获取自己的防守阵容
 * 6. getSeasonInfo：获取赛季信息（编号/时间/奖励规则）
 * 7. settleSeason：赛季结算（排名奖励发放 + 积分重置 + 赛季递增）
 *
 * 设计原则：
 * - 所有可变参数从 game_balance.json pvp_extended.fengshen 段读取，禁止硬编码
 * - 多表/多字段变更使用事务 + 行级锁（fengshen_rankings + players）
 * - 防守方使用防守阵容快照（setDefense 时存的属性快照）参与战斗
 * - 挑战者使用当前属性参与战斗，实现"镜像排名战"的核心机制
 * - BigInt 安全：spirit_stones 和 honor 使用 safeBigInt 运算
 * - WebSocket 推送通过 WebSocketNotificationService.notifyPlayerUpdate
 * - 冷却时间使用内存 Map 追踪（因模型无 last_challenge_at 时间戳字段）
 */
'use strict';

const Player = require('../../models/player');
const FengshenRanking = require('../../models/fengshenRanking');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
// 大五行幻世轮服务（同目录引用，用于战斗结算后被动积累悟印）
const ArtifactDeepLineService = require('./ArtifactDeepLineService');

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

class FengshenService {
    /**
     * 构造函数
     * 初始化配置加载器引用和内存级冷却追踪 Map
     */
    constructor() {
        this.configLoader = null;
        // 冷却时间追踪：playerId -> 上次挑战的时间戳（毫秒）
        // 说明：模型 fengshen_rankings 无 last_challenge_at 时间戳字段，
        //       last_challenge_date 为 DATEONLY 类型（仅日期），无法精确到秒级冷却。
        //       采用内存 Map 追踪冷却，服务重启后冷却重置（可接受，冷却仅 180 秒）。
        this.lastChallengeTime = new Map();
    }

    /**
     * 初始化方法（接受配置注入）
     * 由外部调用方传入 ConfigLoader 实例，实现配置中心化
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 读取封神台配置
     * 从 game_balance.json -> pvp_extended.fengshen 段读取配置
     * 若未注入 configLoader，回退到全局 infrastructure.ConfigLoader
     * @returns {Object} 封神台配置对象
     */
    getFengshenConfig() {
        if (!this.configLoader) {
            // 回退到全局 ConfigLoader（兼容未显式 initialize 的场景）
            const { infrastructure } = require('../../modules');
            this.configLoader = infrastructure.ConfigLoader;
        }
        const config = this.configLoader.getConfig('game_balance');
        return config?.pvp_extended?.fengshen || {};
    }

    /**
     * 获取当前赛季编号
     * 取 fengshen_rankings 表中最大的 season 值，无记录则返回 1
     * @returns {Promise<number>} 当前赛季编号
     */
    async _getCurrentSeason() {
        const maxSeason = await FengshenRanking.max('season');
        return maxSeason || 1;
    }

    /**
     * 跨日重置每日挑战次数（基于 last_challenge_date）
     * 注意：DATEONLY 字段，比较 YYYY-MM-DD 字符串
     * @param {Object} ranking - FengshenRanking 实例
     */
    _resetDailyCountersIfNewDay(ranking) {
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
     * 从玩家当前属性计算战力
     * 战力公式：atk * 2 + def * 1.5 + speed * 1.2 + hp_max * 0.1 + realm_rank * 100
     * （与 PvpService._calculatePower 保持一致，确保战力体系统一）
     * @param {Object} player - 玩家实例
     * @returns {number} 战力值
     */
    _calculatePowerFromAttributes(player) {
        const attrs = player.attributes || {};
        const atk = Number(attrs.atk) || 0;
        const def = Number(attrs.def) || 0;
        const speed = Number(attrs.speed) || 0;
        const hpMax = Number(attrs.hp_max) || 0;
        const realmRank = Number(player.realm_rank) || 0;
        return Math.floor(atk * 2 + def * 1.5 + speed * 1.2 + hpMax * 0.1 + realmRank * 100);
    }

    /**
     * 从防守阵容快照计算战力
     * 防守方使用 setDefense 时存的属性快照参与战斗，而非当前属性
     * @param {Object} snapshot - 防守阵容中的属性快照
     * @returns {number} 战力值
     */
    _calculatePowerFromSnapshot(snapshot) {
        if (!snapshot) return 0;
        const atk = Number(snapshot.atk) || 0;
        const def = Number(snapshot.def) || 0;
        const speed = Number(snapshot.speed) || 0;
        const hpMax = Number(snapshot.hp_max) || 0;
        const realmRank = Number(snapshot.realm_rank) || 0;
        return Math.floor(atk * 2 + def * 1.5 + speed * 1.2 + hpMax * 0.1 + realmRank * 100);
    }

    /**
     * 模拟封神台战斗（简化版）
     * 基于双方战力对比，加入 ±20% 随机波动判定胜负
     * 设计说明：封神台为镜像排名战，战斗自动结算（非回合制），
     *           随机因素保证低战力玩家有逆袭可能，符合"以弱胜强"的修仙叙事
     * @param {number} attackerPower - 挑战者战力
     * @param {number} defenderPower - 防守方战力
     * @returns {Object} { attackerWins: boolean, log: Array }
     */
    _simulateBattle(attackerPower, defenderPower) {
        // 随机波动：0.8 ~ 1.2 倍战力，模拟战斗中的临场发挥
        const attackerRoll = attackerPower * (0.8 + Math.random() * 0.4);
        const defenderRoll = defenderPower * (0.8 + Math.random() * 0.4);
        const attackerWins = attackerRoll >= defenderRoll;

        // 生成战斗日志（供前端展示战斗过程）
        const log = [
            {
                round: 0,
                event: 'battle_start',
                attacker_power: attackerPower,
                defender_power: defenderPower,
                timestamp: new Date().toISOString()
            },
            {
                round: 1,
                event: 'power_clash',
                attacker_roll: Math.floor(attackerRoll),
                defender_roll: Math.floor(defenderRoll),
                timestamp: new Date().toISOString()
            },
            {
                round: 2,
                event: 'battle_end',
                winner: attackerWins ? 'attacker' : 'defender',
                timestamp: new Date().toISOString()
            }
        ];

        return { attackerWins, log };
    }

    /**
     * 重新计算所有玩家的排名
     * 按 fengshen_score 降序、total_wins 降序、created_at 升序排列
     * 仅更新排名发生变化的记录，减少数据库写入
     * 注意：调用方必须已传入事务
     * @param {Object} t - 事务实例
     */
    async _recalculateRanks(t) {
        // 查询所有有防守阵容的玩家（rank > 0 的前提是已设置防守）
        const rankings = await FengshenRanking.findAll({
            where: { defense_config: { [Op.ne]: null } },
            order: [
                ['fengshen_score', 'DESC'],
                ['total_wins', 'DESC'],
                ['created_at', 'ASC']
            ],
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        const updatePromises = [];
        for (let i = 0; i < rankings.length; i++) {
            const newRank = i + 1;
            if (rankings[i].rank !== newRank) {
                rankings[i].rank = newRank;
                updatePromises.push(rankings[i].save({ transaction: t }));
            }
        }
        // 并发执行排名更新
        await Promise.all(updatePromises);
    }

    /**
     * 获取封神台排名榜（分页查询）
     * 返回按排名升序排列的玩家列表，标注当前玩家的排名
     * @param {number} playerId - 当前玩家ID（用于标注自己的排名）
     * @param {number} page - 页码（从 1 开始）
     * @param {number} pageSize - 每页数量
     * @returns {Promise<Object>} 排行榜数据 { list, total, page, page_size, my_rank, my_score }
     */
    async getRanking(playerId, page = 1, pageSize = 20) {
        const safePage = Math.max(1, parseInt(page) || 1);
        const safePageSize = Math.min(Math.max(1, parseInt(pageSize) || 20), 100);
        const offset = (safePage - 1) * safePageSize;

        // 分页查询排名记录（仅已设置防守阵容的玩家，rank > 0）
        const { count, rows } = await FengshenRanking.findAndCountAll({
            where: {
                rank: { [Op.gt]: 0 },
                defense_config: { [Op.ne]: null }
            },
            order: [['rank', 'ASC']],
            limit: safePageSize,
            offset
        });

        // 批量查询对应玩家基础信息（避免 N+1 查询）
        const playerIds = rows.map(r => r.player_id);
        const players = playerIds.length > 0
            ? await Player.findAll({
                where: { id: playerIds },
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            })
            : [];
        const playerMap = new Map(players.map(p => [p.id, p]));

        // 查询当前玩家的排名信息
        const myRanking = await FengshenRanking.findOne({
            where: { player_id: playerId }
        });

        // 拼装排行榜列表
        const list = rows.map(r => {
            const p = playerMap.get(r.player_id);
            const totalBattles = (r.total_wins || 0) + (r.total_losses || 0);
            const winRate = totalBattles > 0
                ? parseFloat(((r.total_wins / totalBattles) * 100).toFixed(1))
                : 0;
            return {
                rank: r.rank,
                player_id: r.player_id,
                nickname: p?.nickname || '未知道友',
                realm: p?.realm || '凡人',
                realm_rank: p?.realm_rank || 0,
                fengshen_score: r.fengshen_score,
                total_wins: r.total_wins,
                total_losses: r.total_losses,
                win_rate: winRate
            };
        });

        return {
            list,
            total: count,
            page: safePage,
            page_size: safePageSize,
            my_rank: myRanking?.rank || 0,
            my_score: myRanking?.fengshen_score || 0
        };
    }

    /**
     * 设置防守阵容
     * 前端传入防守配置（装备/法宝选择等），后端快照当前属性一并存储
     * 若玩家无排名记录则创建（初始积分 base_score=1000），并触发排名重算
     * @param {number} playerId - 玩家ID
     * @param {Object} defenseConfig - 前端传入的防守阵容配置
     * @returns {Promise<Object>} 设置结果 { success, defense_set_at, rank, fengshen_score }
     */
    async setDefense(playerId, defenseConfig) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 快照当前战斗属性（用于防守时模拟战斗）
        const attrs = player.attributes || {};
        const snapshot = {
            nickname: player.nickname,
            realm: player.realm,
            realm_rank: Number(player.realm_rank) || 0,
            atk: Number(attrs.atk) || 0,
            def: Number(attrs.def) || 0,
            speed: Number(attrs.speed) || 0,
            hp_max: Number(attrs.hp_max) || 0,
            hp_current: Number(attrs.hp_current) || Number(attrs.hp_max) || 100,
            mp_current: Number(attrs.mp_current) || 0
        };

        // 组装防守阵容数据：前端配置 + 属性快照 + 设置时间
        const defenseData = {
            config: defenseConfig || {},      // 前端传入的装备/法宝选择
            snapshot: snapshot,                // 当前属性快照（战斗模拟用）
            set_at: new Date().toISOString()  // 设置时间戳
        };

        const cfg = this.getFengshenConfig();
        const baseScore = cfg.base_score || 1000;

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家排名记录
            let ranking = await FengshenRanking.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if (!ranking) {
                // 新玩家初始化排名记录
                const currentSeason = await this._getCurrentSeason();
                ranking = await FengshenRanking.create({
                    player_id: playerId,
                    rank: 0,  // 待排名重算分配
                    season: currentSeason,
                    fengshen_score: baseScore,
                    defense_config: defenseData,
                    defense_set_at: new Date(),
                    daily_challenge_count: 0,
                    daily_defend_count: 0,
                    total_wins: 0,
                    total_losses: 0,
                    last_challenge_date: null
                }, { transaction: t });
            } else {
                // 更新已有记录的防守阵容
                ranking.defense_config = defenseData;
                ranking.defense_set_at = new Date();
            }

            await ranking.save({ transaction: t });

            // 重新计算所有玩家排名（为新加入的玩家分配排名）
            await this._recalculateRanks(t);

            // 重新读取排名（重算后可能已更新）
            await ranking.reload({ transaction: t });

            await t.commit();

            return {
                success: true,
                defense_set_at: ranking.defense_set_at,
                rank: ranking.rank,
                fengshen_score: ranking.fengshen_score
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 挑战指定排名的玩家
     * 校验流程：全局开关 → 冷却 → 玩家状态 → 防守阵容 → 每日次数 → 排名范围 → 双方 pvp_mode
     * 战斗结算：模拟战斗 → 积分变动 → 排名交换（仅挑战者胜）→ 胜负记录 → 每日次数累加
     * @param {number} playerId - 挑战者玩家ID
     * @param {number} targetRank - 目标排名
     * @returns {Promise<Object>} 挑战结果 { battle_result, my_rank, my_score, ... }
     */
    async challengeRank(playerId, targetRank) {
        const cfg = this.getFengshenConfig();

        // 全局开关校验
        if (cfg.enabled === false) {
            throw new AppError('封神台系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 目标排名参数校验
        const targetRankNum = parseInt(targetRank);
        if (!Number.isFinite(targetRankNum) || targetRankNum <= 0) {
            throw new AppError('目标排名参数无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 冷却时间校验（内存追踪）
        const cooldownSeconds = cfg.cooldown_seconds || 180;
        const lastChallengeMs = this.lastChallengeTime.get(playerId);
        if (lastChallengeMs) {
            const elapsed = (Date.now() - lastChallengeMs) / 1000;
            if (elapsed < cooldownSeconds) {
                const remain = Math.ceil(cooldownSeconds - elapsed);
                throw new AppError(`封神台冷却中，请 ${remain} 秒后再试`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
        }

        const t = await sequelize.transaction();
        try {
            // ===== 挑战者校验 =====
            const attacker = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!attacker) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (attacker.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法挑战封神台', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (attacker.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁，无法挑战封神台', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 双方 pvp_mode 必须为 active
            if (attacker.pvp_mode !== 'active') {
                await t.commit();
                throw new AppError('当前处于避世状态，无法参与封神台挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 挑战者排名记录校验
            const attackerRanking = await FengshenRanking.findOne({
                where: { player_id: playerId },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!attackerRanking || !attackerRanking.defense_config) {
                await t.commit();
                throw new AppError('请先设置防守阵容方可挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 跨日重置每日次数
            this._resetDailyCountersIfNewDay(attackerRanking);

            // 每日挑战次数校验
            const dailyLimit = cfg.daily_challenge_limit || 5;
            if (attackerRanking.daily_challenge_count >= dailyLimit) {
                await t.commit();
                throw new AppError(`今日封神台挑战次数已达上限（${dailyLimit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 排名范围校验：只能挑战比自己高 1~challenge_rank_range 名的玩家
            const myRank = attackerRanking.rank;
            if (myRank <= 0) {
                await t.commit();
                throw new AppError('排名数据异常，请重新设置防守阵容', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const range = cfg.challenge_rank_range || 5;
            const minTargetRank = Math.max(1, myRank - range);
            const maxTargetRank = myRank - 1;  // 目标排名必须比自己高（排名数字更小）
            if (maxTargetRank < 1) {
                await t.commit();
                throw new AppError('您已位列榜首，无人可挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (targetRankNum < minTargetRank || targetRankNum > maxTargetRank) {
                await t.commit();
                throw new AppError(
                    `只能挑战排名比自己高 1~${range} 名的玩家（可挑战范围：${minTargetRank}~${maxTargetRank} 名）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // ===== 防守方校验 =====
            const defenderRanking = await FengshenRanking.findOne({
                where: { rank: targetRankNum },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!defenderRanking) {
                await t.commit();
                throw new AppError('目标排名不存在', 404, ErrorCodes.NOT_FOUND);
            }
            // 不可挑战自己
            if (Number(defenderRanking.player_id) === Number(playerId)) {
                await t.commit();
                throw new AppError('不可挑战自己', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 防守方必须已设置防守阵容
            if (!defenderRanking.defense_config) {
                await t.commit();
                throw new AppError('目标玩家尚未设置防守阵容', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const defender = await Player.findByPk(defenderRanking.player_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!defender) {
                await t.commit();
                throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            // 防守方 pvp_mode 必须为 active
            if (defender.pvp_mode !== 'active') {
                await t.commit();
                throw new AppError('目标玩家处于避世状态，无法被挑战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // ===== 战斗模拟 =====
            // 挑战者使用当前属性，防守方使用防守阵容快照
            const attackerPower = this._calculatePowerFromAttributes(attacker);
            const defenderPower = this._calculatePowerFromSnapshot(
                defenderRanking.defense_config.snapshot
            );
            const battleResult = this._simulateBattle(attackerPower, defenderPower);
            const attackerWins = battleResult.attackerWins;

            // ===== 积分变动计算 =====
            const scoreWinAttacker = cfg.score_win_attacker || 30;
            const scoreLoseAttacker = cfg.score_lose_attacker || 20;
            const scoreWinDefender = cfg.score_win_defender || 10;
            const scoreLoseDefender = cfg.score_lose_defender || 30;

            let attackerScoreChange = 0;
            let defenderScoreChange = 0;

            if (attackerWins) {
                // 挑战者胜：交换排名 + 积分变动
                attackerScoreChange = scoreWinAttacker;
                defenderScoreChange = -scoreLoseDefender;

                // 交换排名
                const tmpRank = attackerRanking.rank;
                attackerRanking.rank = defenderRanking.rank;
                defenderRanking.rank = tmpRank;

                // 胜负记录
                attackerRanking.total_wins = (attackerRanking.total_wins || 0) + 1;
                defenderRanking.total_losses = (defenderRanking.total_losses || 0) + 1;
            } else {
                // 挑战者败：不交换排名 + 积分变动
                attackerScoreChange = -scoreLoseAttacker;
                defenderScoreChange = scoreWinDefender;

                // 胜负记录
                attackerRanking.total_losses = (attackerRanking.total_losses || 0) + 1;
                defenderRanking.total_wins = (defenderRanking.total_wins || 0) + 1;
            }

            // 应用积分变动（下限为 0，防止负分）
            attackerRanking.fengshen_score = Math.max(0, attackerRanking.fengshen_score + attackerScoreChange);
            defenderRanking.fengshen_score = Math.max(0, defenderRanking.fengshen_score + defenderScoreChange);

            // 累加每日挑战次数
            attackerRanking.daily_challenge_count = (attackerRanking.daily_challenge_count || 0) + 1;
            const today = new Date().toISOString().slice(0, 10);
            attackerRanking.last_challenge_date = today;

            // 持久化
            await attackerRanking.save({ transaction: t });
            await defenderRanking.save({ transaction: t });

            await t.commit();

            // 大五行幻世轮：封神台挑战结算后双方自动积累悟印（未装备时静默返回）
            await Promise.all([
                ArtifactDeepLineService.safeAddInsightExp(attacker.id, {
                    battle_type: 'pvp',
                    is_win: attackerWins,
                    opponent_realm_rank: defender.realm_rank
                }),
                ArtifactDeepLineService.safeAddInsightExp(defender.id, {
                    battle_type: 'pvp',
                    is_win: !attackerWins,
                    opponent_realm_rank: attacker.realm_rank
                })
            ]);

            // 更新内存冷却时间
            this.lastChallengeTime.set(playerId, Date.now());

            // 异步推送：通知防守方被挑战结果
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(defenderRanking.player_id, 'fengshen_challenged', {
                    attacker_id: playerId,
                    attacker_nickname: attacker.nickname,
                    result: attackerWins ? 'defender_lost' : 'defender_won',
                    score_change: defenderScoreChange,
                    new_rank: defenderRanking.rank,
                    new_score: defenderRanking.fengshen_score
                });
            } catch (e) { /* 推送失败不阻塞主流程 */ }

            return {
                battle_result: {
                    attacker_wins: attackerWins,
                    attacker_power: attackerPower,
                    defender_power: defenderPower,
                    attacker_score_change: attackerScoreChange,
                    defender_score_change: defenderScoreChange,
                    battle_log: battleResult.log
                },
                my_rank: attackerRanking.rank,
                my_score: attackerRanking.fengshen_score,
                defender_id: defenderRanking.player_id,
                defender_nickname: defender.nickname,
                defender_rank: defenderRanking.rank,
                defender_score: defenderRanking.fengshen_score,
                daily_challenge_count: attackerRanking.daily_challenge_count,
                daily_challenge_remaining: Math.max(0, (cfg.daily_challenge_limit || 5) - attackerRanking.daily_challenge_count)
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 获取自己的封神台信息
     * 返回排名、封神积分、胜负记录、今日挑战次数、防守阵容状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 封神台个人信息
     */
    async getMyRanking(playerId) {
        const cfg = this.getFengshenConfig();
        const dailyLimit = cfg.daily_challenge_limit || 5;

        const ranking = await FengshenRanking.findOne({
            where: { player_id: playerId }
        });

        if (!ranking) {
            // 无排名记录：返回默认值
            return {
                rank: 0,
                fengshen_score: 0,
                total_wins: 0,
                total_losses: 0,
                win_rate: 0,
                daily_challenge_count: 0,
                daily_challenge_remaining: dailyLimit,
                defense_set: false,
                defense_set_at: null,
                season: await this._getCurrentSeason()
            };
        }

        // 跨日重置展示（仅内存层面，不持久化；持久化由下次 challenge 触发）
        const today = new Date().toISOString().slice(0, 10);
        const lastDate = ranking.last_challenge_date
            ? new Date(ranking.last_challenge_date).toISOString().slice(0, 10)
            : null;
        const dailyCount = (lastDate === today) ? (ranking.daily_challenge_count || 0) : 0;

        // 计算胜率
        const totalBattles = (ranking.total_wins || 0) + (ranking.total_losses || 0);
        const winRate = totalBattles > 0
            ? parseFloat(((ranking.total_wins / totalBattles) * 100).toFixed(1))
            : 0;

        return {
            rank: ranking.rank,
            fengshen_score: ranking.fengshen_score,
            total_wins: ranking.total_wins,
            total_losses: ranking.total_losses,
            win_rate: winRate,
            daily_challenge_count: dailyCount,
            daily_challenge_remaining: Math.max(0, dailyLimit - dailyCount),
            defense_set: !!ranking.defense_config,
            defense_set_at: ranking.defense_set_at,
            season: ranking.season
        };
    }

    /**
     * 获取自己的防守阵容
     * 返回前端传入的防守配置和属性快照
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 防守阵容信息
     */
    async getDefense(playerId) {
        const ranking = await FengshenRanking.findOne({
            where: { player_id: playerId }
        });

        if (!ranking || !ranking.defense_config) {
            return {
                has_defense: false,
                defense_config: null,
                snapshot: null,
                defense_set_at: null
            };
        }

        return {
            has_defense: true,
            defense_config: ranking.defense_config.config || {},
            snapshot: ranking.defense_config.snapshot || {},
            defense_set_at: ranking.defense_set_at
        };
    }

    /**
     * 获取赛季信息
     * 返回当前赛季编号、赛季开始/结束时间、剩余天数、奖励规则
     * 赛季开始时间取当前赛季最早记录的 created_at，无记录则视为当前时间
     * @returns {Promise<Object>} 赛季信息
     */
    async getSeasonInfo() {
        const cfg = this.getFengshenConfig();
        const seasonDurationDays = cfg.season_duration_days || 30;

        const currentSeason = await this._getCurrentSeason();

        // 查询当前赛季最早创建的记录，作为赛季开始时间
        const earliestRecord = await FengshenRanking.findOne({
            where: { season: currentSeason },
            order: [['created_at', 'ASC']],
            attributes: ['created_at']
        });

        const now = new Date();
        let seasonStart;
        if (earliestRecord && earliestRecord.created_at) {
            seasonStart = new Date(earliestRecord.created_at);
        } else {
            // 无记录，赛季开始时间视为当前
            seasonStart = now;
        }

        // 计算赛季结束时间和剩余天数
        const seasonEnd = new Date(seasonStart.getTime() + seasonDurationDays * 24 * 60 * 60 * 1000);
        const remainingDays = Math.max(0, Math.ceil((seasonEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));

        return {
            current_season: currentSeason,
            season_start: seasonStart.toISOString(),
            season_end: seasonEnd.toISOString(),
            remaining_days: remainingDays,
            season_duration_days: seasonDurationDays,
            reward_enabled: cfg.top_rank_reward_enabled !== false,
            top_ranks: cfg.top_ranks || [1, 2, 3],
            rank_reward_honor: cfg.rank_reward_honor || [500, 300, 150],
            rank_reward_stones: cfg.rank_reward_stones || [5000, 3000, 1500]
        };
    }

    /**
     * 赛季结算（GM 调用或定时任务）
     * 流程：
     * 1. 按 fengshen_score 排序确定最终排名
     * 2. 发放排名奖励（top_ranks 对应 honor 和 stones）
     * 3. 重置所有玩家积分为 base_score
     * 4. 递增赛季编号
     * 5. 重新计算排名
     * @returns {Promise<Object>} 结算结果 { settled, old_season, new_season, total_players, rewards }
     */
    async settleSeason() {
        const cfg = this.getFengshenConfig();
        const baseScore = cfg.base_score || 1000;
        const currentSeason = await this._getCurrentSeason();
        const newSeason = currentSeason + 1;

        const t = await sequelize.transaction();
        try {
            // 查询所有排名记录，按积分降序确定最终排名
            const rankings = await FengshenRanking.findAll({
                order: [
                    ['fengshen_score', 'DESC'],
                    ['total_wins', 'DESC'],
                    ['created_at', 'ASC']
                ],
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            const rewards = [];

            // 发放排名奖励
            if (cfg.top_rank_reward_enabled !== false) {
                const topRanks = cfg.top_ranks || [1, 2, 3];
                const honorRewards = cfg.rank_reward_honor || [500, 300, 150];
                const stoneRewards = cfg.rank_reward_stones || [5000, 3000, 1500];

                for (let i = 0; i < topRanks.length && i < rankings.length; i++) {
                    const ranking = rankings[i];
                    const honorGain = honorRewards[i] || 0;
                    const stoneGain = stoneRewards[i] || 0;

                    if (honorGain <= 0 && stoneGain <= 0) continue;

                    // 获取玩家并发放奖励
                    const player = await Player.findByPk(ranking.player_id, {
                        lock: t.LOCK.UPDATE,
                        transaction: t
                    });

                    if (player) {
                        // BigInt 安全累加荣誉值和灵石
                        if (honorGain > 0) {
                            player.honor = safeBigInt(player.honor) + BigInt(honorGain);
                        }
                        if (stoneGain > 0) {
                            player.spirit_stones = safeBigInt(player.spirit_stones) + BigInt(stoneGain);
                        }
                        await player.save({ transaction: t });
                    }

                    rewards.push({
                        rank: topRanks[i],
                        player_id: ranking.player_id,
                        honor_gain: honorGain,
                        spirit_stones_gain: stoneGain
                    });
                }
            }

            // 重置所有玩家积分、排名、赛季编号、每日次数
            for (const ranking of rankings) {
                ranking.fengshen_score = baseScore;
                ranking.rank = 0;  // 待排名重算分配
                ranking.season = newSeason;
                ranking.daily_challenge_count = 0;
                ranking.daily_defend_count = 0;
                ranking.last_challenge_date = null;
                await ranking.save({ transaction: t });
            }

            // 重新计算排名（基于重置后的 base_score，按 created_at 排序）
            await this._recalculateRanks(t);

            // 记录审计日志
            try {
                const AdminLog = require('../../models/admin_log');
                await AdminLog.create({
                    admin_id: 0,  // 系统自动结算，无 GM 操作人
                    action: 'fengshen_season_settle',
                    target_id: currentSeason,
                    details: JSON.stringify({
                        old_season: currentSeason,
                        new_season: newSeason,
                        total_players: rankings.length,
                        rewards_distributed: rewards.length,
                        rewards_detail: rewards
                    }),
                    ip: null
                }, { transaction: t });
            } catch (e) { /* 审计日志失败不阻塞主流程 */ }

            await t.commit();

            // 清空内存冷却追踪（新赛季重置）
            this.lastChallengeTime.clear();

            return {
                settled: true,
                old_season: currentSeason,
                new_season: newSeason,
                total_players: rankings.length,
                rewards
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }
}

// 导出单例实例（符合任务要求的 module.exports = new FengshenService()）
module.exports = new FengshenService();
