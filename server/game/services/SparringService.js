/**
 * 切磋木人服务模块
 *
 * 处理切磋木人业务逻辑：配置查询、战斗模拟、评分计算、奖励结算、排行榜
 *
 * 设计说明：
 *   - 木人配置从 sparring_woodman.json 读取（配置中心化）
 *   - 战斗为自动回合制模拟，玩家无需手动操作（切磋是战力测试，非真实战斗）
 *   - 伤害公式复用 CombatService：max(1, atk - def + random(-7, 7))
 *   - 技能攻击：damage × 1.5，消耗 20 MP（MP 不足时自动降级为普攻）
 *   - 评分 = 基础分(档次×1000) + 效率分(剩余回合×100) + HP保留分(HP比例×500) + 完美分(未受伤+1000)
 *   - 每日 5 次切磋限制，冷却 5 分钟
 *   - 首次击败该档次木人可获得首通奖励
 *   - 排行榜按分数降序，前 10 名有额外奖励（每日 00:05 结算）
 *
 * 玩法文档对照：xiuxian_game_guide.md 第17节·战力与阵法
 *   `.切磋木人 [境界]` 用于检查战斗准备，是战力测试功能
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const Player = require('../../models/player');
const PlayerSparring = require('../../models/playerSparring');
const SystemConfig = require('../../models/system_config');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const path = require('path');
const ArtifactDeepLineService = require('./ArtifactDeepLineService');

/**
 * 构造结算状态记录的 SystemConfig key
 * 使用日期作为后缀，每个日期一个独立 key，便于按日期查询
 * @param {string} dateStr - YYYY-MM-DD 格式日期
 * @returns {string} SystemConfig key
 */
function _buildSettleConfigKey(dateStr) {
    return `sparring_settle_${dateStr}`;
}

// 懒加载切磋木人配置（避免模块加载时配置未初始化）
let _sparringConfig = null;
/**
 * 获取切磋木人配置
 * @returns {Object} 切磋木人配置对象
 */
function getSparringConfig() {
    if (!_sparringConfig) {
        _sparringConfig = require('../../config/sparring_woodman.json');
    }
    return _sparringConfig;
}

/**
 * 安全 BigInt 转换（防御 null/undefined 导致 500）
 * @param {*} val - 待转换值
 * @returns {BigInt} 安全的 BigInt 值
 */
function safeBigInt(val) {
    if (val === null || val === undefined || val === '') return BigInt(0);
    try {
        return BigInt(val);
    } catch (e) {
        return BigInt(0);
    }
}

class SparringService {
    /**
     * 获取切磋木人配置信息（对外只读接口）
     * @returns {Object} 配置信息（全局参数 + 5个木人档次）
     */
    static getInfo() {
        const config = getSparringConfig();
        return {
            global: config.global,
            woodmen: config.woodmen.map(w => ({
                tier: w.tier,
                key: w.key,
                name: w.name,
                min_realm_rank: w.min_realm_rank,
                recommended_realm: w.recommended_realm,
                description: w.description,
                stats: w.stats,
                rewards: {
                    exp_win: w.rewards.exp_win,
                    spirit_stones_win: w.rewards.spirit_stones_win
                },
                first_clear_bonus: w.first_clear_bonus,
                ai_strategy: w.ai_strategy,
                ai_description: w.ai_description
            }))
        };
    }

    /**
     * 获取玩家切磋状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 切磋状态（今日次数/冷却/首次击败记录）
     */
    static async getStatus(playerId) {
        // 获取今日切磋记录
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayRecords = await PlayerSparring.findAll({
            where: {
                player_id: playerId,
                created_at: { [Op.gte]: todayStart }
            },
            order: [['created_at', 'DESC']]
        });

        const config = getSparringConfig();
        const dailyLimit = config.global.daily_limit;
        const todayCount = todayRecords.length;
        const lastRecord = todayRecords[0];

        // 计算冷却剩余时间
        let cooldownRemaining = 0;
        if (lastRecord) {
            const cooldownEnd = new Date(lastRecord.created_at.getTime() + config.global.cooldown_sec * 1000);
            const now = new Date();
            if (cooldownEnd > now) {
                cooldownRemaining = Math.ceil((cooldownEnd - now) / 1000);
            }
        }

        // 获取首次击败记录（各档次）
        const firstClears = await PlayerSparring.findAll({
            where: {
                player_id: playerId,
                is_first_clear: 1,
                result: 'win'
            },
            attributes: ['woodman_tier', 'woodman_key', 'woodman_name', 'created_at'],
            order: [['woodman_tier', 'ASC']]
        });

        // 获取个人最高分
        const bestScoreRecord = await PlayerSparring.findOne({
            where: { player_id: playerId },
            order: [['score', 'DESC']]
        });

        return {
            daily_limit: dailyLimit,
            daily_used: todayCount,
            daily_remaining: Math.max(0, dailyLimit - todayCount),
            cooldown_remaining_sec: cooldownRemaining,
            can_sparring: todayCount < dailyLimit && cooldownRemaining === 0,
            first_clears: firstClears.map(f => ({
                tier: f.woodman_tier,
                key: f.woodman_key,
                name: f.woodman_name,
                cleared_at: f.created_at
            })),
            best_score: bestScoreRecord ? bestScoreRecord.score : 0,
            best_score_tier: bestScoreRecord ? bestScoreRecord.woodman_tier : null,
            today_records: todayRecords.map(r => ({
                id: r.id,
                woodman_name: r.woodman_name,
                woodman_tier: r.woodman_tier,
                result: r.result,
                score: r.score,
                rounds_used: r.rounds_used,
                exp_gained: r.exp_gained,
                spirit_stones_gained: r.spirit_stones_gained,
                is_first_clear: !!r.is_first_clear,
                created_at: r.created_at
            }))
        };
    }

    /**
     * 开始切磋木人（核心方法）
     *
     * 流程：
     *   1. 校验境界要求
     *   2. 校验每日次数
     *   3. 校验冷却
     *   4. 获取玩家属性
     *   5. 生成木人数据
     *   6. 模拟自动战斗
     *   7. 计算评分
     *   8. 结算奖励
     *   9. 记录到数据库
     *   10. 返回结果
     *
     * @param {number} playerId - 玩家ID
     * @param {string} woodmanKey - 木人键（qi_refining/foundation/core_formation/nascent_soul/spirit_severing）
     * @returns {Promise<Object>} 切磋结果
     */
    static async startSparring(playerId, woodmanKey) {
        const t = await sequelize.transaction();
        try {
            // 1. 查找木人配置
            const config = getSparringConfig();
            const woodman = config.woodmen.find(w => w.key === woodmanKey);
            if (!woodman) {
                throw new AppError(
                    `木人键无效：${woodmanKey}，可选值：${config.woodmen.map(w => w.key).join('/')}`,
                    400,
                    ErrorCodes.VALIDATION_ERROR
                );
            }

            // 2. 行级锁玩家
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 3. 校验境界要求
            const playerRank = player.realm_rank || 0;
            if (playerRank < config.global.min_realm_rank) {
                throw new AppError(
                    `切磋木人需达到${config.global.min_realm_name}（rank≥${config.global.min_realm_rank}），当前境界rank=${playerRank}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 4. 校验每日次数
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayCount = await PlayerSparring.count({
                where: {
                    player_id: playerId,
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            if (todayCount >= config.global.daily_limit) {
                throw new AppError(
                    `今日切磋次数已用完（${todayCount}/${config.global.daily_limit}），请明日再来`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 5. 校验冷却
            const lastRecord = await PlayerSparring.findOne({
                where: { player_id: playerId },
                order: [['created_at', 'DESC']],
                transaction: t
            });
            if (lastRecord) {
                const cooldownEnd = new Date(lastRecord.created_at.getTime() + config.global.cooldown_sec * 1000);
                if (cooldownEnd > new Date()) {
                    const remaining = Math.ceil((cooldownEnd - new Date()) / 1000);
                    throw new AppError(
                        `切磋冷却中，还需等待 ${remaining} 秒`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 6. 获取玩家完整属性（含境界/装备/灵兽/天赋/称号等全部加成）
            // 设计要点：切磋是战力测试，必须使用玩家真实战力（含所有加成），
            // 而非 attributes.hp_max 基础值（175），否则化神期玩家会被当作低境界处理
            // AttributeService.calculateFullAttributesAsync 内部已集成灵兽加成，无需重复计算
            const AttributeService = require('../core/AttributeService');
            let fullAttrs;
            try {
                const attrResult = await AttributeService.calculateFullAttributesAsync(player);
                fullAttrs = attrResult.final || {};
            } catch (e) {
                // 属性服务异常时降级到基础属性
                console.warn('[SparringService] AttributeService 计算失败，降级使用基础属性:', e.message);
                fullAttrs = player.attributes || {};
            }

            const playerAtk = Number(fullAttrs.atk) || 10;
            const playerDef = Number(fullAttrs.def) || 5;
            const playerSpeed = Number(fullAttrs.speed) || 10;
            // hp_max 优先用完整属性计算结果（含装备/灵兽加成），兜底 player.hp_current（实际当前HP），最后 100
            const playerHpMax = safeBigInt(fullAttrs.hp_max || player.hp_current || 100);
            const playerMpMax = safeBigInt(fullAttrs.mp_max || 0);
            const playerHp = playerHpMax; // 切磋开始时满血
            const playerMp = playerMpMax; // 切磋开始时满蓝
            // totalPlayerAtk 等于 playerAtk（已含灵兽加成，AttributeService 内部已计算）
            const totalPlayerAtk = playerAtk;

            // 7. 生成木人数据
            const woodmanData = {
                name: woodman.name,
                max_hp: BigInt(woodman.stats.max_hp),
                hp: BigInt(woodman.stats.max_hp),
                atk: woodman.stats.atk,
                def: woodman.stats.def,
                speed: woodman.stats.speed,
                tier: woodman.tier
            };

            // 8. 模拟自动战斗
            const battleResult = this._simulateBattle(
                { atk: totalPlayerAtk, def: playerDef, speed: playerSpeed, hp: playerHp, hp_max: playerHpMax, mp: playerMp, mp_max: playerMpMax },
                woodmanData,
                config.global
            );

            // 9. 判断是否首次击败该档次
            const isFirstClear = battleResult.result === 'win' && !await PlayerSparring.findOne({
                where: {
                    player_id: playerId,
                    woodman_key: woodmanKey,
                    result: 'win'
                },
                transaction: t
            });

            // 10. 计算评分
            const score = this._calculateScore(battleResult, woodman.tier, config.global);

            // 11. 结算奖励
            let expGained = 0;
            let spiritStonesGained = 0;
            let titleAwarded = null;

            if (battleResult.result === 'win') {
                expGained = woodman.rewards.exp_win;
                spiritStonesGained = woodman.rewards.spirit_stones_win;

                // 首通奖励
                if (isFirstClear) {
                    expGained += woodman.first_clear_bonus.exp || 0;
                    spiritStonesGained += woodman.first_clear_bonus.spirit_stones || 0;
                    if (woodman.first_clear_bonus.title) {
                        titleAwarded = woodman.first_clear_bonus.title;
                    }
                }
            } else {
                // 失败惩罚：损失少量 HP（不实际扣除，仅记录）
                // 注：切磋是友好的战力测试，失败不扣HP，只记录
            }

            // 12. 发放奖励（修为和灵石）
            if (expGained > 0 || spiritStonesGained > 0) {
                const newExp = safeBigInt(player.exp) + BigInt(expGained);
                const newStones = safeBigInt(player.spirit_stones) + BigInt(spiritStonesGained);
                await player.update({
                    exp: newExp.toString(),
                    spirit_stones: newStones.toString()
                }, { transaction: t });
            }

            // 13. 记录到数据库
            // 说明：player.realm 字段本身就是境界名称字符串（如"化神初期"），无需额外转换
            const realmName = player.realm || '凡人';
            const record = await PlayerSparring.create({
                player_id: playerId,
                player_nickname: player.nickname,
                player_realm_rank: playerRank,
                player_realm_name: realmName,
                woodman_tier: woodman.tier,
                woodman_key: woodman.key,
                woodman_name: woodman.name,
                rounds_used: battleResult.rounds,
                max_rounds: config.global.max_rounds,
                player_hp_remaining: battleResult.player_hp.toString(),
                player_hp_max: playerHpMax.toString(),
                player_mp_used: battleResult.player_mp_used.toString(),
                total_damage_dealt: battleResult.total_damage_dealt.toString(),
                total_damage_taken: battleResult.total_damage_taken.toString(),
                result: battleResult.result,
                score: score,
                is_first_clear: isFirstClear ? 1 : 0,
                exp_gained: expGained,
                spirit_stones_gained: spiritStonesGained,
                title_awarded: titleAwarded,
                battle_log: JSON.stringify(battleResult.log)
            }, { transaction: t });

            await t.commit();

            // 大五行幻世轮：切磋木人结算后自动积累悟印（未装备时静默返回）
            await ArtifactDeepLineService.safeAddInsightExp(playerId, {
                battle_type: 'pve',
                is_win: battleResult.result === 'win'
            });

            // 14. 返回结果
            return {
                record_id: record.id,
                woodman: {
                    tier: woodman.tier,
                    key: woodman.key,
                    name: woodman.name
                },
                battle: {
                    result: battleResult.result,
                    rounds: battleResult.rounds,
                    max_rounds: config.global.max_rounds,
                    player_hp_remaining: battleResult.player_hp.toString(),
                    player_hp_max: playerHpMax.toString(),
                    player_mp_used: battleResult.player_mp_used.toString(),
                    woodman_hp_remaining: battleResult.woodman_hp.toString(),
                    woodman_hp_max: woodmanData.max_hp.toString(),
                    total_damage_dealt: battleResult.total_damage_dealt.toString(),
                    total_damage_taken: battleResult.total_damage_taken.toString(),
                    is_flawless: battleResult.is_flawless,
                    log: battleResult.log
                },
                score: score,
                rewards: {
                    exp: expGained,
                    spirit_stones: spiritStonesGained,
                    title: titleAwarded,
                    is_first_clear: isFirstClear
                },
                daily_remaining: Math.max(0, config.global.daily_limit - todayCount - 1)
            };
        } catch (error) {
            if (!t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 模拟自动战斗（私有方法）
     *
     * 回合制战斗模拟：
     *   - 速度高的一方先手
     *   - 每回合：先手攻击 → 后手攻击
     *   - 伤害公式：max(1, atk - def + random(-7, 7))
     *   - 技能攻击：damage × 1.5，消耗 20 MP（MP 不足时降级为普攻）
     *   - 战斗结束：木人HP≤0 胜利 / 玩家HP≤0 失败 / 回合数≥上限 超时
     *
     * @param {Object} playerStats - 玩家属性 {atk, def, speed, hp, hp_max, mp, mp_max}
     * @param {Object} woodmanData - 木人数据 {name, max_hp, hp, atk, def, speed, tier}
     * @param {Object} globalConfig - 全局配置
     * @returns {Object} 战斗结果 {result, rounds, player_hp, woodman_hp, total_damage_dealt, total_damage_taken, player_mp_used, is_flawless, log}
     */
    static _simulateBattle(playerStats, woodmanData, globalConfig) {
        const maxRounds = globalConfig.max_rounds;
        const dmgRange = globalConfig.damage_random_range ?? 15;
        const dmgOffset = globalConfig.damage_random_offset ?? 7;
        const skillMpCost = globalConfig.skill_mp_cost ?? 20;
        const skillMultiplier = globalConfig.skill_damage_multiplier ?? 1.5;

        let playerHp = BigInt(playerStats.hp);
        const playerHpMax = BigInt(playerStats.hp_max);
        let playerMp = BigInt(playerStats.mp);
        let woodmanHp = BigInt(woodmanData.hp);
        const woodmanHpMax = BigInt(woodmanData.max_hp);

        let rounds = 0;
        let totalDamageDealt = BigInt(0);
        let totalDamageTaken = BigInt(0);
        let playerMpUsed = BigInt(0);
        let isFlawless = true; // 是否未受伤（完美）

        // 速度决定先手
        const playerFirst = playerStats.speed >= woodmanData.speed;
        const log = [];

        while (rounds < maxRounds) {
            rounds++;
            const roundLog = { round: rounds, actions: [] };

            // 先手攻击
            const firstAttacker = playerFirst ? 'player' : 'woodman';
            const secondAttacker = playerFirst ? 'woodman' : 'player';

            for (const attacker of [firstAttacker, secondAttacker]) {
                // 检查战斗是否已结束
                if (woodmanHp <= 0 || playerHp <= 0) break;

                if (attacker === 'player') {
                    // 玩家攻击：优先使用技能（如果MP足够），否则普攻
                    let damage;
                    let action = 'attack';
                    if (playerMp >= BigInt(skillMpCost)) {
                        // 技能攻击
                        damage = Math.max(1, playerStats.atk - woodmanData.def + Math.floor(Math.random() * dmgRange) - dmgOffset);
                        damage = Math.floor(damage * skillMultiplier);
                        playerMp -= BigInt(skillMpCost);
                        playerMpUsed += BigInt(skillMpCost);
                        action = 'skill';
                    } else {
                        // 普攻
                        damage = Math.max(1, playerStats.atk - woodmanData.def + Math.floor(Math.random() * dmgRange) - dmgOffset);
                    }

                    woodmanHp -= BigInt(damage);
                    totalDamageDealt += BigInt(damage);

                    roundLog.actions.push({
                        attacker: 'player',
                        action: action,
                        damage: damage,
                        target_hp: woodmanHp.toString()
                    });

                    if (woodmanHp <= 0) break;
                } else {
                    // 木人攻击
                    const damage = Math.max(1, woodmanData.atk - playerStats.def + Math.floor(Math.random() * dmgRange) - dmgOffset);
                    playerHp -= BigInt(damage);
                    totalDamageTaken += BigInt(damage);
                    isFlawless = false; // 受伤则非完美

                    roundLog.actions.push({
                        attacker: 'woodman',
                        action: 'attack',
                        damage: damage,
                        target_hp: playerHp.toString()
                    });

                    if (playerHp <= 0) break;
                }
            }

            log.push(roundLog);

            // 检查战斗结束
            if (woodmanHp <= 0) {
                return {
                    result: 'win',
                    rounds: rounds,
                    player_hp: playerHp < 0 ? BigInt(0) : playerHp,
                    player_hp_max: playerHpMax,
                    woodman_hp: BigInt(0),
                    woodman_hp_max: woodmanHpMax,
                    total_damage_dealt: totalDamageDealt,
                    total_damage_taken: totalDamageTaken,
                    player_mp_used: playerMpUsed,
                    is_flawless: isFlawless,
                    log: log
                };
            }
            if (playerHp <= 0) {
                return {
                    result: 'lose',
                    rounds: rounds,
                    player_hp: BigInt(0),
                    player_hp_max: playerHpMax,
                    woodman_hp: woodmanHp,
                    woodman_hp_max: woodmanHpMax,
                    total_damage_dealt: totalDamageDealt,
                    total_damage_taken: totalDamageTaken,
                    player_mp_used: playerMpUsed,
                    is_flawless: false,
                    log: log
                };
            }
        }

        // 超时
        return {
            result: 'timeout',
            rounds: maxRounds,
            player_hp: playerHp < 0 ? BigInt(0) : playerHp,
            player_hp_max: playerHpMax,
            woodman_hp: woodmanHp < 0 ? BigInt(0) : woodmanHp,
            woodman_hp_max: woodmanHpMax,
            total_damage_dealt: totalDamageDealt,
            total_damage_taken: totalDamageTaken,
            player_mp_used: playerMpUsed,
            is_flawless: isFlawless,
            log: log
        };
    }

    /**
     * 计算战力评分（私有方法）
     *
     * 评分公式：
     *   基础分 = 档次 × 1000（仅胜利有基础分）
     *   效率分 = max(0, (15 - 回合数) × 100)（越快胜利分数越高）
     *   HP保留分 = (剩余HP / 最大HP) × 500（HP保留越多分数越高）
     *   完美分 = 未受伤 +1000
     *
     * @param {Object} battleResult - 战斗结果
     * @param {number} tier - 木人档次
     * @param {Object} globalConfig - 全局配置
     * @returns {number} 战力评分
     */
    static _calculateScore(battleResult, tier, globalConfig) {
        // 失败/超时：0 分
        if (battleResult.result !== 'win') {
            return 0;
        }

        const baseScore = tier * (globalConfig.score_base_per_tier || 1000);

        // 效率分：越快胜利分数越高
        const efficiencyMaxRounds = globalConfig.score_efficiency_max_rounds || 15;
        const efficiencyPerRound = globalConfig.score_efficiency_per_round_saved || 100;
        const efficiencyScore = Math.max(0, (efficiencyMaxRounds - battleResult.rounds) * efficiencyPerRound);

        // HP保留分：HP保留越多分数越高
        const playerHp = Number(battleResult.player_hp);
        const playerHpMax = Number(battleResult.player_hp_max);
        const hpRatio = playerHpMax > 0 ? playerHp / playerHpMax : 0;
        const hpScore = Math.floor(hpRatio * (globalConfig.score_hp_ratio_bonus || 500));

        // 完美分：未受伤
        const flawlessScore = battleResult.is_flawless ? (globalConfig.score_flawless_bonus || 1000) : 0;

        return baseScore + efficiencyScore + hpScore + flawlessScore;
    }

    /**
     * 获取切磋历史
     * @param {number} playerId - 玩家ID
     * @param {number} limit - 返回条数（默认20）
     * @param {number} offset - 偏移量（默认0）
     * @returns {Promise<Object>} 切磋历史列表
     */
    static async getHistory(playerId, limit = 20, offset = 0) {
        const { count, rows } = await PlayerSparring.findAndCountAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: Math.min(limit, 100),
            offset: offset
        });

        return {
            total: count,
            limit: Math.min(limit, 100),
            offset: offset,
            records: rows.map(r => ({
                id: r.id,
                woodman_tier: r.woodman_tier,
                woodman_key: r.woodman_key,
                woodman_name: r.woodman_name,
                result: r.result,
                score: r.score,
                rounds_used: r.rounds_used,
                player_hp_remaining: r.player_hp_remaining.toString(),
                player_hp_max: r.player_hp_max.toString(),
                total_damage_dealt: r.total_damage_dealt.toString(),
                total_damage_taken: r.total_damage_taken.toString(),
                is_first_clear: !!r.is_first_clear,
                exp_gained: r.exp_gained,
                spirit_stones_gained: r.spirit_stones_gained,
                title_awarded: r.title_awarded,
                created_at: r.created_at
            }))
        };
    }

    /**
     * 每日排行榜奖励结算（由调度器在 00:05 调用，或由 GM 手动触发）
     *
     * 结算逻辑：
     *   1. 计算目标日期（默认昨天：00:00:00 ~ 23:59:59）
     *   2. 防重入：通过 SystemConfig 表的 sparring_settle_<YYYY-MM-DD> 记录检查
     *      （双重幂等：SystemConfig + PlayerSparring.settled_at，确保即使该日无任何切磋记录也能正确防重入）
     *   3. 按玩家聚合取当日 MAX(score)，按分数降序取前 N 名（N=ranking_top_n）
     *   4. 按 ranking_daily_reward 配置发放经验/灵石/称号奖励
     *   5. 标记该日所有切磋记录的 settled_at（含 lose/timeout，防止下次重复扫描）
     *   6. 写入 SystemConfig 记录该日已结算（关键：即使该日无任何切磋记录也会写入，确保幂等性）
     *   7. 推送 WebSocket 通知给上榜玩家
     *
     * 事务保证：
     *   - 全流程在单个事务中，失败则回滚
     *   - 玩家行级锁防并发修改
     *   - SystemConfig + settled_at 双重标记确保幂等性
     *
     * @param {string|Date|null} targetDate - 目标日期（默认昨天）；传入 'YYYY-MM-DD' 字符串或 Date 对象
     * @returns {Promise<Object>} 结算结果 { settle_date, settled_count, rewards[], already_settled }
     */
    static async settleDailyRanking(targetDate = null) {
        // 1. 计算目标日期（默认昨天）并生成本地时区的 YYYY-MM-DD 字符串
        // 说明：调度器在今日 00:05 执行时，应结算"昨日"的切磋记录
        // 关键：new Date('YYYY-MM-DD') 按 UTC 解析为 UTC 0 点，但 setHours/getDate 等是本地时区方法
        // 在 UTC+8 时区下会让 2026-07-14 错位为 2026-07-13。所以字符串日期直接用作 dateStr
        let dateStr;
        if (targetDate && typeof targetDate === 'string') {
            // 字符串日期：直接用作 dateStr（路由层已校验格式与合法性）
            dateStr = targetDate;
        } else {
            // Date 对象或默认昨天：用本地方法格式化为 YYYY-MM-DD
            const d = targetDate ? new Date(targetDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
            if (isNaN(d.getTime())) {
                throw new AppError(
                    `targetDate 参数无效：${targetDate}`,
                    400,
                    ErrorCodes.VALIDATION_ERROR
                );
            }
            dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
        // 用 dateStr 构造本地时区的 dateStart/dateEnd（[00:00:00.000, 23:59:59.999] 闭区间）
        const [y, m, d] = dateStr.split('-').map(Number);
        const dateStart = new Date(y, m - 1, d, 0, 0, 0, 0);
        const dateEnd = new Date(y, m - 1, d, 23, 59, 59, 999);

        // 2. 防重入检查（关键）：通过 SystemConfig 表查询该日期是否已结算过
        // 使用 SystemConfig 而非 PlayerSparring.settled_at 的原因：
        //   - 当该日完全无任何切磋记录时，settled_at 字段无记录可标记，下次检查仍会返回 null
        //   - SystemConfig 表独立于切磋记录，即使无记录也能正确标记已结算状态
        const settleConfigKey = _buildSettleConfigKey(dateStr);
        const existingSettle = await SystemConfig.findByPk(settleConfigKey);
        if (existingSettle) {
            let settledAt = null;
            try { settledAt = JSON.parse(existingSettle.value)?.settled_at || null; } catch (_) {}
            console.log(`[SparringService] 排行榜 ${dateStr} 已于 ${settledAt || '未知时间'} 结算（SystemConfig 标记），跳过`);
            return {
                settle_date: dateStr,
                already_settled: true,
                settled_count: 0,
                rewards: [],
                message: `排行榜 ${dateStr} 已结算过，跳过执行`
            };
        }

        // 3. 查询当日每个玩家最高分（仅 win 且未结算）
        const config = getSparringConfig();
        const topN = config.global.ranking_top_n || 10;
        const rankings = await PlayerSparring.findAll({
            where: {
                result: 'win',
                created_at: { [Op.between]: [dateStart, dateEnd] },
                settled_at: null
            },
            attributes: [
                'player_id',
                'player_nickname',
                'player_realm_rank',
                'player_realm_name',
                [sequelize.fn('MAX', sequelize.col('score')), 'best_score'],
                [sequelize.fn('MAX', sequelize.col('woodman_tier')), 'best_tier'],
                [sequelize.fn('MAX', sequelize.col('woodman_name')), 'best_woodman'],
                [sequelize.fn('MAX', sequelize.col('created_at')), 'latest_time']
            ],
            group: ['player_id', 'player_nickname', 'player_realm_rank', 'player_realm_name'],
            order: [[sequelize.fn('MAX', sequelize.col('score')), 'DESC']],
            limit: topN,
            raw: true
        });

        // 4. 事务内发放奖励 + 标记 settled_at + 写入 SystemConfig
        const rewardConfig = config.global.ranking_daily_reward || {};
        const rewardResults = [];
        const t = await sequelize.transaction();
        try {
            // 4.1 发放奖励（仅当有上榜玩家时）
            if (rankings.length > 0) {
                for (let i = 0; i < rankings.length; i++) {
                    const rank = i + 1;
                    const ranking = rankings[i];
                    // 奖励档位：1/2/3 名有专属奖励，4-10 名走 default 档
                    const rewardKey = String(rank);
                    const reward = rewardConfig[rewardKey] || rewardConfig['default'] || { exp: 0, spirit_stones: 0 };

                    // 行级锁玩家，防止并发修改
                    const player = await Player.findByPk(ranking.player_id, {
                        lock: t.LOCK.UPDATE,
                        transaction: t
                    });

                    // 玩家不存在或已陨落：跳过发放，但仍记录到结果中
                    if (!player) {
                        rewardResults.push({
                            rank,
                            player_id: ranking.player_id,
                            nickname: ranking.player_nickname,
                            realm_name: ranking.player_realm_name,
                            best_score: Number(ranking.best_score),
                            best_tier: ranking.best_tier,
                            best_woodman: ranking.best_woodman,
                            status: 'skipped',
                            reason: '玩家不存在',
                            rewards: { exp: 0, spirit_stones: 0, title: null }
                        });
                        continue;
                    }
                    if (player.is_dead) {
                        rewardResults.push({
                            rank,
                            player_id: ranking.player_id,
                            nickname: ranking.player_nickname,
                            realm_name: ranking.player_realm_name,
                            best_score: Number(ranking.best_score),
                            best_tier: ranking.best_tier,
                            best_woodman: ranking.best_woodman,
                            status: 'skipped',
                            reason: '玩家已陨落',
                            rewards: { exp: 0, spirit_stones: 0, title: null }
                        });
                        continue;
                    }

                    // 发放经验 + 灵石
                    const newExp = safeBigInt(player.exp) + BigInt(reward.exp || 0);
                    const newStones = safeBigInt(player.spirit_stones) + BigInt(reward.spirit_stones || 0);

                    // 构造更新字段（titles 字段由 Sequelize set hook 自动 JSON.stringify）
                    const updateFields = {
                        exp: newExp.toString(),
                        spirit_stones: newStones.toString()
                    };

                    // 发放称号（去重：已有则不重复添加）
                    let titleAwarded = null;
                    if (reward.title) {
                        const titles = player.titles || [];
                        if (!titles.includes(reward.title)) {
                            titles.push(reward.title);
                            updateFields.titles = titles; // set hook 会自动 JSON.stringify
                        }
                        titleAwarded = reward.title;
                    }

                    await player.update(updateFields, { transaction: t });

                    rewardResults.push({
                        rank,
                        player_id: ranking.player_id,
                        nickname: ranking.player_nickname,
                        realm_name: ranking.player_realm_name,
                        best_score: Number(ranking.best_score),
                        best_tier: ranking.best_tier,
                        best_woodman: ranking.best_woodman,
                        status: 'rewarded',
                        rewards: {
                            exp: reward.exp || 0,
                            spirit_stones: reward.spirit_stones || 0,
                            title: titleAwarded
                        }
                    });
                }
            }

            // 4.2 标记该日所有切磋记录的 settled_at（含 lose/timeout，防止下次重复扫描）
            // 即使该日无任何记录，update 0 行也无副作用
            await PlayerSparring.update(
                { settled_at: new Date() },
                {
                    where: {
                        created_at: { [Op.between]: [dateStart, dateEnd] },
                        settled_at: null
                    },
                    transaction: t
                }
            );

            // 4.3 写入 SystemConfig 记录该日已结算（关键：即使无任何切磋记录也会写入，确保幂等性）
            // 使用 upsert 模式（findByPk 已确认不存在，直接 create）
            const settledAt = new Date().toISOString();
            await SystemConfig.create({
                key: settleConfigKey,
                value: JSON.stringify({
                    settled_at: settledAt,
                    settle_date: dateStr,
                    settled_count: rewardResults.filter(r => r.status === 'rewarded').length,
                    skipped_count: rewardResults.filter(r => r.status === 'skipped').length
                }),
                description: `切磋木人排行榜 ${dateStr} 结算记录`
            }, { transaction: t });

            await t.commit();
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }

        // 5. 推送 WebSocket 通知给上榜玩家（事务外推送，避免推送失败影响结算）
        try {
            const WebSocketNotificationService = require('./WebSocketNotificationService');
            for (const result of rewardResults) {
                if (result.status !== 'rewarded') continue;
                WebSocketNotificationService.notifyPlayerUpdate(result.player_id, 'sparring_daily_ranking_settled', {
                    settle_date: dateStr,
                    rank: result.rank,
                    best_score: result.best_score,
                    rewards: result.rewards,
                    message: result.rank === 1
                        ? `恭喜登顶 ${dateStr} 切磋木人榜首！获修为 ${result.rewards.exp}、灵石 ${result.rewards.spirit_stones}${result.rewards.title ? '、称号「' + result.rewards.title + '」' : ''}`
                        : `恭喜获得 ${dateStr} 切磋木人排行榜第 ${result.rank} 名！获修为 ${result.rewards.exp}、灵石 ${result.rewards.spirit_stones}`
                });
            }
        } catch (e) {
            console.warn('[SparringService] 推送结算通知失败:', e.message);
        }

        console.log(`[SparringService] 排行榜 ${dateStr} 结算完成：${rewardResults.length} 名上榜，${rewardResults.filter(r => r.status === 'skipped').length} 名跳过`);

        return {
            settle_date: dateStr,
            already_settled: false,
            settled_count: rewardResults.length,
            rewards: rewardResults,
            message: rankings.length === 0
                ? `排行榜 ${dateStr} 无上榜玩家`
                : `排行榜 ${dateStr} 结算完成，共 ${rewardResults.length} 名上榜`
        };
    }

    /**
     * 获取排行榜
     * @param {string} type - 排行榜类型（daily/all_time/tier）
     * @param {number} tier - 木人档次（仅 type=tier 时有效）
     * @param {number} limit - 返回条数（默认10）
     * @returns {Promise<Object>} 排行榜列表
     */
    static async getRanking(type = 'daily', tier = null, limit = 10) {
        const whereClause = { result: 'win' };
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        if (type === 'daily') {
            whereClause.created_at = { [Op.gte]: todayStart };
        } else if (type === 'tier') {
            if (tier) {
                whereClause.woodman_tier = tier;
            }
        }
        // all_time: 不加时间限制

        // 每个玩家只取最高分（避免同一玩家多次上榜）
        const ranking = await PlayerSparring.findAll({
            where: whereClause,
            attributes: [
                'player_id',
                'player_nickname',
                'player_realm_rank',
                'player_realm_name',
                [sequelize.fn('MAX', sequelize.col('score')), 'best_score'],
                [sequelize.fn('MAX', sequelize.col('woodman_tier')), 'best_tier'],
                [sequelize.fn('MAX', sequelize.col('woodman_name')), 'best_woodman'],
                [sequelize.fn('MAX', sequelize.col('created_at')), 'latest_time']
            ],
            group: ['player_id', 'player_nickname', 'player_realm_rank', 'player_realm_name'],
            order: [[sequelize.fn('MAX', sequelize.col('score')), 'DESC']],
            limit: Math.min(limit, 50),
            raw: true
        });

        return {
            type: type,
            tier: tier,
            ranking: ranking.map((r, idx) => ({
                rank: idx + 1,
                player_id: r.player_id,
                nickname: r.player_nickname,
                realm_rank: r.player_realm_rank,
                realm_name: r.player_realm_name,
                best_score: r.best_score,
                best_tier: r.best_tier,
                best_woodman: r.best_woodman,
                latest_time: r.latest_time
            }))
        };
    }
}

module.exports = SparringService;
