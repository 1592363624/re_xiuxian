/**
 * 迁移 0087：system_notifications 表新增 publishAt 字段
 *
 * 用途：公告的"预约发布时间"。此前只有 expiresAt（自动下架），发布只能是"点下去就立刻全服弹窗"——
 *       运营想安排一条早间公告只能定闹钟手动点。加了这个字段后：
 *         - publishAt 为空 / 已过去 → 立即发布（与旧行为一致）
 *         - publishAt 在未来 → 玩家侧不可见、不计入未读，到点由 NotificationSchedulerService 推送
 *       可见性判定落在查询条件里（而不是只靠定时器去"改状态"），因此即使调度器停摆、
 *       或者玩家在到点前后刷新页面，看到的结果都是一致的。
 *
 * 字段：
 *   - publishAt DATETIME NULL：预约发布时间，NULL 表示立即生效
 */
module.exports = {
    description: 'system_notifications 表新增 publishAt 字段（公告预约发布时间）',

    async up(sequelize, QueryTypes) {
        const addColumnIfNotExists = async (tableName, columnName, columnDef) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length === 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` ADD COLUMN ${columnDef}`);
                console.log(`[Migration 0087] ✓ 已添加列: ${tableName}.${columnName}`);
            } else {
                console.log(`[Migration 0087] ⏭ 列已存在，跳过: ${tableName}.${columnName}`);
            }
        };

        await addColumnIfNotExists('system_notifications', 'publishAt',
            '`publishAt` DATETIME NULL COMMENT \'预约发布时间（NULL 表示立即生效）\'');

        console.log('[Migration 0087] ✓ 迁移完成');
    },

    async down(sequelize, QueryTypes) {
        const dropColumnIfExists = async (tableName, columnName) => {
            const [results] = await sequelize.query(`
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
            `, { replacements: [tableName, columnName] });
            if (results.length > 0) {
                await sequelize.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
                console.log(`[Migration 0087] ✓ 已删除列: ${tableName}.${columnName}`);
            }
        };

        await dropColumnIfExists('system_notifications', 'publishAt');

        console.log('[Migration 0087] ✓ 回滚完成');
    }
};
