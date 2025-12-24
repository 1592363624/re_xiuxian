/**
 * 模块初始化脚本
 * 在应用启动时初始化所有基础设施模块
 */
async function initializeModules() {
    const configLoader = require('./infrastructure/ConfigLoader');
    const eventBus = require('./infrastructure/EventBus');
    
    console.log('开始初始化模块...');
    
    try {
        await configLoader.initialize();
        console.log('配置加载器初始化成功，已加载配置:', configLoader.getLoadedConfigNames());
        
        eventBus.emit('modulesInitialized', { 
            timestamp: Date.now(),
            loadedConfigs: configLoader.getLoadedConfigNames()
        });
        
        return { 
            success: true, 
            configLoader,
            loadedConfigs: configLoader.getLoadedConfigNames()
        };
    } catch (error) {
        console.error('模块初始化失败:', error.message);
        throw error;
    }
}

module.exports = { initializeModules };
