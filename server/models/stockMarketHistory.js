/**
 * 股价K线历史模型
 *
 * 存储各周期（1h/1d/1w）的开高低收成交量，用于绘制K线图
 * 由定时任务在周期结束时聚合 stock_transactions 流水生成
 * period_start/period_end 标识该K线的时间区间
 * 查询时按 stock_id + period + period_start 索引高效检索
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StockMarketHistory = sequelize.define('StockMarketHistory', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    stock_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '股票ID'
    },
    period: {
        type: DataTypes.STRING(10),
        defaultValue: '1h',
        comment: '周期：1h/1d/1w'
    },
    open_price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '开盘价'
    },
    close_price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '收盘价'
    },
    high_price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '最高价'
    },
    low_price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '最低价'
    },
    volume: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '成交量'
    },
    period_start: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '周期开始时间'
    },
    period_end: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '周期结束时间'
    }
}, {
    tableName: 'stock_market_history',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['stock_id', 'period', 'period_start'] },
        { fields: ['period_start'] }
    ]
});

module.exports = StockMarketHistory;
