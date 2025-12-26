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
        const configFiles = ['realm_breakthrough', 'role_init', 'item_data', 'map_data', 'ui_layout', 'ui_routes'];
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
