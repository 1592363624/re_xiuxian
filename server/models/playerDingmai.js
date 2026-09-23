/**
 * 落云宗定脉个人状态模型
 * 表 player_dingmai：一人一行
 * 玩法文档对照：xiuxian_game_guide.md 第25节·云梦灵眼定脉
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerDingmai = sequelize.define('PlayerDingmai', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false, unique: true },
    today_vein: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'calm' },
    today_orders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    today_charges: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    count_date: { type: DataTypes.STRING(10), allowNull: true },
    total_merit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_purify: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_action: { type: DataTypes.STRING(20), allowNull: true },
    last_action_at: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: 'player_dingmai',
    timestamps: true,
    underscored: true,
    updatedAt: 'updated_at',
    createdAt: 'created_at',
    indexes: [
        { fields: ['player_id'], name: 'idx_pd_player', unique: true },
        { fields: ['total_merit'], name: 'idx_pd_merit' },
        { fields: ['total_purify'], name: 'idx_pd_purify' }
    ]
});

module.exports = PlayerDingmai;
