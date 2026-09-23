/**
 * 称号引用 → 中文名。名字只有一个来源：内容里的 `titles`（资料片新加一档称号自动生效）。
 *
 * 与 `game/items/itemNaming.js` 同族，也同规则：**内容里与库里只存引用（`title_id`），
 * 名字在出参那一刻现算。** 为什么要专门把这一条写成模块 —— 副本/切磋的内容里以前每写一条发放路径，
 * 就在同一层手抄一份 `title_name`（2026-09-22 实测 16 处）外加一份 `title_desc`（6 处，**全仓没有任何代码读它**）。
 * 那份镜像与 `titles[id].name` 之间没有任何约束：改一边另一边不报错，而结算文本、奖励预览读的都是镜像 ——
 * 于是"称号表里到底有没有这一档"这件事被镜像盖住了（同批实测：发放路径指着 10 档词表里根本不存在的称号）。
 * 现在镜像删掉、出参一律走这里，并由启动闸硬拦"发放路径同层再写 title_name / title_desc"。
 */
'use strict';

const { infrastructure } = require('../../modules');

let sourceRef = null;
let index = new Map();
let descIndex = new Map();

/** 配置热更或资料片重载后（数组换了引用）自动重建索引 */
function titleIndexes() {
    const titles = infrastructure.ConfigLoader.getConfig('titles') || [];
    if (titles !== sourceRef) {
        sourceRef = titles;
        index = new Map(titles.map(t => [String(t && t.id), t && t.name]));
        descIndex = new Map(titles.map(t => [String(t && t.id), t && t.description]));
    }
    return { names: index, descriptions: descIndex };
}

/**
 * @param {string} titleId - 称号 id
 * @returns {string|null} 词表里登记的名字；查不到返回 null（调用方自己决定退回什么）
 */
function titleName(titleId) {
    if (titleId === null || titleId === undefined || titleId === '') return null;
    return titleIndexes().names.get(String(titleId)) || null;
}

/** 称号说明（同样是引用 → 现算；镜像 `title_desc` 一并取消，说明只在词表里） */
function titleDescription(titleId) {
    if (titleId === null || titleId === undefined || titleId === '') return null;
    return titleIndexes().descriptions.get(String(titleId)) || null;
}

/** 词表里登记过的全部称号 id（给"引用必须存在"这类判据用，不在这里抄第二份清单） */
function knownTitleIds() {
    return [...titleIndexes().names.keys()].filter(id => id && id !== 'undefined');
}

module.exports = { titleName, titleDescription, knownTitleIds };
