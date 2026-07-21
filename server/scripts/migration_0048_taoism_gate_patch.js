/**
 * 数据库迁移脚本
 * 版本: 48
 * 描述: 太一门引道系统补丁——添加每日修炼次数字段
 * 创建时间: 2026-07-21
 *
 * 设计要点：
 *   1. 原 TaoismGateService.cultivate 使用 daily_tasks 中 cultivate 任务的 current_count
 *      作为每日修炼次数判断依据，但该 current_count 受 target_count 限制（最大3），
 *      导致 daily_cultivate_limit=5 永远无法触达，每日次数限制失效。
 *   2. 本迁移新增 daily_cultivate_count 字段（每日重置）+ last_cultivate_date（跨日判断）
 *   3. 幂等性：所有 ALTER 前先检查列是否存在
 *   4. 参数化查询防 SQL 注入
 */
'use strict';

module.exports = {
    description: '太一门引道补丁：player_taoism_gate 新增 daily_cultivate_count + last_cultivate_date 字段',
    version: 48,

    /**
     * 执行迁移
     * @param {import('sequelize').Sequelize} sequelizeInstance - sequelize 实例
     * @param {object} QueryTypes - QueryTypes 对象
     */
    async up(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;

        // 辅助函数：检查列是否存在
        async function columnExists(tableName, columnName) {
            const [rows] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
                { replacements: [tableName, columnName], type: QueryTypes.SELECT }
            );
            return rows && rows.length > 0;
        }

        // ========== 1. 新增 daily_cultivate_count 字段（每日修炼次数，跨日重置） ==========
        if (!(await columnExists('player_taoism_gate', 'daily_cultivate_count'))) {
            await sequelize.query(`
                ALTER TABLE player_taoism_gate
                ADD COLUMN daily_cultivate_count INT NOT NULL DEFAULT 0
                COMMENT '今日已修炼次数（跨日重置，上限 daily_cultivate_limit）'
                AFTER total_resonance_count
            `);
            console.log('[Migration 0048] player_taoism_gate.daily_cultivate_count 字段添加成功');
        }

        // ========== 2. 新增 last_cultivate_date 字段（最后修炼日期，跨日重置基准） ==========
        if (!(await columnExists('player_taoism_gate', 'last_cultivate_date'))) {
            await sequelize.query(`
                ALTER TABLE player_taoism_gate
                ADD COLUMN last_cultivate_date DATE NULL
                COMMENT '最后修炼日期（跨日重置 daily_cultivate_count）'
                AFTER daily_cultivate_count
            `);
            console.log('[Migration 0048] player_taoism_gate.last_cultivate_date 字段添加成功');
        }

        console.log('[Migration 0048] 太一门引道补丁迁移完成');
    },

    /**
     * 回滚迁移（谨慎使用）
     */
    async down(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;

        async function columnExists(tableName, columnName) {
            const [rows] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
                { replacements: [tableName, columnName], type: QueryTypes.SELECT }
            );
            return rows && rows.length > 0;
        }

        if (await columnExists('player_taoism_gate', 'last_cultivate_date')) {
            await sequelize.query('ALTER TABLE player_taoism_gate DROP COLUMN last_cultivate_date');
        }
        if (await columnExists('player_taoism_gate', 'daily_cultivate_count')) {
            await sequelize.query('ALTER TABLE player_taoism_gate DROP COLUMN daily_cultivate_count');
        }

        console.log('[Migration 0048] 回滚完成');
    }
};
