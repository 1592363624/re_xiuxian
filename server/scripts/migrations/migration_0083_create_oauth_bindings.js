/**
 * 迁移脚本 0083：创建 player_oauth_bindings 表
 *
 * 用途：承载 QQ 互联等第三方登录身份与游戏账号的绑定关系。
 * 绑定关系与 players 表分表存放，避免为第三方登录在玩家主表上扩列，
 * 后续接入微信/微博等平台只需新增 provider 取值，无需再改表结构。
 */
const sequelize = require('../config/database');
const PlayerOAuthBinding = require('../models/playerOAuthBinding');

const migrationInfo = {
    description: '创建 player_oauth_bindings 表，存储第三方登录身份与玩家账号的绑定关系',
    version: '1.0.0'
};

async function up() {
    // sync 仅创建不存在的表，不会改动已有表结构（与项目迁移约定一致）
    await PlayerOAuthBinding.sync();
    console.log('[Migration 0083] player_oauth_bindings 表已就绪');
}

async function down() {
    await sequelize.query('DROP TABLE IF EXISTS player_oauth_bindings');
    console.log('[Migration 0083] 已回滚 player_oauth_bindings 表');
}

module.exports = { up, down, migrationInfo };
