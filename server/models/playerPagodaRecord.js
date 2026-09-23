/**
 * 琉璃古塔闯关记录模型
 * 表 player_pagoda_records：每次闯层落一条，供历史与榜单
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerPagodaRecord = sequelize.define('PlayerPagodaRecord', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false },
    player_nickname: { type: DataTypes.STRING(50), allowNull: false },
    floor: { type: DataTypes.INTEGER, allowNull: false },
    floor_name: { type: DataTypes.STRING(50), allowNull: true },
    result: { type: DataTypes.STRING(20), allowNull: false },
    score: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    rounds_used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    player_hp_remaining: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    is_first_clear: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    exp_gained: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    spirit_stones_gained: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    battle_log: { type: DataTypes.TEXT, allowNull: true }
}, {
    tableName: 'player_pagoda_records',
    timestamps: true,
    underscored: true,
    updatedAt: false,
    createdAt: 'created_at',
    indexes: [
        { fields: ['player_id'], name: 'idx_ppr_player' },
        { fields: ['score'], name: 'idx_ppr_score' },
        { fields: ['floor', 'created_at'], name: 'idx_ppr_floor' }
    ]
});

module.exports = PlayerPagodaRecord;
