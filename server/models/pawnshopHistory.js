/**
 * 当铺交易历史模型
 *
 * 存储玩家在当铺的所有操作记录（典当/赎回/逾期/拍卖）
 * listing_id 关联当票ID，便于反查当票的完整操作链路
 * detail 字段以 JSON 字符串存储额外详情（如拍卖买家、GM操作备注等）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PawnshopHistory = sequelize.define('PawnshopHistory', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    listing_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联当票ID'
    },
    action_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '操作类型：pawn/redeem/overdue/auction'
    },
    item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品key'
    },
    item_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品名称'
    },
    quantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '数量'
    },
    amount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '涉及灵石数'
    },
    detail: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '详情JSON'
    }
}, {
    tableName: 'pawnshop_histories',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'created_at'] },
        { fields: ['listing_id'] }
    ]
});

module.exports = PawnshopHistory;
