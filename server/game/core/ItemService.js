/**
 * 物品服务模块
 * 处理物品相关的核心业务逻辑
 */
class ItemService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化物品服务
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 获取所有物品配置
     * @returns {Array} 物品配置列表
     */
    getAllItems() {
        const config = this.configLoader?.getConfig('item_data');
        return config?.items || [];
    }

    /**
     * 根据物品ID获取物品配置
     * @param {string} itemId - 物品ID
     * @returns {Object|null} 物品配置
     */
    getItemById(itemId) {
        const items = this.getAllItems();
        return items.find(item => item.id === itemId) || null;
    }

    /**
     * 根据物品类型获取物品列表
     * @param {string} type - 物品类型
     * @returns {Array} 物品列表
     */
    getItemsByType(type) {
        const items = this.getAllItems();
        return items.filter(item => item.type === type);
    }

    /**
     * 获取物品使用效果
     * @param {string} itemId - 物品ID
     * @param {Object} player - 玩家对象
     * @returns {Object} 使用效果
     */
    getItemEffect(itemId, player) {
        const item = this.getItemById(itemId);
        if (!item || !item.effects) {
            return null;
        }

        const effects = {};
        for (const [key, value] of Object.entries(item.effects)) {
            effects[key] = value;
        }

        return effects;
    }

    /**
     * 使用物品
     * @param {string} itemId - 物品ID
     * @param {Object} player - 玩家对象
     * @returns {Object} 使用结果
     */
    async useItem(itemId, player) {
        const item = this.getItemById(itemId);
        if (!item) {
            return { success: false, message: '物品不存在' };
        }

        if (!item.consumable) {
            return { success: false, message: '该物品不可使用' };
        }

        const effects = this.getItemEffect(itemId, player);
        if (!effects) {
            return { success: false, message: '物品效果无效' };
        }

        return {
            success: true,
            message: `使用了 ${item.name}`,
            effects: effects,
            itemName: item.name
        };
    }

    /**
     * 获取物品分类列表
     * @returns {Array} 物品分类列表
     */
    getItemCategories() {
        const items = this.getAllItems();
        const categories = [...new Set(items.map(item => item.type))];
        return categories;
    }

    /**
     * 获取物品稀有度颜色
     * @param {string} rarity - 稀有度
     * @returns {string} 颜色代码
     */
    getRarityColor(rarity) {
        const colors = {
            common: '#FFFFFF',
            uncommon: '#1EFF00',
            rare: '#0070DD',
            epic: '#A335EE',
            legendary: '#FF8000'
        };
        return colors[rarity] || colors.common;
    }
}

module.exports = new ItemService();
