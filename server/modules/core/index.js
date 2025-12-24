/**
 * 核心逻辑层模块索引
 * 统一导出所有核心服务模块
 */

// 境界服务
const RealmService = require('./RealmService');

// 玩家服务 (直接使用 require 加载 ConfigLoader，无需初始化)
const PlayerService = require('./PlayerService');

// 寿命服务 (直接使用 require 加载 ConfigLoader，无需初始化)
const LifespanService = require('./LifespanService');

// 物品服务 (需要初始化)
const ItemService = require('./ItemService');

// 经验服务 (需要初始化)
const ExperienceService = require('./ExperienceService');

// 属性服务 (需要初始化)
const AttributeService = require('./AttributeService');

// 地图服务 (需要初始化)
const MapService = require('./MapService');

/**
 * 初始化所有核心服务
 * @param {Object} configLoader - 配置加载器实例
 */
function initializeCoreServices(configLoader) {
    // PlayerService 和 LifespanService 直接使用 require 加载 ConfigLoader，无需初始化
    ItemService.initialize(configLoader);
    ExperienceService.initialize(configLoader);
    AttributeService.initialize(configLoader);
    MapService.initialize(configLoader);
    
    console.log('核心服务模块初始化完成');
}

module.exports = {
    RealmService,
    PlayerService,
    LifespanService,
    ItemService,
    ExperienceService,
    AttributeService,
    MapService,
    initializeCoreServices
};
