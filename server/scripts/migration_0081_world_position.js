/**
 * 迁移：玩家世界坐标字段（大世界地图 MVP）
 *
 * 用途：在 player_map_positions 表上增加玩家连续世界坐标，
 * 支撑 2D 俯视大世界地图的移动与多人位置同步。
 */
const sequelize = require('../config/database');

const migrationInfo = {
    description: '为 player_map_positions 增加世界坐标 pos_x/pos_y 与最近移动时间 latest_move_time',
    version: '1.0.0'
};

async function up() {
    await sequelize.query(`
        ALTER TABLE player_map_positions
        ADD COLUMN pos_x DOUBLE NULL COMMENT '世界坐标X（大世界地图）',
        ADD COLUMN pos_y DOUBLE NULL COMMENT '世界坐标Y（大世界地图）',
        ADD COLUMN latest_move_time DATETIME NULL COMMENT '最近一次世界移动时间（防滥用）'
    `);
    console.log('[Migration 0081] player_map_positions 已增加世界坐标字段');
}

async function down() {
    await sequelize.query(`
        ALTER TABLE player_map_positions
        DROP COLUMN latest_move_time,
        DROP COLUMN pos_y,
        DROP COLUMN pos_x
    `);
    console.log('[Migration 0081] 已回滚世界坐标字段');
}

module.exports = { up, down, migrationInfo };
