/**
 * 迁移脚本 0054：为 multi_dungeon_instance 与 multi_dungeon_choice 表添加小极宫专属字段
 *
 * 设计依据：xiuxian_game_guide.md 第32节·剧情与飞升 - 北冥小极宫多人剧情副本
 *   - 第1幕·玄冰花之行：采摘策略影响咒扰（curse_disorder）
 *   - 第2幕·五焰冲关：火焰之力（flame_power）与冰封之力（ice_seal_power）相互克制
 *   - 第3幕·寒骊翻脸：阴罗宗队员可选阴幡镇魂（消耗阴罗幡煞气 yinluo_banner_qi ≥ 50）
 *   - 第4幕·冰海妖围：需在 8 回合内将冰封之力推到 100 通关
 *
 * 新增字段（multi_dungeon_instance）：
 *   - curse_disorder      INT NOT NULL DEFAULT 0   咒扰值（0-100，高时全员受伤）
 *   - ice_seal_power      INT NOT NULL DEFAULT 50   冰封之力（0-100，第4幕需达到 100 通关）
 *   - flame_power         INT NOT NULL DEFAULT 0     火焰之力（0-100，第2幕机制）
 *   - yinluo_banner_qi    INT NOT NULL DEFAULT 0    阴罗幡煞气（队伍总煞气，第3幕消耗）
 *
 * 新增字段（multi_dungeon_choice）：
 *   - curse_disorder_change     INT NOT NULL DEFAULT 0  咒扰变化（累加）
 *   - ice_seal_power_change     INT NOT NULL DEFAULT 0  冰封之力变化（累加）
 *   - flame_power_change        INT NOT NULL DEFAULT 0  火焰之力变化（累加）
 *   - yinluo_banner_qi_change   INT NOT NULL DEFAULT 0  阴罗幡煞气变化（负值表示消耗）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0054_xiaoji_fields',
    description: '为 multi_dungeon_instance / multi_dungeon_choice 添加小极宫专属字段',

    /**
     * 执行迁移：添加小极宫专属字段
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
                console.log(`[migration_0054] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0054] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== multi_dungeon_instance 表新增字段 ==========
        // curse_disorder：咒扰值（0-100），高时全员受伤，第1幕起累积
        await addColumn(
            'multi_dungeon_instance',
            'curse_disorder',
            "INT NOT NULL DEFAULT 0 COMMENT '小极宫·咒扰值（0-100，高时全员受伤）'"
        );
        // ice_seal_power：冰封之力（0-100），第4幕需达到 100 通关
        await addColumn(
            'multi_dungeon_instance',
            'ice_seal_power',
            "INT NOT NULL DEFAULT 50 COMMENT '小极宫·冰封之力（0-100，第4幕需达到100通关）'"
        );
        // flame_power：火焰之力（0-100），第2幕机关机制
        await addColumn(
            'multi_dungeon_instance',
            'flame_power',
            "INT NOT NULL DEFAULT 0 COMMENT '小极宫·火焰之力（0-100，第2幕机关机制）'"
        );
        // yinluo_banner_qi：阴罗幡煞气（队伍总煞气），第3幕阴幡镇魂消耗
        await addColumn(
            'multi_dungeon_instance',
            'yinluo_banner_qi',
            "INT NOT NULL DEFAULT 0 COMMENT '小极宫·阴罗幡煞气（队伍总煞气，第3幕消耗）'"
        );

        // ========== multi_dungeon_choice 表新增字段 ==========
        // curse_disorder_change：咒扰变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'curse_disorder_change',
            "INT NOT NULL DEFAULT 0 COMMENT '咒扰变化（小极宫专用，累加）'"
        );
        // ice_seal_power_change：冰封之力变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'ice_seal_power_change',
            "INT NOT NULL DEFAULT 0 COMMENT '冰封之力变化（小极宫专用，累加）'"
        );
        // flame_power_change：火焰之力变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'flame_power_change',
            "INT NOT NULL DEFAULT 0 COMMENT '火焰之力变化（小极宫专用，累加）'"
        );
        // yinluo_banner_qi_change：阴罗幡煞气变化（负值表示消耗）
        await addColumn(
            'multi_dungeon_choice',
            'yinluo_banner_qi_change',
            "INT NOT NULL DEFAULT 0 COMMENT '阴罗幡煞气变化（小极宫专用，负值表示消耗）'"
        );

        console.log('[migration_0054] 小极宫字段迁移完成');
    },

    /**
     * 回滚迁移：删除小极宫专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        // 回滚：删除新增字段
        const columnsToDrop = [
            { table: 'multi_dungeon_instance', column: 'curse_disorder' },
            { table: 'multi_dungeon_instance', column: 'ice_seal_power' },
            { table: 'multi_dungeon_instance', column: 'flame_power' },
            { table: 'multi_dungeon_instance', column: 'yinluo_banner_qi' },
            { table: 'multi_dungeon_choice', column: 'curse_disorder_change' },
            { table: 'multi_dungeon_choice', column: 'ice_seal_power_change' },
            { table: 'multi_dungeon_choice', column: 'flame_power_change' },
            { table: 'multi_dungeon_choice', column: 'yinluo_banner_qi_change' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0054] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0054] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
