/**
 * 数据库迁移脚本
 * 版本: 0024
 * 描述: 副本系统（秘境挑战）表与字段创建
 * 创建时间: 2026-07-19
 *
 * 新增字段（players 表，共 8 个）：
 *   - in_dungeon：是否在副本挑战中（TINYINT(1)）
 *   - dungeon_chapter_id：当前副本章节ID（如 'ch1'）
 *   - dungeon_node_id：当前副本关卡节点ID（如 'ch1_node3'）
 *   - dungeon_difficulty：当前副本难度（normal/hard/nightmare）
 *   - dungeon_start_time：本次副本开始时间
 *   - daily_dungeon_count：今日挑战次数（跨日重置）
 *   - last_dungeon_date：最后挑战日期（跨日重置）
 *   - last_dungeon_time：最后挑战结束时间（冷却计算）
 *
 * 新建表：
 *   1. player_dungeon_records：玩家副本通关记录（用于扫荡、星级展示）
 *   2. player_dungeon_progress：玩家副本进行中进度（用于断线重连）
 *
 * 幂等性：每个字段/索引/表都先查询 INFORMATION_SCHEMA 后操作
 *
 * MySQL 5.6 兼容性：
 *   - BOOLEAN 使用 TINYINT(1)
 *   - 每列单独 ALTER TABLE
 *   - JSON 字段使用 LONGTEXT 模拟（5.6 不支持 JSON 类型）
 */

module.exports = {
    description: '副本系统（秘境挑战）表与字段创建',
    version: 24,

    /**
     * 执行迁移：添加字段、索引与新建表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0024] 开始创建副本系统...');

        // ===== 1. 为 players 表添加字段 =====
        const columnsToAdd = [
            { name: 'in_dungeon', ddl: "ADD COLUMN in_dungeon TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否在副本挑战中（0=否，1=是）'" },
            { name: 'dungeon_chapter_id', ddl: "ADD COLUMN dungeon_chapter_id VARCHAR(20) NULL COMMENT '当前副本章节ID（如 ch1）'" },
            { name: 'dungeon_node_id', ddl: "ADD COLUMN dungeon_node_id VARCHAR(40) NULL COMMENT '当前副本关卡节点ID（如 ch1_node3）'" },
            { name: 'dungeon_difficulty', ddl: "ADD COLUMN dungeon_difficulty VARCHAR(20) NULL COMMENT '当前副本难度（normal/hard/nightmare）'" },
            { name: 'dungeon_start_time', ddl: "ADD COLUMN dungeon_start_time DATETIME NULL COMMENT '本次副本开始时间'" },
            { name: 'daily_dungeon_count', ddl: "ADD COLUMN daily_dungeon_count INT NOT NULL DEFAULT 0 COMMENT '今日副本挑战次数（跨日重置）'" },
            { name: 'last_dungeon_date', ddl: "ADD COLUMN last_dungeon_date DATE NULL COMMENT '最后副本挑战日期（跨日重置）'" },
            { name: 'last_dungeon_time', ddl: "ADD COLUMN last_dungeon_time DATETIME NULL COMMENT '最后副本挑战结束时间（冷却计算）'" }
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

        // ===== 2. 为 players 表添加索引 =====
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        if (!existingIndexes.includes('idx_player_dungeon')) {
            await sequelize.query('CREATE INDEX idx_player_dungeon ON players (in_dungeon, dungeon_start_time)');
            console.log('  ✓ 添加索引: idx_player_dungeon');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_dungeon');
        }

        // ===== 3. 创建 player_dungeon_records 表（玩家副本通关记录） =====
        const [tables] = await sequelize.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_dungeon_records'
        `);
        const tableExists = tables.length > 0;

        if (!tableExists) {
            await sequelize.query(`
                CREATE TABLE player_dungeon_records (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    chapter_id VARCHAR(20) NOT NULL COMMENT '章节ID（如 ch1）',
                    chapter_name VARCHAR(100) NOT NULL COMMENT '章节名称（冗余便于查询）',
                    difficulty VARCHAR(20) NOT NULL DEFAULT 'normal' COMMENT '难度（normal/hard/nightmare）',
                    stars INT NOT NULL DEFAULT 1 COMMENT '本章节获得的星级（1-3星）',
                    completion_time_sec INT NOT NULL DEFAULT 0 COMMENT '通关用时（秒）',
                    exp_gained BIGINT NOT NULL DEFAULT 0 COMMENT '获得修为',
                    spirit_stones_gained BIGINT NOT NULL DEFAULT 0 COMMENT '获得灵石',
                    items_gained LONGTEXT NULL COMMENT '获得物品JSON数组',
                    ai_narrative LONGTEXT NULL COMMENT 'AI生成的剧情文本（如有）',
                    completed_at DATETIME NOT NULL COMMENT '通关时间',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
                    INDEX idx_records_player (player_id),
                    INDEX idx_records_chapter (player_id, chapter_id, difficulty),
                    UNIQUE KEY uk_player_chapter_diff (player_id, chapter_id, difficulty)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家副本通关记录'
            `);
            console.log('  ✓ 创建表: player_dungeon_records');
        } else {
            console.log('  - 表已存在，跳过: player_dungeon_records');
        }

        // ===== 4. 创建 player_dungeon_progress 表（玩家副本进行中进度，用于断线重连） =====
        const [progressTables] = await sequelize.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_dungeon_progress'
        `);
        const progressTableExists = progressTables.length > 0;

        if (!progressTableExists) {
            await sequelize.query(`
                CREATE TABLE player_dungeon_progress (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    chapter_id VARCHAR(20) NOT NULL COMMENT '章节ID',
                    difficulty VARCHAR(20) NOT NULL DEFAULT 'normal' COMMENT '难度',
                    current_node_id VARCHAR(40) NOT NULL COMMENT '当前关卡节点ID',
                    current_node_type VARCHAR(20) NOT NULL COMMENT '当前关卡类型（story/battle/puzzle/boss/reward）',
                    nodes_completed LONGTEXT NULL COMMENT '已完成节点ID JSON数组',
                    hp_remaining BIGINT NOT NULL DEFAULT 0 COMMENT '剩余HP（关卡间持续）',
                    mp_remaining BIGINT NOT NULL DEFAULT 0 COMMENT '剩余MP',
                    items_collected LONGTEXT NULL COMMENT '本次副本已获得物品JSON数组',
                    exp_accumulated BIGINT NOT NULL DEFAULT 0 COMMENT '本次副本已积累修为',
                    spirit_stones_accumulated BIGINT NOT NULL DEFAULT 0 COMMENT '本次副本已积累灵石',
                    ai_context LONGTEXT NULL COMMENT 'AI生成的剧情上下文（用于跨节点连贯）',
                    start_time DATETIME NOT NULL COMMENT '副本开始时间',
                    last_active_time DATETIME NOT NULL COMMENT '最后活跃时间',
                    expires_at DATETIME NOT NULL COMMENT '过期时间（超时自动结算）',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                    UNIQUE KEY uk_progress_player (player_id),
                    INDEX idx_progress_expires (expires_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家副本进行中进度（断线重连用）'
            `);
            console.log('  ✓ 创建表: player_dungeon_progress');
        } else {
            console.log('  - 表已存在，跳过: player_dungeon_progress');
        }

        console.log(`[Migration v0024] 迁移完成：新增 ${addedFieldCount} 个字段，2 张表`);
    },

    /**
     * 回滚迁移：删除字段、索引与表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0024] 开始回滚副本系统...');

        // 删除表（先删依赖，后删主表）
        try {
            await sequelize.query('DROP TABLE IF EXISTS player_dungeon_progress');
            console.log('  ✓ 删除表: player_dungeon_progress');
        } catch (e) { /* 忽略 */ }

        try {
            await sequelize.query('DROP TABLE IF EXISTS player_dungeon_records');
            console.log('  ✓ 删除表: player_dungeon_records');
        } catch (e) { /* 忽略 */ }

        // 删除索引
        try {
            await sequelize.query('DROP INDEX idx_player_dungeon ON players');
            console.log('  ✓ 删除索引: idx_player_dungeon');
        } catch (e) { /* 忽略 */ }

        // 删除字段
        const fieldsToDrop = [
            'last_dungeon_time', 'last_dungeon_date', 'daily_dungeon_count',
            'dungeon_start_time', 'dungeon_difficulty', 'dungeon_node_id',
            'dungeon_chapter_id', 'in_dungeon'
        ];
        for (const field of fieldsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${field}`);
                console.log(`  ✓ 删除字段: ${field}`);
            } catch (e) { /* 忽略 */ }
        }

        console.log('[Migration v0024] 回滚完成');
    }
};
