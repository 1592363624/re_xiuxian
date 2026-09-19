/**
 * 迁移 0076：player_items 表新增 metadata JSON 字段
 *
 * 用途：承载物品动态元数据，例如炼丹/炼器产出的品质倍率（effect_multiplier），
 *       服用丹药时按该倍率放大恢复/修为等效果，打通"品质→实际收益"断链。
 *
 * 字段：
 *   - metadata JSON NULL DEFAULT NULL：物品动态元数据
 */
module.exports = {
    description: 'player_items 表新增 metadata JSON 字段（承载炼制品质倍率等动态元数据）',

    async up(sequelize, QueryTypes) {
        const addColumnIfNotExists = async (tableName, columnName, columnDef) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length === 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnDef}`);
                console.log(`[Migration 0076] ✓ 已添加列: ${tableName}.${columnName}`);
            } else {
                console.log(`[Migration 0076] ⏭ 列已存在，跳过: ${tableName}.${columnName}`);
            }
        };

        // 添加 metadata JSON 字段
        await addColumnIfNotExists('player_items', 'metadata',
            '`metadata` JSON NULL DEFAULT NULL COMMENT \'物品动态元数据（如品质倍率 effect_multiplier）\'');

        console.log('[Migration 0076] ✓ 迁移完成');
    },

    async down(sequelize, QueryTypes) {
        const dropColumnIfExists = async (tableName, columnName) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length > 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
                console.log(`[Migration 0076] ✓ 已删除列: ${tableName}.${columnName}`);
            }
        };

        await dropColumnIfExists('player_items', 'metadata');

        console.log('[Migration 0076] ✓ 回滚完成');
    }
};
