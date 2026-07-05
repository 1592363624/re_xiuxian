/**
 * PVP 段位积分模型
 *
 * 存储玩家 PVP 段位积分信息（每玩家一条）
 * 包含本赛季胜负场、连胜、每日挑战次数、最后战斗时间等
 * score 字段冗余存储于 players 表 pvp_score，便于排行榜查询
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PvpRanking = sequelize.define('PvpRanking', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        comment: '玩家ID'
    },
    score: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'PVP段位积分'
    },
    rank_tier: {
        type: DataTypes.STRING(20),
        defaultValue: '散修',
        comment: '段位名称'
    },
    season_wins: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '本赛季胜场'
    },
    season_losses: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '本赛季败场'
    },
    season_draws: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '本赛季平局'
    },
    win_streak: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '当前连胜'
    },
    max_win_streak: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '历史最高连胜'
    },
    daily_challenge_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '今日挑战次数'
    },
    daily_defend_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '今日被挑战次数'
    },
    last_challenge_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后挑战日期（用于跨日重置）'
    },
    last_battle_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后战斗时间（冷却计算）'
    },
    total_battles: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '历史总战斗数'
    }
}, {
    tableName: 'pvp_rankings',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id'], unique: true },
        { fields: ['score'] },
        { fields: ['rank_tier'] }
    ]
});

module.exports = PvpRanking;
