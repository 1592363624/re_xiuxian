/**
 * 年兽讨伐队员
 * settled: 是否已领过本场奖励
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const YearBeastMember = sequelize.define('YearBeastMember', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    party_id: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    role: {
        type: DataTypes.STRING(20),
        defaultValue: 'member',
        comment: 'leader / member'
    },
    firecrackers_used: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    focus_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    damage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    settled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    }
}, {
    tableName: 'year_beast_members',
    timestamps: true,
    indexes: [
        { fields: ['party_id'] },
        { fields: ['player_id'] },
        { unique: true, fields: ['party_id', 'player_id'] }
    ]
});

module.exports = YearBeastMember;
