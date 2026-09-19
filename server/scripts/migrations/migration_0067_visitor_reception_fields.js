/**
 * 迁移 0067：cave_visitors 表新增接待/驱逐访客系统字段
 *
 * 新增 3 个字段：
 *   - reception_status VARCHAR(20) DEFAULT 'pending'：接待状态
 *   - reception_at DATETIME NULL：主人处理时间
 *   - reception_buff_until DATETIME NULL：接待buff到期时间
 *
 * 新增 2 个索引：
 *   - idx_cv_owner_status：洞府主人查询待处理访客列表
 *   - idx_cv_visitor_status：访客查询自己被接待/驱逐状态
 */
module.exports = {
    description: 'cave_visitors 表新增接待/驱逐访客系统字段（reception_status/reception_at/reception_buff_until）',

    async up(sequelize, QueryTypes) {
        const addColumnIfNotExists = async (tableName, columnName, columnDef) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length === 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnDef}`);
                console.log(`[Migration 0067] ✓ 已添加列: ${tableName}.${columnName}`);
            } else {
                console.log(`[Migration 0067] ⏭ 列已存在，跳过: ${tableName}.${columnName}`);
            }
        };

        const addIndexIfNotExists = async (tableName, indexName, indexDef) => {
            const [results] = await sequelize.query(`
                SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
            `, { replacements: [tableName, indexName] });
            if (results.length === 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` ${indexDef}`);
                console.log(`[Migration 0067] ✓ 已添加索引: ${indexName}`);
            } else {
                console.log(`[Migration 0067] ⏭ 索引已存在，跳过: ${indexName}`);
            }
        };

        // 添加字段
        await addColumnIfNotExists('cave_visitors', 'reception_status',
            "`reception_status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '接待状态：pending待处理/received已接待/expelled已驱逐/ignored已忽略'");
        await addColumnIfNotExists('cave_visitors', 'reception_at',
            "`reception_at` DATETIME NULL DEFAULT NULL COMMENT '主人处理时间'");
        await addColumnIfNotExists('cave_visitors', 'reception_buff_until',
            "`reception_buff_until` DATETIME NULL DEFAULT NULL COMMENT '接待buff到期时间'");

        // 添加索引
        await addIndexIfNotExists('cave_visitors', 'idx_cv_owner_status',
            '(`cave_owner_id`, `reception_status`)');
        await addIndexIfNotExists('cave_visitors', 'idx_cv_visitor_status',
            '(`visitor_id`, `reception_status`)');

        console.log('[Migration 0067] ✓ 迁移完成');
    },

    async down(sequelize, QueryTypes) {
        const dropColumnIfExists = async (tableName, columnName) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length > 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
                console.log(`[Migration 0067] ✓ 已删除列: ${tableName}.${columnName}`);
            }
        };

        const dropIndexIfExists = async (tableName, indexName) => {
            const [results] = await sequelize.query(`
                SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
            `, { replacements: [tableName, indexName] });
            if (results.length > 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
                console.log(`[Migration 0067] ✓ 已删除索引: ${indexName}`);
            }
        };

        await dropIndexIfExists('cave_visitors', 'idx_cv_visitor_status');
        await dropIndexIfExists('cave_visitors', 'idx_cv_owner_status');
        await dropColumnIfExists('cave_visitors', 'reception_buff_until');
        await dropColumnIfExists('cave_visitors', 'reception_at');
        await dropColumnIfExists('cave_visitors', 'reception_status');

        console.log('[Migration 0067] ✓ 回滚完成');
    }
};
