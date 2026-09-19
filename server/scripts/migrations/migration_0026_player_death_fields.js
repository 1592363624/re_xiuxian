/**
 * 数据库迁移脚本
 * 版本: 0026
 * 描述: 为 players 表新增死亡状态字段（death_reason / death_time）
 * 创建时间: 2026-07-19
 *
 * 背景：
 *   批次1 修复 B2/B3/B4：玩家寿元耗尽死亡后，原系统仅设置 is_dead=true，
 *   未记录死亡原因和死亡时间，前端无法展示完整死亡信息，也无法基于死亡时长
 *   计算冷却（如夺舍重生的窗口期）。本迁移补全这两个字段。
 *
 * 新增字段（共 2 个）：
 *   - death_reason：死亡原因（寿元耗尽/被击杀/突破失败等），VARCHAR(50)，允许 NULL
 *   - death_time：死亡时间戳，DATETIME，允许 NULL
 *
 * 幂等性：每个字段单独检查 INFORMATION_SCHEMA.COLUMNS 后 ADD COLUMN
 *
 * MySQL 5.6 兼容性：
 *   - 每列单独 ALTER TABLE，避免多列同时 ADD 失败
 *   - 字符集使用 utf8mb4 保证中文存储正常
 */

module.exports = {
    description: '为 players 表新增死亡状态字段（death_reason / death_time）',
    version: 26,

    /**
     * 执行迁移：为 players 表添加死亡相关字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0026] 开始为 players 表添加死亡状态字段...');

        // 待添加字段列表
        const columnsToAdd = [
            {
                name: 'death_reason',
                ddl: "ADD COLUMN death_reason VARCHAR(50) NULL COMMENT '死亡原因（寿元耗尽/被击杀/突破失败等），复活时清空'"
            },
            {
                name: 'death_time',
                ddl: "ADD COLUMN death_time DATETIME NULL COMMENT '死亡时间戳，用于计算死亡时长与冷却'"
            }
        ];

        // 查询当前 players 表的所有列
        const [columns] = await sequelize.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingColumns = columns.map(c => c.COLUMN_NAME);

        // 逐个添加缺失字段
        let addedCount = 0;
        for (const col of columnsToAdd) {
            if (!existingColumns.includes(col.name)) {
                await sequelize.query(`ALTER TABLE players ${col.ddl}`);
                console.log(`  ✓ 添加字段: ${col.name}`);
                addedCount++;
            } else {
                console.log(`  - 字段已存在，跳过: ${col.name}`);
            }
        }

        // 新增索引：便于按死亡时间排序查询（GM 后台死亡玩家列表、夺舍重生窗口匹配）
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        if (!existingIndexes.includes('idx_player_death_time')) {
            await sequelize.query('CREATE INDEX idx_player_death_time ON players (death_time)');
            console.log('  ✓ 添加索引: idx_player_death_time');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_death_time');
        }

        console.log(`[Migration v0026] 迁移完成：新增 ${addedCount} 个字段`);
    },

    /**
     * 回滚迁移：删除新增字段与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0026] 开始回滚 players 表死亡状态字段...');

        // 删除索引
        try {
            await sequelize.query('DROP INDEX idx_player_death_time ON players');
            console.log('  ✓ 删除索引: idx_player_death_time');
        } catch (e) {
            console.log('  - 索引不存在，跳过');
        }

        // 删除字段
        const columnsToRemove = ['death_reason', 'death_time'];
        for (const col of columnsToRemove) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${col}`);
                console.log(`  ✓ 删除字段: ${col}`);
            } catch (e) {
                console.log(`  - 字段不存在，跳过: ${col}`);
            }
        }

        console.log('[Migration v0026] 回滚完成');
    }
};