/**
 * 玩家物品模型
 * 用于存储玩家拥有的物品
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Item = sequelize.define('Item', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属玩家ID'
    },
    item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品配置键名'
    },
    quantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '物品数量'
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '获得时间'
    }
}, {
    tableName: 'player_items',
    timestamps: true,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['item_key'] }
    ]
});

module.exports = Item;
