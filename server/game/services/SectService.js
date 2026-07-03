/**
 * 宗门业务服务模块
 *
 * 处理宗门系统全部核心玩法逻辑：拜入/叛出宗门、每日点卯、宗门传功、
 * 宝库兑换、宗门日常任务等。
 *
 * 设计说明：
 *   - 宗门静态数据（名称、描述、宝库、任务）从 sect_data.json 读取（配置中心化）
 *   - 玩家在宗门中的动态数据（贡献度、身份、点卯/传功时间、任务进度）存 player_sects 表
 *   - 点卯/传功奖励数值从 game_balance.sect 配置读取，禁止硬编码
 *   - 所有写操作使用事务保证数据一致性，事务回滚前检查 t.finished 防止重复回滚
 *   - 兑换宝库物品时复用 InventoryService.addItem，避免重复实现背包入库逻辑
 */
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerSect = require('../../models/playerSect');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class SectService {
    constructor() {
        // 配置加载器，通过 initialize 注入（与 InventoryService 风格一致）
        this.configLoader = null;
    }

    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 懒加载获取宗门静态配置（sect_data.json）
     * @returns {Array} 宗门配置数组
     */
    getSectConfig() {
        return this.configLoader?.getConfig('sect_data')?.sects || [];
    }

    /**
     * 获取宗门数值平衡配置（game_balance.sect）
     * 包含点卯/传功的奖励与冷却参数
     * @returns {Object} 宗门平衡配置
     */
    getBalanceConfig() {
        return this.configLoader?.getConfig('game_balance')?.sect || {};
    }

    /**
     * 获取 GM 管理后台数值配置（game_balance.admin）
     * 包含宗门成员列表分页、贡献度上下限等参数
     * @returns {Object} 管理后台配置
     */
    getAdminConfig() {
        return this.configLoader?.getConfig('game_balance')?.admin || {};
    }

    /**
     * 根据宗门ID查找宗门静态配置
     * @param {string} sectId - 宗门ID
     * @returns {Object|null} 宗门配置，未找到返回 null
     */
    findSectById(sectId) {
        return this.getSectConfig().find(s => s.id === sectId) || null;
    }

    /**
     * 获取玩家宗门加成（供其他服务调用，如采集/经验/突破流程）
     *
     * 业务说明：
     *   - 该方法不依赖事务，仅做只读查询，可在各业务流程的加成计算阶段调用
     *   - 调用方应使用 try-catch 包裹，避免宗门加成获取失败阻断主流程
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 宗门加成对象，未加入宗门或配置缺失时返回空对象 {}
     *   返回结构示例：{
     *     sect_id: 'luoyun',
     *     sect_name: '落云宗',
     *     bonus: { exp_multiplier: 1.1, gather_bonus: 0.15 },
     *     contribution: 100,
     *     role: 'disciple'
     *   }
     */
    async getPlayerSectBonus(playerId) {
        // 查询玩家宗门动态记录（贡献度、身份等）
        const playerSect = await PlayerSect.findOne({
            where: { player_id: playerId }
        });
        // 未加入宗门，返回空对象，调用方按"无加成"处理
        if (!playerSect) return {};

        // 获取宗门静态配置（含 bonus 加成字段）
        const sect = this.findSectById(playerSect.sect_id);
        // 配置缺失或无 bonus 字段，返回空对象避免下游空指针
        if (!sect || !sect.bonus) return {};

        // 返回宗门加成信息，供采集/经验/突破等流程使用
        return {
            sect_id: sect.id,
            sect_name: sect.name,
            bonus: sect.bonus,
            contribution: playerSect.contribution,
            role: playerSect.role
        };
    }

    /**
     * 获取境界排名（用于境界要求校验）
     * 通过 realm_breakthrough 配置查找境界名对应的 rank
     * @param {string} realmName - 境界名称
     * @returns {number} 境界排名，未找到返回 -1
     */
    _getRealmRank(realmName) {
        const realms = this.configLoader?.getConfig('realm_breakthrough')?.realms || [];
        const realm = realms.find(r => r.name === realmName);
        return realm ? realm.rank : -1;
    }

    /**
     * 获取玩家当前境界排名
     * 优先使用 player.realm_rank（模型已维护），找不到再查配置兜底
     * @param {Object} player - 玩家实例
     * @returns {number} 境界排名
     */
    _getPlayerRealmRank(player) {
        if (player.realm_rank != null) {
            return player.realm_rank;
        }
        // 兜底：通过境界名查配置
        return this._getRealmRank(player.realm);
    }

    /**
     * 获取所有宗门列表（基础信息，不包含宝库和任务详情）
     * @returns {Array} 宗门基础信息列表
     */
    getSectList() {
        return this.getSectConfig().map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            alignment: s.alignment,
            element: s.element,
            join_requirement: s.join_requirement,
            bonus: s.bonus
        }));
    }

    /**
     * 获取宗门详情（包含宝库和任务）
     * @param {string} sectId - 宗门ID
     * @returns {Object} 宗门完整信息
     */
    getSectDetail(sectId) {
        const sect = this.findSectById(sectId);
        if (!sect) {
            throw new AppError('宗门不存在', 404, ErrorCodes.NOT_FOUND);
        }
        // 返回完整信息，含宝库和任务
        return sect;
    }

    /**
     * 拜入宗门
     * 校验境界要求、灵石消耗、是否已加入其他宗门；扣灵石、创建 PlayerSect 记录
     * @param {number} playerId - 玩家ID
     * @param {string} sectId - 宗门ID
     * @returns {Promise<Object>} 拜入结果
     */
    async joinSect(playerId, sectId) {
        const sect = this.findSectById(sectId);
        if (!sect) {
            throw new AppError('宗门不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const t = await sequelize.transaction();
        try {
            // 加锁查询玩家，防止并发拜入
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                throw new AppError('已陨落，无法拜入宗门', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验是否已加入其他宗门
            const existing = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            if (existing) {
                throw new AppError('已加入宗门，请先叛出后再拜入', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验境界要求：优先用 realm_breakthrough 配置查 rank，查不到则用 default_min_realm_rank 兜底
            const requirement = sect.join_requirement || {};
            let requiredRank = this._getRealmRank(requirement.realm_min);
            if (requiredRank < 0) {
                // 配置数据不一致时（如 sect_data 用"炼气初期"而境界表用"炼气1层"），用配置兜底值
                requiredRank = this.getBalanceConfig().default_min_realm_rank ?? 1;
            }
            const playerRank = this._getPlayerRealmRank(player);
            if (playerRank < requiredRank) {
                throw new AppError(
                    `境界不足，加入【${sect.name}】至少需要达到 ${requirement.realm_min}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 校验并扣除灵石
            const cost = requirement.spirit_stones || 0;
            if (cost > 0) {
                if (BigInt(player.spirit_stones || 0) < BigInt(cost)) {
                    throw new AppError(
                        `灵石不足，加入【${sect.name}】需要 ${cost} 灵石`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
                player.spirit_stones = BigInt(player.spirit_stones) - BigInt(cost);
            }

            // 创建宗门成员记录
            await PlayerSect.create({
                player_id: playerId,
                sect_id: sectId,
                contribution: 0,
                role: 'disciple',
                joined_at: new Date(),
                daily_quests_completed: [],
                quests_reset_at: this._getNextResetTime()
            }, { transaction: t });

            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `成功拜入【${sect.name}】`,
                sect: {
                    id: sect.id,
                    name: sect.name,
                    alignment: sect.alignment,
                    element: sect.element
                },
                spirit_stones: player.spirit_stones.toString()
            };
        } catch (error) {
            // 事务回滚前检查是否已完成，防止重复回滚报错
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 叛出宗门
     * 清除 PlayerSect 记录（贡献度随之清空，符合"叛门"的代价）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 叛出结果
     */
    async leaveSect(playerId) {
        const t = await sequelize.transaction();
        try {
            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            if (!playerSect) {
                throw new AppError('尚未加入任何宗门', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const sect = this.findSectById(playerSect.sect_id);
            const sectName = sect?.name || playerSect.sect_id;

            // 删除宗门成员记录，贡献度随之清空
            await playerSect.destroy({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `已叛出【${sectName}】，宗门贡献度已清空`
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 获取我的宗门信息（合并静态配置 + 动态成员数据）
     * 后端权威计算点卯/传功冷却剩余毫秒，避免前端硬编码冷却时长导致不一致
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object|null>} 宗门信息，未加入返回 null
     */
    async getMySect(playerId) {
        const playerSect = await PlayerSect.findOne({
            where: { player_id: playerId }
        });
        if (!playerSect) {
            return null;
        }

        // 读取宗门数值平衡配置，获取冷却时长（小时）
        const balance = this.getBalanceConfig();
        const checkinCooldownHours = balance.checkin_cooldown_hours ?? 24;
        const transferCooldownHours = balance.transfer_cooldown_hours ?? 24;
        const checkinCooldownMs = checkinCooldownHours * 3600 * 1000;
        const transferCooldownMs = transferCooldownHours * 3600 * 1000;

        // 后端权威计算点卯/传功冷却剩余毫秒（避免前端硬编码 24h 且存在时钟漂移）
        const now = new Date();
        const computeRemainingMs = (lastTime, cooldownMs) => {
            if (!lastTime) return 0;
            const lastTs = new Date(lastTime).getTime();
            if (isNaN(lastTs)) return 0;
            const remain = lastTs + cooldownMs - now.getTime();
            return remain > 0 ? remain : 0;
        };
        const checkinCooldownRemainingMs = computeRemainingMs(playerSect.last_check_in, checkinCooldownMs);
        const transferCooldownRemainingMs = computeRemainingMs(playerSect.last_transfer, transferCooldownMs);

        const sect = this.findSectById(playerSect.sect_id);
        if (!sect) {
            // 静态配置丢失，仅返回动态数据避免接口报错
            return {
                sect_id: playerSect.sect_id,
                name: '未知宗门',
                description: '宗门配置已失效',
                contribution: playerSect.contribution,
                role: playerSect.role,
                joined_at: playerSect.joined_at,
                last_check_in: playerSect.last_check_in,
                last_transfer: playerSect.last_transfer,
                // 冷却剩余毫秒（后端权威计算）
                checkin_cooldown_remaining_ms: checkinCooldownRemainingMs,
                transfer_cooldown_remaining_ms: transferCooldownRemainingMs,
                // 服务端时间戳（毫秒），供前端基于此 tick 计算实时剩余，避免时钟漂移
                server_time: now.getTime(),
                config_missing: true
            };
        }

        // 合并静态配置与动态成员数据
        return {
            sect_id: sect.id,
            name: sect.name,
            description: sect.description,
            alignment: sect.alignment,
            element: sect.element,
            bonus: sect.bonus,
            contribution: playerSect.contribution,
            role: playerSect.role,
            joined_at: playerSect.joined_at,
            last_check_in: playerSect.last_check_in,
            last_transfer: playerSect.last_transfer,
            // 冷却剩余毫秒（后端权威计算，前端直接展示，避免硬编码冷却时长）
            checkin_cooldown_remaining_ms: checkinCooldownRemainingMs,
            transfer_cooldown_remaining_ms: transferCooldownRemainingMs,
            // 服务端时间戳（毫秒），供前端基于此 tick 计算实时剩余，避免时钟漂移
            server_time: now.getTime()
        };
    }

    /**
     * 每日点卯
     * 校验是否已加入、是否在冷却中（24小时）；奖励贡献度+修为，数值从配置读取
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 点卯结果
     */
    async dailyCheckIn(playerId) {
        const balance = this.getBalanceConfig();
        const rewardContribution = balance.checkin_contribution ?? 10;
        const rewardExp = balance.checkin_exp ?? 50;
        const cooldownHours = balance.checkin_cooldown_hours ?? 24;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!playerSect) {
                throw new AppError('尚未加入宗门，无法点卯', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验点卯冷却（24小时内仅可点卯一次）
            const now = new Date();
            if (playerSect.last_check_in) {
                const cooldownMs = cooldownHours * 3600 * 1000;
                const nextAvailable = new Date(playerSect.last_check_in.getTime() + cooldownMs);
                if (now < nextAvailable) {
                    // 计算剩余冷却时间，便于前端展示
                    const remainMs = nextAvailable - now;
                    const remainHours = Math.floor(remainMs / 3600000);
                    const remainMinutes = Math.floor((remainMs % 3600000) / 60000);
                    throw new AppError(
                        `点卯冷却中，距下次可点卯还有 ${remainHours}小时${remainMinutes}分钟`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 先检查并重置每日任务（点卯作为每日首登的标志动作）
            this._checkAndResetDailyQuests(playerSect);

            // 发放奖励：贡献度 + 修为
            playerSect.contribution += rewardContribution;
            playerSect.last_check_in = now;
            player.exp = BigInt(player.exp || 0) + BigInt(rewardExp);

            await playerSect.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '点卯成功，获得宗门嘉奖',
                rewards: {
                    contribution: rewardContribution,
                    exp: rewardExp
                },
                contribution: playerSect.contribution,
                exp: player.exp.toString(),
                next_check_in_time: new Date(now.getTime() + cooldownHours * 3600 * 1000).toISOString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 宗门传功
     * 校验冷却时间，消耗灵石换取修为，数值从配置读取
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 传功结果
     */
    async transferSkill(playerId) {
        const balance = this.getBalanceConfig();
        const cost = balance.transfer_cost_spirit_stones ?? 100;
        const gainExp = balance.transfer_gain_exp ?? 200;
        const cooldownHours = balance.transfer_cooldown_hours ?? 24;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!playerSect) {
                throw new AppError('尚未加入宗门，无法传功', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验传功冷却
            const now = new Date();
            if (playerSect.last_transfer) {
                const cooldownMs = cooldownHours * 3600 * 1000;
                const nextAvailable = new Date(playerSect.last_transfer.getTime() + cooldownMs);
                if (now < nextAvailable) {
                    const remainMs = nextAvailable - now;
                    const remainHours = Math.floor(remainMs / 3600000);
                    const remainMinutes = Math.floor((remainMs % 3600000) / 60000);
                    throw new AppError(
                        `传功冷却中，距下次可传功还有 ${remainHours}小时${remainMinutes}分钟`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 校验并扣除灵石
            if (BigInt(player.spirit_stones || 0) < BigInt(cost)) {
                throw new AppError(`灵石不足，传功需要 ${cost} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            player.spirit_stones = BigInt(player.spirit_stones) - BigInt(cost);
            // 增加修为
            player.exp = BigInt(player.exp || 0) + BigInt(gainExp);
            playerSect.last_transfer = now;

            await playerSect.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '传功完成，修为大涨',
                cost_spirit_stones: cost,
                gain_exp: gainExp,
                spirit_stones: player.spirit_stones.toString(),
                exp: player.exp.toString(),
                next_transfer_time: new Date(now.getTime() + cooldownHours * 3600 * 1000).toISOString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 获取宝库物品列表
     * @param {string} sectId - 宗门ID
     * @returns {Array} 宝库物品列表
     */
    getTreasury(sectId) {
        const sect = this.findSectById(sectId);
        if (!sect) {
            throw new AppError('宗门不存在', 404, ErrorCodes.NOT_FOUND);
        }
        return sect.treasury || [];
    }

    /**
     * 兑换宝库物品
     * 校验贡献是否足够，扣贡献，调用 InventoryService.addItem 发放物品
     * @param {number} playerId - 玩家ID
     * @param {string} treasureId - 宝库物品ID
     * @returns {Promise<Object>} 兑换结果
     */
    async exchangeTreasury(playerId, treasureId) {
        const t = await sequelize.transaction();
        try {
            // 加锁查询玩家宗门记录，防止并发兑换导致贡献度超扣
            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!playerSect) {
                throw new AppError('尚未加入宗门，无法兑换', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const sect = this.findSectById(playerSect.sect_id);
            if (!sect) {
                throw new AppError('宗门配置已失效', 500, ErrorCodes.CONFIG_ERROR);
            }

            // 查找宝库物品
            const treasure = (sect.treasury || []).find(item => item.id === treasureId);
            if (!treasure) {
                throw new AppError('宝库中不存在该物品', 404, ErrorCodes.NOT_FOUND);
            }

            // 校验贡献度是否足够
            if (playerSect.contribution < treasure.cost) {
                throw new AppError(
                    `贡献度不足，兑换【${treasure.name}】需要 ${treasure.cost} 贡献，当前 ${playerSect.contribution}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 扣减贡献度
            playerSect.contribution -= treasure.cost;
            await playerSect.save({ transaction: t });

            // 调用 InventoryService 发放物品，复用背包入库逻辑（传入当前事务保证原子性）
            await InventoryService.addItem(playerId, treasure.item_key, 1, t);

            await t.commit();

            return {
                success: true,
                message: `兑换成功，获得【${treasure.name}】`,
                treasure: {
                    id: treasure.id,
                    name: treasure.name,
                    item_key: treasure.item_key
                },
                cost: treasure.cost,
                contribution_remaining: playerSect.contribution
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 获取宗门任务列表（标记今日是否已完成）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 任务列表
     */
    async getQuests(playerId) {
        const playerSect = await PlayerSect.findOne({
            where: { player_id: playerId }
        });
        if (!playerSect) {
            throw new AppError('尚未加入宗门，无法查看任务', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const sect = this.findSectById(playerSect.sect_id);
        if (!sect) {
            throw new AppError('宗门配置已失效', 500, ErrorCodes.CONFIG_ERROR);
        }

        // 检查并重置每日任务（读取时若跨天则清零已完成列表）
        let needsSave = this._checkAndResetDailyQuests(playerSect);
        if (needsSave) {
            await playerSect.save();
        }

        // 标记今日是否已完成
        const completedIds = playerSect.daily_quests_completed || [];
        const quests = (sect.quests || []).map(q => ({
            id: q.id,
            name: q.name,
            description: q.description,
            contribution: q.contribution,
            exp_reward: q.exp_reward,
            daily: q.daily,
            completed: completedIds.includes(q.id)
        }));

        return {
            sect_id: sect.id,
            sect_name: sect.name,
            quests: quests,
            quests_reset_at: playerSect.quests_reset_at
        };
    }

    /**
     * 提交宗门任务
     * 校验是否已完成（防重复领取），发放贡献度+修为奖励
     * @param {number} playerId - 玩家ID
     * @param {string} questId - 任务ID
     * @returns {Promise<Object>} 提交结果
     */
    async submitQuest(playerId, questId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!playerSect) {
                throw new AppError('尚未加入宗门，无法提交任务', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const sect = this.findSectById(playerSect.sect_id);
            if (!sect) {
                throw new AppError('宗门配置已失效', 500, ErrorCodes.CONFIG_ERROR);
            }

            // 查找任务配置
            const quest = (sect.quests || []).find(q => q.id === questId);
            if (!quest) {
                throw new AppError('宗门任务不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 提交前先检查并重置每日任务（跨天则清零已完成列表）
            this._checkAndResetDailyQuests(playerSect);

            // 校验是否已完成（每日任务仅可领取一次）
            const completedIds = playerSect.daily_quests_completed || [];
            if (completedIds.includes(questId)) {
                throw new AppError('今日已完成该任务，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 发放奖励：贡献度 + 修为
            playerSect.contribution += (quest.contribution || 0);
            player.exp = BigInt(player.exp || 0) + BigInt(quest.exp_reward || 0);

            // 记录已完成任务
            completedIds.push(questId);
            playerSect.daily_quests_completed = completedIds;

            await playerSect.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `任务【${quest.name}】完成`,
                rewards: {
                    contribution: quest.contribution || 0,
                    exp: quest.exp_reward || 0
                },
                contribution: playerSect.contribution,
                exp: player.exp.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 计算下次任务重置时间（次日0点）
     * @returns {Date} 次日0点时间
     */
    _getNextResetTime() {
        const next = new Date();
        // setHours(24,...) 会自动进位到次日0点
        next.setHours(24, 0, 0, 0);
        return next;
    }

    /**
     * 检查并重置每日任务进度
     * 若 quests_reset_at 为空或已过期，则清零已完成列表并设置下次重置时间
     * @param {Object} playerSect - 玩家宗门记录实例
     * @returns {boolean} 是否发生了重置（调用方据此决定是否需要 save）
     */
    _checkAndResetDailyQuests(playerSect) {
        const now = new Date();
        const resetAt = playerSect.quests_reset_at ? new Date(playerSect.quests_reset_at) : null;

        // 重置条件：从未设置重置时间，或当前时间已超过重置时间
        if (!resetAt || now >= resetAt) {
            playerSect.daily_quests_completed = [];
            playerSect.quests_reset_at = this._getNextResetTime();
            return true; // 标记已修改，需调用方保存
        }
        return false;
    }

    // ==================== GM 管理后台辅助方法 ====================
    // 以下方法供 admin_sect.js 路由调用，与玩家侧玩法逻辑解耦
    // 均不记录 AdminLog（日志由路由层统一处理）

    /**
     * GM：获取所有宗门成员列表（支持按宗门筛选与分页）
     * 实现：先分页查询 PlayerSect，再批量查询 Player 基础信息合并，
     *      最后合并 sect_data.json 静态配置补充宗门名称，避免 N+1 查询
     * @param {Object} filter - { sect_id?: string, page?: number, page_size?: number }
     * @returns {Promise<Object>} { total, page, page_size, total_pages, members }
     */
    async getAllMembers(filter = {}) {
        const adminConfig = this.getAdminConfig();
        // 分页参数从配置读取，page_size 不超过配置的最大值
        const pageSize = Math.min(
            parseInt(filter.page_size) || adminConfig.sect_members_page_size || 20,
            adminConfig.sect_members_max_page_size || 100
        );
        const page = Math.max(parseInt(filter.page) || 1, 1);
        const offset = (page - 1) * pageSize;

        // 构造查询条件：sect_id 可选筛选
        const whereClause = {};
        if (filter.sect_id) {
            whereClause.sect_id = filter.sect_id;
        }

        // 分页查询宗门成员记录，按加入时间倒序
        const { count, rows } = await PlayerSect.findAndCountAll({
            where: whereClause,
            limit: pageSize,
            offset,
            order: [['joined_at', 'DESC']]
        });

        // 无数据时直接返回空结构
        if (rows.length === 0) {
            return { total: 0, page, page_size: pageSize, total_pages: 0, members: [] };
        }

        // 批量查询玩家基础信息，避免逐条查询（N+1 优化）
        const playerIds = rows.map(r => r.player_id);
        const players = await Player.findAll({
            attributes: ['id', 'username', 'nickname', 'realm', 'realm_rank'],
            where: { id: playerIds }
        });
        const playerMap = new Map(players.map(p => [p.id, p]));

        // 合并静态宗门配置，补充宗门名称等展示信息
        const members = rows.map(r => {
            const player = playerMap.get(r.player_id);
            const sect = this.findSectById(r.sect_id);
            return {
                player_id: r.player_id,
                username: player?.username || '',
                nickname: player?.nickname || '未知道友',
                realm: player?.realm || '凡人',
                realm_rank: player?.realm_rank ?? 0,
                sect_id: r.sect_id,
                sect_name: sect?.name || r.sect_id,
                contribution: r.contribution,
                role: r.role,
                joined_at: r.joined_at,
                last_check_in: r.last_check_in,
                last_transfer: r.last_transfer
            };
        });

        return {
            total: count,
            page,
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize),
            members
        };
    }

    /**
     * GM：调整玩家宗门贡献度
     * 校验贡献度范围（从配置读取上下限），直接覆盖原有值
     * @param {number} playerId - 玩家ID
     * @param {number} contribution - 新的贡献度值
     * @returns {Promise<Object>} { player_id, contribution }
     */
    async updateMemberContribution(playerId, contribution) {
        const adminConfig = this.getAdminConfig();
        const min = adminConfig.sect_contribution_min ?? 0;
        const max = adminConfig.sect_contribution_max ?? 100000000;

        // 校验贡献度必须为有效数字
        if (contribution === undefined || contribution === null || isNaN(contribution)) {
            throw new AppError('贡献度必须为数字', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const value = parseInt(contribution);
        if (value < min || value > max) {
            throw new AppError(
                `贡献度超出允许范围 [${min}, ${max}]`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        const playerSect = await PlayerSect.findOne({ where: { player_id: playerId } });
        if (!playerSect) {
            throw new AppError('该玩家尚未加入任何宗门', 404, ErrorCodes.NOT_FOUND);
        }

        playerSect.contribution = value;
        await playerSect.save();

        return {
            player_id: playerId,
            contribution: playerSect.contribution
        };
    }

    /**
     * GM：设置玩家宗门身份
     * 仅允许设置为 disciple（弟子）或 elder（长老）
     * @param {number} playerId - 玩家ID
     * @param {string} role - 目标身份
     * @returns {Promise<Object>} { player_id, role }
     */
    async updateMemberRole(playerId, role) {
        // 身份白名单校验，防止非法值入库
        const allowedRoles = ['disciple', 'elder'];
        if (!allowedRoles.includes(role)) {
            throw new AppError(
                `身份无效，仅支持: ${allowedRoles.join(', ')}`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        const playerSect = await PlayerSect.findOne({ where: { player_id: playerId } });
        if (!playerSect) {
            throw new AppError('该玩家尚未加入任何宗门', 404, ErrorCodes.NOT_FOUND);
        }

        playerSect.role = role;
        await playerSect.save();

        return {
            player_id: playerId,
            role: playerSect.role
        };
    }

    /**
     * GM：踢出宗门
     * 删除 PlayerSect 记录（贡献度随之清空，与叛门逻辑一致）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { player_id, sect_id, sect_name }
     */
    async kickMember(playerId) {
        const playerSect = await PlayerSect.findOne({ where: { player_id: playerId } });
        if (!playerSect) {
            throw new AppError('该玩家尚未加入任何宗门', 404, ErrorCodes.NOT_FOUND);
        }

        // 记录宗门名称供日志展示
        const sectName = this.findSectById(playerSect.sect_id)?.name || playerSect.sect_id;
        await playerSect.destroy();

        return {
            player_id: playerId,
            sect_id: playerSect.sect_id,
            sect_name: sectName
        };
    }

    /**
     * GM：获取宗门统计数据
     * 按 sect_id 聚合查询成员数、总贡献度、长老数，并合并静态配置补充宗门名称
     * @returns {Promise<Array>} 宗门统计数组
     */
    async getSectStats() {
        // 按宗门聚合：统计成员数、总贡献度、长老数
        const stats = await PlayerSect.findAll({
            attributes: [
                'sect_id',
                [sequelize.fn('COUNT', sequelize.col('player_id')), 'member_count'],
                [sequelize.fn('SUM', sequelize.col('contribution')), 'total_contribution'],
                // 统计长老数：role 为 elder 的记1，否则记0
                [sequelize.fn('SUM', sequelize.literal("CASE WHEN role = 'elder' THEN 1 ELSE 0 END")), 'elder_count']
            ],
            group: ['sect_id'],
            raw: true
        });

        // 合并静态配置补充宗门名称
        const sectConfig = this.getSectConfig();
        const sectMap = new Map(sectConfig.map(s => [s.id, s]));

        return stats.map(stat => {
            const sect = sectMap.get(stat.sect_id);
            const memberCount = parseInt(stat.member_count) || 0;
            const elderCount = parseInt(stat.elder_count) || 0;
            return {
                sect_id: stat.sect_id,
                sect_name: sect?.name || stat.sect_id,
                member_count: memberCount,
                total_contribution: parseInt(stat.total_contribution) || 0,
                elder_count: elderCount,
                disciple_count: memberCount - elderCount
            };
        });
    }
}

module.exports = new SectService();
