/**
 * 股价事件模型
 *
 * 存储影响股价的事件：副本通关、宗门战胜等，含影响百分比与持续时间
 * stock_id 为 NULL 时表示全市场事件（影响所有股票）
 * impact_pct 正数上涨、负数下跌，duration_hours 控制影响持续时间
 * is_active 标记事件是否生效中，expire_at 到期后由调度器置为 0
 * 事件触发示例：
 *   - sect_dungeon_success：宗门副本通关，对应宗门股上涨
 *   - war_victory：宗门战胜，对应宗门股上涨
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StockEvent = sequelize.define('StockEvent', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '事件ID'
    },
    stock_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联股票ID（NULL表示全市场事件）'
    },
    event_type: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '事件类型：sect_dungeon_success/war_victory等'
    },
    impact_pct: {
        type: DataTypes.DECIMAL(5, 4),
        allowNull: false,
        comment: '影响百分比（正数上涨，负数下跌）'
    },
    duration_hours: {
        type: DataTypes.INTEGER,
        defaultValue: 24,
        comment: '影响持续时间'
    },
    triggered_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '触发时间'
    },
    expire_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '影响结束时间'
    },
    description: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: '事件描述'
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: '是否生效中'
    }
}, {
    tableName: 'stock_events',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['stock_id', 'is_active', 'expire_at'] },
        { fields: ['is_active', 'expire_at'] }
    ]
});

module.exports = StockEvent;
