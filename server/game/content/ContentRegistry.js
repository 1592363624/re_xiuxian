/**
 * 内容注册中心（DLC / 资料片层）
 *
 * 目标：加内容 = 放数据文件，而不是改一堆 Service。
 *
 * 三层结构
 *   1. 基础层  server/config/<dataset>.json          —— 现网既有内容，保持不动
 *   2. 资料片  server/content/packs/<packId>/*.json  —— 目录扫描自动发现，无注册代码
 *   3. 合并视图                                      —— 回灌 ConfigLoader，
 *      现网数十处 getConfig('item_data') 调用点一行不改就能看到新内容
 *
 * 每个 pack 的一个数据文件针对一个集合（collection），文件名就决定目标：
 *   <dataset>.json            → 该数据集的主集合
 *   <dataset>__<collection>.json → 指定集合（用于 technique_data__skills.json 这种同数据集多集合）
 * 形如：
 *   { "dataset": "item_data",
 *     "add":      [ { "id": "qingzhu_fengyun_sword", "effect": { "matk": 12 } } ],  // 全新内容
 *     "override": { "wooden_sword": { "effect": { "matk": 8 } } },                   // 给已有内容补字段
 *     "remove":   [ "obsolete_item" ],                                               // 下架
 *     "replace":  false }                                                            // 整集合替换（少用）
 * override 采用"一层深合并"：patch 里的对象字段（如 effect）与原值合并而非整块替换，
 * 于是"早期只做攻击、后期补法攻"这种需求只写一行数据。
 *
 * 启动期硬校验（不过则抛错，不留运行期静默失效）；后台热更走 reload()，跑的是同一套闸：
 * 两条路径都调 _refreshDerivedAndValidate()，所以"改基础配置"不会成为绕过校验的旁门：
 * 把一个拼错的属性键写进 item_data，如果只有启动期校验，表现就是玩家身上凭空少一份加成。
 * reload() 校验不过时会把该数据集退回上一份通过校验的视图再抛错，ConfigLoader 连带退回运行缓存，
 * 一次失败的编辑不会让运行中的进程突然看不到资料片内容。
 *   - manifest 合法、depends 满足、目录名与 manifest.id 一致
 *   - add 不能撞已有 id（要改用 override）；override/remove 的目标必须存在
 *   - stat_definitions 交给 StatRegistry 校验（派生公式/环/存储键冲突）
 *   - 物品 effect 键必须是已注册属性、其别名，或在效果词表内
 *   - 跨数据集引用（掉落/产出/宝库 → 物品）必须存在
 *   - 五行属性名（功法/神通的 element）必须是 role_init.spirit_roots 里的真实灵根
 */
'use strict';

const fs = require('fs');
const path = require('path');
// 神通特效词表（叶子模块，无依赖）：校验与战斗/属性折叠共用同一张表
const {
    isKnownSkillEffectKey, skillEffectVocabulary, SKILL_STAT_EFFECTS
} = require('../combat/skillEffects');
// 品质档序的唯一读取口（叶子模块）：这里只用它算"某张按品质取参数的表覆盖了哪几档"
const { qualityParamCoverage } = require('../items/itemQuality');

/**
 * 数据集结构：collections 里每个集合是 { field, key }（数组，key 为主键字段）
 * 或 { field, map: true }（对象映射，键即主键）。
 */
const DATASET_SPECS = {
    item_data: { collections: { items: { key: 'id' } } },
    // 神通（skills）也要能被资料片扩展：只登记 techniques 的话，
    // 资料片就没法新增一条"打剑意伤害"的神通，新伤害档位依旧进不了战斗。
    // element_match.conflicts 也登记成集合（2026-09-22）：资料片给自己新加的灵根配一条相克，
    // 不需要改 TechniqueService。基础值是裸数组（走 passthrough 原样保留），片里写的是对象条目，
    // 读取端一律过 contentList —— 否则 `Array.isArray` 会静默丢掉资料片那一条。
    // grades（品阶表）同一天登记：TechniqueService.getGradeConfig 是它唯一的读取口，
    // 12 处消费全部写成 `Number(gradeCfg.x) || 兜底`，而 getRequiredProficiency 在查不到品阶时
    // 直接返回 Infinity —— 资料片加得了新功法、加不了它所属的那一档品阶，写一个表里没有的 grade
    // 就得到一部"熟练度永远到不了阈值、界面品阶徽章是空的"功法（见 _validateTechniqueGrades）。
    // grades / fish_pools 都标 optional：登记成**必填**会让"只塞部分集合的合成夹具"在 load() 就抛
    // "集合缺失"（本轮真踩到，ContentRegistry.test.js 一次红 7 条 —— §13b 同一个坑）。
    // "表整个没了"仍然硬拦，但拦在校验器那一层：它看得到全貌，读集合的那一层不该替它决定。
    technique_data: {
        collections: {
            techniques: { map: true },
            grades: { map: true, optional: true },
            skills: { map: true, optional: true },
            'element_match.conflicts': { map: true, optional: true }
        }
    },
    resource_data: { collections: { resource_yields: { key: 'resource_id' } } },
    drop_data: { collections: { drops: { key: 'monster_id' }, boss_drops: { key: 'monster_id', optional: true } } },
    map_data: { collections: { maps: { key: 'id' } } },
    realm_breakthrough: { collections: { realms: { key: 'id' } } },
    // 展示用的标签表也登记成集合：资料片能加宗门/副本/器灵，但过去没法给它配中文名，
    // 结果就是"加了内容反而启动失败"（启动期闸要求每个键都有标签）。map 集合按键合并，
    // `_note` 这类字符串值走 passthrough 原样保留。
    sect_data: { collections: { sects: { key: 'id' }, 'global.bonus_labels': { map: true, optional: true } } },
    spirit_beast_data: {
        collections: {
            beast_types: { key: 'beast_key' },
            elements: { map: true },
            settings: { map: true },
            // 稀有度词表 + 两张按它取参数的伴生表：三格必须一起开。
            // 只开词表 = 资料片加得出档位，加不了它的升星倍率（回落 1.0，越稀有反而越便宜）；
            // 只开倍率 = 词表没这一档，图鉴连名字都没有。三道键名都在 _validateBeastRarity 里对账。
            // 三格都 optional：合成夹具/只喂部分数据集的测试里没有 star_upgrade 是合法的，
            // 缺口的判定交给校验器（它问的是"词表里有没有这一档"，不是"集合登记了没有"）。
            rarity_config: { map: true, optional: true },
            'star_upgrade.rarity_cost_multiplier': { map: true, optional: true },
            'star_upgrade.upgrade_table': { key: 'from_star', optional: true }
        }
    },
    dungeon_data: { collections: { chapters: { key: 'id' } } },
    multi_dungeon_data: {
        collections: {
            dungeons: { map: true },
            'global.variable_labels': { map: true, optional: true },
            'global.reward_type_labels': { map: true, optional: true }
        }
    },
    achievement_data: { collections: { achievements: { key: 'id' }, categories: { map: true, optional: true } } },
    // 玩家统计量词表（成就度量、祖业求和、后台展示共用的取数声明）。
    // 登记成 map 集合 = 资料片加一档统计量不必动任何代码；启动期 _validatePlayerMetrics 逐条判来源形状。
    player_metrics: { collections: { metrics: { map: true } } },
    world_boss_data: { collections: { bosses: { key: 'boss_key' } } },
    // 兽潮妖兽与灵兽探渊的层以前根本不在这个注册表里：资料片加不了新妖兽/新层，
    // 更糟的是下面 _validateCombatStatBlocks 里那两条"兽潮/探渊"的校验分支永远读不到数据集，
    // 于是声明写错了也没有任何启动期信号（看起来有闸，其实闸没接线）。
    beast_invasion_data: { collections: { beasts: { key: 'beast_key' } } },
    spirit_beast_abyss_data: { collections: { floors: { key: 'floor' } } },
    // 切磋木人的属性块本来就以 stats 的形式写在内容里（max_hp/atk/def/speed），
    // 但这份数据集没登记：资料片加不了木人，服务里那份 require(JSON) 又把这个文件永久缓存住，
    // 于是它既是"内容层的盲区"也是"校验层的盲区"。登记之后两件事一起解决。
    sparring_woodman: { collections: { woodmen: { key: 'key' } } },
    // 傀儡是"友方版本的怪物"：base_stats 就是一整块属性，出战/护法时按比例折算进玩家战斗。
    // 不登记的话资料片既加不了傀儡类型，也解释不了为什么傀儡的属性键不受启动期校验管。
    puppet_data: {
        collections: {
            puppet_types: { map: true },
            // 图谱必须和类型一起开：只开 puppet_types 时，资料片加得出新傀儡却没有任何途径能学会它
            // （learnBlueprint 扣的是背包里那张图谱物品），而客户端"参悟"按钮以前是按
            // `类型 + '_blueprint'` 拼 key 的 —— 名字不合这个约定的图谱一点就报"图谱不存在"。
            blueprints: { map: true, optional: true }
        }
    },
    // 下面这几份是"一个玩法一个文件、条目数组住在第二层"的典型：登记之前资料片完全碰不到它们，
    // 而这些玩法恰恰是最需要"只加数据就能扩"的内容（妾室/道侣、灵兽段位、宗门专属、飞升形态、后期法则）。
    /**
     * 道侣 / 侍妾：两张词表 + 一份按模式分的奖励池（2026-09-23）。
     *
     * 登记之前这两处都是"内容里有、代码里也点写了一份"：`routes/companion.js` 与
     * `CompanionService` 各抄了一份 `['steady','ruthless','deceive']`，`routes/concubine.js`
     * 与 `ConcubineService` 各抄了一份四个远航模式 —— 资料片加第五个模式或第四个选项，
     * 会被路由当场以"参数非法"挡掉（客户端面板的注释甚至直接写着「后端不下发名称」）。
     *
     * `voyage.reward_pools` 登记成 map 而不是给每档池子登记条目表，原因有两个实测出来的：
     *   · 池子里的条目没有稳定主键（同一档可以有两行 `type:"item"`，按 type 登记会互相覆盖）；
     *   · 池子的值是**裸数组**，而 pack 经 map 追加只能是对象 → 消费端必须过 `contentList` 取形
     *     （否则资料片新加的那一档会被当成空池子：走出去必定空手回来，而回执一切正常）。
     * 所以"往已有那一档里多加一件东西"目前要整份池子 override —— 这条限制写在这里，
     * 也写在启动闸的报错里，不做成"看起来能加其实加了没用"。
     */
    companion_data: {
        collections: {
            concubines: { key: 'concubine_key' },
            'heart_tribulation.options': { map: true, optional: true },
            'voyage.modes': { map: true, optional: true },
            'voyage.reward_pools': { map: true, optional: true }
        }
    },
    spirit_beast_pvp_data: { collections: { 'spirit_beast_pvp.tiers': { key: 'key' } } },
    sect_special_data: {
        collections: {
            'star_platform.star_forms': { key: 'id' },
            'fate_disk.fates': { key: 'id' }
        }
    },
    ascension_data: {
        collections: {
            'dharma_form.levels': { key: 'level' },
            'fracture_explore.rewards': { key: 'name' }
        }
    },
    late_stage_data: {
        collections: {
            'divine_temple.offerings': { key: 'name' },
            'law.convert_options': { key: 'name' },
            'second_soul.fragment_types': { map: true },
            'second_soul.dispatch_modes': { map: true }
        }
    },
    // 历练事件：这份内容以前根本不在 config/ 里，而是抄在 AdventureEventService 的代码里
    // （模板 / 抽取权重 / AI 标题 / AI 保底经验四份）。抄在代码里的内容对所有内容闸都是隐形的：
    // 物品引用不校验、资料片加不进来、启动期报错也指不到它。搬进来之后它才受这条链保护。
    // events 放第一个 = 主集合：资料片只写 <dataset>.json 时进的就是它；
    // 要动类型表得写 <dataset>__event_types.json（权重/标题是一张按类型索引的表，不是数组）。
    adventure_event_data: {
        collections: {
            events: { key: 'id' },
            event_types: { map: true }
        }
    },
    // 洞府整份都没登记过：五座设施、四条灵种、五处景观、五种访客遭遇、十件商人货摊全是内容，
    // 资料片既加不了"符箓阁"也加不了一株新灵草，而洞府的产出/冷却/升级材料又恰恰是最常扩的东西。
    cave_data: {
        collections: {
            'cave.facilities': { map: true },
            'cave.garden.seeds': { key: 'seed_id' },
            'cave.social.landscapes': { key: 'id' },
            'cave.social.visit_encounters.encounters': { key: 'id' },
            'cave.social.merchant.items': { key: 'item_key' }
        }
    },
    // 放养场所（灵田/火山口…）是一条条内容：场所名、境界门槛、偏好五行、产出物与权重。
    // 以前整份文件没登记，资料片加不了新场所；同时它也是物品引用的盲区（yield_items[].item_id）。
    spirit_beast_pasture_data: { collections: { 'pasture.locations': { key: 'location_key' } } },
    // 境界 → 灵力上限：realm_data / realm_breakthrough 都可被资料片扩展，唯独这张表不行，
    // 于是"资料片新开一个境界"会算不出 mp_max（AttributeService 读不到就是 null，静默降级）。
    spirit_system: { collections: { realm_settings: { map: true } } },
    taoism_gate_data: { collections: { dao_paths: { map: true } } },
    dayan_data: { collections: { levels: { map: true }, fragments: { map: true } } },
    // 鱼池与稀有材料池登记成集合（2026-09-22）：`ponds` 早就开了口子，但渔获表没开 ——
    // 于是资料片加得了新渔场，它 `fish_pool` 只能指现网那 4 池（指一个新名字就是运行时 TypeError，
    // 见 _validateFishingPonds 里那条"906 行没有兜底"的说明）。这是 §16/§17 同一形状的第四例：
    // **登记了条目集合、漏了它配套的引用目标表**。
    fishing_data: {
        collections: {
            rods: { map: true },
            baits: { map: true },
            ponds: { map: true },
            fish_pools: { map: true, optional: true },
            rare_material_pools: { map: true, optional: true }
        }
    },
    /**
     * 赌石：词表 + 四张产出池全部开放（2026-09-23）。
     *
     * 登记分两层是有原因的，两件事各自要扩的对象不一样：
     *   · `yield_pools.materials` / `.rare_drops` / `.spirit_stones` / `.cultivation` 登记成 **map**
     *     —— 资料片新加一档品质时，用它一次给出这一档的整套池子（`add: { immortal: [...] }`）；
     *   · 每一档品质各自的池子再登记成**条目表** —— `materials` 按 `item_id`，
     *     `rare_drops` 按 `name`（那张表里混着 `{type:'ldc'}` 这种没有 item_id 的条目，
     *     只有 name 是每种形状都带的；按 item_id 登记会在装配阶段就抛"缺主键"）
     *     —— 资料片新加一种矿石/丹药时，只需往已有那一档里 `add` 一条，不用抄回整份列表
     *     （只有 map 那一层的话，加一条东西要重写整个池子，两支资料片同时加就互相覆盖）。
     * `clues` 也登记成 map：维度名就是键（服务侧现在按内容遍历维度，见 GamblingStoneService._clueDimensions）。
     * 全部 `optional: true` 的理由同前几格：登记集合写必填会让只带自己那一块内容的夹具炸掉，
     * "表被抹空/缺档"交给 `_validateGamblingStone()` 判，且它问的是基础配置那份。
     */
    gambling_stone_data: {
        collections: {
            origins: { map: true },
            qualities: { map: true },
            cut_methods: { map: true },
            clues: { map: true, optional: true },
            'skill.level_titles': { map: true, optional: true },
            'yield_pools.spirit_stones': { map: true, optional: true },
            'yield_pools.cultivation': { map: true, optional: true },
            'yield_pools.materials': { map: true, optional: true },
            'yield_pools.rare_drops': { map: true, optional: true },
            'yield_pools.materials.common': { key: 'item_id', optional: true },
            'yield_pools.materials.spirit_vein': { key: 'item_id', optional: true },
            'yield_pools.materials.treasure_glow': { key: 'item_id', optional: true },
            'yield_pools.materials.fairy_mist': { key: 'item_id', optional: true },
            'yield_pools.rare_drops.spirit_vein': { key: 'name', optional: true },
            'yield_pools.rare_drops.treasure_glow': { key: 'name', optional: true },
            'yield_pools.rare_drops.fairy_mist': { key: 'name', optional: true }
        }
    },
    artifact_spirit_data: {
        collections: {
            spirit_types: { map: true },
            spirit_bonus_stat_labels: { map: true, optional: true },
            spirit_effect_labels: { map: true, optional: true }
        }
    },
    stock_data: { collections: { stocks: { key: 'code' } } },
    lottery_data: { collections: { ranks: { map: true }, pool: { key: 'name' } } },
    formation_data: {
        collections: {
            formations: { key: 'id' },
            /**
             * 两张名字表登记成集合：`FormationService.formationCategories()` 是
             * `Object.keys(category_display_names)` —— 这张表的键**就是合法流派的全集**（路由据此挡参数），
             * 品级名同理。以前只登记了 formations，于是资料片能加阵法、加不了新的一档流派/品级，
             * 而服务注释还写着"以内容为准"。登记之后"只加数据开一档流派"才真的成立。
             */
            'global.category_display_names': { map: true },
            'global.grade_display_names': { map: true }
            // global.counter_relationships 刻意**不**登记：它的值是"流派→流派"的引用而不是标签。
            // 登记成 map 集合只会让资料片写进来的一条引用变成对象、比较处永远不相等 ——
            // 那正是"配了不生效"的新形状。所以这里宁缺：片想写它会被"未登记集合"当场挡下（有测试钉），
            // 加一档新流派于是克性是中性（与灵兽雷元素的处置一致），要真接相克得先设计引用条目形状。
        }
    },
    crafting_data: { collections: { alchemy_recipes: { key: 'id' }, refining_recipes: { key: 'id' } } },
    stat_definitions: { collections: { stats: { key: 'key' } } },
    // 法宝深度玩法（血魔剑/虚天鼎/遮天瓶…）的每一套配置都住在 settings.<法宝id> 下，
    // 登记成 map 集合之后，资料片就能"只写一个 JSON"给自己新增一件可祭炼的法宝；
    // 不登记的话它连合并视图都没有，新增法宝只能改基础配置 + 改服务代码。
    // combat_bonus_sources 标 optional 是为了让别的测试的合成基座不必陪葬（少一个键就启动失败）；
    // 真配置里空表/缺表由聚合器自己报 source_problems（少一条 = 那条法宝线的加成不进账）。
    /**
     * game_balance 整体是"改数值"而不是"加内容"（间隔/分页/限速/段位表），所以只登记这一条嵌套路径：
     * `equipment.slot_names` —— 它是装备槽位的**词表**（键=槽位，值=中文名）。
     * 不登记它，资料片就加不了一档新槽位：物品能加（item_data 是集合）、路由能装（slot 列是 STRING(20)），
     * 唯独"这个槽位合法吗/它叫什么"没有可扩展的落点，于是新装备在启动自检里被判成死内容。
     * 登记成 map 集合要求值是对象（{id,label}），所以配置里已从"槽位→字符串"改成"槽位→{id,label}"，
     * 消费端一律走 EquipmentService.slotVocabulary()（内含 contentLabel，两种形状都认）。
     */
    /**
     * 灵根三件套登记成可扩展集合（2026-09-22）：`spirit_roots` 是条目表（id 主键），
     * 概率表与加成表是"键 → 值"的字典，所以走 map 集合。
     * 以前 role_init 整份被标成"不是内容集合"，理由写的是"map 集合只支持对象值" ——
     * 那条理由已被 `tests/CollectionShapeLedger.test.js` 的实测否证（标量值走 passthrough 原样保留，
     * 资料片条目本来就是对象、读取端过 contentLabel/contentNumber）。所以"资料片加一种灵根"
     * 现在真的只是写数据：新灵根的 type 会同时进灵兽/神通的元素词表（那道闸读的就是这张表）。
     */
    role_init: {
        collections: {
            spirit_roots: { key: 'id' },
            spiritRootProbabilities: { map: true, optional: true },
            spiritRootBonuses: { map: true, optional: true }
        }
    },
    game_balance: {
        collections: {
            'equipment.slot_names': { map: true, optional: true },
            // 品质词表同族：档名/色令牌/排序都存在内容里，资料片可以加一档或改叫法
            'item_qualities': { map: true, optional: true }
        }
    },
    artifact_deep_lines: { collections: { settings: { map: true }, combat_bonus_sources: { key: 'key', optional: true }, bonus_field_labels: { map: true, optional: true } } },
    // 宗门战领地是纯内容（一张图上的一块块地：产出、上限、地图坐标）。不登记的话资料片加不了一块领地，
    // 而领地字段写错也没有任何启动期信号。
    sect_war_data: { collections: { territories: { key: 'territory_key' } } },
    // 天时系统：加一条吉时/凶时、或一种凡俗活动，本该只是写数据；不登记就只能改 DualTimeService。
    time_system: {
        collections: {
            heavenly_events: { key: 'key' },
            mortal_activities: { map: true }
        }
    },
    // 慕兰战线：后勤路线、巡山路线、临战刻印类型、军功商店货架、军功里程碑档位都是条目集合。
    // 登记之前资料片碰不到它们；更要紧的是这份文件根本不在合并视图里，
    // _validateItemKeysDeep 那道深扫自然也看不见它 —— 于是货架与掉落里 4 个不存在的物品 id
    // 一直躺着（玩家兑换时收到"物品发放失败"；里程碑更狠：先把"已发放"记进表再吞掉发放异常，
    // 奖励永久丢失且不会再补）。登记之后这两件事一起解决。
    border_military_data: {
        collections: {
            support_routes: { map: true },
            'beast_patrol.routes': { map: true },
            'war_imprint.imprint_types': { map: true },
            'military_shop.items': { key: 'key' },
            'milestones.thresholds': { key: 'merit' }
        }
    },
    // 伤害/战力公式档位：资料片加了新属性（battleRoles）之后，还要能加一条用它的公式，
    // 否则"新属性进了面板却进不了战斗"，扩展性承诺只兑现一半。
    combat_formulas: { collections: { profiles: { map: true } } },
    effect_vocabulary: { collections: { effects: { key: 'id' } } },
    talents: { collections: { root: { key: 'id', root: true } } },
    titles: { collections: { root: { key: 'id', root: true } } }
};

const DEFAULT_COLLECTION = (dataset) => {
    const spec = DATASET_SPECS[dataset];
    if (!spec) return null;
    return Object.keys(spec.collections)[0];
};

/**
 * 成就奖励的合法键 = `AchievementService.claimReward` 真的去读的那几个键。
 *
 * 这份名单不是"我希望支持什么"，而是"代码现在读什么"，所以它必须与那几行取值一一对得上 ——
 * tests/AchievementRewardShape.test.js 会把服务源码里的 `reward.xxx` 全扫一遍来比对这份表，
 * 加了一个口子忘了开闸（或反过来）都会红。
 */
const ACHIEVEMENT_REWARD_KEYS = ['spirit_stones', 'exp', 'items', 'title_id'];

/** 统计量"自己会变小"的口径，只有代码里真实现了清零的才允许出现在内容里 */
const METRIC_RESET_KINDS = ['daily'];

/**
 * 代码里真实存在的 `bumpStat(实例, '<计数键>', …)` 字面量集合。
 *
 * 为什么启动期要去读源码：这一族判据要回答的是"内容配了一档 stats 计数，可有没有人往它累加"。
 * 只靠 `pending_writer` 那格自证是不够的 —— 谁都能写一句理由把它糊过去，而写完 pack 就忘的
 * 才是常态（现网那 14 条进度恒 0 的成就就是这么来的）。扫一遍源码的代价是一次文件遍历，
 * 换来的是"配了没人写"和"豁免忘了删"两个方向都会当场红。
 * 结果缓存：JS 源码不会热更，配置热更时不必重扫。
 */
let statWriterCache = null;
function statWriterCalls() {
    if (statWriterCache) return statWriterCache;
    const keys = new Set();
    const serverRoot = path.join(__dirname, '..', '..');
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') walk(full);
                continue;
            }
            if (!entry.name.endsWith('.js')) continue;
            let text = '';
            try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
            // 形状一：bumpStat(实例, 'kill_count', 1, …) —— 增量累加
            for (const m of text.matchAll(/\bbumpStat\(\s*[^,)]+,\s*'([a-z][a-z0-9_]+)'/g)) keys.add(m[1]);
            // 形状二：setStatKeys(实例, { duel_count: n, duel_last_date: d }, …)
            // 每日计数那一族要"换日则从 1 重新开始"，$add 表达不出来，所以走键级绝对值写；
            // 判据必须同时认识这一形 —— 只认 bumpStat 的话，迁到新助手就会报"配了没人写"的假红。
            for (const m of text.matchAll(/\bsetStatKeys\(\s*[^,]+,\s*\{([^}]*)\}/g)) {
                for (const k of m[1].matchAll(/(?:^|[,{\s])['"]?([a-z][a-z0-9_]*)['"]?\s*:/g)) keys.add(k[1]);
            }
        }
    };
    for (const dir of ['game', 'routes']) walk(path.join(serverRoot, dir));
    statWriterCache = keys;
    return keys;
}

/** 读某个"相对 server 根目录"的源码文件（读不到返回 null）；同样带缓存，配置热更不必重扫 */
const sourceTextCache = new Map();
function sourceTextOf(relPath) {
    const norm = String(relPath || '').replace(/\\/g, '/');
    if (sourceTextCache.has(norm)) return sourceTextCache.get(norm);
    const serverRoot = path.join(__dirname, '..', '..');
    const full = path.join(serverRoot, norm);
    let text = null;
    // 只认 server 根目录之内、且不越过 .. 的相对路径：这一格是内容里写的声明，不能变成读任意文件的口子
    if (norm && !norm.startsWith('/') && !norm.includes('..')) {
        try { text = fs.readFileSync(full, 'utf8'); } catch { text = null; }
    }
    sourceTextCache.set(norm, text);
    return text;
}
/**
 * 非属性效果词表：这些 effect 键不属于"属性"，由各子系统自行消费。
 * 显式列出是为了让校验区分"故意不是属性"与"属性名拼错了"——后者必须启动期失败。
 */
const BASE_EFFECT_VOCABULARY = [
    { id: 'hp_restore', label: '气血恢复', description: '回复气血' },
    { id: 'mp_restore', label: '灵力恢复', description: '回复灵力' },
    { id: 'exp', label: '修为', description: '直接增加修为' },
    { id: 'spirit_stones', label: '灵石', description: '直接增加灵石' },
    { id: 'spirit_stones_random', label: '随机灵石', description: '随机灵石' },
    { id: 'breakthrough_bonus', label: '突破加成', description: '提升突破成功率', format: 'ratio_pct' },
    { id: 'longevity_add', label: '寿元', description: '增加寿元' },
    { id: 'toxicity_reduce', label: '丹毒清除', description: '降低丹毒' },
    { id: 'alchemy_bonus', label: '炼丹成功率', description: '炼丹成功率加成' },
    { id: 'seal_bonus', label: '封印加成', description: '封印/法则加成' },
    { id: 'divine_sense_bonus', label: '神识储备', description: '神识储备加成' },
    { id: 'dungeon_ticket', label: '副本凭证', description: '副本入场凭证' },
    { id: 'learn_recipe', label: '学习配方', description: '学习配方' },
    // 功法残卷：TechniqueService.learnTechnique 的 recipe_scroll 分支按 acquire.item_id 反向消耗它，
    // 这一键只是让玩家在背包里点开卷轴时能看出它悟的是哪一部（不是 CraftingService 那条 learn_recipe）
    { id: 'learn_technique', label: '研习功法', description: '在功法页研习对应功法（消耗本卷）' },
    { id: 'ascension_protect_material', label: '飞升护持', description: '飞升护持材料' },
    // 通配效果：由属性系统展开到"全部已注册属性"，因此新增属性自动被它覆盖
    { id: 'all_stats_bonus', label: '全属性', description: '全属性加成（随属性注册表自动扩展）', wildcard: true }
];

/** 跨数据集引用完整性检查（nested 指条目内层的数组字段） */
const REFERENCES = [
    { dataset: 'drop_data', collection: 'drops', nested: 'drops', field: 'item_id', target: 'item_data' },
    { dataset: 'drop_data', collection: 'boss_drops', nested: 'drops', field: 'item_id', target: 'item_data' },
    { dataset: 'resource_data', collection: 'resource_yields', nested: null, field: 'item_id', target: 'item_data' },
    { dataset: 'sect_data', collection: 'sects', nested: 'treasury', field: 'item_key', target: 'item_data' }
];

/**
 * 显式豁免的"可选物品引用"：这些路径上的 item 键允许指向不存在的物品，
 * 因为读它的代码本身就写了缺失时的降级分支，或者干脆还没有代码在读。
 *
 * 为什么写在这里而不是放宽整道闸：每一条例外都要写理由，理由要能在代码里查到；
 * 新增一条时必须回答"到底是没实现、还是故意可选"，否则这道闸就会悄悄变成摆设。
 */
const OPTIONAL_ITEM_REFS = [
    {
        at: 'sect_special_data.spirit_eye_tree.harvest.produce_item_key',
        item: 'spirit_eye_fruit',
        reason: '采收分支自己写了"物品配置不存在时给一次性经验奖励"（SectSpecialService 的 harvest），缺物品是设计允许的降级；要真出果实只需补这个物品，代码不用改'
    },
    {
        at: 'sect_special_data.spirit_eye_tree.seed_item_key',
        item: 'spirit_eye_seed',
        reason: '全仓库没有任何代码读 seed_item_key：灵眼树的"结果实"有实现，"留种"没有。补实现时要么一并发放这个物品，要么删掉这个键'
    },
    {
        at: 'sect_special_data.star_platform.star_chart_item_key',
        item: 'star_chart',
        reason: '全仓库没有任何代码读 star_chart_item_key：星台玩法读的是 star_forms，这个键是未完成玩法留下的'
    }
];

class ContentError extends Error {}

/**
 * 深扫内容时允许嵌套多深（只有 `_walkItemRefs` 用）。
 *
 * 原来写死 8，而**现网就有一条 9 层的真实引用**：
 * `dungeon_data.chapters[].nodes[].options[].rewards.items[].item_key`（实测 15 处）——
 * 走到第 9 层直接 return，于是这些副本抉择奖励里的物品 id 从来没被存在性校验看过一眼。
 * 深度上限只是防"配置里出现环"，而内容全部来自 JSON.parse（结构上不可能有环），
 * 所以留 24 层纯保险。要改这条判据必须同时过 tests/ItemReferenceShapes.test.js。
 */
const MAX_ITEM_REF_DEPTH = 24;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 内容字典里"真条目"的键：`_comment` 这类说明文字、以及 `__content_origin` / `__pk` 这种
 * 装配期的记账字段都不是一条内容。校验器若把它们当条目，就会拿说明去要求 name/label 齐备。
 */
function entryKeys(dict) {
    return Object.keys(dict || {}).filter(k => !k.startsWith('_'));
}

/**
 * 集合名允许写成点号路径（如 `spirit_beast_pvp.tiers`）。
 *
 * 为什么需要：现网最大的几份玩法配置（late_stage_data / ascension_data / sect_special_data
 * / spirit_beast_pvp_data …）都是"一个文件里再分子系统"的形状，真正的条目数组住在第二、三层。
 * 只支持顶层集合的话，这些玩法就永远进不了资料片层 —— 而它们恰恰是最需要"只加数据就能扩展"的内容。
 * 路径只用来定位容器，条目的合并/覆盖/删除规则与顶层集合完全一样，不是第二套机制。
 */
function getPath(data, collectionName) {
    let cursor = data;
    for (const segment of String(collectionName).split('.')) {
        if (!isPlainObject(cursor)) return undefined;
        cursor = cursor[segment];
    }
    return cursor;
}

/** 沿路径逐层浅拷贝后写回（不修改基础配置那份对象，否则一次热更就会污染下一次合并） */
function setPath(root, collectionName, value) {
    const [head, ...rest] = String(collectionName).split('.');
    if (!rest.length) return { ...(isPlainObject(root) ? root : {}), [head]: value };
    const child = isPlainObject(root?.[head]) ? root[head] : {};
    return { ...(isPlainObject(root) ? root : {}), [head]: setPath(child, rest.join('.'), value) };
}

/** 集合规范化：统一成条目数组 + 主键，并记住回写方式 */
function readCollection(dataset, data, collectionName) {
    const spec = DATASET_SPECS[dataset]?.collections?.[collectionName];
    if (!spec) throw new ContentError(`数据集 ${dataset} 未登记集合 ${collectionName}`);

    if (spec.root) {
        if (!Array.isArray(data)) throw new ContentError(`${dataset}: 根结构应为数组`);
        return { spec, entries: data, passthrough: {} };
    }

    const raw = getPath(data, collectionName);
    if (raw === undefined || raw === null) {
        if (spec.optional) return { spec, entries: [], passthrough: {} };
        throw new ContentError(`${dataset}.${collectionName} 缺失`);
    }

    if (spec.map) {
        if (!isPlainObject(raw)) throw new ContentError(`${dataset}.${collectionName} 应为对象映射`);
        const entries = [];
        const passthrough = {};
        for (const [key, value] of Object.entries(raw)) {
            // _comment / _meta 这类说明性键不是内容，原样保留，不能被当成条目展开
            if (isPlainObject(value)) entries.push({ ...value, __pk: key });
            else passthrough[key] = value;
        }
        return { spec, entries, passthrough };
    }

    if (!Array.isArray(raw)) throw new ContentError(`${dataset}.${collectionName} 应为数组`);
    return { spec, entries: raw, passthrough: {} };
}

/**
 * 展示标签取法：基础配置里标签是字符串（`"morale": "士气"`），
 * 而资料片通过 map 集合追加的条目必然是对象（`{id, label}`），合并后两种形状并存。
 * 所有读标签的地方都过这一层 —— 否则资料片加的标签会印成 `[object Object]`。
 *
 * `value` 是最后一档：map 集合的**值本身就是那个标签**时（赌石的等级称号表
 * `{"0":"赌石新手", ...}`），资料片写出来的对象里承载标签的键就是 `value`
 * （`{id:'20', value:'铁口直断'}`）；这一档放在最后，所以 `{label}/{name}` 的既有语义不变。
 */
function contentLabel(value, fallback = null) {
    if (typeof value === 'string') return value.trim() || fallback;
    if (isPlainObject(value)) {
        const label = value.label ?? value.name ?? value.title ?? value.value;
        if (typeof label === 'string' && label.trim()) return label.trim();
    }
    return fallback;
}

/**
 * 数值型登记表（概率/权重/倍率这类"键 → 一个数"的表）的取法，与 `contentLabel` 同族：
 * 基础配置写的是裸数字（`"金": 0.2`），而资料片经 map 集合追加的条目**必然是对象**
 * （`{id:'雷', value:0.05}`）—— 直接 `+=` 会算出 NaN，于是整池权重崩掉、玩家永远抽到第一个。
 * 认三种写法：裸数字、`{value}`、`{number|weight|prob}`；取不到就返回 fallback。
 */
function contentNumber(value, fallback = null) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (isPlainObject(value)) {
        for (const field of ['value', 'number', 'weight', 'probability']) {
            const inner = value[field];
            if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
        }
    }
    return fallback;
}

/**
 * 列表型登记表的取法，与 `contentLabel`/`contentNumber` 同族（如五行相克表"灵根 → 被克的属性列表"）。
 * 基础配置写的是裸数组（`"fire": ["metal"]`），而资料片经 map 集合追加的条目**必然是对象**
 * （`{id:'star', counters:['metal']}`）—— 消费端如果只认 `Array.isArray`，资料片那一条就会被静默丢掉，
 * 表现和"配了却没人读"一模一样。认三种写法：数组、`{counters|values|items|list}`、单个字符串。
 */
function contentList(value, fallback = []) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (isPlainObject(value)) {
        // `value` 放在最后：它是 map 集合里 pack 条目的**规范包装键**（`{id, value:[...]}`），
        // 与 contentLabel/contentNumber/contentRange 认的那颗同名 —— 四颗兼容层要认同一套形状，
        // 否则资料片作者按其中一种写法提交，只有某几张表能用（另一些静默变成空列表）。
        for (const field of ['counters', 'values', 'items', 'list', 'value']) {
            const inner = value[field];
            if (Array.isArray(inner) && inner.length) return inner;
            if (typeof inner === 'string' && inner.trim()) return [inner.trim()];
        }
    }
    return fallback;
}

/**
 * 区间型登记表的取法（`contentLabel`/`contentNumber`/`contentList` 同族，2026-09-23 因赌石产出池补）。
 *
 * 为什么单独要一个：这类表的值是 `[min,max]` 两个数（赌石每档品质的灵石/修为产出区间）。
 * 基础配置写的是裸数组，而资料片经 map 集合追加的条目**必然是对象**（`{id:'immortal_mist', value:[50,120]}`），
 * 消费端写成 `range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1))` 时，
 * 拿到对象会得 `undefined + NaN` = NaN —— 于是那一档石头切出来的产出是 NaN，
 * 而且是在**发钱那一步**才炸（玩家看到的是"服务器内部错误"的 400）。
 * 认四种写法：`[min,max]`、`{value:[..]}`、`{range:[..]}`、`{min,max}`；拿不到就返回 null 交给调用点报错。
 */
function contentRange(value, fallback = null) {
    const pair = list => (Array.isArray(list) && list.length >= 2
        && Number.isFinite(Number(list[0])) && Number.isFinite(Number(list[1]))
        ? [Number(list[0]), Number(list[1])] : null);
    if (Array.isArray(value)) return pair(value) ?? fallback;
    if (isPlainObject(value)) {
        for (const field of ['value', 'range', 'values']) {
            const picked = pair(value[field]);
            if (picked) return picked;
        }
        const min = Number(value.min), max = Number(value.max);
        if (Number.isFinite(min) && Number.isFinite(max)) return [min, max];
    }
    return fallback;
}

/**
 * 「物品 effect 里没有任何一处落账」的键（存量台账，每条必须带理由，理由过期会反过来红）。
 * 判"有没有人落账"没法机械做（要看整条链），所以这张表是**人写的结论**：
 * 名单外的键由 `_validateItemEffects`（必须是注册属性或效果词表）+ 资料片新增即拦兜住。
 */
const UNAPPLIED_ITEM_EFFECTS = {
    breakthrough_bonus: '突破流程读的是 attributes.breakthrough_bonus（RealmService.resolveBreakthroughBonus 走属性解析层，'
        + 'LawService 那一支就是这么写进去的），而"使用物品"这条链从来没往那个键写过东西 —— '
        + '现网 16 件物品拿它当唯一或主要效果（筑基丹 15 … 补天丹 60）。要接只要一行 $add，'
        + '但先要业主定三件事：永久还是本次突破一次性、注册表 30 点上限要不要抬（现网 11 件配的值超过它）、'
        + '以及 化龙脉石 写的 0.1 是 10% 还是 0.1 点（同一个键现网有两种单位）'
};

/**
 * 已知例外：某支资料片带来的物品用了没落账的效果键，但删掉它等于改别人的内容，所以带理由登记
 * （与 OPTIONAL_ITEM_REFS 同一套纪律：例外不再命中就 console.warn，防止例外和它想解释的烂内容一起烂掉）。
 */
const UNAPPLIED_ITEM_EFFECT_EXCEPTIONS = [
    {
        key: 'breakthrough_bonus',
        item: 'wuzhen_dan',
        why: '悟真丹是本轮之前另一路改动加进乱星海片的（+3 突破加成），与本表那 16 件基础丹药同一条死账；业主定出口后一并接上，届时这条例外会因为不再命中而自动报红'
    }
];

/**
 * 「按品质档名取一个数」的伴生参数表清单（显式登记，不按键名猜）。
 * 每一份都会在启动报告里点名"哪一档没有自己的值、继承了哪一档"，见 `_validateItemQualities`。
 */
const QUALITY_PARAMETER_TABLES = [
    {
        dataset: 'game_balance',
        path: 'pawnshop.valuation_ratios',
        usedBy: 'PawnshopService._calculateValuation（典当估值系数，随品质递减）'
    }
];

function keyOf(entry, spec, index) {    if (!isPlainObject(entry)) throw new ContentError(`条目 #${index} 不是对象（是 ${JSON.stringify(entry)?.slice(0, 60)}）`);
    // map 集合：对象键即主键；pack 新增时用条目的 id 字段作为对象键
    if (spec.map) {
        const value = entry.__pk ?? entry.id;
        if (typeof value !== 'string' && typeof value !== 'number') {
            throw new ContentError(`条目 #${index} 属于对象映射集合，但既无对象键也无 id（这条自带的键：${Object.keys(entry).join('/') || '无'}）`);
        }
        return String(value);
    }
    const value = spec.key ? entry[spec.key] : undefined;
    if (typeof value !== 'string' && typeof value !== 'number') {
        // 把"这一条到底有哪些键"打出来：一份内容集里通常登记了十几张表，
        // 只说"条目 #0 缺 item_id"没人知道是哪张表炸的（实测：赌石 rare_drops 里混着 {type:'ldc'} 那条就是这样）
        throw new ContentError(`条目 #${index} 缺少主键字段 ${spec.key}（这条自带的键：${Object.keys(entry).join('/')}）`
            + ' → 同一个池子里混了多种形状的条目时，别按其中一种的键登记，换一个每种都有的键（或只登记到父层 map）');
    }
    return String(value);
}

/** 把一组 add/override/remove 应用到一个集合 */
function applyOps({ dataset, collection, packId, baseEntries, spec, add = [], override = {}, remove = [], replace = false }) {
    if (replace) {
        if (!Array.isArray(add) || add.length === 0) {
            throw new ContentError(`pack ${packId}: ${dataset}.${collection} 声明 replace 但 add 为空`);
        }
        return add.map((entry, i) => ({ ...entry, __content_origin: packId, __pk: keyOf(entry, spec, i) }));
    }

    const entries = baseEntries.map(entry => ({ ...entry, __pk: keyOf(entry, spec, 0) }));
    const index = new Map(entries.map(entry => [entry.__pk, entry]));

    for (const [i, raw] of add.entries()) {
        const key = keyOf(raw, spec, i);
        if (index.has(key)) {
            throw new ContentError(
                `pack ${packId}: ${dataset}.${collection} 新增的 "${key}" 已存在。要修改既有内容请写 override，不要重复 add。`
            );
        }
        const entry = { ...raw, __content_origin: packId, __pk: key };
        entries.push(entry);
        index.set(key, entry);
    }

    for (const [key, patch] of Object.entries(override)) {
        const existing = index.get(key);
        if (!existing) {
            throw new ContentError(`pack ${packId}: ${dataset}.${collection} 要 override 的 "${key}" 不存在（id 拼错？）`);
        }
        if (!isPlainObject(patch)) throw new ContentError(`pack ${packId}: ${dataset}.${collection} override.${key} 必须是对象`);

        for (const [field, value] of Object.entries(patch)) {
            // 一层深合并：effect/bonuses 这类嵌套对象补字段而不是整块替换
            if (isPlainObject(value) && isPlainObject(existing[field])) {
                existing[field] = { ...existing[field], ...value };
            } else {
                /**
                 * 数组字段是整块替换。两片资料片改同一条目的同一个数组字段时，后合并的那片会把
                 * 前一片加进去的条目**整块吃掉**，而启动报告两边都显示成功（各 +N ~1）。
                 * 掉落表就是这个形状（一个怪一张表：drops 是数组、monster_id 是主键），
                 * 乱星海市舶与魔道血修遗篇各自 override 鲨鱼/妖魔时谁都不知道对方存在过。
                 * 与其等玩家的掉落莫名少一份，不如在启动期点名两片资料片让他们协调。
                 */
                const prior = (existing.__content_replaced_fields || {})[field];
                if (Array.isArray(value) && prior && prior !== packId) {
                    throw new ContentError(
                        `pack ${packId}: ${dataset}.${collection} 的 "${key}" 上，数组字段 "${field}" 已被资料片 ${prior} 整块替换过。`
                        + `两片各写各的会互相吞条目（现在这一份有 ${Array.isArray(existing[field]) ? existing[field].length : 0} 条），`
                        + '请改挂到别的条目上；确实要接手的话，把前一片的内容一起抄进来并写明为什么。'
                    );
                }
                existing[field] = value;
                if (Array.isArray(value)) {
                    existing.__content_replaced_fields = { ...(existing.__content_replaced_fields || {}), [field]: packId };
                }
            }
        }
        existing.__content_overridden_by = [...new Set([...(existing.__content_overridden_by || []), packId])];
    }

    const removed = new Set(remove.map(String));
    for (const key of removed) {
        if (!index.has(key)) {
            throw new ContentError(`pack ${packId}: ${dataset}.${collection} 要移除的 "${key}" 不存在`);
        }
    }
    return removed.size ? entries.filter(entry => !removed.has(entry.__pk)) : entries;
}

class ContentRegistry {
    /**
     * @param {Object} options
     * @param {string} [options.packDir]   资料片根目录，默认 server/content/packs
     * @param {string} [options.configPath] 基础数据目录，默认 server/config
     * @param {Object} [options.statRegistry] 属性注册中心；传入则合并后的 stat_definitions 会装入并校验
     */
    constructor(options = {}) {
        const serverRoot = path.join(__dirname, '..', '..');
        this.packDir = options.packDir || path.join(serverRoot, 'content', 'packs');
        this.configPath = options.configPath || path.join(serverRoot, 'config');
        this.statRegistry = options.statRegistry || null;

        this.packs = [];
        this.datasets = new Map();
        this.collectionStates = new Map(); // `${dataset}` -> 最终集合数组（含内部标记）
        this.report = { packs: [], merged: {}, warnings: [] };
        this._knownEffects = new Set();
        this._wildcards = new Set();
        this._effectVocabulary = [];
    }

    _loadBase(dataset) {
        const file = path.join(this.configPath, `${dataset}.json`);
        if (!fs.existsSync(file)) return null;
        try {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (error) {
            throw new ContentError(`基础数据集 ${dataset}.json 解析失败: ${error.message}`);
        }
    }

    /**
     * 某个集合在**基础配置**里有没有真条目（返回键数组；null = 这份内容集不是从磁盘装的，不判）。
     *
     * 为什么校验器要回头看基础而不是只看合并视图：集合登记成 `optional` 之后，
     * "这份内容压根没有这张表"与"表被资料片整块抹空"在合并视图里都是 `{}` ——
     * 只看合并视图会把"没用过这个机制"的合成夹具判成内容坏了（本轮实测一次红 7 条夹具）。
     * 而"基础有、合并没有"才是真事故（有人 replace/remove 掉了整张表），那一条必须抛。
     */
    _baseEntries(dataset, collectionPath) {
        if (!this.configPath) return null;
        let node = this._loadBase(dataset);
        for (const seg of String(collectionPath).split('.')) {
            if (!isPlainObject(node)) return null;
            node = node[seg];
        }
        return isPlainObject(node) ? entryKeys(node) : null;
    }

    /** 目录扫描发现资料片：新增 pack 不需要改任何注册代码 */
    discoverPacks() {
        this.packs = [];
        if (!fs.existsSync(this.packDir)) return this.packs;

        const dirNames = fs.readdirSync(this.packDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort();

        for (const dirName of dirNames) {
            const dir = path.join(this.packDir, dirName);
            const manifestFile = path.join(dir, 'pack.json');
            if (!fs.existsSync(manifestFile)) continue; // 无 manifest 视为未发布目录

            let manifest;
            try {
                manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
            } catch (error) {
                throw new ContentError(`pack ${dirName} 的 pack.json 解析失败: ${error.message}`);
            }
            if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
                throw new ContentError(`pack ${dirName}: pack.json 缺少 id`);
            }
            if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
                throw new ContentError(`pack ${manifest.id}: pack.json 缺少 version`);
            }
            if (manifest.id !== dirName) {
                throw new ContentError(`pack ${dirName}: manifest.id "${manifest.id}" 与目录名不一致`);
            }

            // 文件名即目标：<dataset>.json 写主集合，<dataset>__<collection>.json 写指定集合。
            // 有了后一种写法，一个资料片才能同时新增功法和神通（同一数据集的两个集合）。
            // 嵌套集合用多个段落表示（`spirit_beast_pvp_data__spirit_beast_pvp__tiers.json`
            // → 集合路径 spirit_beast_pvp.tiers），因为现网大玩法的条目数组普遍住在第二层。
            const files = fs.readdirSync(dir)
                .filter(name => name.endsWith('.json') && name !== 'pack.json')
                .map(name => name.replace(/\.json$/, ''))
                .sort()
                .map(key => {
                    const [dataset, ...path] = key.split('__');
                    return { key, dataset, collection: path.length ? path.join('.') : null };
                });

            this.packs.push({
                id: manifest.id,
                name: manifest.name || manifest.id,
                version: manifest.version,
                enabled: manifest.enabled !== false,
                depends: Array.isArray(manifest.depends) ? manifest.depends : [],
                priority: Number.isFinite(manifest.priority) ? manifest.priority : 100,
                files,
                datasets: [...new Set(files.map(file => file.dataset))],
                dir
            });
        }

        // priority 小的先合并，后者可覆盖前者；同优先级按 id 稳定排序
        this.packs.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
        return this.packs;
    }

    /** 构建全部数据集的合并视图并做启动期校验 */
    load() {
        this.report = { packs: [], merged: {}, warnings: [] };
        this.datasets = new Map();
        this.collectionStates = new Map();
        this.discoverPacks();

        const active = this.packs.filter(pack => pack.enabled);
        this._checkDepends(active);

        // 全部登记过的数据集都要产出视图（哪怕没有 pack 碰它），
        // 否则 ConfigLoader 回灌时会把基础内容整块丢掉
        const targets = new Set(Object.keys(DATASET_SPECS));
        for (const pack of active) for (const dataset of pack.datasets) targets.add(dataset);
        const ordered = [...targets].sort((a, b) => this._loadRank(a) - this._loadRank(b));
        for (const dataset of ordered) this._mergeDataset(dataset, active);

        this._refreshDerivedAndValidate();

        this.report.packs = this.packs.map(pack => ({
            id: pack.id, name: pack.name, version: pack.version,
            enabled: pack.enabled, priority: pack.priority,
            depends: pack.depends, datasets: pack.datasets, files: pack.files.map(file => file.key)
        }));
        return this.report;
    }

    /** stat_definitions / effect_vocabulary 必须先于其他数据集 */
    _loadRank(dataset) {
        if (dataset === 'stat_definitions') return 0;
        if (dataset === 'effect_vocabulary') return 1;
        return 2;
    }

    _checkDepends(active) {
        const present = new Set(active.map(pack => pack.id));
        for (const pack of active) {
            for (const dep of pack.depends) {
                if (!present.has(dep)) {
                    throw new ContentError(`pack ${pack.id} 依赖 ${dep}，但该 pack 不存在或未启用`);
                }
            }
        }
    }

    _mergeDataset(dataset, activePacks) {
        const spec = DATASET_SPECS[dataset];
        if (!spec) {
            const base = this._loadBase(dataset);
            if (base) this.datasets.set(dataset, base);
            for (const pack of activePacks) {
                if (pack.datasets.includes(dataset)) {
                    this.report.warnings.push(
                        `数据集 ${dataset} 未在 DATASET_SPECS 登记，pack ${pack.id} 中的同名内容未合并`
                    );
                }
            }
            return;
        }

        const baseData = this._loadBase(dataset);
        const primaryCollection = DEFAULT_COLLECTION(dataset);

        // 每个数据集可含多个集合；pack 文件用 "into" 指定目标集合，默认主集合
        const states = new Map();
        const bases = new Map();
        const passthroughs = new Map();
        for (const collection of Object.keys(spec.collections)) {
            if (!baseData) {
                states.set(collection, []);
                bases.set(collection, null);
                passthroughs.set(collection, {});
                continue;
            }
            const view = readCollection(dataset, baseData, collection);
            const viewSpec = spec.collections[collection];
            bases.set(collection, view.entries);
            passthroughs.set(collection, view.passthrough);
            states.set(collection, view.entries.map((entry, i) => ({ ...entry, __pk: keyOf(entry, viewSpec, i) })));
        }

        for (const pack of activePacks) {
            // 同一数据集可以拆成多个文件：<dataset>.json 写主集合，
            // <dataset>__<collection>.json 写指定集合（否则资料片无法既加功法又加神通）
            for (const file of pack.files.filter(entry => entry.dataset === dataset)) {
                const ops = this._readPackFile(pack, file);
                // 资料片文件的形状是"操作包"（add/override/remove/replace）或裸数组。
                // 写成 {"events": [...]} 这种"照着基础配置文件抄一份"的样子时，过去一个字都不合并、
                // 也不报错：内容层日志照样说这个 pack 装配成功。本轮写测试就正好踩在这上面，
                // 作者只会以为是合并规则坏了，所以这里直接拒。
                const hasOps = Array.isArray(ops.add)
                    || Object.keys(ops.override || {}).length > 0
                    || (ops.remove || []).length > 0 || ops.replace === true;
                if (!hasOps) {
                    throw new ContentError(
                        `pack ${pack.id}/${file.key}.json 里没有任何 add/override/remove/replace：这份内容一个字都不会被合并。`
                        + '整个文件就是条目列表请直接写裸数组，否则写 {"into": "<集合名>", "add": [ ... ]}。'
                    );
                }
                if (file.collection && ops.into && file.collection !== ops.into) {
                    throw new ContentError(
                        `pack ${pack.id}/${file.key}.json：文件名指向集合 "${file.collection}"，` +
                        `但内容里写了 into "${ops.into}"，两者必须一致`
                    );
                }
                const collection = file.collection || ops.into || primaryCollection;
                if (!spec.collections[collection]) {
                    throw new ContentError(`pack ${pack.id}/${file.key}.json 指定 into "${collection}"，但 ${dataset} 没有该集合`);
                }
                if (ops.dataset && ops.dataset !== dataset) {
                    throw new ContentError(`pack ${pack.id}/${file.key}.json 声明 dataset "${ops.dataset}" 与文件名不符`);
                }

                const next = applyOps({
                    dataset,
                    collection,
                    packId: pack.id,
                    baseEntries: states.get(collection),
                    spec: spec.collections[collection],
                    add: ops.add || [],
                    override: ops.override || {},
                    remove: ops.remove || [],
                    replace: ops.replace === true
                });
                states.set(collection, next);
                if (!Array.isArray(pack.mergedInto)) pack.mergedInto = [];
                if (!pack.mergedInto.includes(dataset)) pack.mergedInto.push(dataset);
            }
        }

        // 生成对外视图（去掉内部标记），并保留带标记版本供校验用
        this.collectionStates.set(dataset, states);
        const view = baseData === null && !activePacks.some(p => p.datasets.includes(dataset))
            ? null
            : this._composeView(dataset, baseData, primaryCollection, states, passthroughs);
        if (view !== null) this.datasets.set(dataset, view);

        const totalMerged = [...states.values()].reduce((sum, list) => sum + list.length, 0);
        const totalBase = [...bases.values()].reduce((sum, list) => sum + (list ? list.length : 0), 0);
        this.report.merged[dataset] = { base_count: totalBase, merged_count: totalMerged };
    }

    _readPackFile(pack, file) {
        const target = path.join(pack.dir, `${file.key}.json`);
        try {
            const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
            if (Array.isArray(parsed)) return { add: parsed }; // 允许裸数组：整包都是新增
            if (!isPlainObject(parsed)) throw new ContentError('内容文件既不是对象也不是数组');
            return parsed;
        } catch (error) {
            throw new ContentError(`pack ${pack.id} 的 ${file.key}.json 解析失败: ${error.message}`);
        }
    }

    _composeView(dataset, baseData, primaryCollection, states, passthroughs = new Map()) {
        const spec = DATASET_SPECS[dataset];
        const strip = (list) => list.map(entry => {
            const { __pk, ...rest } = entry;
            return rest;
        });

        let result = baseData;
        if (result === null) {
            const first = Object.keys(spec.collections)[0];
            result = spec.collections[first].root ? [] : setPath({}, first, []);
        }

        for (const collection of Object.keys(spec.collections)) {
            const collectionSpec = spec.collections[collection];
            const list = strip(states.get(collection) || []);
            if (collectionSpec.root) {
                result = list;
                continue;
            }
            result = setPath(result, collection, collectionSpec.map
                ? {
                    // map 集合：对象键即主键，_comment 之类原样带回
                    ...(passthroughs.get(collection) || {}),
                    ...Object.fromEntries((states.get(collection) || []).map(entry => {
                        const { __pk, ...rest } = entry;
                        return [__pk, rest];
                    }))
                }
                : list);
        }
        return result;
    }

    /** 带内部标记的集合条目（校验用） */
    _entriesWithMeta(dataset, collection) {
        const states = this.collectionStates.get(dataset);
        if (!states) return [];
        if (!collection) {
            return [...states.values()].flat();
        }
        return states.get(collection) || [];
    }

    _loadStatsIntoRegistry() {
        if (!this.statRegistry) return;
        const defs = this.dataset('stat_definitions')?.stats || [];
        this.statRegistry.reset();
        this.statRegistry.load(defs.map(def => ({ ...def })), 'content');
        this.statRegistry.validate();
    }

    _buildEffectVocabulary() {
        this._effectVocabulary = [];
        this._knownEffects = new Set();
        this._wildcards = new Set();
        const add = (effect) => {
            if (typeof effect.id !== 'string') return;
            this._knownEffects.add(effect.id);
            if (effect.wildcard === true) this._wildcards.add(effect.id);
            this._effectVocabulary.push({
                id: effect.id,
                label: effect.label || effect.description || effect.id,
                // ratio_pct：配置里存 0.05 这种倍率，前端要显示成 5%
                format: effect.format || null,
                wildcard: effect.wildcard === true
            });
        };
        BASE_EFFECT_VOCABULARY.forEach(add);
        // 资料片可注册新的物品效果（连同展示名），前端才不会出现"加了效果但卡片显示原始键名"
        for (const extra of this.dataset('effect_vocabulary')?.effects || []) add(extra);
    }

    /** 非属性类物品效果的展示名，供前端渲染物品卡 */
    effectVocabulary() { return this._effectVocabulary; }

    /**
     * 物品 effect 键校验：属性名拼错、或新属性忘了在 stat_definitions/pack 里声明，
     * 都在启动期报错。此前这类问题的表现是"装备上加了个字段但游戏里毫无效果"。
     */
    _validateItemEffects() {
        if (!this.statRegistry) return;
        const unknown = new Map();

        for (const item of this._entriesWithMeta('item_data', 'items')) {
            const effect = item.effect;
            if (!isPlainObject(effect)) continue;
            for (const [key, value] of Object.entries(effect)) {
                if (typeof value !== 'number') continue;
                if (this.isKnownEffectKey(key)) continue;
                if (!unknown.has(key)) unknown.set(key, []);
                unknown.get(key).push(item.id || item.__pk);
            }
        }

        if (unknown.size) {
            const detail = [...unknown.entries()]
                .map(([key, items]) => `${key} (出现在 ${items.slice(0, 3).join(', ')}${items.length > 3 ? ` 等 ${items.length} 项` : ''})`)
                .join('; ');
            throw new ContentError(
                `物品 effect 含未登记的属性键: ${detail}。` +
                `请在 stat_definitions.json（或资料片）声明该属性，或在 effect_vocabulary.json 登记为非属性效果。`
            );
        }
    }

    /**
     * 五行属性名校验：功法/神通的 element 是拿去和玩家灵根比对的字符串，
     * 拼错（例如把"金"写成 gold）不会报错，只会让契合/相克永远不命中——
     * 现网就因此静默失效过一整条机制，所以这里在启动期直接拒收。
     * 灵兽的 element 属于另一套自洽词表（spirit_beast_data.elements，含 dark），
     * 不与玩家灵根比对，因此不在此校验范围内。
     */
    _validateElements() {
        // 读**合并视图**而不是 config 原件：spirit_roots 登记成了集合，资料片加一种灵根
        // 就是想让"它的 element 也进这套词表"。只看基础文件会让"新灵根 + 用它的新功法"这种
        // 合法组合在启动期被误拒（而拒的是校验自己跟不上内容）。
        const roleInit = this.datasets.get('role_init');
        const rootTypes = new Set((roleInit?.spirit_roots || [])
            .filter(root => root && typeof root === 'object' && !root.__content_removed)
            .map(root => root.type).filter(Boolean));
        if (!rootTypes.size) return; // 读不到灵根表时不拦，交给 SpiritRoot 自身的降级路径

        const bad = [];
        for (const collection of ['techniques', 'skills']) {
            for (const entry of this._entriesWithMeta('technique_data', collection)) {
                const element = entry.element;
                if (element === undefined || element === null) continue;
                if (element === 'none' || rootTypes.has(element)) continue;
                bad.push(`${collection}.${entry.__pk || entry.name}="${element}"`);
            }
        }
        if (bad.length) {
            throw new ContentError(
                `功法/神通的 element 含未知灵根名: ${bad.join(', ')}。` +
                `可用值只有 role_init.spirit_roots[].type（${[...rootTypes].join('/')}）加 'none'。`
            );
        }
    }

    /**
     * 五行相克表（technique_data.element_match.conflicts）在**合并视图**上校验。
     *
     * 这张表登记成集合之后，资料片能给自己新增的灵根配一条相克；但配错和以前一样静默：
     *   · 键写错（玩家身上永远不会出现那个 type）→ 这条克制永不触发；
     *   · 值写错（功法 element 只可能取 spirit_roots[].type）→ 同样是死配置；
     *   · 形状只认裸数组时，资料片写的 `{id,counters:[...]}` 会被 `Array.isArray` 直接丢掉 ——
     *     于是"新灵根只能契合、不能相克"，而表看起来是配齐的。
     */
    _validateElementMatch() {
        const roleInit = this.datasets.get('role_init');
        const types = new Set((roleInit?.spirit_roots || [])
            .filter(root => root && typeof root === 'object' && root.type).map(root => root.type));
        const conflicts = this.datasets.get('technique_data')?.element_match?.conflicts;
        if (!types.size || !isPlainObject(conflicts)) return;

        const errors = [];
        for (const [root, raw] of Object.entries(conflicts)) {
            if (root.startsWith('_')) continue;
            if (root !== 'none' && !types.has(root)) {
                errors.push(`element_match.conflicts.${root} 不是 role_init.spirit_roots[].type → `
                    + `玩家身上永远不会有这条灵根，整条克制是死配置（可用键：${[...types].join('/')}）`);
            }
            const targets = contentList(raw);
            if (!targets.length) {
                errors.push(`element_match.conflicts.${root} 的值是空列表或 contentList 认不出的形状`
                    + `（${JSON.stringify(raw)}）→ 这条什么都不克，配了等于没配`);
            }
            for (const target of targets) {
                if (typeof target !== 'string' || (target !== 'none' && !types.has(target))) {
                    errors.push(`element_match.conflicts.${root} 克的 ${JSON.stringify(target)} 不是任何灵根 type `
                        + `→ 功法的 element 只能取这些值，所以这一条永远不会命中`);
                }
            }
        }
        if (errors.length) throw new ContentError(`五行相克表校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 功法品阶表（technique_data.grades）在**合并视图**上校验。
     *
     * 为什么单独一道（2026-09-22，与登记成集合同一天）：`TechniqueService.getGradeConfig` 是这张表
     * 唯一的读取口，12 处消费全部写成 `Number(gradeCfg.<字段>) || 兜底`，而 `getRequiredProficiency`
     * 在**查不到品阶**时直接 `return Infinity`。于是资料片加得了新功法、加不了它所属的那一档品阶，
     * 写一个表里没有的 grade 就得到一部"熟练度永远够不着阈值、永远突破不了一层"的功法，
     * 界面上品阶徽章与颜色双双为空/退回默认 —— 启动、测试、探针一路全绿。
     * 判两件事：① 每一档品阶的六个被读字段必须齐且合法（缺一个就是一条静默兜底）；
     * ② 每一部功法（含资料片）的 `grade` 必须查得到 —— 现网 12 部 + 4 片全部对得上，所以硬拦零爆炸半径。
     *
     * `order` 字段没有任何代码读（品阶顺序靠键序），已记进 sourceLedgers 的死字段账，这里不校验它。
     */
    _validateTechniqueGrades() {
        const data = this.datasets.get('technique_data');
        const techniques = data?.techniques;
        if (!isPlainObject(techniques) || !entryKeys(techniques).length) return;
        const grades = data.grades;
        // "这份内容集到底用不用品阶机制"要问基础配置，不能问合并视图：集合登记成 optional 之后，
        // "文件里没这张表"和"表是空的"在合并视图里都是 `{}`，只按合并视图判会让每一支只塞了 techniques
        // 的合成夹具都报"grade 不存在"（本轮真红过 4 条夹具）。基础表存在而合并视图空 = 被谁整块抹了，那才要抛。
        const baseGrades = this._baseEntries('technique_data', 'grades');
        if (!baseGrades || !baseGrades.length) return;
        if (!isPlainObject(grades) || !entryKeys(grades).length) {
            throw new ContentError(`grades 品阶表在基础配置里有 ${baseGrades.length} 档，合并视图里却是空的 `
                + `→ 每一部功法的品阶数值全部走兜底：熟练度阈值 Infinity（一层都突破不了）、突破率 0.5、`
                + `修炼消耗系数 1、面板品阶徽章与颜色空白。成因通常是某份资料片把这张表整块 replace/remove 掉了`);
        }

        const REQUIRED = {
            name: [v => typeof v === 'string' && v.trim() !== '', '出参 grade_name 取它 → 面板品阶徽章是空的'],
            color: [v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v), '出参 grade_color 取它 → 面板退回默认色，看不出品阶'],
            max_layer: [v => Number.isInteger(v) && v >= 1, '`Number(...) || 9` 兜底 → 这一档实际按 9 层封顶'],
            attr_coefficient: [v => Number.isFinite(v) && v > 0, '`|| 1` 兜底 → 每层加成与修炼消耗都按无品阶算'],
            breakthrough_base_rate: [v => Number.isFinite(v) && v > 0 && v <= 1, '`|| 0.5` 兜底 → 突破率与品阶无关'],
            proficiency_per_layer: [v => Number.isFinite(v) && v > 0, '`|| 100` 兜底 → 熟练度阈值与黄阶同档']
        };
        const errors = [];
        const known = entryKeys(grades);

        for (const key of known) {
            const cfg = grades[key];
            if (!isPlainObject(cfg)) {
                errors.push(`grades.${key} 不是对象 → map 集合的条目必须是可以逐键 override 的对象，`
                    + `写成字符串等于这一档一旦被资料片覆盖就整块没了`);
                continue;
            }
            for (const [field, [ok, why]] of Object.entries(REQUIRED)) {
                if (!ok(cfg[field])) {
                    errors.push(`grades.${key}.${field} 缺失或非法（${JSON.stringify(cfg[field])}）→ ${why}`);
                }
            }
        }
        for (const [id, tech] of Object.entries(data.techniques || {})) {
            if (id.startsWith('_') || !isPlainObject(tech)) continue;
            if (typeof tech.grade !== 'string' || tech.grade === '') {
                errors.push(`techniques.${id} 没有 grade → getGradeConfig 拿 undefined 查，`
                    + `这部功法的所有品阶相关数值都走兜底`);
                continue;
            }
            if (!known.includes(tech.grade)) {
                errors.push(`techniques.${id} 的 grade "${tech.grade}" 不在 grades 表里（现有 ${known.join('/')}）`
                    + `→ getRequiredProficiency 直接返回 Infinity：熟练度永远够不着阈值、一层都突破不了，`
                    + `而界面品阶徽章是空的。要么补这一档品阶（资料片可写 technique_data__grades.json），要么改引用`);
            }
        }
        if (errors.length) throw new ContentError(`功法品阶表校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 钓鱼的两张新登记表（fish_pools / rare_material_pools）与渔场的引用完整性。
     *
     * 为什么必须配这一道（登记成集合的当天就要写，理由见 §9 那一族的教训）：
     *   · `FishingService:906` 读的是 `this._config.fish_pools[pond.fish_pool].empty_weight`
     *     —— **没有兜底**，资料片把 `fish_pool` 指到一个不存在的池，玩家起竿那一刻结算直接 TypeError（500）；
     *   · `rare_material_pools[...]` 那一头有 `if (materialPool && …)` 兜底，于是错键的表现是
     *     "这个渔场永远不出稀有材料"，一声不响（同 §31 称号、§30 reward 键那一族）。
     * 两条都在合并视图上判，所以资料片自己写的渔场与鱼池一起进同一张账。
     */
    _validateFishingPonds() {
        const data = this.datasets.get('fishing_data');
        if (!isPlainObject(data)) return;
        const ponds = data.ponds;
        const pools = data.fish_pools;
        if (!isPlainObject(ponds) || !entryKeys(ponds).length) return;
        // 与 _validateTechniqueGrades 同一条口径：合不合并得起来问基础配置，
        // 否则只塞 ponds 的合成夹具会被 optional 集合回吐的 `{}` 误判成"表被抹了"。
        const basePools = this._baseEntries('fishing_data', 'fish_pools');
        if (!basePools || !basePools.length) return;
        if (!isPlainObject(pools) || !entryKeys(pools).length) {
            throw new ContentError(`fish_pools 渔获表在基础配置里有 ${basePools.length} 口，合并视图里却是空的 → `
                + `FishingService 起竿时读的是 fish_pools[pond.fish_pool].empty_weight，那一行没有兜底，玩家一竿下去就是 500`);
        }

        const errors = [];
        const poolKeys = entryKeys(pools);
        const rareKeys = entryKeys(data.rare_material_pools || {});

        for (const [key, pool] of Object.entries(pools)) {
            if (key.startsWith('_')) continue;
            if (!isPlainObject(pool)) {
                errors.push(`fish_pools.${key} 不是对象 → map 集合条目被资料片 override 时会整块丢掉`);
                continue;
            }
            const empty = Number(pool.empty_weight);
            if (!Number.isFinite(empty) || empty < 0 || empty > 100) {
                errors.push(`fish_pools.${key}.empty_weight = ${JSON.stringify(pool.empty_weight)} 不是 0~100 的百分比`
                    + `→ 代码按 \`empty_weight / 100\` 当空竿率用，>100 会让这个池永远钓不到鱼`);
            }
            if (!Array.isArray(pool.fishes) || !pool.fishes.length) {
                errors.push(`fish_pools.${key}.fishes 是空的或不是数组 → _rollFish 一律返回 null，这个池只有空竿`);
                continue;
            }
            for (const [i, fish] of pool.fishes.entries()) {
                if (!isPlainObject(fish) || typeof fish.id !== 'string' || !fish.id) {
                    errors.push(`fish_pools.${key}.fishes[${i}] 没有 id → 钓上来的鱼无法入包、也无法显示名字`);
                } else if (!(Number(fish.weight) > 0)) {
                    errors.push(`fish_pools.${key}.fishes[${i}]（${fish.id}）的 weight 不是正数 → 权重抽样的分母里它等于不存在`);
                }
            }
        }
        for (const [key, pool] of Object.entries(data.rare_material_pools || {})) {
            if (key.startsWith('_')) continue;
            if (!isPlainObject(pool) || !Array.isArray(pool.items) || !pool.items.length) {
                errors.push(`rare_material_pools.${key}.items 不是非空数组 → 这个稀有池一条都发不出`);
                continue;
            }
            const chance = Number(pool.chance_per_success);
            if (!Number.isFinite(chance) || chance < 0 || chance > 1) {
                errors.push(`rare_material_pools.${key}.chance_per_success = ${JSON.stringify(pool.chance_per_success)} `
                    + `不是 0~1 的比率（代码直接把它交给 Math.random）`);
            }
        }
        for (const [key, pond] of Object.entries(ponds)) {
            if (key.startsWith('_') || !isPlainObject(pond)) continue;
            if (typeof pond.fish_pool !== 'string' || !poolKeys.includes(pond.fish_pool)) {
                errors.push(`ponds.${key}.fish_pool = ${JSON.stringify(pond.fish_pool)} 在 fish_pools 里查不到`
                    + `（现有 ${poolKeys.join('/')}）→ 玩家在这个渔场起竿时读 undefined.empty_weight，服务端抛 TypeError（500）`);
            }
            if (pond.rare_material_pool != null && !rareKeys.includes(pond.rare_material_pool)) {
                errors.push(`ponds.${key}.rare_material_pool = ${JSON.stringify(pond.rare_material_pool)} 查不到`
                    + `（现有 ${rareKeys.join('/') || '无'}）→ 那一头有兜底，所以表现是这个渔场永远不出稀有材料，不报错`);
            }
        }
        if (errors.length) throw new ContentError(`钓鱼内容校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 校验"内容里用到的属性键"时该问哪个注册中心。
     *
     * 为什么不是直接问 `this.statRegistry`：注册中心是**注入**的，测试与脚本里常见两种坏状态 ——
     * 压根没注入（null），或注入了一个刚 new 出来、还没装入任何定义的（`has('atk')` 一律 false）。
     * 后者会把整条属性键校验变成"全表都是非法键"，报错看着像内容坏了，其实是没人跑过启动流程。
     * 所以：注入了且已装入 → 用注入的（含资料片追加的属性）；否则退回 `ensureStatRegistryLoaded()`，
     * 它按同一个来源（config/stat_definitions.json）兜底，已装入时是 no-op。
     */
    _statRegistryForValidation() {
        if (this.statRegistry?.isLoaded) return this.statRegistry;
        const { ensureStatRegistryLoaded } = require('../stats');
        return ensureStatRegistryLoaded();
    }

    /**
     * 新建角色抽灵根的概率表与灵根声明是否对得上。
     *
     * 为什么单独一道：抽的是 spiritRootProbabilities 的**中文键**，声明的是 spirit_roots 的
     * name/type，两套键之间以前没有任何校验。于是两种错都只会静默发生：
     *   ① 键写错（或灵根改名了概率表没跟着改）→ 那一档概率白给，玩家永远抽不到这条灵根；
     *   ② 加了灵根（ bonuses 也配了）却忘了给概率 → 内容层看起来齐全，实际不可获得。
     * ① 直接拒；② 只警告，因为"先声明后开放"也可能是有意的节奏。
     */
    _validateSpiritRootRoll() {
        // 合并视图：资料片加的灵根/概率/加成必须一起被判，否则"片加了灵根却漏了概率"这种正好漏掉
        const roleInit = this.datasets.get('role_init');
        const declared = (roleInit?.spirit_roots || []).filter(r => r && typeof r === 'object' && r.name);
        const probabilities = roleInit?.spiritRootProbabilities || {};
        const bonuses = roleInit?.spiritRootBonuses || {};
        if (!declared.length) return;

        const names = declared.map(r => r.name);
        const keys = (dict) => Object.keys(dict || {}).filter(k => !k.startsWith('_'));
        const errors = [];

        const unknown = keys(probabilities).filter(key => !names.includes(key));
        if (unknown.length) {
            errors.push(`spiritRootProbabilities 含未声明的灵根名: ${unknown.join('/')}。`
                + `可用键只有 spirit_roots[].name（${names.join('/')}）—— 写错的这一档谁也抽不到。`);
        }
        const unknownBonus = keys(bonuses).filter(key => !names.includes(key));
        if (unknownBonus.length) {
            errors.push(`spiritRootBonuses 含未声明的灵根名: ${unknownBonus.join('/')} → 这份加成永远用不上，`
                + '而看起来"灵根配齐了"（要真加灵根得同时往 spirit_roots 里声明一条）');
        }

        // 概率值：走 contentNumber —— 资料片经 map 集合加的条目是 `{id,value}` 对象，
        // 抽卡处如果只认裸数字，`+= 对象` 会算成 NaN，整池权重一起坏掉（不只是那一条抽不到）。
        for (const name of keys(probabilities)) {
            const value = contentNumber(probabilities[name], NaN);
            if (!Number.isFinite(value) || value <= 0) {
                errors.push(`spiritRootProbabilities.${name} 不是正数（${JSON.stringify(probabilities[name])}）`
                    + ' → 权重会被算成 NaN，抽池退化成"永远抽到第一个"');
            }
        }

        // "声明了却没概率"以前只 warn（因为可能是有意的节奏）。现在必须留痕：
        // 要么给概率，要么显式 `roll_enabled:false`。二者都没写的，就是"内容看起来齐全、实际不可获得"。
        const silent = declared.filter(r => !(r.name in probabilities) && r.roll_enabled !== false);
        if (silent.length) {
            errors.push(`灵根 ${silent.map(r => r.name).join('/')} 在 spirit_roots 里声明了（bonus 也配了），`
                + '却没进 spiritRootProbabilities，也没标 roll_enabled:false → 新建角色永远抽不到它。'
                + '要"先声明后开放"就写 `"roll_enabled": false`，要开放就给概率');
        }
        for (const root of declared) {
            if (root.roll_enabled === false && root.name in probabilities) {
                errors.push(`灵根 ${root.name} 同时标了 roll_enabled:false 与概率 → 到底开不开？两边必须一致`);
            }
        }
        // 全关掉 = 建号时没有可选灵根（rollSpiritRoot 会返回 null、号上干脆没灵根，
        // 那是配置坏掉的样子，不该静默）—— 判据直接问抽卡用的同一个池子定义，不在这里重述一遍规则
        const { spiritRootRollPool } = require('../stats/SpiritRoot');
        if (!spiritRootRollPool(roleInit).length) {
            errors.push(`spirit_roots 里一条"可抽"的灵根都没有（要么给 spiritRootProbabilities 加权重，要么别标 roll_enabled:false）`
                + ` → 新建角色将无法获得任何灵根加成`);
        }

        // 加成键必须是注册表里的属性：写错不会报错，只会"抽到这条灵根等于白抽"
        const statRegistry = this._statRegistryForValidation();
        for (const root of declared) {
            const entry = bonuses[root.name];
            if (!entry || typeof entry !== 'object') {
                errors.push(`灵根 ${root.name} 在 spiritRootBonuses 里没有加成条目 → 抽到它等于白抽`);
                continue;
            }
            const bad = Object.entries(entry)
                .filter(([key, value]) => !key.startsWith('_') && !['id', 'label', 'comment'].includes(key)
                    && typeof value === 'number' && !statRegistry.has(key))
                .map(([key, value]) => `${key}=${value}`);
            if (bad.length) {
                errors.push(`spiritRootBonuses.${root.name} 用了注册表里没有的属性键：${bad.join(', ')} `
                    + `→ 这一档加成不会进面板也不会进战斗（合法键见 config/stat_definitions.json）`);
            }
        }

        if (errors.length) throw new ContentError(`灵根词表/概率/加成校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 洞府药园每条灵种的 seed_id 必须是一件真物品。
     * GardenService.plant 直接拿 seed_id 去 removeItem(playerId, seed_id, 1) ——
     * 对不上时的表现是"药园里明明列着这一味，玩家点下去永远提示种子不足"，既不报错也不提示。
     */
    _validateGardenSeeds() {
        const seeds = this.dataset('cave_data')?.cave?.garden?.seeds;
        if (!Array.isArray(seeds) || !seeds.length) return;
        const itemIds = new Set((this.dataset('item_data')?.items || []).map(i => String(i.id)));
        if (!itemIds.size) return;
        const bad = seeds.filter(s => !itemIds.has(String(s.seed_id))).map(s => s.seed_id || '(缺 seed_id)');
        if (bad.length) {
            throw new ContentError(
                `洞府药园灵种的 seed_id 不是真物品（种植时按 seed_id 扣背包）: ${bad.join('/')}。`
                + '请在 item_data 补一件同名物品，或把 seed_id 改成已有种子的 item_key。'
            );
        }
    }

    /**
     * 采集节点与资源表必须**双向**对得上（2026-09-22 实测现网 11↔11 全对上，所以直接硬拦不会误伤）。
     *
     * 地图上的 `map_data.maps[].resources[].id` 是 GatheringService 拿去查
     * `resource_data.resource_yields[].resource_id` 的键，两边各断一次的表现都不一样但都不响：
     *   · 节点有、资源表没有 → 玩家点了采集什么都采不到（这一头以前连物品引用深扫都不认，因为它叫 `id`）；
     *   · 资源表有、没有一张地图挂它 → 这一味资源**永远采不到**（"内容配了但玩家拿不到"的标准形状）。
     */
    _validateGatheringNodes() {
        const maps = this.dataset('map_data')?.maps;
        const yields = this.dataset('resource_data')?.resource_yields;
        if (!Array.isArray(maps) || !maps.length || !Array.isArray(yields) || !yields.length) return;

        const yieldIds = new Set(yields.map(y => String(y.resource_id)));
        const nodeIds = new Set(maps.flatMap(m => (m.resources || []).map(r => String(r.id))));
        const errors = [];
        const orphans = [...nodeIds].filter(id => !yieldIds.has(id));
        if (orphans.length) {
            errors.push(`map_data 的采集节点在 resource_data.resource_yields 里没有定义：${orphans.join('/')} `
                + '→ 玩家点这一格只会"什么都没采到"（采集按 resource_id 查产出表）');
        }
        const unreachable = [...yieldIds].filter(id => !nodeIds.has(id));
        if (unreachable.length) {
            errors.push(`resource_data 定义了但没有任何一张地图挂的资源：${unreachable.join('/')} `
                + '→ 这一味永远采不到，只能从别处发（要开放就在地图上挂节点）');
        }
        if (!nodeIds.size) {
            errors.push('map_data 里一个采集节点都没有，而资源表有 0 条可采 → 采集玩法整体不可用');
        }
        if (errors.length) throw new ContentError(`采集资源链校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 历练事件的 type 必须先在 event_types 里声明。
     * selectEventType 只按 event_types 的 weight 抽类型，没声明的那一类永远不会被抽到 ——
     * 资料片加了新事件却忘了加类型，表现就是"内容装进来了，玩家一辈子碰不到"，而且两头都不报错。
     */
    _validateAdventureEvents() {
        const data = this.dataset('adventure_event_data');
        const events = data?.events;
        if (!Array.isArray(events) || !events.length) return;
        const types = data.event_types || {};
        if (!Object.keys(types).length) {
            throw new ContentError(
                'adventure_event_data 有事件却没有 event_types —— 类型表决定抽不抽得到这一类、'
                + '标题叫什么、AI 事件给多少保底经验，缺它等于历练发不出事件。'
            );
        }
        const unknown = events.filter(e => !types[e.type]).map(e => `${e.id}="${e.type}"`);
        if (unknown.length) {
            throw new ContentError(
                `历练事件的 type 没在 adventure_event_data.event_types 里声明: ${unknown.join(', ')}。`
                + `已声明的类型：${Object.keys(types).join('/') || '(一个都没有)'}。`
            );
        }
        // rewards.items 只认"物品键数组"这一种形状。服务里写的是 `if (items && Array.isArray(items))`，
        // 所以 `items: true` 这类配置等于"承诺发东西、永远不发"，两头都不报错（现网 combat_1 就是这样一条）。
        const itemIds = new Set((this.dataset('item_data')?.items || []).map(i => String(i.id)));
        const badShape = [];
        const unknownItems = [];
        for (const e of events) {
            const it = e?.rewards?.items;
            if (it === undefined || it === null) continue;
            if (!Array.isArray(it)) { badShape.push(`${e.id}=${JSON.stringify(it)}`); continue; }
            for (const k of it) if (!itemIds.has(String(k))) unknownItems.push(`${e.id}:${k}`);
        }
        if (badShape.length) {
            throw new ContentError(
                `历练事件的 rewards.items 必须是物品键数组，现在是 ${badShape.join(', ')}。`
                + '写 true/字符串都会被服务当"没有物品"静默跳过；战斗掉落走 drop_data，不填这个键就行。'
            );
        }
        if (unknownItems.length) {
            throw new ContentError(
                `历练事件引用了 item_data 里不存在的物品: ${unknownItems.join(', ')}。`
                + '背包里只会留下一条查不出名字的裸 id，等于没发；请在 item_data 补同名物品或改掉引用。'
            );
        }
        const unreachable = Object.entries(types)
            .filter(([, cfg]) => !(Number(cfg?.weight) > 0))
            .map(([id]) => id);
        if (unreachable.length) {
            console.warn(
                `[ContentRegistry] 历练事件类型 ${unreachable.join('/')} 的 weight 不是正数 —— 这一类永远不会被抽到。`
                + `若这是"先声明后开放"可以忽略本条。`
            );
        }
    }

    /**
     * 神通 effects 键校验。这些键过去无人消费（配了也只是文案），现在有 CombatResolver
     * 的战斗特效与功法属性折叠两条落地路径，所以拼错的键必须启动期失败，
     * 而不是像以前那样"领悟了一条永远不触发的大招"。
     */
    _validateSkillEffects() {
        const unknown = [];
        const unregistered = [];
        for (const entry of this._entriesWithMeta('technique_data', 'skills')) {
            if (!isPlainObject(entry.effects)) continue;
            for (const [key, value] of Object.entries(entry.effects)) {
                if (!isKnownSkillEffectKey(key)) {
                    unknown.push(`${entry.__pk}.${key}`);
                    continue;
                }
                const statSpec = SKILL_STAT_EFFECTS[key];
                if (statSpec && this.statRegistry && !this.statRegistry.has(statSpec.stat)) {
                    unregistered.push(`${entry.__pk}.${key}→${statSpec.stat}`);
                }
                const num = Number(value);
                if (!Number.isFinite(num)) unknown.push(`${entry.__pk}.${key}=${value}`);
            }
        }
        if (unknown.length || unregistered.length) {
            const vocab = skillEffectVocabulary();
            throw new ContentError(
                `神通 effects 校验失败：` +
                (unknown.length ? `未知特效键 ${unknown.join(', ')}；` : '') +
                (unregistered.length ? `目标属性未注册 ${unregistered.join(', ')}；` : '') +
                `可用键：${vocab.trigger} / 属性类 ${vocab.stats.join('/')} / 战斗类 ${vocab.procs.join('/')}` +
                `（数值一律用小数，0.15 表示 15%）。`
            );
        }
    }

    _validateReferences() {
        const errors = [];
        for (const ref of REFERENCES) {
            const spec = DATASET_SPECS[ref.dataset]?.collections?.[ref.collection];
            if (!spec) continue;
            const targetEntries = this._entriesWithMeta(ref.target, DEFAULT_COLLECTION(ref.target));
            const targetSpec = DATASET_SPECS[ref.target].collections[DEFAULT_COLLECTION(ref.target)];
            const targetKeys = new Set(targetEntries.map((entry, i) => keyOf(entry, targetSpec, i)));

            for (const entry of this._entriesWithMeta(ref.dataset, ref.collection)) {
                const candidates = ref.nested && Array.isArray(entry[ref.nested]) ? entry[ref.nested] : [entry];
                for (const candidate of candidates) {
                    if (!isPlainObject(candidate)) continue;
                    const value = candidate[ref.field];
                    if (value === undefined || value === null) continue;
                    if (!targetKeys.has(String(value))) {
                        errors.push(`${ref.dataset}.${ref.collection} 引用了不存在的 ${ref.target} 条目 "${value}"`);
                    }
                }
            }
        }
        if (errors.length) {
            throw new ContentError(`内容引用完整性校验失败:\n  - ${[...new Set(errors)].join('\n  - ')}`);
        }
    }

    /**
     * 掉落表指向的怪，必须是某张地图上真会刷出来的怪。
     *
     * 为什么单独一道：既有的掉落校验只管"item_id 存不存在"，于是资料片自己新造一个 monster_id
     * 时全部通过，而那张掉落表永远不会触发——内容加了，玩家一件也拿不到，且没有任何地方报错。
     * 这是"静默不生效"里最难发现的一类，只能靠这道闸。
     */
    _validateDropMonsters() {
        const maps = this.dataset('map_data')?.maps || {};
        const spawnable = new Set();
        for (const map of Object.values(maps)) {
            for (const monster of (map?.monsters || [])) {
                const id = typeof monster === 'string' ? monster : (monster?.id || monster?.monster_id);
                if (id) spawnable.add(id);
            }
        }
        // 只喂了部分数据集的单元测试里地图数据可能整个缺席，这时不做判定（宁可漏判也不误伤）
        if (!spawnable.size) return;

        const orphans = [];
        for (const entry of this._entriesWithMeta('drop_data', 'drops')) {
            if (entry?.monster_id && !spawnable.has(entry.monster_id)) orphans.push(entry.monster_id);
        }
        if (orphans.length) {
            throw new ContentError(
                `掉落表指向了地图上不会刷出的怪：${[...new Set(orphans)].join(', ')}。`
                + '这些掉落永远不会发生——请把掉落挂到已有的怪上，或在某张地图的 monsters 里真的把它加进去。'
            );
        }
    }

    /**
     * 灵兽的 element 是另一套自洽词表（spirit_beast_data.elements，不与玩家灵根比对），
     * 以前 _validateElements 只管功法/神通，灵兽这一半没人查。
     *
     * 为什么单独一道：拼错的元素名不会报错，只会有两个静默后果 ——
     * ① 图鉴 `elements[bt.element]?.name || bt.element` 退回原始键（玩家看到 "thunder"），
     * ② `SpiritBeastService.getElementMultiplier` 第一句就是 `if (!attacker) return normal`，
     *    于是这只灵兽在兽斗里**永远中性**，既不克人也不被克 —— 配了雷属的雷音神兽其实没有五行。
     * 顺带查 strong_against/weak_against 指向的元素是否声明过：那两处同样只在查得到时才生效。
     * 现网 fanren_legacy 的 ti_hun 就是这一类（element 写 thunder，而灵兽词表只有五行），
     * 所以本轮同时把 elements 登记成 map 集合 —— 资料片从此能自己补一档灵兽属性，不必改代码。
     */
    _validateBeastElements() {
        const elements = this.datasets.get('spirit_beast_data')?.elements;
        if (!isPlainObject(elements) || !Object.keys(elements).length) return;   // 只喂部分数据集的测试里可能整个缺席

        const declared = new Set(Object.keys(elements));
        const problems = [];
        for (const beast of this._entriesWithMeta('spirit_beast_data', 'beast_types')) {
            const element = beast?.element;
            if (element === undefined || element === null || element === '') continue;   // 没写 = 无属性，合法
            if (!declared.has(String(element))) {
                problems.push(`${beast.__pk || beast.beast_key}.element="${element}" 不在灵兽属性词表里（可用：${[...declared].join('/')}）—— 图鉴会印原始键，兽斗里它永远中性`);
            }
        }
        for (const [key, def] of Object.entries(elements)) {
            for (const field of ['strong_against', 'weak_against']) {
                const target = def?.[field];
                if (target === undefined || target === null || target === '') continue;
                if (!declared.has(String(target))) {
                    problems.push(`elements.${key}.${field}="${target}" 没有这一档灵兽属性（相克关系永远匹配不上）`);
                }
            }
        }
        if (problems.length) {
            throw new ContentError(`灵兽属性词表校验失败:\n  - ${[...new Set(problems)].join('\n  - ')}`);
        }
    }

    /**
     * 灵兽稀有度词表（`spirit_beast_data.rarity_config`）+ 它的两张伴生表。
     *
     * 这道闸是本轮"把词表开放给资料片"的另一半：登记成集合只保证**加得进来**，
     * 而这一族的每个缺口都不报错，只是算错钱：
     *   · 灵兽写一个词表里没有的档位 → 图鉴/列表把裸键印给人（`?.name || key`），
     *     放生返还回落 0.2、升星倍率回落 1.0（= common 那一档）→ **越稀有的灵兽升星越便宜**，方向是反的；
     *   · 词表加了档、`star_upgrade.rarity_cost_multiplier` 没加 → 同上，而且倍率表读不到就是 1.0，
     *     没有任何日志。这就是 §16/§17/品阶 grades 那三次"登记了一半"的同一个形状，
     *     所以本轮把三格一起登记（词表 / 倍率表 / 升星消耗表），并在这里互相对账；
     *   · 少写 `order` → `rarityRank` 没有依据，图鉴与统计的档位顺序变成 Object.keys 的写入顺序，
     *     热更一次就可能换一种排法（品质词表那条同一判据，见 `_validateItemQualities`）。
     * 现网实测：四档 common/rare/epic/legendary 全部有名有色有 order、倍率表逐档齐全、
     * 7 只灵兽（含 fanren_legacy / mo_da_blood_sutra 加的）都指向已登记档 → 这道闸不误伤现有内容。
     */
    _validateBeastRarity() {
        const config = this.datasets.get('spirit_beast_data');
        // "这份内容集到不到底用不用稀有度机制"要问基础配置：集合登记成 optional 之后，
        // "文件里没这张表"和"表被资料片整块抹了"在合并视图里都是 `{}`（同一族坑见 `_validateTechniqueGrades`）。
        const baseRarities = this._baseEntries('spirit_beast_data', 'rarity_config');
        if (!baseRarities || !baseRarities.length) return;
        const dict = config?.rarity_config;
        const keys = isPlainObject(dict) ? Object.keys(dict).filter(k => !k.startsWith('_')) : [];
        if (!keys.length) {
            throw new ContentError(`rarity_config 在基础配置里有 ${baseRarities.length} 档，合并视图里却是空的`
                + ' → 每一只灵兽的档名与配色全部走兜底（图鉴印裸键、卡片没有颜色、放生返还按 0.2、升星倍率按 1.0）。'
                + '成因通常是某份资料片把这张表整块 replace/remove 掉了');
        }

        const errors = [];
        const declared = new Set(keys);
        const orders = new Map();
        const multipliers = config?.star_upgrade?.rarity_cost_multiplier;
        if (!isPlainObject(multipliers)) {
            errors.push('star_upgrade.rarity_cost_multiplier 不存在或不是对象 → 每档升星消耗倍率全部回落 1.0，'
                + `词表里的 ${keys.join('/')} 在消耗上没有任何区别（"越稀有越贵"这条设计失效）`);
        }

        for (const key of keys) {
            const entry = dict[key] || {};
            if (!/^[a-z][a-z0-9_]*$/.test(key)) {
                errors.push(`rarity_config 的键 "${key}" 不是小写字母开头的 [a-z0-9_]`
                    + ' → 玩家行里存的是这个字符串，`Rare` 与 `rare` 会在统计里算成两档');
            }
            const label = contentLabel(entry, null);
            if (!label) errors.push(`rarity_config.${key} 没有中文名 → 图鉴/列表/详情会把裸键 "${key}" 印给玩家`);
            else if (label === key) errors.push(`rarity_config.${key} 的名字与键相同（"${label}"）→ 与漏写等价，仍在印裸键`);
            if (typeof entry.color !== 'string' || !entry.color.trim()) {
                errors.push(`rarity_config.${key} 没有 color → 卡片边框与档名退回代码里抄的那份灰，玩家看不出它比别的档高`);
            }
            const order = Number(entry.order);
            if (!Number.isFinite(order)) errors.push(`rarity_config.${key} 没有 order → 档位由低到高的排序没有依据`);
            else if (orders.has(order)) errors.push(`rarity_config.${key} 与 ${orders.get(order)} 的 order 都是 ${order} → 排序不确定`);
            else orders.set(order, key);

            const ratio = contentNumber(entry.release_return_ratio, null);
            if (ratio === null) errors.push(`rarity_config.${key} 没有 release_return_ratio → 放生返还回落 0.2（与这一档无关的一个数）`);
            else if (!(ratio >= 0 && ratio <= 1)) errors.push(`rarity_config.${key}.release_return_ratio=${entry.release_return_ratio} 不在 0~1 → 放生可能返还负数灵石（BigInt(Math.floor(负数)) 直接抛）`);

            if (isPlainObject(multipliers)) {
                const multiplier = contentNumber(multipliers[key], null);
                if (multiplier === null) {
                    errors.push(`灵兽升星倍率表缺 "${key}" 这一档（star_upgrade.rarity_cost_multiplier）→ 它的升星消耗按 1.0 算，`
                        + '而 1.0 就是 common 那一档的倍率：越稀有的灵兽升星越便宜，方向直接反了');
                } else if (!(multiplier > 0)) {
                    errors.push(`star_upgrade.rarity_cost_multiplier.${key}=${multipliers[key]} 不是正数 → 升星消耗会算成 0 或负数材料`);
                }
            }
        }

        for (const key of Object.keys(multipliers || {}).filter(k => !k.startsWith('_'))) {
            if (!declared.has(key)) {
                errors.push(`star_upgrade.rarity_cost_multiplier.${key} 在稀有度词表里没有这一档 → 这个倍率永远不会被读到（拼错了或词表已删）`);
            }
        }

        for (const beast of this._entriesWithMeta('spirit_beast_data', 'beast_types')) {
            const rarity = beast?.rarity;
            if (rarity === undefined || rarity === null || rarity === '') continue;   // 没写 = 走兜底档，交由默认值处理
            if (!declared.has(String(rarity))) {
                errors.push(`${beast.__pk || beast.beast_key}（${contentLabel(beast, null) || beast?.name || '?'}）的 rarity="${rarity}" 不在稀有度词表里`
                    + `（可用：${keys.join('/')}）→ 图鉴印裸键、放生按 0.2 退、升星按 1.0 倍收，三处都不报错`);
            }
        }

        if (errors.length) throw new ContentError(`灵兽稀有度词表校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 「物品效果有人落账吗」—— 只对**资料片新增**硬拦，存量走带理由的台账（2026-09-23）。
     *
     * 起因是量到的一条玩家可见死账：16 件物品把 `breakthrough_bonus` 当成唯一或主要效果
     * （筑基丹 15 → 渡劫丹 50 → 补天丹 60，整条突破丹药线），而 `InventoryService._applyItemEffect`
     * 以前只把那个数往回执里塞一份、从不写进玩家身上 —— 突破流程读的其实是
     * `attributes.breakthrough_bonus`（`RealmService.resolveBreakthroughBonus` 走属性解析层，
     * 法则点那一支 LawService 就是这么写进去的），所以这条线**只差一次写入**，但一直没人写。
     * 补上那一行就等于替业主定三件事（永久还是一次性、注册表 30 点上限要不要抬、
     * 以及 化龙脉石 那个 0.1 是"10%"还是"0.1 点" —— 同一个键现网有两种单位），
     * 所以本轮只做"让它无法再静默发生"：回执不再报这个数、名单进报告、资料片新增即拦。
     */
    _validateItemEffectApplication() {
        const items = this._entriesWithMeta('item_data', 'items');
        if (!items.length) return;
        const used = new Map();          // 效果键 → 用了它的物品
        for (const item of items) {
            for (const key of Object.keys(item.effect || {})) {
                if (!used.has(key)) used.set(key, []);
                used.get(key).push(item);
            }
        }

        const errors = [];
        for (const [key, reason] of Object.entries(UNAPPLIED_ITEM_EFFECTS)) {
            const hits = used.get(key) || [];
            if (!hits.length) {
                // 过期结论**只在真实内容里**才算过期：这套闸跑在任何一份内容集上（测试夹具只带两三件物品），
                // 而"名单里这一条还有物品在用"是对**仓库内容**的断言，不是对某一份内容集的断言。
                // 所以这里只告警，硬拦放在 tests/ItemEffectApplicationLedger.test.js（它加载真实内容，
                // 名单过期时那条测试直接抛）—— 与"资料片新增死键"那一半相反：那一半在任何内容集上都成立，留在启动期。
                const stale = `UNAPPLIED_ITEM_EFFECTS 里的 "${key}" 现在没有任何物品在用 → 这条结论过期了，请把它从名单删掉`;
                this.report.warnings.push(`${stale}（留着只会让下一个用同一个键的物品蒙混过关）`);
                console.warn(`[ContentRegistry] ${stale}`);
                continue;
            }
            const fromPacks = hits.filter(item => item.__content_origin && item.__content_origin !== 'base');
            const isExcepted = item => UNAPPLIED_ITEM_EFFECT_EXCEPTIONS.some(
                e => e.key === key && e.item === String(item.__pk || item.id));
            const excepted = fromPacks.filter(isExcepted);
            const offending = fromPacks.filter(item => !isExcepted(item));
            if (offending.length) {
                errors.push(`资料片新增的 ${offending.length} 件物品（${offending.slice(0, 3).map(i => i.__pk || i.id).join('/')}）用效果键 "${key}"，而它没有任何落账逻辑：${reason}`
                    + ' → 玩家用下去只会看见一句「使用了 X」，什么也不会多；要么接进属性/账本，要么换一个有人消费的效果键，要么带理由登记成已知例外');
            }
            if (excepted.length) {
                const why = UNAPPLIED_ITEM_EFFECT_EXCEPTIONS.find(e => e.key === key).why;
                this.report.warnings.push(`已知例外：资料片带来的 ${excepted.map(i => i.__pk || i.id).join('/')} 用了没落账的效果键 "${key}"（${why}）；例外表与物品引用例外表同一套纪律，不再命中会反过来红`);
            }
            const staleExceptions = UNAPPLIED_ITEM_EFFECT_EXCEPTIONS.filter(
                e => e.key === key && !excepted.some(i => String(i.__pk || i.id) === e.item)).map(e => e.item);
            if (staleExceptions.length) {
                console.warn(`[ContentRegistry] 物品效果例外已失效：${key} 的例外 ${staleExceptions.join('/')} 现在没有对应的资料片物品，请删掉这条例外`);
            }
            this.report.warnings.push(`物品效果 "${key}" 有 ${hits.length} 件物品在用，但没有任何一处把它落到玩家身上（存量，等业主定出口）：${reason}`);
        }
        if (errors.length) throw new ContentError(`物品效果落账校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 赌石这一坨内容的对账（2026-09-23，与"产出池开放给资料片"同一天）。
     *
     * 为什么这道闸必须和登记一起做：`GamblingStoneService._rollYield` 里有两处**按下标直接取**的表
     * （`pools.spirit_stones[quality][0]`、`pools.cultivation[quality][0]`，代码里没有 `?.`），
     * 而品质本身是内容里的一张 map —— 于是"资料片新加一档品质、忘了同时给出这两档池子"
     * 不是少一个产出，而是**玩家一切开这块石头就 TypeError**，且服务把异常吞成
     * 「服务器内部错误」的 400（§26 那一族的形状：崩在 POST，GET 全绿）。
     * 同一批里还有三处是"配了但静默不生效"：线索维度数 ≠ 品质档数（两档共用一条线索）、
     * `fake_probability` 缺失（假线索这一层博弈永远不出现）、产地的 `pool_bias` 缺一个键
     * （NaN 比较恒 false → 那个产地无论怎么滚都只出稀有掉落）。
     */
    _validateGamblingStone() {
        const data = this.datasets.get('gambling_stone_data');
        // 问基础配置而不是合并视图：四张池子都登记成 optional，"没有这张表"与"被资料片整块抹掉"
        // 在合并视图里都是 {}（同一族坑见 `_validateTechniqueGrades`）
        const baseQualities = this._baseEntries('gambling_stone_data', 'qualities');
        if (!isPlainObject(data) || !baseQualities || !baseQualities.length) return;

        const errors = [];
        const warn = message => this.report.warnings.push(message);
        const realKeys = obj => (isPlainObject(obj) ? Object.keys(obj).filter(k => !k.startsWith('_')) : []);
        const isNum = v => typeof v === 'number' && Number.isFinite(v);
        const items = this.datasets.get('item_data')?.items;
        const itemKeys = new Set((Array.isArray(items) ? items : []).map(i => i && i.id).filter(Boolean));

        const qualities = data.qualities;
        const qualityKeys = realKeys(qualities);
        if (!qualityKeys.length) {
            errors.push(`qualities 在基础配置里有 ${baseQualities.length} 档，合并视图里却是空的`
                + ' → `_rollQuality` 抽不出任何品质，赌石整条玩法链当场失效；通常是某份资料片把这张表整块 replace/remove 了');
        }
        const tiers = new Map();
        for (const key of qualityKeys) {
            const entry = qualities[key] || {};
            if (!/^[a-z][a-z0-9_]*$/.test(key)) {
                errors.push(`qualities 的键 "${key}" 不是小写字母开头的 [a-z0-9_] → 原石行里存的就是这个字符串，改一次名就等于把老玩家的石头变成"品质不存在"`);
            }
            if (!contentLabel(entry, null)) errors.push(`qualities.${key} 没有中文名 → 列表与切开回执会把裸键 "${key}" 印给玩家`);
            if (!isNum(entry.tier)) {
                errors.push(`qualities.${key}.tier 不是数值（现值=${JSON.stringify(entry.tier)}）→ 服务里的品质档序按 \`Number.isFinite(tier)\` 过滤，`
                    + '这一档会整个从档序里消失：线索按 -1 下标取（取到 undefined）、"越切越好"的比较也不算它');
            } else if (tiers.has(entry.tier)) {
                errors.push(`qualities.${key}.tier=${entry.tier} 与 ${tiers.get(entry.tier)} 撞档 → 档序排序结果取决于对象键序，线索与产出池的对应关系会飘`);
            } else {
                tiers.set(entry.tier, key);
            }
            for (const [field, floor] of [['weight', 0], ['base_price', 0], ['yield_multiplier', 0], ['rare_chance_bonus', 0]]) {
                if (!isNum(entry[field]) || entry[field] < floor) {
                    errors.push(`qualities.${key}.${field} 不是数值或不小于 ${floor}（现值=${JSON.stringify(entry[field])}）`
                        + ` → ${field === 'weight' ? '整局品质抽样权重变 NaN，抽出来是 undefined 品质' : '`_rollYield` 拿它做乘法，产出直接变 NaN'}`);
                }
            }
            if (entry.color && !/^#[0-9a-fA-F]{3,8}$/.test(String(entry.color))) {
                warn(`qualities.${key}.color=${JSON.stringify(entry.color)} 不是 #hex → 卡片配色退回默认灰`);
            }
        }

        // —— 四张按品质索引的池子 ——
        const pools = data.yield_pools;
        if (!isPlainObject(pools)) {
            errors.push('yield_pools 不存在或不是对象 → 赌石没有任何产出');
        } else {
            // 这两张是代码里**没有守卫**的那两张：缺档不是少点东西，是切开就抛
            for (const table of ['spirit_stones', 'cultivation']) {
                const ranges = pools[table];
                if (!isPlainObject(ranges)) {
                    errors.push(`yield_pools.${table} 不存在 → \`_rollYield\` 里 \`pools.${table}[quality][0]\` 直接下标取，任何一次切开都会抛`);
                    continue;
                }
                for (const key of qualityKeys) {
                    // 与消费端同一份取形（contentRange）：基础配置是裸数组，资料片经 map 集合写的是 {id,value:[..]}
                    const range = contentRange(ranges[key]);
                    if (!range) {
                        errors.push(`yield_pools.${table}.${key} 不是 [min,max] 两个数（现值=${JSON.stringify(ranges[key])?.slice(0, 40)}）`
                            + ` → 切出品质 "${key}" 的那一块石头在 \`_rollYield\` 里当场抛，玩家看到的是"服务器内部错误"（服务把异常吞成 400）`);
                        continue;
                    }
                    if (range[0] > range[1]) errors.push(`yield_pools.${table}.${key} 的 min(${range[0]}) > max(${range[1]}) → \`min + floor(rand*(max-min+1))\` 会算出比 min 还小的数，甚至是负数产出`);
                }
                const orphans = realKeys(ranges).filter(k => !qualityKeys.includes(k));
                if (orphans.length) warn(`yield_pools.${table} 里的 ${orphans.join('/')} 在 qualities 里没有对应档 → 永远不会被读到（死配置）`);
            }

            for (const table of ['materials', 'rare_drops']) {
                const buckets = pools[table];
                if (buckets === undefined) continue;         // 这一档没稀有掉落是合法的（common 就没有）
                if (!isPlainObject(buckets)) {
                    errors.push(`yield_pools.${table} 不是对象 → 服务按品质下标取池子，取不到就当没有（这一类掉落整体消失）`);
                    continue;
                }
                for (const [quality, rawPool] of Object.entries(buckets)) {
                    if (quality.startsWith('_')) continue;
                    if (!qualityKeys.includes(quality)) {
                        warn(`yield_pools.${table}.${quality} 在 qualities 里没有对应档 → 这份池子永远不会被抽到（要么补一档品质，要么改键名）`);
                        continue;
                    }
                    // 与消费端同一份取形（contentList）：基础配置是裸数组，资料片经 map 集合写的是 {id, items:[...]}
                    const pool = contentList(rawPool, null);
                    if (!pool) {
                        errors.push(`yield_pools.${table}.${quality} 不是池子数组（现值=${JSON.stringify(rawPool)?.slice(0, 40)}）`
                            + ' → 服务按数组遍历这一档，取不到就当没有（这一类掉落整体消失）；资料片写池子请用 `{id, items:[...]}`');
                        continue;
                    }
                    let weightSum = 0;
                    for (const [index, entry] of pool.entries()) {
                        const isLdc = entry && entry.type === 'ldc';
                        const itemKey = entry && entry.item_id;
                        if (!itemKey && !isLdc) {
                            errors.push(`yield_pools.${table}.${quality}[${index}] 既没有 item_id 也不是 { type:'ldc' } → 抽中它时进背包那一步拿到的是没有键的物品，`
                                + '轻则那一行记录查无此物、重则整块石头开不出来（这句里不许写函数调用形状：文本闸会把散文当成真调用点）');
                        } else if (itemKey && itemKeys.size && !itemKeys.has(itemKey)) {
                            errors.push(`yield_pools.${table}.${quality}[${index}].item_id="${itemKey}" 不是 item_data 里的物品`
                                + ' → 玩家抽中它那一刻才失败：轻则这件东西永远切不出来（权重照占，等效于把别的产出挤掉），重则背包写进一条查无此物的行');
                        }
                        if (table === 'materials') {
                            const min = Number(entry?.min), max = Number(entry?.max);
                            if (!isNum(min) || !isNum(max) || min > max) {
                                errors.push(`yield_pools.materials.${quality}[${index}] 的 min/max 不合法（min=${JSON.stringify(entry?.min)}, max=${JSON.stringify(entry?.max)}）→ 数量算成 NaN，进背包那一步才炸`);
                            }
                            const weight = Number(entry?.weight);
                            if (!isNum(weight) || weight <= 0) {
                                errors.push(`yield_pools.materials.${quality}[${index}].weight 必须是正数（现值=${JSON.stringify(entry?.weight)}）→ 这一条在加权抽样里等于 0 权重，永远抽不到`);
                            } else weightSum += weight;
                        } else {
                            const chance = Number(entry?.chance);
                            if (!isNum(chance) || chance < 0 || chance > 1) {
                                errors.push(`yield_pools.rare_drops.${quality}[${index}].chance 必须是 0~1（现值=${JSON.stringify(entry?.chance)}）→ \`Math.random() < NaN\` 恒 false，这件稀有掉落永远不会出`);
                            }
                            if (!isLdc && !contentLabel(entry, null)) {
                                warn(`yield_pools.rare_drops.${quality}[${index}] 没有 name → 回执与推送里只能印 item_id`);
                            }
                        }
                    }
                    if (table === 'materials' && pool.length && weightSum === 0) {
                        errors.push(`yield_pools.materials.${quality} 里所有条目权重都≤0 → 加权抽样退回第一条，这一档"随机出材料"其实是固定的`);
                    }
                }
            }

            const curse = pools.curse_drops;
            const bonus = contentNumber(curse?.bonus_multiplier);
            const curseChance = contentNumber(curse?.curse_chance);
            if (!isNum(bonus) || bonus <= 0 || !isNum(curseChance)) {
                errors.push('yield_pools.curse_drops 缺 bonus_multiplier 或 curse_chance（必须是数值）'
                    + ' → 诅咒矿脉的产出倍率拿 undefined 相乘，那一类矿脉切出来的灵石/修为全是 NaN');
            } else if (curseChance < 0 || curseChance > 1) {
                errors.push(`yield_pools.curse_drops.curse_chance=${curseChance} 不在 0~1 → "石中诅咒"这一档要么永不触发要么每次必中`);
            }
        }

        // —— 线索维度：数量与档序都要跟着品质走 ——
        const clues = data.clues;
        if (!isPlainObject(clues)) {
            errors.push('clues 不存在 → 服务里 \`clueCfg[dim].values\` 直接点取，生成原石那一步就抛');
        } else {
            if (!isNum(clues.fake_probability) || clues.fake_probability < 0 || clues.fake_probability > 1) {
                errors.push(`clues.fake_probability=${JSON.stringify(clues.fake_probability)} 不是 0~1 的数 → \`Math.random() < NaN\` 恒 false，`
                    + '"三成药师看走眼"这一层博弈静默消失，赌石变成纯读表');
            }
            if (clues.fake_reduction_per_level !== undefined && !isNum(clues.fake_reduction_per_level)) {
                // 这一条曾经红过一次，而且抓到一个真死功能：代码里读的是 clues 这一节，
                // 而内容把减幅写在 skill 那一节（`skill.fake_reduction_per_level = 0.005`），
                // 于是 `Math.random() < NaN` 恒 false —— "30% 线索是假的"这一层博弈从来没触发过。
                // 现在读的是 skill（下面那条断言钉住它），而 clues 里**不许再补一份同名的**：
                // 两处都写就等于留一份永远不被读的假数值（同一族"覆盖退路 = 镜像"的坑）。
                errors.push('clues.fake_reduction_per_level 又出现了一份（且不是数值）→ 假线索减幅的正确出处是 '
                    + 'skill.fake_reduction_per_level，两处都写会有一份永远没人读；把 clues 里这颗删掉');
            }
            const dimensions = Object.entries(clues).filter(([key, value]) => !key.startsWith('_') && isPlainObject(value));
            if (!dimensions.length) {
                errors.push('clues 里没有任何维度条目 → 玩家切石头前看不到一条线索');
            }
            for (const [dim, entry] of dimensions) {
                if (!contentLabel(entry, null)) errors.push(`clues.${dim} 没有中文名 → 线索面板那一栏只能印裸键 "${dim}"`);
                if (!Array.isArray(entry.values) || entry.values.length < 2) {
                    errors.push(`clues.${dim}.values 至少要有 2 个档位（现值=${JSON.stringify(entry.values)}）`
                        + ' → 服务的"假线索"是在 values 里挑一个**不同**的档，只有 1 项时那个 do/while 永远出不来（请求挂住）');
                    continue;
                }
                if (entry.values.some(v => !isNum(v) && (typeof v !== 'string' || !v.trim()))) {
                    errors.push(`clues.${dim}.values 里有空项 → 玩家看到一条空白线索，读不出任何信息`);
                }
                if (qualityKeys.length && entry.values.length !== qualityKeys.length) {
                    errors.push(`clues.${dim}.values 有 ${entry.values.length} 档，而 qualities 有 ${qualityKeys.length} 档`
                        + ' → 服务按 `Math.min(品质档序, values.length-1)` 取线索：多出来的那一档和它下面那一档**共用同一条线索**，'
                        + '玩家在最上面两档之间看不出任何区别（这一档价值几万灵石的石头和下一档读起来一模一样）');
                }
            }
        }

        // —— 熟练度那一节：两处 NaN 会让"练级有用"整条线静默失效 ——
        const skill = data.skill;
        if (!isPlainObject(skill)) {
            errors.push('skill 不存在或不是对象 → `_rollYield` 里 \`cfg.skill.rare_bonus_per_10_level\` 直接点取，切开石头当场抛');
        } else {
            for (const [field, upper] of [['exp_per_cut', 1000], ['exp_per_rare_drop', 1000], ['max_level', 999], ['insight_unlock_level', 999]]) {
                if (!isNum(skill[field]) || skill[field] < 0 || skill[field] > upper) {
                    errors.push(`skill.${field} 不是 0~${upper} 的数值（现值=${JSON.stringify(skill[field])}）→ 熟练度成长那一格算成 NaN，练赌石技能不会有任何变化`);
                }
            }
            for (const [field, label] of [['fake_reduction_per_level', '假线索概率的减幅'], ['rare_bonus_per_10_level', '稀有掉落的每 10 级加成']]) {
                if (!isNum(skill[field]) || skill[field] < 0 || skill[field] > 1) {
                    errors.push(`skill.${field} 必须是 0~1 的数值（现值=${JSON.stringify(skill[field])}）`
                        + ` → ${label}这一项掺进算式就是 NaN：\`Math.random() < NaN\` 恒 false，`
                        + '于是"练赌石熟练度会看得更准 / 切得更好"这两条写在内容里的成长线一条都不成立（不报错，只是永远不中）');
                }
            }
            const titles = skill.level_titles;
            if (!isPlainObject(titles) || !Object.keys(titles).length) {
                errors.push('skill.level_titles 缺失或为空 → 等级称号那一步拿 undefined 取名，玩家升到 10/30/…级时称号那一格是空的');
            } else {
                // 值过 contentLabel：基础配置是裸字符串，资料片经 map 集合写的是 {id, label}（或 {id, value}）
                const bad = Object.entries(titles).filter(([level, name]) => !/^\d+$/.test(level) || !contentLabel(name, null));
                if (bad.length) errors.push(`skill.level_titles 里有非数字门槛或空称号：${bad.map(([l, n]) => `${l}=${JSON.stringify(n)}`).join(', ')}`);
            }
        }

        // —— 产地与切法 ——
        for (const [key, entry] of Object.entries(data.origins || {})) {
            if (key.startsWith('_')) continue;
            if (!contentLabel(entry, null)) errors.push(`origins.${key} 没有中文名 → 原石列表与线索文案里印裸键`);
            if (!isNum(entry.weight) || entry.weight <= 0) errors.push(`origins.${key}.weight 必须是正数 → 这一处矿脉抽不到（或 NaN 让整次抽样退回第一条）`);
            const bias = entry.pool_bias;
            const needed = ['spirit_stones', 'cultivation', 'material', 'rare'];
            if (!isPlainObject(bias) || needed.some(k => !isNum(bias[k]))) {
                errors.push(`origins.${key}.pool_bias 必须齐 ${needed.join('/')} 四个数值`
                    + ` → \`_rollYield\` 里那串 \`r < bias.a + bias.b + ...\` 一旦掺进 NaN 就恒 false，这个产地无论滚多少次都只出"稀有"那一类产出`);
                continue;
            }
            const sum = needed.reduce((acc, k) => acc + bias[k], 0);
            if (sum > 1.0001 || sum < 0.999) {
                errors.push(`origins.${key}.pool_bias 四档之和=${sum.toFixed(3)}，不是 1 → 剩下的那一截全部落到 "rare"（或负数时前面的判定顺序说了算），产出分布和配表写的不是一回事`);
            }
        }
        for (const [key, entry] of Object.entries(data.cut_methods || {})) {
            if (key.startsWith('_')) continue;
            if (!contentLabel(entry, null)) errors.push(`cut_methods.${key} 没有中文名 → 切法按钮/回执里印裸键`);
            if (!isNum(entry.loss_rate) || entry.loss_rate < 0 || entry.loss_rate >= 1) {
                errors.push(`cut_methods.${key}.loss_rate=${JSON.stringify(entry.loss_rate)} 不在 [0,1) → 这一种切法算出来的产出是 NaN 或整笔归零`);
            }
            if (!isNum(entry.cost_spirit_stones) || entry.cost_spirit_stones < 0) {
                errors.push(`cut_methods.${key}.cost_spirit_stones 不是非负数 → 扣费那一步算成 NaN，玩家切不开也退不回`);
            }
        }

        if (errors.length) throw new ContentError(`赌石内容对账失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 道侣 / 侍妾：心动劫选项、远航模式与远航奖励池的对账（2026-09-23，与这三块登记成集合同一天）。
     *
     * 三处"配了却不会按内容生效"的形状都在这条链上，全都要在启动期响：
     *   · `voyage.modes.<键>` 有档但 `voyage.reward_pools.<同名键>` 缺 → 服务读的是
     *     `contentList(reward_pools[mode], [])`，走出去**必定空手回来**，而回执、耗时、成功判定全都正常；
     *   · 池子条目的 `type` 只认 `spirit_stones`/`item`（消费端就两个 if），写成别的值就是"这一条永远不会出"；
     *   · `heart_tribulation.options.*.remnant_soul_cost` 结算路径整体不读（连余额校验都没有），
     *     而面板照着它印"· 残魂消耗：15" —— 存量三档里两档写了 cost，所以这里只告警；
     *     **资料片新加的选项写这颗键直接拦**（同一族纪律见 UNAPPLIED_ITEM_EFFECTS）。
     */
    _validateCompanionVoyage() {
        const data = this.datasets.get('companion_data');
        if (!isPlainObject(data)) return;
        const errors = [];
        const warn = message => this.report.warnings.push(message);
        const isNum = v => typeof v === 'number' && Number.isFinite(v);
        const realKeys = obj => (isPlainObject(obj) ? Object.keys(obj).filter(k => !k.startsWith('_')) : []);

        // —— 心劫选项 ——
        const options = data.heart_tribulation?.options;
        const optionKeys = realKeys(options);
        if (!optionKeys.length) {
            if (this._baseEntries('companion_data', 'heart_tribulation.options')?.length) {
                errors.push('heart_tribulation.options 在合并视图里被清空 → 触发心劫后玩家一个选项都看不到（抉择接口会一律回"必须是  之一"）');
            }
        }
        const fromPacks = new Set(this._entriesWithMeta('companion_data', 'heart_tribulation.options')
            .filter(entry => entry.__content_origin && entry.__content_origin !== 'base')
            .map(entry => String(entry.__pk)));
        for (const key of optionKeys) {
            const entry = options[key] || {};
            if (!contentLabel(entry, null)) {
                errors.push(`heart_tribulation.options.${key} 没有中文名 → 面板只能印裸键 "${key}"（客户端那份键→名字的手抄表已被删）`);
            }
            if (!isNum(entry.success_rate) || entry.success_rate <= 0 || entry.success_rate > 1) {
                errors.push(`heart_tribulation.options.${key}.success_rate=${JSON.stringify(entry.success_rate)} 不在 (0,1]`
                    + ' → 判定是 `Math.random() < success_rate`：NaN 恒 false（这个选项永远不会成功），>1 则恒 true（没有抉择风险）');
            }
            if (!isNum(entry.intimacy_gain)) {
                errors.push(`heart_tribulation.options.${key}.intimacy_gain 不是数值 → 成功回执与库里亲密度都会算成 NaN`);
            }
            if (entry.remnant_soul_cost !== undefined) {
                const message = `heart_tribulation.options.${key}.remnant_soul_cost 没有任何结算代码读它（服务只做成功率判定 + 亲密度/心契/虚弱，从不扣残魂）`
                    + ' → 面板印的"残魂消耗"是空头承诺；出参层已把这颗键滤掉，接上扣费要业主定（见 docs/待业主拍板清单.md）';
                if (fromPacks.has(key)) errors.push(`资料片新增的选项 "${key}" ${message}`);
                else warn(`${key} ${message}`);
            }
        }

        // —— 远航模式与奖励池 ——
        const voyage = data.voyage;
        if (!isPlainObject(voyage)) {
            errors.push('voyage 不存在或不是对象 → 侍妾远航整条玩法链读不到配置');
        } else {
            const modes = voyage.modes;
            const modeKeys = realKeys(modes);
            const pools = voyage.reward_pools;
            const items = this.datasets.get('item_data')?.items;
            const itemKeys = new Set((Array.isArray(items) ? items : []).map(i => i && i.id).filter(Boolean));
            if (!modeKeys.length) {
                if (this._baseEntries('companion_data', 'voyage.modes')?.length) {
                    errors.push('voyage.modes 在合并视图里被清空 → 任何 mode 都会被路由判"参数非法"，远航整条线关张');
                }
            }
            for (const key of modeKeys) {
                const entry = modes[key] || {};
                if (!contentLabel(entry, null)) {
                    errors.push(`voyage.modes.${key} 没有中文名 → 选择列表与"待领取"那行只能印裸键 "${key}"`);
                }
                for (const field of ['duration_hours', 'risk_modifier', 'reward_multiplier', 'min_charm']) {
                    if (!isNum(entry[field])) {
                        errors.push(`voyage.modes.${key}.${field} 不是数值（现值=${JSON.stringify(entry[field])}）`
                            + ` → ${field === 'duration_hours' ? '预计归来时间算成 Invalid Date，玩家永远领不到奖励'
                                : field === 'min_charm' ? '魅力门槛比较变成 NaN 比较（永远放行）'
                                    : '成功率的 risk_penalty 项或奖励倍率算成 NaN'}`);
                    } else if (field !== 'min_charm' && entry[field] <= 0) {
                        errors.push(`voyage.modes.${key}.${field}=${entry[field]} 必须是正数 → 这一档的时长/风险/回报要么为零要么为负`);
                    }
                }
                const pool = contentList(pools?.[key], null);
                if (!pool || !pool.length) {
                    errors.push(`voyage.reward_pools.${key} 缺失或为空（模式 "${key}" 在 voyage.modes 里有档）`
                        + ` → 这一档远航走出去**必定空手回来**：${key} 的耗时、风险、成功判定全都照常，只是奖励池是空的，玩家只会以为"运气差"`);
                    continue;
                }
                for (const [index, picked] of pool.entries()) {
                    const type = picked && picked.type;
                    if (type !== 'spirit_stones' && type !== 'item') {
                        errors.push(`voyage.reward_pools.${key}[${index}].type=${JSON.stringify(type)} 只认 spirit_stones / item`
                            + ' → 服务侧那两个 if 之外没有任何分支，这一条会被静默丢掉（占着权重却永远不出）');
                        continue;
                    }
                    const weight = Number(picked.weight);
                    if (!isNum(weight) || weight <= 0) {
                        errors.push(`voyage.reward_pools.${key}[${index}].weight 必须是正数（现值=${JSON.stringify(picked.weight)}）→ 加权抽样里等于 0，这一条永远不会被选中`);
                    }
                    if (type === 'spirit_stones') {
                        const min = Number(picked.min), max = Number(picked.max);
                        if (!isNum(min) || !isNum(max) || min > max) {
                            errors.push(`voyage.reward_pools.${key}[${index}] 的 min/max 不合法（min=${JSON.stringify(picked.min)}, max=${JSON.stringify(picked.max)}）→ 灵石数算成 NaN，发钱那一步才炸`);
                        }
                    } else {
                        const keys = contentList(picked.item_keys, []);
                        if (!keys.length) {
                            errors.push(`voyage.reward_pools.${key}[${index}].item_keys 是空的 → 这一条抽中了也发不出东西`);
                            continue;
                        }
                        for (const itemKey of keys) {
                            if (itemKeys.size && !itemKeys.has(itemKey)) {
                                errors.push(`voyage.reward_pools.${key}[${index}].item_keys 里的 "${itemKey}" 不是 item_data 里的物品`
                                    + ' → 抽中它那一刻才失败（要么发不出、要么在背包里留下一行查无此物的记录）；把物品一起写进资料片，或换一个真存在的键');
                            }
                        }
                    }
                }
            }
            const orphanPools = realKeys(pools).filter(k => !modeKeys.includes(k));
            if (orphanPools.length) {
                warn(`voyage.reward_pools 里的 ${orphanPools.join('/')} 在 voyage.modes 里没有对应档 → 这些池子永远不会被读到（死配置，要么补一档模式要么删掉）`);
            }
            const formula = voyage.success_rate_formula;
            const formulaKeys = ['base', 'charm_weight', 'intimacy_weight', 'loyalty_weight', 'risk_penalty', 'max_rate', 'min_rate'];
            if (!isPlainObject(formula) || formulaKeys.some(k => !isNum(formula[k]))) {
                errors.push('voyage.success_rate_formula 缺 ' + formulaKeys.filter(k => !isNum(formula?.[k])).join('/')
                    + ' → 成功率那串乘加算成 NaN，`Math.random() < NaN` 恒 false：远航**必定失败**（还会照发"保留 30% 灵石"）');
            } else if (formula.min_rate > formula.max_rate) {
                errors.push(`voyage.success_rate_formula 的 min_rate(${formula.min_rate}) > max_rate(${formula.max_rate}) → Math.max(min, Math.min(max, x)) 这一串钳制失效，成功率取的是 max 还是 min 取决于钳制顺序`);
            }
            if (!isNum(voyage.max_rare_items) || voyage.max_rare_items < 1) {
                errors.push(`voyage.max_rare_items=${JSON.stringify(voyage.max_rare_items)} 必须是 ≥1 的数 → 成功时一件材料都发不出（rewards.items.length < max_rare_items 恒 false）`);
            }
            if (!isNum(voyage.failure_spirit_stone_retain) || voyage.failure_spirit_stone_retain < 0 || voyage.failure_spirit_stone_retain > 1) {
                errors.push(`voyage.failure_spirit_stone_retain=${JSON.stringify(voyage.failure_spirit_stone_retain)} 必须在 0~1 → 失败保留的那笔灵石算成 NaN 或超过全额`);
            }
            if (!isNum(voyage.collect_expire_hours) || voyage.collect_expire_hours <= 0) {
                errors.push('voyage.collect_expire_hours 必须是正数 → 领取截止时间为 NaN，归来奖励要么立刻过期要么永远领不到');
            }
        }

        if (errors.length) throw new ContentError(`道侣/侍妾内容对账失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 傀儡「类型 ↔ 图谱」双向对账（2026-09-23，与把 blueprints 开放给资料片同一天）。
     *
     * 为什么这道闸必须和登记一起做：`puppet_types` 早就可扩，而它每一档的 `blueprint_key`
     * 指向的 `blueprints` 表却没登记 —— 于是"资料片加一只新傀儡"能写、**学不到也造不出**：
     * `learnBlueprint` 第一步就是 `blueprints[key]` 查不到就回"图谱不存在"，
     * 而它扣的是背包里那张图谱**物品**（图谱必须是 item_data 里真存在的物品，否则永远拿不到）。
     * 更要紧的是反向：图谱的 `puppet_type` 指错，玩家参悟完了面板上 `has_blueprint` 仍然是 false
     * （那一行按 `blueprint.puppet_type === 类型` 判），按钮永远灰着，一声不响。
     *
     * 现网实测五档全部双向一致、五张图谱都是真物品、source/name 齐 → 这道闸不误伤现有内容。
     */
    _validatePuppetBlueprints() {
        const base = this._baseEntries('puppet_data', 'blueprints');
        if (!base || !base.length) return;              // 这份内容集不用品阶图谱机制（合成夹具）
        const puppet = this.datasets.get('puppet_data') || {};
        const types = isPlainObject(puppet.puppet_types) ? puppet.puppet_types : {};
        const blueprints = isPlainObject(puppet.blueprints) ? puppet.blueprints : {};
        const typeKeys = entryKeys(types);
        const blueprintKeys = entryKeys(blueprints);
        const errors = [];

        if (!typeKeys.length) {
            throw new ContentError('puppet_data.puppet_types 是空表而 blueprints 有 '
                + `${blueprintKeys.length} 张图谱 → 每张图谱的 puppet_type 都会指不到类型，`
                + '玩家参悟完仍然造不出任何傀儡');
        }
        const itemIds = new Set((this.dataset('item_data')?.items || []).map(i => String(i.id)));

        for (const typeKey of typeKeys) {
            const cfg = types[typeKey] || {};
            const bk = cfg.blueprint_key;
            if (!bk) {
                errors.push(`puppet_types.${typeKey} 没有 blueprint_key → 这只傀儡没有任何获取途径：`
                    + 'manufacture 只认"已参悟过该类型的图谱"，面板上 has_blueprint 永远 false');
                continue;
            }
            if (!blueprintKeys.includes(String(bk))) {
                errors.push(`puppet_types.${typeKey}.blueprint_key="${bk}" 在 blueprints 里没有这张图谱`
                    + ' → learnBlueprint 第一步就回"图谱不存在"，这只傀儡造不出来（资料片加得了类型、加不了图谱就是这一格）');
                continue;
            }
            if (itemIds.size && !itemIds.has(String(bk))) {
                errors.push(`图谱 ${bk}（${typeKey} 唯一的学习途径）不是 item_data 里的物品`
                    + ' → 参悟要先在背包里有它，永远拿不到的东西不该做成获取途径');
            }
            const back = blueprints[bk];
            if (contentLabel(back, null) == null) errors.push(`blueprints.${bk} 没有 name → 图谱列表与确认弹窗都是空的`);
            if (!back?.source) errors.push(`blueprints.${bk} 没有 source → 面板上"从哪 obtain"那一行是空的，玩家不知道该去哪打`);
        }

        for (const bk of blueprintKeys) {
            const back = blueprints[bk] || {};
            if (!typeKeys.includes(String(back.puppet_type))) {
                errors.push(`blueprints.${bk}.puppet_type="${back.puppet_type}" 没有这一类傀儡`
                    + ' → 这张图谱参悟了也没用（manufacture 按类型查 puppet_types）');
            } else if (String(types[back.puppet_type].blueprint_key) !== String(bk)) {
                errors.push(`blueprints.${bk} 声称属于 ${back.puppet_type}，但那一类自己的 blueprint_key 指的是`
                    + ` "${types[back.puppet_type].blueprint_key}" → 两条路对不上：`
                    + '面板按图谱的 puppet_type 判"已参悟"，按类型的 blueprint_key 出"去哪拿"，玩家会看见两张说法不同的图谱');
            }
        }

        if (errors.length) throw new ContentError(`傀儡图谱与类型对账失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 功法获取途径必须落在服务真认识的分支上，带物品的途径还要双向对得上。
     *
     * 为什么单独一道（三件事都是量出来的，不是设想）：
     *   ① TechniqueService.learnTechnique 只有 shop / sect 两条会扣代价，secret_realm 会被拒，
     *      **其余取值全部落到"什么都不扣"** —— 资料片写过的 "recipe_scroll"、"sect_treasury"
     *      于是变成"境界够就免费研习"，看起来配了稀有机缘，实际是白送；
     *   ② 那张残卷物品走的是另一条链：CraftingService.learnRecipe 只在炼丹/炼器配方里找 id，
     *      撞见功法 id 就回"配方配置不存在" —— 玩家花六万灵石买的东西点下去只会报错；
     *   ③ 残卷还完全不在任何掉落/商店里，就算②修好了也照样拿不到。
     * 三条各自单看都"配置合法、代码没崩"，只有玩家能看出这是坏的，所以钉在启动期。
     */
    _validateTechniqueAcquire() {
        // 这张表就是"代码认识哪些分支"的清单：给 learnTechnique 加分支时必须同步这里，
        // 否则新分支永远进不了校验，这道闸又变成摆设（同一族教训见 DATASET_SPECS 的登记）。
        const SUPPORTED = {
            default: [],
            shop: ['cost_spirit_stone'],
            sect: ['sect_contribution'],
            secret_realm: [],
            recipe_scroll: ['item_id']
        };
        const techniques = this._entriesWithMeta('technique_data', 'techniques');
        if (!techniques.length) return;     // 只喂了部分数据集的单元测试里这份可能整个缺席

        const items = this._entriesWithMeta('item_data', 'items');
        const itemById = new Map(items.map(i => [String(i.id), i]));
        const byPk = new Map(techniques.map(t => [String(t.__pk ?? t.id), t]));
        const sectIds = new Set(this._entriesWithMeta('sect_data', 'sects').map(s => String(s.id)));

        const problems = [];
        const referenced = new Set();
        for (const entry of techniques) {
            const id = String(entry.__pk ?? entry.id ?? '(无 id)');
            const acquire = entry.acquire;
            if (!acquire) continue;
            const source = String(acquire.source ?? 'default');
            if (!Object.prototype.hasOwnProperty.call(SUPPORTED, source)) {
                problems.push(`${id}: acquire.source="${source}" 没有任何代码处理它 —— 境界够就免费研习。可用值：${Object.keys(SUPPORTED).join('/')}`);
                continue;
            }
            for (const field of SUPPORTED[source]) {
                const value = acquire[field];
                if (value === undefined || value === null || value === '') {
                    problems.push(`${id}: acquire.source="${source}" 缺字段 ${field}`);
                    continue;
                }
                if (source !== 'recipe_scroll' && !Number.isFinite(Number(value))) {
                    problems.push(`${id}: acquire.${field} 必须是数字（现在是 ${JSON.stringify(value)}）`);
                }
            }
            if (source === 'sect' && acquire.sect_id && !sectIds.has(String(acquire.sect_id))) {
                problems.push(`${id}: acquire.sect_id="${acquire.sect_id}" 不是任何宗门（限定条件永远判不过）`);
            }
            if (source !== 'recipe_scroll') continue;
            const item = itemById.get(String(acquire.item_id));
            if (!item) {
                problems.push(`${id}: acquire.item_id="${acquire.item_id}" 不是任何一件物品（玩家永远凑不齐这份代价）`);
                continue;
            }
            if (item.type !== 'recipe_scroll') {
                problems.push(`${id}: acquire.item_id 指向的 ${item.id} 类型是 ${item.type}；研习要消耗它，必须是 recipe_scroll`);
            }
            if (String(item.effect?.learn_technique ?? '') !== id) {
                problems.push(`${id}: 残卷 ${item.id} 的 effect.learn_technique=${JSON.stringify(item.effect?.learn_technique)}`
                    + ' 必须回指这部功法，否则玩家手里的卷轴没有任何一侧认得它是钥匙');
            }
            referenced.add(String(acquire.item_id));
        }

        // 反方向：写着 learn_technique 的物品必须真被某部功法的 acquire 引用，且目标存在
        for (const item of items) {
            const target = item.effect?.learn_technique;
            if (!target) continue;
            if (!byPk.has(String(target))) {
                problems.push(`物品 ${item.id} 的 effect.learn_technique="${target}" 不是任何功法（学了个空）`);
            } else if (!referenced.has(String(item.id))) {
                problems.push(`物品 ${item.id} 声明可悟《${target}》，但 ${target} 的 acquire 没引用它：这条通道没人开`);
            }
            // 一卷不能同时是两样钥匙：两条链各自都要"用掉一份"，玩家先走哪条，另一条就永久断了
            if (item.effect?.learn_recipe) {
                problems.push(`物品 ${item.id} 同时写了 learn_technique 与 learn_recipe：`
                    + `交去研习功法会消耗掉它，拿去学配方也会消耗掉它，一份只能成一条链。请拆成两件物品`);
            }
        }

        if (problems.length) {
            throw new ContentError(
                `功法获取途径不成立:\n  - ${[...new Set(problems)].join('\n  - ')}`
            );
        }
    }

    /**
     * 境界链必须逐级相连、名字唯一。
     *
     * 为什么单独一道：realm_breakthrough 是资料片可增删的数据集，而境界之间的"下一境"
     * 是靠 rank 连续隐式成立的（配置里没有 next 指针）。删掉中间一个境界，配置自身看不出任何破绽，
     * 但两件事当场坏掉：突破链在那里断掉，而正卡在那个境界上的玩家 —— players.realm 存的是**名字**，
     * 从此查无此境界，表现是突破面板报"境界配置不存在"，不是"内容少了一条"。
     * 与掉落表那道闸同一类：坏在数据里，长在玩家身上。
     */
    _validateRealmChain() {
        const realms = this._entriesWithMeta('realm_breakthrough', 'realms');
        // 只喂了部分数据集的单元测试里这份配置可能整个缺席（宁可漏判也不误伤）
        if (!realms.length) return;

        const problems = [];
        const byRank = new Map();
        const names = new Set();
        for (const realm of realms) {
            const label = realm?.name || realm?.id || '(无名字无 id)';
            const rank = Number(realm?.rank);
            if (!Number.isInteger(rank)) {
                problems.push(`${label} 的 rank 不是整数（${JSON.stringify(realm?.rank)}）`);
                continue;
            }
            if (byRank.has(rank)) problems.push(`rank ${rank} 被 ${byRank.get(rank)} 和 ${label} 同时占用`);
            else byRank.set(rank, label);

            const name = String(realm?.name ?? '').trim();
            // 名字是 players.realm 里存的值：重名等于两个境界挤同一个键，查出来永远是先命中的那个
            if (!name) problems.push(`境界 ${realm?.id || rank} 没有 name，玩家身上没法存`);
            else if (names.has(name)) problems.push(`境界名字重复：${name}`);
            else names.add(name);
        }

        const ordered = [...byRank.keys()].sort((a, b) => a - b);
        for (let i = 1; i < ordered.length; i++) {
            if (ordered[i] !== ordered[i - 1] + 1) {
                problems.push(`rank ${ordered[i - 1] + 1} 缺失：境界链在「${byRank.get(ordered[i - 1])}」之后断了`);
            }
        }

        if (problems.length) {
            throw new ContentError(`境界链不完整：${[...new Set(problems)].join('；')}。`
                + '资料片可以加境界，但不要删掉或改号基础链里的境界 —— 玩家身上存的是境界名字。'
            );
        }
    }

    /**
     * 怪物声明的属性必须是注册表里的属性。
     *
     * 为什么单独一道：怪物属性现在由内容驱动（map_data 里 `stats: { crit_rate: 15 }` 就直接进结算），
     * 而结算侧读的是"属性块里的键"—— 一个拼错的键（`crit_change`）不会报错，只会永远不生效，
     * 表现是"我明明给这只怪加了暴击，它怎么从来不暴击"。这正是这一整套改造要消灭的那类静默失效。
     */
    _validateCombatStatBlocks() {
        const problems = [];
        let sawAnyEnemy = false;

        // 实例行撑腰的敌人（世界 BOSS / 兽潮妖兽）：这些数值以行为准，内容里再声明一遍就是两个真相
        const INSTANCE_OWNED_STATS = ['atk', 'def', 'speed', 'hp_max', 'max_hp', 'hp'];

        const checkEnemy = (label, enemy, reserved = []) => {
            if (!enemy || typeof enemy !== 'object') return;
            sawAnyEnemy = true;

            if (enemy.power_multiplier !== undefined) {
                const factor = Number(enemy.power_multiplier);
                if (!Number.isFinite(factor) || factor <= 0) {
                    problems.push(`${label} 的 power_multiplier 不是正数：${JSON.stringify(enemy.power_multiplier)}`);
                }
            }
            if (enemy.stats === undefined) return;
            if (!enemy.stats || typeof enemy.stats !== 'object' || Array.isArray(enemy.stats)) {
                problems.push(`${label} 的 stats 必须是对象（写属性键:数值）`);
                return;
            }
            for (const [key, value] of Object.entries(enemy.stats)) {
                if (reserved.includes(key)) {
                    problems.push(`${label} 在 stats 里声明了 ${key}：这个值以敌人实例行/配置里的基础字段为准，声明不会生效（请改 base_atk/base_def/base_hp 那一层）`);
                    continue;
                }
                if (!Number.isFinite(Number(value))) {
                    problems.push(`${label} 的属性 ${key} 不是数值：${JSON.stringify(value)}`);
                    continue;
                }
                // 没接注册中心的调用方（有的单测只要合并结果）不做"属性是否登记"判定
                if (this.statRegistry && !this.statRegistry.resolveStatKey(key)) {
                    problems.push(`${label} 声明了未注册的属性 "${key}"（结算读不到它，这只怪不会有任何效果）`);
                }
            }
        };

        // 野外怪（map_data）
        const maps = this.dataset('map_data')?.maps || {};
        for (const map of Object.values(maps)) {
            for (const monster of (map?.monsters || [])) checkEnemy(`${map?.id ?? '?'}/${monster?.id || '(无 id)'}`, monster);
        }

        // 副本怪与副本 BOSS（dungeon_data：节点上的 monster、章节末尾的 boss）
        for (const chapter of (this.dataset('dungeon_data')?.chapters || [])) {
            checkEnemy(`${chapter?.id || '?'}/boss`, chapter?.boss);
            for (const node of (chapter?.nodes || [])) {
                if (node?.monster) checkEnemy(`${chapter?.id}/${node?.id}`, node.monster);
            }
        }

        // 世界 BOSS 与兽潮妖兽（实例行上只有 atk/def/speed/hp，触发属性只能从静态声明来）
        for (const boss of (this.dataset('world_boss_data')?.bosses || [])) {
            checkEnemy(`world_boss/${boss?.boss_key || '?'}`, boss, INSTANCE_OWNED_STATS);
        }
        for (const beast of (this.dataset('beast_invasion_data')?.beasts || [])) {
            checkEnemy(`beast_invasion/${beast?.beast_key || '?'}`, beast, INSTANCE_OWNED_STATS);
        }

        // 灵兽探渊每层抽的怪：条目自己就带 atk/def/hp/speed，再在 stats 里写一遍同样是两个真相
        const ABYSS_OWNED = [...INSTANCE_OWNED_STATS, 'exp_reward', 'key', 'name', 'element'];
        for (const floor of (this.dataset('spirit_beast_abyss_data')?.floors || [])) {
            for (const monster of (floor?.monsters || [])) {
                checkEnemy(`beast_abyss/第${floor?.floor ?? '?'}层/${monster?.key || '?'}`, monster, ABYSS_OWNED);
            }
        }

        // 切磋木人：这份的 stats 就是属性块本身（max_hp/atk/def/speed），不是覆盖层，
        // 所以不做"与基础字段重名"的判定，但键名同样必须登记过 —— 木人写个 crit_change
        // 永远不会有人读，而玩家与策划都会以为那只木人会暴击。
        // HP 的几种叫法（hp/max_hp/hp_max）按存储别名放行：它们是各来源的列名，不是属性键。
        const { HP_KEYS } = require('../combat/CombatStats');
        for (const woodman of (this.dataset('sparring_woodman')?.woodmen || [])) {
            const label = `sparring/${woodman?.key || '?'}`;
            sawAnyEnemy = true;
            if (woodman?.power_multiplier !== undefined) {
                const factor = Number(woodman.power_multiplier);
                if (!Number.isFinite(factor) || factor <= 0) {
                    problems.push(`${label} 的 power_multiplier 不是正数：${JSON.stringify(woodman.power_multiplier)}`);
                }
            }
            const block = woodman?.stats;
            if (!block || typeof block !== 'object' || Array.isArray(block)) {
                problems.push(`${label} 缺少 stats 属性块（切磋战斗直接读它）`);
                continue;
            }
            for (const [key, value] of Object.entries(block)) {
                if (!Number.isFinite(Number(value))) {
                    problems.push(`${label} 的属性 ${key} 不是数值：${JSON.stringify(value)}`);
                } else if (this.statRegistry && !this.statRegistry.resolveStatKey(key) && !HP_KEYS.includes(key)) {
                    problems.push(`${label} 声明了未注册的属性 "${key}"（结算读不到它，这个木人不会有任何效果）`);
                }
            }
        }

        // 出战/护法傀儡（友方战斗单位）：base_stats 是它的属性块，PuppetService 折算整块进战斗，
        // 所以这里的规则与敌人一模一样 —— 写一个没登记的键不会报错，只是永远不会生效。
        // 连等级增长率（quench.stat_growth_rate）一起查：那一份以前只有 atk/speed 真的被读，
        // def/hp 两档写了也没人看，正是"改了数值没反应"那一类。
        const puppetData = this.dataset('puppet_data');
        for (const [typeKey, typeCfg] of Object.entries(puppetData?.puppet_types || {})) {
            const block = typeCfg?.base_stats;
            if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
            sawAnyEnemy = true;
            for (const [key, value] of Object.entries(block)) {
                if (!Number.isFinite(Number(value))) {
                    problems.push(`puppet/${typeKey} 的属性 ${key} 不是数值：${JSON.stringify(value)}`);
                } else if (this.statRegistry && !this.statRegistry.resolveStatKey(key) && !HP_KEYS.includes(key)) {
                    problems.push(`puppet/${typeKey} 声明了未注册的属性 "${key}"（傀儡折算时读不到它）`);
                }
            }
        }
        for (const key of Object.keys(puppetData?.quench?.stat_growth_rate || {})) {
            if (this.statRegistry && !this.statRegistry.resolveStatKey(key) && !HP_KEYS.includes(key)) {
                problems.push(`puppet 的等级增长率写了未登记的属性 "${key}"（没有一只傀儡会因此变强）`);
            }
        }

        // 只喂了部分数据集的单元测试里这两份配置可能整个缺席（宁可漏判也不误伤）
        if (!sawAnyEnemy) return;
        if (problems.length) {
            throw new ContentError(`战斗单位属性声明校验失败：\n  - ${[...new Set(problems)].join('\n  - ')}`);
        }
    }

    /** 合并后的数据集视图（已含资料片内容），形状与基础 config 文件一致 */
    dataset(name) { return this.datasets.get(name) || null; }

    /** 已登记的数据集名（后台按这份名单出下拉，不在名单里的数据集直接拒） */
    static get registeredDatasets() { return Object.keys(DATASET_SPECS); }

    /**
     * 某个集合的"主键 + 显示名"清单，给 GM 面板当下拉的数据源。
     *
     * 为什么要有：后台三个面板（侍妾 / 宗门 / 灵兽）以前各自抄了一份主键清单，
     * 资料片加一条内容，下拉里就没有它 —— 而服务端一直是按内容认的，本来选得出来。
     * 显示名按 name / display_name / title / label / <主键字段去 _key>_name 的顺序找，都没有就用主键。
     * @param {string} datasetName 已登记数据集名
     * @param {string|null} collectionName 集合名，省略则取该数据集的第一个集合
     * @returns {Array<{key: string, name: string, collection: string}>}
     */
    entryOptions(datasetName, collectionName = null) {
        const spec = DATASET_SPECS[datasetName];
        if (!spec) throw new ContentError(`数据集未登记，不能按内容出清单: ${datasetName}`);
        const name = collectionName || Object.keys(spec.collections || {})[0];
        if (!spec.collections[name]) throw new ContentError(`数据集 ${datasetName} 未登记集合 ${name}`);
        const data = this.dataset(datasetName);
        if (!data) throw new ContentError(`数据集未加载: ${datasetName}`);
        const { spec: colSpec, entries } = readCollection(datasetName, data, name);
        const stem = (colSpec.key || 'id').replace(/_key$/, '');
        return entries.map((entry, i) => {
            const key = keyOf(entry, colSpec, i);
            const label = entry.name ?? entry.display_name ?? entry.title ?? entry.label ?? entry[`${stem}_name`] ?? key;
            const option = { key, name: String(label), collection: name };
            // 颜色与档序内容里有就一起发：后台以前为了画一个色块自己抄了一份档位表（灵兽稀有度就是那一份），
            // 抄的那份不会跟着资料片长。没有这两个字段的集合（属性/流派…）保持原形状。
            if (typeof entry.color === 'string' && entry.color.trim()) option.color = entry.color.trim();
            const order = Number(entry.order);
            if (Number.isFinite(order)) option.order = order;
            return option;
        }).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
    }

    /** 全部合并视图，供 ConfigLoader 回灌 */
    mergedDatasets() { return this.datasets; }

    /**
     * 深扫所有已合并的数据集：凡是长得像"物品引用"的字段（item_key / item_id / material_key /
     * xxx_item_key / xxx_item_id），值必须是真的物品 id。
     *
     * 为什么不只用 REFERENCES 那张表：REFERENCES 要一行行写"哪个数据集哪个集合的哪个字段"，
     * 而法宝深度这类配置是**任意深度嵌套**的（stages[].materials[].item_key、
     * thunder_wash.materials_tianlei[].item_key…），一行行列既写不完也一定会漏。
     * 漏掉的表现很难看：玩家在炼焰/祭炼进行到一半时才撞上"物品配置不存在"，
     * 整笔事务回滚 —— 材料扣了、进度没动，或者直接报内部错误。
     * 按字段名匹配是刻意的宽松：宁可多扫一些，也不要让一处引用没人管。
     */
    _validateItemKeysDeep() {
        const itemIds = new Set((this.dataset('item_data')?.items || []).map(i => String(i.id)));
        if (!itemIds.size) return;
        const offenders = [];
        const matchedExemptions = new Set();

        this._walkItemRefs((at, item) => {
            if (typeof item !== 'string' || itemIds.has(item)) return;
            const ref = OPTIONAL_ITEM_REFS.find(r => r.at === at && (r.item === undefined || r.item === item));
            if (ref) { matchedExemptions.add(ref.at); return; }
            offenders.push(`${at} = "${item}"`);
        });

        // 豁免条目也会过期：物品补上了、或键被删了，留着它只会让"这条闸到底还管不管"再次变得看不清楚
        for (const ref of OPTIONAL_ITEM_REFS) {
            if (!matchedExemptions.has(ref.at)) {
                console.warn(`[ContentRegistry] 物品引用豁免已失效：${ref.at} 现在没有指向缺失的物品，请删掉这条例外`);
            }
        }

        if (offenders.length) {
            throw new ContentError(
                `内容里有物品引用指向不存在的物品（先补物品，或把引用改掉）:\n  - ${[...new Set(offenders)].join('\n  - ')}`
            );
        }
    }

    /**
     * "什么长得像物品引用"这一个问题只有一份答案（2026-09-22 抽出来）。
     *
     * 为什么单独一个方法：这条判据原来只活在 `_validateItemKeysDeep` 里，而它要回答的是**反方向**的
     * 问题（"这条引用指着不存在的物品"）。要问"这件物品有没有任何获取来源"就得把同一套形状再认一遍 ——
     * 抄一份就必然分叉（少一种形状 = 那条路径上的来源不被算进账，物品被误判成死内容）。
     *
     * 认三种形状（第 1、2 条是原有判据，第 4、5 条是 2026-09-22 实测补的）：
     *   1. 字段名匹配（item_key / item_id / material_key / xxx_item_key / item_pool…），值可以是单个或数组。
     *      第 3 种形状里的"裸 id 数组"（访客遭遇 `rewards.item_pool`、各种"随机发一件"的池子）曾经不在
     *      匹配里：池子里写个不存在的物品没有任何信号，玩家撞上那次遭遇就是"什么都没拿到"。
     *   2. 引用藏在"物品数组"的元素里、字段名只是 key（慕兰战线 `military_shop.items[].key`、
     *      `support_routes.*.item_drops[].key`、`milestones.thresholds[].rewards.items[].key`）——
     *      光靠字段名匹配永远够不着，那 4 个不存在的物品 id 就是这么躺到现在的。
     *   3. 同一种数组的元素直接是裸物品 id（历练事件 `rewards.items: ['spirit_herb']`）。
     *      以前只认对象元素，于是整条数组绕过校验：`ancient_token` 靠这条缝隙指着不存在的物品，
     *      发奖照发、玩家拿到一条查不出名字的背包行；放大扫描后同一缝隙又抓到 beast_invasion 的三枚伏妖令
     *      （全场广播的结算摘要里印的就是裸键）—— 这类引用不是孤例。
     *   4. 数组元素的主键不止 `key`：`{item_key}`、`{item_id}`、`{id}`（钓鱼奖池）都真实在用。
     *   5. 名字本身就是物品的裸数组：`choices[].items_granted`、`alchemy.supported_pills`；
     *      以及**只在数组元素里**才算引用的 `material`（洞府设施升级扣的材料）。
     * 路径不带下标（豁免表与分类账都要能写稳定路径，数组换个顺序不该让结论失效）。
     *
     * @param {(at:string, item:any)=>void} onRef 每个引用调用一次；at 是稳定路径
     */
    _walkItemRefs(onRef) {
        // 两种"名字本身已经说明它是物品"的写法是 2026-09-22 实测补进来的，每一条都对得上消费端：
        //   · items_granted —— 多人副本抉择（MultiDungeonService:1274 直接 grantItems(choice.items_granted)）
        //   · supported_pills —— 掌天瓶炼丹白名单（ArtifactDeepLineService:2314 按它收丹）
        //   · fragment_required —— 大衍层级要的残片（DayanService:119 拿它当 item_key 扣背包）
        // 这些以前完全绕过存在性校验：键写错没有任何信号，表现是"玩家点了才扣不下来/发不出去"。
        const pattern = /^(item_key|item_id|material_key|fragment_required|[a-z_]+_item_key|[a-z_]+_item_id|item_pools?|[a-z_]+_item_pools?|items_granted|supported_pills)$/;
        // `material` 单独一档，而且**只认数组元素里的那种**（洞府五种设施的 `upgrade_costs[]{material, material_count}`，
        // CaveService:286 按它 removeItem）。同一个词当普通键用是别的东西 —— 现网
        // `game_balance.item_types.material = "材料"` 是物品类型的中文标签表，一律按物品引用扫就会在启动期
        // 抛一句谁也看不懂的"材料不是物品"（这条红是真信号：判据太宽，不是内容坏了 —— 收窄判据而不是加豁免）。
        const arrayElementPattern = /^material$/;
        // 元素主键可以是 key / item_key / item_id / id —— `items[].id` 这种写法现网只有钓鱼的
        // function_item_pools 在用。认多一种的代价是**假红**（将来某个"不是物品的 items[].id"被判成引用，
        // 会被看见、能改判据）；认少一种的代价是**假绿**（引用了不存在的物品，玩家撞上才炸，没人看见）。
        // 这类形状判据一律往"宁多勿漏"偏。
        const itemArrayField = /^(items|item_drops|drop_items|rewards_items|function_item_pools)$/;
        const elementKeyFields = ['key', 'item_key', 'item_id', 'id'];
        /** 已经被"元素主键"认过账的那些行（对象身份），整棵子树不再当普通字段扫第二遍 */
        const claimedRows = new Set();

        const walk = (node, where, depth, inArray = false) => {
            if (depth > MAX_ITEM_REF_DEPTH || node == null || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                const at = `${where}.${key}`;
                // 这一行已经被"元素主键"那条判据认过账了（下面 itemArrayField 分支会登记），
                // 再按普通字段扫一遍就会把同一处引用报两条：`items[].item_key` 与 `items.0.item_key`。
                if (claimedRows.has(value)) continue;
                if (pattern.test(key) || (inArray && arrayElementPattern.test(key))) {
                    const list = Array.isArray(value) ? value : [value];
                    for (const item of list) onRef(at, item);
                    // 刻意不 continue：字段名像物品池、值却是**对象**的写法真实存在
                    // （`fishing_data.function_item_pools = {chance_per_success, items:[{id}…]}`），
                    // 一 continue 就把整棵子树放过了 —— 里面的 `items[].id` 永远没人查。
                    // 值是字符串/字符串数组时递归是空转（下面对非对象直接 return），不会重复报。
                }
                if (itemArrayField.test(key) && Array.isArray(value)) {
                    for (const row of value) {
                        // 数组元素直接就是物品 id（历练事件的 rewards.items: ['spirit_herb']）。
                        // 以前只认对象元素，于是整条数组绕过校验：`ancient_token` 靠这条缝隙指着不存在的物品，
                        // 发奖照发、玩家拿到一条查不出名字的背包行；放大扫描后同一缝隙又抓到 beast_invasion
                        // 的三枚伏妖令（全场广播的结算摘要里印的就是裸键）—— 这类引用不是孤例。
                        if (typeof row === 'string') { onRef(`${at}[]`, row); continue; }
                        if (!row || typeof row !== 'object') continue;
                        const field = elementKeyFields.find(f => typeof row[f] === 'string' && row[f]);
                        // 认到元素主键就到此为止、不再递归这一行：否则同一处引用会被报两遍
                        // （`items[].item_key` 与 `items.0.item_key`），判据自己变吵。
                        // 索引不进"已认账"的那条路径：豁免表与分类账要写得出稳定路径，
                        // 数组换个顺序不该让结论失效。
                        if (field) { onRef(`${at}[].${field}`, row[field]); claimedRows.add(row); continue; }
                    }
                }
                walk(value, at, depth + 1, Array.isArray(node));
            }
        };

        for (const [dataset, data] of this.datasets.entries()) {
            if (dataset === 'item_data') continue;      // 物品表自己不算引用方
            walk(data, dataset, 0);
        }
    }

    /**
     * 反向清单：`稳定路径 → 这条路径引用到的物品 id 集合`。
     * 给"每件物品都要有获取来源"那本账用（tests/ItemSourceCoverage.test.js）——
     * 账判的是**路径**（`drop_data.drops[].drops[].item_id` 是来源、
     * `crafting_data.recipes[].materials[].item_key` 是消耗），所以不能只给一个物品 id 集合。
     * @returns {Map<string, Set<string>>}
     */
    itemReferenceIndex() {
        const index = new Map();
        this._walkItemRefs((at, item) => {
            if (typeof item !== 'string' || !item) return;
            if (!index.has(at)) index.set(at, new Set());
            index.get(at).add(item);
        });
        return index;
    }

    /**
     * 物品品质词表（`game_balance.item_qualities`）—— 档名/颜色/排序的唯一来源。
     *
     * 为什么单独一道闸：品质以前没有归属，每个面板自己抄一份"品质 → 中文名 + 颜色"字典。
     * 实测 9 个玩家面板各抄一份、其中 6 份漏了 `mythic` → 现网 45 件神话档物品（补天丹、
     * 玄天斩灵剑、有生不增丹…）在背包/当铺/装备/炼器/世界聊天里被印成「普通」或「凡品」，
     * 并且三套叫法并存（普通/非凡 vs 凡品/灵品 vs 普通/精良）。把词表放进内容之后：
     *   · 资料片加一档 = 写一条数据（这张表登记成 map 集合）；
     *   · 写错一档（`mythical`、`gold_3`）当场抛 —— 以前只会静默退回最低档色，谁也看不出；
     *   · 色令牌只有六个（客户端一处映射成 Tailwind 类），所以"加一档"不必动前端，
     *     除非真要一种全新颜色（那是一次映射，不是九份抄写）。
     */
    _validateItemQualities() {
        const table = this.datasets.get('game_balance')?.item_qualities;
        if (!isPlainObject(table)) return;              // 没装这张表的合成基座不陪葬（optional）
        const keys = Object.keys(table).filter(k => !k.startsWith('_'));
        if (!keys.length) {
            throw new ContentError('game_balance.item_qualities 是空表 → 品质标签与颜色没有来源，面板只能各自抄一份（本轮就是来收这份抄写的）');
        }
        const TONES = ['neutral', 'jade', 'azure', 'violet', 'gold', 'crimson'];
        const errors = [];
        const orders = new Map();
        for (const key of keys) {
            const entry = table[key] || {};
            if (!/^[a-z][a-z0-9_]*$/.test(key)) {
                errors.push(`item_qualities 的键 "${key}" 不是小写字母开头的 [a-z0-9_]`
                    + ' → FishingService 的排行榜把档名拼进 SQL 的 FIELD(...)，那条语句正是按这个正则过滤档名的：'
                    + '不合形的档在面板上看得见、在榜上永远不参与排序（一处可见一处静默，最难查的那种）');
            }
            const label = contentLabel(entry);
            if (!label) errors.push(`item_qualities.${key} 没有中文名 → 界面会把裸键印给玩家`);
            else if (label === key) errors.push(`item_qualities.${key} 的名字与键相同（"${label}"）→ 与漏写等价，界面仍在印裸键`);
            if (!TONES.includes(entry.tone)) {
                errors.push(`item_qualities.${key} 的 tone=${JSON.stringify(entry.tone)} 不是客户端认识的色令牌（${TONES.join('/')}）`
                    + ' → 这一档会退回默认色，玩家看不出它比别的档高');
            }
            const order = Number(entry.order);
            if (!Number.isFinite(order)) errors.push(`item_qualities.${key} 没有 order → 品质由低到高的排序没有依据`);
            else if (orders.has(order)) errors.push(`item_qualities.${key} 与 ${orders.get(order)} 的 order 都是 ${order} → 排序不确定`);
            else orders.set(order, key);
        }

        // 内容里用到的每个品质都必须在这张表里
        const declared = new Set(keys);
        const unknown = new Map();
        const missingQuality = [];
        for (const item of this.dataset('item_data')?.items || []) {
            const quality = item?.quality;
            if (quality === undefined || quality === null || quality === '') {
                missingQuality.push(String(item?.id));
                continue;
            }
            if (!declared.has(String(quality))) {
                if (!unknown.has(String(quality))) unknown.set(String(quality), []);
                unknown.get(String(quality)).push(String(item?.id));
            }
        }
        for (const [quality, list] of unknown) {
            errors.push(`有 ${list.length} 件物品的 quality="${quality}" 不在品质词表里（${list.slice(0, 3).join('/')}${list.length > 3 ? ' …' : ''}）`
                + ` → 面板只能退回兜底色与兜底名，可用键：${keys.join('/')}`);
        }
        // 别的内容按品质筛选/发放的地方（洞府遗宝只发指定几档）同样要认这套键
        const scanQualityLists = (node, at, depth) => {
            if (depth > 6 || node == null || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node)) {
                const where = `${at}.${key}`;
                // 档序镜像：内容里再写一份"从低到高的档名清单"就等于第二个真相 —— 词表长了它不跟着长。
                // 本轮删掉了 `game_balance.crafting.quality_float.quality_order` 与
                // `cave_data.cave.social.treasure_pavilion.quality_order`（两份都与词表逐字相同），
                // 两个消费点改成只问 `qualityOrder()`。要"只用其中几档"请写 `include_qualities`。
                if (key === 'quality_order' && Array.isArray(value)) {
                    errors.push(`${where} 抄了一份品质档序镜像（${JSON.stringify(value)}）`
                        + ` → 档序只有一个来源：game_balance.item_qualities 的 order（现网 ${keys.join('/')}）；`
                        + '留着这份镜像，资料片加一档时这里不会跟着长，那一档在炼制浮动/万宝阁排名里等于不存在');
                    continue;
                }
                if (key === 'include_qualities' && Array.isArray(value)) {
                    for (const quality of value) {
                        if (!declared.has(String(quality))) {
                            errors.push(`${where} 里的 "${quality}" 不是品质词表里的档（${keys.join('/')}）`
                                + ' → 这一档永远匹配不上，那块地/那个池子就发不出东西');
                        }
                    }
                    continue;
                }
                scanQualityLists(value, where, depth + 1);
            }
        };
        for (const [dataset, data] of this.datasets.entries()) {
            // game_balance 也要扫：那两份档序镜像里有一份就住在它的 crafting.quality_float 里。
            // 只把词表本身（item_qualities）摘掉 —— 它是唯一合法来源，不是镜像。
            const root = dataset === 'game_balance' && isPlainObject(data)
                ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'item_qualities'))
                : data;
            scanQualityLists(root, dataset, 0);
        }

        // 缺 quality 的物品：界面按最低档显示是存量事实，先点名成警告（棘轮在 tests/ItemQualityVocabulary.test.js）
        if (missingQuality.length) {
            this.report.warnings.push(`item_data 里 ${missingQuality.length} 件物品没有 quality 字段（${missingQuality.slice(0, 5).join('/')} …）`
                + ' → 面板按最低档显示；要定档就补数据');
        }
        // 「档名 → 一个数」的伴生参数表：词表长了、它没跟着长，就有一档在算钱时凭空少一份参数。
        // 消费端（PawnshopService）现在按词表档序取"不高于本档的最近一档"，所以缺档不再反向、也不再静默：
        // 这里把它点名进报告，要单独定价就在表里补一档。清单是按路径显式登记的，
        // 不按"键撞得上词表"猜 —— 灵兽稀有度那四档恰好也叫 common/rare/epic/legendary，
        // 按名字扫会把那张表误报成品质参数表（§31 那 83 条假引用同一个病）。
        for (const table of QUALITY_PARAMETER_TABLES) {
            const values = getPath(this.datasets.get(table.dataset), table.path);
            if (!isPlainObject(values)) continue;
            const coverage = qualityParamCoverage({ getConfig: name => this.datasets.get(name) }, values);
            for (const gap of coverage.missing) {
                this.report.warnings.push(`${table.dataset}.${table.path} 没有 "${gap.key}" 这一档的品质参数`
                    + `（消费者：${table.usedBy}）`
                    + (gap.inheritedFrom ? ` → 按档序继承 ${gap.inheritedFrom} 的参数值` : ' → 词表里比它低的档也都没有值，只能走代码兜底')
                    + '；要给这一档单独定价，就在这张表里补一键');
            }
        }
        if (errors.length) throw new ContentError(`物品品质词表校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 派生状态 + 全量校验：属性装进注册表、效果词表重建、四道引用/键名校验。
     * 启动期（load）和热更（reload）必须走同一个方法，否则"改基础配置"这条路径会绕过闸门：
     * 后台把一个拼错的属性键写进 item_data 时，表现不是报错而是玩家身上凭空少一份加成。
     */
    _refreshDerivedAndValidate() {
        this._loadStatsIntoRegistry();
        this._buildEffectVocabulary();
        this._validateItemEffects();
        this._validateElements();
        this._validateSpiritRootRoll();
        this._validateElementMatch();
        this._validateTechniqueGrades();
        this._validateFishingPonds();
        this._validateItemQualities();
        this._validateGardenSeeds();
        this._validateGatheringNodes();
        this._validateAdventureEvents();
        this._validateSkillEffects();
        this._validateReferences();
        this._validateItemKeysDeep();
        this._validateDropMonsters();
        this._validateBeastElements();
        this._validateBeastRarity();
        this._validateGamblingStone();
        this._validateCompanionVoyage();
        this._validateItemEffectApplication();
        this._validatePuppetBlueprints();
        this._validateTechniqueAcquire();
        this._validateRealmChain();
        this._validateCombatStatBlocks();
        this._validateDungeonChoiceVars();
        this._validateDungeonVariableLabels();
        this._validateDungeonRewardTypeLabels();
        this._validateArtifactSpiritLabels();
        this._validateSectBonusLabels();
        this._validateFormationVocabulary();
        this._validatePlayerMetrics();
        this._validateAchievementRewards();
        this._validateAchievementCategories();
        this._validateTitleGrants();
    }

    /**
     * 器灵类型的展示元数据必须齐：加成键要有中文名，护主/催发效果要有标签与换算方式。
     *
     * 为什么算闸：面板以前自己抄了一份 4 档器灵的文案（连数值都抄成文本，如"攻击 +5%（每级 +2%）"）。
     * 内容改数值或加一档，界面不会跟着变 —— 抄的那份平灵型就已经漏了"暴击 +1%"。
     * 现在文案由服务端按内容数值拼（`ArtifactSpiritService.spiritTypeCatalog`），缺标签只能在这里响。
     */
    _validateArtifactSpiritLabels() {
        const data = this.datasets.get('artifact_spirit_data');
        const types = data && data.spirit_types;
        if (!types || typeof types !== 'object') return;
        const statLabels = data.spirit_bonus_stat_labels || {};
        const effectLabels = data.spirit_effect_labels || {};
        const errors = [];
        for (const [key, cfg] of Object.entries(types)) {
            for (const field of ['base_bonus', 'level_bonus_per_level']) {
                for (const stat of Object.keys((cfg && cfg[field]) || {})) {
                    if (!contentLabel(statLabels[stat])) {
                        errors.push(`spirit_types.${key}.${field} 的加成键 ${stat} 没有中文名（spirit_bonus_stat_labels）`);
                    }
                }
            }
            for (const field of ['protect_effect', 'activate_effect']) {
                const code = cfg && cfg[field];
                if (!code) continue;
                const meta = effectLabels[code];
                if (!contentLabel(meta)) {
                    errors.push(`spirit_types.${key}.${field}=${code} 在 spirit_effect_labels 里没有中文标签`);
                } else if (!['percent', 'none'].includes(meta.value_format)) {
                    errors.push(`spirit_types.${key}.${field}=${code} 的 value_format=${JSON.stringify(meta.value_format)}，只支持 percent/none`);
                }
            }
        }
        if (errors.length) {
            throw new ContentError(`器灵展示元数据校验失败:\n  - ${errors.join('\n  - ')}`);
        }
    }

    /**
     * 奖励条目的 type 必须有中文名：`multi_dungeon_data.global.reward_type_labels` 是奖励池
     * 显示名称的唯一来源（`_getRewardDisplayName` 只读这一份）。
     *
     * 为什么算闸：服务原来手写了一份 7 个类型的表，内容里第 8 种类型（sect_contribution）一出现，
     * 奖励池界面就把裸键名当奖励名印出来，而且没有任何异常 —— 只有启动期能钉住。
     */
    _validateDungeonRewardTypeLabels() {
        const data = this.datasets.get('multi_dungeon_data');
        const dungeons = data && data.dungeons;
        if (!dungeons || typeof dungeons !== 'object') return;
        const labels = (data.global && data.global.reward_type_labels) || {};
        const missing = new Set();
        const walk = (node, at) => {
            if (Array.isArray(node)) {
                for (const [i, row] of node.entries()) walk(row, `${at}[${i}]`);
                return;
            }
            if (!node || typeof node !== 'object') return;
            if (typeof node.type === 'string' && !contentLabel(labels[node.type])) missing.add(`${at} → ${node.type}`);
            for (const [key, value] of Object.entries(node)) {
                if (key === '_note') continue;
                if (value && typeof value === 'object') walk(value, `${at}.${key}`);
            }
        };
        for (const [key, dungeon] of Object.entries(dungeons)) walk((dungeon && dungeon.rewards) || {}, key);
        if (missing.size) {
            throw new ContentError(`副本奖励类型缺少中文标签（global.reward_type_labels）:\n  - ${[...missing].join('\n  - ')}`);
        }
    }

    /**
     * 宗门加成字段必须有展示元数据：`sect_data.global.bonus_labels` 是面板拿中文名与换算方式的唯一来源。
     *
     * 为什么算闸：客户端原来自己抄了一份 10 条字典，并且**按字典的键顺序去过滤** bonus ——
     * 内容里新增一种宗门加成而字典没跟上时，那行加成在面板上凭空消失，服务端与客户端都不报错。
     * 现在字典删了，缺元数据的后果仍然只会表现为"少一行"，所以只能在启动期钉。
     * format 只认两种：multiplier（1.1 → +10%）、ratio（0.15 → +15%）。
     */
    _validateSectBonusLabels() {
        const data = this.datasets.get('sect_data');
        if (!data) return;
        const labels = (data.global && data.global.bonus_labels) || {};
        const errors = [];

        for (const [key, meta] of Object.entries(labels)) {
            if (!contentLabel(meta)) {
                errors.push(`bonus_labels.${key} 没有中文 label`);
            } else if (!['multiplier', 'ratio'].includes(meta.format)) {
                errors.push(`bonus_labels.${key} 的 format=${JSON.stringify(meta && meta.format)}，只支持 multiplier/ratio`);
            }
        }

        const missing = new Set();
        for (const sect of (Array.isArray(data.sects) ? data.sects : [])) {
            for (const key of Object.keys((sect && sect.bonus) || {})) {
                if (!contentLabel(labels[key])) missing.add(key);
            }
        }
        if (missing.size) {
            errors.push(`sects[].bonus 用到了 bonus_labels 里没有的加成键：${[...missing].sort().join(', ')}`);
        }

        if (errors.length) throw new ContentError(`宗门加成展示元数据校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 玩家统计量词表自检（`player_metrics`）+ 成就引用的闭合性。
     *
     * 为什么这道闸必须在启动期：以前"成就度量怎么取数"是 `AchievementService.METRIC_SOURCES` 里
     * 一张代码表，而它点名的 `player.kill_count / meditation_count / exploration_count`
     * 根本不是 players 的列（计数住在 players.stats 那坨 JSON 里）→ 取到 undefined → 按 0 处理。
     * 结果是 **34 条成就里 14 条永远停在 0%**，接口照常返回"进度 0/5"，测试全绿、玩家什么也拿不到。
     * 词表搬到内容之后，引用是否成立只有在这里才问得出来（资料片加一档度量、加一条成就都要能问）。
     *
     * 判的六件事：
     *   1. 词表必须存在且非空（空表 = 所有成就度量都无从取值）；
     *   2. 每条 `from` 必须是认识的来源形状，且目标真的存在
     *      （`column.x` 得是 players 的列、`attr.x` 得是注册属性、`query.x` 得是代码侧注册过的查询）；
     *   3. 每条都得有中文名，且名字不许等于键（跟漏写等价）；
     *   4. `cumulative_command:true` 只能挂在 `stats.` 计数上（祖业求和只认次数）；
     *   5. 每条成就的 `metric` 必须在这张词表里（成就引用不存在的度量 = 那条成就永远不可能完成）；
     *   6. `pending_writer`（配了来源但代码还没人累加）必须写清理由，且理由不能是空话。
     */
    _validatePlayerMetrics() {
        const dataset = this.datasets.get('player_metrics');
        // 没有这份数据集 = 这套夹具/裁剪过的配置根本不玩成就（其它校验器同样直接 return）；
        // 但"文件在、表是空的"必须抛 —— 那是"配了但每条成就都无从取值"的现实形状。
        if (!dataset) return;
        const table = dataset.metrics;
        const achievements = this.datasets.get('achievement_data')?.achievements || [];
        const ids = Object.keys(table || {}).filter(k => !k.startsWith('_'));
        const errors = [];

        if (!ids.length) {
            throw new ContentError('player_metrics.metrics 读不到或为空表：'
                + '成就的 metric 全靠这张词表取数，空表意味着每条成就的进度都永远是 0');
        }

        const PlayerMetrics = require('../stats/PlayerMetrics');
        // 列清单从 PlayerMetrics 那边要（它才是"这档度量从哪读"的负责人），这里不直接摸模型
        const columns = new Set(PlayerMetrics.playerColumns());
        const registry = this._statRegistryForValidation();
        const queries = new Set(Object.keys(PlayerMetrics.QUERIES));
        const writers = statWriterCalls();

        for (const id of ids) {
            const spec = table[id] || {};
            const label = contentLabel(spec.label);
            if (!label) errors.push(`metrics.${id} 没有 label → 后台/界面只能印裸键`);
            else if (label === id) errors.push(`metrics.${id} 的 label 与键相同（"${label}"）→ 与漏写等价`);

            const from = String(spec.from || '');
            const dot = from.indexOf('.');
            const kind = dot < 0 ? from : from.slice(0, dot);
            const key = dot < 0 ? '' : from.slice(dot + 1);
            if (!PlayerMetrics.sourceKinds().includes(kind)) {
                errors.push(`metrics.${id}.from="${from}" 不是认识的来源形状（可用：${PlayerMetrics.sourceKinds().join(' / ')}）`);
            } else if (kind === 'column' && !columns.has(key)) {
                errors.push(`metrics.${id}.from="${from}" 指着一个不存在的 players 列 → 取数永远 0（这正是当年 spirit_root 那个病的形状）`);
            } else if (kind === 'attr' && !registry.has(key)) {
                errors.push(`metrics.${id}.from="${from}" 里的 "${key}" 不是注册属性（stat_definitions 里查无此档）`);
            } else if (kind === 'query' && !queries.has(key)) {
                errors.push(`metrics.${id}.from="${from}" 指向未登记的查询，代码侧 PlayerMetrics.QUERIES 里没有 "${key}"`);
            } else if (kind === 'stats') {
                if (!/^[a-z][a-z0-9_]*$/.test(key)) {
                    errors.push(`metrics.${id}.from="${from}" 的计数键名不合法（只能小写字母数字下划线）`);
                } else if (spec.pending_writer !== undefined) {
                    // 豁免也要防自己过期：写入点补上了还留着这一格，就等于把这条闸又关回去了
                    if (writers.has(key)) {
                        errors.push(`metrics.${id}.pending_writer 已经失效：代码里现在有 bumpStat(..., '${key}') 的写入点，请删掉这一格`);
                    }
                } else if (spec.legacy_writer !== undefined) {
                    // 旧口径（整块回写 stats 的那一族）允许点名一个写入点，但**这句声明必须查得实**：
                    // 文件存在、且里面真的有 `<key> = …` 这一行。写个不存在的路径或写错键名都过不了，
                    // 于是"legacy_writer"不会变成第二个可以随便糊的理由。
                    const claimed = String(spec.legacy_writer);
                    const text = sourceTextOf(claimed);
                    if (writers.has(key)) {
                        errors.push(`metrics.${id}.legacy_writer 已经失效：这一格现在有 bumpStat(..., '${key}') 走统一入口了，请删掉 legacy_writer`);
                    } else if (text == null) {
                        errors.push(`metrics.${id}.legacy_writer="${claimed}" 指向的源码文件读不到（相对 server 根目录）`);
                    } else if (!new RegExp(`\\b${key}\\s*=(?!=)`).test(text)) {
                        errors.push(`metrics.${id}.legacy_writer="${claimed}" 里找不到对 ${key} 的赋值行 → `
                            + '这一档统计量今天到底谁在写？（要么点名真正的文件，要么改走 bumpStat，要么写 pending_writer）');
                    }
                } else if (!writers.has(key)) {
                    errors.push(`metrics.${id}.from="${from}" 指向 stats.${key}，但 game/ 与 routes/ 里没有任何 bumpStat(..., '${key}') 调用点 → `
                        + '这一档统计量永远取到 0（配了没人写，正是 spirit_root 那一族成就空转的形状）。'
                        + '三条出口选一：在事件点补一行 bumpStat；旧口径整块回写的就点名 legacy_writer（会被查证）；'
                        + '确实还没写入点则写 pending_writer 说明为什么');
                }
            }

            if (spec.cumulative_command === true && !from.startsWith('stats.')) {
                errors.push(`metrics.${id} 标了 cumulative_command:true 但来源是 "${from}"：祖业"总修行次数"只累加 stats 里的计数`);
            }
            if (spec.pending_writer !== undefined
                && (typeof spec.pending_writer !== 'string' || spec.pending_writer.length < 15)) {
                errors.push(`metrics.${id}.pending_writer 必须写清"为什么还没有事件往它累加"（现在这段不算理由）`);
            }
            if (spec.pending_writer !== undefined && spec.legacy_writer !== undefined) {
                errors.push(`metrics.${id} 同时写了 pending_writer 与 legacy_writer：`
                    + '到底是"还没有写入点"还是"有人在用旧口径写"？两句并存就等于谁也没说清，留一条');
            }
            // resets 这一格说的是"这个计数会不会自己变小"。切磋/决斗那两个是**当日**计数
            // （DuelService._resetDailyDuelCountIfNewDay / PvpService 的同名逻辑），
            // 不写出来的话，它读起来就像"累计次数"，而累计口径的成就永远达不成（见 _validateAchievementRewards）。
            if (spec.resets !== undefined && !METRIC_RESET_KINDS.includes(spec.resets)) {
                errors.push(`metrics.${id}.resets="${spec.resets}" 不是代码里真的存在的清零口径`
                    + `（可用：${METRIC_RESET_KINDS.join(' / ')}；要加一种新清零，先在写入点实现再登记到这里）`);
            }
        }

        for (const achievement of achievements) {
            if (!achievement || typeof achievement !== 'object') continue;
            const metric = achievement.metric;
            if (!ids.includes(String(metric))) {
                errors.push(`成就 ${achievement.id || '(无 id)'} 的 metric="${metric}" 不在 player_metrics 里 → `
                    + '这条成就没有任何代码能算它的进度（写错的键、删掉的度量都是这一种死法）');
            }
        }

        const usedQueries = new Set(ids.map(k => String(table[k].from || ''))
            .filter(f => f.startsWith('query.')).map(f => f.slice('query.'.length)));
        for (const name of queries) {
            if (!usedQueries.has(name)) {
                errors.push(`PlayerMetrics.QUERIES 里的 "${name}" 没有任何度量引用（要么补一条 metrics，要么把这个查询删掉）`);
            }
        }

        if (errors.length) throw new ContentError(`玩家统计量词表校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 成就奖励形状自检：`reward` 里**代码读不到的键 = 这一项永远发不出去**。
     *
     * 为什么单独一道闸：领奖励那段代码只认 `spirit_stones` / `exp` / `items` / `title_id` 四个键，
     * 而它读配置是 `Number(reward.xxx) || 0` 这种容错形状 —— 于是以前把物品写成 `reward.item`、
     * 把称号写成 `reward.title`（这两个名字最自然）时：成就页照常显示"奖励：… "、
     * 玩家照常领、回执照常 success、什么都不报错。这就是"内容配了但玩家拿不到"的第三种形状
     * （前两种：度量指向不存在的列 → 进度恒 0；引用了不存在的物品 → 发奖静默跳过）。
     * 现网 34 条成就全部只用灵石/修为（2026-09-22 量过：reward 键只有这两种），所以这条只拦以后写错的。
     *
     * 另外钉一条口径：成就是**领一次**的（player_achievements.claimed），所以它的进度不能来自
     * 每日重置的计数 —— 那种度量今天能到 3、明天回 0，写成 target=10 就是一条永远领不到的成就。
     */
    _validateAchievementRewards() {
        const achievements = this.datasets.get('achievement_data')?.achievements;
        if (!Array.isArray(achievements)) return;      // 夹具只喂了部分数据集，不做判定（宁可漏判也不误伤）
        const errors = [];
        const metrics = this.datasets.get('player_metrics')?.metrics || {};
        const categories = this.datasets.get('achievement_data')?.categories || {};
        const categoryIds = new Set(Object.keys(categories).filter(k => !k.startsWith('_')));

        for (const a of achievements) {
            if (!a || typeof a !== 'object') continue;
            const who = `成就 ${a.id || '(无 id)'}`;

            // 分组名必须落在 `categories` 里（那一格已登记成 map 集合，资料片可以自己加一档分组）。
            // 为什么这条要硬拦：列表页是 `categories[cat]?.name || cat` —— 写错一个键没有任何信号，
            // 那一组成就就在界面上顶着一个裸键（"explore" 当标题），而玩家只会以为那是名字。
            if (categoryIds.size && !categoryIds.has(String(a.category))) {
                errors.push(`${who} 的 category="${a.category}" 不在 achievement_data.categories 里 → `
                    + '成就页会把裸键印成分组标题。现有分组：' + [...categoryIds].join(' / ')
                    + '（categories 已是集合，资料片可以 `achievement_data__categories.json` 自己加一档）');
            }

            const metricSpec = metrics[a.metric];
            if (metricSpec && metricSpec.resets) {
                errors.push(`${who} 的度量 "${a.metric}" 标了 resets:"${metricSpec.resets}"（每日重置口径），`
                    + '而成就只能领一次 → target 一旦超过当日上限就永远达不成。'
                    + '要么换成累计口径的度量，要么给这一档统计量补一个不清零的累计键');
            }

            const reward = a.reward;
            if (reward === undefined || reward === null) continue;   // 纯成就（没有奖励）是合法配置
            if (!isPlainObject(reward)) {
                errors.push(`${who}.reward 必须是对象（现在是 ${JSON.stringify(reward)}）`);
                continue;
            }
            for (const key of Object.keys(reward)) {
                if (key.startsWith('_')) continue;
                if (!ACHIEVEMENT_REWARD_KEYS.includes(key)) {
                    errors.push(`${who}.reward.${key} 不是代码认识的奖励键（只有 ${ACHIEVEMENT_REWARD_KEYS.join(' / ')}）→ `
                        + '这一项永远发不出去，而成就页照样会把它显示成"有奖"，玩家领完什么也没多');
                }
            }
            for (const key of ['spirit_stones', 'exp']) {
                const value = reward[key];
                if (value === undefined || value === null) continue;
                if (!Number.isFinite(Number(value)) || Number(value) < 0) {
                    errors.push(`${who}.reward.${key}=${JSON.stringify(value)} 必须是有限的非负数（负数会被当成 0 发，写成字符串数字也行）`);
                }
            }
            if (reward.items !== undefined) {
                if (!Array.isArray(reward.items) || !reward.items.length) {
                    errors.push(`${who}.reward.items 必须是非空数组（至少一件；只发灵石/修为就别写这一格）`);
                } else {
                    for (const entry of reward.items) {
                        const key = typeof entry === 'string' ? entry
                            : (isPlainObject(entry) ? (entry.item_key ?? entry.item_id) : null);
                        if (!key) {
                            errors.push(`${who}.reward.items 里有一条既不是物品 id 字符串、也不是 {item_key, quantity}`);
                            continue;
                        }
                        // 物品 id 存不存在由 _validateItemKeysDeep 判（它先跑，且全仓只判一次）；
                        // 这里只管"代码拿不拿得到这一格"与数量形状，不重复别人的活 —— 两道闸判同一件事，
                        // 以后一道改了另一道没改，报错就会变得难以解释。
                        const qty = isPlainObject(entry) ? entry.quantity : undefined;
                        if (qty !== undefined && (!Number.isInteger(Number(qty)) || Number(qty) <= 0)) {
                            errors.push(`${who}.reward.items(${key}).quantity=${JSON.stringify(qty)} 必须是正整数`);
                        }
                    }
                }
            }
            if (reward.title_id !== undefined) {
                // 只判形状：这一格必须是能当 id 用的字符串。"这个 id 到底有没有一档称号"归
                // _validateTitleGrants（它一次看全仓所有发放路径，两边判同一件事只会让报错难以解释）
                if (typeof reward.title_id !== 'string' || !reward.title_id.trim()) {
                    errors.push(`${who}.reward.title_id 必须是 titles 里的称号 id（字符串），现在是 ${JSON.stringify(reward.title_id)}`);
                }
            }
        }
        if (errors.length) throw new ContentError(`成就奖励形状校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 成就分组词表（`achievement_data.categories`，已登记成 map 集合 —— 资料片可以自带一档分组）。
     *
     * 为什么要单独一道：成就页是**按分组渲染**的（客户端把 items 按 `category` 归堆，
     * 标题取 `categories[cat].name`、图标取 `.icon`），所以一档坏分组的表现是"那一堆成就在界面上没有一个名字"，
     * 而一条没人挂的分组则根本不会出现 —— 它是彻底的死内容（客户端遍历的是成就项，不是分组表）。
     * 现网 5 档全部有成就引用（2026-09-22 量过），所以这几条都可以直接硬拦。
     */
    _validateAchievementCategories() {
        const dataset = this.datasets.get('achievement_data');
        if (!dataset) return;
        const categories = dataset.categories;
        if (!categories || typeof categories !== 'object') return;      // 夹具只喂了 achievements 时不判
        const keys = Object.keys(categories).filter(k => !k.startsWith('_'));
        const achievements = dataset.achievements || [];
        const errors = [];

        if (achievements.length && !keys.length) {
            errors.push('achievement_data.categories 是空表而成就非空 → 每条成就在界面上都没有分组标题');
        }
        const used = new Set(achievements.map(a => a && String(a.category)));
        for (const key of keys) {
            const entry = categories[key];
            const label = contentLabel(isPlainObject(entry) ? (entry.name ?? entry.label) : entry);
            if (!label) errors.push(`categories.${key} 没有 name → 界面会把裸键 "${key}" 印成分组标题`);
            else if (label === key) errors.push(`categories.${key} 的 name 与键相同（"${label}"）→ 与漏写等价`);
            if (!used.has(key)) {
                errors.push(`categories.${key}（"${label}"）没有任何成就挂在下面 → 死分组：`
                    + '成就页是按成就项归堆渲染的，没人挂的分组根本不会出现。要么把成就归进去，要么删掉这一档');
            }
            // `color` 是本轮清掉的死字段：全仓没有任何一处读它（以前只是被转成出参里的 category_color，
            // 而客户端用的是自己那套 tone 令牌）。留着只会让人以为改这格能换颜色，而它值又是一份没管过的
            // Tailwind 颜色名清单 —— 想给分组上色的正确做法是加一档受控色令牌，不是往这里塞任意字符串。
            if (isPlainObject(entry) && entry.color !== undefined) {
                errors.push(`categories.${key}.color 没有人读（成就页的底色由客户端自己的 tone 令牌决定）→ `
                    + '删掉这一格；要真能配色，先加一档受控色令牌并让界面认得它');
            }
        }
        if (errors.length) throw new ContentError(`成就分组词表校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 称号发放账，两个方向都判：
     *   ① 发放路径指向的称号必须真的在 `titles` 里；
     *   ② 资料片新增的称号必须有至少一条发放路径。
     *
     * 为什么单独一道：`addTitleToInstance` 只判"字符串非空"，**不查这个词表**。于是内容里写一个
     * 不存在的称号 id 时，那条链照样把它写进 `players.titles`，而界面按 `titles.find(t => t.id === …)`
     * 取名、属性引擎第 40 站（providers 的 title 档）也按同一个 find 吃加成 —— 两边都查不到，
     * 玩家拿到的是一个查无此名的裸字符串，且没有任何地方报错。2026-09-22 实测：**副本/切磋的发放路径
     * 指着 10 档 titles 里根本不存在的称号**（掩月破阵者、封魔塔主、伏魔者…内容里还另抄了一份
     * `title_name` 镜像，所以看起来一切正常 —— 两个真相的典型）。
     * 反向（②）只硬拦资料片新增的：现网 33 档基础称号里 32 档今天没有任何发放路径，
     * 一次拦下来只会逼人把那 32 档删掉（把"补出口"变成"删内容"），所以存量交给
     * tests/TitleSourceCoverage.test.js 的棘轮盯（只许变小，且每条要写理由）。
     */
    _validateTitleGrants() {
        const titles = this.dataset('titles');
        if (!Array.isArray(titles) || !titles.length) return;     // 夹具只喂了部分数据集，不做判定
        const known = new Set(titles.filter(t => t && t.id).map(t => String(t.id)));
        const grants = this.titleGrantIndex();
        const errors = [];

        for (const [id, paths] of grants.entries()) {
            if (known.has(id)) continue;
            errors.push(`称号 "${id}" 被这些路径发给玩家（${[...paths].join(' , ')}），但 titles 里没有这一档 → `
                + '裸 id 会直接进 players.titles：称号列表查不到名字、属性引擎也吃不到加成，'
                + '而内容里另抄的那份 title_name 镜像会让它看起来正常');
        }
        // 镜像键：名字与说明只许住在 titles 里。发放路径旁边再抄一份 title_name / title_desc，
        // 两边之间没有任何约束（改一边另一边不报错），而结算文本与奖励预览读的偏偏是镜像 ——
        // 上面那条"引用了不存在的称号"能被盖住，就是被这份镜像盖住的（2026-09-22 实测 22 处，已清）。
        for (const mirror of this.titleMirrorPaths()) {
            errors.push(`${mirror} 又抄了一份称号名/称号说明镜像 → `
                + '名字与说明只有一个来源：titles[id].name / titles[id].description（出参那一刻按 game/content/titleNaming.js 现算）');
        }
        for (const entry of titles) {
            if (!entry || !entry.__content_origin) continue;       // 只看资料片新增的
            if (known.has(String(entry.id)) && grants.has(String(entry.id))) continue;
            errors.push(`资料片 ${entry.__content_origin} 新增的称号 "${entry.id}" 没有任何发放路径 → `
                + '玩家永远拿不到（死内容）。要么把它挂到一条发放链上（成就 reward.title_id、副本首通奖…），'
                + '要么别加这一档');
        }
        if (errors.length) throw new ContentError(`称号发放校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /** 内容里"称号引用旁边又抄一份名字/说明"的路径（镜像判据，见 _validateTitleGrants 里的注释） */
    titleMirrorPaths() {
        const found = [];
        const walk = (node, where, depth) => {
            if (depth > MAX_ITEM_REF_DEPTH || node == null || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                for (const item of node) walk(item, `${where}[]`, depth + 1);
                return;
            }
            const hasRef = typeof node.title === 'string' || typeof node.title_id === 'string';
            if (hasRef) {
                for (const mirror of ['title_name', 'title_desc']) {
                    if (node[mirror] !== undefined) found.push(`${where}.${mirror}`);
                }
            }
            for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`, depth + 1);
        };
        for (const [dataset, data] of this.datasets.entries()) {
            if (dataset === 'titles') continue;
            walk(data, dataset, 0);
        }
        return [...new Set(found)];
    }

    /**
     * `称号 id → 发放它的那条内容路径（点名哪个服务按它发货）`。
     * 判据取自 `TITLE_GRANT_PATHS`（只认代码真读的字段），不是"凡叫 title 的都算" —— 见那份表上的注释。
     * @returns {Map<string, Set<string>>}
     */
    titleGrantIndex() {
        const index = new Map();
        const walk = (node, where, depth) => {
            if (depth > MAX_ITEM_REF_DEPTH || node == null || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                for (const item of node) walk(item, `${where}[]`, depth + 1);
                return;
            }
            for (const [key, value] of Object.entries(node)) {
                const at = `${where}.${key}`;
                if ((key === 'title' || key === 'title_id') && typeof value === 'string' && value) {
                    const matched = TITLE_GRANT_PATHS.find(path => path.re.test(at));
                    if (matched) {
                        if (!index.has(value)) index.set(value, new Set());
                        index.get(value).add(matched.by);
                    }
                }
                walk(value, at, depth + 1);
            }
        };
        for (const [dataset, data] of this.datasets.entries()) {
            if (dataset === 'titles') continue;                    // 称号表自己不是发放方
            walk(data, dataset, 0);
        }
        return index;
    }

    /**
     * 阵法词表自检：`global.category_display_names` / `global.grade_display_names` 的键
     * **就是合法流派与合法品级的全集**（`FormationService.formationCategories()` 直接取键，
     * 路由据此挡"对手流派"参数），所以每一条都必须有名字、每个阵法的声明都必须落在词表里。
     *
     * 为什么和装备槽位那道闸同族：阵法的 `category` 写错时没有任何运行期信号 ——
     * 列表页用 `contentLabel(表[category], 兜底=裸键)` 把 `sword_school` 这种键直接印给玩家，
     * 而它同时不在合法集里，于是这个阵法**永远选不到、也永远不被相克命中**（相克表两边比的都是词表里的键）。
     * 现网 12 个阵法 + 4 条相克全部合规（2026-09-22 先量过爆炸半径才上硬拦），所以这条只拦以后写错的。
     */
    _validateFormationVocabulary() {
        const data = this.datasets.get('formation_data');
        if (!data) return;
        const global = data.global || {};
        const pick = (dict) => Object.keys(dict || {}).filter(k => !k.startsWith('_'));
        const categories = pick(global.category_display_names);
        const grades = pick(global.grade_display_names);
        const errors = [];

        if (!categories.length || !grades.length) {
            throw new ContentError('formation_data.global 的流派/品级词表读不到或为空：'
                + '合法流派全集为空意味着任何阵法对战参数都会被拒，而阵法列表页会全部印成裸键名');
        }
        for (const [table, dict, list] of [
            ['category_display_names', global.category_display_names, categories],
            ['grade_display_names', global.grade_display_names, grades]
        ]) {
            for (const key of list) {
                const label = contentLabel(dict[key]);
                if (!label) {
                    errors.push(`global.${table}.${key} 没有中文名 → 界面会把 "${key}" 直接印给玩家`);
                } else if (label === key) {
                    // 名字与键相同等于没名字：读取端的兜底就是键名，这样写谁也不知道自己看不到中文名
                    errors.push(`global.${table}.${key} 的名字与键相同（"${label}"）→ 与漏写等价，界面仍在印裸键`);
                }
            }
        }

        const formations = Array.isArray(data.formations) ? data.formations : [];
        for (const formation of formations) {
            if (!formation || typeof formation !== 'object') continue;
            const id = formation.id || formation.name || '(无 id)';
            if (!formation.category) {
                errors.push(`阵法 ${id} 没有 category → 它进不了任何流派筛选，也不参与相克`);
            } else if (!categories.includes(formation.category)) {
                errors.push(`阵法 ${id} 的 category="${formation.category}" 不在流派词表里 → 永远选不到、`
                    + `相克也不命中（合法值：${categories.join('/')}）`);
            }
            if (!formation.grade) {
                errors.push(`阵法 ${id} 没有 grade`);
            } else if (!grades.includes(formation.grade)) {
                errors.push(`阵法 ${id} 的 grade="${formation.grade}" 不在品级词表里（合法值：${grades.join('/')}）`);
            }
        }

        // 相克表刻意**没有**登记成集合（它的值是"流派→流派"的引用，登记成 map 集合会把引用变成对象，
        // counterMap[a] === b 就永远不成立 —— 那是又造一个"配了不生效"）。所以这里逐条查引用。
        const counters = global.counter_relationships || {};
        for (const [attacker, defended] of Object.entries(counters)) {
            if (attacker.startsWith('_')) continue;
            if (!categories.includes(attacker)) {
                errors.push(`counter_relationships 的键 "${attacker}" 不是合法流派 → 这一行相克永远不生效`);
            }
            for (const target of (Array.isArray(defended) ? defended : [defended])) {
                if (typeof target === 'string' && !categories.includes(target)) {
                    errors.push(`counter_relationships.${attacker} 指向 "${target}"，但它不是合法流派 → 这一行相克永远不生效`);
                }
            }
        }

        if (errors.length) throw new ContentError(`阵法词表校验失败:\n  - ${errors.join('\n  - ')}`);
    }

    /**
     * 副本变量必须有中文名：面板的外发清单与标签是同一份内容（`global.variable_labels`），
     * 少了标签不会报错给玩家，只会"这个变量永远不显示"——服务算得再对也没人看得见。
     */
    _validateDungeonVariableLabels() {
        const data = this.datasets.get('multi_dungeon_data');
        const dungeons = data && data.dungeons;
        if (!dungeons || typeof dungeons !== 'object') return;
        const global = (data.global && data.global.variable_labels) ? data.global : {};
        const labels = global.variable_labels || {};
        // "通用变量"的判据用内容自身：global 里写了 <变量>_min / <变量>_max 的那六个（士气/警戒/魔染/封印/神魂/收获倍率）
        const common = new Set(Object.keys(global)
            .filter(key => /_min$|_max$/.test(key))
            .map(key => key.replace(/_min$|_max$/, '')));

        const declared = new Set();
        for (const dungeon of Object.values(dungeons)) {
            for (const key of Object.keys(dungeon || {})) {
                if (key.startsWith('init_')) {
                    const name = key.slice('init_'.length);
                    if (common.has(name)) declared.add(name);
                }
            }
            for (const column of Object.keys(dungeon.instance_vars || {})) declared.add(column);
        }
        const missing = [...declared].filter(name => !contentLabel(labels[name]));
        if (missing.length) {
            throw new ContentError(`副本变量缺少 variable_labels 标签（前端面板不会显示这些变量）：${missing.sort().join(', ')}`);
        }
    }

    /**
     * 多人副本：内容里写的"抉择变量键"必须能被这个副本自己声明的词汇解释。
     *
     * 起因是黄龙山（migration_0060）：内容按短名写（eye_position / resonance_count_change /
     * contribution_score_self_change），服务与抉择记录表按带前缀的列名读
     * （huanglong_eye_position / huanglong_resonance_count_change…），两边对不上时**不报错**，
     * 抉择接口照样返回成功，只是阵眼/共鸣/贡献/叛道全都不生效 —— 玩家看得到文案，看不到结果。
     *
     * 判据只用内容自身，不认识任何代码里的清单：把键去掉后缀得到词干，词干必须是
     *   ① 通用变量之一（由各副本的 `init_<变量>` 初值键推出），或
     *   ② 该副本 `instance_vars` / `member_vars` 声明过的列名（含带 `<副本名>_` 前缀的形式）。
     * 资料片要加新副本变量：在 instance_vars / member_vars 里声明即可，这条校验与服务侧
     * MultiDungeonService._canonicalizeVarKeys 用的是同一份词汇。
     */
    _validateDungeonChoiceVars() {
        const data = this.datasets.get('multi_dungeon_data');
        const dungeons = data && data.dungeons;
        if (!dungeons || typeof dungeons !== 'object') return;

        const SUFFIXES = ['_others_change_highest', '_self_change', '_others_change', '_change', '_self', ''];
        const common = new Set(Object.values(dungeons)
            .flatMap(dungeon => Object.keys(dungeon || {}))
            .filter(key => key.startsWith('init_'))
            .map(key => key.slice('init_'.length)));

        const problems = [];
        for (const [dungeonKey, dungeon] of Object.entries(dungeons)) {
            const declared = new Set([
                ...Object.keys(dungeon.instance_vars || {}),
                ...Object.keys(dungeon.member_vars || {})
            ]);
            const seen = new Set();
            const walk = node => {
                if (Array.isArray(node)) return node.forEach(walk);
                if (!node || typeof node !== 'object') return;
                for (const [key, value] of Object.entries(node)) {
                    if (typeof value !== 'object' && /_change$|_self$|_others$|_position$/.test(key) && !seen.has(key)) {
                        seen.add(key);
                        const suffix = SUFFIXES.find(s => key.endsWith(s) && key.length > s.length);
                        const stem = suffix === undefined ? key : key.slice(0, key.length - suffix.length);
                        if (!common.has(stem) && !declared.has(stem) && !declared.has(`${dungeonKey}_${stem}`)) {
                            problems.push(`${dungeonKey} 的抉择键 ${key}（变量 ${stem}）没有声明：既不是通用变量，也不在 ${dungeonKey} 的 instance_vars / member_vars 里`);
                        }
                    }
                    walk(value);
                }
            };
            walk(dungeon.acts);
        }
        if (problems.length) {
            throw new ContentError(`副本抉择变量词汇对不上（这些抉择会静默不生效）：\n  ${problems.join('\n  ')}`);
        }
    }

    /**
     * 基础配置被改写后重新合并一个数据集。
     * 校验不过时把这一份数据集退回上一版通过校验的视图再抛错——调用方（ConfigLoader）会
     * 连带把运行时缓存退回旧值，于是一次失败的编辑不会让线上突然看不到资料片内容。
     */
    reload(dataset) {
        const active = this.packs.filter(pack => pack.enabled);
        const hadPrevious = this.datasets.has(dataset);
        const previous = this.datasets.get(dataset);
        try {
            this._mergeDataset(dataset, active);
            this._refreshDerivedAndValidate();
            return this.dataset(dataset);
        } catch (error) {
            if (hadPrevious) this.datasets.set(dataset, previous);
            else this.datasets.delete(dataset);
            try {
                this._refreshDerivedAndValidate();   // 退回旧视图后，派生状态也要跟着复原
            } catch (rollbackError) {
                console.error(`[ContentRegistry] 回滚 ${dataset} 的派生状态失败:`, rollbackError.message);
            }
            throw error;
        }
    }

    isKnownEffectKey(key) {
        if (this._knownEffects.has(key)) return true;
        if (!this.statRegistry) return true; // 未接注册中心时不做属性校验
        return Boolean(this.statRegistry.resolveStatKey(key));
    }

    /** 通配效果（如 all_stats_bonus）在属性系统里展开为全部已注册属性 */
    wildcardEffectKeys() { return [...this._wildcards]; }

    /** 启动自检 / 后台展示用 */
    status() {
        const datasets = {};
        for (const [dataset] of this.datasets.entries()) {
            datasets[dataset] = this._entriesWithMeta(dataset).length;
        }
        return { packs: this.report.packs, datasets, warnings: this.report.warnings };
    }
}

/**
 * 称号发放路径：**只有这几条链真的会把一个称号 id 发给玩家**（每条点名哪个服务按它发货）。
 *
 * 为什么按路径认，而不是"凡是叫 title 的字段都当称号"：现网 `title` 这个名字同时被用来写
 * **章节/事件的显示标题**（`dungeon_data.chapters[].nodes[].title` = "入谷探秘"、
 * `adventure_event_data.events[].title`、赌石的 `level_titles`…），照字段名一律扫会得到
 * 83 条假引用（2026-09-22 实测），闸一开就等于把所有内容判成坏。清单外的 title 字段不算发放，
 * 于是新加一条发放链时要同时在这里登记 —— 那一次改动会顺带逼作者说清"谁按它发货"。
 */
const TITLE_GRANT_PATHS = [
    { re: /^multi_dungeon_data\.dungeons\.\w+\.rewards\.title$/, by: 'MultiDungeonService 完美通关按 title_chance 掷' },
    { re: /^multi_dungeon_data\.dungeons\.\w+\.rewards\.first_clear_bonus\[\]\.title_id$/, by: 'MultiDungeonService 首通成员奖' },
    { re: /^sparring_woodman\.global\.ranking_daily_reward\.\w+\.title$/, by: 'SparringService 切磋榜每日名次奖' },
    { re: /^sparring_woodman\.woodmen\[\]\.first_clear_bonus\.title$/, by: 'SparringService 首次击败木人' },
    { re: /^achievement_data\.achievements\[\]\.reward\.title_id$/, by: 'AchievementService.claimReward（2026-09-22 开的那条奖励口子）' }
];

module.exports = {
    ContentRegistry,
    ContentError,
    DATASET_SPECS,
    ACHIEVEMENT_REWARD_KEYS,
    METRIC_RESET_KINDS,
    statWriterCalls,
    TITLE_GRANT_PATHS,
    UNAPPLIED_ITEM_EFFECTS,
    UNAPPLIED_ITEM_EFFECT_EXCEPTIONS,
    BASE_EFFECT_VOCABULARY,
    REFERENCES,
    applyOps,
    contentLabel,
    contentNumber,
    contentList,
    contentRange,
    isPlainObject
};
