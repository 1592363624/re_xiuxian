/**
 * 迁移脚本 0071：为 player_ascension 表添加大衍诀参悟相关字段
 *
 * 设计依据：xiuxian_game_guide.md 第23节·大衍诀与傀儡路线
 *   `.参悟大衍诀` 推进大衍诀层数
 *
 * 新增字段：
 *   - dayan_meditate_count：今日参悟次数（跨日重置为0）
 *   - last_meditate_at：最后参悟时间（冷却计算用）
 *   - last_meditate_date：最后参悟日期（跨日重置判断用）
 *
 * 系统定位：
 *   大衍诀修炼系统的参悟推进机制需要记录每日次数与冷却时间，
 *   复用 player_ascension 表（已存在 dayan_level + dayan_exp 字段），
 *   无需新建表，仅追加 3 个字段。
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

module.exports = {
    name: '0071_dayan_meditate_fields',
    description: '为 player_ascension 表添加大衍诀参悟相关字段（dayan_meditate_count/last_meditate_at/last_meditate_date）',

    /**
     * 执行迁移：添加 3 个字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    up: async (sequelize, QueryTypes) => {
        /**
         * 检查字段是否已存在（幂等性保障）
         * @param {string} tableName - 表名
         * @param {string} columnName - 字段名
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

        // ===== 添加 dayan_meditate_count 字段 =====
        if (await columnExists('player_ascension', 'dayan_meditate_count')) {
            console.log('[migration_0071] dayan_meditate_count 字段已存在，跳过');
        } else {
            await sequelize.query(`
                ALTER TABLE player_ascension
                ADD COLUMN dayan_meditate_count INT NOT NULL DEFAULT 0 COMMENT '今日参悟次数（跨日重置为0）'
            `);
            console.log('[migration_0071] dayan_meditate_count 字段添加成功');
        }

        // ===== 添加 last_meditate_at 字段 =====
        if (await columnExists('player_ascension', 'last_meditate_at')) {
            console.log('[migration_0071] last_meditate_at 字段已存在，跳过');
        } else {
            await sequelize.query(`
                ALTER TABLE player_ascension
                ADD COLUMN last_meditate_at DATETIME NULL COMMENT '最后参悟时间（冷却计算用）'
            `);
            console.log('[migration_0071] last_meditate_at 字段添加成功');
        }

        // ===== 添加 last_meditate_date 字段 =====
        if (await columnExists('player_ascension', 'last_meditate_date')) {
            console.log('[migration_0071] last_meditate_date 字段已存在，跳过');
        } else {
            await sequelize.query(`
                ALTER TABLE player_ascension
                ADD COLUMN last_meditate_date DATE NULL COMMENT '最后参悟日期（跨日重置判断用）'
            `);
            console.log('[migration_0071] last_meditate_date 字段添加成功');
        }
    },

    /**
     * 回滚迁移：删除 3 个字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        await sequelize.query(`
            ALTER TABLE player_ascension
            DROP COLUMN IF EXISTS dayan_meditate_count,
            DROP COLUMN IF EXISTS last_meditate_at,
            DROP COLUMN IF EXISTS last_meditate_date
        `);
        console.log('[migration_0071] 大衍诀参悟字段已删除');
    }
};
