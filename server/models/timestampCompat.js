/**
 * 时间戳读法兼容层：让 row.created_at 与 row.createdAt 读到同一份值。
 *
 * 为什么补一层，而不是把模型统一改名：`server/models` 里 117 个模型共存着三种写法
 *   1. `underscored: true`（60 个）——实例属性名是 createdAt，数据库列才是 created_at；
 *   2. 显式声明 `created_at`（25 个）——实例属性名是 created_at，读 createdAt 得到 undefined；
 *   3. 两种都声明（Item / PlayerCave / PlayerGathering / PlayerCombat 等 7 个）。
 * 统一改列名要先动线上 schema 再改上百处调用，风险远大于收益；而"读错拼法"的代价是静默 undefined：
 * 兽潮的攻击冷却就因为读 `lastAttack.created_at` 打印过"NaN 秒后可再次攻击"，
 * 捐献流水也回给过前端 `created_at: undefined`。这类问题不会报错，只会显示成空值。
 *
 * 做法：包一层 sequelize.define，按每个模型**真实声明的属性**补上另一种拼法的读写口。
 * 于是新增模型时不管沿用哪种写法，消费方都不会踩到 undefined，也不必先查它属于哪一类。
 *
 * 边界（有意为之）：
 *   - 只补"没有被声明成属性"的那一侧，绝不覆盖已有属性或已有原型成员；
 *   - 只管实例读属性。where 条件不经这层——那里 Sequelize 按列名解析，snake_case 本来就是真实列名；
 *   - 别名写会转成对真实属性的 `set()`，因此改动追踪（changed/save）照常工作。
 */
'use strict';

/** 时间戳属性的两种拼法（第三对 deletedAt 现网没人软删，装上是为了以后不至于再踩） */
const TIMESTAMP_SPELLINGS = [
    ['createdAt', 'created_at'],
    ['updatedAt', 'updated_at'],
    ['deletedAt', 'deleted_at']
];

/**
 * 给 model 增加一个"别名读写口"：realKey 是模型真正声明的属性，aliasKey 是补出来的拼法。
 * @returns {boolean} 是否装了（已声明/已存在同名成员时不装）
 */
function defineSpelling(model, realKey, aliasKey) {
    const attributes = model.rawAttributes || {};
    if (!attributes[realKey] || attributes[aliasKey]) return false;
    if (aliasKey in model.prototype) return false;

    const readSpelling = function readTimestampSpelling() {
        return this.get(realKey);
    };
    const writeSpelling = function writeTimestampSpelling(value) {
        this.set(realKey, value);
    };
    // 打上标记，契约测试才能分清"这一侧是补出来的别名"还是"模型自己声明的属性"
    readSpelling.__timestampSpellingAlias = true;
    writeSpelling.__timestampSpellingAlias = true;

    Object.defineProperty(model.prototype, aliasKey, {
        configurable: true,
        enumerable: false,
        get: readSpelling,
        set: writeSpelling
    });
    return true;
}

function installModelTimestampCompat(model) {
    if (!model || !model.rawAttributes) return 0;
    let installed = 0;
    for (const [camel, snake] of TIMESTAMP_SPELLINGS) {
        if (defineSpelling(model, camel, snake)) installed += 1;
        if (defineSpelling(model, snake, camel)) installed += 1;
    }
    return installed;
}

/**
 * 包住 sequelize.define：每个模型定义完立刻补时间戳读法。
 * 幂等，重复调用不会二次包装。
 */
function installTimestampCompat(sequelize) {
    if (!sequelize || sequelize.__timestampCompatInstalled) return sequelize;
    sequelize.__timestampCompatInstalled = true;

    const define = sequelize.define.bind(sequelize);
    sequelize.define = (modelName, attributes, options) => {
        const model = define(modelName, attributes, options);
        installModelTimestampCompat(model);
        return model;
    };
    return sequelize;
}

module.exports = {
    installTimestampCompat,
    installModelTimestampCompat,
    defineSpelling,
    TIMESTAMP_SPELLINGS
};
