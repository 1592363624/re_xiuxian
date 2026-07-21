/**
 * 侍妾互动日志模型
 *
 * 记录玩家与侍妾的所有互动历史，用于审计和数据分析：
 *   - ask_after: 每日问安
 *   - backfeed: 灵力反哺
 *   - gift: 赠予物品
 *   - awaken: 觉醒婉影
 *   - heart_tribulation: 心劫事件
 *
 * 表设计：按 (player_id, created_at) 建复合索引，便于按玩家查询时间线
 * JSON 字段 action_detail 在 Model 中配置 getter/setter 自动处理
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ConcubineLog = sequelize.define('ConcubineLog', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    concubine_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '侍妾ID'
    },
    action_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '互动类型：ask_after/backfeed/gift/awaken/heart_tribulation'
    },
    action_detail: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '互动详情JSON',
        get() {
            const rawValue = this.getDataValue('action_detail');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('action_detail', value ? JSON.stringify(value) : null);
        }
    },
    charm_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '魅力变化'
    },
    intimacy_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '亲密度变化'
    },
    loyalty_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '忠诚度变化'
    },
    exp_change: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '修为变化'
    }
}, {
    tableName: 'concubine_log',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false, // 日志表只记录创建时间，不更新
    indexes: [
        { fields: ['player_id', 'created_at'], name: 'idx_cl_player_time' },
        { fields: ['concubine_id'], name: 'idx_cl_concubine' },
        { fields: ['action_type'], name: 'idx_cl_action' }
    ]
});

module.exports = ConcubineLog;
