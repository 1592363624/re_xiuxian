/**
 * 数据库迁移脚本
 * 版本: 0029
 * 描述: 为 players 表新增荣誉/战绩字段（用于世界BOSS + 宗门战）
 * 创建时间: 2026-07-19
 *
 * 背景：
 *   世界BOSS和宗门战需要记录玩家历史战绩（荣誉值、击杀数、死亡数、BOSS参与数），
 *   原玩家表无相关字段。本迁移补全 5 个字段。
 *
 * 新增字段（players 表，共 5 个）：
 *   - honor_value              - 荣誉值（PVP/世界BOSS/宗门战通用货币）
 *   - war_kills_total          - 历史总击杀（PVP + 宗门战）
 *   - war_deaths_total         - 历史总死亡
 *   - boss_kill_count_total    - 历史BOSS击杀参与数
 *   - boss_first_kill_count    - 历史BOSS首杀次数
 *
 * 索引：
 *   - idx_players_honor：按荣誉值倒序索引，用于荣誉排行榜查询
 *
 * 幂等性：每个字段/索引单独检查 INFORMATION_SCHEMA 后操作
 */

module.exports = {
    description: '为 players 表新增荣誉/战绩字段（5 个字段 + 1 个索引）',
    version: 29,

    /**
     * 执行迁移：为 players 表添加荣誉相关字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0029] 开始为 players 表添加荣誉/战绩字段...');

        // 待添加字段列表
        const columnsToAdd = [
            {
                name: 'honor_value',
                ddl: "ADD COLUMN honor_value INT NOT NULL DEFAULT 0 COMMENT '荣誉值（PVP/世界BOSS/宗门战通用货币）'"
            },
            {
                name: 'war_kills_total',
                ddl: "ADD COLUMN war_kills_total INT NOT NULL DEFAULT 0 COMMENT '历史总击杀（PVP+宗门战）'"
            },
            {
                name: 'war_deaths_total',
                ddl: "ADD COLUMN war_deaths_total INT NOT NULL DEFAULT 0 COMMENT '历史总死亡'"
            },
            {
                name: 'boss_kill_count_total',
                ddl: "ADD COLUMN boss_kill_count_total INT NOT NULL DEFAULT 0 COMMENT '历史BOSS击杀参与数'"
            },
            {
                name: 'boss_first_kill_count',
                ddl: "ADD COLUMN boss_first_kill_count INT NOT NULL DEFAULT 0 COMMENT '历史BOSS首杀次数'"
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

        // 新增索引：荣誉值排行榜查询
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        if (!existingIndexes.includes('idx_players_honor')) {
            await sequelize.query('CREATE INDEX idx_players_honor ON players (honor_value DESC)');
            console.log('  ✓ 添加索引: idx_players_honor');
        } else {
            console.log('  - 索引已存在，跳过: idx_players_honor');
        }

        console.log(`[Migration v0029] 迁移完成：新增 ${addedCount} 个字段`);
    },

    /**
     * 回滚迁移：删除新增字段与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0029] 开始回滚 players 表荣誉字段...');

        // 删除索引
        try {
            await sequelize.query('DROP INDEX idx_players_honor ON players');
            console.log('  ✓ 删除索引: idx_players_honor');
        } catch (e) {
            console.log('  - 索引不存在，跳过');
        }

        // 删除字段（倒序删除，避免潜在依赖问题）
        const columnsToRemove = [
            'boss_first_kill_count',
            'boss_kill_count_total',
            'war_deaths_total',
            'war_kills_total',
            'honor_value'
        ];
        for (const col of columnsToRemove) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${col}`);
                console.log(`  ✓ 删除字段: ${col}`);
            } catch (e) {
                console.log(`  - 字段不存在，跳过: ${col}`);
            }
        }

        console.log('[Migration v0029] 回滚完成');
    }
};