/**
 * 数据库迁移脚本
 * 版本: 0018
 * 描述: 为股市相关表补充 updated_at 字段
 * 创建时间: 2026-07-05
 *
 * 修复背景：
 *   迁移 0017 创建股市 7 张表时，4 张表（stock_transactions/stock_market_history/
 *   stock_events/stock_dividends）仅含 created_at，缺少 updated_at 字段。
 *   但 Sequelize 模型统一使用 timestamps: true + underscored: true，
 *   会默认查询 updated_at 字段，导致 Unknown column 'updated_at' 错误。
 *
 * 修复方案：
 *   通过 ALTER TABLE ADD COLUMN IF NOT EXISTS 补充 updated_at 字段，
 *   并设置默认值 CURRENT_TIMESTAMP 与 ON UPDATE CURRENT_TIMESTAMP，
 *   与其他表保持一致。
 *
 * 幂等性：使用 INFORMATION_SCHEMA 检查列是否存在，避免重复添加报错
 */

module.exports = {
    description: '为股市相关表（stock_transactions/stock_market_history/stock_events/stock_dividends）补充 updated_at 字段',
    version: 18,

    /**
     * 执行迁移：补充 updated_at 字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0018] 开始为股市相关表补充 updated_at 字段...');

        const tables = [
            'stock_transactions',
            'stock_market_history',
            'stock_events',
            'stock_dividends'
        ];

        for (const tableName of tables) {
            // 检查 updated_at 列是否已存在（MySQL 5.6 不支持 ADD COLUMN IF NOT EXISTS）
            const [results] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'updated_at'`,
                { replacements: [tableName] }
            );

            if (results.length === 0) {
                // 列不存在，添加 updated_at 字段
                await sequelize.query(
                    `ALTER TABLE \`${tableName}\`
                     ADD COLUMN \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
                );
                console.log(`  ✓ 表 ${tableName} 添加 updated_at 字段`);
            } else {
                console.log(`  - 表 ${tableName} 已存在 updated_at 字段，跳过`);
            }
        }

        console.log('[Migration v0018] 补充 updated_at 字段完成');
    },

    /**
     * 回滚迁移：删除 updated_at 字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0018] 开始回滚：删除 updated_at 字段...');
        const tables = [
            'stock_dividends',
            'stock_events',
            'stock_market_history',
            'stock_transactions'
        ];
        for (const tableName of tables) {
            await sequelize.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`updated_at\``);
            console.log(`  ✓ 表 ${tableName} 删除 updated_at 字段`);
        }
        console.log('[Migration v0018] 回滚完成');
    }
};
