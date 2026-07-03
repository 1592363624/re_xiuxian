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

class AdventureEventService {
    /**
     * 构造函数
     * @param {Object} aiService - AI 服务实例
     */
    constructor(aiService = null) {
        this.aiService = aiService;
        this.eventTemplates = this.loadEventTemplates();
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
        return {
            peaceful: [
                {
                    id: 'peaceful_1',
                    title: '灵气充盈',
                    description: '此地的灵气颇为充盈，你寻得一处僻静之地，静坐吐纳，吸纳天地灵气',
                    duration: 60,
                    rewards: { exp: 10, mp: 5 }
                },
                {
                    id: 'peaceful_2',
                    title: '心境平和',
                    description: '漫步于山水之间，心中杂念渐消，道心愈发通透',
                    duration: 45,
                    rewards: { exp: 8, wisdom: 1 }
                },
                {
                    id: 'peaceful_3',
                    title: '偶有所悟',
                    description: '观摩天地自然之道，忽然心有所感，仿佛触摸到了某条大道的一丝脉络',
                    duration: 90,
                    rewards: { exp: 15, realm_insight: 1 }
                }
            ],
            combat: [
                {
                    id: 'combat_1',
                    title: '妖兽袭击',
                    description: '林中忽然窜出一只凶兽，眼中闪着血红的光芒，似乎已将你锁定为目标',
                    duration: 120,
                    monsterType: 'beast',
                    rewards: { exp: 50, items: true }
                },
                {
                    id: 'combat_2',
                    title: '拦路劫修',
                    description: '一道黑影从林中窜出，却是一名等级不低的劫修，眼中满是贪婪之色',
                    duration: 150,
                    monsterType: 'cultivator',
                    rewards: { exp: 80, spirit_stones: true }
                },
                {
                    id: 'combat_3',
                    title: '守护灵兽',
                    description: '你惊动了一只正在守护某物的灵兽，它怒吼着向你扑来',
                    duration: 180,
                    monsterType: 'guardian_beast',
                    rewards: { exp: 100, treasure: true }
                }
            ],
            treasure: [
                {
                    id: 'treasure_1',
                    title: '灵草发现',
                    description: '拨开草丛，你发现了一株散发着淡淡荧光的灵草，正是炼制丹药的稀有材料',
                    duration: 30,
                    rewards: { items: ['spirit_herb'] }
                },
                {
                    id: 'treasure_2',
                    title: '前人遗府',
                    description: '在一处隐蔽的崖壁下，你发现了一处前人遗留下的洞府遗迹',
                    duration: 60,
                    rewards: { items: ['ancient_token'], exp: 30 }
                },
                {
                    id: 'treasure_3',
                    title: '灵泉',
                    description: '你发现了一处天然的灵泉，泉水散发着诱人的灵气',
                    duration: 45,
                    rewards: { exp: 25, mp: 20 }
                }
            ],
            encounter: [
                {
                    id: 'encounter_1',
                    title: '神秘散修',
                    description: '偶遇一位行色匆匆的散修，彼此点头示意后各自离去',
                    duration: 20,
                    rewards: { exp: 5, information: '附近有异宝' }
                },
                {
                    id: 'encounter_2',
                    title: '高人指点',
                    description: '一位灰袍老者从你身旁经过，深深看了你一眼，留下一句指点后飘然远去',
                    duration: 30,
                    rewards: { exp: 20, technique_hint: true }
                },
                {
                    id: 'encounter_3',
                    title: '坊市见闻',
                    description: '来到一处小型坊市，人声鼎沸，各种修仙者在此交易',
                    duration: 40,
                    rewards: { exp: 15, trade_opportunity: true }
                }
            ],
            discovery: [
                {
                    id: 'discovery_1',
                    title: '奇景',
                    description: '站在高处远眺，云海翻涌，气象万千，令你心境开阔',
                    duration: 35,
                    rewards: { exp: 12, realm_insight: 1 }
                },
                {
                    id: 'discovery_2',
                    title: '古迹',
                    description: '此处似乎是一处远古遗迹，虽已斑驳，但仍能感受到当年的辉煌',
                    duration: 50,
                    rewards: { exp: 20, ancient_knowledge: true }
                },
                {
                    id: 'discovery_3',
                    title: '天然阵法',
                    description: '此处天地灵气流转有异，似乎有一处天然形成的阵法',
                    duration: 60,
                    rewards: { exp: 25, array_insight: 1 }
                }
            ]
        };
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
        const weights = {
            peaceful: 40,
            combat: 35,
            treasure: 10,
            encounter: 10,
            discovery: 5
        };

        const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
        let random = Math.random() * totalWeight;

        for (const [type, weight] of Object.entries(weights)) {
            if (random < weight) {
                return type;
            }
            random -= weight;
        }

        return 'peaceful';
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
        const templates = this.eventTemplates[eventType] || this.eventTemplates.peaceful;
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
        const titles = {
            peaceful: '修炼感悟',
            combat: '战斗遭遇',
            treasure: '意外发现',
            encounter: '途中偶遇',
            discovery: '新见所闻'
        };
        return titles[eventType] || '历练事件';
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
        const baseExp = {
            peaceful: { min: 10, max: 30 },
            combat: { min: 50, max: 150 },
            treasure: { min: 20, max: 60 },
            encounter: { min: 10, max: 40 },
            discovery: { min: 15, max: 45 }
        };

        const range = baseExp[eventType] || baseExp.peaceful;
        const exp = range.min + Math.floor(Math.random() * (range.max - range.min));

        return { exp };
    }

    /**
     * 完成历练
     * @param {number} playerId - 玩家 ID
     * @returns {Object} 完成结果
     */
    async completeAdventure(playerId) {
        try {
            const player = await Player.findByPk(playerId);
            if (!player) {
                return { success: false, code: 'PLAYER_NOT_FOUND', message: '玩家不存在' };
            }

            const eventData = await this.getLastAdventureEvent(playerId);
            if (!eventData) {
                return { success: false, code: 'NO_ADVENTURE', message: '没有进行中的历练' };
            }

            if (eventData.status !== 'in_progress') {
                return { success: false, code: 'INVALID_STATUS', message: '当前历练状态不允许完成' };
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
            // 奖励 = 基础奖励 × 提前结束折扣 × 时长倍率
            const rawRewards = eventObj?.rewards || {};
            const rewards = {
                exp: Math.floor((rawRewards.exp || 0) * rewardScale * rewardMultiplier),
                spirit_stones: Math.floor((rawRewards.spirit_stones || 0) * rewardScale * rewardMultiplier),
                items: rawRewards.items || []
            };
            const result = await this.grantRewards(playerId, rewards);

            // 风险机制：历练可能受伤（损失气血），长时历练受伤概率更高
            const durationType = eventObj?.duration_type || 'medium';
            const durationConfig = this.getAdventureDurationConfig(durationType);
            let injury = null;
            if (Math.random() < (durationConfig.injury_chance || 0)) {
                // 重新获取玩家（grantRewards 已更新玩家数据）
                const playerForInjury = await Player.findByPk(playerId);
                if (playerForInjury) {
                    const currentHp = Number(playerForInjury.hp_current);
                    const hpLoss = Math.floor(currentHp * (durationConfig.injury_hp_loss_rate || 0.08));
                    if (hpLoss > 0) {
                        let newHp = BigInt(playerForInjury.hp_current) - BigInt(hpLoss);
                        if (newHp < 0n) newHp = 0n;
                        playerForInjury.hp_current = newHp;
                        await playerForInjury.save();
                        injury = { hp_loss: hpLoss };
                    }
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
                    where: { id: eventData.id }
                }
            );

            return {
                success: true,
                message: '历练完成',
                rewards: result
            };
        } catch (error) {
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
     * 授予奖励
     * @param {number} playerId - 玩家 ID
     * @param {Object} rewards - 奖励
     * @returns {Object} 授予结果
     */
    async grantRewards(playerId, rewards) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, error: '玩家不存在' };
        }

        const granted = {
            exp: 0,
            items: [],
            spirit_stones: 0
        };

        if (rewards.exp) {
            player.exp = BigInt(player.exp) + BigInt(rewards.exp);
            granted.exp = rewards.exp;
        }

        if (rewards.mp) {
            player.mp_current = BigInt(player.mp_current) + BigInt(rewards.mp);
            granted.mp = rewards.mp;
        }

        if (rewards.spirit_stones) {
            player.spirit_stones = BigInt(player.spirit_stones) + BigInt(rewards.spirit_stones);
            granted.spirit_stones = rewards.spirit_stones;
        }

        if (rewards.items && Array.isArray(rewards.items)) {
            for (const itemKey of rewards.items) {
                await Item.upsert({
                    player_id: playerId,
                    item_key: itemKey,
                    quantity: 1
                });
                granted.items.push({ item_key: itemKey, quantity: 1 });
            }
        }

        await player.save();

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
                monsterResult = await this.aiService.generateMonster({
                    playerRealm: player.realm,
                    mapEnvironment: currentMap.environment,
                    difficulty: 'normal'
                });
            }

            if (!monsterResult?.success) {
                const randomMonster = currentMap.monsters[Math.floor(Math.random() * currentMap.monsters.length)];
                monsterResult = {
                    success: true,
                    monster: {
                        id: randomMonster.id,
                        name: randomMonster.name,
                        realm: randomMonster.realm,
                        hp: 100,
                        atk: 15,
                        def: 5,
                        exp_reward: randomMonster.exp || 10
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
     * @param {Object} player - 玩家对象
     * @returns {number} 等级
     */
    getPlayerLevel(player) {
        const { REALM_ORDER } = require('../../utils/gameConstants');
        return REALM_ORDER.indexOf(player.realm) + 1;
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
