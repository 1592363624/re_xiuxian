/**
 * 灵兽PVP竞技场服务
 *
 * 实现玩法文档第8节"灵兽PVP对战"和第9节"战斗与风险"：
 *   - 玩家选择自己的灵兽 + 战术，挑战其他玩家的出战灵兽
 *   - 自动回合制战斗（最多20回合），按速度决定先后手
 *   - 元素相克影响伤害（强克制1.5x / 弱克制0.75x）
 *   - 押注灵石（100-10000），赢家拿走双方押注
 *   - 赛季段位制（青铜→白银→黄金→铂金→钻石→王者），28天一季
 *   - 胜点规则：胜+10 / 负-5（青铜保护）/ 王者额外+15
 *   - 每日首胜额外奖励200灵石
 *
 * 核心设计：
 *   1. 战斗引擎 _executeBattle：自动回合制，含暴击/闪避/元素克制/战术倍率/反击
 *   2. 段位系统 _calculateTier：6段位，胜点决定段位
 *   3. 赛季系统：自动结算，按段位+排名发放奖励
 *   4. 防作弊：同主魂IP校验、同对手冷却、每日次数限制
 *   5. 事务+行级锁：押注/胜点/战绩更新使用事务+LOCK.UPDATE
 *
 * 单例导出：module.exports = new SpiritBeastPvpService()
 */
'use strict';

const { Op } = require('sequelize');
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const SpiritBeast = require('../../models/spiritBeast');
const SpiritBeastPvpMatch = require('../../models/spiritBeastPvpMatch');
const SpiritBeastPvpSeason = require('../../models/spiritBeastPvpSeason');
const SpiritBeastPvpRanking = require('../../models/spiritBeastPvpRanking');
// 大五行幻世轮服务（同目录引用，用于战斗结算后被动积累悟印）
const ArtifactDeepLineService = require('./ArtifactDeepLineService');

class SpiritBeastPvpService {
    constructor() {
        this.config = null;
        this.initialized = false;
    }

    /**
     * 初始化服务
     * @param {object} configLoader - ConfigLoader 实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        this.config = configLoader.getConfig('spirit_beast_pvp_data')?.spirit_beast_pvp;
        if (!this.config) {
            throw new Error('灵兽PVP配置未加载，请检查 spirit_beast_pvp_data.json');
        }
        this.initialized = true;
        console.log('[SpiritBeastPvpService] 灵兽PVP竞技场服务初始化完成');
    }

    // ==================== 玩家接口 ====================

    /**
     * 获取玩家PVP档案（段位/胜点/战绩/今日挑战次数）
     * @param {object} player - 玩家对象（来自 auth 中间件）
     * @returns {object} PVP档案
     */
    async getProfile(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        // 获取当前赛季
        const season = await this._getActiveSeason();
        if (!season) {
            return { data: { season: null, ranking: null, message: '当前无进行中的赛季' } };
        }

        // 获取或创建排行记录
        const ranking = await this._getOrCreateRanking(player, season.id);
        // 检查每日重置
        await this._checkDailyReset(ranking);

        const tierInfo = this._getTierInfo(ranking.ranking_points);

        return {
            data: {
                season: {
                    id: season.id,
                    name: season.season_name,
                    start_time: season.start_time,
                    end_time: season.end_time,
                    days_remaining: Math.ceil((new Date(season.end_time) - Date.now()) / (24 * 3600 * 1000))
                },
                ranking: {
                    tier: tierInfo.key,
                    tier_name: tierInfo.name,
                    tier_color: tierInfo.color,
                    ranking_points: ranking.ranking_points,
                    total_wins: ranking.total_wins,
                    total_losses: ranking.total_losses,
                    total_draws: ranking.total_draws,
                    total_matches: ranking.total_matches,
                    win_rate: Number(ranking.win_rate),
                    daily_challenge_count: ranking.daily_challenge_count,
                    daily_challenge_limit: this.config.challenge.daily_challenge_limit,
                    daily_first_win_claimed: ranking.daily_first_win_claimed,
                    total_bet_won: ranking.total_bet_won.toString(),
                    total_bet_lost: ranking.total_bet_lost.toString(),
                    next_tier: tierInfo.next_tier
                }
            }
        };
    }

    /**
     * 获取赛季排行榜
     * @param {object} player - 玩家对象
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object} 排行榜列表
     */
    async getRanking(player, page = 1, pageSize = 20) {
        if (!this.initialized) throw new Error('服务未初始化');

        const season = await this._getActiveSeason();
        if (!season) {
            return { data: { rankings: [], total: 0, message: '当前无进行中的赛季' } };
        }

        const offset = (page - 1) * pageSize;
        const { rows, count } = await SpiritBeastPvpRanking.findAndCountAll({
            where: { season_id: season.id, total_matches: { [Op.gt]: 0 } },
            order: [['ranking_points', 'DESC'], ['total_wins', 'DESC'], ['created_at', 'ASC']],
            offset,
            limit: pageSize
        });

        const rankings = rows.map((r, idx) => {
            const tierInfo = this._getTierInfo(r.ranking_points);
            return {
                rank: offset + idx + 1,
                player_id: r.player_id,
                player_nickname: r.player_nickname_snapshot,
                tier: tierInfo.key,
                tier_name: tierInfo.name,
                tier_color: tierInfo.color,
                ranking_points: r.ranking_points,
                total_wins: r.total_wins,
                total_losses: r.total_losses,
                total_matches: r.total_matches,
                win_rate: Number(r.win_rate)
            };
        });

        return {
            data: {
                rankings,
                total: count,
                current_page: page,
                total_pages: Math.ceil(count / pageSize),
                my_rank: await this._getPlayerRank(player.id, season.id)
            }
        };
    }

    /**
     * 获取对局历史
     * @param {object} player - 玩家对象
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object} 对局历史列表
     */
    async getHistory(player, page = 1, pageSize = 10) {
        if (!this.initialized) throw new Error('服务未初始化');

        const offset = (page - 1) * pageSize;
        const { rows, count } = await SpiritBeastPvpMatch.findAndCountAll({
            where: {
                [Op.or]: [
                    { challenger_player_id: player.id },
                    { defender_player_id: player.id }
                ],
                status: 'finished'
            },
            order: [['created_at', 'DESC']],
            offset,
            limit: pageSize
        });

        const history = rows.map(m => ({
            match_id: m.id,
            created_at: m.createdAt,  // 时间戳属性名为 camelCase
            finished_at: m.finished_at,  // 自定义字段保持 snake_case
            role: m.challenger_player_id === player.id ? 'challenger' : 'defender',
            opponent_id: m.challenger_player_id === player.id ? m.defender_player_id : m.challenger_player_id,
            opponent_beast_name: m.challenger_player_id === player.id
                ? m.defender_beast_snapshot?.beast_name
                : m.challenger_beast_snapshot?.beast_name,
            my_beast_name: m.challenger_player_id === player.id
                ? m.challenger_beast_snapshot?.beast_name
                : m.defender_beast_snapshot?.beast_name,
            my_tactic: m.challenger_player_id === player.id ? m.challenger_tactic : m.defender_tactic,
            opponent_tactic: m.challenger_player_id === player.id ? m.defender_tactic : m.challenger_tactic,
            bet_spirit_stones: m.bet_spirit_stones.toString(),
            is_friendly: m.is_friendly,
            result: m.winner_player_id === player.id ? 'win'
                : (m.winner_side === 'draw' ? 'draw' : 'lose'),
            total_rounds: m.total_rounds,
            points_change: m.points_change
        }));

        return {
            data: {
                history,
                total: count,
                current_page: page,
                total_pages: Math.ceil(count / pageSize)
            }
        };
    }

    /**
     * 获取当前赛季信息
     * @returns {object} 赛季信息
     */
    async getSeasonInfo() {
        if (!this.initialized) throw new Error('服务未初始化');

        const season = await this._getActiveSeason();
        if (!season) {
            return { data: { season: null, message: '当前无进行中的赛季' } };
        }

        // 统计参与人数
        const participantCount = await SpiritBeastPvpRanking.count({
            where: { season_id: season.id, total_matches: { [Op.gt]: 0 } }
        });

        return {
            data: {
                season: {
                    id: season.id,
                    name: season.season_name,
                    start_time: season.start_time,
                    end_time: season.end_time,
                    status: season.status,
                    days_remaining: Math.ceil((new Date(season.end_time) - Date.now()) / (24 * 3600 * 1000)),
                    participants: participantCount
                },
                tiers: this.config.tiers.map(t => ({
                    key: t.key,
                    name: t.name,
                    min_points: t.min_points,
                    color: t.color,
                    season_reward: t.season_reward_spirit_stones
                }))
            }
        };
    }

    /**
     * 发起挑战（核心接口）
     * @param {object} player - 挑战方玩家对象
     * @param {number} targetPlayerId - 目标玩家ID
     * @param {number} beastId - 挑战方灵兽ID
     * @param {string} tactic - 战术：all_out/balanced/counter
     * @param {number} betStones - 押注灵石（0=友谊赛）
     * @param {boolean} isFriendly - 是否友谊赛
     * @returns {object} 对局结果
     */
    async challenge(player, targetPlayerId, beastId, tactic = 'balanced', betStones = 0, isFriendly = false) {
        if (!this.initialized) throw new Error('服务未初始化');

        // ===== 1. 参数校验 =====
        if (!targetPlayerId || targetPlayerId === player.id) {
            return { success: false, message: '目标玩家无效或不能挑战自己' };
        }
        if (!['all_out', 'balanced', 'counter'].includes(tactic)) {
            return { success: false, message: '战术无效，可选：all_out全力一击 / balanced稳健输出 / counter防御反击' };
        }
        if (isFriendly) {
            betStones = 0;
        } else {
            const minBet = Number(this.config.bet.min_spirit_stones);
            const maxBet = Number(this.config.bet.max_spirit_stones);
            if (betStones < minBet || betStones > maxBet) {
                return { success: false, message: `押注灵石必须在 ${minBet}-${maxBet} 之间` };
            }
        }

        // ===== 2. 获取赛季 =====
        const season = await this._getActiveSeason();
        if (!season) {
            return { success: false, message: '当前无进行中的赛季' };
        }

        // ===== 3. 校验挑战方资格（下面这些无锁预读只用于快速失败；真正结算前会在锁内重判）=====
        let challengerRanking = await this._getOrCreateRanking(player, season.id);
        await this._checkDailyReset(challengerRanking);

        // 每日挑战次数
        if (challengerRanking.daily_challenge_count >= this.config.challenge.daily_challenge_limit) {
            return { success: false, message: `今日挑战次数已用完（${this.config.challenge.daily_challenge_limit}次/天）` };
        }

        // 获取挑战方灵兽
        const challengerBeast = await SpiritBeast.findOne({
            where: { id: beastId, player_id: player.id }
        });
        if (!challengerBeast) {
            return { success: false, message: '灵兽不存在或不属于你' };
        }
        const beastCheck = this._checkBeastEligibility(challengerBeast);
        if (!beastCheck.ok) {
            return { success: false, message: beastCheck.reason };
        }

        // ===== 4. 校验目标玩家和灵兽 =====
        const targetPlayer = await Player.findByPk(targetPlayerId);
        if (!targetPlayer || targetPlayer.is_dead || targetPlayer.is_banned) {
            return { success: false, message: '目标玩家不存在或已死亡/封禁' };
        }

        // 同主魂校验
        if (player.ip_address && targetPlayer.ip_address &&
            player.ip_address === targetPlayer.ip_address) {
            return { success: false, message: '不能挑战同主魂玩家（IP相同）' };
        }

        // 同对手冷却（注意：模型 underscored:true，属性名仍为 camelCase）
        const cooldownSec = Number(this.config.challenge.same_opponent_cooldown_sec);
        const recentMatch = await SpiritBeastPvpMatch.findOne({
            where: {
                [Op.or]: [
                    { challenger_player_id: player.id, defender_player_id: targetPlayerId },
                    { challenger_player_id: targetPlayerId, defender_player_id: player.id }
                ],
                createdAt: { [Op.gte]: new Date(Date.now() - cooldownSec * 1000) }
            },
            order: [['createdAt', 'DESC']]
        });
        if (recentMatch) {
            const remainingSec = Math.ceil((new Date(recentMatch.createdAt).getTime() + cooldownSec * 1000 - Date.now()) / 1000);
            return { success: false, message: `与该对手冷却中，剩余 ${remainingSec} 秒` };
        }

        // 获取防守方出战灵兽
        const defenderBeast = await SpiritBeast.findOne({
            where: { player_id: targetPlayerId, is_active: true }
        });
        if (!defenderBeast) {
            return { success: false, message: '对手当前没有出战灵兽' };
        }
        const defenderBeastCheck = this._checkBeastEligibility(defenderBeast);
        if (!defenderBeastCheck.ok) {
            return { success: false, message: `对手灵兽不满足参战条件：${defenderBeastCheck.reason}` };
        }

        // ===== 5. 校验押注 =====
        if (!isFriendly && betStones > 0) {
            // 挑战方押注
            const challengerStones = BigInt(player.spirit_stones || 0);
            if (challengerStones < BigInt(betStones)) {
                return { success: false, message: '灵石不足，无法押注' };
            }
            // 防守方也需匹配押注
            const defenderStones = BigInt(targetPlayer.spirit_stones || 0);
            if (defenderStones < BigInt(betStones)) {
                return { success: false, message: '对手灵石不足，无法匹配押注' };
            }
        }

        // ===== 6. 执行战斗 =====
        const challengerSnapshot = this._createBeastSnapshot(challengerBeast);
        const defenderSnapshot = this._createBeastSnapshot(defenderBeast);

        const battleResult = this._executeBattle(
            challengerSnapshot,
            defenderSnapshot,
            tactic,
            'balanced', // 防守方默认稳健输出
            challengerBeast.element,
            defenderBeast.element
        );

        // ===== 7. 事务结算 =====
        const transaction = await sequelize.transaction();
        try {
            // 两把锁一次按 id 升序取齐。"先挑战者后防守者"是**调用方顺序**：
            // 甲乙互相挑战时两笔各持自己那侧、再伸手要对方的行 = ABBA 死锁（赛季结算按名次锁玩家是同一个坑）。
            const lockedPlayers = await this._lockPlayersByIdAsc(transaction, [player.id, targetPlayerId]);
            const challengerLocked = lockedPlayers.find(p => Number(p.id) === Number(player.id)) || null;
            const defenderLocked = lockedPlayers.find(p => Number(p.id) === Number(targetPlayerId)) || null;

            // ===== 锁住之后把"这一仗到底能不能打"重判一遍（上面那些无锁预读只用来快速失败）=====
            // 不重判的实际后果（scripts/smoke_beast_pvp_battle.js 量化过）：
            //   A 只有 100 灵石，同时对两个**不同**对手各押 100（同对手冷却拦不住不同对手），
            //   两笔的余额校验都读自己那份无锁快照 → 同一份灵石押两次，A 余额被扣成 -100；
            //   daily_challenge_count 同理是整块行上的 read-modify-write，10 次/天的上限形同虚设。
            const reject = async (message) => {
                if (!transaction.finished) await transaction.rollback();
                return { success: false, message };
            };
            if (!challengerLocked || !defenderLocked) {
                return await reject('玩家状态已变化，请稍后重试');
            }
            if (challengerLocked.is_dead || challengerLocked.is_banned
                || defenderLocked.is_dead || defenderLocked.is_banned) {
                return await reject('对局双方有一方当前不可应战');
            }
            if (!isFriendly) {
                if (BigInt(challengerLocked.spirit_stones || 0) < BigInt(betStones)) {
                    return await reject('灵石不足，无法押注');
                }
                if (BigInt(defenderLocked.spirit_stones || 0) < BigInt(betStones)) {
                    return await reject('对手灵石不足，无法匹配押注');
                }
            }
            await this._ensureRanking(player, season.id, transaction);
            await this._ensureRanking(defenderLocked, season.id, transaction);
            const lockedRankings = await this._lockRankingsByIdAsc(transaction, season.id, [player.id, targetPlayerId]);
            const challengerRankingLocked = lockedRankings.find(r => Number(r.player_id) === Number(player.id)) || null;
            const defenderRankingLocked = lockedRankings.find(r => Number(r.player_id) === Number(targetPlayerId)) || null;
            if (!challengerRankingLocked || !defenderRankingLocked) {
                return await reject('排名记录建立中，请稍后重试');
            }
            await this._checkDailyReset(challengerRankingLocked, transaction);
            if (challengerRankingLocked.daily_challenge_count >= Number(this.config.challenge.daily_challenge_limit)) {
                return await reject(`今日挑战次数已用完（${this.config.challenge.daily_challenge_limit}次/天）`);
            }
            // 下面整段结算都用锁到的那一份，别再拿无锁预读改出来的值往回写
            challengerRanking = challengerRankingLocked;

            let winnerId = null;
            let winnerSide = null;
            let pointsChange = 0;
            let betWon = BigInt(0);
            let betLost = BigInt(0);

            if (battleResult.winner === 'challenger') {
                winnerId = player.id;
                winnerSide = 'challenger';
                if (!isFriendly) {
                    // 挑战方赢，拿走双方押注
                    betWon = BigInt(betStones) * 2n;
                    betLost = BigInt(0);
                    // 扣除灵石
                    challengerLocked.spirit_stones = BigInt(challengerLocked.spirit_stones || 0) - BigInt(betStones) + betWon;
                    defenderLocked.spirit_stones = BigInt(defenderLocked.spirit_stones || 0) - BigInt(betStones);
                    await challengerLocked.save({ transaction, silent: true });
                    await defenderLocked.save({ transaction, silent: true });
                }
                if (!isFriendly) {
                    pointsChange = this._calculatePointsChange(challengerRanking, true, false);
                }
            } else if (battleResult.winner === 'defender') {
                winnerId = targetPlayerId;
                winnerSide = 'defender';
                if (!isFriendly) {
                    betWon = BigInt(0);
                    betLost = BigInt(betStones);
                    // 双方各下一注，赢家拿走整池（2×bet）。原来这里只扣了挑战方那一注、
                    // 却给防守方发 2 注 → 每输一次就凭空印出 betStones 灵石
                    // （smoke_beast_pvp_battle B7 实测：三人 300 灵石两局之后变 500）。
                    challengerLocked.spirit_stones = BigInt(challengerLocked.spirit_stones || 0) - BigInt(betStones);
                    defenderLocked.spirit_stones = BigInt(defenderLocked.spirit_stones || 0) - BigInt(betStones) + BigInt(betStones) * 2n;
                    await challengerLocked.save({ transaction, silent: true });
                    await defenderLocked.save({ transaction, silent: true });
                }
                if (!isFriendly) {
                    pointsChange = this._calculatePointsChange(challengerRanking, false, false);
                }
            } else {
                // 平局
                winnerSide = 'draw';
                if (!isFriendly) {
                    pointsChange = 0;
                }
            }

            // 创建对局记录
            const match = await SpiritBeastPvpMatch.create({
                season_id: season.id,
                challenger_player_id: player.id,
                challenger_beast_id: beastId,
                challenger_beast_snapshot: challengerSnapshot,
                challenger_tactic: tactic,
                defender_player_id: targetPlayerId,
                defender_beast_id: defenderBeast.id,
                defender_beast_snapshot: defenderSnapshot,
                defender_tactic: 'balanced',
                bet_spirit_stones: betStones,
                is_friendly: isFriendly,
                status: 'finished',
                winner_player_id: winnerId,
                winner_side: winnerSide,
                total_rounds: battleResult.total_rounds,
                final_challenger_hp: battleResult.final_challenger_hp,
                final_defender_hp: battleResult.final_defender_hp,
                battle_log: battleResult.log,
                points_change: pointsChange,
                finished_at: new Date()
            }, { transaction });

            // 更新挑战方排行（仅非友谊赛）
            if (!isFriendly) {
                const isWin = winnerSide === 'challenger';
                const isDraw = winnerSide === 'draw';
                challengerRanking.ranking_points = Math.max(0, challengerRanking.ranking_points + pointsChange);
                challengerRanking.total_matches += 1;
                if (isWin) challengerRanking.total_wins += 1;
                else if (isDraw) challengerRanking.total_draws += 1;
                else challengerRanking.total_losses += 1;
                challengerRanking.win_rate = Number((challengerRanking.total_wins / challengerRanking.total_matches * 100).toFixed(2));
                challengerRanking.total_bet_won = BigInt(challengerRanking.total_bet_won || 0) + betWon;
                challengerRanking.total_bet_lost = BigInt(challengerRanking.total_bet_lost || 0) + betLost;
                challengerRanking.tier = this._getTierInfo(challengerRanking.ranking_points).key;
                challengerRanking.daily_challenge_count += 1;

                // 每日首胜奖励
                let firstWinBonus = 0;
                if (isWin && !challengerRanking.daily_first_win_claimed) {
                    firstWinBonus = Number(this.config.rewards.daily_first_win_bonus);
                    challengerLocked.spirit_stones = BigInt(challengerLocked.spirit_stones || 0) + BigInt(firstWinBonus);
                    await challengerLocked.save({ transaction, silent: true });
                    challengerRanking.daily_first_win_claimed = true;
                }
                await challengerRanking.save({ transaction, silent: true });

                // 防守方排行：用上面一起锁到的那一份（原来这里又 `_getOrCreateRanking` 无锁读一遍，
                // 两笔并发对局会把 total_matches / win_rate 按旧快照盖回去）
                const defenderRanking = defenderRankingLocked;
                const defenderPointsChange = this._calculatePointsChange(defenderRanking, winnerSide === 'defender', winnerSide === 'draw');
                defenderRanking.ranking_points = Math.max(0, defenderRanking.ranking_points + defenderPointsChange);
                defenderRanking.total_matches += 1;
                if (winnerSide === 'defender') defenderRanking.total_wins += 1;
                else if (winnerSide === 'draw') defenderRanking.total_draws += 1;
                else defenderRanking.total_losses += 1;
                defenderRanking.win_rate = Number((defenderRanking.total_wins / defenderRanking.total_matches * 100).toFixed(2));
                defenderRanking.tier = this._getTierInfo(defenderRanking.ranking_points).key;
                await defenderRanking.save({ transaction, silent: true });

                // 更新灵兽经验/忠诚度
                const rewards = this.config.rewards;
                if (winnerSide === 'challenger') {
                    challengerBeast.exp = BigInt(challengerBeast.exp || 0) + BigInt(rewards.win_exp);
                    challengerBeast.loyalty = Math.min(100, challengerBeast.loyalty + rewards.win_loyalty);
                    defenderBeast.exp = BigInt(defenderBeast.exp || 0) + BigInt(rewards.lose_exp);
                    defenderBeast.loyalty = Math.max(0, defenderBeast.loyalty + rewards.lose_loyalty);
                } else if (winnerSide === 'defender') {
                    defenderBeast.exp = BigInt(defenderBeast.exp || 0) + BigInt(rewards.win_exp);
                    defenderBeast.loyalty = Math.min(100, defenderBeast.loyalty + rewards.win_loyalty);
                    challengerBeast.exp = BigInt(challengerBeast.exp || 0) + BigInt(rewards.lose_exp);
                    challengerBeast.loyalty = Math.max(0, challengerBeast.loyalty + rewards.lose_loyalty);
                }
                await challengerBeast.save({ transaction, silent: true });
                await defenderBeast.save({ transaction, silent: true });

                await transaction.commit();

                // 大五行幻世轮：灵兽PVP非友谊赛结算后双方自动积累悟印（未装备时静默返回）
                await Promise.all([
                    ArtifactDeepLineService.safeAddInsightExp(player.id, {
                        battle_type: 'pvp',
                        is_win: winnerSide === 'challenger',
                        opponent_realm_rank: targetPlayer.realm_rank
                    }),
                    ArtifactDeepLineService.safeAddInsightExp(targetPlayer.id, {
                        battle_type: 'pvp',
                        is_win: winnerSide === 'defender',
                        opponent_realm_rank: player.realm_rank
                    })
                ]);

                return {
                    data: {
                        match_id: match.id,
                        result: winnerSide === 'challenger' ? 'win' : (winnerSide === 'draw' ? 'draw' : 'lose'),
                        winner_side: winnerSide,
                        total_rounds: battleResult.total_rounds,
                        final_challenger_hp: battleResult.final_challenger_hp.toString(),
                        final_defender_hp: battleResult.final_defender_hp.toString(),
                        my_beast_name: challengerSnapshot.beast_name,
                        opponent_beast_name: defenderSnapshot.beast_name,
                        my_tactic: tactic,
                        opponent_tactic: 'balanced',
                        bet_spirit_stones: betStones.toString(),
                        bet_won: betWon.toString(),
                        bet_lost: betLost.toString(),
                        points_change: pointsChange,
                        first_win_bonus: firstWinBonus || 0,
                        ranking_points: challengerRanking.ranking_points,
                        tier: challengerRanking.tier,
                        battle_log: battleResult.log
                    }
                };
            }

            // 友谊赛：计入对局数/胜负/平局/胜率，但不影响段位/胜点/灵石/灵兽经验
            // 这样玩家可以通过友谊赛热身，同时排行榜仍以正式赛为主
            // 使用行级锁重新获取，避免并发更新丢失
            // 友谊赛同样用上面锁到的那两份（原来这里再 `_getOrCreateRanking` 读一遍无锁行，
            // 并发对局会把 total_matches/win_rate 按旧快照写回去）
            challengerRankingLocked.total_matches += 1;
            if (winnerSide === 'challenger') challengerRankingLocked.total_wins += 1;
            else if (winnerSide === 'draw') challengerRankingLocked.total_draws += 1;
            else challengerRankingLocked.total_losses += 1;
            challengerRankingLocked.win_rate = challengerRankingLocked.total_matches > 0
                ? Number((challengerRankingLocked.total_wins / challengerRankingLocked.total_matches * 100).toFixed(2))
                : 0;
            challengerRankingLocked.daily_challenge_count += 1;
            await challengerRankingLocked.save({ transaction, silent: true });

            // 同步更新防守方对局统计（友谊赛）
            const defenderRankingFriendly = await this._getOrCreateRanking(targetPlayer, season.id, transaction);
            defenderRankingFriendly.total_matches += 1;
            if (winnerSide === 'defender') defenderRankingFriendly.total_wins += 1;
            else if (winnerSide === 'draw') defenderRankingFriendly.total_draws += 1;
            else defenderRankingFriendly.total_losses += 1;
            defenderRankingFriendly.win_rate = defenderRankingFriendly.total_matches > 0
                ? Number((defenderRankingFriendly.total_wins / defenderRankingFriendly.total_matches * 100).toFixed(2))
                : 0;
            await defenderRankingFriendly.save({ transaction, silent: true });

            await transaction.commit();

            // 大五行幻世轮：灵兽PVP友谊赛切磋后双方自动积累悟印（未装备时静默返回）
            await Promise.all([
                ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pvp',
                    is_win: winnerSide === 'challenger',
                    opponent_realm_rank: targetPlayer.realm_rank
                }),
                ArtifactDeepLineService.safeAddInsightExp(targetPlayer.id, {
                    battle_type: 'pvp',
                    is_win: winnerSide === 'defender',
                    opponent_realm_rank: player.realm_rank
                })
            ]);

            return {
                data: {
                    match_id: match.id,
                    result: winnerSide === 'challenger' ? 'win' : (winnerSide === 'draw' ? 'draw' : 'lose'),
                    winner_side: winnerSide,
                    total_rounds: battleResult.total_rounds,
                    final_challenger_hp: battleResult.final_challenger_hp.toString(),
                    final_defender_hp: battleResult.final_defender_hp.toString(),
                    my_beast_name: challengerSnapshot.beast_name,
                    opponent_beast_name: defenderSnapshot.beast_name,
                    my_tactic: tactic,
                    opponent_tactic: 'balanced',
                    is_friendly: true,
                    bet_spirit_stones: '0',
                    bet_won: '0',
                    bet_lost: '0',
                    points_change: 0,
                    ranking_points: challengerRankingLocked.ranking_points,
                    tier: challengerRankingLocked.tier,
                    battle_log: battleResult.log
                }
            };
        } catch (err) {
            await transaction.rollback();
            console.error('[SpiritBeastPvpService] 挑战结算失败:', err);
            throw err;
        }
    }

    // ==================== 内部方法 ====================

    /**
     * 获取当前活跃赛季
     * @private
     */
    async _getActiveSeason() {
        return await SpiritBeastPvpSeason.findOne({
            where: { status: 'active', end_time: { [Op.gt]: new Date() } },
            order: [['id', 'DESC']]
        });
    }

    /**
     * 获取或创建玩家赛季排行记录
     * @private
     */
    async _getOrCreateRanking(player, seasonId, transaction = null) {
        const options = transaction ? { transaction } : {};
        let ranking = await SpiritBeastPvpRanking.findOne({
            where: { season_id: seasonId, player_id: player.id },
            ...options
        });
        if (!ranking) {
            ranking = await SpiritBeastPvpRanking.create({
                season_id: seasonId,
                player_id: player.id,
                player_nickname_snapshot: player.nickname || `玩家${player.id}`,
                tier: 'bronze',
                ranking_points: 0,
                daily_reset_at: new Date()
            }, options);
        }
        return ranking;
    }

    /**
     * 建排名行的"并发安全"版本：两笔并发各自 findOne→create 会撞 uk_pvp_season_player，
     * 第二笔直接以 SequelizeUniqueConstraintError 冒到玩家脸上（表现为 500）。
     * 撞键说明别人已经建好了，吞掉这一次冲突、后面按锁读拿到的那份即可。
     * @private
     */
    async _ensureRanking(player, seasonId, transaction) {
        try {
            await this._getOrCreateRanking(player, seasonId, transaction);
        } catch (error) {
            const dup = /unique|Validation error|ER_DUP/i.test(`${error.name || ''} ${error.message || ''}`);
            if (!dup) throw error;
        }
    }

    /**
     * 一次把本赛季这几名玩家的排名行按 player_id 升序锁齐。
     * 次序必须固定：与对局/赛季结算共用同一批行，两边各按自己的顺序锁就是 ABBA 死锁；
     * 而且 daily_challenge_count / total_matches 是 read-modify-write，不锁就会被并发对局盖回旧值。
     * @private
     */
    async _lockRankingsByIdAsc(t, seasonId, playerIds) {
        const unique = [...new Set((playerIds || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
        if (!unique.length) return [];
        return SpiritBeastPvpRanking.findAll({
            where: { season_id: seasonId, player_id: unique },
            order: [['player_id', 'ASC']],
            lock: t.LOCK.UPDATE,
            transaction: t
        });
    }

    /**
     * 检查灵兽参战资格
     * @private
     */
    _checkBeastEligibility(beast) {
        const elig = this.config.eligibility;
        if (beast.level < Number(elig.min_beast_level)) {
            return { ok: false, reason: `灵兽等级不足（需${elig.min_beast_level}级）` };
        }
        if (beast.loyalty < Number(elig.min_beast_loyalty)) {
            return { ok: false, reason: `灵兽忠诚度不足（需${elig.min_beast_loyalty}）` };
        }
        const hpRatio = Number(beast.hp_max) > 0 ? 1 : 1; // 灵兽HP是满的（无战斗HP消耗）
        return { ok: true };
    }

    /**
     * 创建灵兽快照（用于对局记录）
     * @private
     */
    _createBeastSnapshot(beast) {
        return {
            beast_id: beast.id,
            beast_key: beast.beast_key,
            beast_name: beast.beast_name || beast.beast_key,
            element: beast.element,
            rarity: beast.rarity,
            star_level: beast.star_level,
            level: beast.level,
            hp_max: beast.hp_max.toString(),
            atk: beast.atk,
            def: beast.def,
            speed: beast.speed,
            loyalty: beast.loyalty
        };
    }

    /**
     * 执行自动战斗
     * @param {object} challenger - 挑战方灵兽快照
     * @param {object} defender - 防守方灵兽快照
     * @param {string} challengerTactic - 挑战方战术
     * @param {string} defenderTactic - 防守方战术
     * @param {string} challengerElement - 挑战方元素
     * @param {string} defenderElement - 防守方元素
     * @returns {object} 战斗结果
     * @private
     */
    _executeBattle(challenger, defender, challengerTactic, defenderTactic, challengerElement, defenderElement) {
        const combat = this.config.combat;
        const maxRounds = Number(combat.max_rounds);

        // 初始化HP
        let challengerHp = BigInt(challenger.hp_max);
        let defenderHp = BigInt(defender.hp_max);

        // 获取战术配置
        const cTactic = this.config.tactics.options[challengerTactic];
        const dTactic = this.config.tactics.options[defenderTactic];

        // 元素克制倍率
        const elementMultiplier = this._getElementMultiplier(challengerElement, defenderElement);
        const reverseElementMultiplier = this._getElementMultiplier(defenderElement, challengerElement);

        // 速度决定先后手
        let challengerFirst = defender.speed >= challenger.speed ? false : true;

        const log = [];
        let winner = null;

        for (let round = 1; round <= maxRounds; round++) {
            const roundLog = { round, events: [] };
            let challengerHpBefore = challengerHp;
            let defenderHpBefore = defenderHp;

            // 先手攻击
            if (challengerFirst) {
                const atkResult = this._calculateAttack(challenger, defender, cTactic, dTactic, elementMultiplier, combat);
                defenderHp -= atkResult.damage;
                roundLog.events.push({ attacker: 'challenger', damage: atkResult.damage.toString(), ...atkResult.flags });

                // 反击检查
                if (defenderHp > 0n && atkResult.flags.counter_triggered) {
                    const counterDmg = BigInt(Math.floor(Number(atkResult.damage) * dTactic.counter_damage_ratio));
                    challengerHp -= counterDmg;
                    roundLog.events.push({ attacker: 'defender', damage: counterDmg.toString(), type: 'counter' });
                }
            } else {
                const atkResult = this._calculateAttack(defender, challenger, dTactic, cTactic, reverseElementMultiplier, combat);
                challengerHp -= atkResult.damage;
                roundLog.events.push({ attacker: 'defender', damage: atkResult.damage.toString(), ...atkResult.flags });

                if (challengerHp > 0n && atkResult.flags.counter_triggered) {
                    const counterDmg = BigInt(Math.floor(Number(atkResult.damage) * cTactic.counter_damage_ratio));
                    defenderHp -= counterDmg;
                    roundLog.events.push({ attacker: 'challenger', damage: counterDmg.toString(), type: 'counter' });
                }
            }

            // 后手攻击（如果先手方未击倒对方）
            if (challengerHp > 0n && defenderHp > 0n) {
                if (challengerFirst) {
                    const atkResult = this._calculateAttack(defender, challenger, dTactic, cTactic, reverseElementMultiplier, combat);
                    challengerHp -= atkResult.damage;
                    roundLog.events.push({ attacker: 'defender', damage: atkResult.damage.toString(), ...atkResult.flags });

                    if (defenderHp > 0n && atkResult.flags.counter_triggered) {
                        const counterDmg = BigInt(Math.floor(Number(atkResult.damage) * cTactic.counter_damage_ratio));
                        defenderHp -= counterDmg;
                        roundLog.events.push({ attacker: 'challenger', damage: counterDmg.toString(), type: 'counter' });
                    }
                } else {
                    const atkResult = this._calculateAttack(challenger, defender, cTactic, dTactic, elementMultiplier, combat);
                    defenderHp -= atkResult.damage;
                    roundLog.events.push({ attacker: 'challenger', damage: atkResult.damage.toString(), ...atkResult.flags });

                    if (challengerHp > 0n && atkResult.flags.counter_triggered) {
                        const counterDmg = BigInt(Math.floor(Number(atkResult.damage) * dTactic.counter_damage_ratio));
                        challengerHp -= counterDmg;
                        roundLog.events.push({ attacker: 'defender', damage: counterDmg.toString(), type: 'counter' });
                    }
                }
            }

            challengerHp = challengerHp < 0n ? 0n : challengerHp;
            defenderHp = defenderHp < 0n ? 0n : defenderHp;
            roundLog.challenger_hp_after = challengerHp.toString();
            roundLog.defender_hp_after = defenderHp.toString();

            // 关键回合记录（第1/5/10/15/20回合 + 击倒回合）
            if (round === 1 || round === 5 || round === 10 || round === 15 || round === maxRounds ||
                challengerHp === 0n || defenderHp === 0n) {
                log.push(roundLog);
            }

            // 判定胜负
            if (defenderHp === 0n && challengerHp > 0n) {
                winner = 'challenger';
                break;
            }
            if (challengerHp === 0n && defenderHp > 0n) {
                winner = 'defender';
                break;
            }
            if (challengerHp === 0n && defenderHp === 0n) {
                winner = 'draw';
                break;
            }
        }

        // 达到最大回合数，按HP比例判定
        if (!winner) {
            const cRatio = Number(challengerHp) / Number(challenger.hp_max);
            const dRatio = Number(defenderHp) / Number(defender.hp_max);
            if (cRatio > dRatio * 1.1) winner = 'challenger';
            else if (dRatio > cRatio * 1.1) winner = 'defender';
            else winner = 'draw';
        }

        return {
            winner,
            total_rounds: log.length > 0 ? log[log.length - 1].round : maxRounds,
            final_challenger_hp: challengerHp,
            final_defender_hp: defenderHp,
            log
        };
    }

    /**
     * 计算单次攻击伤害
     * @private
     */
    _calculateAttack(attacker, defender, atkTactic, defTactic, elementMult, combat) {
        // 基础攻击 = atk * 战术攻击倍率
        const baseAtk = Number(attacker.atk) * Number(atkTactic.atk_multiplier);
        // 基础防御 = def * 战术防御倍率
        const baseDef = Number(defender.def) * Number(defTactic.def_multiplier);
        // 元素克制
        const elementDamage = baseAtk * elementMult;
        // 净伤害 = max(1, 攻击 - 防御*0.5)
        let damage = Math.max(1, Math.floor(elementDamage - baseDef * 0.5));

        // 闪避检查
        const dodgeBase = Number(combat.dodge_chance_base);
        const dodgeSpeedFactor = Number(combat.dodge_chance_speed_factor);
        const dodgeMax = Number(combat.dodge_chance_max);
        const speedDiff = Number(defender.speed) - Number(attacker.speed);
        const dodgeChance = Math.min(dodgeMax, dodgeBase + Math.max(0, speedDiff) * dodgeSpeedFactor);
        if (Math.random() < dodgeChance) {
            return { damage: 0n, flags: { dodged: true, crit: false, counter_triggered: false, element_multiplier: elementMult } };
        }

        // 命中率检查（全力一击降低命中）
        const hitPenalty = Number(atkTactic.hit_penalty || 0);
        if (hitPenalty > 0 && Math.random() < hitPenalty) {
            return { damage: 0n, flags: { missed: true, crit: false, counter_triggered: false, element_multiplier: elementMult } };
        }

        // 暴击检查
        let crit = false;
        const critChance = Number(combat.crit_chance) + Number(atkTactic.crit_bonus || 0);
        if (Math.random() < critChance) {
            damage = Math.floor(damage * Number(combat.crit_multiplier));
            crit = true;
        }

        // 反击触发检查（仅防御反击战术）
        let counterTriggered = false;
        if (defTactic.counter_chance && Math.random() < Number(defTactic.counter_chance)) {
            counterTriggered = true;
        }

        return {
            damage: BigInt(damage),
            flags: { crit, dodged: false, missed: false, counter_triggered: counterTriggered, element_multiplier: elementMult }
        };
    }

    /**
     * 获取元素克制倍率
     * @private
     */
    _getElementMultiplier(attackerElement, defenderElement) {
        // 元素表走 ConfigLoader（合并视图），不再 require 配置文件：
        // require 一个 .json 会被 Node 永久缓存，资料片改的克制关系、热更后的新值都到不了这里。
        const beastData = this.configLoader?.getConfig('spirit_beast_data') || {};
        const elem = (beastData.elements || {})[attackerElement];
        if (!elem) return 1.0;
        if (elem.strong_against === defenderElement) {
            return Number(this.config.combat.element_strong_multiplier);
        }
        if (elem.weak_against === defenderElement) {
            return Number(this.config.combat.element_weak_multiplier);
        }
        return 1.0;
    }

    /**
     * 根据胜点计算段位
     * @private
     */
    _getTierInfo(points) {
        const tiers = this.config.tiers;
        let current = tiers[0];
        let nextTier = null;
        for (let i = 0; i < tiers.length; i++) {
            if (points >= Number(tiers[i].min_points) && points < Number(tiers[i].max_points)) {
                current = tiers[i];
                nextTier = i < tiers.length - 1 ? tiers[i + 1] : null;
                break;
            }
            if (points >= Number(tiers[i].max_points) && i === tiers.length - 1) {
                current = tiers[i];
                nextTier = null;
            }
        }
        return {
            key: current.key,
            name: current.name,
            color: current.color,
            season_reward: current.season_reward_spirit_stones,
            next_tier: nextTier ? {
                key: nextTier.key,
                name: nextTier.name,
                points_needed: Number(nextTier.min_points) - points
            } : null
        };
    }

    /**
     * 计算胜点变化
     * @private
     */
    _calculatePointsChange(ranking, isWin, isDraw) {
        const rp = this.config.ranking_points;
        if (isDraw) return 0;
        if (isWin) {
            let points = Number(rp.win);
            // 王者段位额外奖励
            if (ranking.tier === 'king') {
                points += Number(rp.king_bonus);
            }
            return points;
        } else {
            // 青铜段位保护
            if (rp.bronce_protect && ranking.tier === 'bronze') {
                return 0;
            }
            return Number(rp.lose);
        }
    }

    /**
     * 检查并执行每日重置
     * @private
     */
    async _checkDailyReset(ranking, transaction = null) {
        // 带调用方事务：不带事务的 save() 在"同一行已被本事务 FOR UPDATE 锁住"时会走另一条连接
        // 去写同一行 = 自己等自己，只能等到 innodb_lock_wait_timeout。
        if (!ranking.daily_reset_at) {
            ranking.daily_reset_at = new Date();
            ranking.daily_challenge_count = 0;
            ranking.daily_first_win_claimed = false;
            await ranking.save({ silent: true, transaction });
            return;
        }
        const now = new Date();
        const lastReset = new Date(ranking.daily_reset_at);
        // 如果不是同一天，重置
        if (now.toDateString() !== lastReset.toDateString()) {
            ranking.daily_reset_at = now;
            ranking.daily_challenge_count = 0;
            ranking.daily_first_win_claimed = false;
            await ranking.save({ silent: true, transaction });
        }
    }

    /**
     * 获取玩家在赛季中的排名
     * @private
     */
    async _getPlayerRank(playerId, seasonId) {
        const ranking = await SpiritBeastPvpRanking.findOne({
            where: { season_id: seasonId, player_id: playerId }
        });
        if (!ranking || ranking.total_matches === 0) return null;
        const higherCount = await SpiritBeastPvpRanking.count({
            where: {
                season_id: seasonId,
                total_matches: { [Op.gt]: 0 },
                [Op.or]: [
                    { ranking_points: { [Op.gt]: ranking.ranking_points } },
                    {
                        ranking_points: ranking.ranking_points,
                        total_wins: { [Op.gt]: ranking.total_wins }
                    }
                ]
            }
        });
        return higherCount + 1;
    }

    /**
     * 调度器：检查赛季是否到期并自动结算
     */
    async checkSeasonExpiry() {
        if (!this.initialized) return;

        const expiredSeasons = await SpiritBeastPvpSeason.findAll({
            where: { status: 'active', end_time: { [Op.lt]: new Date() } }
        });

        for (const season of expiredSeasons) {
            try {
                const result = await this._settleSeason(season);
                if (result?.settled) {
                    console.log(`[SpiritBeastPvpService] 赛季 ${season.season_name} 已自动结算`);
                } else {
                    console.log(`[SpiritBeastPvpService] 赛季 ${season.season_name} 跳过结算：${result?.reason}`);
                }
            } catch (e) {
                console.error(`[SpiritBeastPvpService] 赛季 ${season.season_name} 结算失败:`, e.message);
            }
        }
    }

    /**
     * 一次把多行 players 按 id 升序锁齐（本服务的取锁契约）。
     * 顺序必须固定：players 是多人共用行，两笔流程用不同次序锁同一批行就是 ABBA 死锁。
     * @private
     */
    async _lockPlayersByIdAsc(t, ids) {
        const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
        if (!unique.length) return [];
        return Player.findAll({
            where: { id: unique },
            order: [['id', 'ASC']],
            lock: t.LOCK.UPDATE,
            transaction: t
        });
    }

    /**
     * 结算赛季
     * @private
     */
    async _settleSeason(season) {
        const transaction = await sequelize.transaction();
        try {
            // 调用方那次 findAll 粗筛是**不带锁**的：调度器与手动结算（或两轮 tick 重叠）会拿到
            // 同一份 status='active' 的快照双双通过检查，前 100 名的赛季奖励就发两遍。
            // 锁住这一行再重判一遍，第二笔直接退出。
            const lockedSeason = await SpiritBeastPvpSeason.findByPk(season.id, {
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            if (!lockedSeason || lockedSeason.status !== 'active' || new Date(lockedSeason.end_time) > new Date()) {
                await transaction.rollback();
                return { settled: false, reason: '赛季已被其它结算处理或尚未到期' };
            }
            season = lockedSeason;

            // 获取前100名
            const top100 = await SpiritBeastPvpRanking.findAll({
                where: { season_id: season.id, total_matches: { [Op.gt]: 0 } },
                order: [['ranking_points', 'DESC'], ['total_wins', 'DESC'], ['created_at', 'ASC']],
                limit: 100,
                transaction
            });

            const summary = [];
            const seasonRewards = this.config.season;
            const tiersConfig = this.config.tiers;
            const tierRewardMap = {};
            tiersConfig.forEach(t => { tierRewardMap[t.key] = Number(t.season_reward_spirit_stones); });

            // 要发奖的玩家一次按 id 升序锁齐（一件一件按名次锁 = 与并发对局的次序可能相反 → ABBA）
            const recipientById = new Map((await this._lockPlayersByIdAsc(transaction, top100.map(r => r.player_id)))
                .map(p => [Number(p.id), p]));

            for (let i = 0; i < top100.length; i++) {
                const ranking = top100[i];
                const rank = i + 1;
                // 段位奖励
                let reward = tierRewardMap[ranking.tier] || 0;
                // 排名奖励
                if (rank === 1) reward += Number(seasonRewards.top1_reward_spirit_stones);
                else if (rank <= 3) reward += Number(seasonRewards.top3_reward_spirit_stones);
                else if (rank <= 10) reward += Number(seasonRewards.top10_reward_spirit_stones);
                else reward += Number(seasonRewards.top100_reward_spirit_stones);

                // 发放奖励（玩家行已在上面按 id 升序锁好，这里只认锁到的那一份）
                if (reward > 0) {
                    const player = recipientById.get(Number(ranking.player_id));
                    if (player && !player.is_dead && !player.is_banned) {
                        player.spirit_stones = BigInt(player.spirit_stones || 0) + BigInt(reward);
                        await player.save({ transaction, silent: true });
                    }
                }

                summary.push({
                    rank,
                    player_id: ranking.player_id,
                    player_nickname: ranking.player_nickname_snapshot,
                    tier: ranking.tier,
                    ranking_points: ranking.ranking_points,
                    total_wins: ranking.total_wins,
                    reward_spirit_stones: reward
                });
            }

            // 更新赛季状态
            season.status = 'settled';
            season.settled_at = new Date();
            season.settlement_summary = {
                settled_at: new Date().toISOString(),
                total_participants: top100.length,
                top_100: summary
            };
            await season.save({ transaction, silent: true });

            // 建新赛季放在**同一个事务里**：原来先 commit 再建，建失败（唯一键/进程被杀）就留下
            // "上一季已 settled、下一季不存在"的空档，排位玩法直接停摆且没人补。
            const durationDays = Number(this.config.season.duration_days);
            const now = new Date();
            const seasonCount = await SpiritBeastPvpSeason.count({ transaction });
            const newSeasonName = `${now.getFullYear()}年第${Math.floor(now.getMonth() / 4) + 1 + seasonCount}季`;
            await SpiritBeastPvpSeason.create({
                season_name: newSeasonName,
                start_time: now,
                end_time: new Date(now.getTime() + durationDays * 24 * 3600 * 1000),
                status: 'active'
            }, { transaction });

            await transaction.commit();
            console.log(`[SpiritBeastPvpService] 新赛季 ${newSeasonName} 已创建`);
            return { settled: true, rewarded: summary.length, new_season: newSeasonName };
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    }
}

// 单例导出
module.exports = new SpiritBeastPvpService();
