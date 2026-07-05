/**
 * 股票交易流水模型
 *
 * 存储玩家买卖记录：成交价、金额、手续费、印花税、融资标记等
 * 状态流转：pending（待成交）→ completed（已成交）/ cancelled（已撤销）
 * is_margin 标记融资交易，关联 stock_margin_accounts 表
 * 卖出时收取印花税（stamp_tax_sell），买卖均收取手续费（trading_fee）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StockTransaction = sequelize.define('StockTransaction', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '交易ID'
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
    trade_type: {
        type: DataTypes.STRING(10),
        allowNull: false,
        comment: '交易类型：buy/sell'
    },
    quantity: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '交易数量'
    },
    price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '成交价'
    },
    amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '成交金额'
    },
    fee: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '手续费'
    },
    tax: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '印花税'
    },
    is_margin: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否融资交易'
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'completed',
        comment: '状态：pending/completed/cancelled'
    }
}, {
    tableName: 'stock_transactions',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'created_at'] },
        { fields: ['stock_id', 'created_at'] }
    ]
});

module.exports = StockTransaction;
