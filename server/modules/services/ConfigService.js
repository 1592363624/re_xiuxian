/**
 * 系统配置统一管理模块
 * 负责从 JSON 文件读取/写入系统配置
 */
const configLoader = require('../modules/infrastructure/ConfigLoader');
const fs = require('fs');
const path = require('path');

const CONFIG_FILES = {
    system: path.join(__dirname, '../config/system.json'),
    seclusion: path.join(__dirname, '../config/seclusion.json')
};

/**
 * 获取配置值
 * @param {string} configFile - 配置文件名 (system/seclusion)
 * @param {string} key - 配置键名
 * @param {*} defaultValue - 默认值
 */
function getConfig(configFile, key, defaultValue = null) {
    try {
        const config = configLoader.getConfig(configFile);
        if (config && config.settings && config.settings[key]) {
            return config.settings[key].value;
        }
        return defaultValue;
    } catch (err) {
        console.error(`获取配置 ${configFile}.${key} 失败:`, err);
        return defaultValue;
    }
}

/**
 * 设置配置值（写入JSON文件）
 * @param {string} configFile - 配置文件名
 * @param {string} key - 配置键名
 * @param {*} value - 配置值
 * @param {string} displayName - 显示名称
 */
function setConfig(configFile, key, value, displayName = null) {
    try {
        const filePath = CONFIG_FILES[configFile];
        if (!filePath) {
            throw new Error(`未知配置文件: ${configFile}`);
        }

        let config = { settings: {} };
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            config = JSON.parse(content);
        }

        if (!config.settings[key]) {
            config.settings[key] = { value: value };
            if (displayName) {
                config.settings[key].displayName = displayName;
            }
        } else {
            config.settings[key].value = value;
        }

        config.lastUpdated = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
        
        // 热更新配置
        configLoader.hotUpdateConfig(configFile);

        return true;
    } catch (err) {
        console.error(`设置配置 ${configFile}.${key} 失败:`, err);
        return false;
    }
}

/**
 * 获取所有配置（包含来源信息）
 * @param {string} configFile - 配置文件名
 */
function getAllConfigs(configFile) {
    try {
        const config = configLoader.getConfig(configFile);
        return config?.settings || {};
    } catch (err) {
        console.error(`获取配置 ${configFile} 失败:`, err);
        return {};
    }
}

// 系统配置快捷方法
const SystemConfig = {
    getAutoSaveInterval: () => getConfig('system', 'auto_save_interval', 10000),
    setAutoSaveInterval: (value) => setConfig('system', 'auto_save_interval', value, '自动存档间隔'),
    getInitialLifespan: () => getConfig('system', 'initial_lifespan', 100),
    setInitialLifespan: (value) => setConfig('system', 'initial_lifespan', value, '初始寿元'),
    getServerPort: () => getConfig('system', 'server_port', 3000)
};

module.exports = {
    getConfig,
    setConfig,
    getAllConfigs,
    SystemConfig
};
