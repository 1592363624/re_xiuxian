/**
 * "哪些配置数据集资料片能扩展"的闭合清单（与整块列户口册同一套做法：棘轮 + 每条给结论）
 *
 * 目标里"方便扩展内容 / DLC 模式"这条，此前只能靠人记住：DATASET_SPECS 里登记了 43 个数据集，
 * config/ 下有 55 个 JSON，剩下那十几个到底是"故意不给资料片碰"还是"忘了登记"，
 * 代码里看不出来 —— 而"忘了登记"的表现形式很讨厌：资料片作者加了文件、合并没报错、玩家就是拿不到。
 *
 * 所以这里要求：config/ 下每个数据集要么在 DATASET_SPECS 里（可被资料片扩展），
 * 要么在本台账里写清**为什么不开放**。两类结论各有含义：
 *   vocabulary_authority —— 它是校验基准（元素/灵根权威表），资料片能改它就等于资料片能改校验规则
 *   balance_tuning_only  —— 它是数值/阈值中枢，改动属于平衡决策（要业主签字），不该由资料片顺手改
 *   not_content          —— 系统/前端/AI/上传等配置，根本不是玩法内容
 * 新增一个 config 文件而没给结论 = 红；把结论删掉而数据集仍未登记 = 红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { DATASET_SPECS } = require('../game/content/ContentRegistry');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const configNames = fs.readdirSync(CONFIG_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();

/**
 * 登记进 DATASET_SPECS 但 config/ 下**没有基础文件**的数据集：
 * 这类是"只由资料片提供"的词表扩展位 —— 基础效果词表在 `game/combat/skillEffects.js`（叶子模块），
 * 资料片若要把**非属性**的 effect 键登记成合法词表，就往 `<pack>/effect_vocabulary.json` 里写 effects 数组
 * （ContentRegistry 在算效果词表时读它）。这里点名允许，避免被"登记了就该有基础文件"的直觉误判成空转。
 */
const PACK_ONLY_DATASETS = {
    effect_vocabulary: '非属性效果键的资料片登记位；权威基础词表在 game/combat/skillEffects.js'
};

/** 不开放给资料片的配置 + 为什么（2026-09-21 逐个看过） */
const NOT_PACKABLE = {
    system_log_viewer: {
        verdict: 'not_content',
        reason: '后台日志查看器的读取白名单（sources 是服务端日志文件名、allowed_extensions、limits/live）——'
            + '这是安全边界配置而不是玩法内容：开放给资料片等于让内容包决定服务端能读哪些文件。'
            + '（2026-09-22 这条由内容体检的扩展台账补上：文件是当轮新出现的，门禁要求"每个未登记数据集都要有结论"）'
    },
    notification_policy: {
        verdict: 'not_content',
        reason: '通知的可见性、定时发布、重提示与留存策略（阈值/周期/文案），属于后台系统行为配置，'
            + '不是玩家可获得的内容；开放给资料片只会让内容包顺手改推送节奏'
    },
    ai_config: {
        verdict: 'not_content',
        reason: 'LLM/模型与密钥配置：不是玩法内容，开放给资料片等于让内容包能改运行时 AI 设置'
    },
    announcement_upload: {
        verdict: 'not_content',
        reason: '公告配图上传的大小/格式/清理策略，属于后台系统配置而非内容条目'
    },
    attribute_system: {
        verdict: 'balance_tuning_only',
        reason: '属性系统自身的数值表（加点/祭炼等系数）。属性**词表**在 stat_definitions（资料片可扩），'
            + '这张是数值中枢：改它等于改平衡，要业主签字而不是资料片顺手改'
    },
    auction_data: {
        verdict: 'balance_tuning_only',
        reason: '拍卖行的手续费/延时/并发上限等阈值，全是数值没有条目数组；资料片加不了"新拍卖内容"，'
            + '开放进去只会被用来悄悄改经济平衡'
    },
    cave_legacy_data: {
        verdict: 'balance_tuning_only',
        reason: '坐化遗府的时长/参与人数/份数等阈值集合（分宝内容由 item_data / drop_data 提供，那两个已开放）'
    },
    dao_companion_data: {
        verdict: 'balance_tuning_only',
        reason: '道侣/心魔契约的门槛与每级效果数值。目前无"新增契约类型"的内容需求；'
            + '真要加新契约类型时先登记进 DATASET_SPECS 并补启动期校验，再动这条结论'
    },
    // game_balance 不再出现在这份清单里：它已经**部分**登记进 DATASET_SPECS，只开了
    // `equipment.slot_names` 这一条嵌套路径（其余段落没登记，pack 写进去会被"没有该集合"当场挡下）。
    // 为什么要开这一条：它是装备槽位的词表，而"槽位"以前是一份裸字符串数组（valid_slots），
    // 不能按条增删 —— 于是资料片加得了新装备（item_data 是集合）、装得上（player_equipment.slot 是
    // STRING(20) + uk_player_slot，新槽位不需要改表），唯独"这个槽位合法吗/它叫什么"没有可扩展落点，
    // 那件新装备会被启动自检判成"永远穿不上的死内容"。这正是我 2026-09-22 给五行神光旗修 subtype 时撞到的墙。
    // 需求方：任何想加一档本命/旗/幡类槽位的资料片（本仓尚未有真的资料片用这条路 —— 开槽位是玩法决定，
    // 要业主点头；能力与判据在 tests/EquipmentSlotGate.test.js 最后一条用例里，用合成词表演示）。
    // 校验靠什么兜：EquipmentService.assertEquipableContent() —— 每件 type:'equipment' 的物品的 subtype
    // 必须在词表里且必须有中文名，否则启动就抛；槽位清单只有派生的一份（valid_slots 已从配置删除）。
    notification_icons: {
        verdict: 'not_content',
        reason: '通知图标与文案映射，属于展示层资源，不是玩家可获得的内容'
    },
    // role_init 不再是"整份不可扩"（2026-09-22）：登记了 spirit_roots（条目集合）与
    // spiritRootProbabilities / spiritRootBonuses（map 集合）。原来两条理由里，
    // "map 集合只支持对象值"那条已被 CollectionShapeLedger 实测否证；
    // "它是元素权威词表，开放给资料片等于让它改校验规则本身"这条**依然成立**，
    // 但方向反了：校验读的正是合并视图，所以"扩词表 + 用新元素写功法"这种合法组合不再被误拒，
    // 而"加了灵根漏了概率""加成键写错属性"这类会在启动期被 _validateSpiritRootRoll 拒掉。
    // 剩下 role_init 的标量段（initialAttributes / 各种成长率）没登记，写进 pack 会被"没有该集合"挡下。
    seclusion: {
        verdict: 'balance_tuning_only',
        reason: '闭关经验率/间隔/深度闭关参数，纯数值调参，没有条目集合可扩'
    },
    system: {
        verdict: 'not_content',
        reason: '系统级配置（名称/开关/维护），与内容无关'
    },
    admin_player_editor: {
        verdict: 'not_content',
        reason: 'GM 玩家编辑器的字段清单与校验边界：属于后台管理 UI 配置，开放给资料片等于让内容包改 GM 能改哪些玩家字段'
    },
    fengxi_curse: {
        verdict: 'balance_tuning_only',
        reason: '风希诅咒的触发阈值/时长/惩罚系数是运行时数值中枢，没有可按条扩展的内容集合；真要加新诅咒类型先登记 DATASET_SPECS'
    },
    trial_tower: {
        verdict: 'balance_tuning_only',
        reason: '试炼塔的层数门槛/奖励倍率/重置节奏是数值调参表，不是条目型内容；层数扩展应走业主签字的数值方案'
    },
    world_activity: {
        verdict: 'not_content',
        reason: '世界活动广播文案与限流策略：展示/推送配置，不是玩家可获得的内容条目；活动玩法本体在 world_boss / sect_war 等数据集'
    },
    ui_layout: {
        verdict: 'not_content',
        reason: '前端布局配置：客户端读它，不属于服务端内容层'
    },
    ui_routes: {
        verdict: 'not_content',
        reason: '前端路由/面板注册表：同上，改它需要发客户端，不是"加内容"'
    }
};

const ALLOWED_VERDICTS = ['vocabulary_authority', 'balance_tuning_only', 'not_content'];

describe('资料片可扩展数据集是闭合清单（不开放的必须写清为什么）', () => {
    test('检测范围是真的：config/ 下的数据集都读到了，DATASET_SPECS 也确实登记了一大片', () => {
        expect(configNames.length).toBeGreaterThanOrEqual(50);
        expect(Object.keys(DATASET_SPECS).length).toBeGreaterThanOrEqual(40);
        // 已登记的数据集要么有基础 config 文件，要么点名是"只由资料片提供"的扩展位。
        // 不允许"登记了但哪儿都读不到"—— 那种情况下依赖它的启动期校验会静默空转（本仓踩过：
        // 兽潮那条校验分支因为数据集没登记而永远读不到东西）。
        const orphans = Object.keys(DATASET_SPECS).filter(n => !configNames.includes(n) && !PACK_ONLY_DATASETS[n]);
        expect(orphans).toEqual([]);
    });

    test('每个未登记的数据集都有结论；每个结论都仍未登记（两边对得上）', () => {
        const unregistered = configNames.filter(n => !DATASET_SPECS[n]);
        const problems = [];
        for (const name of unregistered) {
            const entry = NOT_PACKABLE[name];
            if (!entry) {
                problems.push(`${name}.json 没登记进 DATASET_SPECS，也没有"为什么不开放"的结论 —— `
                    + '要么登记成可扩展数据集，要么在 NOT_PACKABLE 里写清理由');
                continue;
            }
            if (!ALLOWED_VERDICTS.includes(entry.verdict)) {
                problems.push(`${name} 的 verdict=${entry.verdict} 不在允许值里（${ALLOWED_VERDICTS.join('/')}）`);
            }
            if (!entry.reason || entry.reason.length < 12) problems.push(`${name} 的理由太短，看不出为什么`);
        }
        for (const name of Object.keys(NOT_PACKABLE)) {
            if (DATASET_SPECS[name]) {
                problems.push(`${name} 已经登记进 DATASET_SPECS 了 —— 把 NOT_PACKABLE 里那条结论删掉，`
                    + '并说明是哪个资料片需要它、开放后靠什么校验兜住');
            }
            if (!configNames.includes(name)) problems.push(`NOT_PACKABLE 里的 ${name} 在 config/ 下已不存在，清一下结论`);
        }
        if (problems.length) throw new Error(problems.join('\n'));
    });

    test('词表权威只能有一处：role_init 的灵根表没有被第二份定义取代', () => {
        // 这条守的是本轮之前定下的口径：元素词表以 role_init.spirit_roots[].type 为唯一权威。
        // 哪天有人把权威搬到别处（或改了列名），_validateElements 会静默放行不认识的元素，
        // 表现就是"资料片写了个 element 但五行克制永远不命中"。
        const role = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'role_init.json'), 'utf8'));
        const types = (role.spirit_roots || []).map(r => r.type).filter(Boolean);
        expect(types.length).toBeGreaterThanOrEqual(8);   // 五行 + 雷/冰/风
        expect(new Set(types).size).toBe(types.length);   // 名字不许重复
        const technique = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'technique_data.json'), 'utf8'));
        const conflicts = Object.keys(technique.element_match?.conflicts || {});
        const unknown = conflicts.filter(c => !types.includes(c) && c !== 'none');
        expect(unknown).toEqual([]);
        // 权威在合并视图上（资料片能扩），不是写死在基础文件里 —— 反过来读 _loadBase 就等于
        // "资料片加了新元素、校验却按旧词表拒收"，那是要修校验而不是骂内容
        const registry = fs.readFileSync(path.join(__dirname, '..', 'game/content/ContentRegistry.js'), 'utf8');
        const elementValidator = registry.slice(registry.indexOf('_validateElements() {'), registry.indexOf('_validateElements() {') + 900);
        expect(elementValidator).toMatch(/this\.datasets\.get\('role_init'\)/);
        expect(elementValidator).not.toMatch(/_loadBase\('role_init'\)/);
    });
});
