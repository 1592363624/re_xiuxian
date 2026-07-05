/**
 * 当铺典当记录模型（当票）
 *
 * 存储玩家典当物品的当票信息：估值、赎回价、截止时间、状态等
 * 状态流转：active（典当中）→ redeemed（已赎回）/ overdue（已逾期）/ auctioned（已拍卖）
 * redeemed_by 字段在 GM 代赎时记录操作人，便于审计
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PawnshopListing = sequelize.define('PawnshopListing', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '当票ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '典当人玩家ID'
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
    item_quality: {
        type: DataTypes.STRING(20),
        defaultValue: 'common',
        comment: '物品品质'
    },
    quantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '典当数量'
    },
    base_price: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '物品基础价值'
    },
    valuation: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '估值'
    },
    pawn_amount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '实际获得灵石（估值×折扣率）'
    },
    redeem_amount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '赎回价（含利息）'
    },
    pawn_fee: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '手续费'
    },
    pawned_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '典当时间'
    },
    redeem_deadline: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '赎回截止时间'
    },
    redeemed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '实际赎回时间'
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active',
        comment: '状态：active/redeemed/overdue/auctioned'
    },
    redeemed_by: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '赎回操作人玩家ID（GM代赎时记录）'
    }
}, {
    tableName: 'pawnshop_listings',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'status'] },
        { fields: ['status', 'redeem_deadline'] },
        { fields: ['pawned_at'] }
    ]
});

module.exports = PawnshopListing;
