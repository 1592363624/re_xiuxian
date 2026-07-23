/**
 * migration_0074: 为 players 表新增 ldc（灵鱼丹珠）字段
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   LDC 是灵溪垂钓系统的稀有保底货币：
 *     - 用途：购买青竹钓竿（30 LDC）
 *     - 产出：鱼腹机缘（2%概率开出 1/2/3 LDC）+ 全服每日保底 2-3 LDC
 *     - 流通：后续可在万宝楼/拍卖行流通
 *
 * 字段设计：
 *   - 类型 INT（LDC 总量稀少，INT 足够）
 *   - 默认值 0（新玩家无 LDC，需通过垂钓或交易获取）
 *   - 与 spirit_stones 分账，避免通胀污染主货币
 *
 * 幂等性：添加前检查字段是否存在
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const sequelize = require('../config/database');

/**
 * 检查字段是否存在
 * @param {string} tableName - 表名
 * @param {string} columnName - 字段名
 * @returns {Promise<boolean>}
 */
async function columnExists(tableName, columnName) {
    const [results] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        { replacements: [tableName, columnName] }
    );
    return results[0].cnt > 0;
}

module.exports = {
    /**
     * 执行迁移：为 players 表添加 ldc 列
     */
    async up() {
        if (!(await columnExists('players', 'ldc'))) {
            // 在 pawnshop_credit 之后添加 ldc 字段（MySQL 5.6 支持 AFTER 子句）
            await sequelize.query(`
                ALTER TABLE players
                ADD COLUMN ldc INT NOT NULL DEFAULT 0 COMMENT 'LDC灵鱼丹珠（稀有保底货币：购买钓竿/拍卖流通，鱼腹机缘产出）'
                AFTER pawnshop_credit
            `);
            console.log('[migration_0074] players.ldc 字段添加成功');
        } else {
            console.log('[migration_0074] players.ldc 字段已存在，跳过');
        }
    },

    /**
     * 回滚迁移：删除 ldc 列
     */
    async down() {
        if (await columnExists('players', 'ldc')) {
            await sequelize.query('ALTER TABLE players DROP COLUMN ldc');
            console.log('[migration_0074] 回滚完成：已删除 players.ldc 字段');
        }
    }
};
