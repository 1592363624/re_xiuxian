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
const InventoryService = require('./services/InventoryService');
const SectService = require('./services/SectService');
const MarketService = require('./services/MarketService');
const EquipmentService = require('./services/EquipmentService');
const CraftingService = require('./services/CraftingService');
const DuelService = require('./services/DuelService');
const BountyService = require('./services/BountyService');
const FengshenService = require('./services/FengshenService');
const CaveSocialService = require('./services/CaveSocialService');
const SectSpecialService = require('./services/SectSpecialService');
const RedPacketService = require('./services/RedPacketService');

// 基础设施模块（从 modules 重新导出）
const { infrastructure } = require('../modules');

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
    // 新增系统服务初始化
    InventoryService.initialize(configLoader);
    SectService.initialize(configLoader);
    MarketService.initialize(configLoader);
    EquipmentService.initialize(configLoader);
    CraftingService.initialize(configLoader);
    // PVP 扩展系统服务初始化
    DuelService.initialize(configLoader);
    BountyService.initialize(configLoader);
    FengshenService.initialize(configLoader);
    // 洞府社交系统服务初始化
    CaveSocialService.initialize(configLoader);
    // 宗门专属玩法服务初始化（灵眼树/观星台/命盘/天阶/魔道/炉鼎）
    SectSpecialService.initialize(configLoader);
    // 聊天红包系统服务初始化
    RedPacketService.initialize(configLoader);

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
    InventoryService,
    SectService,
    MarketService,
    EquipmentService,
    CraftingService,
    DuelService,
    BountyService,
    FengshenService,
    CaveSocialService,
    SectSpecialService,
    RedPacketService,

    // 基础设施
    ConfigLoader: infrastructure?.ConfigLoader,
    
    // 初始化函数
    initializeGameServices
};
