/**
 * 配置相关路由
 * 处理配置获取、热更新等接口
 */
const express = require('express');
const router = express.Router();
const game = require('../game');
const auth = require('../middleware/auth');
const { infrastructure } = require('../modules');

// 管理员权限中间件
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: '权限不足：需要管理员权限' });
    }
};

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
 * 获取玩家可见的游戏平衡配置（公开接口，无需鉴权）
 * GET /api/config/game-balance/public
 *
 * 设计目的：
 *   遵循"配置驱动"原则，前端面板（如历练时长卡片、背包分类、地图类型）需要展示配置数值，
 *   但不能暴露内部配置（如 state_cleaner 调度参数、combat 伤害系数等）。
 *   本接口只返回玩家可见的配置段，避免敏感配置泄露。
 *
 * 返回内容：
 *   - adventure: 历练时长分级配置（duration_types / default_duration_type / early_finish_penalty）
 *   - seclusion: 闭关配置（基础速率、常规/深度闭关参数）
 *   - combat.skill_mp_cost: 技能灵力消耗（供前端展示）
 *   - equipment: 装备槽位配置（valid_slots / slot_names）
 *   - item_types: 物品类型中文名映射（consumable→丹药 等）
 *   - item_categories: 背包分类 tabs 配置
 *   - map_types: 地图类型中文名映射
 *   - safety_levels: 地图危险等级中文名映射
 *   - inventory.max_use_quantity: 使用物品单次最大数量
 */
router.get('/game-balance/public', async (req, res) => {
    try {
        const gameBalance = infrastructure.ConfigLoader?.getConfig('game_balance');
        if (!gameBalance) {
            return res.status(503).json({
                code: 503,
                message: '游戏配置尚未加载完成'
            });
        }

        // 只返回玩家可见的配置段，过滤内部配置
        const publicConfig = {
            adventure: gameBalance.adventure || null,
            seclusion: {
                // 闭关基础修为速率（每秒）
                base_exp_rate: gameBalance.seclusion?.base_exp_rate ?? 1,
                // 常规闭关与深度闭关配置由 seclusion.json 提供，此处附加
            },
            combat: {
                skill_mp_cost: gameBalance.combat?.skill_mp_cost ?? 20
            },
            // 装备槽位配置 + 法宝深度系统配置（耐久/祭炼/修理/本命/祭出）
            // 注意：过滤内部 comment 字段，仅返回玩家可见的纯数据
            equipment: {
                valid_slots: gameBalance.equipment?.valid_slots || [],
                slot_names: gameBalance.equipment?.slot_names || {},
                durability: gameBalance.equipment?.durability || null,
                refine: gameBalance.equipment?.refine || null,
                repair: gameBalance.equipment?.repair || null,
                benming: gameBalance.equipment?.benming || null,
                summon: gameBalance.equipment?.summon || null
            },
            // 物品类型中文名映射（供 InventoryPanel/MarketPanel 共用，避免前端硬编码不一致）
            item_types: gameBalance.item_types || {},
            // 背包分类 tabs（含 other 兜底分类）
            item_categories: gameBalance.item_categories || [],
            // 地图类型中文名映射（不含 Tailwind 样式，样式由前端展示层维护）
            map_types: gameBalance.map_types || {},
            // 地图危险等级中文名映射
            safety_levels: gameBalance.safety_levels || {},
            // 背包相关配置
            inventory: {
                max_use_quantity: gameBalance.inventory?.max_use_quantity ?? 99
            }
        };

        // 附加 seclusion.json 中的闭关配置（normal_seclusion / deep_seclusion）
        try {
            const seclusionConfig = infrastructure.ConfigLoader?.getConfig('seclusion');
            if (seclusionConfig?.settings) {
                publicConfig.seclusion.normal = seclusionConfig.settings.normal_seclusion?.value || null;
                publicConfig.seclusion.deep = seclusionConfig.settings.deep_seclusion?.value || null;
                publicConfig.seclusion.base_exp_rate = seclusionConfig.settings.seclusion_exp_rate?.value ?? publicConfig.seclusion.base_exp_rate;
            }
        } catch (e) {
            console.warn('[Config Route] 读取 seclusion 配置失败:', e.message);
        }

        res.json({
            code: 200,
            data: publicConfig
        });
    } catch (error) {
        console.error('获取公开游戏配置失败:', error);
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
 * 触发配置热更新（需要管理员权限）
 * POST /api/config/hot-update
 */
router.post('/hot-update', auth, adminCheck, async (req, res) => {
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
        const isInitialized = game.ConfigLoader?.isInitialized || false;
        
        res.json({
            code: 200,
            data: {
                initialized: isInitialized,
                config_count: game.ConfigLoader?.configCache?.size || 0
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
