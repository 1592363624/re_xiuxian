/**
 * 玩家副本进行中进度模型
 *
 * 表名: player_dungeon_progress
 * 用途: 记录玩家正在挑战的副本进度，支持断线重连和状态机恢复
 *
 * 关键字段说明：
 *   - current_node_id/current_node_type：当前所在关卡节点
 *   - nodes_completed：JSON 数组，已完成的节点ID列表（避免重复奖励）
 *   - hp_remaining/mp_remaining：HP/MP 在关卡间持续，不复位
 *   - items_collected：本次副本累计获得的物品
 *   - ai_context：AI 生成的剧情上下文（用于跨节点连贯叙事）
 *   - expires_at：超时时间，StateCleanerService 会自动结算过期副本
 *
 * 唯一约束：player_id - 每个玩家同时只能有一个进行中的副本
 */

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DungeonProgress = sequelize.define('DungeonProgress', {
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
    chapter_id: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '章节ID'
    },
    difficulty: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'normal',
        comment: '难度（normal/hard/nightmare）'
    },
    current_node_id: {
        type: DataTypes.STRING(40),
        allowNull: false,
        comment: '当前关卡节点ID'
    },
    current_node_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '当前关卡类型（story/battle/puzzle/boss/reward）'
    },
    nodes_completed: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        get() {
            const raw = this.getDataValue('nodes_completed');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch (e) { return []; }
        },
        set(value) {
            this.setDataValue('nodes_completed', Array.isArray(value) ? JSON.stringify(value) : value);
        },
        comment: '已完成节点ID JSON数组'
    },
    hp_remaining: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '剩余HP（关卡间持续）'
    },
    mp_remaining: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '剩余MP'
    },
    items_collected: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        get() {
            const raw = this.getDataValue('items_collected');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch (e) { return []; }
        },
        set(value) {
            this.setDataValue('items_collected', Array.isArray(value) ? JSON.stringify(value) : value);
        },
        comment: '本次副本已获得物品JSON数组'
    },
    exp_accumulated: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '本次副本已积累修为'
    },
    spirit_stones_accumulated: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '本次副本已积累灵石'
    },
    ai_context: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: 'AI生成的剧情上下文（用于跨节点连贯）'
    },
    start_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '副本开始时间'
    },
    last_active_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '最后活跃时间'
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '过期时间（超时自动结算）'
    }
}, {
    tableName: 'player_dungeon_progress',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
        { name: 'idx_progress_expires', fields: ['expires_at'] }
    ]
});

module.exports = DungeonProgress;
