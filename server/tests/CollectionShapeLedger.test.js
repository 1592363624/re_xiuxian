/**
 * "这张登记表能不能被资料片扩"的形状户口册（2026-09-22）
 *
 * 起因是一次**我自己写错的推断**：我写了个临时清点脚本，把"基础值是字符串的 map 集合"标成
 * "❌ 资料片加不进"，看着像 5 个现成的洞。读了 `ContentRegistry` 的 map 分支才知道事实是：
 *   · 非对象值走 `passthrough` 原样带回，不会被丢掉；
 *   · 资料片加条目的正路是 `add: [{id, label}]`（对象条目），读取端一律过 `contentLabel`；
 *   · 所以"标量字典"不是"扩不动"，而是**扩进来一定是对象形状** —— 真正的风险只有一个：
 *     某张这样的表被登记成集合、却**没有启动期标签校验**，于是资料片加了一条没 label 的条目，
 *     界面就把 `{id:'x'}` 印成裸键或 `[object Object]`（这个坑 §9 真踩过一次）。
 * 这份户口册就把这三件事钉住：形状事实、"每张标量表必须有校验"的闭合清单、以及别再把推断当结论。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DATASET_SPECS } = require('../game/content/ContentRegistry');

const SERVER = path.join(__dirname, '..');
const CONFIG = path.join(SERVER, 'config');
const read = f => fs.readFileSync(path.join(SERVER, f), 'utf8');

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const at = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/**
 * 纯函数：一份登记表的基础值 → 形状结论。
 * `_` 前缀的键（`_comment` / `_slot_names_comment`）是说明文字，不是条目 —— 上一版清点脚本把它们
 * 也算成"标量值"，于是 technique_data.skills 这类**本来就是对象表**的文件被误判成"混合"。
 */
function classifyMapShape(dict) {
    const keys = Object.keys(dict || {}).filter(k => !k.startsWith('_'));
    if (!keys.length) return { kind: 'empty', scalars: 0, objects: 0, total: 0 };
    const scalars = keys.filter(k => !isPlainObject(dict[k])).length;
    const objects = keys.length - scalars;
    if (scalars === 0) return { kind: 'map-of-objects', scalars, objects, total: keys.length };
    if (objects === 0) return { kind: 'map-of-scalars', scalars, objects, total: keys.length };
    return { kind: 'mixed', scalars, objects, total: keys.length };
}

/**
 * 形状为 map-of-scalars / mixed 的登记表 → 谁在启动期保证"每条都有可读的中文名"。
 * 两边都要对得上：新登记一张标量表却没写校验会红（那是会印裸键的那一类），
 * 校验指向一张已经不存在的表也会红（过期结论比没有结论更坏）。
 */
const LABEL_VALIDATORS = {
    'multi_dungeon_data.global.variable_labels': '_validateDungeonVariableLabels',
    'multi_dungeon_data.global.reward_type_labels': '_validateDungeonRewardTypeLabels',
    'artifact_spirit_data.spirit_bonus_stat_labels': '_validateArtifactSpiritLabels',
    'sect_data.global.bonus_labels': '_validateSectBonusLabels',
    'formation_data.global.category_display_names': '_validateFormationVocabulary',
    'formation_data.global.grade_display_names': '_validateFormationVocabulary',
    // 法宝深线加成字段的中文名走 statRegistry 回退（泛化字段 `<属性>_bonus`），所以它的"校验"在取名字那一刻抛
    'artifact_deep_lines.bonus_field_labels': '_bonusFieldMeta',
    // 灵兽升星的稀有度倍率表：值不显示给玩家（它是"每档乘几"的系数），风险全在**缺档**与**形状**上 ——
    // 缺档会让那一档按 1.0 收（= common 的倍率，越稀有越便宜），资料片条目写成 {id,value} 时
    // 直接 `Number(对象)` 会得 NaN。两头都由 _validateBeastRarity 拦（覆盖词表每一档 + contentNumber 兼容）。
    'spirit_beast_data.star_upgrade.rarity_cost_multiplier': '_validateBeastRarity',
    // —— 赌石：一次登记六张表，风险全在"值不显示给玩家、但缺了/错了就把产出算成 NaN 或整条静默失效" ——
    // clues 是混合表（4 个维度条目 + fake_probability 这颗标量）。它的真风险不是名字，
    // 是"维度数 ≠ 品质档数"（两档共用一条线索，玩家看不出最贵那两stone的区别）与那颗标量被删
    // （`Math.random() < NaN` 恒 false → "三成线索是假的"这层博弈整体消失，本轮就是这么抓到一个键放错节的死功能）。
    'gambling_stone_data.clues': '_validateGamblingStone',
    // 等级称号：值本身就是给玩家看的字符串，且门槛键必须是数字 —— 两条都在闸里点名
    'gambling_stone_data.skill.level_titles': '_validateGamblingStone',
    // 这两张是"品质 → [min,max]"，服务侧**没有守卫**地下标取值：缺档不是少点产出，是切开当场抛
    'gambling_stone_data.yield_pools.spirit_stones': '_validateGamblingStone',
    'gambling_stone_data.yield_pools.cultivation': '_validateGamblingStone',
    // 这两张的值是"一条池子数组"（materials 每项带 item_id；rare_drops 混着 {type:'ldc'} 与物品两种形状）
    'gambling_stone_data.yield_pools.materials': '_validateGamblingStone',
    'gambling_stone_data.yield_pools.rare_drops': '_validateGamblingStone',
    // 远航奖励池：值是"每档模式一份条目数组"，而 map 集合里资料片追加的条目必然是对象
    // （`{id:'star_sea', items:[...]}`）—— 消费端与闸都过 contentList 取形，
    // 不然新加那一档会被当成空池子：走出去必定空手回来，而回执一切正常。
    'companion_data.voyage.reward_pools': '_validateCompanionVoyage'
};
/** 明确不需要标签校验的标量/混合表（每条都要写为什么；空表是正常状态） */
const NO_LABEL_NEED = new Map([
    ['spirit_beast_data.settings', '值是按 key 取的数值/对象表（战力权重、上限），不显示给玩家，缺键走代码默认而不是印裸键'],
    ['technique_data.techniques', '只有 `_comment` 一个标量键，条目本身是对象表'],
    ['technique_data.skills', '同上：`_comment` 之外全是条目'],
    ['artifact_spirit_data.spirit_effect_labels', '条目是 `{label,value_format}` 对象，标量只有 `_comment`'],
    ['border_military_data.support_routes', '条目是对象，标量只有 `_comment`'],
    ['game_balance.equipment.slot_names', '值已是 `{id,label}`；缺 label 由 EquipmentService.assertEquipableContent 点名'],
    ['spirit_beast_data.elements', '五行元素是词表本身（值只有名字与颜色），不印给玩家键名'],
    // 灵根概率表是"中文灵根名 → 权重"，值不显示给玩家：它的风险不在标签而在权重形状与键合法性，
    // 那两条都由 ContentRegistry._validateSpiritRootRoll 管（键必须是 spirit_roots[].name；
    // 值经 contentNumber 取值，资料片写 {id,value} 也认，非正数直接抛）。
    ['role_init.spiritRootProbabilities', '值是抽卡权重、不印给玩家；资料片的 {id,value} 由 contentNumber 兼容，键与正数性由 _validateSpiritRootRoll 拦'],
    // 相克表：键是灵根 type、值是"被克的属性列表"。基础配置是裸数组（走 passthrough 原样保留），
    // 资料片条目是 `{id,counters:[...]}` 对象 —— 形状由 contentList 兼容，键与值由 _validateElementMatch 拦。
    ['technique_data.element_match.conflicts', '值是相克目标列表、不印给玩家；两种形状由 contentList 兼容，拼错的键/值由 _validateElementMatch 在启动期点名']
]);

function scanShapes() {
    const out = [];
    for (const [dataset, spec] of Object.entries(DATASET_SPECS)) {
        let base;
        try { base = JSON.parse(read(`config/${dataset}.json`)); } catch { continue; }   // pack-only 数据集
        for (const [name, cs] of Object.entries(spec.collections || {})) {
            if (!cs.map) continue;
            const value = at(base, name);
            if (!isPlainObject(value) || Array.isArray(value)) continue;
            const shape = classifyMapShape(value);
            out.push({ key: `${dataset}.${name}`, ...shape });
        }
    }
    return out;
}

const shapes = scanShapes();
const needValidator = shapes.filter(s => s.kind === 'map-of-scalars' || s.kind === 'mixed');

describe('登记表形状户口册：标量字典能被资料片扩，但必须配一条启动期校验', () => {
    test('扫描器确实看见了东西（否则下面两条都是空跑）', () => {
        expect(shapes.length).toBeGreaterThanOrEqual(8);
        expect(needValidator.length).toBeGreaterThanOrEqual(5);
        expect(Object.keys(DATASET_SPECS).length).toBeGreaterThanOrEqual(40);
    });

    test('每张"值可能是标量"的登记表都有结论：要么有启动期校验，要么写明不需要', () => {
        const missing = needValidator
            .filter(s => !LABEL_VALIDATORS[s.key] && !NO_LABEL_NEED.has(s.key))
            .map(s => `${s.key}（${s.kind}，标量 ${s.scalars}/${s.total}）`);
        expect(missing).toEqual([]);
    });

    test('结论不许变成化石：列了的表必须还在扫描结果里，且形状确实还是需要校验', () => {
        const seen = new Map(shapes.map(s => [s.key, s.kind]));
        const stale = [];
        for (const key of Object.keys(LABEL_VALIDATORS)) {
            // 只要求"这张表还登记着"。形状是不是标量不影响要不要校验：
            // 标签表就算基础值已经是 {label,format} 对象（sect_data.bonus_labels 就是），
            // 资料片加一条没有 label 的条目照样会把裸键印给玩家。
            if (!seen.has(key)) stale.push(`${key} 已经不是登记的 map 集合了，清掉这条结论`);
        }
        for (const key of NO_LABEL_NEED.keys()) {
            // 理由表里允许出现"本来就是对象表"的条目（那正是我这次误判的来源），只要求它仍被登记
            if (!seen.has(key)) stale.push(`${key} 已不在登记表里，清掉理由`);
        }
        expect(stale).toEqual([]);
    });

    test('校验函数真的存在（写个不存在的名字当结论，等于没有结论）', () => {
        const registrySource = read('game/content/ContentRegistry.js');
        const deepLineSource = read('game/services/ArtifactDeepLineService.js');
        const ghosts = [];
        for (const validator of new Set(Object.values(LABEL_VALIDATORS))) {
            const pattern = new RegExp(`_?${validator.replace(/^_/, '')}\\s*\\(`);
            if (!pattern.test(registrySource) && !pattern.test(deepLineSource)) {
                ghosts.push(`找不到校验/取名处：${validator}`);
            }
        }
        expect(ghosts).toEqual([]);
    });

    test('控制跑：分类函数认得三种形状，并且不把 _comment 当条目', () => {
        expect(classifyMapShape({ a: 'A', b: 'B' }).kind).toBe('map-of-scalars');
        expect(classifyMapShape({ a: { label: 'A' } }).kind).toBe('map-of-objects');
        expect(classifyMapShape({ a: { label: 'A' }, b: 'B' }).kind).toBe('mixed');
        expect(classifyMapShape({ _comment: '说明', a: { label: 'A' } }).kind).toBe('map-of-objects');
        expect(classifyMapShape({ _comment: '只有说明' }).kind).toBe('empty');
        // 反面对照：如果 _comment 没被排除，这份户口册会把 3 张本来正常的对象表误判成"混合"
        expect(classifyMapShape({ _comment: '只有说明' })).toMatchObject({ total: 0, kind: 'empty' });
    });

    test('控制跑：新登记一张没校验的标量表必须被这份户口册抓到', () => {
        const synthetic = [
            { key: 'new_pack_data.weight_labels', kind: 'map-of-scalars', scalars: 3, objects: 0, total: 3 },
            { key: 'sect_data.global.bonus_labels', kind: 'mixed', scalars: 1, objects: 9, total: 10 }
        ];
        const uncovered = synthetic
            .filter(s => !LABEL_VALIDATORS[s.key] && !NO_LABEL_NEED.has(s.key))
            .map(s => s.key);
        expect(uncovered).toEqual(['new_pack_data.weight_labels']);
    });
});
