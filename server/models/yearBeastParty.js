/**
 * 年兽讨伐队伍（活动副本）
 * status: forming / fighting / victory / defeat
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const YearBeastParty = sequelize.define('YearBeastParty', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    leader_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '队长玩家ID'
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'forming',
        comment: 'forming组队中 / fighting讨伐中 / victory胜利 / defeat失败'
    },
    shield: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 20,
        comment: '岁除之盾剩余层数'
    },
    max_shield: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 20
    },
    turns: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    damage_dealt: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    battle_log: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '讨伐战报'
    },
    started_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    finished_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'year_beast_parties',
    timestamps: true,
    indexes: [
        { fields: ['status'] },
        { fields: ['leader_id'] }
    ]
});

module.exports = YearBeastParty;
