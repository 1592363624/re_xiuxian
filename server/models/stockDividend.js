/**
 * 股票分红记录模型
 *
 * 存储玩家获得的股票分红记录
 * 分红类型：
 *   - monthly：月度分红（mine 灵矿股）
 *   - quarterly：季度分红（sect 宗门股）
 *   - event：事件触发分红（dungeon 副本通关、event 战争胜利）
 * 分红金额 = 持股数量 × 每股分红
 * 由分红调度器按 dividend_schedules 配置周期触发
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StockDividend = sequelize.define('StockDividend', {
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
    stock_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '股票ID'
    },
    quantity: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '持股数量'
    },
    dividend_per_share: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '每股分红'
    },
    total_dividend: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '总分红金额'
    },
    dividend_type: {
        type: DataTypes.STRING(20),
        defaultValue: 'monthly',
        comment: '分红类型：monthly/quarterly/event'
    }
}, {
    tableName: 'stock_dividends',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'created_at'] },
        { fields: ['stock_id', 'created_at'] }
    ]
});

module.exports = StockDividend;
