/**
 * 数据库迁移脚本
 * 版本: 50
 * 描述: 灵兽升星系统（玩法文档第8节 灵兽升星）
 * 创建时间: 2026-07-21
 *
 * 设计要点：
 *   1. spirit_beasts 表新增字段：
 *      - beast_soul：兽魂（满级灵兽溢出经验凝练而得，配合妖丹用于通灵升星）
 *      - last_upgrade_star_time：上次升星时间（用于冷却限制，可选）
 *   2. 幂等性：所有 ALTER 前先检查列存在性
 *   3. 参数化查询防 SQL 注入
 *
 * 业务背景：
 *   玩法文档第8节明确指出："满级后的经验不会完全浪费，会按阶级凝成兽魂；
 *   兽魂可配合妖丹用 .灵兽升星 <灵兽> 进行通灵升星，提升战力，
 *   并在 3 星、5 星强化噬金虫、啼魂兽、六翼霜蚣等灵兽的招牌特性。"
 *   原 _checkLevelUp 满级时直接清零 exp，未按文档凝练兽魂，本迁移补字段以支持新机制。
 */
'use strict';

module.exports = {
    description: '灵兽升星系统：spirit_beasts 表新增 beast_soul / last_upgrade_star_time 字段',
    version: 50,

    /**
     * 执行迁移
     * @param {import('sequelize').Sequelize} sequelizeInstance - sequelize 实例
     * @param {object} QueryTypes - QueryTypes 对象
     */
    async up(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;

        // 辅助函数：检查列是否存在（幂等性保证）
        async function columnExists(tableName, columnName) {
            const [rows] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
                { replacements: [tableName, columnName], type: QueryTypes.SELECT }
            );
            return rows && rows.length > 0;
        }

        // ========== 1. spirit_beasts 表新增 beast_soul 字段 ==========
        // 兽魂：满级灵兽溢出经验按 ratio 凝练的数值，配合妖丹用于升星
        if (!(await columnExists('spirit_beasts', 'beast_soul'))) {
            await sequelize.query(`
                ALTER TABLE spirit_beasts
                ADD COLUMN beast_soul INT NOT NULL DEFAULT 0
                COMMENT '兽魂（满级灵兽溢出经验凝练而得，配合妖丹用于通灵升星）'
                AFTER star_level
            `);
            console.log('[Migration 0050] spirit_beasts.beast_soul 字段添加成功');
        }

        // ========== 2. spirit_beasts 表新增 last_upgrade_star_time 字段 ==========
        // 升星冷却时间（避免频繁升星操作造成数据竞争或刷屏）
        if (!(await columnExists('spirit_beasts', 'last_upgrade_star_time'))) {
            await sequelize.query(`
                ALTER TABLE spirit_beasts
                ADD COLUMN last_upgrade_star_time DATETIME NULL
                COMMENT '最后升星时间（用于升星冷却限制）'
                AFTER beast_soul
            `);
            console.log('[Migration 0050] spirit_beasts.last_upgrade_star_time 字段添加成功');
        }

        console.log('[Migration 0050] 灵兽升星系统迁移完成');
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

        if (await columnExists('spirit_beasts', 'last_upgrade_star_time')) {
            await sequelize.query('ALTER TABLE spirit_beasts DROP COLUMN last_upgrade_star_time');
        }
        if (await columnExists('spirit_beasts', 'beast_soul')) {
            await sequelize.query('ALTER TABLE spirit_beasts DROP COLUMN beast_soul');
        }

        console.log('[Migration 0050] 回滚完成');
    }
};
