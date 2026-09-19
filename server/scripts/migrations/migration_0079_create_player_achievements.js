/**
 * 迁移：创建 player_achievements 表
 *
 * 用途：保存玩家成就的达成进度与奖励领取状态，支撑成就系统。
 * 静态成就定义来自 achievement_data.json，本表只存动态进度。
 */
const { sequelize } = require('../config/database');
const PlayerAchievement = require('../models/playerAchievement');

// 迁移元信息（由 migration_manager 读取，用于展示与校验）
const migrationInfo = {
    description: '创建 player_achievements 表，存储玩家成就达成进度与奖励领取状态',
    version: '1.0.0'
};

async function up() {
    // sync 仅创建不存在的表，不会改动已有表结构（与项目迁移约定一致）
    await PlayerAchievement.sync();
    console.log('[Migration 0079] player_achievements 表已就绪');
}

async function down() {
    await sequelize.query('DROP TABLE IF EXISTS player_achievements');
    console.log('[Migration 0079] 已回滚 player_achievements 表');
}

module.exports = { up, down, migrationInfo };
