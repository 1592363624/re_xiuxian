/**
 * 游戏核心模块索引
 * 统一导出所有游戏核心服务
 */

// 核心服务
const PlayerService = require('./core/PlayerService');
const RealmService = require('./core/RealmService');
const LifespanService = require('./core/LifespanService');
const AttributeService = require('./core/AttributeService');
const AttributeMaxService = require('./core/AttributeMaxService');
const ExperienceService = require('./core/ExperienceService');
const ItemService = require('./core/ItemService');
const MapService = require('./core/MapService');
const DualTimeService = require('./core/DualTimeService');

// 游戏服务
const CombatService = require('./services/CombatService');
const GatheringService = require('./services/GatheringService');
const MapConfigLoader = require('./services/MapConfigLoader');
const DropLoader = require('./services/DropLoader');
const ResourceLoader = require('./services/ResourceLoader');
const NotificationService = require('./services/NotificationService');
const WebSocketNotificationService = require('./services/WebSocketNotificationService');
const AdventureEventService = require('./services/AdventureEventService');
const AIService = require('./services/AIService');

/**
 * 初始化所有游戏核心服务
 * @param {Object} configLoader - 配置加载器实例
 */
async function initializeGameServices(configLoader) {
    // 需要初始化的服务
    ItemService.initialize(configLoader);
    ExperienceService.initialize(configLoader);
    AttributeService.initialize(configLoader);
    // AttributeMaxService.initialize 是异步方法，需要等待
    await AttributeMaxService.initialize(configLoader);
    DualTimeService.initialize(configLoader);
    MapService.initialize(configLoader);
    
    console.log('游戏核心服务模块初始化完成');
}

module.exports = {
    // 核心服务
    PlayerService,
    RealmService,
    LifespanService,
    AttributeService,
    AttributeMaxService,
    ExperienceService,
    ItemService,
    MapService,
    DualTimeService,
    
    // 游戏服务
    CombatService,
    GatheringService,
    MapConfigLoader,
    DropLoader,
    ResourceLoader,
    NotificationService,
    WebSocketNotificationService,
    AdventureEventService,
    AIService,
    
    // 初始化函数
    initializeGameServices
};
