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
const { Op } = require('sequelize');
const { contentLabel } = require('../content/ContentRegistry');
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
     * 宗门加成的展示元数据（中文名 + 换算方式），来源是内容 sect_data.global.bonus_labels。
     *
     * 以前这两样抄在客户端 SectPanel 里：一份 10 条的中文字典 + "看键名后缀决定怎么换算"的判断，
     * 而且面板是按字典顺序遍历 bonus 的 —— 内容里新增一种宗门加成，前端不改就**整条不显示**，
     * 表现是"宗门面板上凭空少一行加成"，没有任何报错。
     * 键顺序即展示顺序（内容里写一次，各宗门一致）。
     * @returns {Object} { [bonusKey]: { label, format } }
     */
    getBonusMeta() {
        const labels = this.configLoader?.peekConfig('sect_data', 'global')?.bonus_labels || {};
        // 只把展示要用的两项交给客户端：资料片经 map 集合加进来的条目会带 id / __content_origin 等内部标记，
        // 而标签本身允许"字符串（基础配置）/ 对象（资料片）"两种形状，这里统一成 {label, format}。
        return Object.fromEntries(Object.entries(labels)
            .filter(([key]) => key !== '_note')
            .map(([key, meta]) => [key, { label: contentLabel(meta, key), format: (meta && meta.format) || null }]));
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
            // 加成的中文名与换算方式（见 getBonusMeta：内容是唯一来源，面板不再抄一份）
            bonus_meta: this.getBonusMeta(),
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
     * 任务玩法类型：
     *   labor_mp     —— 劳作：接取即耗灵力（可选灵石/气血），完成只拿贡献
     *   submit_items —— 上交：完成时必须交出指定物资，只拿贡献
     *   patrol       —— 巡守：完成时掷随机事件（战斗/发现/机缘/负伤）
     *   trial        —— 试炼：完成时掷成败（大成/小成/勉强/失败），失败会损气血
     * 默认 labor_mp，资料片写错 type 时不至于整条任务变成白拿。
     */
    _questType(quest) {
        const allowed = new Set(['labor_mp', 'submit_items', 'patrol', 'trial']);
        return allowed.has(quest.type) ? quest.type : 'labor_mp';
    }

    /**
     * 任务耗时：优先任务自带 duration_minutes，否则退回全局 quest_accept_min_wait_minutes
     */
    _questDurationMinutes(quest) {
        const balanceCfg = this.getBalanceConfig();
        return Number(quest.duration_minutes) > 0
            ? Number(quest.duration_minutes)
            : (balanceCfg.quest_accept_min_wait_minutes || 5);
    }

    /**
     * BIGINT 列安全读取（exp / hp_current / mp_current 从库里出来是字符串）
     */
    _safeBigInt(value) {
        try {
            return BigInt(value ?? 0);
        } catch {
            return 0n;
        }
    }

    /**
     * 任务代价的展示摘要（列表页/接取确认都用这一份，不把结构体原样甩给 UI 猜）
     */
    /**
     * 本地日历日键（与 quests_reset_at 的「次日 0 点」同一口径）
     */
    _dateKey(date = new Date()) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    /**
     * 稳定种子（同宗门同日 → 同一份轮值，全服弟子看到同一组差事）
     */
    _hashSeed(text) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h >>> 0;
    }

    /**
     * 可复现 PRNG（mulberry32）：轮值/事件抽检都要「同日可复现、跨日会变」
     */
    _mulberry32(seed) {
        let a = seed >>> 0;
        return function next() {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    _shuffled(list, rng) {
        const arr = list.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    /**
     * 从差事池抽取「今日轮值」——每天 5 件（可配置），不是把池子原样摊开让人一眼做完。
     *
     * 规则（合理化，避免抽到全是新人做不了、或全是同一种玩法）：
     *   1. 四类玩法各保底 1 件（池子里有才保）
     *   2. 至少 2 件入门差事（min_contribution 低）
     *   3. 余下名额从剩池打乱补齐
     * 同一宗门同一日结果稳定，避免有人刷新刷出更好一组。
     *
     * @param {Array} pool - sect.quests 全量
     * @param {string} sectId
     * @param {Date} [date]
     * @returns {Array} 今日可接差事（保持配置原顺序，方便界面稳定）
     */
    _pickDailySlate(pool, sectId, date = new Date()) {
        const all = pool || [];
        if (!all.length) return [];
        const balance = this.getBalanceConfig();
        const size = Math.max(1, Number(balance.quest_daily_offer_count) || 5);
        const entryMax = Number(balance.quest_pool_entry_max_contribution) || 30;

        if (all.length <= size) return all.slice();

        const rng = this._mulberry32(this._hashSeed(`${sectId}|${this._dateKey(date)}`));
        const byType = { labor_mp: [], submit_items: [], patrol: [], trial: [] };
        const entry = [];
        for (const q of all) {
            const t = this._questType(q);
            (byType[t] || byType.labor_mp).push(q);
            if ((Number(q.min_contribution) || 0) <= entryMax) entry.push(q);
        }

        const picked = new Set();
        const take = (q) => { if (q && !picked.has(q.id)) picked.add(q.id); };

        // 1) 四类各保底 1 件
        for (const t of Object.keys(byType)) {
            const list = this._shuffled(byType[t], rng);
            if (list[0]) take(list[0]);
        }

        // 2) 入门差事保底 2 件
        const entryShuffled = this._shuffled(entry, rng);
        for (const q of entryShuffled) {
            if (picked.size >= size) break;
            const entryCount = all.filter(x => picked.has(x.id) && (Number(x.min_contribution) || 0) <= entryMax).length;
            if (entryCount >= 2) break;
            take(q);
        }

        // 3) 从剩池补齐
        for (const q of this._shuffled(all, rng)) {
            if (picked.size >= size) break;
            take(q);
        }

        return all.filter(q => picked.has(q.id));
    }

    /**
     * 今日轮值集合（id 列表）——接取/提交都要过这道闸，不在今日名单上就不算差事
     */
    _todaySlateIds(pool, sectId, date = new Date()) {
        return new Set(this._pickDailySlate(pool, sectId, date).map(q => q.id));
    }

    _costSummary(quest) {
        const cost = quest.cost || {};
        const parts = [];
        if (cost.mp > 0) parts.push(`灵力 -${cost.mp}`);
        if (cost.hp > 0) parts.push(`气血 -${cost.hp}`);
        if (cost.spirit_stones > 0) parts.push(`灵石 -${cost.spirit_stones}`);
        const items = cost.items || [];
        for (const it of items) {
            const name = this._itemName(it.item_key);
            parts.push(`上交 ${name}×${it.quantity || 1}`);
        }
        return parts;
    }

    /**
     * 物品展示名：走 InventoryService 的同一份物品配置，配置缺失时回退 item_key
     */
    _itemName(itemKey) {
        try {
            const cfg = this.configLoader?.getConfig('item_data')?.items || [];
            const hit = cfg.find(i => i.id === itemKey);
            return hit?.name || itemKey;
        } catch {
            return itemKey;
        }
    }

    /**
     * 获取宗门任务列表（标记今日是否已完成/已接取，并带上代价与进行中剩余时间）
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

        // 跨天清零：以前是"无锁读 → 整列写回 []"，会把并发提交的加锁写入吃掉，
        // 详见 _resetDailyQuestsForRead 的注释。
        const shown = await this._resetDailyQuestsForRead(playerSect);

        const completedIds = shown.daily_quests_completed || [];
        const acceptedIds = shown.quests_accepted || [];
        const acceptedAtMap = shown.quests_accepted_at || {};
        const nowMs = Date.now();

        // 今日轮值：从差事池抽固定件数，不是把整池原样摊开
        const pool = sect.quests || [];
        const slateIds = this._todaySlateIds(pool, sect.id);
        const quests = pool.filter(q => slateIds.has(q.id)).map(q => {
            const type = this._questType(q);
            const durationMinutes = this._questDurationMinutes(q);
            const completed = completedIds.includes(q.id);
            const accepted = acceptedIds.includes(q.id);
            let remaining_ms = 0;
            let ready = false;
            const acceptedAt = acceptedAtMap[q.id] || null;
            if (accepted && !completed) {
                const elapsed = acceptedAt ? (nowMs - new Date(acceptedAt).getTime()) / 60000 : durationMinutes;
                const remainMin = Math.max(0, durationMinutes - elapsed);
                remaining_ms = Math.ceil(remainMin * 60000);
                ready = remainMin <= 0;
            }
            return {
                id: q.id,
                name: q.name,
                description: q.description,
                type,
                contribution: q.contribution || 0,
                daily: q.daily,
                min_contribution: q.min_contribution || 0,
                duration_minutes: durationMinutes,
                cost: q.cost || {},
                cost_summary: this._costSummary(q),
                has_random_event: type === 'patrol' || type === 'trial' || !!(q.events?.pool?.length),
                completed,
                accepted,
                accepted_at: acceptedAt,
                ready,
                remaining_ms
            };
        });

        return {
            sect_id: sect.id,
            sect_name: sect.name,
            quests: quests,
            pool_size: pool.length,
            offer_count: Math.min(pool.length, Number(this.getBalanceConfig().quest_daily_offer_count) || 5),
            quests_reset_at: shown.quests_reset_at
        };
    }

    /**
     * 提交宗门任务
     *
     * 按玩法类型结算，绝不是"等够时间就发贡献+修为"：
     *   - 全类型：完成时才给贡献（修为默认 0）
     *   - submit_items：先扣上交物资，不够则拒绝提交
     *   - patrol：掷事件，可能损气血 / 得物品 / 加减贡献 / 偶得顿悟
     *   - trial：掷成败，失败损气血且贡献打折甚至为 0
     *
     * @param {number} playerId - 玩家ID
     * @param {string} questId - 任务ID
     * @returns {Promise<Object>} 提交结果（含代价、事件/试炼结果、奖励）
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

            const quest = (sect.quests || []).find(q => q.id === questId);
            if (!quest) {
                throw new AppError('宗门任务不存在', 404, ErrorCodes.NOT_FOUND);
            }
            const type = this._questType(quest);

            this._checkAndResetDailyQuests(playerSect);

            if (!this._todaySlateIds(sect.quests || [], sect.id).has(questId)) {
                throw new AppError('该差事今日未轮值，请查看今日宗门差事', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const completedIds = playerSect.daily_quests_completed || [];
            if (completedIds.includes(questId)) {
                throw new AppError('今日已完成该任务，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const minContribution = quest.min_contribution || 0;
            if (playerSect.contribution < minContribution) {
                throw new AppError(
                    `宗门贡献度不足，提交【${quest.name}】需要至少 ${minContribution} 贡献度，当前 ${playerSect.contribution}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            const acceptedIds = playerSect.quests_accepted || [];
            if (!acceptedIds.includes(questId)) {
                throw new AppError(
                    `请先接取任务【${quest.name}】后再提交`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            const durationMinutes = this._questDurationMinutes(quest);
            const acceptedAtMap = playerSect.quests_accepted_at || {};
            const acceptedAt = acceptedAtMap[questId];
            if (acceptedAt) {
                const acceptedTime = new Date(acceptedAt).getTime();
                const nowTime = Date.now();
                const elapsedMinutes = (nowTime - acceptedTime) / 60000;
                if (elapsedMinutes < durationMinutes) {
                    const remainingMinutes = Math.ceil(durationMinutes - elapsedMinutes);
                    throw new AppError(
                        `任务【${quest.name}】正在进行中，还需等待约 ${remainingMinutes} 分钟才能提交`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // ===== 上交类：提交时真正扣背包 =====
            const cost = quest.cost || {};
            const submittedItems = [];
            if (type === 'submit_items') {
                const items = cost.items || [];
                if (!items.length) {
                    throw new AppError('任务配置缺少上交物资', 500, ErrorCodes.CONFIG_ERROR);
                }
                for (const it of items) {
                    const need = Number(it.quantity) || 1;
                    const has = await InventoryService.hasItem(playerId, it.item_key, need, t);
                    if (!has) {
                        const owned = await InventoryService.getItemQuantity(playerId, it.item_key);
                        throw new AppError(
                            `上交物资不足：【${this._itemName(it.item_key)}】需要 ${need}，当前 ${owned}`,
                            400,
                            ErrorCodes.INSUFFICIENT_RESOURCES
                        );
                    }
                }
                for (const it of items) {
                    const need = Number(it.quantity) || 1;
                    const removed = await InventoryService.removeItem(playerId, it.item_key, need, t);
                    if (!removed) {
                        // hasItem 与 removeItem 之间理论上只会被并发抢走；回滚整笔，避免半扣
                        throw new AppError(
                            `上交【${this._itemName(it.item_key)}】失败，请稍后再试`,
                            409,
                            ErrorCodes.BUSINESS_LOGIC_ERROR
                        );
                    }
                    submittedItems.push({ item_key: it.item_key, item_name: this._itemName(it.item_key), quantity: need });
                }
            }

            // ===== 奖励与事件结算 =====
            let contributionGain = Number(quest.contribution) || 0;
            let expGain = 0;
            let stoneGain = 0;
            let hpLoss = 0;
            const gainedItems = [];
            let outcome = null;   // trial
            let event = null;     // patrol

            if (type === 'patrol') {
                event = this._rollPatrolEvent(quest);
                if (event) {
                    hpLoss += Number(event.hp_loss) || 0;
                    expGain += Number(event.exp) || 0;
                    stoneGain += Number(event.spirit_stones) || 0;
                    if (event.contribution_bonus) contributionGain += Number(event.contribution_bonus);
                    if (event.contribution_penalty_ratio) {
                        contributionGain = Math.floor(contributionGain * (1 - Number(event.contribution_penalty_ratio)));
                    }
                    const { granted: patrolGranted } = await require('../items/itemGrant').grantItems(
                        playerId,
                        (event.items || []).map(it => ({ item_key: it.item_key, quantity: Number(it.quantity) || 1 })),
                        t,
                        { label: 'sect_quest_patrol' }
                    );
                    for (const g of patrolGranted) {
                        gainedItems.push({ item_key: g.item_key, item_name: this._itemName(g.item_key), quantity: g.quantity });
                    }
                }
            } else if (type === 'trial') {
                outcome = this._rollTrialOutcome(quest);
                const conf = outcome.config || {};
                contributionGain = Math.floor(contributionGain * (Number(conf.contribution_mult) || 0));
                expGain += Number(conf.exp) || 0;
                hpLoss += Number(conf.hp_loss) || 0;
            } else if (type === 'labor_mp') {
                // 劳作偶得：配了 events 就按池抽，没配则极低概率顺手采到灵草
                const laborEvent = this._rollPatrolEvent(quest);
                if (laborEvent) {
                    event = laborEvent;
                    hpLoss += Number(laborEvent.hp_loss) || 0;
                    expGain += Number(laborEvent.exp) || 0;
                    stoneGain += Number(laborEvent.spirit_stones) || 0;
                    if (laborEvent.contribution_bonus) contributionGain += Number(laborEvent.contribution_bonus);
                    if (laborEvent.contribution_penalty_ratio) {
                        contributionGain = Math.floor(contributionGain * (1 - Number(laborEvent.contribution_penalty_ratio)));
                    }
                    const { granted: laborGranted } = await require('../items/itemGrant').grantItems(
                        playerId,
                        (laborEvent.items || []).map(it => ({ item_key: it.item_key, quantity: Number(it.quantity) || 1 })),
                        t,
                        { label: 'sect_quest_labor' }
                    );
                    for (const g of laborGranted) {
                        gainedItems.push({ item_key: g.item_key, item_name: this._itemName(g.item_key), quantity: g.quantity });
                    }
                } else if (!(quest.events?.pool?.length) && Math.random() < 0.08) {
                    const { granted: herbGranted } = await require('../items/itemGrant').grantItems(
                        playerId, [{ item_key: 'spirit_herb', quantity: 1 }], t, { label: 'sect_quest_labor_herb' }
                    );
                    for (const g of herbGranted) {
                        gainedItems.push({ item_key: g.item_key, item_name: this._itemName(g.item_key), quantity: g.quantity });
                    }
                }
            }

            contributionGain = Math.max(0, contributionGain);

            // 落库：贡献 + 顿悟修为 + 灵石 + 气血损耗
            playerSect.contribution += contributionGain;

            if (expGain > 0) {
                player.exp = this._safeBigInt(player.exp) + BigInt(expGain);
            }
            if (stoneGain > 0) {
                player.spirit_stones = this._safeBigInt(player.spirit_stones) + BigInt(stoneGain);
            }
            if (hpLoss > 0) {
                const hp = this._safeBigInt(player.hp_current);
                // 气血最低留 1，任务失败不至于直接躺尸
                player.hp_current = (hp > BigInt(hpLoss) ? hp - BigInt(hpLoss) : 1n).toString();
            }

            completedIds.push(questId);
            playerSect.daily_quests_completed = completedIds;

            await playerSect.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            // 消息按类型拼，让战斗/机缘/试炼结果读起来像真的干了点事
            let message = `任务【${quest.name}】完成，贡献 +${contributionGain}`;
            if (type === 'submit_items' && submittedItems.length) {
                message += `，上交 ${submittedItems.map(i => `${i.item_name}×${i.quantity}`).join('、')}`;
            }
            if (event) {
                message += `。途中：${event.name} — ${event.description}`;
            }
            if (outcome) {
                message += `。试炼结果：${outcome.label}`;
            }
            if (hpLoss > 0) message += `（气血 -${hpLoss}）`;
            if (expGain > 0) message += `，顿悟修为 +${expGain}`;
            if (gainedItems.length) {
                message += `，获得 ${gainedItems.map(i => `${i.item_name}×${i.quantity}`).join('、')}`;
            }
            if (stoneGain > 0) message += `，灵石 +${stoneGain}`;

            return {
                success: true,
                message,
                type,
                costs: {
                    items: submittedItems
                },
                rewards: {
                    contribution: contributionGain,
                    exp: expGain,
                    spirit_stones: stoneGain,
                    items: gainedItems
                },
                penalties: {
                    hp_loss: hpLoss
                },
                event,
                outcome,
                contribution: playerSect.contribution,
                exp: player.exp.toString(),
                spirit_stones: player.spirit_stones.toString(),
                hp_current: player.hp_current.toString(),
                mp_current: player.mp_current.toString()
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 巡守随机事件池抽取（按权重；trigger_chance 未触发则平安交差）
     */
    _rollPatrolEvent(quest) {
        const cfg = quest.events || {};
        const pool = cfg.pool || [];
        if (!pool.length) return null;
        const chance = Number(cfg.trigger_chance);
        if (Number.isFinite(chance) && Math.random() > chance) return null;

        const total = pool.reduce((s, e) => s + (Number(e.weight) || 0), 0);
        if (total <= 0) return pool[Math.floor(Math.random() * pool.length)] || null;
        let roll = Math.random() * total;
        for (const e of pool) {
            roll -= (Number(e.weight) || 0);
            if (roll <= 0) return e;
        }
        return pool[pool.length - 1] || null;
    }

    /**
     * 试炼成败抽取：大成 / 小成 / 勉强 / 失败（剩余概率归失败）
     */
    _rollTrialOutcome(quest) {
        const cfg = quest.trial || {};
        // 注意：0 是合法概率（全失败试炼配置），不能用 `||` 兜底 —— Number(0) 是 falsy 会被默认值吃掉
        const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
        const great = num(cfg.great_success_chance, 0);
        const success = num(cfg.success_chance, 0.5);
        const partial = num(cfg.partial_chance, 0.2);
        const r = Math.random();
        if (r < great) {
            return { id: 'great_success', label: cfg.great_success?.label || '大成', config: cfg.great_success || {} };
        }
        if (r < great + success) {
            return { id: 'success', label: cfg.success?.label || '小成', config: cfg.success || {} };
        }
        if (r < great + success + partial) {
            return { id: 'partial', label: cfg.partial?.label || '勉强', config: cfg.partial || {} };
        }
        return { id: 'fail', label: cfg.fail?.label || '失败', config: cfg.fail || {} };
    }

    /**
     * 接取宗门任务
     *
     * 有启动代价的任务（灵力/灵石/气血）在这里就扣，不是"点一下等时间白拿"。
     * 上交类（submit_items）不在接取时扣物资 —— 那是完成后交差时才交的货。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} questId - 任务ID
     * @returns {Promise<Object>} 接取结果
     */
    async acceptQuest(playerId, questId) {
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
                throw new AppError('尚未加入宗门，无法接取任务', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const sect = this.findSectById(playerSect.sect_id);
            if (!sect) {
                throw new AppError('宗门配置已失效', 500, ErrorCodes.CONFIG_ERROR);
            }

            const quest = (sect.quests || []).find(q => q.id === questId);
            if (!quest) {
                throw new AppError('宗门任务不存在', 404, ErrorCodes.NOT_FOUND);
            }
            const type = this._questType(quest);

            this._checkAndResetDailyQuests(playerSect);

            if (!this._todaySlateIds(sect.quests || [], sect.id).has(questId)) {
                throw new AppError('该差事今日未轮值，请查看今日宗门差事', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const completedIds = playerSect.daily_quests_completed || [];
            if (completedIds.includes(questId)) {
                throw new AppError('今日已完成该任务，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const acceptedIds = playerSect.quests_accepted || [];
            if (acceptedIds.includes(questId)) {
                throw new AppError('已接取该任务，请等待完成后提交', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const minContribution = quest.min_contribution || 0;
            if (playerSect.contribution < minContribution) {
                throw new AppError(
                    `宗门贡献度不足，接取【${quest.name}】需要至少 ${minContribution} 贡献度，当前 ${playerSect.contribution}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // ===== 启动代价：灵力 / 灵石 / 气血（上交物资留到提交时扣） =====
            const cost = quest.cost || {};
            const costMp = Number(cost.mp) || 0;
            const costHp = Number(cost.hp) || 0;
            const costStones = Number(cost.spirit_stones) || 0;
            const paid = { mp: 0, hp: 0, spirit_stones: 0 };

            const mpCur = this._safeBigInt(player.mp_current);
            if (costMp > 0) {
                if (mpCur < BigInt(costMp)) {
                    throw new AppError(
                        `灵力不足，接取【${quest.name}】需要 ${costMp} 灵力，当前 ${mpCur}`,
                        400,
                        ErrorCodes.INSUFFICIENT_RESOURCES
                    );
                }
                player.mp_current = (mpCur - BigInt(costMp)).toString();
                paid.mp = costMp;
            }

            const hpCur = this._safeBigInt(player.hp_current);
            if (costHp > 0) {
                // 留 1 点气血，避免接取任务直接把自己耗死
                if (hpCur <= BigInt(costHp)) {
                    throw new AppError(
                        `气血不足，接取【${quest.name}】需要 ${costHp} 气血，当前 ${hpCur}`,
                        400,
                        ErrorCodes.INSUFFICIENT_RESOURCES
                    );
                }
                player.hp_current = (hpCur - BigInt(costHp)).toString();
                paid.hp = costHp;
            }

            if (costStones > 0) {
                const stoneCur = this._safeBigInt(player.spirit_stones);
                if (stoneCur < BigInt(costStones)) {
                    throw new AppError(
                        `灵石不足，接取【${quest.name}】需要 ${costStones} 灵石，当前 ${stoneCur}`,
                        400,
                        ErrorCodes.INSUFFICIENT_RESOURCES
                    );
                }
                player.spirit_stones = (stoneCur - BigInt(costStones)).toString();
                paid.spirit_stones = costStones;
            }

            // 记录接取状态
            acceptedIds.push(questId);
            playerSect.quests_accepted = acceptedIds;

            const acceptedAtMap = playerSect.quests_accepted_at || {};
            acceptedAtMap[questId] = new Date().toISOString();
            playerSect.quests_accepted_at = acceptedAtMap;

            await playerSect.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            const durationMinutes = this._questDurationMinutes(quest);
            const costParts = this._costSummary(quest);
            let message = `已接取任务【${quest.name}】，预计需要 ${durationMinutes} 分钟`;
            if (costParts.length) message += `，已付：${costParts.filter(p => !p.startsWith('上交')).join('、') || '无'}`;
            if (type === 'submit_items') {
                const items = (cost.items || []).map(i => `${this._itemName(i.item_key)}×${i.quantity || 1}`).join('、');
                message += `；完成时需上交 ${items}`;
            }
            if (type === 'patrol') message += '；途中或有战斗与机缘';
            if (type === 'trial') message += '；结果有成有败，失败会伤身';

            return {
                success: true,
                message,
                quest_id: questId,
                type,
                min_wait_minutes: durationMinutes,
                costs_paid: paid,
                mp_current: player.mp_current.toString(),
                hp_current: player.hp_current.toString(),
                spirit_stones: player.spirit_stones.toString()
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
            playerSect.quests_accepted = [];
            playerSect.quests_accepted_at = {};
            playerSect.quests_reset_at = this._getNextResetTime();
            return true; // 标记已修改，需调用方保存
        }
        return false;
    }

    /**
     * GET 面板用的跨天清零：**带条件写**，不是"无锁读 → 整列写回"。
     *
     * 旧写法会吃掉玩家的日常任务完成标记：
     *   1) 任务面板读到昨天那份已过期的（daily_quests_completed 还是空）；
     *   2) 与此同时 submitQuest 走的是加锁写入，把今天完成的 Q 记进去、并把 quests_reset_at 推到明天；
     *   3) 面板那次 save() 无条件把整列写回 []。
     * 标记没了，可奖励已经在 2) 发过 —— 同一个日常任务今天还能再领一遍。跟太一门
     * claimTaskReward 双领是同一类，只是要跨过零点才撞得上。
     *
     * 条件用"这一行**仍然**到期"，不用"仍等于我读到的那个时间戳"：后者要把 DATETIME 原样
     * 往返一遍，秒/时区精度一丢就永远匹配不上，等于悄悄退回无条件写。
     * 打不中 CAS 说明别人已经推进过这行（那次清零与我们这次等价），重读一份来渲染，
     * 别让面板拿旧快照显示。
     *
     * @param {Object} playerSect - 无锁读到的玩家宗门记录
     * @returns {Promise<Object>} 该拿去渲染的那份记录
     */
    async _resetDailyQuestsForRead(playerSect) {
        const resetAt = playerSect.quests_reset_at ? new Date(playerSect.quests_reset_at) : null;
        const now = new Date();
        if (resetAt && now < resetAt) return playerSect;          // 没跨天：一个键都不写

        await PlayerSect.update({
            daily_quests_completed: [],
            quests_accepted: [],
            quests_accepted_at: {},
            quests_reset_at: this._getNextResetTime()
        }, {
            where: {
                id: playerSect.id,
                [Op.or]: [{ quests_reset_at: null }, { quests_reset_at: { [Op.lt]: now } }]
            }
        });
        return await PlayerSect.findByPk(playerSect.id) || playerSect;
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
