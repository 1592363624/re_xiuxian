/**
 * 物品 → 「获取途径」标签。来源只有一个：内容配置（资料片新增的物品自动生效）。
 *
 * 为什么要单独一层：玩家在储物袋里看到一件材料，最常问的两句话是
 * 「这玩意儿有什么用」和「我上哪儿弄」。前者已经由 item_data 的 description/effect 回答，
 * 后者过去全仓没有任何地方回答 —— 玩家只能靠猜，猜不到就以为游戏里拿不到材料。
 *
 * 这里不新增一份人工维护的「来源表」（那种表必然随配置漂移），而是反向扫描
 * 已经存在的产出配置，推导出每个物品的真实来源：
 *   采集点 / 怪物掉落 / 炼制配方产物 / 指归任务奖励 / 宗门库房 / 慕兰军需铺。
 * 配置改了，来源标签跟着变；扫描不到的物品返回空数组 —— 这本身是有用信号：
 * 说明这件物品当前没有任何稳定产出途径。
 */
'use strict';

const { infrastructure } = require('../../modules');

/** 读取一个内容配置（走 ConfigLoader，与 itemNaming 同源，资料片合并后可见） */
function cfg(name) {
    // 用 peekConfig 而不是 getConfig：后者在配置未加载时抛错，会把「背包少一列来源」
    // 放大成「背包接口 500」。任一来源配置缺失时按 null 处理，其余来源照常推导。
    return infrastructure.ConfigLoader.peekConfig(name);
}

/** 来源标签最多列几张地图，超出用「等 n 处」收敛，避免背包里出现一屏地名 */
const MAX_MAP_LABELS = 3;

/**
 * 往索引里追加一条来源（同一个物品的同一条标签只保留一次）
 * @param {Map<string, Array>} map - itemKey → [{ type, label }]
 * @param {string} itemKey - 物品 key
 * @param {string} label - 人类可读的来源描述
 * @param {string} type - 来源类型标识（gather/drop/craft/quest/sect/shop）
 */
function push(map, itemKey, label, type) {
    if (!itemKey) return;
    const key = String(itemKey);
    const list = map.get(key) || [];
    if (!list.some(entry => entry.label === label)) {
        list.push({ type, label });
        map.set(key, list);
    }
}

/**
 * 扫描「资源 → 可采集地图」关系，得到 resource_id → [地图名]
 * 采集配置在 resource_data，而「哪张图有这种资源」在 map_data，两处必须合起来才说得清
 */
function buildResourceMapIndex() {
    const index = new Map();
    for (const mapConfig of cfg('map_data')?.maps || []) {
        for (const resource of mapConfig.resources || []) {
            const list = index.get(String(resource.id)) || [];
            if (mapConfig.name) list.push(mapConfig.name);
            index.set(String(resource.id), list);
        }
    }
    return index;
}

/** 组装采集类来源标签：有具体地图就写地图，「越国、彩霞山 等 4 处」 */
function gatherLabel(mapNames) {
    if (!mapNames.length) return '野外采集';
    if (mapNames.length <= MAX_MAP_LABELS) return `采集 · ${mapNames.join('、')}`;
    const shown = mapNames.slice(0, MAX_MAP_LABELS).join('、');
    return `采集 · ${shown} 等 ${mapNames.length} 处`;
}

/** 递归收集系统任务里 promises 的物品奖励（配置是嵌套树，层级不固定，只能递归找 rewards.items） */
function collectQuestRewardItems(node, map, seen) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
        node.forEach(child => collectQuestRewardItems(child, map, seen));
        return;
    }

    const rewardItems = node.rewards?.items;
    if (Array.isArray(rewardItems)) {
        for (const item of rewardItems) {
            push(map, item?.item_key, '指归任务奖励', 'quest');
        }
    }

    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') collectQuestRewardItems(value, map, seen);
    }
}

/** 全量扫描配置，构建 itemKey → 来源标签索引 */
function buildIndex() {
    const map = new Map();

    // ① 采集：resource_data 给出产物，map_data 给出可采集地点
    const resourceMaps = buildResourceMapIndex();
    for (const yieldEntry of cfg('resource_data')?.resource_yields || []) {
        const mapNames = resourceMaps.get(String(yieldEntry.resource_id)) || [];
        push(map, yieldEntry.item_id, gatherLabel(mapNames), 'gather');
    }

    // ② 怪物掉落（含普通怪与 BOSS 两张表）
    const dropConfig = cfg('drop_data') || {};
    for (const group of [dropConfig.drops, dropConfig.boss_drops]) {
        for (const entry of group || []) {
            const monster = entry?.monster_name || entry?.name || entry?.monster_id || '妖兽';
            for (const drop of entry?.drops || []) {
                push(map, drop?.item_id, `击杀「${monster}」掉落`, 'drop');
            }
        }
    }

    // ③ 炼制产物：crafting_data 下所有配方数组（炼丹/炼器等），按 product.item_key 归类
    const craftingConfig = cfg('crafting_data') || {};
    for (const value of Object.values(craftingConfig)) {
        if (!Array.isArray(value)) continue;
        for (const recipe of value) {
            if (recipe?.product?.item_key) {
                push(map, recipe.product.item_key, `炼制「${recipe.name || '配方'}」`, 'craft');
            }
        }
    }

    // ④ 指归任务奖励
    collectQuestRewardItems(cfg('system_quest_data'), map, new Set());

    // ⑤ 宗门库房兑换
    for (const sect of cfg('sect_data')?.sects || []) {
        for (const entry of sect?.treasury || []) {
            const sectName = sect.name ? ` · ${sect.name}` : '';
            push(map, entry?.item_key, `宗门库房${sectName}`, 'sect');
        }
    }

    // ⑥ 慕兰战线军需铺
    for (const item of cfg('border_military_data')?.military_shop?.items || []) {
        push(map, item?.key, '慕兰军需铺兑换', 'shop');
    }

    return map;
}

// 缓存：任一来源配置被热更/资料片重载（对象引用变化）就整体重建
let cacheRefs = null;
let cacheIndex = new Map();

/** 校验配置引用是否变化，必要时重建索引 */
function sourceIndex() {
    const currentRefs = [
        cfg('resource_data'),
        cfg('map_data'),
        cfg('drop_data'),
        cfg('crafting_data'),
        cfg('system_quest_data'),
        cfg('sect_data'),
        cfg('border_military_data'),
    ];
    const changed = !cacheRefs
        || currentRefs.length !== cacheRefs.length
        || currentRefs.some((ref, i) => ref !== cacheRefs[i]);
    if (changed) {
        cacheRefs = currentRefs;
        cacheIndex = buildIndex();
    }
    return cacheIndex;
}

/**
 * 取某个物品的获取途径标签
 * @param {string} itemKey - 物品 key
 * @returns {Array<{type: string, label: string}>} 来源标签；查不到返回空数组（表示当前无稳定产出）
 */
function getItemSources(itemKey) {
    if (itemKey === null || itemKey === undefined) return [];
    return sourceIndex().get(String(itemKey)) || [];
}

module.exports = { getItemSources };