/**
 * 迁移脚本 0089：创建玩家个人 AI 配置表（user_ai_configs）
 *
 * 用途：玩家在游戏设置里可填写自己的 AI 接口（Base URL / 模型 / API Key），
 * 启用后其触发的大模型调用优先走自己的接口与额度，减少服务器公共额度消耗。
 * 与 migration_0083（oauth_bindings）/0086（notification_reads）同约定：
 * Model.sync() 仅创建不存在的表，幂等，可重复执行。
 */
const UserAiConfig = require('../../models/user_ai_config');

const migrationInfo = {
    description: '创建玩家个人 AI 配置表 user_ai_configs（一人一条，Key 加密存储）',
    version: '1.0.0'
};

async function up() {
    // sync 仅创建不存在的表，不会改动已有表结构（与项目迁移约定一致）
    await UserAiConfig.sync();
    console.log('[Migration 0089] user_ai_configs 表已就绪');
}

async function down() {
    await UserAiConfig.getQueryInterface().dropTable('user_ai_configs');
    console.log('[Migration 0089] 已回滚：删除 user_ai_configs 表');
}

module.exports = { up, down, migrationInfo };
