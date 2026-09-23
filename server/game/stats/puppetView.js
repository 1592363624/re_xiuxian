'use strict';
/**
 * 傀儡行 → 出参/落库的那四个战斗列，一处定义（2026-09-23）。
 *
 * 为什么要单独一层：同一块 `atk/def/hp/speed` 在 PuppetService 里被手抄了 **五份**
 * （工坊列表、manufacture 建行的 INSERT、manufacture 回执、设出战/护法回执、淬炼回执），
 * 而且每一份都得跟着改 —— 这与"给一把刀加一档属性要改很多位置"是同一个病，只是宿主从物品换成傀儡：
 * 内容里 \`puppet_types.<档>.base_stats\` 与 `_calcStats` 早就是泛型的（有多少档声明就算多少档），
 * 可一到这五处出参就只剩四个键 —— 新属性在内存里算得出、在回执与面板上看不见，也不报错。
 *
 * 所以现在只有这一处认识"傀儡行对外露哪几列"。以后要给傀儡多看一档属性：
 * 先在这里加（或改成遍历属性注册表 ∩ 行上的列），五处出参一起跟着变；
 * 真正让它**落库**还需要 player_puppets 上的存储位置（要么加列、要么照灵兽 `stat_block`
 * 那样加一个 JSON 属性块列）—— 那是改表，要业主授权，见 [[project-stat-registry-migration-2026-09-20]] 的 #43 先例。
 */
'use strict';

/** 傀儡行当前对外露出的战斗列（顺序即出参顺序；`hp` 是这张表的血量列名） */
const PUPPET_STAT_COLUMNS = Object.freeze(['atk', 'def', 'hp', 'speed']);

/**
 * 从任意一份"傀儡形状"的对象（Sequelize 行 / _calcStats 的结果 / 普通对象）里取那四项。
 * 原样搬运，不做数值转换：这五处历史上就是"直接透传行里的值"，加转换会把 BigInt/String 的形状改掉。
 */
function puppetStatFields(source) {
    const out = {};
    for (const column of PUPPET_STAT_COLUMNS) out[column] = source?.[column];
    return out;
}

module.exports = { PUPPET_STAT_COLUMNS, puppetStatFields };
