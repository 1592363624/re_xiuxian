/**
 * 玩家股票持仓模型
 *
 * 存储玩家持有的股票数量、可用数量（T+1 冻结）、平均成本等
 * available_quantity 扣除当日买入冻结（T+1 结算制，买入当日不可卖）
 * market_value 为缓存字段，由定时任务按最新价刷新
 * player_id + stock_id 唯一索引，保证一人一股一条
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StockHolding = sequelize.define('StockHolding', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '持仓ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    stock_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '股票ID'
    },
    quantity: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '持有数量'
    },
    available_quantity: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '可用数量（扣除T+1冻结）'
    },
    average_cost: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '平均成本'
    },
    total_cost: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '总成本'
    },
    market_value: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '最新市值（缓存）'
    }
}, {
    tableName: 'stock_holdings',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'stock_id'], unique: true },
        { fields: ['player_id'] }
    ]
});

module.exports = StockHolding;
