/**
 * 迁移脚本：cave_visitors 表新增奇遇字段
 *
 * 新增字段：
 *   - encounter_type: VARCHAR(50)，奇遇类型ID（如 treasure_pill/spirit_vein_residual/cave_trap/spirit_beast_encounter/nothing）
 *   - encounter_reward: TEXT，奇遇奖励 JSON（如 {"item_id":"low_healing_pill","item_count":1}）
 *
 * 幂等：通过 INFORMATION_SCHEMA 检查列是否已存在，重复执行不会报错
 */
'use strict';

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

async function columnExists(tableName, columnName) {
    const [result] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        { replacements: [tableName, columnName], type: QueryTypes.SELECT }
    );
    return result.cnt > 0;
}

async function up() {
    console.log('[migration_0064] 开始执行：cave_visitors 表新增奇遇字段');

    // 1. 添加 encounter_type 列
    if (!(await columnExists('cave_visitors', 'encounter_type'))) {
        await sequelize.query(
            `ALTER TABLE cave_visitors ADD COLUMN encounter_type VARCHAR(50) DEFAULT NULL COMMENT '奇遇类型ID（null=未触发奇遇）'`
        );
        console.log('  ✅ 新增列：cave_visitors.encounter_type');
    } else {
        console.log('  ⏭️ 列已存在：cave_visitors.encounter_type');
    }

    // 2. 添加 encounter_reward 列
    if (!(await columnExists('cave_visitors', 'encounter_reward'))) {
        await sequelize.query(
            `ALTER TABLE cave_visitors ADD COLUMN encounter_reward TEXT DEFAULT NULL COMMENT '奇遇奖励 JSON'`
        );
        console.log('  ✅ 新增列：cave_visitors.encounter_reward');
    } else {
        console.log('  ⏭️ 列已存在：cave_visitors.encounter_reward');
    }

    // 3. 添加索引用于快速查询每日奇遇次数
    const [indexResult] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cave_visitors' AND INDEX_NAME = 'idx_encounter_type'`
    );
    if (indexResult[0].cnt === 0) {
        await sequelize.query(
            `ALTER TABLE cave_visitors ADD INDEX idx_encounter_type (encounter_type)`
        );
        console.log('  ✅ 新增索引：idx_encounter_type');
    } else {
        console.log('  ⏭️ 索引已存在：idx_encounter_type');
    }

    console.log('[migration_0064] 执行完成');
}

async function down() {
    console.log('[migration_0064] 回滚：删除 cave_visitors 奇遇字段');
    if (await columnExists('cave_visitors', 'encounter_type')) {
        await sequelize.query('ALTER TABLE cave_visitors DROP COLUMN encounter_type');
    }
    if (await columnExists('cave_visitors', 'encounter_reward')) {
        await sequelize.query('ALTER TABLE cave_visitors DROP COLUMN encounter_reward');
    }
    console.log('[migration_0064] 回滚完成');
}

module.exports = { up, down };
