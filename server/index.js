/**
 * 服务端入口文件
 * 负责启动 Express 服务器，初始化数据库连接和配置加载模块
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const sequelize = require('./config/database');
require('dotenv').config();

// 解决 BigInt 序列化问题
BigInt.prototype.toJSON = function() {
  return this.toString();
};

// 检查 JWT_SECRET 环境变量（安全要求）
if (!process.env.JWT_SECRET) {
  console.error('[安全错误] 未配置 JWT_SECRET 环境变量');
  console.error('请在 .env 文件中设置 JWT_SECRET，或设置环境变量后启动服务');
  process.exit(1);
}

// 引入模型以确保同步
require('./models/player');
require('./models/chat');
require('./models/system_config');
require('./models/system_notification');
require('./models/playerMapPosition');
require('./models/playerGathering');
require('./models/playerCombat');
require('./models/playerMovement');
require('./models/playerAdventure');
require('./models/activeBattle');
require('./models/item');
require('./models/playerEquipment');
require('./models/realm');
require('./models/admin_log');
require('./models/map');
// 玩家状态转移日志模型（优化3：状态变更追溯）
require('./models/playerStateLog');
// 洞府与药园模型（第一阶段新增玩法）
require('./models/playerCave');
require('./models/playerGarden');
// 炼制系统模型（玩家已学配方及技能信息）
require('./models/playerRecipe');
// PVP 扩展系统模型（悬赏追杀、封神台排名）
require('./models/playerBounty');
require('./models/fengshenRanking');
// 洞府社交系统模型（留言、访客记录）
require('./models/caveMessage');
require('./models/caveVisitor');
// 宗门专属玩法模型（灵眼之树/观星台/命盘/天阶/魔道/炉鼎）
require('./models/playerSectSpecial');
// 阵法系统模型（玩家已学阵法及熟练度）
require('./models/playerFormation');

// 世界BOSS系统模型（批次2多人玩法：3个BOSS实例、伤害记录、赛季配置、赛季排行）
require('./models/worldBoss');
require('./models/worldBossDamageRecord');
require('./models/worldBossSeason');
require('./models/worldBossSeasonRanking');

// 宗门战/领地争夺系统模型（批次2多人玩法：战役、资源点、参战记录、赛季配置、赛季排行、宗门资金）
require('./models/sectWar');
require('./models/sectWarTerritory');
require('./models/sectWarParticipant');
require('./models/sectWarSeason');
require('./models/sectWarSeasonRanking');
require('./models/sectFund');

// 飞升+夺舍重生系统模型（批次3：玩家飞升进度、空间节点、夺舍目标配置、夺舍记录）
require('./models/playerAscension');
require('./models/playerAscensionNode');
require('./models/reincarnationTarget');
require('./models/playerReincarnation');

// 后期系统模型（批次3：第二元神/元神残篇/小世界/神庙/香火流水/神识/法则/法则碎片流水）
require('./models/playerSecondSoul');
require('./models/playerSoulFragment');
require('./models/playerSmallWorld');
require('./models/playerDivineTemple');
require('./models/playerIncenseLog');
require('./models/playerDivineSense');
require('./models/playerLaw');
require('./models/playerLawFragment');
// 神识对决系统模型（玩法文档第18节：1v1 神识小游戏，同时选择博弈）
require('./models/playerDivineDuel');

// 灵兽PVP竞技场系统模型（玩法文档第8节：灵兽PVP对战，押注/段位/赛季排行）
require('./models/spiritBeastPvpMatch');
require('./models/spiritBeastPvpSeason');
require('./models/spiritBeastPvpRanking');

// 灵兽探渊系统模型（玩法文档第24节：灵兽探渊，9层深渊PVE+PVP混合探索）
require('./models/spiritBeastAbyss');
require('./models/abyssEncounterLog');

// 太一门引道系统模型（玩法文档第25节：太一门引道，五行道途+神识联动+多人共鸣）
require('./models/playerTaoismGate');

// 道侣/双修/侍妾系统模型（批次3：道侣关系/侍妾/远航记录/互动日志/心劫事件）
require('./models/daoCompanion');
require('./models/concubine');
require('./models/concubineVoyage');
require('./models/concubineLog');
require('./models/heartTribulationEvent');

// 道侣/双修系统（玩家间 1v1 长期社交玩法重做版：含亲密度/心契/心印/心劫冷却）
require('./models/daoCompanions');

// 多人副本系统模型（批次3：实例/成员/抉择记录/冷却）
require('./models/multiDungeonInstance');
require('./models/multiDungeonMember');
require('./models/multiDungeonChoice');
require('./models/multiDungeonCooldown');

const http = require('http');
const socketIo = require('socket.io');
const { infrastructure } = require('./modules');
const game = require('./game');
const WebSocketNotificationService = require('./game/services/WebSocketNotificationService');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

// 在线用户跟踪（使用Socket.IO连接状态）
const onlineUsers = new Map();

// 修复：显式声明 configLoader，避免隐式全局变量污染
let configLoader = null;

// 从配置文件读取时间间隔常量（通过 ConfigLoader 支持热更新）
// 使用懒加载函数，避免模块加载时配置未初始化的问题
function getTimeIntervals() {
    return configLoader?.getConfig('game_balance')?.time_intervals || {};
}

// 提供配置访问函数，而非立即获取配置值
const UPDATE_INTERVAL_MS = () => getTimeIntervals().lifespan_update_interval_ms || 600000;
const UPDATE_INTERVAL_SEC = () => getTimeIntervals().lifespan_update_interval_sec || 600;
// 移动完成检查已迁移到 StateCleanerService（per-state interval 5s），无需独立定时任务
// 保留 move_check_interval_ms 配置项用于兼容，但本文件不再使用

// CORS 配置 - 生产环境应配置白名单域名
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*', // 生产环境建议配置具体域名，如 'https://yourdomain.com'
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// 中间件
app.use(cors(corsOptions));
app.use(express.json());

// 将 io 实例挂载到 app 上，供路由使用
app.set('io', io);

// 初始化配置加载器
async function initializeConfigLoader() {
    try {
        const { initializeModules } = require('./modules');
        const result = await initializeModules();
        // 修复：configLoader 已在文件顶部声明（let configLoader = null），此处赋值即可
        configLoader = result.configLoader || require('./modules').infrastructure.ConfigLoader;
        console.log('配置加载器初始化成功，已加载配置:', configLoader.getLoadedConfigNames());
        return true;
    } catch (error) {
        console.error('配置加载器初始化失败:', error.message);
        return false;
    }
}

// 初始化游戏核心服务
async function initializeCoreServices(configLoaderInstance) {
    try {
        const { initializeGameServices } = require('./game');
        // initializeGameServices 是异步函数，需要等待
        await initializeGameServices(configLoaderInstance);
        console.log('游戏核心服务模块初始化成功');
        // 神识对决服务初始化（独立于 game/index.js，因其依赖 late_stage_data.divine_duel 配置）
        try {
            const DivineDuelService = require('./game/services/DivineDuelService');
            DivineDuelService.initialize(configLoaderInstance);
        } catch (e) {
            console.warn('神识对决服务初始化失败:', e.message);
        }
        // 坐化遗府服务初始化（独立于 game/index.js，因其依赖 cave_legacy_data.cave_legacy 配置）
        try {
            const CaveLegacyService = require('./game/services/CaveLegacyService');
            CaveLegacyService.initialize(configLoaderInstance);
        } catch (e) {
            console.warn('坐化遗府服务初始化失败:', e.message);
        }
        // 灵兽PVP竞技场服务初始化（独立于 game/index.js，因其依赖 spirit_beast_pvp_data.spirit_beast_pvp 配置）
        try {
            const SpiritBeastPvpService = require('./game/services/SpiritBeastPvpService');
            SpiritBeastPvpService.initialize(configLoaderInstance);
        } catch (e) {
            console.warn('灵兽PVP竞技场服务初始化失败:', e.message);
        }
        // 灵兽放养与偷菜服务初始化（独立于 game/index.js，因其依赖 spirit_beast_pasture_data 配置）
        try {
            const BeastPastureService = require('./game/services/BeastPastureService');
            BeastPastureService.initialize(configLoaderInstance);
        } catch (e) {
            console.warn('灵兽放养与偷菜服务初始化失败:', e.message);
        }
        // 灵兽探渊服务初始化（独立于 game/index.js，因其依赖 spirit_beast_abyss_data 配置）
        try {
            const BeastAbyssService = require('./game/services/BeastAbyssService');
            BeastAbyssService.initialize(configLoaderInstance);
        } catch (e) {
            console.warn('灵兽探渊服务初始化失败:', e.message);
        }
        // 太一门引道服务初始化（独立于 game/index.js，因其依赖 taoism_gate_data 配置）
        try {
            const TaoismGateService = require('./game/services/TaoismGateService');
            TaoismGateService.initialize(configLoaderInstance);
        } catch (e) {
            console.warn('太一门引道服务初始化失败:', e.message);
        }
        return true;
    } catch (error) {
        console.error('游戏核心服务初始化失败:', error.message);
        return false;
    }
}

// 监听配置热更新事件
if (infrastructure.EventBus) {
    infrastructure.EventBus.subscribe('configHotUpdated', (event) => {
        console.log(`配置热更新: ${event.configName}`);
    });
}

// 启动服务器
const startServer = async () => {
    // 初始化配置加载器
    const configInitResult = await initializeConfigLoader();
    
    // 初始化核心服务
    if (configInitResult) {
        await initializeCoreServices(configLoader);
    }

    // 初始化历练探索服务（AI大模型事件生成）
    try {
        const { initializeAdventureService } = require('./routes/map');
        await initializeAdventureService(configLoader);
        console.log('历练探索服务初始化完成');
    } catch (error) {
        console.warn('历练探索服务初始化失败:', error.message);
    }

    // 尝试连接数据库，但不阻塞服务器启动
    try {
        await sequelize.authenticate();
        console.log('数据库连接成功。');
        
        if (process.env.DB_NAME) {
            try {
                await sequelize.query(`USE \`${process.env.DB_NAME}\``);
                console.log(`已选择数据库: ${process.env.DB_NAME}`);
            } catch (err) {
                console.warn('手动选择数据库失败 (可能是权限问题或无需选择):', err.message);
            }
        }

        // 执行数据库迁移（必须在 sequelize.sync() 之前）
        console.log('检查数据库迁移...');
        const { migrate } = require('./scripts/migration_manager');
        const migrationResult = await migrate();
        
        if (migrationResult.success && migrationResult.migrated > 0) {
            console.log(`✅ 数据库迁移完成: ${migrationResult.migrated} 个新迁移已执行`);
        }
        
        // 迁移失败时阻止服务器启动
        if (!migrationResult.success) {
            console.error('');
            console.error('═══════════════════════════════════════════');
            console.error('❌ 数据库迁移失败！服务器无法启动');
            console.error('═══════════════════════════════════════════');
            console.error(`错误: ${migrationResult.error || migrationResult.error}`);
            console.error('');
            console.error('请修复问题后重启服务器');
            console.error('═══════════════════════════════════════════');
            console.error('');
            process.exit(1);
        }
        
        // 同步数据库模型
        // 修复（2026-07-21）：原 sync({ alter: true }) 会在每次启动时为 unique 字段
        // 创建带数字后缀的重复索引（player_id_2, player_id_3, ...），导致 player_caves
        // 表索引数累积到 64 个触发 MySQL 5.6 限制，阻止后续字段同步
        // 改为 sync()：仅创建不存在的表，不修改已有表结构，新字段通过 migrations 迁移
        // 已通过 scripts/cleanup_duplicate_indexes.js 清理 99 个冗余索引
        await sequelize.sync();
    } catch (error) {
        console.error('无法连接到数据库 (但不影响服务器启动):', error.message);
    }

    // 启动定时任务
    setInterval(async () => {
        try {
            await game.LifespanService.updateLifespan(UPDATE_INTERVAL_SEC());
        } catch (error) {
            console.error('寿命更新失败:', error.message);
        }
    }, UPDATE_INTERVAL_MS());
    console.log('寿命更新定时任务已启动');

    // 统一状态清理调度器：定期清理过期闭关/战斗/历练/移动/封禁
    // 解决玩家非正常退出（关浏览器/断网/服务重启）导致状态卡死的问题
    // 架构：通过 StateRegistry 注册中心调度，新增玩法只需在 game/state/registrations/ 下新增注册文件
    // 说明：原 index.js 中的移动完成检查定时任务已迁移到 moving.js 的 cleanExpired，
    //       由 StateCleanerService 通过 per-state interval（5s）统一调度，保持架构一致
    try {
        // 1. 注册所有玩法状态处理器（闭关/战斗/历练/移动/封禁）
        const { registerAllStates } = require('./game/state');
        registerAllStates();
        // 2. 启动清理调度器（主调度间隔取所有状态中最小的 interval_ms，如移动 5s）
        const StateCleanerService = require('./game/services/StateCleanerService');
        StateCleanerService.start();
    } catch (err) {
        console.error('状态清理调度器启动失败:', err.message);
    }

    // 股市定时任务调度器：价格更新、强平检查、利息计算、分红派息
    // 由 StockSchedulerService 内部根据 game_balance.stock_market 配置调度周期
    try {
        const StockSchedulerService = require('./game/services/StockSchedulerService');
        // start() 是 async 方法但不阻塞主流程
        StockSchedulerService.start().catch(err => {
            console.error('股市调度器启动失败:', err.message);
        });
    } catch (err) {
        console.error('股市调度器加载失败:', err.message);
    }

    // 世界BOSS调度器（批次2）：BOSS自动刷新/过期/阶段切换/赛季结算
    // 由 WorldBossSchedulerService 内部根据 game_balance.world_boss.scheduler_interval_ms 配置调度周期
    try {
        const WorldBossSchedulerService = require('./game/services/WorldBossSchedulerService');
        WorldBossSchedulerService.start().catch(err => {
            console.error('世界BOSS调度器启动失败:', err.message);
        });
    } catch (err) {
        console.error('世界BOSS调度器加载失败:', err.message);
    }

    // 妖兽入侵调度器（多人公共事件）：阶段超时检查/兜底阶段切换
    // 由 BeastInvasionSchedulerService 内部根据 game_balance.beast_invasion.state_cleaner_interval_ms 配置调度周期
    try {
        const BeastInvasionSchedulerService = require('./game/services/BeastInvasionSchedulerService');
        BeastInvasionSchedulerService.start().catch(err => {
            console.error('妖兽入侵调度器启动失败:', err.message);
        });
    } catch (err) {
        console.error('妖兽入侵调度器加载失败:', err.message);
    }

    // 宗门战调度器（批次2）：战役状态推进/占领超时补偿/资源点产出结算/赛季结算
    // 由 SectWarSchedulerService 内部根据 game_balance.sect_war.scheduler_interval_ms 配置调度周期
    try {
        const SectWarSchedulerService = require('./game/services/SectWarSchedulerService');
        SectWarSchedulerService.start().catch(err => {
            console.error('宗门战调度器启动失败:', err.message);
        });
    } catch (err) {
        console.error('宗门战调度器加载失败:', err.message);
    }

    // 神识对决超时检查调度器（玩法文档第18节）
    // 每 10 秒检查一次：pending 超时自动取消 + active 操作超时自动固元
    try {
        const DivineDuelService = require('./game/services/DivineDuelService');
        setInterval(async () => {
            try {
                await DivineDuelService.checkTimeouts();
            } catch (e) {
                console.error('[DivineDuel] 超时检查失败:', e.message);
            }
        }, 10000);
        console.log('神识对决超时检查调度器已启动 (10s)');
    } catch (err) {
        console.error('神识对决调度器加载失败:', err.message);
    }

    // 坐化遗府过期检查调度器（玩法文档第16节）
    // 每 60 秒检查一次：自动关闭已过期但未关闭的遗府，结算未分配物品
    try {
        const CaveLegacyService = require('./game/services/CaveLegacyService');
        const caveLegacyConfig = configLoader.getConfig('cave_legacy_data')?.cave_legacy?.scheduler;
        const checkInterval = Number(caveLegacyConfig?.check_interval_ms) || 60000;
        setInterval(async () => {
            try {
                await CaveLegacyService.checkExpiredLegacies();
            } catch (e) {
                console.error('[CaveLegacy] 过期检查失败:', e.message);
            }
        }, checkInterval);
        console.log(`坐化遗府过期检查调度器已启动 (${checkInterval}ms)`);
    } catch (err) {
        console.error('坐化遗府调度器加载失败:', err.message);
    }

    // 灵兽PVP竞技场赛季到期检查调度器（每 60 秒）
    try {
        const SpiritBeastPvpService = require('./game/services/SpiritBeastPvpService');
        const pvpConfig = configLoader.getConfig('spirit_beast_pvp_data')?.spirit_beast_pvp?.scheduler;
        const pvpCheckInterval = Number(pvpConfig?.check_interval_ms) || 60000;
        setInterval(async () => {
            try {
                await SpiritBeastPvpService.checkSeasonExpiry();
            } catch (e) {
                console.error('[SpiritBeastPvp] 赛季检查失败:', e.message);
            }
        }, pvpCheckInterval);
        console.log(`灵兽PVP赛季检查调度器已启动 (${pvpCheckInterval}ms)`);
    } catch (err) {
        console.error('灵兽PVP调度器加载失败:', err.message);
    }

    // 灵兽放养过期自动结算调度器（每 60 秒）
    // 检查超过宽限期仍未手动召回的放养记录，按 80% 折扣自动结算
    try {
        const BeastPastureService = require('./game/services/BeastPastureService');
        const pastureConfig = configLoader.getConfig('spirit_beast_pasture_data')?.scheduler;
        const pastureCheckInterval = Number(pastureConfig?.check_interval_ms) || 60000;
        setInterval(async () => {
            try {
                await BeastPastureService.checkExpirations();
            } catch (e) {
                console.error('[BeastPasture] 过期检查失败:', e.message);
            }
        }, pastureCheckInterval);
        console.log(`灵兽放养过期检查调度器已启动 (${pastureCheckInterval}ms)`);
    } catch (err) {
        console.error('灵兽放养调度器加载失败:', err.message);
    }

    // 灵兽探渊过期检查调度器（玩法文档第24节）
    // 每 60 秒检查一次：自动结算已过期的探渊记录，模拟所有遭遇事件并发放奖励
    try {
        const BeastAbyssService = require('./game/services/BeastAbyssService');
        const abyssConfig = configLoader.getConfig('spirit_beast_abyss_data')?.abyss?.scheduler;
        const abyssCheckInterval = Number(abyssConfig?.check_interval_ms) || 60000;
        setInterval(async () => {
            try {
                await BeastAbyssService.checkExpirations();
            } catch (e) {
                console.error('[BeastAbyss] 过期检查失败:', e.message);
            }
        }, abyssCheckInterval);
        console.log(`灵兽探渊过期检查调度器已启动 (${abyssCheckInterval}ms)`);
    } catch (err) {
        console.error('灵兽探渊调度器加载失败:', err.message);
    }

    // 路由
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/player', require('./routes/player'));
    app.use('/api/chat', require('./routes/chat'));
    app.use('/api/admin', require('./routes/admin'));
    app.use('/api/admin/ai-config', require('./routes/admin_ai'));
    app.use('/api/admin/sect', require('./routes/admin_sect'));
    // 洞府管理（GM 后台）：玩家洞府列表查询、设施等级调整、洞府重置、药园地块数调整
    app.use('/api/admin/cave', require('./routes/admin_cave'));
    // 装备管理（GM 后台）：装备列表查询、记录修改、重置、强制卸下、GM 一键修理
    app.use('/api/admin/equipment', require('./routes/admin_equipment'));
    app.use('/api/admin/meditation', require('./routes/admin_meditation'));
    // 修炼配置管理（闭关 + 历练，支持热加载）
    app.use('/api/admin/cultivation', require('./routes/admin_cultivation'));
    app.use('/api/system', require('./routes/system'));
    app.use('/api/seclusion', require('./routes/seclusion'));
    app.use('/api/breakthrough', require('./routes/breakthrough'));
    app.use('/api/meditation', require('./routes/meditation'));
    app.use('/api/map', require('./routes/map').router);
    app.use('/api/gather', require('./routes/gather'));
    app.use('/api/combat', require('./routes/combat'));
    app.use('/api/config', require('./routes/config'));
    app.use('/api/attribute', require('./routes/attribute'));
    app.use('/api/time', require('./routes/time'));
    app.use('/api/notifications', require('./routes/notifications'));
    app.use('/api/inventory', require('./routes/inventory'));
    app.use('/api/sect', require('./routes/sect'));
    app.use('/api/market', require('./routes/market'));
    // PVP 斗法系统（第四阶段新增：玩家对战、段位排名、荣誉值）
    app.use('/api/pvp', require('./routes/pvp'));
    // PVP 管理（GM 后台）：段位调整、强制取消战斗、战斗记录查询
    app.use('/api/admin/pvp', require('./routes/admin_pvp'));
    // 当铺系统（第四阶段新增：典当、赎回、信用额度）
    app.use('/api/pawnshop', require('./routes/pawnshop'));
    // 当铺管理（GM 后台）：强制赎回、取消当票、调整信用
    app.use('/api/admin/pawnshop', require('./routes/admin_pawnshop'));
    // 股市系统（第四阶段新增：行情查询、买卖交易、融资融券、分红派息）
    app.use('/api/stock', require('./routes/stock'));
    // 股市管理（GM 后台）：调整股价、暂停交易、触发事件、强制平仓、手动分红
    app.use('/api/admin/stock', require('./routes/admin_stock'));
    app.use('/api/equipment', require('./routes/equipment'));
    // 洞府系统（开辟洞府、升级灵脉/静室/丹房/器室/大阵、领取灵石）
    app.use('/api/cave', require('./routes/cave'));
    // 药园系统（播种、采收、一键采收）
    app.use('/api/garden', require('./routes/garden'));
    // 炼制系统（炼丹/炼器、学习配方、技能成长）
    app.use('/api/crafting', require('./routes/crafting'));
    // PVP 扩展系统（决斗/悬赏/封神台，避世入世/切磋木人/战力查询已整合到 pvp 路由）
    app.use('/api/duel', require('./routes/duel'));
    app.use('/api/bounty', require('./routes/bounty'));
    app.use('/api/fengshen', require('./routes/fengshen'));
    // 洞府社交系统（拜访/留言/访客/景观/商人）
    app.use('/api/cave-social', require('./routes/cave_social'));
    // 宗门专属玩法系统（灵眼之树/观星台/命盘/天阶/魔道/炉鼎）
    app.use('/api/sect-special', require('./routes/sect_special'));
    // 元婴出窍与高阶境界系统（出窍/归来/问道/法相天地/探寻裂缝/夺舍重生）
    app.use('/api/nascent-soul', require('./routes/nascent_soul'));
    // 副本系统（5章节×5-7关，含剧情/战斗/解谜/BOSS/奖励5种关卡类型，三档难度，AI剧情增强）
    app.use('/api/dungeon', require('./routes/dungeon'));
    // 阵法系统（10大阵法，4类×4品阶，熟练度，相克关系，战力加成）
    app.use('/api/formation', require('./routes/formation'));
    // 阵法系统 GM 后台（统计/发放/剥夺/强制激活/配置热更新）
    app.use('/api/admin/formation', require('./routes/admin_formation'));
    // 世界BOSS系统（批次2多人玩法：3个BOSS、阶段切换、伤害排行、赛季结算）
    app.use('/api/world-boss', require('./routes/world_boss'));
    // 世界BOSS管理（GM 后台：手动刷新/过期/创建赛季/强制结算）
    app.use('/api/admin/world-boss', require('./routes/admin_world_boss'));
    // 妖兽入侵系统（多人公共事件：两阶段流程 捐献→战斗，伤害排行，击杀结算）
    app.use('/api/beast-invasion', require('./routes/beast_invasion'));
    // 妖兽入侵管理（GM 后台：手动开启/强制结束/统计/配置查询）
    app.use('/api/admin/beast-invasion', require('./routes/admin_beast_invasion'));
    // 宗门战系统（批次2多人玩法：领地争夺、宣战、攻防、占领、赛季结算）
    app.use('/api/sect-war', require('./routes/sect_war'));
    // 宗门战管理（GM 后台：统计/赛季管理/资源点初始化/手动推进状态）
    app.use('/api/admin/sect-war', require('./routes/admin_sect_war'));

    // 批次3 飞升+夺舍重生系统（玩家：问道/法相天地/探寻裂缝/搜寻节点/定星/飞升/回溯 + 夺舍触发/选定/记录）
    // 注意：routes/ascension.js 内部已带 /ascension/ 与 /reincarnation/ 前缀，故挂载到 /api 即可
    app.use('/api', require('./routes/ascension'));
    // 批次3 飞升+夺舍重生系统 GM 后台（统计/玩家进度/调整大衍诀/发放法则碎片/发放坐标/重置冷却/夺舍目标CRUD）
    app.use('/api/admin/ascension', require('./routes/admin_ascension'));

    // 批次3 后期系统玩家路由（6 大子系统：第二元神/小世界/神庙/香火/神识淬炼/法则转换）
    // 第二元神系统（凝练/分化/调度/独立修炼）
    app.use('/api/second-soul', require('./routes/second-soul'));
    // 小世界系统（开辟/显灵/神迹干预）
    app.use('/api/small-world', require('./routes/small-world'));
    // 神庙系统（升级/修复禁制/兑换供奉）
    app.use('/api/divine-temple', require('./routes/divine-temple'));
    // 香火系统（收割/流水分页查询）
    app.use('/api/incense', require('./routes/incense'));
    // 神识淬炼系统（查询面板/淬炼）
    app.use('/api/divine-sense', require('./routes/divine-sense'));
    // 法则转换系统（查询面板/神识→法则点/碎片→法则点/法则转换）
    app.use('/api/law', require('./routes/law'));
    // 批次3 后期系统 GM 后台（调整副元神属性/重置小世界/调整小世界&神庙等级/发放香火/神识/法则点/法则碎片）
    app.use('/api/admin/late-stage', require('./routes/admin_late_stage'));

    // 批次3 道侣/双修/侍妾系统玩家路由（道侣关系/双修/温养/采补/立誓/心契/心劫 + 侍妾培养/远航/觉醒）
    // 道侣系统（寻侣/双修/温养/采补/立誓/心契面板/心劫抉择）
    app.use('/api/companion', require('./routes/companion'));
    // 侍妾系统（红尘寻缘/问安/反哺/赠予/安置/遣散/远航/护法/觉醒）
    app.use('/api/concubine', require('./routes/concubine'));
    // 批次3 道侣/侍妾系统 GM 后台（强制解除道侣/调整心契/发放侍妾/调整属性/立即完成远航/触发心劫）
    app.use('/api/admin/companion-concubine', require('./routes/admin_companion_concubine'));

    // 批次3 多人副本系统玩家路由（创建/加入/进入/状态查询/抉择/投粽/解散/踢人/奖励/历史/冷却）
    app.use('/api/multi-dungeon', require('./routes/multi_dungeon'));
    // 批次3 多人副本系统 GM 后台（强制解散/调整变量/发放奖励/重置冷却）
    app.use('/api/admin/multi-dungeon', require('./routes/admin_multi_dungeon'));

    // 灵兽系统玩家路由（图鉴/列表/详情/捕获/喂养/互动/出战/放生/每日状态）
    // 4阶灵兽（青云狼/火焰狮/冰魄狐/腾蛇）+ 五行相克 + 培养体系
    app.use('/api/spirit-beast', require('./routes/spirit_beast'));
    // 灵兽系统 GM 后台（统计/分页查询/详情/玩家灵兽/发放/修改/删除/强制出战/重置冷却）
    app.use('/api/admin/spirit-beast', require('./routes/admin_spirit_beast'));

    // 道侣/双修系统玩家路由（玩家间 1v1 长期社交：求婚/响应/互动/双修/解除/心劫/心印）
    // 与 /api/companion 区别：新系统含亲密度 0-100、心契 0-9、心印、心劫冷却
    app.use('/api/dao-companion', require('./routes/dao_companion'));

    // 批次5 慕兰战线系统玩家路由（玩法文档第16节：军议/支援/谍影/军功司/灵兽边境/残图匣/临战刻印 7 大子系统）
    app.use('/api/border-military', require('./routes/border_military'));

    // 批次5 坐化遗府系统玩家+管理员路由（玩法文档第16节：异步多人 PvP/协作玩法）
    // 玩家端：查看当前遗府/转动分宝/查询历史；管理员端：预览/开启/关闭/状态查询
    app.use('/api/cave-legacy', require('./routes/cave_legacy'));

    // 批次5 灵兽PVP竞技场系统玩家路由（玩法文档第8节：灵兽PVP对战，押注/段位/赛季排行）
    // 玩家端：档案/排行榜/历史/赛季信息/发起挑战/战术列表/段位信息/对局详情
    app.use('/api/spirit-beast/pvp', require('./routes/spirit_beast_pvp'));

    // 批次5 灵兽放养+偷菜系统玩家路由（玩法文档第8节：异步多人经济PVP玩法）
    // 玩家端：放养场所/开始放养/召回/状态/历史/偷菜/偷菜历史/被偷历史
    // 多人交互：放养灵兽偷其他玩家药园作物 + 护院灵兽拦截 + 反伤 + 忠诚度变化
    app.use('/api/spirit-beast/pasture', require('./routes/spirit_beast_pasture'));

    // 批次5 灵兽探渊系统玩家路由（玩法文档第24节：异步多人PVE+PVP混合探索玩法）
    // 玩家端：层数列表/开始探渊/召回/状态/历史/遭遇历史/排行榜/配置
    // 多人交互：同层探索有概率遭遇其他玩家灵兽发生PVP + 排行榜竞争
    app.use('/api/spirit-beast/abyss', require('./routes/spirit_beast_abyss'));

    // 批次5 太一门引道系统玩家路由（玩法文档第25节：五行道途+神识联动+多人共鸣）
    // 玩家端：道途面板/选择道途/切换道途/引道修炼/使用技能/日常任务/排行榜/共鸣查询
    // 多人交互：同道途玩家组队获得共鸣加成 + 五行相克影响技能成功率 + 火眼金睛探查他人储物袋
    app.use('/api/taoism-gate', require('./routes/taoism_gate'));

    // 健康检查接口（供部署脚本验证服务是否启动成功）
    // 设计目的：deploy.ps1 部署完成后 curl 此接口，确认服务真的起来了
    // 轻量级：不查数据库，只返回进程存活信号 + 基础运行信息
    app.get('/api/health', (req, res) => {
        res.json({
            code: 200,
            status: 'ok',
            uptime: process.uptime(),  // 进程运行秒数
            timestamp: Date.now(),
            version: process.env.npm_package_version || 'unknown'
        });
    });

    // 全局404路由处理（API路由之后）
    app.use('/api/*', (req, res) => {
        res.status(404).json({
            code: 404,
            message: 'API接口不存在',
            path: req.originalUrl
        });
    });

    // 全局错误处理中间件（必须在所有路由和404处理之后）
    const { errorHandler } = require('./middleware/errorHandler');
    app.use(errorHandler);

    // Socket.IO 在线用户跟踪（与 WebSocketNotificationService 共享 JWT 鉴权）
    // 修复安全漏洞：禁止信任客户端传入的 playerId，必须通过 JWT 校验
    const jwt = require('jsonwebtoken');
    const Player = require('./models/player');

    async function authenticateSocket(socket) {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (!token) {
            socket.emit('auth_error', { message: '未提供认证令牌' });
            socket.disconnect(true);
            return null;
        }
        try {
            const decoded = jwt.verify(token.replace('Bearer ', ''), process.env.JWT_SECRET);
            const player = await Player.findByPk(decoded.id);
            if (!player || player.token_version !== decoded.v) {
                socket.emit('auth_error', { message: '认证失败，请重新登录' });
                socket.disconnect(true);
                return null;
            }
            return player.id;
        } catch (err) {
            socket.emit('auth_error', { message: '令牌无效或已过期' });
            socket.disconnect(true);
            return null;
        }
    }

    io.on('connection', async (socket) => {
        const playerId = await authenticateSocket(socket);
        if (!playerId) return;

        if (!onlineUsers.has(playerId.toString())) {
            onlineUsers.set(playerId.toString(), {
                socketId: socket.id,
                connectedAt: new Date(),
                lastSavedAt: new Date()
            });
        } else {
            // 更新 socketId，保留连接时间
            const info = onlineUsers.get(playerId.toString());
            info.socketId = socket.id;
            onlineUsers.set(playerId.toString(), info);
        }
        console.log(`玩家 ${playerId} 已连接，SocketID: ${socket.id}`);

        socket.on('disconnect', async () => {
            const userInfo = onlineUsers.get(playerId.toString());
            if (userInfo && userInfo.socketId === socket.id) {
                // 计算并保存时长
                const now = new Date();
                const lastSaved = userInfo.lastSavedAt || userInfo.connectedAt;
                const duration = now - lastSaved;

                if (duration > 0) {
                    try {
                        const player = await Player.findByPk(playerId);
                        if (player) {
                            player.total_online_time = BigInt(player.total_online_time || 0) + BigInt(duration);
                            await player.save();
                            console.log(`玩家 ${playerId} 下线，增加在线时长 ${duration}ms`);
                        }
                    } catch (err) {
                        console.error(`保存玩家 ${playerId} 在线时长失败:`, err);
                    }
                }

                onlineUsers.delete(playerId.toString());
                console.log(`玩家 ${playerId} 已断开连接`);
            }
        });
    });
    
    // 定时保存在线时长 (每分钟) - 优化为批量查询
    setInterval(async () => {
        if (onlineUsers.size === 0) return;
        
        const Player = require('./models/player');
        const now = new Date();
        const playerIds = Array.from(onlineUsers.keys());
        
        try {
            // 批量查询所有在线玩家
            const players = await Player.findAll({
                where: { id: playerIds }
            });
            
            // 创建玩家映射
            const playerMap = new Map(players.map(p => [p.id, p]));
            
            // 批量更新在线时长
            for (const [playerId, info] of onlineUsers.entries()) {
                const lastSaved = info.lastSavedAt || info.connectedAt;
                const duration = now - lastSaved;
                
                if (duration > 5000) { // 至少5秒才保存
                    const player = playerMap.get(playerId);
                    if (player) {
                        player.total_online_time = BigInt(player.total_online_time || 0) + BigInt(duration);
                        await player.save();
                        
                        // 更新保存时间
                        info.lastSavedAt = now;
                        onlineUsers.set(playerId, info);
                    }
                }
            }
        } catch (err) {
            console.error('批量保存玩家在线时长失败:', err);
        }
    }, 60 * 1000);

    // 初始化WebSocket通知服务
    WebSocketNotificationService.initialize(io);
    console.log('WebSocket通知服务已初始化');

    // 将onlineUsers挂载到app
    app.set('onlineUsers', onlineUsers);

    // 3000端口仅提供API服务，不托管前端静态文件
    // 前端游戏客户端和管理后台需单独部署

    server.listen(PORT, () => {
        console.log(`API服务运行在 http://localhost:${PORT}`);
        console.log(`注意：此端口仅提供API服务，前端请通过开发服务器访问`);
    });
};

startServer();

module.exports = { app, server, io };
