'use strict';
/**
 * 灵兽战斗快照的唯一投影。
 *
 * 为什么要单独一层：同一个"把一行 spirit_beasts 变成对战/回放用的快照"被手抄了三份
 * （`BeastAbyssService._createBeastSnapshot`、`BeastPastureService._createBeastSnapshot`、
 * `SpiritBeastPvpService._createBeastSnapshot`），字段一模一样，类型却不一致（`hp_max` 一份是 Number、
 * 两份是字符串），字段还各自漏一个 `stamina`。这种形状下"给灵兽多看一个属性"就要改三处，
 * 而三处很容易只改到两处 —— 与"一把刀加属性要改很多位置"是同一个病。
 *
 * 边界（别把它当 #43 的解）：这里只投**已有的基础列**。资料片新声明的属性要走注册表那条已泛化的
 * 消费者（`SpiritBeastService` 用 `pickRegisteredStats(beast.toJSON())` 供进面板/战斗），灵兽自身要带上
 * 新属性还缺一个存储列 —— 那是 #43，等业主定 schema 之后再回来。
 */

/**
 * @param {Object} beast - 一行灵兽实例（Sequelize 实例或同名字段的普通对象）
 * @param {Object} [options]
 * @param {'string'|'number'} [options.hpMaxAs='string'] - 探渊那份快照历史上是 Number（下游按数字算），
 *        放养/对局那两份是字符串：保留各自原形状，不趁这次改动偷偷换类型。
 * @param {boolean} [options.includeStamina=false] - 只有探渊的快照带体力。
 * @returns {Object} 字段顺序固定：beast_id … loyalty（[, stamina]）
 */
function beastSnapshot(beast, { hpMaxAs = 'string', includeStamina = false } = {}) {
    const view = {
        beast_id: beast.id,
        beast_key: beast.beast_key,
        beast_name: beast.beast_name ?? beast.beast_key,
        element: beast.element,
        rarity: beast.rarity,
        star_level: beast.star_level,
        level: beast.level,
        hp_max: hpMaxAs === 'number'
            ? Number(beast.hp_max)
            : (beast.hp_max == null ? '0' : String(beast.hp_max)),
        atk: beast.atk,
        def: beast.def,
        speed: beast.speed,
        loyalty: beast.loyalty
    };
    if (includeStamina) view.stamina = beast.stamina;
    return view;
}

module.exports = { beastSnapshot };
