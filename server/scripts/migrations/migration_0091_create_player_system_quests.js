/**
 * 迁移脚本 0091：创建系统任务「尘缘指归」进度表（player_system_quests）
 *
 * 用途：一条独立线性链，每人一行。静态节点在 config/system_quest_data.json。
 * 与 migration_0089 同约定：Model.sync() 仅创建不存在的表，幂等，可重复执行。
 */
const PlayerSystemQuest = require('../../models/playerSystemQuest');

const migrationInfo = {
    description: '创建系统任务进度表 player_system_quests（尘缘指归线性链）',
    version: '1.0.0'
};

async function up() {
    await PlayerSystemQuest.sync();
    console.log('[Migration 0091] player_system_quests 表已就绪');
}

async function down() {
    await PlayerSystemQuest.getQueryInterface().dropTable('player_system_quests');
    console.log('[Migration 0091] 已回滚：删除 player_system_quests 表');
}

module.exports = { up, down, migrationInfo };
