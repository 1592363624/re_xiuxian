/**
 * 玲珑骰对赌匹配
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const GhostDiceMatch = sequelize.define('GhostDiceMatch', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    challenger_id: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    defender_id: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    bet_amount: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'pending',
        comment: 'pending待应战 / finished已结束 / draw平局 / cancelled撤回 / expired过期'
    },
    challenger_dice: {
        type: DataTypes.JSON,
        allowNull: true
    },
    defender_dice: {
        type: DataTypes.JSON,
        allowNull: true
    },
    winner_id: {
        type: DataTypes.BIGINT,
        allowNull: true
    },
    house_cut: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    finished_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
}, {
    tableName: 'ghost_dice_matches',
    timestamps: true,
    indexes: [
        { fields: ['status'] },
        { fields: ['challenger_id'] },
        { fields: ['defender_id'] }
    ]
});

module.exports = GhostDiceMatch;
