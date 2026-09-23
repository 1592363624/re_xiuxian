/**
 * 进行中事件奇遇模型
 * 表 player_fated_events：一人最多一条未决事件
 * 玩法文档对照：xiuxian_game_guide.md 第22节·隐藏/事件式命令
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerFatedEvent = sequelize.define('PlayerFatedEvent', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false },
    event_id: { type: DataTypes.STRING(50), allowNull: false },
    event_name: { type: DataTypes.STRING(50), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    choice_id: { type: DataTypes.STRING(50), allowNull: true },
    result: { type: DataTypes.STRING(20), allowNull: true },
    payload: { type: DataTypes.TEXT, allowNull: true },
    rewards_summary: { type: DataTypes.TEXT, allowNull: true },
    today_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    count_date: { type: DataTypes.STRING(10), allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: 'player_fated_events',
    timestamps: true,
    underscored: true,
    updatedAt: 'updated_at',
    createdAt: 'created_at',
    indexes: [
        { fields: ['player_id'], name: 'idx_pfe_player' },
        { fields: ['player_id', 'status'], name: 'idx_pfe_player_status' },
        { fields: ['expires_at'], name: 'idx_pfe_expires' }
    ]
});

module.exports = PlayerFatedEvent;
