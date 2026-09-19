/**
 * 数据库迁移脚本
 * 版本: 0031
 * 描述: 为 players 表新增批次3 字段（飞升/夺舍/第二元神/小世界/道侣/侍妾/香火/神识/法则）
 * 创建时间: 2026-07-19
 *
 * 背景：
 *   批次3 引入飞升+夺舍重生、后期系统（第二元神/小世界/神庙香火/神识/法则）、
 *   道侣/双修/侍妾等多个新玩法子系统，原 players 表缺少承载这些子系统运行时状态的字段。
 *   本迁移按 docs/批次3_设计文档.md §3.2.5 一次性补全 9 个字段 + 2 个索引。
 *
 * 已存在字段（无需新增，仅作说明）：
 *   - remnant_soul            - 残魂值（飞升前置 ≥80）
 *   - soul_state              - 灵魂状态（normal/weak/shattered/recovering）
 *   - ask_dao_insight         - 问道感悟值（飞升成功率加成）
 *   - dharma_form_level       - 法相天地等级（0-9）
 *   - last_reincarnation_time - 上次夺舍时间（CD 计算）
 *   - weakness_end_time       - 虚弱状态结束时间
 *
 * 新增字段（players 表，共 9 个）：
 *   - reincarnation_count   INT       - 历史夺舍次数（每次+1）
 *   - ascension_eligible    TINYINT   - 是否满足飞升前置（0否1是，冗余字段加速查询）
 *   - second_soul_count     INT       - 已凝练第二元神数量（0-3）
 *   - small_world_id        BIGINT    - 所属小世界ID
 *   - dao_companion_id      BIGINT    - 道侣关系ID
 *   - concubine_count       INT       - 当前侍妾数量
 *   - incense_balance       INT       - 当前香火余额
 *   - divine_sense_balance  INT       - 当前神识余额
 *   - law_points            INT       - 法则点数（用于法则转换）
 *
 * 索引：
 *   - idx_players_ascension_eligible：按飞升资格筛选索引，加速 GM 后台批量查询
 *   - idx_players_dao_companion：道侣关系索引，加速道侣关系反查
 *
 * 幂等性：每个字段/索引单独检查 INFORMATION_SCHEMA 后操作
 */

module.exports = {
    description: '为 players 表新增批次3 字段（9 个字段 + 2 个索引）',
    version: 31,

    /**
     * 执行迁移：为 players 表添加批次3 玩家扩展字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0031] 开始为 players 表添加批次3 字段...');

        // 待添加字段列表（按设计文档顺序）
        // 注意：不使用 AFTER 子句，因为该子句依赖字段存在性，幂等性较差
        const columnsToAdd = [
            {
                name: 'reincarnation_count',
                ddl: "ADD COLUMN reincarnation_count INT NOT NULL DEFAULT 0 COMMENT '历史夺舍次数（每次+1）'"
            },
            {
                name: 'ascension_eligible',
                ddl: "ADD COLUMN ascension_eligible TINYINT NOT NULL DEFAULT 0 COMMENT '是否满足飞升前置（0否1是，冗余字段加速查询）'"
            },
            {
                name: 'second_soul_count',
                ddl: "ADD COLUMN second_soul_count INT NOT NULL DEFAULT 0 COMMENT '已凝练第二元神数量（0-3）'"
            },
            {
                name: 'small_world_id',
                ddl: "ADD COLUMN small_world_id BIGINT NULL COMMENT '所属小世界ID'"
            },
            {
                name: 'dao_companion_id',
                ddl: "ADD COLUMN dao_companion_id BIGINT NULL COMMENT '道侣关系ID'"
            },
            {
                name: 'concubine_count',
                ddl: "ADD COLUMN concubine_count INT NOT NULL DEFAULT 0 COMMENT '当前侍妾数量'"
            },
            {
                name: 'incense_balance',
                ddl: "ADD COLUMN incense_balance INT NOT NULL DEFAULT 0 COMMENT '当前香火余额'"
            },
            {
                name: 'divine_sense_balance',
                ddl: "ADD COLUMN divine_sense_balance INT NOT NULL DEFAULT 0 COMMENT '当前神识余额'"
            },
            {
                name: 'law_points',
                ddl: "ADD COLUMN law_points INT NOT NULL DEFAULT 0 COMMENT '法则点数（用于法则转换）'"
            }
        ];

        // 查询当前 players 表的所有列（幂等性检查）
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

        // 新增索引
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        // 飞升资格索引：GM 后台按飞升资格批量查询玩家
        if (!existingIndexes.includes('idx_players_ascension_eligible')) {
            await sequelize.query('CREATE INDEX idx_players_ascension_eligible ON players (ascension_eligible)');
            console.log('  ✓ 添加索引: idx_players_ascension_eligible');
        } else {
            console.log('  - 索引已存在，跳过: idx_players_ascension_eligible');
        }

        // 道侣关系索引：根据道侣关系ID反查玩家
        if (!existingIndexes.includes('idx_players_dao_companion')) {
            await sequelize.query('CREATE INDEX idx_players_dao_companion ON players (dao_companion_id)');
            console.log('  ✓ 添加索引: idx_players_dao_companion');
        } else {
            console.log('  - 索引已存在，跳过: idx_players_dao_companion');
        }

        console.log(`[Migration v0031] 迁移完成：新增 ${addedCount} 个字段`);
    },

    /**
     * 回滚迁移：删除新增字段与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0031] 开始回滚 players 表批次3 字段...');

        // 先删除索引（字段删除前必须先删索引，否则会因索引依赖字段而失败）
        const indexesToDrop = ['idx_players_dao_companion', 'idx_players_ascension_eligible'];
        for (const idx of indexesToDrop) {
            try {
                await sequelize.query(`DROP INDEX ${idx} ON players`);
                console.log(`  ✓ 删除索引: ${idx}`);
            } catch (e) {
                console.log(`  - 索引不存在，跳过: ${idx}`);
            }
        }

        // 删除字段（倒序删除，避免潜在依赖问题）
        const columnsToRemove = [
            'law_points',
            'divine_sense_balance',
            'incense_balance',
            'concubine_count',
            'dao_companion_id',
            'small_world_id',
            'second_soul_count',
            'ascension_eligible',
            'reincarnation_count'
        ];
        for (const col of columnsToRemove) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${col}`);
                console.log(`  ✓ 删除字段: ${col}`);
            } catch (e) {
                console.log(`  - 字段不存在，跳过: ${col}`);
            }
        }

        console.log('[Migration v0031] 回滚完成');
    }
};
