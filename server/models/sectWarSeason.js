/**
 * 宗门战赛季模型
 *
 * 每赛季一条记录，存储赛季的起止时间与状态
 * 赛季结束结算时按 sect_war_season_rankings 排名发放宗门奖励
 *
 * 状态流转：
 *   pending - 待开始
 *   active  - 进行中
 *   ended   - 已结束（含已结算）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SectWarSeason = sequelize.define('SectWarSeason', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '赛季ID'
    },
    season_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '赛季名称'
    },
    start_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: '开始日期'
    },
    end_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: '结束日期'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: '状态：pending/active/ended'
    },
    total_wars: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总战役数'
    },
    total_participants: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总参战人数'
    },
    settlement_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '结算时间'
    }
}, {
    tableName: 'sect_war_seasons',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['status'] }
    ]
});

module.exports = SectWarSeason;
