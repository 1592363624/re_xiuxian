/**
 * 迁移脚本 0062：为 player_equipment 表添加 deep_line_state 字段
 *
 * 设计依据：xiuxian_game_guide.md 第19节·法宝深线
 *   法宝深线系统统一存储所有法宝线（血魔剑/虚天鼎/掌天瓶/幻世轮）的状态，
 *   使用 JSON 字段避免表结构频繁变更。当前实现血魔剑线（5阶血契+魔染/镇契双值博弈）。
 *
 * 字段设计：
 *   - deep_line_state: TEXT，存储 JSON 状态对象
 *     · blood_sword: 血魔剑线状态
 *       - blood_pact_stage: 0~5 血契阶数
 *       - blood_pact_weekly_progress: 本周血契累计进度（上限 36）
 *       - blood_pact_week_reset_at: 周重置日期
 *       - last_sacrifice_at: 上次祭血时间
 *       - corruption: 0~100 魔染值
 *       - suppression: 0~100 镇契值
 *       - imprint_type: 'none'|'blood'|'suppress' 铭印类型
 *       - last_imprint_at: 上次铭印时间
 *       - sheath_until: 封鞘截止时间
 *     · 预留：xutian_cauldron / sky_bottle / five_element_wheel
 *
 * 幂等性：通过 INFORMATION_SCHEMA.COLUMNS 检查字段是否已存在，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0062_artifact_deep_line_state',
    description: '为 player_equipment 表添加 deep_line_state 字段（法宝深线状态JSON）',

    /**
     * 执行迁移：添加 deep_line_state 字段
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

        if (await columnExists('player_equipment', 'deep_line_state')) {
            console.log('[migration_0062] 字段 player_equipment.deep_line_state 已存在，跳过添加');
            return;
        }

        console.log('[migration_0062] 为 player_equipment 表添加 deep_line_state 字段');
        // 使用 TEXT 类型存储 JSON 字符串，兼容 MySQL 5.6（不支持 JSON 类型）
        // allowNull=true 让历史装备记录无需回填默认值，按需懒初始化
        await sequelize.query(`
            ALTER TABLE player_equipment
            ADD COLUMN deep_line_state TEXT NULL COMMENT '法宝深线状态JSON（血魔剑/虚天鼎/掌天瓶/幻世轮四条线统一存储）'
        `);

        console.log('[migration_0062] 迁移完成：player_equipment.deep_line_state 字段已添加');
    },

    /**
     * 回滚迁移：删除 deep_line_state 字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        /**
         * 检查字段是否已存在
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

        if (!(await columnExists('player_equipment', 'deep_line_state'))) {
            console.log('[migration_0062] 字段 player_equipment.deep_line_state 不存在，跳过删除');
            return;
        }

        console.log('[migration_0062] 回滚：删除 player_equipment.deep_line_state 字段');
        await sequelize.query(`
            ALTER TABLE player_equipment
            DROP COLUMN deep_line_state
        `);

        console.log('[migration_0062] 回滚完成');
    }
};
