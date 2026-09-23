/**
 * 琉璃古塔进度模型
 * 表 player_pagoda：一人一行，记录最高层、今日次数、首通标记
 * 玩法文档对照：xiuxian_game_guide.md 第30节·古塔流程
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerPagoda = sequelize.define('PlayerPagoda', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false, unique: true },
    highest_floor: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    current_floor: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    in_tower: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    today_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    today_resets: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    attempt_date: { type: DataTypes.STRING(10), allowNull: true },
    first_clear_mask: { type: DataTypes.TEXT, allowNull: true },
    last_score: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    best_score: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_clears: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    last_attempt_at: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: 'player_pagoda',
    timestamps: true,
    underscored: true,
    updatedAt: 'updated_at',
    createdAt: 'created_at',
    indexes: [
        { fields: ['player_id'], name: 'idx_pp_player', unique: true },
        { fields: ['best_score'], name: 'idx_pp_best_score' },
        { fields: ['highest_floor'], name: 'idx_pp_highest_floor' }
    ]
});

module.exports = PlayerPagoda;
