/**
 * 玩家状态转移日志模型
 *
 * 记录玩家每次状态变更（进入/退出/转移/自动清理/异常），
 * 用于运维追溯、问题排查和数据分析。
 *
 * 触发场景：
 *   - 玩家主动开始/结束某状态（enter/exit）
 *   - 状态机互斥校验拦截非法转移（transition）
 *   - StateCleanerService 自动清理过期状态（auto_clean）
 *   - 状态变更过程中发生异常（error）
 *
 * 设计要点：
 *   - 字段 player_nickname 冗余存储，避免查询时 JOIN Player 表
 *   - 字段 from_state/to_state 记录状态枚举（如 IDLE/SECLUDED/IN_BATTLE）
 *   - 字段 source 标识触发来源（route/cleaner/gm/system）
 *   - 字段 details 存储额外上下文（JSON 字符串，如闭关时长/战斗结果）
 *   - 索引 player_id + created_at 支持按玩家查询时间线
 *   - 索引 action + state_type 支持按动作类型筛选
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerStateLog = sequelize.define('PlayerStateLog', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '日志ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '玩家昵称（冗余存储，避免JOIN）'
    },
    state_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '状态类型: seclusion/combat/adventure/moving/ban'
    },
    action: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '动作类型: enter/exit/transition/auto_clean/error'
    },
    from_state: {
        type: DataTypes.STRING(30),
        allowNull: true,
        comment: '变更前状态枚举（如 IDLE/SECLUDED）'
    },
    to_state: {
        type: DataTypes.STRING(30),
        allowNull: true,
        comment: '变更后状态枚举'
    },
    source: {
        type: DataTypes.STRING(30),
        allowNull: true,
        comment: '触发来源: route/cleaner/gm/system'
    },
    details: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '详情JSON（如闭关时长/战斗结果/失败原因）'
    }
}, {
    tableName: 'player_state_log',
    timestamps: true,          // 使用 createdAt/updatedAt
    updatedAt: false,          // 日志只增不改，禁用 updatedAt
    indexes: [
        { fields: ['player_id'] },
        { fields: ['action'] },
        { fields: ['state_type'] },
        { fields: ['createdAt'] },
        // 复合索引：按玩家查询时间线时使用
        { fields: ['player_id', 'createdAt'] }
    ]
});

module.exports = PlayerStateLog;
