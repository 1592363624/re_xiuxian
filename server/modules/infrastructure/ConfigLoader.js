/**
 * 配置加载模块
 * 负责加载、校验、缓存配置文件，支持热更新
 * 数据配置层的核心模块
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class ConfigLoader extends EventEmitter {
    constructor() {
        super();
        this.configPath = path.join(__dirname, '../../config');
        this.configCache = new Map();
        this.configValidator = null;
        this.isInitialized = false;
    }

    /**
     * 初始化配置加载器
     */
    async initialize() {
        try {
            this.configValidator = require('./ConfigValidator');
            await this.loadAllConfigs();
            this.isInitialized = true;
            console.log('配置加载模块初始化完成');
            return { success: true };
        } catch (error) {
            console.error('配置加载模块初始化失败:', error);
            throw error;
        }
    }

    /**
     * 批量加载所有配置文件
     */
    async loadAllConfigs() {
        const configFiles = [
            'realm_breakthrough',
            'role_init',
            'item_data',
            'map_data',
            'ui_layout',
            'ui_routes',
            'seclusion',      // 闭关修炼配置
            'system',         // 系统全局配置
            'talents',        // 天赋配置
            'titles',         // 称号配置
            'game_balance',   // 游戏平衡配置
            'ai_config',      // AI 大模型配置（支持多厂商 OpenAI 兼容协议）
            'sect_data',      // 宗门静态配置（6 大宗门信息、宝库、任务）
            'sect_special_data', // 宗门专属玩法配置（灵眼之树/观星台/命盘/天阶/魔道/炉鼎）
            'cave_data',       // 洞府静态配置（设施升级消耗、药园地块、种子数据）
            'stock_data',      // 股市静态配置（股票定义、总股本、基础价格）
            'crafting_data',   // 炼制系统配置（炼丹/炼器配方、技能等级表）
            'dungeon_data',    // 副本系统静态配置（章节、关卡、奖励、难度系数）
            'formation_data',  // 阵法系统静态配置（10大阵法、4类×4品阶、熟练度、相克关系）
            'world_boss_data', // 世界BOSS静态配置（批次2：3个BOSS属性/技能/掉落/刷新计划）
            'sect_war_data',   // 宗门战资源点静态配置（批次2：9个资源点坐标/类型/产出）
            'ascension_data',  // 飞升+夺舍重生系统配置（批次3：问道/法相天地/探寻裂缝/飞升/空间节点/夺舍目标）
            'late_stage_data', // 后期系统配置（批次3：第二元神/小世界/神庙/香火/神识/法则）
            'companion_data',  // 道侣/双修/侍妾系统配置（批次3：道侣关系/侍妾/远航/心劫）
            'multi_dungeon_data',  // 多人副本系统配置（批次3：掩月抢亲/端午镇蛟）
            'spirit_beast_data',   // 灵兽系统静态配置（4阶灵兽/五行相克/培养参数）
            'dao_companion_data',  // 道侣/双修系统配置（玩家间 1v1 长期社交：求婚/双修/心契/心印/心劫）
            'spirit_system',       // 灵力系统配置（各境界灵力上限/恢复速率/消耗/增长曲线）
            'attribute_system',    // 属性系统配置（HP/MP 自然恢复与冥想恢复速率）
            'border_military_data', // 慕兰战线配置（批次5：军议/支援/谍影/军功司/灵兽边境/残图匣/临战刻印）
            'cave_legacy_data',      // 坐化遗府配置（批次5：异步多人 PvP/协作玩法，退坑玩家资产分配）
            'spirit_beast_pvp_data', // 灵兽PVP竞技场配置（批次5：押注/段位/赛季/战术/自动战斗）
            'spirit_beast_pasture_data', // 灵兽放养与偷菜配置（批次5：放养场所/产物/偷菜概率/护院机制）
            'spirit_beast_abyss_data',  // 灵兽探渊配置（批次5：9层深渊/PVE怪物/PVP遭遇/兽魂凝练）
            'taoism_gate_data',         // 太一门引道配置（批次5：5种道途/等级/技能/任务/共鸣）
            'beast_invasion_data',      // 妖兽入侵静态配置（多人公共事件：3只妖兽属性/捐献需求/奖励池/技能表）
            'artifact_deep_lines'       // 法宝深线配置（玩法文档第19节：血魔剑/虚天鼎/掌天瓶/幻世轮四条线）
        ];
        const results = {};

        for (const configName of configFiles) {
            try {
                const config = await this.loadConfig(configName);
                this.configCache.set(configName, config);
                results[configName] = { success: true, data: config };
            } catch (error) {
                console.error(`加载配置文件 ${configName} 失败:`, error);
                results[configName] = { success: false, error: error.message };
                const backupConfig = this.loadBackupConfig(configName);
                if (backupConfig) {
                    this.configCache.set(configName, backupConfig);
                    results[configName] = { success: true, data: backupConfig, useBackup: true };
                }
            }
        }

        this.emit('configsLoaded', results);
        return results;
    }

    /**
     * 加载单个配置文件
     * @param {string} configName - 配置文件名称（不含扩展名）
     */
    async loadConfig(configName) {
        const filePath = path.join(this.configPath, `${configName}.json`);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`配置文件不存在: ${filePath}`);
        }

        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const configData = JSON.parse(fileContent);

        if (this.configValidator) {
            const validationResult = this.configValidator.validate(configName, configData);
            if (!validationResult.valid) {
                throw new Error(`配置文件 ${configName} 校验失败: ${validationResult.errors.join(', ')}`);
            }
        }

        return configData;
    }

    /**
     * 加载备份配置
     */
    loadBackupConfig(configName) {
        const backupPath = path.join(this.configPath, 'backup', `${configName}.json`);
        if (fs.existsSync(backupPath)) {
            try {
                const backupContent = fs.readFileSync(backupPath, 'utf-8');
                return JSON.parse(backupContent);
            } catch (error) {
                console.error(`加载备份配置 ${configName} 失败:`, error);
            }
        }
        return null;
    }

    /**
     * 获取配置数据
     * @param {string} configName - 配置名称
     * @param {string} [key] - 配置键名，可选
     */
    getConfig(configName, key = null) {
        const config = this.configCache.get(configName);
        if (!config) {
            throw new Error(`配置 ${configName} 未加载`);
        }

        if (key === null) {
            return config;
        }

        return config[key];
    }

    /**
     * 热更新配置
     * @param {string} configName - 配置名称
     */
    async hotUpdateConfig(configName) {
        try {
            const newConfig = await this.loadConfig(configName);
            
            const oldConfig = this.configCache.get(configName);
            this.configCache.set(configName, newConfig);

            this.emit('configHotUpdated', { 
                configName, 
                oldConfig, 
                newConfig,
                timestamp: Date.now()
            });

            return { success: true, configName };
        } catch (error) {
            console.error(`热更新配置 ${configName} 失败:`, error);
            throw error;
        }
    }

    /**
     * 重新加载所有配置
     */
    async reloadAllConfigs() {
        this.configCache.clear();
        return await this.loadAllConfigs();
    }

    /**
     * 检查配置是否存在
     */
    hasConfig(configName) {
        return this.configCache.has(configName);
    }

    /**
     * 获取所有已加载的配置名称
     */
    getLoadedConfigNames() {
        return Array.from(this.configCache.keys());
    }
}

module.exports = new ConfigLoader();
