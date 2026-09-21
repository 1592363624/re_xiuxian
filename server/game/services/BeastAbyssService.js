/**
 * 灵兽探渊服务
 *
 * 实现玩法文档第24节"灵兽探渊"：
 *   - 派遣灵兽进入深渊探索（异步玩法，1-4小时）
 *   - 深渊共9层，对应修仙9阶境界，越深层奖励越好但风险越高
 *   - 每层随机遭遇：PVE怪物战斗(45%) / 宝箱(20%) / 陷阱(15%) / PVP玩家遭遇(20%)
 *   - PVP遭遇：同层探索有概率遭遇其他玩家灵兽，自动战斗，胜方获得败方10%收益
 *   - 满级灵兽在探渊中获得的经验会凝成兽魂（用于升星）
 *   - 体力系统：每次探渊消耗体力，每小时恢复25
 *   - 受伤机制：HP归零强制返回，需2小时恢复
 *
 * 核心设计：
 *   1. 异步结算模式：开始探渊只记录时间，召回/结算时一次性模拟所有遭遇
 *   2. 战斗引擎 _battleMonster/_battlePlayer：简化回合制，计算胜负+HP损失
 *   3. PVP匹配：查找同层探索中的其他玩家灵兽，随机匹配
 *   4. 排行榜：最深层数/累计探渊次数/累计PVP胜利
 *   5. 事务+行级锁：探渊/结算/奖励发放使用事务+LOCK.UPDATE
 *
 * 单例导出：module.exports = new BeastAbyssService()
 */
'use strict';
const { beastSnapshot } = require('../stats/beastView');

const { Op } = require('sequelize');
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const SpiritBeast = require('../../models/spiritBeast');
const SpiritBeastAbyssExplore = require('../../models/spiritBeastAbyss');
const AbyssEncounterLog = require('../../models/abyssEncounterLog');
const InventoryService = require('./InventoryService');
const { grantItems } = require('../items/itemGrant');
// 探渊的每回合伤害走声明式档位（beast_abyss_round），怪物属性走与其他敌人来源同一层声明
const CombatResolver = require('../combat/CombatResolver');
const { withDeclaredStats } = require('../combat/MonsterStats');
const { scaleStatBlock } = require('../combat/CombatStats');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class BeastAbyssService {
    constructor() {
        this.config = null;
        this.initialized = false;
    }

    /**
     * 初始化服务
     * @param {object} configLoader - ConfigLoader 实例
     */
    initialize(configLoader) {
        this.config = configLoader.getConfig('spirit_beast_abyss_data');
        if (!this.config) {
            throw new Error('灵兽探渊配置未加载，请检查 spirit_beast_abyss_data.json');
        }
        this.initialized = true;
        console.log('[BeastAbyssService] 灵兽探渊服务初始化完成');
    }

    // ==================== 玩家接口 ====================

    /**
     * 获取可用深渊层数列表（按境界过滤）
     * @param {object} player - 玩家对象
     * @returns {object} 层数列表
     */
    async getFloors(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        const playerRealmRank = player.realm_rank || 1;
        const floors = this.config.floors.filter(f => f.min_realm_rank <= playerRealmRank);

        return {
            data: {
                floors: floors.map(f => ({
                    floor: f.floor,
                    name: f.name,
                    description: f.description,
                    min_realm_rank: f.min_realm_rank,
                    min_realm_name: f.min_realm_name,
                    stamina_cost: f.stamina_cost_per_floor,
                    monster_difficulty: f.monster_difficulty,
                    pvp_encounter_rate: f.pvp_encounter_rate,
                    reward_multiplier: f.reward_multiplier,
                    monsters_count: f.monsters.length,
                    drops_count: f.drops.length
                })),
                total_floors: this.config.abyss.total_floors,
                available_floors: floors.length,
                max_concurrent_beasts: this.config.abyss.max_concurrent_beasts,
                min_duration_hours: this.config.abyss.min_duration_hours,
                max_duration_hours: this.config.abyss.max_duration_hours,
                daily_explore_limit: this.config.abyss.daily_explore_limit,
                stamina_max: this.config.abyss.stamina_max
            }
        };
    }

    /**
     * 开始探渊
     * @param {object} player - 玩家对象
     * @param {number} beastId - 灵兽ID
     * @param {number} durationHours - 探渊时长（小时）
     * @returns {object} 探渊开始结果
     */
    async startExplore(player, beastId, durationHours) {
        if (!this.initialized) throw new Error('服务未初始化');

        const abyssConfig = this.config.abyss;

        // 参数校验
        if (!beastId || beastId < 1) {
            throw new AppError('灵兽ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const duration = Number(durationHours);
        if (!Number.isFinite(duration) || duration < abyssConfig.min_duration_hours || duration > abyssConfig.max_duration_hours) {
            throw new AppError(`探渊时长必须在 ${abyssConfig.min_duration_hours}-${abyssConfig.max_duration_hours} 小时之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 查询灵兽并加锁
            const beast = await SpiritBeast.findOne({
                where: { id: beastId, player_id: player.id },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!beast) {
                throw new AppError('灵兽不存在或不属于你', 404, ErrorCodes.NOT_FOUND);
            }

            // 校验灵兽状态
            if (beast.is_active) {
                throw new AppError('出战中的灵兽不能探渊，请先收回', 400, ErrorCodes.VALIDATION_ERROR);
            }
            if (beast.is_pasturing) {
                throw new AppError('放养中的灵兽不能探渊，请先召回', 400, ErrorCodes.VALIDATION_ERROR);
            }
            if (beast.is_exploring) {
                throw new AppError('该灵兽已在探渊中', 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 校验受伤状态
            if (beast.injury_until && new Date(beast.injury_until) > new Date()) {
                const remainMs = new Date(beast.injury_until) - new Date();
                const remainMin = Math.ceil(remainMs / 60000);
                throw new AppError(`灵兽受伤未恢复，还需 ${remainMin} 分钟`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 校验体力
            if (beast.stamina < abyssConfig.stamina_per_explore) {
                throw new AppError(`体力不足，探渊需 ${abyssConfig.stamina_per_explore} 体力，当前 ${beast.stamina}`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 校验每日次数限制（按玩家当日所有灵兽探渊总次数统计，确保限制是玩家级而非灵兽级）
            const dailyLimit = abyssConfig.daily_explore_limit;
            const todayDate = new Date();
            const todayStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate());
            const todayCount = await SpiritBeastAbyssExplore.count({
                where: {
                    player_id: player.id,
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            if (todayCount >= dailyLimit) {
                throw new AppError(`今日探渊次数已达上限（${dailyLimit}次）`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 校验同时探渊上限
            const activeCount = await SpiritBeastAbyssExplore.count({
                where: { player_id: player.id, status: 'active' },
                transaction: t
            });
            if (activeCount >= abyssConfig.max_concurrent_beasts) {
                throw new AppError(`同时探渊灵兽数已达上限（${abyssConfig.max_concurrent_beasts}只）`, 400, ErrorCodes.VALIDATION_ERROR);
            }

            // 计算起止时间
            const startTime = new Date();
            const endTime = new Date(startTime.getTime() + duration * 3600 * 1000);

            // 创建灵兽快照
            const beastSnapshot = this._createBeastSnapshot(beast);

            // 扣减体力
            beast.stamina = Math.max(0, beast.stamina - abyssConfig.stamina_per_explore);
            beast.is_exploring = true;
            beast.last_explore_time = startTime;
            await beast.save({ transaction: t });

            // 创建探渊记录
            const explore = await SpiritBeastAbyssExplore.create({
                player_id: player.id,
                beast_id: beastId,
                beast_snapshot: beastSnapshot,
                start_floor: 1,
                max_floor_reached: 1,
                duration_hours: duration,
                start_time: startTime,
                end_time: endTime,
                status: 'active'
            }, { transaction: t });

            await t.commit();

            return {
                message: '探渊已开始',
                data: {
                    explore_id: explore.id,
                    beast_id: beastId,
                    beast_name: beast.beast_name,
                    duration_hours: duration,
                    start_time: startTime,
                    end_time: endTime,
                    stamina_remaining: beast.stamina
                }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 召回灵兽（手动召回，应用惩罚）
     * @param {object} player - 玩家对象
     * @param {number} beastId - 灵兽ID
     * @returns {object} 召回结果
     */
    async recallBeast(player, beastId) {
        if (!this.initialized) throw new Error('服务未初始化');

        if (!beastId || beastId < 1) {
            throw new AppError('灵兽ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 查询活跃探渊记录
            const explore = await SpiritBeastAbyssExplore.findOne({
                where: { player_id: player.id, beast_id: beastId, status: 'active' },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!explore) {
                throw new AppError('未找到活跃的探渊记录', 404, ErrorCodes.NOT_FOUND);
            }

            // 判断召回类型
            const now = new Date();
            const endTime = new Date(explore.end_time);
            let recallType = 'manual';
            if (now >= endTime) {
                recallType = 'auto'; // 已到期，按正常结算
            } else {
                recallType = 'early'; // 提前召回
            }

            // 结算探渊
            const result = await this._settleExplore(explore, recallType, t);

            await t.commit();
            return result;
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 获取当前探渊状态
     * @param {object} player - 玩家对象
     * @returns {object} 探渊状态
     */
    async getExploreStatus(player) {
        if (!this.initialized) throw new Error('服务未初始化');

        const activeExplores = await SpiritBeastAbyssExplore.findAll({
            where: { player_id: player.id, status: 'active' },
            order: [['start_time', 'DESC']]
        });

        const result = [];
        for (const explore of activeExplores) {
            const beast = await SpiritBeast.findByPk(explore.beast_id);
            const now = new Date();
            const endTime = new Date(explore.end_time);
            const remainingSeconds = Math.max(0, Math.floor((endTime - now) / 1000));
            const isExpired = now >= endTime;

            result.push({
                explore_id: explore.id,
                beast_id: explore.beast_id,
                beast_name: beast ? beast.beast_name : '未知灵兽',
                beast_key: beast ? beast.beast_key : null,
                start_floor: explore.start_floor,
                max_floor_reached: explore.max_floor_reached,
                duration_hours: explore.duration_hours,
                start_time: explore.start_time,
                end_time: explore.end_time,
                remaining_seconds: remainingSeconds,
                is_expired: isExpired,
                stamina_used: explore.stamina_used
            });
        }

        // 今日已用次数：口径必须与 startExplore 里的每日上限校验完全一致
        // （玩家级、按当日 0 点起的 created_at），否则前端展示的余数会和服务端判定打架
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayCount = await SpiritBeastAbyssExplore.count({
            where: {
                player_id: player.id,
                created_at: { [Op.gte]: todayStart }
            }
        });

        return {
            data: {
                active_explores: result,
                active_count: result.length,
                max_concurrent: this.config.abyss.max_concurrent_beasts,
                daily_explores_today: todayCount,
                daily_limit: this.config.abyss.daily_explore_limit
            }
        };
    }

    /**
     * 获取探渊历史（已结算的记录）
     * @param {object} player - 玩家对象
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object} 探渊历史
     */
    async getExploreHistory(player, page = 1, pageSize = 10) {
        if (!this.initialized) throw new Error('服务未初始化');

        const limit = Math.min(50, Math.max(1, pageSize));
        const offset = (Math.max(1, page) - 1) * limit;

        const { rows, count } = await SpiritBeastAbyssExplore.findAndCountAll({
            where: {
                player_id: player.id,
                status: { [Op.ne]: 'active' }
            },
            order: [['created_at', 'DESC']],
            limit,
            offset
        });

        return {
            data: {
                history: rows.map(e => ({
                    explore_id: e.id,
                    beast_id: e.beast_id,
                    start_floor: e.start_floor,
                    max_floor_reached: e.max_floor_reached,
                    duration_hours: e.duration_hours,
                    start_time: e.start_time,
                    end_time: e.end_time,
                    actual_end_time: e.actual_end_time,
                    status: e.status,
                    recall_type: e.recall_type,
                    pvp_encounters: e.pvp_encounters,
                    pvp_wins: e.pvp_wins,
                    pvp_losses: e.pvp_losses,
                    monster_kills: e.monster_kills,
                    treasures_found: e.treasures_found,
                    traps_triggered: e.traps_triggered,
                    stamina_used: e.stamina_used,
                    beast_soul_gained: e.beast_soul_gained,
                    rewards: e.rewards_snapshot
                })),
                total: count,
                page: Math.max(1, page),
                page_size: limit
            }
        };
    }

    /**
     * 获取遭遇历史（某次探渊的遭遇日志）
     * @param {object} player - 玩家对象
     * @param {number} exploreId - 探渊记录ID
     * @returns {object} 遭遇历史
     */
    async getEncounterHistory(player, exploreId) {
        if (!this.initialized) throw new Error('服务未初始化');

        if (!exploreId || exploreId < 1) {
            throw new AppError('探渊记录ID无效', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验探渊记录归属
        const explore = await SpiritBeastAbyssExplore.findOne({
            where: { id: exploreId, player_id: player.id }
        });
        if (!explore) {
            throw new AppError('探渊记录不存在或不属于你', 404, ErrorCodes.NOT_FOUND);
        }

        const logs = await AbyssEncounterLog.findAll({
            where: { explore_id: exploreId },
            order: [['created_at', 'ASC']]
        });

        return {
            data: {
                explore_id: exploreId,
                encounters: logs.map(l => ({
                    log_id: l.id,
                    floor: l.floor,
                    encounter_type: l.encounter_type,
                    encounter_detail: l.encounter_detail,
                    result: l.result,
                    hp_after: l.hp_after,
                    stamina_after: l.stamina_after,
                    exp_gained: l.exp_gained,
                    items_gained: l.items_gained,
                    spirit_stones_gained: l.spirit_stones_gained,
                    beast_soul_gained: l.beast_soul_gained,
                    opponent_player_id: l.opponent_player_id,
                    opponent_beast_name: l.opponent_beast_name,
                    created_at: l.created_at
                }))
            }
        };
    }

    /**
     * 获取探渊排行榜
     * @param {string} category - 排行榜类别：deepest_floor/total_explore_count/total_pvp_wins
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object} 排行榜
     */
    async getRanking(category = 'deepest_floor', page = 1, pageSize = 20) {
        if (!this.initialized) throw new Error('服务未初始化');

        const validCategories = ['deepest_floor', 'total_explore_count', 'total_pvp_wins'];
        if (!validCategories.includes(category)) {
            throw new AppError(`排行榜类别无效，可选：${validCategories.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const limit = Math.min(this.config.ranking_config.page_size, Math.max(1, pageSize));
        const offset = (Math.max(1, page) - 1) * limit;

        // 根据类别构建查询
        let orderClause;
        let whereClause = { status: { [Op.ne]: 'active' } };

        if (category === 'deepest_floor') {
            orderClause = [['max_floor_reached', 'DESC'], ['created_at', 'DESC']];
        } else if (category === 'total_explore_count') {
            // 按玩家聚合探渊次数
            const playerStats = await SpiritBeastAbyssExplore.findAll({
                where: whereClause,
                attributes: [
                    'player_id',
                    [sequelize.fn('COUNT', sequelize.col('id')), 'explore_count'],
                    [sequelize.fn('MAX', sequelize.col('max_floor_reached')), 'max_floor']
                ],
                group: ['player_id'],
                order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']],
                limit,
                offset,
                raw: true
            });

            // 获取玩家昵称
            const playerIds = playerStats.map(s => s.player_id);
            const players = await Player.findAll({
                where: { id: playerIds },
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            });
            const playerMap = new Map(players.map(p => [p.id, p]));

            return {
                data: {
                    category: 'total_explore_count',
                    ranking: playerStats.map((s, idx) => {
                        const p = playerMap.get(s.player_id);
                        return {
                            rank: offset + idx + 1,
                            player_id: s.player_id,
                            nickname: p ? p.nickname : '未知',
                            realm: p ? p.realm : '未知',
                            explore_count: Number(s.explore_count),
                            max_floor: Number(s.max_floor)
                        };
                    }),
                    page: Math.max(1, page),
                    page_size: limit
                }
            };
        } else if (category === 'total_pvp_wins') {
            // 按玩家聚合PVP胜利数
            const playerStats = await SpiritBeastAbyssExplore.findAll({
                where: whereClause,
                attributes: [
                    'player_id',
                    [sequelize.fn('SUM', sequelize.col('pvp_wins')), 'total_wins'],
                    [sequelize.fn('SUM', sequelize.col('pvp_encounters')), 'total_encounters']
                ],
                group: ['player_id'],
                order: [[sequelize.fn('SUM', sequelize.col('pvp_wins')), 'DESC']],
                limit,
                offset,
                raw: true
            });

            const playerIds = playerStats.map(s => s.player_id);
            const players = await Player.findAll({
                where: { id: playerIds },
                attributes: ['id', 'nickname', 'realm', 'realm_rank']
            });
            const playerMap = new Map(players.map(p => [p.id, p]));

            return {
                data: {
                    category: 'total_pvp_wins',
                    ranking: playerStats.map((s, idx) => {
                        const p = playerMap.get(s.player_id);
                        return {
                            rank: offset + idx + 1,
                            player_id: s.player_id,
                            nickname: p ? p.nickname : '未知',
                            realm: p ? p.realm : '未知',
                            total_wins: Number(s.total_wins),
                            total_encounters: Number(s.total_encounters)
                        };
                    }),
                    page: Math.max(1, page),
                    page_size: limit
                }
            };
        }

        // deepest_floor 排行
        const { rows, count } = await SpiritBeastAbyssExplore.findAndCountAll({
            where: whereClause,
            order: orderClause,
            limit,
            offset
        });

        const playerIds = rows.map(r => r.player_id);
        const players = await Player.findAll({
            where: { id: playerIds },
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        const playerMap = new Map(players.map(p => [p.id, p]));

        return {
            data: {
                category: 'deepest_floor',
                ranking: rows.map((r, idx) => {
                    const p = playerMap.get(r.player_id);
                    return {
                        rank: offset + idx + 1,
                        explore_id: r.id,
                        player_id: r.player_id,
                        nickname: p ? p.nickname : '未知',
                        realm: p ? p.realm : '未知',
                        max_floor_reached: r.max_floor_reached,
                        duration_hours: r.duration_hours,
                        monster_kills: r.monster_kills,
                        pvp_wins: r.pvp_wins,
                        created_at: r.created_at
                    };
                }),
                total: count,
                page: Math.max(1, page),
                page_size: limit
            }
        };
    }

    // ==================== 调度器接口 ====================

    /**
     * 检查过期探渊并自动结算（调度器每60秒调用）
     */
    async checkExpirations() {
        if (!this.initialized) return;

        const batchSize = this.config.abyss.scheduler?.batch_size || 50;
        const now = new Date();

        // 查询已过期但未结算的探渊记录
        const expiredExplores = await SpiritBeastAbyssExplore.findAll({
            where: {
                status: 'active',
                end_time: { [Op.lte]: now }
            },
            limit: batchSize,
            order: [['end_time', 'ASC']]
        });

        for (const explore of expiredExplores) {
            try {
                const t = await sequelize.transaction();
                try {
                    await this._settleExplore(explore, 'auto', t);
                    await t.commit();
                } catch (e) {
                    if (t && !t.finished) await t.rollback();
                    console.error(`[BeastAbyss] 探渊 ${explore.id} 自动结算失败:`, e.message);
                }
            } catch (e) {
                console.error(`[BeastAbyss] 探渊 ${explore.id} 结算异常:`, e.message);
            }
        }
    }

    // ==================== 内部方法 ====================

    /**
     * 创建灵兽快照
     * @private
     */
    _createBeastSnapshot(beast) {
        // 字段清单收在 game/stats/beastView.js：探渊这份历史上是 Number 型 hp_max 且带 stamina，形状保持不变
        return beastSnapshot(beast, { hpMaxAs: 'number', includeStamina: true });
    }

    /**
     * 结算探渊（核心方法）
     * 模拟所有遭遇事件，计算奖励，更新灵兽状态
     * @private
     */
    async _settleExplore(explore, recallType, transaction) {
        // 重新查询并加锁
        const exploreLocked = await SpiritBeastAbyssExplore.findByPk(explore.id, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!exploreLocked || exploreLocked.status !== 'active') {
            return { message: '探渊记录已结算', data: { explore_id: explore.id } };
        }

        // 取锁次序（口径见 game/persistence/lockOrder.js）：players 先于 spirit_beasts。
        // 改造前是 explore → beast → …… → players：本服务（玩家召回 + index.js 里周期跑的 checkExpirations）
        // 持着灵兽行去等 players，而玩家那边喂灵兽/放归/巡边归来都是 players→beast —— 一先一后就成环。
        const player = await Player.findByPk(exploreLocked.player_id, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        const beast = await SpiritBeast.findByPk(exploreLocked.beast_id, {
            transaction,
            lock: transaction.LOCK.UPDATE
        });
        if (!beast) {
            // 灵兽不存在，直接关闭探渊记录
            exploreLocked.status = 'recalled';
            exploreLocked.recall_type = recallType;
            exploreLocked.actual_end_time = new Date();
            await exploreLocked.save({ transaction });
            return { message: '灵兽不存在，探渊已关闭', data: { explore_id: explore.id } };
        }

        const snapshot = exploreLocked.beast_snapshot || this._createBeastSnapshot(beast);
        const abyssConfig = this.config.abyss;
        const recallConfig = this.config.recall_config;

        // 计算实际探索时长
        const startTime = new Date(exploreLocked.start_time);
        const now = new Date();
        const actualDurationHours = (now - startTime) / (3600 * 1000);

        // 计算可探索的层数（1层/小时，向上取整，最少1层）
        let floorsToExplore = Math.max(1, Math.floor(actualDurationHours));

        // 提前召回惩罚：层数减半
        let floorPenalty = 1.0;
        let expPenalty = 1.0;
        if (recallType === 'early') {
            floorPenalty = recallConfig.early_recall_floor_penalty;
            expPenalty = recallConfig.early_recall_exp_penalty;
            floorsToExplore = Math.max(1, Math.floor(floorsToExplore * floorPenalty));
        }

        // 限制最大层数
        const maxFloor = this.config.abyss.total_floors;
        floorsToExplore = Math.min(floorsToExplore, maxFloor);

        // 模拟遭遇事件
        const events = [];
        let currentHp = snapshot.hp_max;
        let currentStamina = snapshot.stamina || beast.stamina;
        let totalExp = 0;
        let totalSpiritStones = 0;
        const totalItems = [];
        let totalBeastSoul = 0;
        let pvpEncounters = 0;
        let pvpWins = 0;
        let pvpLosses = 0;
        let monsterKills = 0;
        let treasuresFound = 0;
        let trapsTriggered = 0;
        let maxFloorReached = exploreLocked.start_floor;
        let injured = false;

        // 灵兽当前层数从起始层开始
        let currentFloor = exploreLocked.start_floor;

        // 灵兽主人的境界门槛：读那份已加锁的 players 行。
        // 原来写的是 beast.player?.realm_rank —— 取灵兽那没带 include，这个关联属性永远是 undefined，
        // 于是门槛恒等于 1：floors 里 2~9 层要求 realm_rank 3/6/11/…/26，**谁都进不去**，
        // 探渊收益被静默卡在首层，而内容看起来是"九层都配好了"。
        const ownerRealmRank = Number(player && player.realm_rank) || 1;

        for (let i = 0; i < floorsToExplore; i++) {
            // 检查HP和体力
            if (currentHp <= 0) {
                injured = true;
                break;
            }
            if (currentStamina <= 0 && abyssConfig.auto_recall_on_stamina_zero) {
                break;
            }

            // 检查境界限制
            const floorConfig = this.config.floors.find(f => f.floor === currentFloor);
            if (!floorConfig) break;
            if (floorConfig.min_realm_rank > ownerRealmRank) {
                // 灵兽主人境界不足，不能进入更高层
                break;
            }

            maxFloorReached = Math.max(maxFloorReached, currentFloor);

            // 模拟遭遇（根据事件类型权重）
            const encounterType = this._rollEncounterType(floorConfig);
            let encounterResult;

            if (encounterType === 'monster') {
                encounterResult = this._battleMonster(beast, snapshot, floorConfig, currentHp);
                if (encounterResult.victory) {
                    monsterKills++;
                    totalExp += Math.floor(encounterResult.exp_gain * expPenalty);
                    if (encounterResult.drops) {
                        for (const drop of encounterResult.drops) {
                            totalItems.push(drop);
                        }
                    }
                }
                currentHp = encounterResult.hp_after;
                if (encounterResult.spirit_stones > 0) {
                    totalSpiritStones += encounterResult.spirit_stones;
                }
            } else if (encounterType === 'treasure') {
                encounterResult = this._rollTreasure(floorConfig, currentHp);
                treasuresFound++;
                if (encounterResult.items) {
                    for (const item of encounterResult.items) {
                        totalItems.push(item);
                    }
                }
                totalSpiritStones += encounterResult.spirit_stones || 0;
                currentHp = encounterResult.hp_after;
            } else if (encounterType === 'trap') {
                encounterResult = this._triggerTrap(floorConfig, currentHp, currentStamina);
                trapsTriggered++;
                currentHp = encounterResult.hp_after;
                currentStamina = encounterResult.stamina_after;
                if (encounterResult.exp_loss > 0) {
                    totalExp = Math.max(0, totalExp - encounterResult.exp_loss);
                }
            } else if (encounterType === 'pvp') {
                // PVP遭遇：查找同层探索的其他玩家灵兽
                const opponent = await this._findPvpOpponent(exploreLocked.player_id, currentFloor, transaction);
                if (opponent) {
                    encounterResult = await this._battlePlayer(beast, snapshot, opponent, floorConfig, currentHp, transaction);
                    pvpEncounters++;
                    if (encounterResult.victory) {
                        pvpWins++;
                        totalExp += Math.floor(encounterResult.exp_gain * expPenalty);
                        if (encounterResult.loot) {
                            for (const item of encounterResult.loot) {
                                totalItems.push(item);
                            }
                        }
                        totalSpiritStones += encounterResult.spirit_stones || 0;
                    } else {
                        pvpLosses++;
                        // 失败损失部分经验
                        totalExp = Math.max(0, totalExp - Math.floor(encounterResult.exp_loss * expPenalty));
                    }
                    currentHp = encounterResult.hp_after;
                } else {
                    // 没有对手，改为怪物遭遇
                    encounterResult = this._battleMonster(beast, snapshot, floorConfig, currentHp);
                    if (encounterResult.victory) {
                        monsterKills++;
                        totalExp += Math.floor(encounterResult.exp_gain * expPenalty);
                        if (encounterResult.drops) {
                            for (const drop of encounterResult.drops) {
                                totalItems.push(drop);
                            }
                        }
                    }
                    currentHp = encounterResult.hp_after;
                }
            }

            // 记录遭遇事件
            events.push({
                floor: currentFloor,
                encounter_type: encounterType,
                result: encounterResult.victory !== undefined ? (encounterResult.victory ? 'victory' : 'defeat') : 'triggered',
                hp_after: currentHp,
                stamina_after: currentStamina,
                exp_gained: encounterResult.exp_gain || 0,
                items_gained: encounterResult.drops || encounterResult.items || encounterResult.loot || [],
                spirit_stones_gained: encounterResult.spirit_stones || 0,
                opponent_player_id: encounterResult.opponent_player_id || null,
                opponent_beast_name: encounterResult.opponent_beast_name || null
            });

            // 消耗体力
            const staminaCost = floorConfig.stamina_cost_per_floor || 10;
            currentStamina = Math.max(0, currentStamina - staminaCost);

            // 进入下一层
            currentFloor++;
            if (currentFloor > maxFloor) break;
        }

        // 计算兽魂（满级灵兽经验凝成兽魂）
        const beastSoulConfig = this.config.beast_soul_config;
        let beastSoulGained = 0;
        // 简化判断：等级>=50视为满级（可配置）
        const maxLevel = 50;
        if (snapshot.level >= maxLevel && totalExp > 0) {
            const soulRatio = beastSoulConfig.exp_to_soul_ratio || 1000;
            const minExp = beastSoulConfig.min_exp_for_soul || 100;
            if (totalExp >= minExp) {
                beastSoulGained = Math.floor(totalExp / soulRatio);
            }
        }

        // 更新探渊记录
        exploreLocked.max_floor_reached = maxFloorReached;
        exploreLocked.status = injured ? 'injured' : 'recalled';
        exploreLocked.recall_type = injured ? 'injured' : recallType;
        exploreLocked.actual_end_time = now;
        exploreLocked.events_snapshot = events;
        exploreLocked.rewards_snapshot = {
            total_exp: totalExp,
            total_spirit_stones: totalSpiritStones,
            total_items: totalItems,
            beast_soul: beastSoulGained
        };
        exploreLocked.pvp_encounters = pvpEncounters;
        exploreLocked.pvp_wins = pvpWins;
        exploreLocked.pvp_losses = pvpLosses;
        exploreLocked.monster_kills = monsterKills;
        exploreLocked.treasures_found = treasuresFound;
        exploreLocked.traps_triggered = trapsTriggered;
        exploreLocked.stamina_used = snapshot.stamina - currentStamina;
        exploreLocked.beast_soul_gained = beastSoulGained;
        await exploreLocked.save({ transaction });

        // 更新灵兽状态
        beast.is_exploring = false;
        // 恢复HP到满值（探渊结束后灵兽HP恢复）
        const beastHpMax = BigInt(snapshot.hp_max);
        beast.hp_max = beastHpMax;
        // 设置受伤状态（HP归零后需2小时恢复）
        if (injured) {
            const injuryHours = abyssConfig.beast_hp_injury_recover_hours || 2;
            beast.injury_until = new Date(now.getTime() + injuryHours * 3600 * 1000);
        }
        await beast.save({ transaction });

        // 发放奖励给玩家：用开头那次已加锁的 players 实例（原来在这里又 FOR UPDATE 读一次同一行，
        // 既留下第二份互相覆盖的实例，也让取锁次序看着像 beast→players 的反向）
        if (player) {
            // 增加灵石
            if (totalSpiritStones > 0) {
                player.spirit_stones = BigInt(player.spirit_stones || 0) + BigInt(totalSpiritStones);
            }
            // 增加修为（经验转化为玩家修为的10%）
            if (totalExp > 0) {
                const playerExpGain = Math.floor(totalExp * 0.1);
                player.exp = BigInt(player.exp || 0) + BigInt(playerExpGain);
            }
            await player.save({ transaction });

            // 发放物品到背包：没发到的不能继续留在 totalItems 里 —— 它同时是 items_gained 的来源，
            // 留着就是"面板与日志说玩家拿到了，背包里却没有"（见 game/items/itemGrant.js）
            const payable = totalItems.filter(i => i.qty > 0 && i.item_id && !i.is_spirit_stone);
            const grant = await grantItems(player.id, payable, transaction, { label: '探渊奖励' });
            const grantedKeys = new Set(grant.granted.map(g => g.item_key));
            for (let i = totalItems.length - 1; i >= 0; i--) {
                const it = totalItems[i];
                if (payable.includes(it) && !grantedKeys.has(it.item_id)) totalItems.splice(i, 1);
            }
        }

        // 记录遭遇日志到数据库
        for (const event of events) {
            await AbyssEncounterLog.create({
                explore_id: exploreLocked.id,
                player_id: exploreLocked.player_id,
                beast_id: exploreLocked.beast_id,
                floor: event.floor,
                encounter_type: event.encounter_type,
                encounter_detail: event.encounter_detail || null,
                result: event.result,
                hp_after: event.hp_after,
                stamina_after: event.stamina_after,
                exp_gained: event.exp_gained || 0,
                items_gained: event.items_gained || null,
                spirit_stones_gained: event.spirit_stones_gained || 0,
                beast_soul_gained: 0,
                opponent_player_id: event.opponent_player_id || null,
                opponent_beast_id: event.opponent_beast_id || null,
                opponent_beast_name: event.opponent_beast_name || null
            }, { transaction });
        }

        return {
            message: injured ? '探渊结束（灵兽受伤返回）' : '探渊已结算',
            data: {
                explore_id: exploreLocked.id,
                beast_id: exploreLocked.beast_id,
                beast_name: beast.beast_name,
                recall_type: exploreLocked.recall_type,
                max_floor_reached: maxFloorReached,
                floors_explored: events.length,
                duration_hours: Math.floor(actualDurationHours * 10) / 10,
                pvp_encounters: pvpEncounters,
                pvp_wins: pvpWins,
                pvp_losses: pvpLosses,
                monster_kills: monsterKills,
                treasures_found: treasuresFound,
                traps_triggered: trapsTriggered,
                stamina_used: snapshot.stamina - currentStamina,
                rewards: {
                    total_exp: totalExp,
                    total_spirit_stones: totalSpiritStones,
                    total_items: totalItems.filter(i => !i.is_spirit_stone),
                    beast_soul: beastSoulGained
                },
                injured: injured,
                injury_until: beast.injury_until
            }
        };
    }

    /**
     * 掷骰决定遭遇类型
     * @private
     */
    _rollEncounterType(floorConfig) {
        const eventTypes = this.config.event_types;
        const pvpRate = floorConfig.pvp_encounter_rate || 0.20;

        // 调整PVP概率
        const weights = {
            monster: eventTypes.monster.weight,
            treasure: eventTypes.treasure.weight,
            trap: eventTypes.trap.weight,
            pvp: Math.floor(eventTypes.pvp.weight * (pvpRate / 0.20)) // 按楼层PVP概率调整
        };

        const totalWeight = weights.monster + weights.treasure + weights.trap + weights.pvp;
        let roll = Math.random() * totalWeight;

        if (roll < weights.monster) return 'monster';
        roll -= weights.monster;
        if (roll < weights.treasure) return 'treasure';
        roll -= weights.treasure;
        if (roll < weights.trap) return 'trap';
        return 'pvp';
    }

    /**
     * 与怪物战斗（PVE）
     * @private
     */
    _battleMonster(beast, snapshot, floorConfig, currentHp) {
        // 随机选择怪物
        const monsters = floorConfig.monsters;
        const monster = monsters[Math.floor(Math.random() * monsters.length)];

        // 计算元素克制
        const elementMult = this._getElementMultiplier(snapshot.element, monster.element);

        // 这只怪有什么数值：层难度整块缩放，再并上内容声明层（stats / power_multiplier）。
        // 以前这里是 `Number(monster.atk) * difficulty` 逐字段手写三行，给怪加一个属性就得
        // 记得回来补一行，漏的那个字段于是"不吃难度"；现在块里有什么就缩放什么。
        const monsterStats = withDeclaredStats(
            scaleStatBlock(monster, floorConfig.monster_difficulty),
            monster
        );
        const beastStats = {
            atk: Math.floor(Number(snapshot.atk) * elementMult),
            def: Number(snapshot.def),
            hp_max: currentHp
        };

        // 简化战斗：比的是"谁先打死谁"所需的回合数（档位在 combat_formulas.json 的 beast_abyss_round）
        const damageToMonster = this._roundDamage(beastStats, monsterStats);
        const damageToBeast = this._roundDamage(monsterStats, beastStats);
        const roundsToKillMonster = Math.ceil(Number(monsterStats.hp) / damageToMonster);
        const roundsToKillBeast = Math.ceil(currentHp / damageToBeast);

        const victory = roundsToKillMonster <= roundsToKillBeast;

        // 计算HP损失
        let hpAfter = currentHp;
        if (victory) {
            // 胜利：损失怪物造成的伤害
            hpAfter = Math.max(0, currentHp - Math.floor(damageToBeast * roundsToKillMonster));
        } else {
            // 失败：HP归零
            hpAfter = 0;
        }

        // 计算奖励
        const expGain = victory ? Math.floor(monster.exp_reward * floorConfig.reward_multiplier) : 0;
        const drops = victory ? this._rollDrops(floorConfig) : [];
        const spiritStones = victory ? this._rollSpiritStones(floorConfig) : 0;

        return {
            victory,
            hp_after: hpAfter,
            exp_gain: expGain,
            drops: drops,
            spirit_stones: spiritStones,
            encounter_detail: {
                monster_key: monster.key,
                monster_name: monster.name,
                monster_element: monster.element,
                monster_hp: Number(monsterStats.hp),
                rounds: victory ? roundsToKillMonster : roundsToKillBeast
            }
        };
    }

    /**
     * 一回合打多少血：与野外/副本/兽潮同一套结算，不再在服务里抄"攻 - 防×0.5"。
     * 档位里 random_range=0、procs 关掉，所以同一个输入永远得到同一个输出（探渊要可复现）。
     * @private
     */
    _roundDamage(attackerStats, defenderStats) {
        return CombatResolver.computeDamage('beast_abyss_round', { attackerStats, defenderStats }).damage;
    }

    /**
     * 与玩家灵兽战斗（PVP）
     * @private
     */
    async _battlePlayer(beast, snapshot, opponent, floorConfig, currentHp, transaction) {
        // 获取对手灵兽快照
        const opponentBeast = await SpiritBeast.findByPk(opponent.beast_id, { transaction });
        if (!opponentBeast) {
            // 对手灵兽不存在，返回失败
            return {
                victory: false,
                hp_after: currentHp,
                exp_gain: 0,
                exp_loss: 0,
                loot: [],
                spirit_stones: 0,
                opponent_player_id: opponent.player_id,
                opponent_beast_name: '未知灵兽'
            };
        }

        // 计算元素克制
        const elementMult = this._getElementMultiplier(snapshot.element, opponentBeast.element);
        const reverseElementMult = this._getElementMultiplier(opponentBeast.element, snapshot.element);

        // 简化战斗：与打野怪同一条回合公式（档位见 combat_formulas.json），只是对手换成别的玩家的灵兽
        const beastStats = {
            atk: Math.floor(Number(snapshot.atk) * elementMult),
            def: Number(snapshot.def),
            hp_max: currentHp
        };
        const opponentStats = {
            atk: Math.floor(Number(opponentBeast.atk) * reverseElementMult),
            def: Number(opponentBeast.def),
            hp_max: Number(opponentBeast.hp_max)
        };

        const damageToOpponent = this._roundDamage(beastStats, opponentStats);
        const damageToBeast = this._roundDamage(opponentStats, beastStats);
        const roundsToKillOpponent = Math.ceil(opponentStats.hp_max / damageToOpponent);
        const roundsToKillBeast = Math.ceil(currentHp / damageToBeast);

        const victory = roundsToKillOpponent <= roundsToKillBeast;

        let hpAfter = currentHp;
        if (victory) {
            hpAfter = Math.max(0, currentHp - Math.floor(damageToBeast * roundsToKillOpponent));
        } else {
            hpAfter = 0;
        }

        // PVP奖励
        const abyssConfig = this.config.abyss;
        const expGain = victory ? Math.floor(50 * floorConfig.reward_multiplier) : 0;
        const expLoss = !victory ? Math.floor(50 * abyssConfig.pvp_loser_exp_loss_ratio * floorConfig.reward_multiplier) : 0;
        const spiritStones = victory ? Math.floor(30 * floorConfig.reward_multiplier) : 0;
        const loot = victory ? this._rollDrops(floorConfig) : [];

        return {
            victory,
            hp_after: hpAfter,
            exp_gain: expGain,
            exp_loss: expLoss,
            loot: loot,
            spirit_stones: spiritStones,
            opponent_player_id: opponent.player_id,
            opponent_beast_id: opponent.beast_id,
            opponent_beast_name: opponentBeast.beast_name
        };
    }

    /**
     * 查找PVP对手（同层探索的其他玩家灵兽）
     * @private
     */
    async _findPvpOpponent(currentPlayerId, floor, transaction) {
        // 查找同层探索中的其他玩家灵兽（活跃探渊记录）
        const candidates = await SpiritBeastAbyssExplore.findAll({
            where: {
                player_id: { [Op.ne]: currentPlayerId },
                status: 'active',
                start_floor: { [Op.lte]: floor },
                max_floor_reached: { [Op.gte]: floor }
            },
            limit: 10,
            transaction
        });

        if (candidates.length === 0) return null;

        // 随机选择一个对手
        const opponent = candidates[Math.floor(Math.random() * candidates.length)];
        return {
            player_id: opponent.player_id,
            beast_id: opponent.beast_id
        };
    }

    /**
     * 掷宝箱奖励
     * @private
     */
    _rollTreasure(floorConfig, currentHp) {
        const treasureConfig = this.config.treasure_config;
        const itemCount = Math.floor(Math.random() * (treasureConfig.max_items - treasureConfig.min_items + 1)) + treasureConfig.min_items;

        const items = [];
        const spiritStonesRange = treasureConfig.spirit_stone_range || [20, 100];
        const spiritStones = Math.floor(Math.random() * (spiritStonesRange[1] - spiritStonesRange[0] + 1)) + spiritStonesRange[0];
        const totalSpiritStones = Math.floor(spiritStones * floorConfig.reward_multiplier);

        // 随机选择物品
        for (let i = 0; i < itemCount; i++) {
            const drops = floorConfig.drops;
            if (drops && drops.length > 0) {
                const drop = drops[Math.floor(Math.random() * drops.length)];
                const qty = Math.floor(Math.random() * (drop.max_qty - drop.min_qty + 1)) + drop.min_qty;
                items.push({
                    item_id: drop.item_id,
                    name: drop.name,
                    qty: qty,
                    is_spirit_stone: drop.is_spirit_stone || false
                });
            }
        }

        return {
            items: items,
            spirit_stones: totalSpiritStones,
            hp_after: currentHp
        };
    }

    /**
     * 触发陷阱
     * @private
     */
    _triggerTrap(floorConfig, currentHp, currentStamina) {
        const trapConfig = this.config.trap_config;
        const hpLoss = Math.floor(currentHp * trapConfig.hp_loss_ratio);
        const staminaLoss = trapConfig.stamina_loss || 15;
        const expLoss = trapConfig.exp_loss_ratio || 0.03;

        return {
            hp_after: Math.max(0, currentHp - hpLoss),
            stamina_after: Math.max(0, currentStamina - staminaLoss),
            exp_loss: Math.floor(100 * expLoss * floorConfig.reward_multiplier)
        };
    }

    /**
     * 掷掉落物品
     * @private
     */
    _rollDrops(floorConfig) {
        const drops = floorConfig.drops;
        if (!drops || drops.length === 0) return [];

        const result = [];
        for (const drop of drops) {
            // 按权重掷骰
            if (Math.random() * 100 < drop.weight) {
                const qty = Math.floor(Math.random() * (drop.max_qty - drop.min_qty + 1)) + drop.min_qty;
                result.push({
                    item_id: drop.item_id,
                    name: drop.name,
                    qty: qty,
                    is_spirit_stone: drop.is_spirit_stone || false
                });
            }
        }
        return result;
    }

    /**
     * 掷灵石奖励
     * @private
     */
    _rollSpiritStones(floorConfig) {
        const drops = floorConfig.drops.filter(d => d.is_spirit_stone);
        if (drops.length === 0) return 0;

        const drop = drops[0];
        const qty = Math.floor(Math.random() * (drop.max_qty - drop.min_qty + 1)) + drop.min_qty;
        return qty;
    }

    /**
     * 计算五行相克倍率
     * @private
     */
    _getElementMultiplier(attackerElement, defenderElement) {
        // dark元素无克制关系
        if (attackerElement === 'dark' || defenderElement === 'dark') {
            return 1.0;
        }

        const elements = this.config.elements || {
            metal: { strong_against: 'wood', weak_against: 'fire' },
            wood: { strong_against: 'earth', weak_against: 'metal' },
            water: { strong_against: 'fire', weak_against: 'earth' },
            fire: { strong_against: 'metal', weak_against: 'water' },
            earth: { strong_against: 'water', weak_against: 'wood' }
        };

        const attackerConfig = elements[attackerElement];
        if (!attackerConfig) return 1.0;

        if (attackerConfig.strong_against === defenderElement) {
            return 1.5; // 强克制
        }
        if (attackerConfig.weak_against === defenderElement) {
            return 0.75; // 弱克制
        }
        return 1.0; // 普通
    }
}

module.exports = new BeastAbyssService();
