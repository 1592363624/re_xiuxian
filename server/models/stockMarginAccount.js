/**
 * 融资账户模型
 *
 * 存储玩家融资账户的总资产、负债、保证金率、爆仓状态
 * 总资产 = 持仓市值 + 账户现金余额
 * 保证金率 = (总资产 - 负债) / 总资产
 * 当保证金率低于 force_liquidation_threshold 时触发强平（is_liquidated=1）
 * player_id 唯一索引，保证一人一融资账户
 * 由定时任务按 force_liquidation_check_interval_ms 检查强平
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StockMarginAccount = sequelize.define('StockMarginAccount', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '账户ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        comment: '玩家ID'
    },
    total_assets: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '总资产（持仓市值+现金）'
    },
    debt: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '融资负债'
    },
    margin_ratio: {
        type: DataTypes.DECIMAL(5, 4),
        defaultValue: 0,
        comment: '维持保证金率'
    },
    is_liquidated: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否已爆仓'
    },
    last_liquidation_check: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后强平检查时间'
    }
}, {
    tableName: 'stock_margin_accounts',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id'], unique: true }
    ]
});

module.exports = StockMarginAccount;
