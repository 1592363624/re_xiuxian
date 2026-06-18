/**
 * 模块导出索引
 * 按架构分层组织模块导出
 * 注意：核心游戏服务已迁移至 game/ 目录，此处仅保留基础设施模块
 */
const infrastructure = {
    ConfigLoader: require('./infrastructure/ConfigLoader'),
    ConfigValidator: require('./infrastructure/ConfigValidator'),
    EventBus: require('./infrastructure/EventBus')
};

const application = {
    InterfaceGateway: require('./application/InterfaceGateway')
};

const { initializeModules } = require('./initialize');

module.exports = {
    infrastructure,
    application,
    initializeModules
};
