/**
 * 数据库迁移脚本
 * 版本: 0025
 * 描述: 阵法系统（player_formations 表 + players 表新增 3 字段）
 * 创建时间: 2026-07-19
 *
 * 新增字段（players 表，共 3 个）：
 *   - active_formation_id：当前激活阵法ID（VARCHAR(40)）
 *   - formation_activated_at：阵法激活时间（DATETIME）
 *   - last_formation_deactivate_time：最后撤阵时间（DATETIME，冷却用）
 *
 * 新建表：
 *   - player_formations：玩家已学阵法记录（含熟练度）
 *
 * 幂等性：每个字段/索引/表都先查询 INFORMATION_SCHEMA 后操作
 *
 * MySQL 5.6 兼容性：
 *   - 每列单独 ALTER TABLE
 *   - 索引单独 CREATE INDEX
 *   - 表结构使用 ENGINE=InnoDB CHARSET=utf8mb4
 */

module.exports = {
    description: '阵法系统：玩家已学阵法表 + players 表新增激活阵法字段',
    version: 25,

    /**
     * 执行迁移：添加字段、索引与新建表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0025] 开始创建阵法系统...');

        // ===== 1. 为 players 表添加阵法相关字段 =====
        const columnsToAdd = [
            { name: 'active_formation_id', ddl: "ADD COLUMN active_formation_id VARCHAR(40) NULL COMMENT '当前激活阵法ID（如 f_tiangan_sword）'" },
            { name: 'formation_activated_at', ddl: "ADD COLUMN formation_activated_at DATETIME NULL COMMENT '阵法激活时间（持续时间计算）'" },
            { name: 'last_formation_deactivate_time', ddl: "ADD COLUMN last_formation_deactivate_time DATETIME NULL COMMENT '最后撤阵时间（冷却计算）'" }
        ];

        // 查询当前 players 表的所有列
        const [columns] = await sequelize.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingColumns = columns.map(c => c.COLUMN_NAME);

        let addedFieldCount = 0;
        for (const col of columnsToAdd) {
            if (!existingColumns.includes(col.name)) {
                await sequelize.query(`ALTER TABLE players ${col.ddl}`);
                console.log(`  ✓ 添加字段: ${col.name}`);
                addedFieldCount++;
            } else {
                console.log(`  - 字段已存在，跳过: ${col.name}`);
            }
        }

        // ===== 2. 为 players 表添加索引（便于查询当前激活阵法的玩家） =====
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        if (!existingIndexes.includes('idx_player_formation_active')) {
            await sequelize.query('CREATE INDEX idx_player_formation_active ON players (active_formation_id)');
            console.log('  ✓ 添加索引: idx_player_formation_active');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_formation_active');
        }

        // ===== 3. 创建 player_formations 表（玩家已学阵法记录） =====
        const [tables] = await sequelize.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_formations'
        `);
        const tableExists = tables.length > 0;

        if (!tableExists) {
            await sequelize.query(`
                CREATE TABLE player_formations (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    formation_id VARCHAR(40) NOT NULL COMMENT '阵法ID（对应 formation_data.json 中的 id）',
                    proficiency INT NOT NULL DEFAULT 0 COMMENT '阵法熟练度（0-1000，每次布阵 +1）',
                    learned_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '学习时间',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '记录更新时间',
                    INDEX idx_player_formations (player_id),
                    UNIQUE KEY uk_player_formation (player_id, formation_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家已学阵法记录'
            `);
            console.log('  ✓ 创建表: player_formations');
        } else {
            console.log('  - 表已存在，跳过: player_formations');
        }

        console.log(`[Migration v0025] 迁移完成：新增 ${addedFieldCount} 个字段，1 张表`);
    },

    /**
     * 回滚迁移：删除字段、索引与表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0025] 开始回滚阵法系统...');

        // 删除表
        try {
            await sequelize.query('DROP TABLE IF EXISTS player_formations');
            console.log('  ✓ 删除表: player_formations');
        } catch (e) { /* 忽略 */ }

        // 删除索引
        try {
            await sequelize.query('DROP INDEX idx_player_formation_active ON players');
            console.log('  ✓ 删除索引: idx_player_formation_active');
        } catch (e) { /* 忽略 */ }

        // 删除字段
        const fieldsToDrop = [
            'last_formation_deactivate_time',
            'formation_activated_at',
            'active_formation_id'
        ];
        for (const field of fieldsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${field}`);
                console.log(`  ✓ 删除字段: ${field}`);
            } catch (e) { /* 忽略 */ }
        }

        console.log('[Migration v0025] 回滚完成');
    }
};
