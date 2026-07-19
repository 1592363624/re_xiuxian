/**
 * 玩家副本通关记录模型
 *
 * 表名: player_dungeon_records
 * 用途: 记录玩家在副本中通关的章节、难度、星级、奖励等信息
 *       支持扫荡（三星通关后可扫荡）、统计、星级展示
 *
 * 关键字段说明：
 *   - stars：本章节获得的星级（1-3星），重复挑战时取最高星级
 *   - items_gained：JSON 字符串，记录获得的物品列表
 *   - ai_narrative：AI 生成的剧情文本（如有），用于回顾
 *
 * 唯一约束：(player_id, chapter_id, difficulty) - 同一玩家同一章节同一难度仅保留一条最高记录
 */

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DungeonRecord = sequelize.define('DungeonRecord', {
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
        comment: '章节ID（如 ch1）'
    },
    chapter_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '章节名称（冗余便于查询）'
    },
    difficulty: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'normal',
        comment: '难度（normal/hard/nightmare）'
    },
    stars: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '本章节获得的星级（1-3星）'
    },
    completion_time_sec: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '通关用时（秒）'
    },
    exp_gained: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '获得修为'
    },
    spirit_stones_gained: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '获得灵石'
    },
    items_gained: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            // 自动反序列化 JSON 字段
            const raw = this.getDataValue('items_gained');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch (e) { return []; }
        },
        set(value) {
            this.setDataValue('items_gained', Array.isArray(value) ? JSON.stringify(value) : value);
        },
        comment: '获得物品JSON数组'
    },
    ai_narrative: {
        type: DataTypes.TEXT('long'),
        allowNull: true,
        comment: 'AI生成的剧情文本（如有）'
    },
    completed_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '通关时间'
    }
}, {
    tableName: 'player_dungeon_records',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
        { name: 'idx_records_player', fields: ['player_id'] },
        { name: 'idx_records_chapter', fields: ['player_id', 'chapter_id', 'difficulty'] }
    ]
});

module.exports = DungeonRecord;
