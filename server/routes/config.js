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
 * 可以**匿名**读取全文的配置白名单。
 *
 * 这里刻意不写成"config 目录里有什么就开放什么"：`GET /api/config/:configName` 不要 token，
 * 而 53 个配置文件里有 `ai_config.json`（后台 AI 设置会把 provider 的 apiKey 写进这个文件）、
 * `game_balance.json`（内部调度与战斗系数）等 —— 一旦按目录枚举，玩家界面能看到的接口就会顺手
 * 把密钥和内部数值一起发给任何请求者。新增**玩家可见**的数据集时才往这里加一行。
 * 管理员要读任意配置走 GET /api/config/full/:configName（带鉴权）。
 */
const PUBLIC_CONFIG_NAMES = [
    'realm_breakthrough',
    'role_init',
    'item_data',
    'map_data',
    'ui_layout',
    'ui_routes'
];

/** 后台可管理的配置集合：由 ConfigLoader 扫描目录得出（新增配置文件不需要改这个路由） */
function manageableConfigNames() {
    const loader = infrastructure.ConfigLoader;
    return loader && typeof loader.discoverConfigNames === 'function' ? loader.discoverConfigNames() : [];
}

/**
 * 获取所有配置列表
 * GET /api/config/list
 */
router.get('/list', async (req, res) => {
    try {
        // 名单来自 ConfigLoader 的目录扫描：以前这里写死 6 个名字，新加一份配置（比如这次的
        // stat_definitions / combat_formulas）在后台就"不存在"，只能回来改代码。
        // 这里只报"有没有加载上"，不报体积：那要把 53 份配置各 stringify 一遍，而这个接口不要 token。
        const configNames = manageableConfigNames();
        const configs = {};
        for (const name of configNames) {
            let config = null;
            try {
                config = infrastructure.ConfigLoader?.getConfig(name);
            } catch { /* 未加载就算 false，不该让整份列表 500 */ }
            configs[name] = {
                loaded: !!config,
                public: PUBLIC_CONFIG_NAMES.includes(name)
            };
        }

        res.json({
            code: 200,
            data: {
                configs: configs,
                available_configs: configNames,
                public_configs: PUBLIC_CONFIG_NAMES,
                config_count: configNames.length
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

        if (!PUBLIC_CONFIG_NAMES.includes(configName)) {
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
 * 管理员读取任意配置的全文
 * GET /api/config/full/:configName   （仅管理员）
 *
 * 上面那个匿名接口只能读白名单里的 6 份（见 PUBLIC_CONFIG_NAMES 的说明）。
 * 后台/排查需要看任意一份时走这里，鉴权挡住，`ai_config` 里的 apiKey 不会再落到匿名响应里。
 */
router.get('/full/:configName', auth, adminCheck, async (req, res) => {
    try {
        const { configName } = req.params;
        // 只承认"目录里真实存在的配置文件名"：这个集合由 readdirSync 得出，不可能含 `/`，
        // 所以它同时挡掉了路径穿越与任意文件名。
        if (!manageableConfigNames().includes(configName)) {
            return res.status(404).json({ code: 404, message: '配置文件不存在' });
        }

        const config = infrastructure.ConfigLoader?.getConfig(configName);
        if (!config) {
            return res.status(404).json({ code: 404, message: '配置未加载或不存在' });
        }

        res.json({
            code: 200,
            data: { config_name: configName, config: config }
        });
    } catch (error) {
        console.error('获取配置失败:', error);
        res.status(500).json({ code: 500, message: '服务器错误' });
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
/**
 * 内容主键清单（只读，仅管理员）
 * GET /api/config/content/keys/:dataset?collection=<集合名>
 *
 * 给后台下拉用，返回 `{dataset, entries:[{key, name}]}`；`name` 取自内容自己的显示名字段。
 * 为什么要有：GM 面板以前各自抄了一份主键清单（侍妾 7 个、宗门 6 个、灵兽 4 个），
 * 资料片加一条内容，下拉里就是没有它 —— 而服务端一直按内容认，本来选得出来。
 * 只认 DATASET_SPECS 里登记过的数据集，其余一律 400（不给人拿它去探任意配置）。
 */
router.get('/content/keys/:dataset', auth, adminCheck, async (req, res) => {
    try {
        const { contentRegistry } = require('../game/content');
        const { DATASET_SPECS } = require('../game/content/ContentRegistry');
        const content = contentRegistry();
        if (!content) {
            return res.status(503).json({ code: 503, message: '内容层尚未初始化' });
        }
        const dataset = req.params.dataset;
        if (!DATASET_SPECS[dataset]) {
            return res.status(400).json({ code: 400, message: `数据集未登记，不能按内容出清单: ${dataset}` });
        }
        const collection = typeof req.query.collection === 'string' && req.query.collection ? req.query.collection : null;
        res.json({ code: 200, data: { dataset, entries: content.entryOptions(dataset, collection) } });
    } catch (error) {
        res.status(400).json({ code: 400, message: error.message });
    }
});

/**
 * 资料片（DLC）运行态视图
 * GET /api/config/content/status   （仅管理员）
 *
 * 为什么要有：加/撤一个资料片是"往 server/content/packs 放目录 + 改 pack.json 的 enabled"，
 * 生效与否以前只能翻启动日志。这里把内容层的实际结果摊开：发现了哪些 pack、
 * 每个 pack 的哪个文件写进了哪个数据集的哪个集合、合并后各数据集有多少条、
 * 属性词表和效果词表最终长什么样、合并过程中的告警，以及限流器实际在用的阈值。
 * 只读：不改任何东西——热更走 POST /api/config/hot-update（那份内容有校验+回滚）。
 */
router.get('/content/status', auth, adminCheck, async (req, res) => {
    try {
        const { contentRegistry } = require('../game/content');
        const { statRegistry } = require('../game/stats');
        const content = contentRegistry();
        if (!content) {
            return res.status(503).json({ code: 503, message: '内容层尚未初始化' });
        }

        const status = content.status();
        res.json({
            code: 200,
            data: {
                packs: status.packs,
                datasets: status.datasets,
                warnings: status.warnings,
                wildcard_effects: content.wildcardEffectKeys(),
                effect_vocabulary: content.effectVocabulary(),
                // stats 为空数组时，这一项能区分"游戏没有属性"和"内容层没把词表装进来"
                stat_definitions_loaded: statRegistry.isLoaded,
                stats: statRegistry.all().map(def => ({
                    key: def.key,
                    label: def.label,
                    unit: def.unit,
                    aggregate: def.aggregate,
                    aliases: def.aliases || [],
                    battle_roles: def.battleRoles || [],
                    visible: def.panel?.visible !== false,
                    spot: def.panel?.spot || null
                })),
                server_time: new Date().toISOString(),
                // 限流器**实际在跑**的阈值与重建代数：配置里的数字是否真的生效、
                // 后台改完之后有没有换进运行中的实例（以前只能靠重启后的行为反推）
                rate_limit: require('../middleware/rateLimit').getRuntimeRateLimitState()
            }
        });
    } catch (error) {
        console.error('查询资料片运行态失败:', error);
        res.status(500).json({ code: 500, message: '查询资料片运行态失败', error: error.message });
    }
});

/**
 * 配置热更新接口
 * POST /api/config/hot-update
 *
 * 白名单只有 6 项是刻意的：DATASET_SPECS 登记过的数据集（如 item_data）热更时会走内容层
 * 的重新合并 + 全套校验，校验不过就退回上一份在用的视图；其余数据集没有这层保护。
 *
 * @param {Object} req.body - { configName: string }
 */
router.post('/hot-update', auth, adminCheck, async (req, res) => {
    try {
        const { configName } = req.body;
        // 可热更的名单 = config 目录里真实存在的配置文件（ConfigLoader 扫描得出）。
        // 以前这里也写死 6 个名字，于是这次新加的 stat_definitions / combat_formulas 以及
        // 资料片合并进来的任何数据集都想热更就得回来改代码；而 game_balance 早就被专用后台
        // 界面单独调 hotUpdateConfig('game_balance') 绕过了这份名单 —— 两处名单已经对不上。
        // 名称形状校验在 ConfigLoader.loadConfig 里（挡 `../`），这里再确认文件确实存在。
        const validConfigs = manageableConfigNames();

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
/** 暴露给测试：匿名可读的配置集合（见 PUBLIC_CONFIG_NAMES 定义处的规则） */
module.exports.PUBLIC_CONFIG_NAMES = PUBLIC_CONFIG_NAMES;
