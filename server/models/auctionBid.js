/**
 * 拍卖竞价历史模型
 *
 * 存储每次竞价记录，用于拍卖详情页展示竞价历史，以及"我的竞价"查询。
 *
 * 业务说明：
 *   - 每次竞价都写入一条记录（包括被超越的旧出价）
 *   - 竞价时冻结的灵石只在"当前最高出价"上，被超越时自动退还给前一个竞价者
 *   - auction_bids 仅作历史记录，不参与灵石冻结/退还逻辑（灵石操作在 players 表完成）
 *
 * 关联表：
 *   - auctions（auction_id → auctions.id）
 *   - players（bidder_id → players.id）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AuctionBid = sequelize.define('AuctionBid', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    auction_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '拍卖ID'
    },
    bidder_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '竞价者玩家ID'
    },
    bid_price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '出价（灵石）'
    }
}, {
    tableName: 'auction_bids',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false, // 竞价记录不修改，无需 updatedAt
    indexes: [
        { fields: ['auction_id', 'created_at'] },
        { fields: ['bidder_id', 'created_at'] }
    ]
});

module.exports = AuctionBid;
