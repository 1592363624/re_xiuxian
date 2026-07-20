/**
 * 世界BOSS赛季配置模型
 *
 * 每赛季一条记录，存储赛季的起止时间与状态
 * 赛季结束后 settlement_time 字段记录结算时间
 *
 * 状态流转：
 *   pending - 待开始
 *   active  - 进行中
 *   ended   - 已结束（含已结算）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WorldBossSeason = sequelize.define('WorldBossSeason', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '赛季ID'
    },
    season_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '赛季名称（如 "甲辰年夏季赛"）'
    },
    start_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: '赛季开始日期'
    },
    end_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        comment: '赛季结束日期'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: '状态：pending/active/ended'
    },
    total_bosses_killed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本赛季击杀BOSS总数'
    },
    total_damage_dealt: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '本赛季总伤害'
    },
    settlement_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '结算时间'
    }
}, {
    tableName: 'world_boss_seasons',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['status'] },
        { fields: ['start_date', 'end_date'] }
    ]
});

module.exports = WorldBossSeason;