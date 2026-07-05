/**
 * 股票定义模型
 *
 * 存储股票基本信息：代码、名称、当前价、涨跌幅、波动率、熔断状态等
 * 静态股票定义存于 server/config/stock_data.json，启动时同步至本表
 * 价格波动由定时任务按 base_volatility 与事件影响计算
 * 熔断机制：涨跌幅超过 circuit_breaker_threshold 时暂停交易（is_trading_halted=1）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Stock = sequelize.define('Stock', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '股票ID'
    },
    code: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: true,
        comment: '股票代码（如ZM01）'
    },
    name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '股票名称'
    },
    category: {
        type: DataTypes.STRING(20),
        defaultValue: 'sect',
        comment: '类型：sect宗门/mine灵矿/dungeon副本/event事件'
    },
    current_price: {
        type: DataTypes.BIGINT,
        defaultValue: 100,
        comment: '当前价'
    },
    open_price: {
        type: DataTypes.BIGINT,
        defaultValue: 100,
        comment: '今日开盘价'
    },
    yesterday_close_price: {
        type: DataTypes.BIGINT,
        defaultValue: 100,
        comment: '昨日收盘价'
    },
    daily_change_pct: {
        type: DataTypes.DECIMAL(5, 4),
        defaultValue: 0,
        comment: '今日涨跌幅（0.0000-0.1500）'
    },
    daily_volume: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '今日成交量'
    },
    total_shares: {
        type: DataTypes.BIGINT,
        defaultValue: 1000000,
        comment: '总股本'
    },
    float_shares: {
        type: DataTypes.BIGINT,
        defaultValue: 1000000,
        comment: '流通股本'
    },
    base_volatility: {
        type: DataTypes.DECIMAL(5, 4),
        defaultValue: 0.0300,
        comment: '基础波动率'
    },
    is_trading_halted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否熔断暂停交易'
    },
    halt_until: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '暂停交易截止时间'
    },
    description: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: '股票描述'
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: '是否启用'
    },
    last_price_update: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后价格更新时间'
    }
}, {
    tableName: 'stocks',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['code'], unique: true },
        { fields: ['category', 'is_active'] }
    ]
});

module.exports = Stock;
