/**
 * 迁移脚本 0055：为 multi_dungeon_instance 与 multi_dungeon_choice 表添加落云秘圃专属字段
 *
 * 设计依据：xiuxian_game_guide.md 第32节·剧情与飞升 - 落云秘圃多人剧情副本
 *   - 第1幕·破禁入圃：选择破禁策略，影响灵脉之力（spirit_vein_power）与根脉稳定（root_stability）
 *   - 第2幕·护根稳压：选择护根策略，影响灵植灵气（spirit_plant_aura）与枝桠活力（branch_vigor）
 *   - 第3幕·截枝封灵：在"截枝封灵"与"留枝养灵"之间抉择，记录 act3_choice
 *     - cut_seal：必得灵眼树胚（lingyan_sapling），但根脉崩塌
 *     - branch_care：灵眼树胚几率低（25%），但根脉保持
 *     - balanced_harvest：均衡采枝，灵眼树胚几率 50%
 *
 * 新增字段（multi_dungeon_instance）：
 *   - spirit_vein_power    INT NOT NULL DEFAULT 0    灵脉之力（0-100，影响灵植生长）
 *   - root_stability       INT NOT NULL DEFAULT 0    根脉稳定（0-100，第3幕需≥50才不致失败）
 *   - branch_vigor         INT NOT NULL DEFAULT 0    枝桠活力（0-100，影响灵眼树胚掉落）
 *   - spirit_plant_aura    INT NOT NULL DEFAULT 0    灵植灵气（0-100，影响最终奖励）
 *   - act3_choice          VARCHAR(50) DEFAULT NULL  第3幕抉择键（cut_seal/branch_care/balanced_harvest）
 *
 * 新增字段（multi_dungeon_choice）：
 *   - spirit_vein_power_change   INT NOT NULL DEFAULT 0  灵脉之力变化（累加）
 *   - root_stability_change       INT NOT NULL DEFAULT 0  根脉稳定变化（累加）
 *   - branch_vigor_change         INT NOT NULL DEFAULT 0  枝桠活力变化（累加）
 *   - spirit_plant_aura_change    INT NOT NULL DEFAULT 0  灵植灵气变化（累加）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0055_luoyun_fields',
    description: '为 multi_dungeon_instance / multi_dungeon_choice 添加落云秘圃专属字段',

    /**
     * 执行迁移：添加落云秘圃专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    up: async (sequelize, QueryTypes) => {
        /**
         * 检查列是否已存在（幂等性保障）
         * @param {string} tableName - 表名
         * @param {string} columnName - 列名
         * @returns {Promise<boolean>} 是否存在
         */
        async function columnExists(tableName, columnName) {
            const [result] = await sequelize.query(
                `SELECT COUNT(*) AS cnt
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = :tbl
                   AND COLUMN_NAME = :col`,
                { replacements: { tbl: tableName, col: columnName }, type: QueryTypes.SELECT }
            );
            return result && result.cnt > 0;
        }

        /**
         * 添加列（幂等）
         * @param {string} tableName - 表名
         * @param {string} columnName - 列名
         * @param {string} columnDef - 列定义 SQL 片段
         */
        async function addColumn(tableName, columnName, columnDef) {
            if (await columnExists(tableName, columnName)) {
                console.log(`[migration_0055] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0055] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== multi_dungeon_instance 表新增字段 ==========
        // spirit_vein_power：灵脉之力（0-100），影响灵植生长
        await addColumn(
            'multi_dungeon_instance',
            'spirit_vein_power',
            "INT NOT NULL DEFAULT 0 COMMENT '落云秘圃·灵脉之力（0-100，影响灵植生长）'"
        );
        // root_stability：根脉稳定（0-100），第3幕需≥50才不致失败
        await addColumn(
            'multi_dungeon_instance',
            'root_stability',
            "INT NOT NULL DEFAULT 0 COMMENT '落云秘圃·根脉稳定（0-100，第3幕需≥50才不致失败）'"
        );
        // branch_vigor：枝桠活力（0-100），影响灵眼树胚掉落
        await addColumn(
            'multi_dungeon_instance',
            'branch_vigor',
            "INT NOT NULL DEFAULT 0 COMMENT '落云秘圃·枝桠活力（0-100，影响灵眼树胚掉落）'"
        );
        // spirit_plant_aura：灵植灵气（0-100），影响最终奖励
        await addColumn(
            'multi_dungeon_instance',
            'spirit_plant_aura',
            "INT NOT NULL DEFAULT 0 COMMENT '落云秘圃·灵植灵气（0-100，影响最终奖励）'"
        );
        // act3_choice：第3幕抉择键（cut_seal/branch_care/balanced_harvest），用于灵眼树胚掉落判定
        await addColumn(
            'multi_dungeon_instance',
            'act3_choice',
            "VARCHAR(50) DEFAULT NULL COMMENT '落云秘圃·第3幕抉择键（用于灵眼树胚掉落判定）'"
        );

        // ========== multi_dungeon_choice 表新增字段 ==========
        // spirit_vein_power_change：灵脉之力变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'spirit_vein_power_change',
            "INT NOT NULL DEFAULT 0 COMMENT '灵脉之力变化（落云秘圃专用，累加）'"
        );
        // root_stability_change：根脉稳定变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'root_stability_change',
            "INT NOT NULL DEFAULT 0 COMMENT '根脉稳定变化（落云秘圃专用，累加）'"
        );
        // branch_vigor_change：枝桠活力变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'branch_vigor_change',
            "INT NOT NULL DEFAULT 0 COMMENT '枝桠活力变化（落云秘圃专用，累加）'"
        );
        // spirit_plant_aura_change：灵植灵气变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'spirit_plant_aura_change',
            "INT NOT NULL DEFAULT 0 COMMENT '灵植灵气变化（落云秘圃专用，累加）'"
        );

        console.log('[migration_0055] 落云秘圃字段迁移完成');
    },

    /**
     * 回滚迁移：删除落云秘圃专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        // 回滚：删除新增字段
        const columnsToDrop = [
            { table: 'multi_dungeon_instance', column: 'spirit_vein_power' },
            { table: 'multi_dungeon_instance', column: 'root_stability' },
            { table: 'multi_dungeon_instance', column: 'branch_vigor' },
            { table: 'multi_dungeon_instance', column: 'spirit_plant_aura' },
            { table: 'multi_dungeon_instance', column: 'act3_choice' },
            { table: 'multi_dungeon_choice', column: 'spirit_vein_power_change' },
            { table: 'multi_dungeon_choice', column: 'root_stability_change' },
            { table: 'multi_dungeon_choice', column: 'branch_vigor_change' },
            { table: 'multi_dungeon_choice', column: 'spirit_plant_aura_change' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0055] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0055] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
