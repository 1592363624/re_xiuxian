/**
 * 历练事件服务
 * 
 * 处理玩家历练过程中的事件生成与管理
 * 支持 AI 生成和模板生成两种模式
 */
const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerMapPosition = require('../../models/playerMapPosition');
const ActiveBattle = require('../../models/activeBattle');
const Item = require('../../models/item');
const PlayerAdventure = require('../../models/playerAdventure');
const MapConfigLoader = require('./MapConfigLoader');
const DropLoader = require('./DropLoader');
const AIService = require('./AIService');
// 配置加载器，用于读取 game_balance.json 中的历练时长分级配置
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
// 修复 B24：怪物属性需基于境界配置计算，避免硬编码 hp:100/atk:15/def:5
const RealmService = require('../core/RealmService');
// 内容声明层 + 境界基础值：与野外怪、副本怪、世界 BOSS 同一套 stats / power_multiplier 规则
const { buildRealmMonsterStats } = require('../combat/MonsterStats');
const { withItemNames } = require('../items/itemNaming');
const { grantItems } = require('../items/itemGrant');

/**
 * 工具函数：根据怪物境界名计算怪物战斗属性
 *
 * 修复 B24：原 fallback 怪物属性硬编码为 hp:100/atk:15/def:5，
 * 导致高境界地图的怪物（如化神期地图的怪）也是 100 HP，玩家一击必杀毫无挑战；
 * 低境界地图的怪物反而 15 攻击可能击杀凡人玩家。
 *
 * 数值表现在只在 MonsterStats.buildRealmMonsterStats 一处：境界基础值查 realm_breakthrough，
 * 再并上 map_data 里这只怪声明的 stats / power_multiplier。以前"按境界给怪配数值"在
 * 历练、AI 降级模板、野外遭遇各存了一份，改境界表只能改到其中几处。
 *
 * @param {string} monsterRealm - 怪物境界名（如 "炼气1层"、"凡人"）
 * @param {number} fallbackExp - 兜底经验值
 * @param {Object} [monsterConfig] - map_data 里那只怪的原条目（提供 stats / power_multiplier 声明层）
 * @returns {Object} 整块战斗属性（hp/max_hp/atk/def/speed/exp_reward + 声明的额外属性）
 */
function computeMonsterStatsByRealm(monsterRealm, fallbackExp = 10, monsterConfig = {}) {
    return buildRealmMonsterStats(monsterRealm, {
        expFallback: fallbackExp,
        enemyConfig: monsterConfig,
        warnLabel: 'AdventureEventService'
    });
}

class AdventureEventService {
    /**
     * 构造函数
     * @param {Object} aiService - AI 服务实例
     */
    constructor(aiService = null) {
        this.aiService = aiService;
    }

    /**
     * 初始化历练事件服务
     * @param {Object} configLoader - 配置加载器
     * @returns {AdventureEventService} 服务实例
     */
    static async initialize(configLoader) {
        let aiService = null;
        try {
            // 优先从数据库加载启用的 AI 配置（GM 后台配置优先）
            aiService = await AIService.reloadFromDatabase();
            if (!aiService) {
                // 数据库无配置时降级为环境变量/JSON 配置
                aiService = await AIService.initialize(configLoader);
            }
            console.log('[AdventureEventService] AI 服务初始化成功');
        } catch (error) {
            console.warn('[AdventureEventService] AI 服务初始化失败，将使用模板模式:', error.message);
        }

        const service = new AdventureEventService(aiService);
        // 保存模块级实例引用，供 AIService.reloadFromDatabase 在热重载时更新
        AdventureEventService._activeInstance = service;
        console.log('[AdventureEventService] 历练事件服务已初始化');
        return service;
    }

    /**
     * 获取当前活跃的 AdventureEventService 实例
     * 供 AIService.reloadFromDatabase 在热重载时更新内部 aiService 引用
     * @returns {AdventureEventService|null} 服务实例
     */
    static getActiveInstance() {
        return AdventureEventService._activeInstance || null;
    }

    /**
     * 加载事件模板
     * @returns {Object} 事件模板
     */
    loadEventTemplates() {
        const byType = {};
        for (const entry of this.adventureConfig().events || []) {
            const list = byType[entry.type] || (byType[entry.type] = []);
            list.push(entry);
        }
        return byType;
    }

    /**
     * 历练内容（事件模板 + 类型表）。每次都用合并视图，不存构造期快照：
     * 资料片开关、GM 热更配置之后，下一场历练就该看到新内容。
     * @returns {Object} adventure_event_data
     */
    adventureConfig() {
        return configLoader.getConfig('adventure_event_data') || { events: [], event_types: {} };
    }

    /**
     * 事件类型 → 抽取权重 / 标题 / AI 保底经验，一张表说清（以前是三份按同一组键抄的字典）
     * @returns {Object} event_types
     */
    eventTypes() {
        return this.adventureConfig().event_types || {};
    }

    /**
     * 一类事件的配置（label / weight / base_exp）。类型没声明时退回第一类，
     * 与改造前 `titles[eventType] || '历练事件'`、`baseExp[eventType] || baseExp.peaceful` 的降级一致。
     * @param {string} eventType - 事件类型
     * @returns {Object} 类型配置
     */
    typeConfig(eventType) {
        const types = this.eventTypes();
        return types[eventType] || types[Object.keys(types)[0]] || {};
    }

    /**
     * @param {string} eventType - 事件类型
     * @returns {Array<Object>} 该类型的模板清单（按内容里的顺序）
     */
    templatesForType(eventType) {
        const byType = this.loadEventTemplates();
        const list = byType[eventType] || byType[Object.keys(byType)[0]];
        if (!list || !list.length) {
            throw new Error('adventure_event_data.events 是空的：没有任何历练事件可发');
        }
        return list;
    }


    /**
     * 开始历练
     * @param {number} playerId - 玩家 ID
     * @param {Object} options - 选项
     * @returns {Object} 历练结果
     */
    async startAdventure(playerId, options = {}) {
        try {
            const player = await Player.findByPk(playerId);
            if (!player) {
                return { success: false, error: '玩家不存在' };
            }

            if (player.is_moving) {
                return { success: false, error: '移动中无法开始历练' };
            }

            if (player.is_secluded) {
                return { success: false, error: '闭关中无法开始历练' };
            }

            const currentMap = MapConfigLoader.getMap(player.current_map_id);
            if (!currentMap) {
                return { success: false, error: '当前地图不存在' };
            }

            const existingAdventure = await this.getLastAdventureEvent(playerId);
            if (existingAdventure) {
                await PlayerAdventure.update(
                    { status: 'cancelled' },
                    { where: { id: existingAdventure.id } }
                );
                console.log(`[AdventureEventService] 自动取消异常历练 ID: ${existingAdventure.id}`);
            }

            // 读取时长分级配置（short/medium/long），向后兼容旧的 duration 参数
            const durationType = options.durationType || 'medium';
            const durationConfig = this.getAdventureDurationConfig(durationType);
            const adventureConfig = {
                duration: durationConfig.duration,
                duration_type: durationConfig.type,
                reward_multiplier: durationConfig.reward_multiplier
            };

            const eventContext = {
                playerRealm: player.realm,
                mapName: currentMap.name,
                mapEnvironment: currentMap.environment,
                timeOfDay: this.getTimeOfDay(),
                weather: this.getWeather(),
                playerLevel: this.getPlayerLevel(player),
                duration: adventureConfig.duration
            };

            const event = await this.generateEvent(eventContext);
            // 写入时长类型与奖励倍率，供 completeAdventure 读取
            event.duration_type = durationConfig.type;
            event.reward_multiplier = durationConfig.reward_multiplier;

            // 确保 duration 是有效数字，避免 Invalid Date
            const durationSeconds = eventContext.duration || 60;
            const adventure = await PlayerAdventure.create({
                player_id: playerId,
                map_id: player.current_map_id,
                map_name: currentMap.name,
                event_id: event.id,
                event_type: event.type,
                event_data: JSON.stringify(event),
                start_time: new Date(),
                end_time: new Date(Date.now() + durationSeconds * 1000),
                status: 'in_progress',
                rewards_claimed: false
            });

            return {
                success: true,
                adventure: {
                    id: adventure.id,
                    player_id: playerId,
                    map_id: player.current_map_id,
                    event_id: event.id,
                    event_type: event.type,
                    event_data: event,
                    start_time: adventure.start_time,
                    end_time: adventure.end_time,
                    status: adventure.status,
                    rewards_claimed: false
                },
                event: {
                    type: event.type,
                    title: event.title,
                    description: event.description,
                    duration: eventContext.duration,
                    aiGenerated: event.aiGenerated || false
                }
            };
        } catch (error) {
            console.error('[AdventureEventService] 开始历练失败:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 生成事件
     * @param {Object} context - 上下文
     * @returns {Object} 事件数据
     */
    async generateEvent(context) {
        const eventType = this.selectEventType();
        const useAI = this.aiService && this.isAIEnabledForType(eventType);

        if (useAI) {
            try {
                const aiResult = await this.aiService.generateAdventureEvent({
                    ...context,
                    eventType
                });

                if (aiResult.success) {
                    return {
                        id: `ai_${Date.now()}`,
                        type: eventType,
                        title: this.getEventTitle(eventType),
                        description: aiResult.description,
                        aiGenerated: true,
                        duration: context.duration || 60,
                        rewards: this.getDefaultRewards(eventType)
                    };
                }
            } catch (error) {
                console.warn('[AdventureEventService] AI 生成失败，使用模板:', error.message);
            }
        }

        return this.generateEventFromTemplate(eventType);
    }

    /**
     * 选择事件类型
     * @returns {string} 事件类型
     */
    selectEventType() {
        const weights = Object.entries(this.eventTypes())
            .map(([type, cfg]) => [type, Number(cfg?.weight) || 0]);

        const totalWeight = weights.reduce((a, [, w]) => a + w, 0);
        let random = Math.random() * totalWeight;

        for (const [type, weight] of weights) {
            if (random < weight) {
                return type;
            }
            random -= weight;
        }

        // 一类都抽不到 = weight 全为 0：退回内容里声明的第一类（改造前是硬退回 peaceful）
        return weights.length ? weights[0][0] : null;
    }

    /**
     * 检查事件类型是否启用 AI
     * @param {string} eventType - 事件类型
     * @returns {boolean} 是否启用 AI
     */
    isAIEnabledForType(eventType) {
        return true;
    }

    /**
     * 从模板生成事件
     * @param {string} eventType - 事件类型
     * @returns {Object} 事件数据
     */
    generateEventFromTemplate(eventType) {
        const templates = this.templatesForType(eventType);
        const template = templates[Math.floor(Math.random() * templates.length)];

        return {
            id: template.id,
            type: eventType,
            title: template.title,
            description: template.description,
            duration: template.duration,
            rewards: template.rewards,
            aiGenerated: false
        };
    }

    /**
     * 获取事件标题
     * @param {string} eventType - 事件类型
     * @returns {string} 标题
     */
    getEventTitle(eventType) {
        return this.typeConfig(eventType).label || '历练事件';
    }

    /**
     * 获取历练配置（向后兼容，默认中等时长）
     * @returns {Object} 配置
     */
    getAdventureConfig() {
        return {
            duration: 60 + Math.floor(Math.random() * 60),
            expMultiplier: 1.0
        };
    }

    /**
     * 根据时长类型读取历练配置（时长分级）
     * 配置来源于 game_balance.json 的 adventure.duration_types
     * @param {string} durationType - 时长类型：short/medium/long
     * @returns {Object} 时长配置 { duration, reward_multiplier, injury_chance, injury_hp_loss_rate, label }
     */
    getAdventureDurationConfig(durationType) {
        const defaultType = 'medium';
        const defaultConfig = {
            duration: 90,
            reward_multiplier: 1.0,
            injury_chance: 0.05,
            injury_hp_loss_rate: 0.08,
            label: '中时历练'
        };
        try {
            const balance = configLoader.getConfig('game_balance');
            const types = balance?.adventure?.duration_types;
            if (!types) return { ...defaultConfig, type: defaultType };
            const type = types[durationType] ? durationType : defaultType;
            return { ...types[type], type };
        } catch (e) {
            console.warn('[AdventureEventService] 读取历练时长配置失败，使用默认值:', e.message);
            return { ...defaultConfig, type: defaultType };
        }
    }

    /**
     * 读取提前结束历练的惩罚比例
     * 配置来源于 game_balance.json 的 adventure.early_finish_penalty
     * @returns {number} 惩罚比例（0-1，0.5 表示获得 50% 收益）
     */
    getEarlyFinishPenalty() {
        try {
            const balance = configLoader.getConfig('game_balance');
            const penalty = balance?.adventure?.early_finish_penalty;
            // 限制在 0-1 范围内
            return Math.max(0, Math.min(1, parseFloat(penalty) || 0.5));
        } catch (e) {
            return 0.5;
        }
    }

    /**
     * 获取默认奖励
     * @param {string} eventType - 事件类型
     * @returns {Object} 奖励
     */
    getDefaultRewards(eventType) {
        // 类型没配 base_exp 时退回内容里第一类的区间（改造前是硬退回 baseExp.peaceful）
        const types = this.eventTypes();
        const range = this.typeConfig(eventType).base_exp || types[Object.keys(types)[0]]?.base_exp;
        const exp = range.min + Math.floor(Math.random() * (range.max - range.min));

        return { exp };
    }

    /**
     * 完成历练
     * @param {number} playerId - 玩家 ID
     * @returns {Object} 完成结果
     */
    async completeAdventure(playerId) {
        // 修复（2026-09-19）并发双领：
        //   原实现是「无锁读 status → 发奖 → 才把状态改成 completed」，
        //   两个标签页共用同一个 JWT（互踢只在重新登录时触发，拦不住这个），
        //   会各自通过状态检查、各发一遍修为/灵石/物品；
        //   且最后那条 UPDATE 的 where 只有 id，不构成 compare-and-swap。
        //   现在整段收进一个事务，并用 SELECT ... FOR UPDATE 锁住历练行：
        //   第二个请求阻塞到第一个提交后，WHERE 已匹配不到 in_progress 行。
        const transaction = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: transaction.LOCK.UPDATE, transaction });
            if (!player) {
                await transaction.rollback();
                return { success: false, code: 'PLAYER_NOT_FOUND', message: '玩家不存在' };
            }

            const eventData = await PlayerAdventure.findOne({
                where: { player_id: playerId, status: 'in_progress' },
                order: [['createdAt', 'DESC']],
                lock: transaction.LOCK.UPDATE,
                transaction
            });
            if (!eventData) {
                await transaction.rollback();
                return { success: false, code: 'NO_ADVENTURE', message: '没有进行中的历练' };
            }

            const now = new Date();
            const endTime = new Date(eventData.end_time);
            // 提前结束时按时间比例给奖励，并按配置扣除 early_finish_penalty 比例
            // 设计理念：提前结束属于违约，仅按已时长比例结算，并按配置扣除部分收益
            // 不设保底，避免玩家反复"开始历练→立即结束"刷保底奖励
            const earlyFinishPenalty = this.getEarlyFinishPenalty();
            let rewardScale = 1.0;
            let earlyFinish = false;
            if (now < endTime) {
                const startTime = new Date(eventData.createdAt);
                const totalDuration = endTime - startTime;
                const elapsed = now - startTime;
                // 按比例 × (1 - penalty) 折扣，最低 0（立即结束无奖励）
                rewardScale = totalDuration > 0 ? (elapsed / totalDuration) * (1 - earlyFinishPenalty) : 0;
                earlyFinish = true;
            }

            const eventObj = typeof eventData.event_data === 'string'
                ? JSON.parse(eventData.event_data)
                : eventData.event_data;
            // 读取时长分级配置的奖励倍率（长时历练 1.8 倍，短时历练 0.6 倍）
            const rewardMultiplier = eventObj?.reward_multiplier || 1.0;
            // 奖励 = 基础奖励 × 提前结束折扣 × 时长倍率 × 境界倍率（境界倍率在 grantRewards 中应用）
            // 修复（2026-07-21）：base_exp / base_spirit_stones 字段透传到 grantRewards，
            // 让 grantRewards 能在返回结果中记录基础值，便于前端展示「基础 × 境界倍率 = 实际」
            const rawRewards = eventObj?.rewards || {};
            // 先应用提前结束折扣 × 时长倍率（不应用境界倍率，境界倍率在 grantRewards 中应用）
            const scaledExp = Math.floor((rawRewards.exp || 0) * rewardScale * rewardMultiplier);
            const scaledStones = Math.floor((rawRewards.spirit_stones || 0) * rewardScale * rewardMultiplier);
            const rewards = {
                exp: scaledExp,
                spirit_stones: scaledStones,
                items: rawRewards.items || [],
                // 透传基础值（已含时长折扣和倍率，但未含境界倍率）
                // grantRewards 会基于此计算 final_exp = base_exp × realm_multiplier
                base_exp: scaledExp,
                base_spirit_stones: scaledStones
            };
            const result = await this.grantRewards(player, rewards, transaction);

            // 风险机制：历练可能受伤（损失气血），长时历练受伤概率更高
            const durationType = eventObj?.duration_type || 'medium';
            const durationConfig = this.getAdventureDurationConfig(durationType);
            let injury = null;
            if (Math.random() < (durationConfig.injury_chance || 0)) {
                // 就用同一份锁住的实例：grantRewards 已经在它上面改过并落库，这里读到的是最新值。
                // 原来这里再补一次 FOR UPDATE（"重新获取玩家"）—— 行本来就锁在手里，补读不加快也不变准，
                // 只在取锁次序上看着像 adventure→players 的反向，还会留下第二份实例互相覆盖。
                const currentHp = Number(player.hp_current);
                const hpLoss = Math.floor(currentHp * (durationConfig.injury_hp_loss_rate || 0.08));
                if (hpLoss > 0) {
                    let newHp = BigInt(player.hp_current) - BigInt(hpLoss);
                    if (newHp < 0n) newHp = 0n;
                    player.hp_current = newHp;
                    await player.save({ transaction });
                    injury = { hp_loss: hpLoss };
                }
            }

            // 提前结束时在消息中标注奖励缩放比例
            if (earlyFinish) {
                result.early_finish = true;
                result.reward_scale = Math.round(rewardScale * 100) + '%';
            }
            // 受伤信息
            if (injury) {
                result.injury = injury;
            }

            await PlayerAdventure.update(
                {
                    status: 'completed',
                    rewards_claimed: true,
                    rewards: JSON.stringify(result.granted)
                },
                {
                    // 再带上 status 条件：行锁已保证唯一，这里只是把"只能结算一次"写进语句本身
                    where: { id: eventData.id, status: 'in_progress' },
                    transaction
                }
            );

            await transaction.commit();

            // 修复：返回结构扁平化，rewards 直接是 granted 内容 + 额外标记
            // 避免前端 res.data.data.rewards.exp 拿到 undefined（旧版返回的是 { success, granted } 嵌套结构）
            return {
                success: true,
                message: '历练完成',
                rewards: {
                    ...result.granted,
                    // 落库的 rewards 仍是引用，名字只在这份出参里按 item_data 解析
                    items: withItemNames(result.granted.items),
                    // 透传提前结束 / 受伤等额外标记，前端可直接 rewards.early_finish 读取
                    early_finish: result.early_finish || false,
                    reward_scale: result.reward_scale || null,
                    injury: result.injury || null
                }
            };
        } catch (error) {
            await transaction.rollback();
            console.error('[AdventureEventService] 完成历练失败:', error);
            return { success: false, code: 'COMPLETE_FAILED', message: '完成历练失败，请稍后重试' };
        }
    }

    /**
     * 获取最后历练事件
     * @param {number} playerId - 玩家 ID
     * @returns {Object|null} 事件数据
     */
    async getLastAdventureEvent(playerId) {
        try {
            const adventure = await PlayerAdventure.findOne({
                where: {
                    player_id: playerId,
                    status: 'in_progress'
                },
                order: [['createdAt', 'DESC']]
            });
            
            if (!adventure) return null;
            
            const plainData = adventure.toJSON();
            if (typeof plainData.event_data === 'string') {
                plainData.event_data = JSON.parse(plainData.event_data);
            }
            if (plainData.rewards && typeof plainData.rewards === 'string') {
                plainData.rewards = JSON.parse(plainData.rewards);
            }
            if (plainData.rewards?.items) {
                plainData.rewards = { ...plainData.rewards, items: withItemNames(plainData.rewards.items) };
            }
            
            return plainData;
        } catch (error) {
            console.error('[AdventureEventService] 获取历练事件失败:', error);
            return null;
        }
    }

    /**
     * 清理历练事件
     * @param {number} playerId - 玩家 ID
     */
    async clearAdventureEvent(playerId) {
        try {
            await PlayerAdventure.update(
                { status: 'completed' },
                {
                    where: {
                        player_id: playerId,
                        status: 'in_progress'
                    }
                }
            );
        } catch (error) {
            console.error('[AdventureEventService] 清理历练事件失败:', error);
        }
    }

    /**
     * 计算境界加成倍率（境界越高收益越高）
     *
     * 修复（2026-07-21）：
     *   原奖励数值与境界脱钩：化神期玩家也只能拿到凡人级别的几十点修为。
     *   现在与闭关修炼保持一致：1.0 + (realm.rank - 1) * 0.1
     *   每提升一个境界 rank，收益增加 10%（化神初期 rank=23 → 3.2x）
     *
     * @param {Object} player - 玩家对象
     * @returns {number} 境界加成倍率
     */
    getRealmMultiplier(player) {
        try {
            // 优先使用 player.realm_rank 字段（数值更快）
            const rank = Number(player?.realm_rank);
            if (rank > 0) {
                return 1.0 + (rank - 1) * 0.1;
            }
            // 兜底：通过 RealmService 查询境界 rank
            const realmName = player?.realm;
            if (realmName) {
                const realmConfig = RealmService.getRealmByName(realmName);
                if (realmConfig && realmConfig.rank) {
                    return 1.0 + (realmConfig.rank - 1) * 0.1;
                }
            }
        } catch (e) {
            console.warn('[AdventureEventService] 获取境界加成失败:', e.message);
        }
        return 1.0;
    }

    /**
     * 授予奖励
     *
     * 修复（2026-07-21）：
     *   1. 奖励数值加入境界加成倍率，与闭关修炼保持一致
     *   2. 修复 Item.upsert 错误用法：原 upsert 依赖主键 id，但传入数据无 id，
     *      实际是 INSERT，多次获得同一物品会创建多条 quantity=1 记录，
     *      改为 findOrCreate + increment 正确累加数量
     *
     * @param {Object} player - 调用方**已加锁**的玩家实例（同一笔事务里同一行只留一份实例：
     *   读两次再分别 save，谁后写谁覆盖对方那一份，见 completeAdventure）
     * @param {Object} rewards - 奖励（基础值，未应用境界加成）
     * @param {Object} [transaction] - 外层事务；传入时所有写入都挂在这笔事务上，并发结算互相串行化。
     * @returns {Object} 授予结果（granted 字段记录实际发放数值，已含境界加成）
     */
    async grantRewards(player, rewards, transaction = null) {
        if (!player) {
            return { success: false, error: '玩家不存在' };
        }

        // 境界加成倍率：化神期 rank=23 → 3.2x，让奖励与境界匹配
        const realmMultiplier = this.getRealmMultiplier(player);

        const granted = {
            exp: 0,
            base_exp: 0,
            items: [],
            spirit_stones: 0,
            base_spirit_stones: 0,
            realm_multiplier: Number(realmMultiplier.toFixed(2))
        };

        // 修复（2026-07-21）：始终记录 base_exp（即使为 0），让前端能正确展示计算过程
        // base_exp = 已含时长折扣 × 时长倍率，但未含境界倍率
        // final_exp = base_exp × 境界倍率
        const baseExpValue = rewards.base_exp ?? rewards.exp ?? 0;
        const finalExp = Math.floor(baseExpValue * realmMultiplier);
        if (finalExp > 0) {
            player.exp = BigInt(player.exp) + BigInt(finalExp);
        }
        granted.exp = finalExp;
        granted.base_exp = baseExpValue;

        if (rewards.mp) {
            // 灵力同样应用境界加成
            const finalMp = Math.floor(rewards.mp * realmMultiplier);
            player.mp_current = BigInt(player.mp_current) + BigInt(finalMp);
            granted.mp = finalMp;
        }

        // 灵石同样始终记录 base_spirit_stones
        const baseStonesValue = rewards.base_spirit_stones ?? rewards.spirit_stones ?? 0;
        const finalStones = Math.floor(baseStonesValue * realmMultiplier);
        if (finalStones > 0) {
            player.spirit_stones = BigInt(player.spirit_stones) + BigInt(finalStones);
        }
        granted.spirit_stones = finalStones;
        granted.base_spirit_stones = baseStonesValue;

        if (rewards.items && Array.isArray(rewards.items)) {
            // 走全仓唯一的"诚实发货门"（game/items/itemGrant.js）。改前这里自己 `Item.findOrCreate + increment`，
            // 于是四件事同时不成立：
            //   ① 绕过储物袋容量校验 —— 别的奖励路径（副本/探渊/战线/战斗掉落）都会因背包满而拒发，历练不会；
            //   ② 不查这件东西配不配发 —— 内容里写错键会静默变成背包里的垃圾行，而不是"没发到"；
            //   ③ 回执无条件记 `quantity: 1` —— 背包塞不下也照样告诉前端"已发放"（落库的 rewards 与库存两张皮）；
            //   ④ 每条只肯发 1 件 —— 资料片/新事件想配"给 3 枚"表达不出来，只能回来改这段硬编码。
            // grantItems 同时吃 `['key']` 与 `[{item_key, quantity}]` 两种写法：老内容照跑，新内容可以带数量。
            const grant = await grantItems(player.id, rewards.items, transaction, { label: '历练奖励' });
            granted.items = grant.granted;
            if (grant.failed.length) {
                granted.items_failed = grant.failed;
            }
        }

        await player.save({ transaction });

        return {
            success: true,
            granted
        };
    }

    /**
     * 生成战斗遭遇
     * @param {number} playerId - 玩家 ID
     * @returns {Object} 战斗数据
     */
    async generateCombatEncounter(playerId) {
        try {
            const player = await Player.findByPk(playerId);
            if (!player) {
                return { success: false, error: '玩家不存在' };
            }

            const currentMap = MapConfigLoader.getMap(player.current_map_id);
            if (!currentMap || !currentMap.monsters || currentMap.monsters.length === 0) {
                return { success: false, error: '当前地图没有怪物' };
            }

            // 清理该玩家旧的进行中战斗记录
            // ActiveBattle 表 player_id 有唯一约束 uk_player_battle，
            // 若不先清理旧记录，创建新战斗会因唯一约束冲突而失败
            await ActiveBattle.destroy({
                where: { player_id: playerId }
            });

            let monsterResult;
            if (this.aiService) {
                // 奖励上限取自这张图里最强的一条怪：模型（或被注入的提示词）不许比手绘怪还肥
                const expCeiling = Math.max(0, ...currentMap.monsters.map(m => Number(m.exp) || 0));
                monsterResult = await this.aiService.generateMonster({
                    playerRealm: player.realm,
                    mapEnvironment: currentMap.environment,
                    difficulty: 'normal',
                    expCeiling
                });
            }

            if (!monsterResult?.success) {
                const randomMonster = currentMap.monsters[Math.floor(Math.random() * currentMap.monsters.length)];
                // 修复 B24：怪物属性基于其境界计算，避免硬编码 hp:100/atk:15/def:5
                // 这样高境界地图的怪物强度与境界一致，玩家无法一击秒杀高境界怪
                const monsterStats = computeMonsterStatsByRealm(randomMonster.realm, randomMonster.exp || 10, randomMonster);
                monsterResult = {
                    success: true,
                    // 整块递过去：这里以前只挑 hp/atk/def/exp_reward 四个键，
                    // 于是资料片给这只怪声明的暴击/闪避在野外生效、进历练就凭空消失。
                    monster: {
                        id: randomMonster.id,
                        name: randomMonster.name,
                        realm: randomMonster.realm,
                        ...monsterStats
                    },
                    fromAI: false
                };
            }

            const monsterData = monsterResult.monster;

            const battle = await ActiveBattle.create({
                player_id: playerId,
                monster_id: monsterData.id || 'unknown',
                monster_name: monsterData.name,
                monster_data: monsterData,
                map_id: player.current_map_id,
                battle_type: 'normal',
                round: 1,
                turn: 'player',
                player_hp: player.hp_current,
                player_mp: player.mp_current,
                monster_hp: BigInt(monsterData.hp),
                monster_max_hp: BigInt(monsterData.hp),
                is_player_turn: true,
                expires_at: new Date(Date.now() + 30 * 60 * 1000),
                battle_log: [{
                    type: 'encounter',
                    description: monsterData.description || `遭遇了 ${monsterData.name}`,
                    timestamp: new Date().toISOString()
                }]
            });

            let description = `遭遇 ${monsterData.name}！`;
            if (this.aiService) {
                const eventResult = await this.aiService.generateAdventureEvent({
                    playerRealm: player.realm,
                    mapName: currentMap.name,
                    mapEnvironment: currentMap.environment,
                    eventType: 'combat'
                });
                if (eventResult.success) {
                    description = eventResult.description;
                }
            }

            const adventure = await this.getLastAdventureEvent(playerId);
            if (adventure) {
                // 战斗触发后，将 end_time 更新为当前时间，允许用户立即结束历练
                await PlayerAdventure.update(
                    {
                        combat_battle_id: battle.battle_uuid,
                        end_time: new Date()
                    },
                    { where: { id: adventure.id } }
                );
            }

            return {
                success: true,
                battle_id: battle.battle_uuid?.toString(),
                monster: {
                    id: monsterData.id,
                    name: monsterData.name,
                    realm: monsterData.realm,
                    hp: monsterData.hp.toString(),
                    max_hp: monsterData.hp.toString(),
                    atk: monsterData.atk?.toString() || '10',
                    def: monsterData.def?.toString() || '5',
                    speed: monsterData.speed?.toString() || '10',
                    exp_reward: monsterData.exp_reward || 10
                },
                player: {
                    hp: player.hp_current.toString(),
                    mp: player.mp_current.toString()
                },
                round: 1,
                turn: 'player',
                description,
                aiGenerated: monsterResult.fromAI || false
            };
        } catch (error) {
            console.error('[AdventureEventService] 生成战斗遭遇失败:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 获取玩家等级
     *
     * 修复 B1 bug：用 RealmService.getRealmRank 替代 REALM_ORDER.indexOf。
     * 旧逻辑 indexOf 在化神期及以上境界返回 -1，+1 后变成 0，等级计算错误。
     * 新逻辑直接返回 rank，与 realm_breakthrough.json 完全对齐。
     * @param {Object} player - 玩家对象
     * @returns {number} 等级（即境界 rank）
     */
    getPlayerLevel(player) {
        const RealmService = require('../core/RealmService');
        return RealmService.getRealmRank(player.realm);
    }

    /**
     * 获取当前时段
     * @returns {string} 时段
     */
    getTimeOfDay() {
        const hours = new Date().getHours();
        if (hours >= 5 && hours < 12) return '清晨';
        if (hours >= 12 && hours < 14) return '正午';
        if (hours >= 14 && hours < 18) return '午后';
        if (hours >= 18 && hours < 22) return '黄昏';
        return '深夜';
    }

    /**
     * 获取天气
     * @returns {string} 天气
     */
    getWeather() {
        const weathers = ['晴朗', '多云', '阴天', '小雨', '雾霾'];
        return weathers[Math.floor(Math.random() * weathers.length)];
    }

    /**
     * 获取 AI 服务状态
     * @returns {Object} 状态
     */
    getAIStatus() {
        if (!this.aiService) {
            return {
                available: false,
                reason: 'AI 服务未初始化'
            };
        }

        return {
            available: true,
            ...this.aiService.checkConfig()
        };
    }
}

module.exports = AdventureEventService;
// 怪物属性表是纯函数，摊出来给单测直接喂境界与声明（真跑一次历练要连库、还要 AI 状态）
module.exports.computeMonsterStatsByRealm = computeMonsterStatsByRealm;
