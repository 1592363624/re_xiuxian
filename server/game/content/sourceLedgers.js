/**
 * 内容可达性台账：一张表说清"哪些内容路径真的会把东西发到玩家手上"。
 *
 * 为什么要从测试里搬出来（2026-09-22）：这几张表原来各自活在 `tests/ItemSourceCoverage.test.js` 与
 * `tests/TitleSourceCoverage.test.js` 里。判据只活在测试里有两个后果 ——
 *   ① 生产代码/命令行报告想用同一条判据就只能再抄一份，两份一定漂移；
 *   ② 业主加内容时看不到账，只能靠 jest 的红字反推。
 * 搬过来之后：测试、启动闸、`scripts/content_health_report.js` 三方共读这一份。
 *
 * 表本身的规矩没变：**每条都要说得出"哪个服务按这条路径发货"**，说不出就是猜的，
 * 而猜的来源等于没有来源（会被判成死内容，或者更糟：把真死内容判成活的）。
 */
'use strict';

/**
 * 稳定路径归一：数组下标一律收成 `[]`。
 * 两种写法都要归一到同一个形状（`drops.0.drops` → `drops[]`），否则同一家族有两种路径键、表怎么写都判不到。
 */
function normalizeRefPath(at) {
    return String(at)
        .replace(/\.\d+(?=\.)/g, '.[]')
        .replace(/\.\d+$/, '.[]')
        .replace(/\.\[\]/g, '[]');
}

/** 物品来源路径（`why` 就是"谁按这条路径发货"） */
const ITEM_GRANT_PATHS = [
    { re: /^drop_data\.drops\[\]\.drops\[\]\.item_id$/, why: '普通怪掉落（战斗结算按这张表发）' },
    { re: /^drop_data\.boss_drops\[\]\.drops\[\]\.item_id$/, why: '首领掉落' },
    { re: /^dungeon_data\.chapters\[\]\.nodes\[\]\.rewards\.items\[\]\.item_key$/, why: '副本节点通关奖励' },
    { re: /^dungeon_data\.chapters\[\]\.nodes\[\]\.options\[\]\.rewards\.items\[\]\.item_key$/, why: '副本抉择分支奖励（深度 9，靠 MAX_ITEM_REF_DEPTH 才扫得到）' },
    { re: /^world_boss_data\.bosses\[\]\.drops\[\]\.item_key$/, why: '世界 Boss 掉落' },
    { re: /^spirit_beast_abyss_data\.floors\[\]\.drops\[\]\.item_id$/, why: '探渊逐层产出' },
    { re: /^spirit_beast_pasture_data\.pasture\.locations\[\]\.yield_items\[\]\.item_id$/, why: '兽栏圈养产出' },
    { re: /^multi_dungeon_data\.dungeons\.\w+\.rewards\.normal_drops\[\]\.item_key$/, why: '多人副本普通掉落' },
    { re: /^multi_dungeon_data\.dungeons\.\w+\.rewards\.rare_drops\[\]\.item_key$/, why: '多人副本稀有掉落' },
    { re: /^multi_dungeon_data\.dungeons\.\w+\.rewards\.rare_drops_by_contribution\.drops\[\]\.item_key$/, why: '多人副本按贡献的稀有掉落' },
    { re: /^multi_dungeon_data\.dungeons\.\w+\.acts\[\]\.choices\[\]\.items_granted$/, why: '多人副本抉择直接 grantItems（裸 id 数组：整条数组共用一条路径）' },
    { re: /^beast_invasion_data\.beasts\[\]\.rewards\.top_3\.items\[\]$/, why: '兽潮前排奖励（donation_items 是投入，不算来源）' },
    { re: /^cave_data\.cave\.social\.merchant\.items\[\]\.item_key$/, why: '洞府商人出售' },
    { re: /^cave_data\.cave\.garden\.seeds\[\]\.produce_item_id$/, why: '药园收获' },
    { re: /^cave_data\.cave\.social\.treasure_hunt\.results\.treasure\.item_pool$/, why: '洞天寻宝奖池' },
    { re: /^resource_data\.resource_yields\[\]\.item_id$/, why: '采集产出（节点必须挂在地图上，由 _validateGatheringNodes 双向判）' },
    { re: /^crafting_data\.(alchemy|refining)_recipes\[\]\.product\.item_key$/, why: '炼丹/炼器产出（materials 是去路）' },
    { re: /^sect_data\.sects\[\]\.treasury\[\]\.item_key$/, why: '宗门宝库兑换' },
    { re: /^border_military_data\.military_shop\.items\[\]\.key$/, why: '慕兰战线军需铺' },
    { re: /^border_military_data\.support_routes\.\w+\.item_drops\[\]\.key$/, why: '战线支援路线掉落' },
    { re: /^border_military_data\.beast_patrol\.routes\.\w+\.item_drops\[\]\.key$/, why: '妖兽巡边掉落' },
    { re: /^border_military_data\.remnant_map\.explore\.item_drops\[\]\.key$/, why: '残图探索掉落' },
    { re: /^border_military_data\.milestones\.thresholds\[\]\.rewards\.items\[\]\.key$/, why: '战线里程碑奖励' },
    { re: /^gambling_stone_data\.yield_pools\.[\w.]+\[\]\.item_id$/, why: '赌石开石产出' },
    { re: /^fishing_data\.function_item_pools\.items\[\]\.id$/, why: '钓鱼功能池（元素主键只有 id）' },
    { re: /^adventure_event_data\.events\[\]\.rewards\.items\[\]$/, why: '历练事件奖励（裸 id 数组）' },
    // 成就奖励从 2026-09-22 起才真的发东西：AchievementService.claimReward 里 reward.items 走 grantItems
    // （同一事务，装不下整笔回滚）。在那之前这两条形同虚设 —— 所以这张表什么时候能加一条，
    // 取决于代码那边有没有真的读它，而不是内容里有没有写。
    { re: /^achievement_data\.achievements\[\]\.reward\.items\[\]\.item_key$/, why: '成就奖励（对象形，带 quantity）' },
    { re: /^achievement_data\.achievements\[\]\.reward\.items\[\]$/, why: '成就奖励（裸 id 数组形，按一件算）' }
];

/** 刻意**不算**来源的形状：它们是"玩家交出去"或"学习前置"，写在这里是为了下次别再当来源算 */
const ITEM_SINK_PATHS = [
    { re: /^crafting_data\.(alchemy|refining)_recipes\[\]\.materials\[\]\.item_key$/, why: '丹方/器方的材料 = 去路' },
    { re: /^cave_data\.cave\.facilities\.\w+\.upgrade_costs\[\]\.material$/, why: '洞府升级扣的材料 = 去路' },
    { re: /^artifact_deep_lines\.settings\.\w+\.blood_pact\.stages\[\]\.materials\[\]\.item_key$/, why: '血祭阶段材料 = 去路' },
    { re: /^dayan_data\.levels\[\]\.fragment_required$/, why: '大衍层级要的残片 = 去路' },
    { re: /^beast_invasion_data\.beasts\[\]\.donation_items\[\]\.item_key$/, why: '兽潮捐献 = 去路' },
    { re: /^technique_data\.techniques\.\w+\.acquire\.item_id$/, why: '功法要的那张卷：这张卷从哪儿掉是 drop 表的事，这一条本身是消耗' }
];

/**
 * 零来源称号的存量名单（`#31` 那本账）。
 * 每条都必须写清"缺的是哪一种出口" —— 只列 id 等于把问题推给以后的人；
 * 名单本身**只许变小**（棘轮在 tests/TitleSourceCoverage.test.js）。
 */
const TITLE_UNREACHABLE_REASONS = {
    newbie: '条件写的是"注册账号"，而建号那一步没有任何代码发称号 → 要么建号时发（等于人手一份加成，等业主定），要么删这一档',
    slayer_king: '条件"击杀5000"，成就表里没有 5000 这一档（只有 1000/10000/50000）→ 要么补一条成就，要么把它挂到既有档上',
    wealth_nation: '条件"坐拥巨额财富"没写数字，与 wealth_10m / wealth_100m 都对不上 → 口径等业主定',
    thousand_battle: '条件"斗法百战百胜"要的是**累计**斗法数，而 duel_count 是当日清零计数（见 player_metrics 的 resets）→ 缺一个不清零的累计键',
    roamer: '条件"探索100处秘境"对应 explore_count，而那一档今天没有任何写入点（pending_writer 挂着）→ 与 #29 同一件待拍板事项',
    grand_alchemist: '现网没有任何"炼丹次数"成就（alchemy_count 有计数、成就表没用它）→ 要发这档就得先加一条炼丹成就',
    alchemy_grandmaster: '丹道"登峰造极"要的是炼丹成就的高段位，而成就表里今天没有炼丹这一档 → 出口与 grand_alchemist 是同一条：先补成就是这两档的前置',
    refining_sage: '炼器"登峰造极"同理：refining_count 有计数，成就表里只有第 6 套资料片那条 30 次的档',
    gathering_master: '采集 items_collected 有计数，但成就要按"件数"还是"次数"算属玩法口径，等业主定',
    beast_tamer: '御使灵兽没有对应的玩家度量（灵兽等级/品质要不要进 player_metrics 是新档统计量）',
    sword_heart: '"以剑证道"要的是装备/功法侧条件，当前词表里没有这一档统计量',
    demonic_overlord: '"魔功大成"同理（魔道功法线在 mo_da_blood_sutra 里，但玩家侧没有"魔功"度量）',
    righteous_path: '"持身极正"要的是道心值，而道心（dao_heart）今天不在这份词表里（只在坠魔谷的发放条件里当门槛用）',
    lone_cultivator: '"以散修之身登顶斗法"要的身份条件（无宗门）没有任何代码记录',
    heaven_favored: '"幸运资质冠绝同侪"要的是灵根/资质评级，词表里没有这一档（attr.luck 有，但那是后天值不是资质）',
    tribulation_survivor: '条件"踏入渡劫期"，成就表的 realm_index 档只到 35（大乘）与 40（真仙），中间缺渡劫那一档成就'
};

/**
 * "内容里写了但没人读"的字段台账：报告按这份表去数**当前还剩几处**，
 * 每一格都点名是哪道闸负责保证它为 0（判据不在这个模块里重复实现，只是引用出处）。
 */
const DEAD_CONTENT_FIELDS = [
    {
        id: 'achievement_category_color',
        label: 'achievement_data.categories.*.color',
        owner: 'ContentRegistry._validateAchievementCategories',
        why: '全仓没人读：唯一去处是被转成出参里的 category_color，而那个字段客户端也不读（界面用自己的 tone 令牌）。已删除并拦住再写。'
    },
    {
        id: 'title_name_mirror',
        label: '任意发放路径旁的 title_name / title_desc',
        owner: 'ContentRegistry._validateTitleGrants → titleMirrorPaths()',
        why: '镜像：名字与说明只有 titles 一个来源（这份镜像正是"副本在发不存在的称号"藏那么久的原因）。'
    },
    {
        id: 'legacy_writer',
        label: 'player_metrics.metrics.*.legacy_writer',
        owner: 'ContentRegistry._validatePlayerMetrics → statWriterCalls()',
        why: '只允许点名"仍在整块回写 players.stats"的文件且要查得到那行赋值；两处已迁到 setStatKeys，所以现网应为 0。'
    },
    {
        id: 'technique_grade_order',
        label: 'technique_data.grades.*.order',
        owner: 'ContentRegistry._validateTechniqueGrades（刻意不校验它）',
        pending: true,
        why: '品阶表登记成集合那天量到的：`getGradeConfig` 是唯一读取口，12 处消费读的是 name/color/max_layer/attr_coefficient/breakthrough_base_rate/proficiency_per_layer，没有一处读 order —— 品阶顺序实际靠键序。留着是因为"想按品阶排序"是个真需求（删了以后要重写回来），但它现在确实等于不存在：改这个值不会有任何效果。要么让它有人读，要么删 —— 这条是"登记在案、等拍板"，不算回潮。'
    }
];

module.exports = {
    normalizeRefPath,
    ITEM_GRANT_PATHS,
    ITEM_SINK_PATHS,
    TITLE_UNREACHABLE_REASONS,
    DEAD_CONTENT_FIELDS
};
