/**
 * 数据库迁移脚本
 * 版本: 0023
 * 描述: 为 players 表新增高阶境界系统字段（元婴出窍/问道/法相天地/探寻裂缝/虚弱/残魂/夺舍）
 * 创建时间: 2026-07-19
 *
 * 新增字段（共 16 个）：
 *   元婴出窍系统：
 *   - soul_state：元神状态（none=在体，out=出窍中，recalling=召回中）
 *   - soul_out_start_time / soul_out_end_time：出窍时间区间
 *   - soul_out_duration：本次出窍计划时长(秒)
 *   - soul_out_target：出窍目标（explore=探索，scout=窥探，cultivate=远方修炼）
 *   - daily_soul_out_count：今日出窍次数（跨日重置）
 *   - last_soul_out_date / last_soul_out_time：日重置与冷却
 *
 *   问道系统：
 *   - ask_dao_insight：问道感悟值
 *   - daily_ask_dao_count：今日问道次数（跨日重置）
 *   - last_ask_dao_date：最后问道日期
 *
 *   法相天地：
 *   - dharma_form_level：法相天地等级（0-9）
 *
 *   探寻裂缝：
 *   - daily_fracture_explore_count：今日裂缝探索次数
 *   - last_fracture_explore_time：最后裂缝探索时间
 *
 *   残魂与夺舍：
 *   - remnant_soul：残魂值（0-100，低于30触发，影响突破与修炼）
 *   - last_reincarnation_time：最后夺舍时间（冷却用）
 *
 * 幂等性：每个字段单独检查 INFORMATION_SCHEMA.COLUMNS 后 ADD COLUMN
 *
 * MySQL 5.6 兼容性：
 *   - BOOLEAN 使用 TINYINT(1)
 *   - 每列单独 ALTER TABLE，避免多列同时 ADD 失败
 */

module.exports = {
    description: '为 players 表新增高阶境界系统字段（元婴出窍/问道/法相天地/探寻裂缝/虚弱/残魂/夺舍）',
    version: 23,

    /**
     * 执行迁移：为 players 表添加新列
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0023] 开始扩展 players 表（高阶境界系统）...');

        // 待添加字段列表（按业务分组）
        const columnsToAdd = [
            // ===== 元婴出窍系统字段 =====
            { name: 'soul_state', ddl: "ADD COLUMN soul_state VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT '元神状态：none=在体，out=出窍中，recalling=召回中'" },
            { name: 'soul_out_start_time', ddl: "ADD COLUMN soul_out_start_time DATETIME NULL COMMENT '出窍开始时间'" },
            { name: 'soul_out_end_time', ddl: "ADD COLUMN soul_out_end_time DATETIME NULL COMMENT '出窍预计结束时间'" },
            { name: 'soul_out_duration', ddl: "ADD COLUMN soul_out_duration INT NOT NULL DEFAULT 0 COMMENT '本次出窍计划时长(秒)'" },
            { name: 'soul_out_target', ddl: "ADD COLUMN soul_out_target VARCHAR(20) NOT NULL DEFAULT 'explore' COMMENT '出窍目标：explore=探索，scout=窥探，cultivate=远方修炼'" },
            { name: 'daily_soul_out_count', ddl: "ADD COLUMN daily_soul_out_count INT NOT NULL DEFAULT 0 COMMENT '今日出窍次数（跨日重置）'" },
            { name: 'last_soul_out_date', ddl: "ADD COLUMN last_soul_out_date DATE NULL COMMENT '最后出窍日期（跨日重置）'" },
            { name: 'last_soul_out_time', ddl: "ADD COLUMN last_soul_out_time DATETIME NULL COMMENT '最后出窍结束时间（冷却计算）'" },
            // ===== 问道系统字段 =====
            { name: 'ask_dao_insight', ddl: "ADD COLUMN ask_dao_insight FLOAT NOT NULL DEFAULT 0 COMMENT '问道感悟值（用于突破加成）'" },
            { name: 'daily_ask_dao_count', ddl: "ADD COLUMN daily_ask_dao_count INT NOT NULL DEFAULT 0 COMMENT '今日问道次数（跨日重置）'" },
            { name: 'last_ask_dao_date', ddl: "ADD COLUMN last_ask_dao_date DATE NULL COMMENT '最后问道日期（跨日重置）'" },
            // ===== 法相天地字段 =====
            { name: 'dharma_form_level', ddl: "ADD COLUMN dharma_form_level INT NOT NULL DEFAULT 0 COMMENT '法相天地等级（0-9，每级提供5%属性加成）'" },
            // ===== 探寻裂缝字段 =====
            { name: 'daily_fracture_explore_count', ddl: "ADD COLUMN daily_fracture_explore_count INT NOT NULL DEFAULT 0 COMMENT '今日裂缝探索次数'" },
            { name: 'last_fracture_explore_time', ddl: "ADD COLUMN last_fracture_explore_time DATETIME NULL COMMENT '最后裂缝探索时间'" },
            // ===== 残魂与夺舍字段 =====
            { name: 'remnant_soul', ddl: "ADD COLUMN remnant_soul FLOAT NOT NULL DEFAULT 100 COMMENT '残魂值（0-100，低于30触发不稳定）'" },
            { name: 'last_reincarnation_time', ddl: "ADD COLUMN last_reincarnation_time DATETIME NULL COMMENT '最后夺舍时间（冷却用）'" }
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

        if (!existingIndexes.includes('idx_player_soul_out')) {
            await sequelize.query('CREATE INDEX idx_player_soul_out ON players (soul_state, soul_out_end_time)');
            console.log('  ✓ 添加索引: idx_player_soul_out');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_soul_out');
        }

        if (!existingIndexes.includes('idx_player_remnant_soul')) {
            await sequelize.query('CREATE INDEX idx_player_remnant_soul ON players (remnant_soul)');
            console.log('  ✓ 添加索引: idx_player_remnant_soul');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_remnant_soul');
        }

        console.log(`[Migration v0023] 迁移完成：新增 ${addedCount} 个字段`);
    },

    /**
     * 回滚迁移：删除新增字段与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0023] 开始回滚 players 表高阶境界系统字段...');

        // 删除索引
        try { await sequelize.query('DROP INDEX idx_player_remnant_soul ON players'); console.log('  ✓ 删除索引: idx_player_remnant_soul'); } catch (e) { console.log('  - 索引不存在，跳过'); }
        try { await sequelize.query('DROP INDEX idx_player_soul_out ON players'); console.log('  ✓ 删除索引: idx_player_soul_out'); } catch (e) { console.log('  - 索引不存在，跳过'); }

        // 删除字段
        const fieldsToDrop = [
            'last_reincarnation_time', 'remnant_soul',
            'last_fracture_explore_time', 'daily_fracture_explore_count',
            'dharma_form_level',
            'last_ask_dao_date', 'daily_ask_dao_count', 'ask_dao_insight',
            'last_soul_out_time', 'last_soul_out_date', 'daily_soul_out_count',
            'soul_out_target', 'soul_out_duration', 'soul_out_end_time',
            'soul_out_start_time', 'soul_state'
        ];

        for (const f of fieldsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${f}`);
                console.log(`  ✓ 删除字段: ${f}`);
            } catch (e) {
                console.log(`  - 字段不存在或删除失败，跳过: ${f}`);
            }
        }

        console.log('[Migration v0023] 回滚完成');
    }
};
