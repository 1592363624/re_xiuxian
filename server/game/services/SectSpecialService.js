/**
 * 宗门专属玩法服务模块
 *
 * 处理六大宗门各自的专属玩法业务逻辑：
 *   - 灵眼之树（落云宗 luoyun）：每日浇灌灵液培育，成熟后采收灵眼果
 *   - 观星台（星宫 xinggong）：每日观星获取星象 buff 加成
 *   - 命盘推演（天星宗 tianxing）：每日推演命途获取命运修正 buff
 *   - 天阶试炼（凌霄宫 lingxiao）：每日攀登天阶获取心力加成
 *   - 魔道功法（阴罗宗 yinluo）：修炼魔道提升攻击，魔气过高会反噬
 *   - 炉鼎侍妾（合欢宗 hehuan）：问安/灵力反哺/远航/护法
 *
 * 设计说明：
 *   - 静态配置从 sect_special_data.json 读取（配置中心化，支持热更新）
 *   - 玩家专属玩法进度存 player_sect_special 表（一人一条记录）
 *   - 宗门成员身份校验通过 player_sects 表（引用 PlayerSect 模型）
 *   - 所有写操作使用事务 + 行级锁保证并发安全
 *   - 灵石、修为等大数值字段使用 BigInt 运算，避免精度丢失
 *   - 跨天重置：所有"今日次数"字段通过日期比对自动清零
 *   - buff 有效期：观星/命盘/护法的 buff 有过期时间，查询时检查是否过期
 */
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerSect = require('../../models/playerSect');
const PlayerSectSpecial = require('../../models/playerSectSpecial');
const InventoryService = require('./InventoryService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// 单例库存服务实例（与 CaveSocialService/SectService 保持一致的引用方式）
const inventoryService = InventoryService;

// 宗门ID与专属玩法子系统的映射关系
const SECT_SPECIAL_MAP = {
    'luoyun': { key: 'spirit_eye_tree', name: '灵眼之树' },
    'xinggong': { key: 'star_platform', name: '观星台' },
    'tianxing': { key: 'fate_disk', name: '命盘推演' },
    'lingxiao': { key: 'heaven_stairs', name: '天阶试炼' },
    'yinluo': { key: 'dark_arts', name: '魔道功法' },
    'hehuan': { key: 'furnace', name: '炉鼎侍妾' }
};

class SectSpecialService {
    constructor() {
        // 配置加载器，通过 initialize 注入（与 SectService 风格一致）
        this.configLoader = null;
    }

    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
        console.log('[SectSpecialService] 宗门专属玩法服务初始化完成');
    }

    /**
     * 获取宗门专属玩法配置（sect_special_data.json）
     * @returns {Object} 宗门专属玩法配置对象
     */
    getSpecialConfig() {
        return this.configLoader?.getConfig('sect_special_data') || {};
    }

    /**
     * 获取指定子系统的配置
     * @param {string} configKey - 子系统配置键（如 spirit_eye_tree）
     * @returns {Object} 子系统配置
     */
    getSubConfig(configKey) {
        return this.getSpecialConfig()[configKey] || {};
    }

    // ==================== 公共方法 ====================

    /**
     * 获取或创建玩家宗门专属记录
     * 若玩家记录不存在则创建默认记录，保证一人一条
     * @param {number} playerId - 玩家ID
     * @param {Object|null} transaction - 事务实例（可选，传入时由调用方管理提交/回滚）
     * @param {boolean} useLock - 是否使用行级锁（默认 false）
     * @returns {Promise<Object>} 玩家宗门专属记录实例
     */
    async getOrCreateRecord(playerId, transaction = null, useLock = false) {
        const options = {};
        if (transaction) options.transaction = transaction;
        if (useLock && transaction) options.lock = transaction.LOCK.UPDATE;

        // 先尝试查询已有记录
        let record = await PlayerSectSpecial.findOne({
            where: { player_id: playerId },
            ...options
        });

        // 记录不存在则创建（首次使用专属玩法的玩家）
        if (!record) {
            record = await PlayerSectSpecial.create({
                player_id: playerId
            }, transaction ? { transaction } : {});
        }

        return record;
    }

    /**
     * 校验玩家是否属于指定宗门
     * @param {number} playerId - 玩家ID
     * @param {string} sectId - 期望的宗门ID
     * @returns {Promise<Object>} 玩家宗门记录（PlayerSect 实例）
     * @throws {AppError} 未加入宗门或宗门不匹配时抛出业务错误
     */
    async _checkSectMembership(playerId, sectId) {
        const playerSect = await PlayerSect.findOne({
            where: { player_id: playerId }
        });
        if (!playerSect) {
            throw new AppError('尚未加入任何宗门，无法使用专属玩法', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (playerSect.sect_id !== sectId) {
            throw new AppError(
                `该专属玩法仅限【${this._getSectName(sectId)}】弟子使用`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }
        return playerSect;
    }

    /**
     * 根据宗门ID获取宗门名称（从 sect_data 配置读取）
     * @param {string} sectId - 宗门ID
     * @returns {string} 宗门名称，配置缺失时返回宗门ID
     */
    _getSectName(sectId) {
        const sects = this.configLoader?.getConfig('sect_data')?.sects || [];
        const sect = sects.find(s => s.id === sectId);
        return sect?.name || sectId;
    }

    /**
     * 检查跨天重置
     * 若记录中的日期字段不是今天，则将次数字段重置为0并更新日期
     *
     * @param {Object} record - 玩家专属记录实例
     * @param {string} dateField - 日期字段名（DATEONLY 类型）
     * @param {string} countField - 次数字段名
     * @returns {boolean} 是否发生了重置（调用方据此决定是否需要 save）
     */
    _checkDailyReset(record, dateField, countField) {
        // 获取今天的日期字符串（YYYY-MM-DD），与 DATEONLY 存储格式一致
        const today = new Date().toISOString().split('T')[0];
        const recordDate = record[dateField];

        // 日期为空或不是今天，则重置次数并更新日期
        if (!recordDate || recordDate !== today) {
            record[countField] = 0;
            record[dateField] = today;
            return true; // 标记已重置
        }
        return false;
    }

    /**
     * 检查 buff 是否仍然有效
     * @param {Object} record - 玩家专属记录实例
     * @param {string} expireField - buff过期时间字段名
     * @returns {boolean} buff 是否有效
     */
    _isBuffActive(record, expireField) {
        const expireAt = record[expireField];
        if (!expireAt) return false;
        return new Date(expireAt) > new Date();
    }

    /**
     * 加权随机选择一项（用于观星星象、命盘推演结果）
     * @param {Array} items - 候选项数组，每项含 weight 字段
     * @returns {Object} 被选中的项
     */
    _weightedRandom(items) {
        const totalWeight = items.reduce((sum, item) => sum + (item.weight || 1), 0);
        let r = Math.random() * totalWeight;
        for (const item of items) {
            r -= (item.weight || 1);
            if (r <= 0) return item;
        }
        // 兜底：返回最后一项（浮点精度边界情况）
        return items[items.length - 1];
    }

    /**
     * 获取玩家宗门专属玩法信息
     * 根据玩家所属宗门自动返回对应子系统的状态数据
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object|null>} 专属玩法信息，未加入宗门或宗门无专属玩法时返回 null
     */
    async getSpecialInfo(playerId) {
        // 查询玩家宗门归属
        const playerSect = await PlayerSect.findOne({
            where: { player_id: playerId }
        });
        if (!playerSect) {
            return null;
        }

        // 查找该宗门对应的专属玩法子系统
        const specialInfo = SECT_SPECIAL_MAP[playerSect.sect_id];
        if (!specialInfo) {
            // 该宗门没有专属玩法（如散修或配置未覆盖的宗门）
            return {
                sect_id: playerSect.sect_id,
                sect_name: this._getSectName(playerSect.sect_id),
                has_special: false,
                message: '当前宗门暂无专属玩法'
            };
        }

        // 获取或创建专属玩法记录
        const record = await this.getOrCreateRecord(playerId);

        // 根据子系统类型组装对应的状态数据
        let subsystemData = {};
        const config = this.getSubConfig(specialInfo.key);

        switch (specialInfo.key) {
            case 'spirit_eye_tree':
                subsystemData = this._buildTreeInfo(record, config);
                break;
            case 'star_platform':
                subsystemData = this._buildStarInfo(record, config);
                break;
            case 'fate_disk':
                subsystemData = this._buildFateInfo(record, config);
                break;
            case 'heaven_stairs':
                subsystemData = this._buildStairsInfo(record, config);
                break;
            case 'dark_arts':
                subsystemData = this._buildDarkArtsInfo(record, config);
                break;
            case 'furnace':
                subsystemData = this._buildFurnaceInfo(record, config);
                break;
        }

        return {
            sect_id: playerSect.sect_id,
            sect_name: this._getSectName(playerSect.sect_id),
            has_special: true,
            special_type: specialInfo.key,
            special_name: specialInfo.name,
            special_description: config.description || '',
            data: subsystemData
        };
    }

    // ==================== 灵眼之树（落云宗） ====================

    /**
     * 浇灌灵眼树
     * - 消耗灵石增加成长值，每日3次
     * - 成长值达到阶段阈值时自动升级
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 浇灌结果
     */
    async waterTree(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'luoyun');
        const config = this.getSubConfig('spirit_eye_tree');
        const wateringConfig = config.watering || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录（扣灵石、加经验）
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查跨天重置浇灌次数
            this._checkDailyReset(record, 'spirit_tree_watered_date', 'spirit_tree_watered_count');

            // 校验每日浇灌次数上限
            const dailyLimit = wateringConfig.daily_limit || 3;
            if (record.spirit_tree_watered_count >= dailyLimit) {
                throw new AppError(
                    `今日灵眼树已浇灌${dailyLimit}次，请明日再来`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 校验并扣除灵石
            const cost = wateringConfig.spirit_stone_cost || 0;
            if (cost > 0 && BigInt(player.spirit_stones || 0) < BigInt(cost)) {
                throw new AppError(
                    `灵石不足，浇灌灵眼树需${cost}灵石`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            if (cost > 0) {
                player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(cost);
            }

            // 增加成长值和经验
            const growthGain = wateringConfig.growth_per_watering || 50;
            const expReward = wateringConfig.exp_reward || 20;
            record.spirit_tree_growth += growthGain;
            player.exp = BigInt(player.exp || 0) + BigInt(expReward);

            // 检查阶段升级
            const oldStage = record.spirit_tree_stage;
            this._checkTreeStageUpgrade(record, config);
            const stageUp = record.spirit_tree_stage > oldStage;

            // 更新浇灌计数
            record.spirit_tree_watered_count += 1;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: stageUp ? `浇灌成功，灵眼树已成长至【${this._getTreeStageName(record.spirit_tree_stage, config)}】` : '浇灌成功，灵眼树茁壮成长',
                cost_spirit_stones: cost,
                growth_gain: growthGain,
                exp_reward: expReward,
                tree: this._buildTreeInfo(record, config),
                remaining_spirit_stones: Number(player.spirit_stones),
                remaining_water_count: dailyLimit - record.spirit_tree_watered_count
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 采收灵眼果
     * - 仅成熟后（阶段3）可采收，每日1次
     * - 优先给予灵眼果物品，物品配置不存在时给予一次性经验奖励
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 采收结果
     */
    async harvestTree(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'luoyun');
        const config = this.getSubConfig('spirit_eye_tree');
        const harvestConfig = config.harvest || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 校验灵眼树是否已成熟（阶段3为最终阶段）
            if (record.spirit_tree_stage < 3) {
                throw new AppError(
                    `灵眼树尚未成熟（当前阶段：${this._getTreeStageName(record.spirit_tree_stage, config)}），无法采收`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 检查今日是否已采收（通过日期比对，跨天自动允许再次采收）
            const today = new Date().toISOString().split('T')[0];
            if (record.spirit_tree_harvested_date === today) {
                throw new AppError('今日已采收灵眼果，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 记录采收日期
            record.spirit_tree_harvested_date = today;

            // 尝试给予灵眼果物品，物品配置不存在时给予一次性经验奖励
            const produceItemKey = harvestConfig.produce_item_key;
            const produceCount = harvestConfig.produce_count || 1;
            const itemConfig = inventoryService.getItemConfig(produceItemKey);
            let rewardType = 'exp'; // 默认经验奖励模式
            let expReward = 0;

            if (itemConfig) {
                // 物品配置存在，通过 InventoryService 发放物品
                await inventoryService.addItem(playerId, produceItemKey, produceCount, t);
                rewardType = 'item';
            } else {
                // 物品配置不存在，给予一次性经验奖励作为灵眼果的等效收益
                // 经验值基于配置的 sense_bonus 效果推导，确保收益与配置挂钩
                const senseBonus = harvestConfig.effect?.sense_bonus || 0.1;
                expReward = Math.max(100, Math.round(senseBonus * 2000));
                player.exp = BigInt(player.exp || 0) + BigInt(expReward);
            }

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `成功采收${harvestConfig.produce_item_name || '灵眼果'}`,
                reward_type: rewardType,
                ...(rewardType === 'item' ? {
                    item: { key: produceItemKey, name: harvestConfig.produce_item_name, count: produceCount }
                } : {
                    exp_reward: expReward
                }),
                exp: player.exp.toString(),
                tree: this._buildTreeInfo(record, config)
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询灵眼树状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 灵眼树状态信息
     */
    async getTreeInfo(playerId) {
        await this._checkSectMembership(playerId, 'luoyun');
        const config = this.getSubConfig('spirit_eye_tree');
        const record = await this.getOrCreateRecord(playerId);

        // 查询时检查跨天重置（只读不保存，避免误触发写操作）
        const tempRecord = { ...record.dataValues };
        this._checkDailyReset(tempRecord, 'spirit_tree_watered_date', 'spirit_tree_watered_count');

        return this._buildTreeInfo(record, config);
    }

    /**
     * 检查灵眼树阶段升级
     * 当成长值达到当前阶段的 growth_needed 阈值时自动升级到下一阶段
     * @param {Object} record - 玩家专属记录实例
     * @param {Object} config - 灵眼树配置
     */
    _checkTreeStageUpgrade(record, config) {
        const stages = config.growth_stages || [];
        // 循环检查是否满足升级条件（可能连续跨阶）
        while (record.spirit_tree_stage < stages.length - 1) {
            const currentStage = stages.find(s => s.stage === record.spirit_tree_stage);
            if (!currentStage || !currentStage.growth_needed || currentStage.growth_needed === 0) {
                break; // 最终阶段或配置异常，停止升级
            }
            if (record.spirit_tree_growth >= currentStage.growth_needed) {
                record.spirit_tree_stage += 1;
            } else {
                break; // 成长值不足，停止升级
            }
        }
    }

    /**
     * 获取灵眼树阶段名称
     * @param {number} stage - 阶段编号
     * @param {Object} config - 灵眼树配置
     * @returns {string} 阶段名称
     */
    _getTreeStageName(stage, config) {
        const stages = config.growth_stages || [];
        const stageInfo = stages.find(s => s.stage === stage);
        return stageInfo?.name || '未知';
    }

    /**
     * 组装灵眼树状态信息（供 getSpecialInfo/getTreeInfo 共用）
     * @param {Object} record - 玩家专属记录实例
     * @param {Object} config - 灵眼树配置
     * @returns {Object} 灵眼树状态
     */
    _buildTreeInfo(record, config) {
        const stages = config.growth_stages || [];
        const currentStageInfo = stages.find(s => s.stage === record.spirit_tree_stage);
        const nextStageInfo = stages.find(s => s.stage === record.spirit_tree_stage + 1);
        const wateringConfig = config.watering || {};

        return {
            stage: record.spirit_tree_stage,
            stage_name: currentStageInfo?.name || '未知',
            stage_description: currentStageInfo?.description || '',
            growth: record.spirit_tree_growth,
            growth_needed: currentStageInfo?.growth_needed || 0,
            next_stage_name: nextStageInfo?.name || null,
            is_mature: record.spirit_tree_stage >= 3,
            today_watered_count: record.spirit_tree_watered_count,
            daily_water_limit: wateringConfig.daily_limit || 3,
            water_cost: wateringConfig.spirit_stone_cost || 0,
            today_harvested: record.spirit_tree_harvested_date === new Date().toISOString().split('T')[0]
        };
    }

    // ==================== 观星台（星宫） ====================

    /**
     * 观星
     * - 每日免费1次，额外2次消耗灵石
     * - 随机获得星象 buff（有持续时间）
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 观星结果
     */
    async observeStar(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'xinggong');
        const config = this.getSubConfig('star_platform');
        const observeConfig = config.observe || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查跨天重置观星次数
            this._checkDailyReset(record, 'star_observed_date', 'star_observed_count');

            const freeLimit = observeConfig.daily_free_limit || 1;
            const extraLimit = observeConfig.extra_daily_limit || 2;
            const totalLimit = freeLimit + extraLimit;
            const extraCost = observeConfig.extra_cost_spirit_stones || 0;

            // 校验总次数上限
            if (record.star_observed_count >= totalLimit) {
                throw new AppError(
                    `今日观星次数已达上限（${totalLimit}次）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 判断本次是否需要消耗灵石（超过免费次数后每次消耗灵石）
            const isFreeObservation = record.star_observed_count < freeLimit;
            if (!isFreeObservation && extraCost > 0) {
                if (BigInt(player.spirit_stones || 0) < BigInt(extraCost)) {
                    throw new AppError(
                        `灵石不足，额外观星需${extraCost}灵石`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
                player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(extraCost);
            }

            // 加权随机选择星象
            const starForms = config.star_forms || [];
            if (starForms.length === 0) {
                throw new AppError('观星配置异常：无星象数据', 500, ErrorCodes.CONFIG_ERROR);
            }
            const selectedForm = this._weightedRandom(starForms);

            // 记录星象 buff（ID + 过期时间）
            const durationMs = (selectedForm.duration_hours || 2) * 3600 * 1000;
            record.star_last_form = selectedForm.id;
            record.star_buff_expire_at = new Date(Date.now() + durationMs);
            record.star_observed_count += 1;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `观星成功，获得【${selectedForm.name}】加持`,
                is_free: isFreeObservation,
                cost_spirit_stones: isFreeObservation ? 0 : extraCost,
                star_form: {
                    id: selectedForm.id,
                    name: selectedForm.name,
                    description: selectedForm.description,
                    bonus: selectedForm.bonus,
                    duration_hours: selectedForm.duration_hours
                },
                buff_expire_at: record.star_buff_expire_at,
                remaining_spirit_stones: Number(player.spirit_stones),
                remaining_observe_count: totalLimit - record.star_observed_count
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询观星状态和当前 buff
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 观星状态信息
     */
    async getStarInfo(playerId) {
        await this._checkSectMembership(playerId, 'xinggong');
        const config = this.getSubConfig('star_platform');
        const record = await this.getOrCreateRecord(playerId);
        return this._buildStarInfo(record, config);
    }

    /**
     * 组装观星状态信息
     * @param {Object} record - 玩家专属记录实例
     * @param {Object} config - 观星台配置
     * @returns {Object} 观星状态
     */
    _buildStarInfo(record, config) {
        const observeConfig = config.observe || {};
        const freeLimit = observeConfig.daily_free_limit || 1;
        const extraLimit = observeConfig.extra_daily_limit || 2;

        // 检查当前 buff 是否有效
        const buffActive = this._isBuffActive(record, 'star_buff_expire_at');
        let currentBuff = null;
        if (buffActive && record.star_last_form) {
            const formConfig = (config.star_forms || []).find(f => f.id === record.star_last_form);
            if (formConfig) {
                currentBuff = {
                    form_id: formConfig.id,
                    form_name: formConfig.name,
                    description: formConfig.description,
                    bonus: formConfig.bonus,
                    expire_at: record.star_buff_expire_at,
                    remaining_ms: Math.max(0, new Date(record.star_buff_expire_at) - new Date())
                };
            }
        }

        return {
            today_observed_count: record.star_observed_count,
            daily_free_limit: freeLimit,
            extra_daily_limit: extraLimit,
            extra_cost_spirit_stones: observeConfig.extra_cost_spirit_stones || 0,
            current_buff: currentBuff,
            available_forms: (config.star_forms || []).map(f => ({
                id: f.id,
                name: f.name,
                description: f.description,
                bonus: f.bonus,
                duration_hours: f.duration_hours
            }))
        };
    }

    // ==================== 命盘推演（天星宗） ====================

    /**
     * 推演命盘
     * - 每日免费1次，额外3次消耗灵石
     * - 随机获得命运 buff（有持续时间）
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 推演结果
     */
    async divineFate(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'tianxing');
        const config = this.getSubConfig('fate_disk');
        const divinationConfig = config.divination || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查跨天重置推演次数
            this._checkDailyReset(record, 'fate_divined_date', 'fate_divined_count');

            const freeLimit = divinationConfig.daily_free_limit || 1;
            const extraLimit = divinationConfig.extra_daily_limit || 3;
            const totalLimit = freeLimit + extraLimit;
            const extraCost = divinationConfig.extra_cost_spirit_stones || 0;

            // 校验总次数上限
            if (record.fate_divined_count >= totalLimit) {
                throw new AppError(
                    `今日命盘推演次数已达上限（${totalLimit}次）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 判断本次是否需要消耗灵石
            const isFreeDivination = record.fate_divined_count < freeLimit;
            if (!isFreeDivination && extraCost > 0) {
                if (BigInt(player.spirit_stones || 0) < BigInt(extraCost)) {
                    throw new AppError(
                        `灵石不足，额外推演需${extraCost}灵石`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
                player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(extraCost);
            }

            // 加权随机选择命运结果
            const fates = config.fates || [];
            if (fates.length === 0) {
                throw new AppError('命盘配置异常：无命运数据', 500, ErrorCodes.CONFIG_ERROR);
            }
            const selectedFate = this._weightedRandom(fates);

            // 记录命运 buff
            const durationMs = (selectedFate.duration_hours || 4) * 3600 * 1000;
            record.fate_last_result = selectedFate.id;
            record.fate_buff_expire_at = new Date(Date.now() + durationMs);
            record.fate_divined_count += 1;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `命盘推演结果：【${selectedFate.name}】`,
                is_free: isFreeDivination,
                cost_spirit_stones: isFreeDivination ? 0 : extraCost,
                fate: {
                    id: selectedFate.id,
                    name: selectedFate.name,
                    description: selectedFate.description,
                    bonus: selectedFate.bonus,
                    duration_hours: selectedFate.duration_hours
                },
                buff_expire_at: record.fate_buff_expire_at,
                remaining_spirit_stones: Number(player.spirit_stones),
                remaining_divine_count: totalLimit - record.fate_divined_count
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询命盘状态和当前 buff
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 命盘状态信息
     */
    async getFateInfo(playerId) {
        await this._checkSectMembership(playerId, 'tianxing');
        const config = this.getSubConfig('fate_disk');
        const record = await this.getOrCreateRecord(playerId);
        return this._buildFateInfo(record, config);
    }

    /**
     * 组装命盘状态信息
     * @param {Object} record - 玩家专属记录实例
     * @param {Object} config - 命盘配置
     * @returns {Object} 命盘状态
     */
    _buildFateInfo(record, config) {
        const divinationConfig = config.divination || {};
        const freeLimit = divinationConfig.daily_free_limit || 1;
        const extraLimit = divinationConfig.extra_daily_limit || 3;

        // 检查当前 buff 是否有效
        const buffActive = this._isBuffActive(record, 'fate_buff_expire_at');
        let currentBuff = null;
        if (buffActive && record.fate_last_result) {
            const fateConfig = (config.fates || []).find(f => f.id === record.fate_last_result);
            if (fateConfig) {
                currentBuff = {
                    fate_id: fateConfig.id,
                    fate_name: fateConfig.name,
                    description: fateConfig.description,
                    bonus: fateConfig.bonus,
                    expire_at: record.fate_buff_expire_at,
                    remaining_ms: Math.max(0, new Date(record.fate_buff_expire_at) - new Date())
                };
            }
        }

        return {
            today_divined_count: record.fate_divined_count,
            daily_free_limit: freeLimit,
            extra_daily_limit: extraLimit,
            extra_cost_spirit_stones: divinationConfig.extra_cost_spirit_stones || 0,
            current_buff: currentBuff,
            available_fates: (config.fates || []).map(f => ({
                id: f.id,
                name: f.name,
                description: f.description,
                bonus: f.bonus,
                duration_hours: f.duration_hours,
                weight: f.weight
            }))
        };
    }

    // ==================== 天阶试炼（凌霄宫） ====================

    /**
     * 攀登天阶
     * - 每日3次，每次消耗灵石
     * - 获得当前层数的心力加成（累加）和经验奖励
     * - 攀登到顶层后循环重置
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 攀登结果
     */
    async climbStairs(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'lingxiao');
        const config = this.getSubConfig('heaven_stairs');
        const challengeConfig = config.challenge || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查跨天重置攀登次数
            this._checkDailyReset(record, 'stairs_today_date', 'stairs_today_count');

            // 校验每日攀登次数上限
            const dailyLimit = challengeConfig.daily_challenge_limit || 3;
            if (record.stairs_today_count >= dailyLimit) {
                throw new AppError(
                    `今日天阶攀登次数已达上限（${dailyLimit}次）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 计算本次攀登的层数（当前层数+1，到顶后循环重置为1）
            const floors = config.floors || [];
            if (floors.length === 0) {
                throw new AppError('天阶配置异常：无层数数据', 500, ErrorCodes.CONFIG_ERROR);
            }
            const maxFloor = floors.length;
            let targetFloor = record.stairs_current_floor + 1;
            if (targetFloor > maxFloor) {
                targetFloor = 1; // 到顶后循环
            }

            // 获取目标楼层配置
            const floorConfig = floors.find(f => f.floor === targetFloor);
            if (!floorConfig) {
                throw new AppError(`天阶第${targetFloor}阶配置缺失`, 500, ErrorCodes.CONFIG_ERROR);
            }

            // 校验并扣除灵石（每层消耗 = spirit_stone_cost_per_floor * 目标层数）
            const costPerFloor = challengeConfig.spirit_stone_cost_per_floor || 0;
            const totalCost = costPerFloor * targetFloor;
            if (totalCost > 0 && BigInt(player.spirit_stones || 0) < BigInt(totalCost)) {
                throw new AppError(
                    `灵石不足，攀登第${targetFloor}阶需${totalCost}灵石`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            if (totalCost > 0) {
                player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(totalCost);
            }

            // 获得经验和心力加成
            const expReward = floorConfig.exp_reward || 0;
            const mentalBonus = floorConfig.mental_strength_bonus || 0;
            player.exp = BigInt(player.exp || 0) + BigInt(expReward);
            record.stairs_mental_bonus = Number(record.stairs_mental_bonus || 0) + mentalBonus;

            // 更新攀登状态
            record.stairs_current_floor = targetFloor;
            if (targetFloor > record.stairs_max_floor) {
                record.stairs_max_floor = targetFloor;
            }
            record.stairs_today_count += 1;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `成功攀登至【${floorConfig.name}】`,
                floor_reached: targetFloor,
                floor_name: floorConfig.name,
                floor_description: floorConfig.description,
                cost_spirit_stones: totalCost,
                exp_reward: expReward,
                mental_strength_bonus_gain: mentalBonus,
                total_mental_bonus: Number(record.stairs_mental_bonus),
                max_floor_reached: record.stairs_max_floor,
                remaining_spirit_stones: Number(player.spirit_stones),
                remaining_climb_count: dailyLimit - record.stairs_today_count
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询天阶状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 天阶状态信息
     */
    async getStairsInfo(playerId) {
        await this._checkSectMembership(playerId, 'lingxiao');
        const config = this.getSubConfig('heaven_stairs');
        const record = await this.getOrCreateRecord(playerId);
        return this._buildStairsInfo(record, config);
    }

    /**
     * 组装天阶状态信息
     * @param {Object} record - 玩家专属记录实例
     * @param {Object} config - 天阶配置
     * @returns {Object} 天阶状态
     */
    _buildStairsInfo(record, config) {
        const challengeConfig = config.challenge || {};
        const floors = config.floors || [];
        const currentFloorInfo = floors.find(f => f.floor === record.stairs_current_floor);

        return {
            today_count: record.stairs_today_count,
            daily_limit: challengeConfig.daily_challenge_limit || 3,
            current_floor: record.stairs_current_floor,
            current_floor_name: currentFloorInfo?.name || '未攀登',
            max_floor_reached: record.stairs_max_floor,
            total_mental_bonus: Number(record.stairs_mental_bonus),
            cost_per_floor: challengeConfig.spirit_stone_cost_per_floor || 0,
            floors: floors.map(f => ({
                floor: f.floor,
                name: f.name,
                description: f.description,
                mental_strength_bonus: f.mental_strength_bonus,
                exp_reward: f.exp_reward
            }))
        };
    }

    // ==================== 魔道功法（阴罗宗） ====================

    /**
     * 修炼魔道
     * - 每日3次，消耗灵石
     * - 增加攻击加成和魔气值，获得经验
     * - 魔气值达到100触发反噬
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 修炼结果
     */
    async practiceDarkArts(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'yinluo');
        const config = this.getSubConfig('dark_arts');
        const practiceConfig = config.practice || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查跨天重置修炼次数
            this._checkDailyReset(record, 'dark_practiced_date', 'dark_practiced_count');

            // 校验每日修炼次数上限
            const dailyLimit = practiceConfig.daily_limit || 3;
            if (record.dark_practiced_count >= dailyLimit) {
                throw new AppError(
                    `今日魔道修炼次数已达上限（${dailyLimit}次）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 校验并扣除灵石
            const cost = practiceConfig.spirit_stone_cost || 0;
            if (cost > 0 && BigInt(player.spirit_stones || 0) < BigInt(cost)) {
                throw new AppError(
                    `灵石不足，修炼魔道需${cost}灵石`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            if (cost > 0) {
                player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(cost);
            }

            // 增加攻击加成和魔气值
            const atkGain = practiceConfig.atk_gain_per_practice || 0.02;
            const corruptionGain = practiceConfig.dark_corruption_per_practice || 10;
            const expReward = practiceConfig.exp_reward || 80;
            record.dark_atk_bonus = Number(record.dark_atk_bonus || 0) + atkGain;
            record.dark_corruption = Math.min(
                (config.max_corruption || 100),
                record.dark_corruption + corruptionGain
            );
            player.exp = BigInt(player.exp || 0) + BigInt(expReward);
            record.dark_practiced_count += 1;

            // 检查魔气反噬
            const backlashThreshold = config.corruption_thresholds?.backlash || 100;
            let backlashTriggered = false;
            let backlashPenaltyInfo = null;
            if (record.dark_corruption >= backlashThreshold) {
                backlashTriggered = true;
                backlashPenaltyInfo = this._applyBacklash(player, record, config, t);
            }

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: backlashTriggered
                    ? `修炼成功，但魔气反噬！${backlashPenaltyInfo.message}`
                    : '魔道修炼成功，攻击力提升',
                cost_spirit_stones: cost,
                atk_bonus_gain: atkGain,
                total_atk_bonus: Number(record.dark_atk_bonus),
                corruption_gain: corruptionGain,
                current_corruption: record.dark_corruption,
                exp_reward: expReward,
                backlash_triggered: backlashTriggered,
                ...(backlashTriggered ? backlashPenaltyInfo : {}),
                remaining_spirit_stones: Number(player.spirit_stones),
                remaining_practice_count: dailyLimit - record.dark_practiced_count
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 净化魔气
     * - 每日1次，消耗灵石降低魔气值
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 净化结果
     */
    async purifyCorruption(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'yinluo');
        const config = this.getSubConfig('dark_arts');
        const purifyConfig = config.purify || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查今日是否已净化
            const today = new Date().toISOString().split('T')[0];
            if (record.dark_purified_date === today) {
                throw new AppError('今日已净化魔气，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验魔气值是否需要净化
            if (record.dark_corruption <= 0) {
                throw new AppError('魔气值已清零，无需净化', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验并扣除灵石
            const cost = purifyConfig.spirit_stone_cost || 0;
            if (cost > 0 && BigInt(player.spirit_stones || 0) < BigInt(cost)) {
                throw new AppError(
                    `灵石不足，净化魔气需${cost}灵石`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            if (cost > 0) {
                player.spirit_stones = BigInt(player.spirit_stones || 0) - BigInt(cost);
            }

            // 降低魔气值
            const reduction = purifyConfig.corruption_reduction || 30;
            const oldCorruption = record.dark_corruption;
            record.dark_corruption = Math.max(0, record.dark_corruption - reduction);
            record.dark_purified_date = today;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `净化成功，魔气值降低${oldCorruption - record.dark_corruption}点`,
                cost_spirit_stones: cost,
                corruption_before: oldCorruption,
                corruption_after: record.dark_corruption,
                corruption_reduction: oldCorruption - record.dark_corruption,
                remaining_spirit_stones: Number(player.spirit_stones)
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询魔道状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 魔道状态信息
     */
    async getDarkArtsInfo(playerId) {
        await this._checkSectMembership(playerId, 'yinluo');
        const config = this.getSubConfig('dark_arts');
        const record = await this.getOrCreateRecord(playerId);
        return this._buildDarkArtsInfo(record, config);
    }

    /**
     * 执行魔气反噬惩罚
     * 扣除 HP 和经验，并将魔气值降低到安全水平
     *
     * @param {Object} player - 玩家实例
     * @param {Object} record - 专属玩法记录实例
     * @param {Object} config - 魔道配置
     * @param {Object} transaction - 事务实例
     * @returns {Object} 反噬惩罚详情
     */
    _applyBacklash(player, record, config, transaction) {
        const penaltyConfig = config.backlash_penalty || {};
        const thresholds = config.corruption_thresholds || {};

        // 计算HP损失（按当前HP比例扣除）
        const hpLossRate = penaltyConfig.hp_loss_rate || 0.2;
        const currentHp = Number(player.hp_current || 0);
        const hpLoss = Math.floor(currentHp * hpLossRate);
        if (hpLoss > 0) {
            player.hp_current = BigInt(player.hp_current || 0) - BigInt(hpLoss);
            // 确保HP不为负
            if (BigInt(player.hp_current) < BigInt(0)) {
                player.hp_current = BigInt(0);
            }
        }

        // 计算经验损失（按当前经验比例扣除）
        const expLossRate = penaltyConfig.exp_loss_rate || 0.05;
        const currentExp = BigInt(player.exp || 0);
        const expLoss = BigInt(Math.floor(Number(currentExp) * expLossRate));
        if (expLoss > 0) {
            player.exp = currentExp - expLoss;
        }

        // 反噬后魔气值降低到警告阈值以下，避免连续反噬
        const safeLevel = thresholds.warn || 50;
        const oldCorruption = record.dark_corruption;
        record.dark_corruption = safeLevel;

        return {
            message: `损失${hpLoss}点气血、${Number(expLoss)}点修为，魔气值降至${safeLevel}`,
            hp_loss: hpLoss,
            exp_loss: Number(expLoss),
            corruption_before: oldCorruption,
            corruption_after: record.dark_corruption
        };
    }

    /**
     * 组装魔道状态信息
     * @param {Object} record - 玩家专属记录实例
     * @param {Object} config - 魔道配置
     * @returns {Object} 魔道状态
     */
    _buildDarkArtsInfo(record, config) {
        const practiceConfig = config.practice || {};
        const purifyConfig = config.purify || {};
        const thresholds = config.corruption_thresholds || {};

        // 根据魔气值判断危险等级
        let corruptionLevel = 'safe';
        if (record.dark_corruption >= (thresholds.backlash || 100)) {
            corruptionLevel = 'backlash';
        } else if (record.dark_corruption >= (thresholds.danger || 80)) {
            corruptionLevel = 'danger';
        } else if (record.dark_corruption >= (thresholds.warn || 50)) {
            corruptionLevel = 'warn';
        }

        return {
            today_practice_count: record.dark_practiced_count,
            daily_practice_limit: practiceConfig.daily_limit || 3,
            practice_cost: practiceConfig.spirit_stone_cost || 0,
            atk_bonus: Number(record.dark_atk_bonus),
            corruption: record.dark_corruption,
            max_corruption: config.max_corruption || 100,
            corruption_level: corruptionLevel,
            thresholds: thresholds,
            today_purified: record.dark_purified_date === new Date().toISOString().split('T')[0],
            purify_cost: purifyConfig.spirit_stone_cost || 0,
            purify_reduction: purifyConfig.corruption_reduction || 0,
            purify_daily_limit: purifyConfig.daily_limit || 1
        };
    }

    // ==================== 炉鼎侍妾（合欢宗） ====================

    /**
     * 每日问安
     * - 每日1次，获得贡献、经验、灵力恢复
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 问安结果
     */
    async greetConcubine(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'hehuan');
        const config = this.getSubConfig('furnace');
        const greetConfig = config.greet || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查今日是否已问安
            const today = new Date().toISOString().split('T')[0];
            if (record.furnace_greeted_date === today) {
                throw new AppError('今日已向侍妾问安，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 发放奖励：贡献、经验、灵力恢复
            const contributionReward = greetConfig.contribution_reward || 0;
            const expReward = greetConfig.exp_reward || 0;
            const mpRestore = greetConfig.mp_restore || 0;

            // 增加宗门贡献度
            if (contributionReward > 0) {
                const playerSect = await PlayerSect.findOne({
                    where: { player_id: playerId },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (playerSect) {
                    playerSect.contribution += contributionReward;
                    await playerSect.save({ transaction: t });
                }
            }

            // 增加经验
            if (expReward > 0) {
                player.exp = BigInt(player.exp || 0) + BigInt(expReward);
            }

            // 恢复灵力（上限为 mp_max）
            if (mpRestore > 0) {
                const attributes = player.attributes || {};
                const mpMax = attributes.mp_max || 0;
                const currentMp = Number(player.mp_current || 0);
                const newMp = Math.min(currentMp + mpRestore, mpMax);
                player.mp_current = BigInt(newMp);
            }

            record.furnace_greeted_date = today;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '问安完毕，侍妾心情愉悦',
                rewards: {
                    contribution: contributionReward,
                    exp: expReward,
                    mp_restore: mpRestore
                },
                exp: player.exp.toString(),
                mp_current: Number(player.mp_current),
                furnace: this._buildFurnaceInfo(record, config)
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 灵力反哺
     * - 每日1次，消耗灵力获得经验
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 反哺结果
     */
    async feedbackSpirit(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'hehuan');
        const config = this.getSubConfig('furnace');
        const feedbackConfig = config.feedback || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查今日是否已反哺
            const today = new Date().toISOString().split('T')[0];
            if (record.furnace_feedbacked_date === today) {
                throw new AppError('今日已灵力反哺，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验灵力是否足够
            const mpCost = feedbackConfig.mp_cost || 0;
            const currentMp = Number(player.mp_current || 0);
            if (currentMp < mpCost) {
                throw new AppError(
                    `灵力不足，反哺需${mpCost}点灵力，当前${currentMp}点`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 消耗灵力
            player.mp_current = BigInt(currentMp - mpCost);

            // 获得经验
            const expGain = feedbackConfig.exp_gain || 0;
            if (expGain > 0) {
                player.exp = BigInt(player.exp || 0) + BigInt(expGain);
            }

            record.furnace_feedbacked_date = today;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '灵力反哺完成，修为提升',
                mp_cost: mpCost,
                exp_gain: expGain,
                exp: player.exp.toString(),
                mp_current: Number(player.mp_current),
                furnace: this._buildFurnaceInfo(record, config)
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 侍妾远航
     * - 每日1次，选择路线，等待时间后结算
     *
     * @param {number} playerId - 玩家ID
     * @param {string} routeId - 路线ID（safe/balanced/adventure/moon_palace）
     * @returns {Promise<Object>} 远航开始结果
     */
    async startVoyage(playerId, routeId) {
        // 参数校验
        if (!routeId) {
            throw new AppError('远航路线ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验宗门归属
        await this._checkSectMembership(playerId, 'hehuan');
        const config = this.getSubConfig('furnace');
        const voyageConfig = config.voyage || {};
        const routes = voyageConfig.routes || [];

        // 校验路线ID有效
        const routeConfig = routes.find(r => r.id === routeId);
        if (!routeConfig) {
            throw new AppError(`远航路线不存在: ${routeId}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查今日是否已远航（通过开始日期判断）
            const today = new Date().toISOString().split('T')[0];
            // 远航日期用 voyage_start_at 的日期部分来判断
            const lastVoyageDate = record.furnace_voyage_start_at
                ? new Date(record.furnace_voyage_start_at).toISOString().split('T')[0]
                : null;
            if (lastVoyageDate === today) {
                throw new AppError('今日侍妾已远航，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 检查是否有未结算的远航
            if (record.furnace_voyage_end_at && new Date(record.furnace_voyage_end_at) > new Date()) {
                throw new AppError('当前侍妾正在远航中，请等待归来后结算', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 开始远航
            const now = new Date();
            const durationMs = (routeConfig.duration_hours || 4) * 3600 * 1000;
            record.furnace_voyage_route = routeId;
            record.furnace_voyage_start_at = now;
            record.furnace_voyage_end_at = new Date(now.getTime() + durationMs);

            await record.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `侍妾已启程远航【${routeConfig.name}】`,
                route: {
                    id: routeConfig.id,
                    name: routeConfig.name,
                    description: routeConfig.description,
                    duration_hours: routeConfig.duration_hours
                },
                start_at: record.furnace_voyage_start_at,
                end_at: record.furnace_voyage_end_at,
                remaining_ms: Math.max(0, new Date(record.furnace_voyage_end_at) - now)
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 远航归来结算
     * - 远航到达结束时间后才能结算
     * - 根据路线配置计算收益（经验、灵石），有风险率可能失败
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 结算结果
     */
    async settleVoyage(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'hehuan');
        const config = this.getSubConfig('furnace');
        const voyageConfig = config.voyage || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 校验是否有远航记录
            if (!record.furnace_voyage_route || !record.furnace_voyage_end_at) {
                throw new AppError('当前无远航记录可结算', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验远航是否已到达结束时间
            const now = new Date();
            const endAt = new Date(record.furnace_voyage_end_at);
            if (now < endAt) {
                const remainingMs = endAt - now;
                const remainHours = Math.floor(remainingMs / 3600000);
                const remainMinutes = Math.floor((remainingMs % 3600000) / 60000);
                throw new AppError(
                    `远航尚未结束，距归来还有${remainHours}小时${remainMinutes}分钟`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 获取路线配置
            const routes = voyageConfig.routes || [];
            const routeConfig = routes.find(r => r.id === record.furnace_voyage_route);
            if (!routeConfig) {
                throw new AppError('远航路线配置已失效', 500, ErrorCodes.CONFIG_ERROR);
            }

            // 判断远航是否失败（风险率）
            const riskRate = routeConfig.risk_rate || 0;
            const isFailed = Math.random() < riskRate;

            // 计算收益范围内随机值
            const expMin = routeConfig.exp_min || 0;
            const expMax = routeConfig.exp_max || 0;
            const stoneMin = routeConfig.spirit_stone_min || 0;
            const stoneMax = routeConfig.spirit_stone_max || 0;
            const randomExp = expMin + Math.floor(Math.random() * (expMax - expMin + 1));
            const randomStones = stoneMin + Math.floor(Math.random() * (stoneMax - stoneMin + 1));

            // 失败时收益减半（经验减半，灵石为0）
            const finalExp = isFailed ? Math.floor(randomExp * 0.5) : randomExp;
            const finalStones = isFailed ? 0 : randomStones;

            // 发放收益
            if (finalExp > 0) {
                player.exp = BigInt(player.exp || 0) + BigInt(finalExp);
            }
            if (finalStones > 0) {
                player.spirit_stones = BigInt(player.spirit_stones || 0) + BigInt(finalStones);
            }

            // 检查稀有掉落（仅成功时触发）
            let rareDrop = null;
            if (!isFailed && routeConfig.rare_drop_rate && routeConfig.rare_drop_item) {
                if (Math.random() < routeConfig.rare_drop_rate) {
                    // 尝试给予稀有物品
                    const itemConfig = inventoryService.getItemConfig(routeConfig.rare_drop_item);
                    if (itemConfig) {
                        await inventoryService.addItem(playerId, routeConfig.rare_drop_item, 1, t);
                        rareDrop = {
                            item_key: routeConfig.rare_drop_item,
                            item_name: itemConfig.name
                        };
                    }
                }
            }

            // 清除远航记录
            const settledRoute = record.furnace_voyage_route;
            const settledStartAt = record.furnace_voyage_start_at;
            record.furnace_voyage_route = null;
            record.furnace_voyage_start_at = null;
            record.furnace_voyage_end_at = null;

            await record.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: isFailed ? '远航归来，遭遇险情，收益受损' : '远航归来，满载而归',
                route_id: settledRoute,
                route_name: routeConfig.name,
                start_at: settledStartAt,
                settle_at: now,
                is_failed: isFailed,
                risk_rate: riskRate,
                rewards: {
                    exp: finalExp,
                    spirit_stones: finalStones,
                    rare_drop: rareDrop
                },
                exp: player.exp.toString(),
                remaining_spirit_stones: Number(player.spirit_stones)
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询远航状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 远航状态信息
     */
    async getVoyageInfo(playerId) {
        await this._checkSectMembership(playerId, 'hehuan');
        const config = this.getSubConfig('furnace');
        const record = await this.getOrCreateRecord(playerId);

        const voyageConfig = config.voyage || {};
        const routes = voyageConfig.routes || [];

        // 判断当前远航状态
        let voyageStatus = 'idle'; // idle/in_progress/ready_to_settle
        let remainingMs = 0;
        if (record.furnace_voyage_route && record.furnace_voyage_end_at) {
            const now = new Date();
            const endAt = new Date(record.furnace_voyage_end_at);
            if (now < endAt) {
                voyageStatus = 'in_progress';
                remainingMs = endAt - now;
            } else {
                voyageStatus = 'ready_to_settle';
            }
        }

        // 获取当前路线配置
        let currentRoute = null;
        if (record.furnace_voyage_route) {
            const routeConfig = routes.find(r => r.id === record.furnace_voyage_route);
            if (routeConfig) {
                currentRoute = {
                    id: routeConfig.id,
                    name: routeConfig.name,
                    description: routeConfig.description,
                    duration_hours: routeConfig.duration_hours
                };
            }
        }

        return {
            status: voyageStatus,
            current_route: currentRoute,
            start_at: record.furnace_voyage_start_at,
            end_at: record.furnace_voyage_end_at,
            remaining_ms: remainingMs,
            available_routes: routes.map(r => ({
                id: r.id,
                name: r.name,
                description: r.description,
                duration_hours: r.duration_hours,
                exp_range: [r.exp_min, r.exp_max],
                spirit_stone_range: [r.spirit_stone_min, r.spirit_stone_max],
                risk_rate: r.risk_rate,
                ...(r.rare_drop_rate ? { rare_drop_rate: r.rare_drop_rate, rare_drop_item: r.rare_drop_item } : {})
            }))
        };
    }

    /**
     * 请侍妾护法
     * - 每日1次，获得突破加成 buff（有持续时间）
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 护法结果
     */
    async protectConcubine(playerId) {
        // 校验宗门归属
        await this._checkSectMembership(playerId, 'hehuan');
        const config = this.getSubConfig('furnace');
        const protectConfig = config.protect || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁专属玩法记录
            const record = await this.getOrCreateRecord(playerId, t, true);

            // 检查今日是否已护法
            const today = new Date().toISOString().split('T')[0];
            if (record.furnace_protected_date === today) {
                throw new AppError('今日已请侍妾护法，请明日再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 设置护法 buff
            const breakthroughBonus = protectConfig.breakthrough_bonus || 0.05;
            const durationMs = (protectConfig.duration_hours || 2) * 3600 * 1000;
            record.furnace_protected_date = today;
            record.furnace_protect_expire_at = new Date(Date.now() + durationMs);

            await record.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: '侍妾已开始护法，突破成功率提升',
                breakthrough_bonus: breakthroughBonus,
                duration_hours: protectConfig.duration_hours || 2,
                buff_expire_at: record.furnace_protect_expire_at
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询炉鼎状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 炉鼎状态信息
     */
    async getFurnaceInfo(playerId) {
        await this._checkSectMembership(playerId, 'hehuan');
        const config = this.getSubConfig('furnace');
        const record = await this.getOrCreateRecord(playerId);
        return this._buildFurnaceInfo(record, config);
    }

    /**
     * 组装炉鼎状态信息
     * @param {Object} record - 玩家专属记录实例
     * @param {Object} config - 炉鼎配置
     * @returns {Object} 炉鼎状态
     */
    _buildFurnaceInfo(record, config) {
        const greetConfig = config.greet || {};
        const feedbackConfig = config.feedback || {};
        const protectConfig = config.protect || {};
        const voyageConfig = config.voyage || {};
        const today = new Date().toISOString().split('T')[0];

        // 检查护法 buff 是否有效
        const protectBuffActive = this._isBuffActive(record, 'furnace_protect_expire_at');

        // 判断远航状态
        let voyageStatus = 'idle';
        let voyageRemainingMs = 0;
        if (record.furnace_voyage_route && record.furnace_voyage_end_at) {
            const now = new Date();
            const endAt = new Date(record.furnace_voyage_end_at);
            if (now < endAt) {
                voyageStatus = 'in_progress';
                voyageRemainingMs = endAt - now;
            } else {
                voyageStatus = 'ready_to_settle';
            }
        }

        return {
            greet: {
                today_greeted: record.furnace_greeted_date === today,
                daily_limit: greetConfig.daily_limit || 1,
                contribution_reward: greetConfig.contribution_reward || 0,
                exp_reward: greetConfig.exp_reward || 0,
                mp_restore: greetConfig.mp_restore || 0
            },
            feedback: {
                today_feedbacked: record.furnace_feedbacked_date === today,
                daily_limit: feedbackConfig.daily_limit || 1,
                mp_cost: feedbackConfig.mp_cost || 0,
                exp_gain: feedbackConfig.exp_gain || 0
            },
            voyage: {
                status: voyageStatus,
                current_route: record.furnace_voyage_route,
                start_at: record.furnace_voyage_start_at,
                end_at: record.furnace_voyage_end_at,
                remaining_ms: voyageRemainingMs,
                daily_limit: voyageConfig.daily_limit || 1,
                routes: (voyageConfig.routes || []).map(r => ({
                    id: r.id,
                    name: r.name,
                    description: r.description,
                    duration_hours: r.duration_hours
                }))
            },
            protect: {
                today_protected: record.furnace_protected_date === today,
                daily_limit: protectConfig.daily_limit || 1,
                buff_active: protectBuffActive,
                breakthrough_bonus: protectConfig.breakthrough_bonus || 0.05,
                buff_expire_at: record.furnace_protect_expire_at,
                ...(protectBuffActive ? { remaining_ms: Math.max(0, new Date(record.furnace_protect_expire_at) - new Date()) } : {})
            }
        };
    }
}

// 导出单例（与 CaveSocialService/SectService 保持一致的模式）
module.exports = new SectSpecialService();
