/**
 * 迁移脚本 0085：player_achievements 补齐成就进度列
 *
 * 背景：migration_0079 用 Model.sync() 建表，只会按"当时的模型"建列，之后不再改结构。
 * 模型后来演进成 progress / completed / claimed / claimed_at，表里却还是旧的 status，
 * 于是 AchievementService 的每一次读写都撞 Unknown column 'progress'，
 * 表现是 /api/achievement/list 稳定 500（成就面板打不开）。
 *
 * 只加列、不删列：旧 status 留给回滚与人工核对，代码里已经没有人读它。
 */
const sequelize = require('../../config/database');

const migrationInfo = {
    description: 'player_achievements 补齐 progress/completed/claimed/claimed_at 列，修复成就面板 500',
    version: '1.0.0'
};

const COLUMNS = [
    ['progress', '`progress` BIGINT NOT NULL DEFAULT 0 COMMENT \'当前完成进度\''],
    ['completed', '`completed` TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'是否已达成条件\''],
    ['claimed', '`claimed` TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'奖励是否已领取\''],
    ['claimed_at', '`claimed_at` DATETIME NULL COMMENT \'领取奖励时间\'']
];

async function up() {
    for (const [name, definition] of COLUMNS) {
        const [columns] = await sequelize.query(`SHOW COLUMNS FROM player_achievements LIKE '${name}'`);
        if (columns.length > 0) {
            console.log(`[Migration 0085] player_achievements.${name} 已存在，跳过`);
            continue;
        }
        await sequelize.query(`ALTER TABLE player_achievements ADD COLUMN ${definition}`);
        console.log(`[Migration 0085] player_achievements.${name} 已添加`);
    }
}

async function down() {
    for (const [name] of [...COLUMNS].reverse()) {
        await sequelize.query(`ALTER TABLE player_achievements DROP COLUMN \`${name}\``);
    }
    console.log('[Migration 0085] 已回滚 player_achievements 成就进度列');
}

module.exports = { up, down, migrationInfo };
