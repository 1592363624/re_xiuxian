/**
 * 安全配置加载助手
 * 
 * 提供带默认值和降级处理的配置读取方法，
 * 避免配置缺失导致模块加载失败
 */

const ConfigHelper = {
    /**
     * 安全获取配置值，带默认值
     * @param {string} configName - 配置文件名（如 'game_balance'）
     * @param {string} configPath - 配置路径，支持点号分隔（如 'combat.skill_mp_cost'）
     * @param {*} defaultValue - 默认值
     * @param {Function} [validator] - 可选的值验证函数
     * @returns {*} 配置值或默认值
     */
    getConfigValue(configName, configPath, defaultValue = null, validator = null) {
        try {
            const { infrastructure } = require('../modules');
            const configLoader = infrastructure.ConfigLoader;
            const config = configLoader.getConfig(configName);

            const value = configPath.split('.').reduce((obj, key) => obj?.[key], config);

            if (value === undefined || value === null) {
                console.warn(`配置项 ${configName}.${configPath} 不存在，使用默认值: ${defaultValue}`);
                return defaultValue;
            }

            if (validator && !validator(value)) {
                console.warn(`配置项 ${configName}.${configPath} 值无效: ${value}，使用默认值: ${defaultValue}`);
                return defaultValue;
            }

            return value;
        } catch (error) {
            console.error(`读取配置 ${configName}.${configPath} 失败:`, error.message);
            return defaultValue;
        }
    },

    /**
     * 获取数值配置，带范围验证
     * @param {string} configName - 配置文件名
     * @param {string} configPath - 配置路径
     * @param {number} defaultValue - 默认值
     * @param {number|null} min - 最小值
     * @param {number|null} max - 最大值
     * @returns {number}
     */
    getNumericConfig(configName, configPath, defaultValue, min = null, max = null) {
        return this.getConfigValue(configName, configPath, defaultValue, (value) => {
            if (typeof value !== 'number' || isNaN(value)) return false;
            if (min !== null && value < min) return false;
            if (max !== null && value > max) return false;
            return true;
        });
    }
};

module.exports = ConfigHelper;
