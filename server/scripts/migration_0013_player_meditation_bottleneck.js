/**
 * 数据库迁移脚本
 * 版本: 0013
 * 描述: 为 players 表新增静思悟道系统与突破瓶颈系统字段
 * 创建时间: 2026-07-04
 *
 * 新增字段（共 14 个）：
 *   静思悟道系统：
 *   - is_meditating：是否正在悟道
 *   - meditation_start_time / meditation_end_time / meditation_duration：悟道时间区间
 *   - meditation_mode：悟道模式（normal/deep）
 *   - meditation_insight：本命感悟值（悟道结算获得）
 *   - daily_meditation_count / daily_deep_meditation_count：每日次数（跨日重置）
 *   - last_meditation_date / last_meditation_time：悟道冷却与日重置
 *
 *   突破瓶颈系统：
 *   - bottleneck_state：瓶颈状态（none/active/broken/failed）
 *   - bottleneck_realm_rank：处于瓶颈期的境界排名
 *   - bottleneck_insight / bottleneck_threshold：瓶颈感悟进度与阈值
 *   - bottleneck_started_at：瓶颈开始时间
 *   - breakthrough_failure_count：当前境界连续突破失败次数
 *
 * 幂等性：每个字段单独检查 INFORMATION_SCHEMA.COLUMNS 后 ADD COLUMN
 *
 * MySQL 5.6 兼容性：
 *   - BOOLEAN 使用 TINYINT(1)
 *   - 每列单独 ALTER TABLE，避免多列同时 ADD 失败
 */

module.exports = {
    description: '为 players 表新增静思悟道与突破瓶颈系统字段',
    version: 13,

    /**
     * 执行迁移：为 players 表添加新列
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0013] 开始扩展 players 表（静思悟道 + 突破瓶颈）...');

        // 待添加字段列表（按业务分组）
        const columnsToAdd = [
            // ===== 静思悟道系统字段 =====
            { name: 'is_meditating', ddl: "ADD COLUMN is_meditating TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否正在静思悟道中'" },
            { name: 'meditation_start_time', ddl: "ADD COLUMN meditation_start_time DATETIME NULL COMMENT '悟道开始时间'" },
            { name: 'meditation_end_time', ddl: "ADD COLUMN meditation_end_time DATETIME NULL COMMENT '悟道预计结束时间'" },
            { name: 'meditation_duration', ddl: "ADD COLUMN meditation_duration INT NOT NULL DEFAULT 0 COMMENT '计划悟道时长(秒)'" },
            { name: 'meditation_mode', ddl: "ADD COLUMN meditation_mode VARCHAR(20) NOT NULL DEFAULT 'normal' COMMENT '悟道模式：normal/deep'" },
            { name: 'meditation_insight', ddl: "ADD COLUMN meditation_insight FLOAT NOT NULL DEFAULT 0 COMMENT '本命感悟值（悟道结算获得）'" },
            { name: 'daily_meditation_count', ddl: "ADD COLUMN daily_meditation_count INT NOT NULL DEFAULT 0 COMMENT '今日悟道已用次数（跨日重置）'" },
            { name: 'daily_deep_meditation_count', ddl: "ADD COLUMN daily_deep_meditation_count INT NOT NULL DEFAULT 0 COMMENT '今日深度悟道已用次数'" },
            { name: 'last_meditation_date', ddl: "ADD COLUMN last_meditation_date DATE NULL COMMENT '最后悟道日期（用于跨日重置）'" },
            { name: 'last_meditation_time', ddl: "ADD COLUMN last_meditation_time DATETIME NULL COMMENT '最后悟道结束时间（用于冷却计算）'" },
            // ===== 突破瓶颈系统字段 =====
            { name: 'bottleneck_state', ddl: "ADD COLUMN bottleneck_state VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT '瓶颈状态：none/active/broken/failed'" },
            { name: 'bottleneck_realm_rank', ddl: "ADD COLUMN bottleneck_realm_rank INT NULL COMMENT '处于瓶颈期的境界排名'" },
            { name: 'bottleneck_insight', ddl: "ADD COLUMN bottleneck_insight FLOAT NOT NULL DEFAULT 0 COMMENT '当前瓶颈已积累的感悟值'" },
            { name: 'bottleneck_threshold', ddl: "ADD COLUMN bottleneck_threshold FLOAT NOT NULL DEFAULT 100 COMMENT '当前瓶颈感悟阈值'" },
            { name: 'bottleneck_started_at', ddl: "ADD COLUMN bottleneck_started_at DATETIME NULL COMMENT '瓶颈开始时间'" },
            { name: 'breakthrough_failure_count', ddl: "ADD COLUMN breakthrough_failure_count INT NOT NULL DEFAULT 0 COMMENT '当前境界连续突破失败次数'" }
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

        // 新增索引（用于状态清理调度器按状态查询）
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        if (!existingIndexes.includes('idx_player_meditating')) {
            await sequelize.query('CREATE INDEX idx_player_meditating ON players (is_meditating, meditation_end_time)');
            console.log('  ✓ 添加索引: idx_player_meditating');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_meditating');
        }

        if (!existingIndexes.includes('idx_player_bottleneck')) {
            await sequelize.query('CREATE INDEX idx_player_bottleneck ON players (bottleneck_state, bottleneck_realm_rank)');
            console.log('  ✓ 添加索引: idx_player_bottleneck');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_bottleneck');
        }

        console.log(`[Migration v0013] 迁移完成：新增 ${addedCount} 个字段`);
    },

    /**
     * 回滚迁移：删除新增字段与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0013] 开始回滚 players 表扩展字段...');

        // 删除索引
        try { await sequelize.query('DROP INDEX idx_player_bottleneck ON players'); console.log('  ✓ 删除索引: idx_player_bottleneck'); } catch (e) { console.log('  - 索引不存在，跳过'); }
        try { await sequelize.query('DROP INDEX idx_player_meditating ON players'); console.log('  ✓ 删除索引: idx_player_meditating'); } catch (e) { console.log('  - 索引不存在，跳过'); }

        // 删除字段
        const fieldsToDrop = [
            'breakthrough_failure_count', 'bottleneck_started_at', 'bottleneck_threshold', 'bottleneck_insight',
            'bottleneck_realm_rank', 'bottleneck_state',
            'last_meditation_time', 'last_meditation_date', 'daily_deep_meditation_count', 'daily_meditation_count',
            'meditation_insight', 'meditation_mode', 'meditation_duration', 'meditation_end_time',
            'meditation_start_time', 'is_meditating'
        ];

        for (const f of fieldsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${f}`);
                console.log(`  ✓ 删除字段: ${f}`);
            } catch (e) {
                console.log(`  - 字段不存在或删除失败，跳过: ${f}`);
            }
        }

        console.log('[Migration v0013] 回滚完成');
    }
};
