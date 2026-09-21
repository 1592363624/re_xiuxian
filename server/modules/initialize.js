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

        // 内容层（资料片/DLC）：合并基础配置与 server/content/packs，并装入属性注册中心。
        // 校验不过会抛错，让启动失败，而不是运行期静默返回 undefined。
        // CONTENT_PACK_DIR 只给探针/运维换 pack 目录用（默认 server/content/packs），
        // 否则"验证一个新资料片"只能往仓库里塞文件。
        const { initializeContentLayer } = require('../game/content');
        const packDir = process.env.CONTENT_PACK_DIR || undefined;
        const { report } = initializeContentLayer(configLoader, { packDir });

        eventBus.emit('modulesInitialized', { 
            timestamp: Date.now(),
            loadedConfigs: configLoader.getLoadedConfigNames(),
            contentPacks: report.packs
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
