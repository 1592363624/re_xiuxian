/**
 * 迁移：玩家世界坐标字段（大世界地图 MVP）
 *
 * 用途：在 player_map_positions 表上增加玩家连续世界坐标，
 * 支撑 2D 俯视大世界地图的移动与多人位置同步。
 */
const sequelize = require('../../config/database');

const migrationInfo = {
    description: '为 player_map_positions 增加世界坐标 pos_x/pos_y 与最近移动时间 latest_move_time',
    version: '1.0.0'
};

async function up() {
    const columns = [
        { name: 'pos_x', ddl: "ADD COLUMN pos_x DOUBLE NULL COMMENT '世界坐标X（大世界地图）'" },
        { name: 'pos_y', ddl: "ADD COLUMN pos_y DOUBLE NULL COMMENT '世界坐标Y（大世界地图）'" },
        { name: 'latest_move_time', ddl: "ADD COLUMN latest_move_time DATETIME NULL COMMENT '最近一次世界移动时间（防滥用）'" }
    ];

    // 只补缺失列：服务器启动时 sync() 先按模型建表，全新库上这些列已经存在，
    // 无条件 ALTER 会撞 ER_DUP_FIELDNAME 并中断整个迁移流程
    const [existing] = await sequelize.query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_map_positions'
    `);
    const present = new Set(existing.map(r => r.COLUMN_NAME || r.column_name));
    const missing = columns.filter(c => !present.has(c.name));

    if (missing.length === 0) {
        console.log('[Migration 0081] 世界坐标字段已存在，跳过');
        return;
    }

    await sequelize.query(`ALTER TABLE player_map_positions ${missing.map(c => c.ddl).join(', ')}`);
    console.log(`[Migration 0081] player_map_positions 已增加字段: ${missing.map(c => c.name).join(', ')}`);
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
