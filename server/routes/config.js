/**
 * 配置相关路由
 * 处理配置获取、热更新等接口
 */
const express = require('express');
const router = express.Router();
const { infrastructure } = require('../modules');

/**
 * 获取所有配置列表
 * GET /api/config/list
 */
router.get('/list', async (req, res) => {
    try {
        const configNames = [
            'realm_breakthrough',
            'role_init',
            'item_data',
            'map_data',
            'ui_layout',
            'ui_routes'
        ];

        const configs = {};
        for (const name of configNames) {
            const config = infrastructure.ConfigLoader?.getConfig(name);
            configs[name] = config ? { loaded: true, size: JSON.stringify(config).length } : { loaded: false };
        }

        res.json({
            code: 200,
            data: {
                configs: configs,
                available_configs: configNames
            }
        });
    } catch (error) {
        console.error('获取配置列表失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 获取指定配置
 * GET /api/config/:configName
 */
router.get('/:configName', async (req, res) => {
    try {
        const { configName } = req.params;
        const validConfigs = [
            'realm_breakthrough',
            'role_init',
            'item_data',
            'map_data',
            'ui_layout',
            'ui_routes'
        ];

        if (!validConfigs.includes(configName)) {
            return res.status(400).json({ 
                code: 400, 
                message: '无效的配置名称' 
            });
        }

        const config = infrastructure.ConfigLoader?.getConfig(configName);
        
        if (!config) {
            return res.status(404).json({ 
                code: 404, 
                message: '配置未加载或不存在' 
            });
        }

        res.json({
            code: 200,
            data: {
                config_name: configName,
                config: config
            }
        });
    } catch (error) {
        console.error('获取配置失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 获取境界配置
 * GET /api/config/realms
 */
router.get('/data/realms', async (req, res) => {
    try {
        const config = infrastructure.ConfigLoader?.getConfig('realm_breakthrough');
        
        if (!config?.realms) {
            return res.status(404).json({ 
                code: 404, 
                message: '境界配置未加载' 
            });
        }

        res.json({
            code: 200,
            data: {
                realms: config.realms,
                count: config.realms.length
            }
        });
    } catch (error) {
        console.error('获取境界配置失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 获取角色初始化配置
 * GET /api/config/role-init
 */
router.get('/data/role-init', async (req, res) => {
    try {
        const config = infrastructure.ConfigLoader?.getConfig('role_init');
        
        if (!config) {
            return res.status(404).json({ 
                code: 404, 
                message: '角色初始化配置未加载' 
            });
        }

        res.json({
            code: 200,
            data: config
        });
    } catch (error) {
        console.error('获取角色初始化配置失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 获取物品配置
 * GET /api/config/items
 */
router.get('/data/items', async (req, res) => {
    try {
        const config = infrastructure.ConfigLoader?.getConfig('item_data');
        
        if (!config?.items) {
            return res.status(404).json({ 
                code: 404, 
                message: '物品配置未加载' 
            });
        }

        const { type } = req.query;
        let items = config.items;
        
        if (type) {
            items = items.filter(item => item.type === type);
        }

        res.json({
            code: 200,
            data: {
                items: items,
                count: items.length,
                type_filter: type || null
            }
        });
    } catch (error) {
        console.error('获取物品配置失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 获取地图配置
 * GET /api/config/maps
 */
router.get('/data/maps', async (req, res) => {
    try {
        const config = infrastructure.ConfigLoader?.getConfig('map_data');
        
        if (!config?.maps) {
            return res.status(404).json({ 
                code: 404, 
                message: '地图配置未加载' 
            });
        }

        const { minRealm } = req.query;
        let maps = config.maps;
        
        if (minRealm) {
            maps = maps.filter(map => !map.minRealm || map.minRealm === minRealm);
        }

        res.json({
            code: 200,
            data: {
                maps: maps,
                count: maps.length
            }
        });
    } catch (error) {
        console.error('获取地图配置失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 触发配置热更新
 * POST /api/config/hot-update
 */
router.post('/hot-update', async (req, res) => {
    try {
        const { configName } = req.body;
        const validConfigs = [
            'realm_breakthrough',
            'role_init',
            'item_data',
            'map_data',
            'ui_layout',
            'ui_routes'
        ];

        if (!configName) {
            return res.status(400).json({ 
                code: 400, 
                message: '未指定配置名称' 
            });
        }

        if (!validConfigs.includes(configName)) {
            return res.status(400).json({ 
                code: 400, 
                message: '无效的配置名称' 
            });
        }

        if (!infrastructure.ConfigLoader) {
            return res.status(500).json({ 
                code: 500, 
                message: '配置加载器未初始化' 
            });
        }

        await infrastructure.ConfigLoader.hotUpdateConfig(configName);

        res.json({
            code: 200,
            message: `配置 ${configName} 热更新成功`,
            data: {
                config_name: configName,
                updated_at: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('配置热更新失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '热更新失败',
            error: error.message 
        });
    }
});

/**
 * 获取配置加载器状态
 * GET /api/config/status
 */
router.get('/status', async (req, res) => {
    try {
        const isInitialized = infrastructure.ConfigLoader?.isInitialized || false;
        
        res.json({
            code: 200,
            data: {
                initialized: isInitialized,
                config_count: infrastructure.ConfigLoader?.configCache?.size || 0
            }
        });
    } catch (error) {
        console.error('获取配置状态失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

module.exports = router;
