/**
 * 模块导出索引
 * 按架构分层组织模块导出
 */
const infrastructure = {
    ConfigLoader: require('./infrastructure/ConfigLoader'),
    ConfigValidator: require('./infrastructure/ConfigValidator'),
    EventBus: require('./infrastructure/EventBus')
};

const coreIndex = require('./core');
const core = {
    RealmService: coreIndex.RealmService,
    PlayerService: coreIndex.PlayerService,
    LifespanService: coreIndex.LifespanService,
    ItemService: coreIndex.ItemService,
    ExperienceService: coreIndex.ExperienceService,
    AttributeService: coreIndex.AttributeService,
    MapService: coreIndex.MapService,
    initializeCoreServices: coreIndex.initializeCoreServices
};

const application = {
    InterfaceGateway: require('./application/InterfaceGateway')
};

const { initializeModules } = require('./initialize');

module.exports = {
    infrastructure,
    core,
    application,
    initializeModules
};
