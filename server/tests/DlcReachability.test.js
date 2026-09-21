/**
 * DLC 可达性验收：一个"只加内容、不改代码"的资料片，装完之后每个展示面都要认得它。
 *
 * 为什么单独一份：本轮把很多界面从"前端/服务抄一份清单"改成"内容驱动"
 * （奖励池子页签、GM 变量下拉、器灵类型清单、GM 主键清单接口…）。
 * 单点测试各自能过，但没人证明"加一条内容 → 所有面同时出现"这条链是通的；
 * 而断在任何一环上的表现都一样：内容层日志正常，界面上就是没有。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContentRegistry } = require('../game/content/ContentRegistry');
const { StatRegistry } = require('../game/stats/StatRegistry');
const { infrastructure, initializeModules } = require('../modules');
const { ensureStatRegistryLoaded } = require('../game/stats');

const loader = infrastructure.ConfigLoader;
const REAL_CONFIG = path.join(__dirname, '..', 'config');

/** 探针资料片：一个新宗门 / 新副本 / 新器灵类型 / 新 BOSS，各带自己的展示标签 */
function probePack(withLabels = true) {
    const files = {
        'pack.json': { id: 'dlc_probe', name: 'DLC 探针', version: '1.0.0' },
        'sect_data__sects.json': {
            add: [{ id: 'probe_gate', name: '试剑阁', description: '探针宗门', alignment: '正道', element: '金', bonus: { probe_focus: 0.2 } }]
        },
        'multi_dungeon_data__dungeons.json': {
            add: [{
                id: 'probe_valley', name: '试剑幽谷', desc: '探针副本',
                member_min: 1, member_max: 1, acts: [],
                instance_vars: { probe_focus_power: { from: null, default: 0 } },
                rewards: { base_rewards: [{ type: 'probe_shard', count: 2 }] }
            }]
        },
        'artifact_spirit_data__spirit_types.json': {
            add: [{
                id: 'probe_type', name: '试灵型', desc: '探针器灵',
                base_bonus: { probe_percent: 0.04 }, level_bonus_per_level: { probe_percent: 0.01 },
                protect_effect: 'probe_ward', protect_value: 0.25,
                activate_effect: 'cleanse', activate_value: 1
            }]
        },
        'world_boss_data__bosses.json': {
            add: [{ boss_key: 'probe_boss', boss_name: '试剑魔君', realm_rank_min: 1, base_hp: 1000, base_atk: 10, base_def: 10, base_speed: 10 }]
        }
    };
    if (withLabels) {
        Object.assign(files, {
            'sect_data__global__bonus_labels.json': { add: [{ id: 'probe_focus', label: '会心加成', format: 'ratio' }] },
            'multi_dungeon_data__global__variable_labels.json': { add: [{ id: 'probe_focus_power', label: '会心力' }] },
            'multi_dungeon_data__global__reward_type_labels.json': { add: [{ id: 'probe_shard', label: '试剑残片' }] },
            'artifact_spirit_data__spirit_bonus_stat_labels.json': { add: [{ id: 'probe_percent', label: '会心' }] },
            'artifact_spirit_data__spirit_effect_labels.json': { add: [{ id: 'probe_ward', label: '护体', value_format: 'percent' }] }
        });
    }
    return files;
}

/** 用真实 config 目录 + 一个临时资料片目录建内容层（合并视图才是各服务读到的东西） */
function buildWithPack(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-dlc-'));
    const packDir = path.join(root, 'packs');            // ContentRegistry 扫的是"放 pack 的目录"
    const packRoot = path.join(packDir, 'dlc_probe');    // 每个 pack 一个子目录，目录名 = manifest.id
    fs.mkdirSync(packRoot, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
        fs.writeFileSync(path.join(packRoot, name.endsWith('.json') ? name : `${name}.json`), JSON.stringify(data));
    }
    const content = new ContentRegistry({ configPath: REAL_CONFIG, packDir, statRegistry: new StatRegistry() });
    content.load();
    if (!content.packs.length) throw new Error('探针资料片没被发现，这条验收会是空测');
    return { content, root };
}

/** 让真实服务读到"合并后的视图"（只在这次断言里生效，用完还原） */
function withMerged(content, names, run) {
    const original = loader.getConfig;
    loader.getConfig = (name) => (names.includes(name) ? content.dataset(name) : original.call(loader, name));
    try {
        return run();
    } finally {
        loader.getConfig = original;
    }
}

const MERGED = ['sect_data', 'multi_dungeon_data', 'artifact_spirit_data', 'world_boss_data'];

beforeAll(async () => {
    await initializeModules();
    ensureStatRegistryLoaded();
    // SectService / ArtifactSpiritService 这些实例服务要等 game/index 才拿到 configLoader，
    // 不装的话它们读不到任何东西，测试会变成在测"服务没初始化"。
    await require('../game').initializeGameServices(loader);
});

describe('一个资料片加一条内容 = 每个展示面都认得它', () => {
    test('装得上：带标签的探针资料片通过全部启动期校验', () => {
        const { content } = buildWithPack(probePack(true));
        expect(content.dataset('sect_data').sects.find(s => s.id === 'probe_gate')).toBeTruthy();
        expect(content.dataset('multi_dungeon_data').dungeons.probe_valley).toBeTruthy();
    });

    test('GM 主键清单接口（entryOptions）出现新条目，名字取自内容', () => {
        const { content } = buildWithPack(probePack(true));
        expect(content.entryOptions('sect_data').map(e => e.key)).toContain('probe_gate');
        expect(content.entryOptions('sect_data').find(e => e.key === 'probe_gate').name).toBe('试剑阁');
        expect(content.entryOptions('multi_dungeon_data').map(e => e.key)).toContain('probe_valley');
        expect(content.entryOptions('artifact_spirit_data').map(e => e.key)).toContain('probe_type');
        expect(content.entryOptions('world_boss_data').map(e => e.key)).toContain('probe_boss');
    });

    test('多人副本：新副本的专属变量进 variable_meta，GM 也调得动', () => {
        const { content } = buildWithPack(probePack(true));
        const MultiDungeonService = require('../game/services/MultiDungeonService');
        const meta = withMerged(content, ['multi_dungeon_data'], () => MultiDungeonService._variableMeta());
        expect(meta.probe_focus_power).toEqual({ dungeons: ['probe_valley'], label: '会心力' });
        const adjustable = withMerged(content, ['multi_dungeon_data'], () => MultiDungeonService.adjustableVariables());
        expect(adjustable).toContain('probe_focus_power');
        // 奖励池：条目名取自内容的 reward_type_labels，不是裸键名
        const rewards = withMerged(content, ['multi_dungeon_data'], () => MultiDungeonService.getRewards('probe_valley'));
        return rewards.then(result => {
            expect(result.success).toBe(true);
            expect(result.data.normal_rewards[0].name).toBe('试剑残片');
        });
    });

    test('器灵：新档位的文案按内容数值拼出来', () => {
        const { content } = buildWithPack(probePack(true));
        const svc = require('../game/services/ArtifactSpiritService');
        const catalog = withMerged(content, ['artifact_spirit_data'], () => svc.spiritTypeCatalog());
        const probe = catalog.find(t => t.key === 'probe_type');
        expect(probe.name).toBe('试灵型');
        expect(probe.bonus_text).toBe('会心 +4%（每级 +1%）');
        expect(probe.protect_text).toBe('护体 25%');
        expect(probe.activate_text).toBe('净化负面状态');
    });

    test('世界BOSS：新 BOSS 出现在给 GM 面板的静态清单里', () => {
        const { content } = buildWithPack(probePack(true));
        const WorldBossService = require('../game/services/WorldBossService');
        const list = withMerged(content, ['world_boss_data'], () => WorldBossService.getAllBossStaticData());
        expect(list.map(b => b.boss_key)).toContain('probe_boss');
    });

    test('宗门：新加成键的中文名走 bonus_labels，SectService.getBonusMeta 认它', () => {
        const { content } = buildWithPack(probePack(true));
        const SectService = require('../game/services/SectService');
        const meta = withMerged(content, ['sect_data'], () => SectService.getBonusMeta());
        expect(meta.probe_focus).toEqual({ label: '会心加成', format: 'ratio' });
    });
});

describe('缺展示标签的资料片：启动期就响，而不是界面上少一行', () => {
    test('新宗门带了一个没标签的加成键 → 抛', () => {
        expect(() => buildWithPack(probePack(false))).toThrow(/probe_focus/);
    });

    test('新器灵用了没标签的加成键/效果码 → 抛', () => {
        const files = probePack(false);
        delete files['sect_data__sects.json'];
        delete files['multi_dungeon_data__dungeons.json'];
        delete files['world_boss_data__bosses.json'];
        expect(() => buildWithPack(files)).toThrow(/probe_percent|probe_ward/);
    });

    /**
     * 资料片经 map 集合加的标签必然是对象（{id, …}），基础配置里是字符串。
     * 只判"键在不在"会放过一个没有 label 的对象，界面就把键名当中文名印出来。
     */
    test('标签条目缺 label 字段 → 抛（对象形状也要有真标签）', () => {
        const files = probePack(true);
        files['multi_dungeon_data__global__variable_labels.json'] = { add: [{ id: 'probe_focus_power' }] };
        expect(() => buildWithPack(files)).toThrow(/probe_focus_power/);
    });
});

describe('防空转：不打探针资料片时，这些面里确实没有 probe_*', () => {
    test('现网内容不含探针键', () => {
        const MultiDungeonService = require('../game/services/MultiDungeonService');
        const svc = require('../game/services/ArtifactSpiritService');
        expect(MultiDungeonService.adjustableVariables()).not.toContain('probe_focus_power');
        expect(svc.spiritTypeCatalog().map(t => t.key)).not.toContain('probe_type');
        expect(require('../game/services/WorldBossService').getAllBossStaticData().map(b => b.boss_key)).not.toContain('probe_boss');
    });

    test('洞府五条集合现网都没有探针键（否则下面那组断言是空的）', () => {
        const { CaveService, GardenService, CaveSocialService } = caveServices();
        expect(CaveService.getFacilityConfig('probe_forge_room')).toBeNull();
        expect(GardenService.getGardenConfig().seeds.map(s => s.seed_id)).not.toContain('probe_seed');
        expect(CaveSocialService.getLandscapesConfig().map(l => l.id)).not.toContain('probe_landscape');
        expect(CaveSocialService.getEncounterConfig().encounters.map(e => e.id)).not.toContain('probe_encounter');
        expect(CaveSocialService.getMerchantConfig().items.map(i => i.item_key)).not.toContain('probe_fruit');
    });
});

/**
 * 洞府（cave_data）。这份数据集登记进注册表之前，资料片连"加一座设施/一株灵草"都做不到，
 * 而它恰恰是最典型的"该能只加数据就扩"的内容（设施/灵种/景观/访客遭遇/商人货摊）。
 */
function cavePack(EncounterItemPool = ['low_healing_pill']) {
    return {
        'pack.json': { id: 'dlc_probe', name: '洞府探针', version: '1.0.0' },
        // map 集合的条目要自带 id：注册表按 entry.__pk ?? entry.id 取键，
        // 基础配置里的键名（spirit_vein 等）是对象属性名，资料片没法靠属性名传进来
        'cave_data__cave__facilities.json': {
            add: [{
                id: 'probe_forge_room', name: '符箓阁', description: '探针设施：制符',
                max_level: 3, bonus_per_level: 0.05,
                upgrade_costs: [{ level: 1, spirit_stone: 0, material: null }]
            }]
        },
        'cave_data__cave__garden__seeds.json': {
            add: [{
                seed_id: 'probe_seed', name: '探针灵种', produce_item_id: 'wild_herb', produce_name: '灵草',
                grow_time_seconds: 60, base_yield: 2, yield_per_level: 0.5,
                quality_rates: { common: 1 }, min_cave_level: 1
            }]
        },
        'cave_data__cave__social__landscapes.json': {
            add: [{
                id: 'probe_landscape', name: '探针景', description: '探针摆放的景观',
                cost: 100, bonus: { meditation_exp_bonus: 0.01 }, required_realm_rank: 1
            }]
        },
        'cave_data__cave__social__visit_encounters__encounters.json': {
            add: [{
                id: 'probe_encounter', name: '探针奇遇', description: '拜访时撞上的探针奇遇',
                weight: 10, type: 'item', rewards: { item_pool: EncounterItemPool, item_count: 1 }
            }]
        },
        'cave_data__cave__social__merchant__items.json': {
            add: [{ item_key: 'probe_fruit', base_price: 25, weight: 5 }]
        },
        // 商人货摊的主键是 item_key，重复 add 现网已有物品会被注册表拒掉（要改既有内容得写 override），
        // 所以资料片按真实做法先把物品自己带进来 —— 顺带证明物品与引用它的洞府条目能同包装配
        'item_data__items.json': {
            add: [{
                id: 'probe_fruit', name: '探针灵果', type: 'consumable', category: 'material',
                quality: 'common', description: '洞府探针资料片带来的灵果', stack_size: 20
            }, {
                // 灵种的 seed_id 必须同时是一件真物品（GardenService.plant 拿 seed_id 去扣背包）。
                // 这条由启动期 _validateGardenSeeds 把关 —— 加这件之前，上面那味 probe_seed
                // 其实是一株"种不下去的假灵种"，夹具自己就是那道闸抓到的第一个样本。
                id: 'probe_seed', name: '探针灵种', type: 'material', category: 'material',
                quality: 'common', description: '洞府探针资料片带来的种子', stack_size: 20
            }]
        }
    };
}

/**
 * 这三个服务的 configLoader 是**路由文件在 require 时**注入的（routes/cave.js、routes/garden.js），
 * 不在 initializeGameServices 那份清单里。测试直接 require 服务会拿到一个没装配置的实例，
 * 于是所有 accessor 都返回 {} —— 断言会"全部通过"，但那是在测空对象。
 */
function caveServices() {
    const CaveService = require('../game/services/CaveService');
    const GardenService = require('../game/services/GardenService');
    const CaveSocialService = require('../game/services/CaveSocialService');
    for (const svc of [CaveService, GardenService, CaveSocialService]) {
        svc.initialize(loader);
        if (!svc.configLoader) throw new Error(`${svc.constructor.name}.configLoader 没装上，这组断言会是空测`);
    }
    return { CaveService, GardenService, CaveSocialService };
}

/**
 * 放养场所与境界灵力上限。这两条以前整份文件都不在注册表里：
 * 资料片能加灵兽、加境界（realm_data/realm_breakthrough 都登记了），却加不了放养场所，
 * 也加不了新境界的灵力上限 —— AttributeService 读不到 realm_settings 那一档就静默按 null 算。
 */
function pastureRealmPack() {
    return {
        'pack.json': { id: 'dlc_probe', name: '放养与境界探针', version: '1.0.0' },
        'spirit_beast_pasture_data__pasture__locations.json': {
            add: [{
                location_key: 'probe_ravine', name: '探针幽谷', description: '探针放养场所',
                min_realm_rank: 1, preferred_elements: ['metal'], element_bonus_multiplier: 1.1,
                yield_items: [{ item_id: 'wild_herb', name: '灵草', weight: 100, min_qty: 1, max_qty: 2 }]
            }]
        },
        'spirit_system__realm_settings.json': {
            add: [{ id: '探针境界期', spirit_power_max: 12345 }]
        }
    };
}

describe('放养场所与境界：资料片加一条，两个读它的环境量都要跟着变', () => {
    test('放养场所列表出现新场所（这个服务把配置缓存在 this.config，必须重装一次才算数）', () => {
        const { content } = buildWithPack(pastureRealmPack());
        const BeastPastureService = require('../game/services/BeastPastureService');
        try {
            const keys = withMerged(content, ['spirit_beast_pasture_data'], () => {
                BeastPastureService.initialize(loader);
                return BeastPastureService.getLocations({ realm_rank: 30 }).data.locations.map(l => l.location_key);
            });
            expect(keys).toContain('probe_ravine');
            expect(keys).toEqual(expect.arrayContaining(['qingyun_mountain', 'volcano_crater']));
        } finally {
            BeastPastureService.initialize(loader);   // 别把探针资料片漏给后面的用例
        }
    });

    test('新境界的灵力上限进得了求解上下文（spiritRealm 不是 null）', () => {
        const { content } = buildWithPack(pastureRealmPack());
        expect(content.dataset('spirit_system').realm_settings['探针境界期'].spirit_power_max).toBe(12345);
        const AttributeService = require('../game/core/AttributeService');
        const ctx = withMerged(content, ['spirit_system'], () =>
            AttributeService._buildContext({ realm: '探针境界期' }, { realmNameOverride: '探针境界期' }));
        // 只点名字段比对：资料片来的条目会带 id 与 __content_origin（归属哪个 pack），
        // 整块 toEqual 会把这两本记账字段也算成差异
        expect(ctx.spiritRealm.spirit_power_max).toBe(12345);
        expect(content.dataset('spirit_system').realm_settings['凡人']).toEqual({ spirit_power_max: 0 });
    });

    test('不打这个资料片时，现网既没有探针场所也没有探针境界（防空转）', () => {
        const BeastPastureService = require('../game/services/BeastPastureService');
        BeastPastureService.initialize(loader);
        const keys = BeastPastureService.getLocations({ realm_rank: 30 }).data.locations.map(l => l.location_key);
        expect(keys).not.toContain('probe_ravine');
        const AttributeService = require('../game/core/AttributeService');
        const ctx = AttributeService._buildContext({ realm: '探针境界期' }, { realmNameOverride: '探针境界期' });
        expect(ctx.spiritRealm).toBeNull();
    });
});

describe('洞府：资料片只加内容，三个服务都要认得它', () => {
    test('新设施 / 新灵种 / 新景观 / 新奇遇 / 新货物都进了合并视图', () => {
        const { content } = buildWithPack(cavePack());
        const cave = content.dataset('cave_data').cave;
        expect(cave.facilities.probe_forge_room.name).toBe('符箓阁');
        expect(cave.garden.seeds.map(s => s.seed_id)).toContain('probe_seed');
        expect(cave.social.landscapes.map(l => l.id)).toContain('probe_landscape');
        expect(cave.social.visit_encounters.encounters.map(e => e.id)).toContain('probe_encounter');
        // 资料片自带的物品进了货摊（现网那 10 件里本来就没有 probe_fruit）
        expect(cave.social.merchant.items.map(i => i.item_key)).toContain('probe_fruit');
    });

    test('服务侧读到的是合并后的那份，不是 config 文件原件', () => {
        const { content } = buildWithPack(cavePack());
        const { CaveService, GardenService, CaveSocialService } = caveServices();
        const seen = withMerged(content, ['cave_data'], () => ({
            facility: CaveService.getFacilityConfig('probe_forge_room'),
            seeds: GardenService.getGardenConfig().seeds.map(s => s.seed_id),
            landscapes: CaveSocialService.getLandscapesConfig().map(l => l.id),
            encounters: CaveSocialService.getEncounterConfig().encounters.map(e => e.id)
        }));
        expect(seen.facility.max_level).toBe(3);
        expect(seen.seeds).toContain('probe_seed');
        expect(seen.landscapes).toContain('probe_landscape');
        expect(seen.encounters).toContain('probe_encounter');
    });

    test('奇遇奖励池里的物品 id 也受引用闸管：写个不存在的物品就在启动期抛', () => {
        // 这条同时是给 _validateItemKeysDeep 的 item_pool 那一档做的反证：
        // 匹配不到字段名的话，这里会安静地装出一个"撞上就什么也拿不到"的奇遇
        expect(() => buildWithPack(cavePack(['probe_item_not_in_content'])))
            .toThrow(/probe_item_not_in_content/);
    });
});
