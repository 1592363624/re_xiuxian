/**
 * 迁移脚本 0082：player_sects 表新增宗门任务接取字段
 *
 * 新增字段：
 *   - quests_accepted (TEXT): 当日已接取任务ID（JSON数组）
 *   - quests_accepted_at (TEXT): 接取任务时间戳（JSON对象）
 *
 * 业务说明：
 *   - 宗门任务系统新增"接取 → 等待 → 提交"流程，防止玩家无操作直接提交任务领奖
 *   - MySQL 5.6 TEXT 列不支持 DEFAULT，应用层（Sequelize model）处理默认值
 */
const sequelize = require('../config/database');

const migrationInfo = {
    description: 'player_sects 表新增 quests_accepted / quests_accepted_at 字段',
    version: '1.0.0'
};

async function up() {
    try {
        // 添加 quests_accepted 字段（MySQL 5.6 TEXT 列不支持 DEFAULT，应用层处理默认值）
        await sequelize.query(`
            ALTER TABLE player_sects 
            ADD COLUMN quests_accepted TEXT COMMENT '当日已接取任务ID（JSON数组）'
            AFTER daily_quests_completed
        `);
        console.log('[Migration 0082] ✓ quests_accepted 字段添加成功');
    } catch (err) {
        if (err.original?.code === 'ER_DUP_FIELDNAME' || err.parent?.code === 'ER_DUP_FIELDNAME') {
            console.log('[Migration 0082] quests_accepted 字段已存在，跳过');
        } else {
            throw err;
        }
    }

    try {
        // 添加 quests_accepted_at 字段
        await sequelize.query(`
            ALTER TABLE player_sects 
            ADD COLUMN quests_accepted_at TEXT COMMENT '接取任务时间戳（JSON对象，key=questId, value=ISO时间字符串）'
            AFTER quests_accepted
        `);
        console.log('[Migration 0082] ✓ quests_accepted_at 字段添加成功');
    } catch (err) {
        if (err.original?.code === 'ER_DUP_FIELDNAME' || err.parent?.code === 'ER_DUP_FIELDNAME') {
            console.log('[Migration 0082] quests_accepted_at 字段已存在，跳过');
        } else {
            throw err;
        }
    }
}

async function down() {
    await sequelize.query(`
        ALTER TABLE player_sects 
        DROP COLUMN quests_accepted_at,
        DROP COLUMN quests_accepted
    `);
    console.log('[Migration 0082] 已回滚宗门任务接取字段');
}

module.exports = { up, down, migrationInfo };