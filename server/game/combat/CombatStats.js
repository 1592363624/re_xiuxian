/**
 * 属性块的通用折算工具（战斗侧共用，不属于任何单一玩法）。
 *
 * 为什么单独一个文件而不是留在 MonsterStats 里：同一件"按比例把一整块属性折算一遍"的事，
 * 敌人来源（探渊的层难度、AI 模板的抖动）和友方来源（出战/护法傀儡按 battle_stat_ratio
 * 折算进玩家战斗）都要做。傀儡那一侧以前是手写四行 `Math.floor(puppet.atk * ratio)`，
 * 于是给傀儡加任何一个新属性（暴伤、五行抗性…）都要记得回来再补一行 —— 忘了的那一个
 * 不是报错，而是"这个属性对傀儡永远不生效"，谁也看不出来。
 *
 * 两种口径必须分清，否则会出事：
 *   - 内容里的敌人条目：整块都是属性，逐键折算即可；
 *   - 数据库行（PlayerPuppet 那一行）：块里还混着 id/level/durability 这些**不是属性**的数字，
 *     必须只折算属性注册表登记过的键，不然玩家等级会跟着倍率一起被乘。
 *
 * 这两个函数都走 ensureStatRegistryLoaded() 而不是直接抓 statRegistry 单例：注册表还没装的时候
 * `resolveStatKey()` 对每个键都返回 undefined，于是"挑出来的属性块"变成空对象 —— 傀儡/灵兽给玩家的
 * 加成静默变 0，不报错也不告警（实测：只 require 模型不跑启动流程时就是这样）。启动路径上内容层会先把
 * "基础 + 资料片"的合并词表装入，ensureStatRegistryLoaded() 见到已装好就直接返回，不会覆盖成基础版。
 */
'use strict';

/** 允许当"血量"用的存储别名：不同来源各叫各的（hp / max_hp / hp_max），但一次战斗里只能有一个真相 */
const HP_KEYS = ['hp_max', 'max_hp', 'hp'];

/**
 * @param {Object} stats - 属性块（不改原对象；数据库行里读出的字符串会顺手转成数值）
 * @param {number} factor - 折算系数，非正数按 1 处理
 * @param {Object} opts - {
 *     except: 不参与折算的键，默认奖励类字段（exp_reward），别让"更难的层"顺带发几倍修为;
 *     registeredOnly: 只折算属性注册表里登记过的键（外加血量别名）—— 从数据库行取块时必须开
 * }
 * @returns {Object} 折算后的新块
 */
function scaleStatBlock(stats, factor, { except = ['exp_reward'], registeredOnly = false } = {}) {
    const multiplier = Number(factor);
    const scale = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
    const registry = registeredOnly ? require('../stats').ensureStatRegistryLoaded() : null;

    const scalables = Object.entries(stats || {}).filter(([key, value]) => {
        if (except.includes(key)) return false;
        const numeric = typeof value === 'string' ? Number(value) : value;
        if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return false;
        // 血量别名是"存储叫法"而不是注册表键（resolveStatKey('hp') 查不到），所以要单独放行
        return !registry || HP_KEYS.includes(key) || !!registry.resolveStatKey(key);
    });

    const out = {};
    for (const [key, value] of Object.entries(stats || {})) out[key] = value;
    for (const [key, value] of scalables) {
        const numeric = typeof value === 'string' ? Number(value) : value;
        // 一律取整：属性块常要进 BIGINT 列（monster_hp / puppet hp），留小数就是 BigInt(30.4) 当场抛错
        out[key] = Math.floor(numeric * scale);
    }

    // 折算是乘法，三种血量叫法各自 floor 会差 1 点：以块里第一个出现的为准对齐
    const hpKey = HP_KEYS.find(key => Object.prototype.hasOwnProperty.call(out, key));
    if (hpKey && scale !== 1) {
        for (const key of HP_KEYS) if (key in out) out[key] = out[hpKey];
    }
    return out;
}

/**
 * 从一份"单位属性块"里挑出属于属性注册表的键，血量别名统一成 hp_max。
 *
 * 给属性引擎喂数据的一方必须做这一步：`normalizeModifiers` 不认识注册表，
 * 未登记的数值键会被记成 unknown（strict 模式下直接抛错）。傀儡那一行里正好混着
 * level/exp/durability 这些"是数字但不是属性"的列，所以以前是手写四行顺手挑掉的 ——
 * 代价是给傀儡加一个新属性时，还得记得回来在这四行里补一行。
 *
 * @param {Object} stats - 任意来源的属性块（含非属性键也没关系）
 * @returns {Object} 只含已登记属性键的块
 */
function pickRegisteredStats(stats = {}) {
    const registry = require('../stats').ensureStatRegistryLoaded();
    const out = {};
    for (const [key, raw] of Object.entries(stats)) {
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        if (key === 'hp' || key === 'max_hp') { out.hp_max = value; continue; }   // 属性口径只有 hp_max 一个名字
        const def = registry.resolveStatKey(key);
        if (def) out[def.key] = value;
    }
    return out;
}

module.exports = { HP_KEYS, scaleStatBlock, pickRegisteredStats };
