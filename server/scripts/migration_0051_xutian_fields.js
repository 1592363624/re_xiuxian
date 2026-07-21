/**
 * 迁移脚本 0051：为 multi_dungeon_instance 与 multi_dungeon_choice 表添加虚天殿专属字段
 *
 * 设计依据：批次3 设计文档第20节·副本决策 - 虚天殿6幕副本
 *   - 第1幕·选择道路：冰道/火道（path_choice = 1/2），影响后续变量变化
 *   - 第2幕·阵策：影响 formation_power（阵法强度 0-100）
 *   - 第6幕·后殿阵策：6回合自动决战，虚天主魂HP（void_soul_hp）归零 + 阵法强度 ≥70 通关
 *
 * 新增字段（multi_dungeon_instance）：
 *   - path_choice       TINYINT NOT NULL DEFAULT 0  道路选择（0=未选 / 1=冰道 / 2=火道）
 *   - formation_power   INT NOT NULL DEFAULT 30     阵法强度（0-100，影响决战伤害与通关）
 *   - void_soul_hp      BIGINT NULL                 虚天主魂HP（第六幕使用，null=未进入第六幕）
 *
 * 新增字段（multi_dungeon_choice）：
 *   - path_choice_change       TINYINT NULL          道路选择变化（直接设置而非累加，仅第一幕有值）
 *   - formation_power_change   INT NOT NULL DEFAULT 0 阵法强度变化（累加）
 *   - void_soul_hp_change      BIGINT NULL            虚天主魂HP变化（第六幕自动决战回合记录用，负值表示削减）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0051_xutian_fields',
    description: '为 multi_dungeon_instance / multi_dungeon_choice 添加虚天殿专属字段',

    /**
     * 执行迁移：添加虚天殿专属字段
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
                console.log(`[migration_0051] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0051] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== multi_dungeon_instance 表新增字段 ==========
        // path_choice：道路选择（0=未选 / 1=冰道 / 2=火道），TINYINT 节省空间
        await addColumn(
            'multi_dungeon_instance',
            'path_choice',
            "TINYINT NOT NULL DEFAULT 0 COMMENT '虚天殿·道路选择（0=未选 / 1=冰道 / 2=火道）'"
        );
        // formation_power：阵法强度（0-100），影响第六幕决战伤害与通关条件
        await addColumn(
            'multi_dungeon_instance',
            'formation_power',
            "INT NOT NULL DEFAULT 30 COMMENT '虚天殿·阵法强度（0-100，影响决战伤害与通关）'"
        );
        // void_soul_hp：虚天主魂HP（初始1500000，null=未进入第六幕）
        await addColumn(
            'multi_dungeon_instance',
            'void_soul_hp',
            "BIGINT NULL COMMENT '虚天殿·虚天主魂HP（第六幕使用，null=未进入第六幕）'"
        );

        // ========== multi_dungeon_choice 表新增字段 ==========
        // path_choice_change：道路选择变化（仅第一幕有值，直接设置而非累加）
        await addColumn(
            'multi_dungeon_choice',
            'path_choice_change',
            "TINYINT NULL COMMENT '道路选择变化（虚天殿第一幕专用，直接设置 1=冰道/2=火道）'"
        );
        // formation_power_change：阵法强度变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'formation_power_change',
            "INT NOT NULL DEFAULT 0 COMMENT '阵法强度变化（虚天殿专用，累加）'"
        );
        // void_soul_hp_change：虚天主魂HP变化（第六幕自动决战回合记录用，负值表示削减）
        await addColumn(
            'multi_dungeon_choice',
            'void_soul_hp_change',
            "BIGINT NULL COMMENT '虚天主魂HP变化（虚天殿第六幕专用，负值表示削减）'"
        );

        console.log('[migration_0051] 虚天殿字段迁移完成');
    },

    /**
     * 回滚迁移：删除虚天殿专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        // 回滚：删除新增字段
        const columnsToDrop = [
            { table: 'multi_dungeon_instance', column: 'path_choice' },
            { table: 'multi_dungeon_instance', column: 'formation_power' },
            { table: 'multi_dungeon_instance', column: 'void_soul_hp' },
            { table: 'multi_dungeon_choice', column: 'path_choice_change' },
            { table: 'multi_dungeon_choice', column: 'formation_power_change' },
            { table: 'multi_dungeon_choice', column: 'void_soul_hp_change' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0051] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0051] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
