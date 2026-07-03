/**
 * 坊市（万宝楼）挂单模型
 *
 * 设计说明：
 *   - market_listings 表存储玩家在坊市上架的物品挂单（万宝楼为换物系统，非灵石交易）
 *   - seller_id 关联 players 表，记录卖家信息
 *   - item_key / want_item_key 关联 item_data.json 静态配置，物品名称冗余存储便于列表展示
 *   - status 字段标识挂单生命周期：active（上架中）/ sold（已售出）/ cancelled（已下架）
 *   - buyer_id / sold_at 仅在成交时写入，用于交易追溯
 *
 * 索引说明：
 *   - seller_id：按卖家查询货摊（高频查询）
 *   - status：按状态筛选上架中挂单（列表展示高频查询）
 *   - item_key：按物品键名查询（用于校验同物品已有挂单数等）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MarketListing = sequelize.define('MarketListing', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    seller_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '卖家玩家ID'
    },
    item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '出售物品配置键名'
    },
    item_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '出售物品名称（冗余存储便于列表展示）'
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '出售数量'
    },
    want_item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '换取的物品键名（万宝楼为换物系统）'
    },
    want_item_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '换取物品名称（冗余存储便于列表展示）'
    },
    want_quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '换取数量'
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active',
        comment: '挂单状态：active上架中 / sold已售出 / cancelled已下架'
    },
    buyer_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '买家玩家ID（成交时写入）'
    },
    sold_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '成交时间'
    }
}, {
    tableName: 'market_listings',
    timestamps: true,
    indexes: [
        { fields: ['seller_id'] },
        { fields: ['status'] },
        { fields: ['item_key'] }
    ]
});

module.exports = MarketListing;
