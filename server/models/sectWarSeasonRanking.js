/**
 * 宗门战赛季宗门排行模型
 *
 * 每赛季每宗门一条记录，聚合本赛季所有战役的胜负/积分
 * 赛季结算时按 total_score 排名发放宗门奖励
 *
 * 关键字段：
 *   - total_score：赛季总积分（胜负 + 资源点占领）
 *   - final_rank：结算时的最终排名
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SectWarSeasonRanking = sequelize.define('SectWarSeasonRanking', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '赛季ID'
    },
    sect_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '宗门ID'
    },
    sect_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '宗门名'
    },
    total_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '赛季总积分'
    },
    war_wins: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '胜场'
    },
    war_losses: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '败场'
    },
    war_draws: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '平场'
    },
    territories_held: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前占领资源点数'
    },
    total_kills: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总击杀'
    },
    total_participants: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总参战人次'
    },
    final_rank: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '最终排名'
    }
}, {
    tableName: 'sect_war_season_rankings',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['season_id', 'sect_id'], unique: true },
        { fields: ['season_id', 'total_score'] }
    ]
});

module.exports = SectWarSeasonRanking;
