/**
 * 迁移脚本 0056：为 players 表添加"天机回溯"（NascentSoulService）专属字段
 *
 * 设计依据：xiuxian_game_guide.md 第3节·元婴以后阶段机制
 *   元婴后期玩家在虚弱/残魂过低状态下的紧急回退机制，与飞升专用的
 *   AscensionService.revert（仅飞升失败状态可回溯）不同，本功能用于
 *   元婴出窍/探寻裂缝等失败后的状态恢复。
 *
 * 新增字段（players 表）：
 *   - daily_tianji_revert_count  INT NOT NULL DEFAULT 0  今日天机回溯次数（跨日重置）
 *   - last_tianji_revert_date    DATE DEFAULT NULL       最后天机回溯日期（跨日重置）
 *   - last_tianji_revert_time    DATETIME DEFAULT NULL   最后天机回溯时间（冷却计算）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0056_tianji_revert_fields',
    description: '为 players 表添加天机回溯（元婴后期）专属字段',

    /**
     * 执行迁移：添加天机回溯相关字段
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
                console.log(`[migration_0056] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0056] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== players 表新增字段 ==========
        // daily_tianji_revert_count：今日天机回溯次数（跨日重置）
        await addColumn(
            'players',
            'daily_tianji_revert_count',
            "INT NOT NULL DEFAULT 0 COMMENT '今日天机回溯次数（跨日重置）'"
        );
        // last_tianji_revert_date：最后天机回溯日期（DATEONLY，跨日重置判断）
        await addColumn(
            'players',
            'last_tianji_revert_date',
            "DATE DEFAULT NULL COMMENT '最后天机回溯日期（跨日重置）'"
        );
        // last_tianji_revert_time：最后天机回溯时间（冷却计算）
        await addColumn(
            'players',
            'last_tianji_revert_time',
            "DATETIME DEFAULT NULL COMMENT '最后天机回溯时间（冷却计算）'"
        );

        console.log('[migration_0056] 天机回溯字段迁移完成');
    },

    /**
     * 回滚迁移：删除天机回溯相关字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        const columnsToDrop = [
            { table: 'players', column: 'daily_tianji_revert_count' },
            { table: 'players', column: 'last_tianji_revert_date' },
            { table: 'players', column: 'last_tianji_revert_time' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0056] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0056] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
