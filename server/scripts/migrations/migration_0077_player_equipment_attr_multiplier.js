/**
 * 迁移 0077：player_equipment 表新增 attr_multiplier 字段
 *
 * 用途：承载装备属性浮动倍率（炼制品质系数）。
 *       穿戴炼器产物时，从背包物品 metadata.attr_multiplier 带入该字段，
 *       在 getEquipmentBonus 中放大装备基础属性，打通"炼器品质→装备实际属性"断链。
 *
 * 字段：
 *   - attr_multiplier DECIMAL(6,4) NOT NULL DEFAULT 1.0：装备属性浮动倍率（1.0 为普通装备，>1 为高品质炼制装备）
 */
module.exports = {
    description: 'player_equipment 表新增 attr_multiplier 字段（承载炼制品质属性浮动倍率）',

    async up(sequelize, QueryTypes) {
        const addColumnIfNotExists = async (tableName, columnName, columnDef) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length === 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnDef}`);
                console.log(`[Migration 0077] ✓ 已添加列: ${tableName}.${columnName}`);
            } else {
                console.log(`[Migration 0077] ⏭ 列已存在，跳过: ${tableName}.${columnName}`);
            }
        };

        // 添加 attr_multiplier 字段（装备属性浮动倍率）
        await addColumnIfNotExists('player_equipment', 'attr_multiplier',
            '`attr_multiplier` DECIMAL(6,4) NOT NULL DEFAULT 1.0 COMMENT \'装备属性浮动倍率（炼制品质系数，1.0为普通装备，>1为高品质炼制装备）\'');

        console.log('[Migration 0077] ✓ 迁移完成');
    },

    async down(sequelize, QueryTypes) {
        const dropColumnIfExists = async (tableName, columnName) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length > 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
                console.log(`[Migration 0077] ✓ 已删除列: ${tableName}.${columnName}`);
            }
        };

        await dropColumnIfExists('player_equipment', 'attr_multiplier');

        console.log('[Migration 0077] ✓ 回滚完成');
    }
};
