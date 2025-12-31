/**
 * 历练事件服务
 * 
 * 处理玩家历练过程中的事件生成与管理
 * 支持 AI 生成和模板生成两种模式
 */
const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerMapPosition = require('../models/playerMapPosition');
const ActiveBattle = require('../models/activeBattle');
const Item = require('../models/item');
const PlayerAdventure = require('../models/playerAdventure');
const MapConfigLoader = require('./MapConfigLoader');
const DropLoader = require('./DropLoader');
const AIService = require('./AIService');

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
            aiService = await AIService.initialize(configLoader);
            console.log('[AdventureEventService] AI 服务初始化成功');
        } catch (error) {
            console.warn('[AdventureEventService] AI 服务初始化失败，将使用模板模式:', error.message);
        }

        const service = new AdventureEventService(aiService);
        console.log('[AdventureEventService] 历练事件服务已初始化');
        return service;
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

            const adventureConfig = options.duration 
                ? { duration: options.duration }
                : this.getAdventureConfig();

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

            const adventure = await PlayerAdventure.create({
                player_id: playerId,
                map_id: player.current_map_id,
                map_name: currentMap.name,
                event_id: event.id,
                event_type: event.type,
                event_data: JSON.stringify(event),
                start_time: new Date(),
                end_time: new Date(Date.now() + eventContext.duration * 1000),
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
     * 获取历练配置
     * @returns {Object} 配置
     */
    getAdventureConfig() {
        return {
            duration: 60 + Math.floor(Math.random() * 60),
            expMultiplier: 1.0
        };
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
            if (now < endTime) {
                const remainingSeconds = Math.ceil((endTime - now) / 1000);
                const minutes = Math.floor(remainingSeconds / 60);
                const seconds = remainingSeconds % 60;
                return { 
                    success: false, 
                    code: 'ADVENTURE_NOT_COMPLETED', 
                    message: `历练尚未结束，请等待 ${minutes}分${seconds}秒` 
                };
            }

            const eventObj = typeof eventData.event_data === 'string' 
                ? JSON.parse(eventData.event_data) 
                : eventData.event_data;
            const rewards = eventObj?.rewards || {};
            const result = await this.grantRewards(playerId, rewards);

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
                await PlayerAdventure.update(
                    { combat_battle_id: battle.battle_uuid },
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
        const realmOrder = [
            '凡人', '炼气1层', '炼气2层', '炼气3层', '炼气4层', '炼气5层',
            '炼气6层', '炼气7层', '炼气8层', '炼气9层', '炼气10层',
            '炼气11层', '炼气12层', '炼气13层', '炼气圆满',
            '筑基期', '筑基初期', '筑基中期', '筑基后期', '筑基圆满',
            '金丹期', '金丹初期', '金丹中期', '金丹后期', '金丹圆满',
            '元婴期', '元婴初期', '元婴中期', '元婴后期', '元婴圆满',
            '化神期'
        ];
        return realmOrder.indexOf(player.realm) + 1;
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
