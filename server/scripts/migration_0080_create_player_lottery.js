/**
 * 迁移：创建 player_lottery 表
 *
 * 用途：保存玩家抽奖累计次数与保底计数，支撑抽奖（寻仙机缘）系统。
 */
const { sequelize } = require('../config/database');
const PlayerLottery = require('../models/playerLottery');

const migrationInfo = {
    description: '创建 player_lottery 表，存储抽奖累计次数、保底计数与出货统计',
    version: '1.0.0'
};

async function up() {
    await PlayerLottery.sync();
    console.log('[Migration 0080] player_lottery 表已就绪');
}

async function down() {
    await sequelize.query('DROP TABLE IF EXISTS player_lottery');
    console.log('[Migration 0080] 已回滚 player_lottery 表');
}

module.exports = { up, down, migrationInfo };
