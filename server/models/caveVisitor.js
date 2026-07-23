/**
 * 洞府访客记录模型
 *
 * 存储玩家拜访他人洞府的访问记录
 * 表名：cave_visitors
 *
 * encounter_type/encounter_reward 字段记录拜访时触发的奇遇结果：
 *   - null 表示该次拜访未触发奇遇
 *   - 非空值记录奇遇类型ID和奖励 JSON，用于每日奇遇次数统计和前端展示
 *
 * reception_status 字段记录洞府主人对接待访客的处理状态：
 *   - pending：待处理（默认，访客刚拜访尚未被主人处理）
 *   - received：已接待（主人接待访客，访客获得临时增益buff）
 *   - expelled：已驱逐（主人驱逐访客，访客被封锁拜访+寻宝24h）
 *   - ignored：已忽略（主人主动忽略，不影响访客行为）
 *
 * reception_buff_until 字段记录接待buff到期时间（仅 received 状态有值）
 * 接待期间访客若寻宝该洞府，被发现率额外 +50%（背叛信任惩罚）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveVisitor = sequelize.define('CaveVisitor', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    cave_owner_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '洞府主人玩家ID'
    },
    visitor_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '访客玩家ID'
    },
    visited_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '拜访时间'
    },
    encounter_type: {
        type: DataTypes.STRING(50),
        allowNull: true,
        defaultValue: null,
        comment: '奇遇类型ID（null=未触发奇遇）'
    },
    encounter_reward: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
        comment: '奇遇奖励 JSON（如 {"item_id":"low_healing_pill","item_count":1}）',
        get() {
            const raw = this.getDataValue('encounter_reward');
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        },
        set(val) {
            this.setDataValue('encounter_reward', val ? JSON.stringify(val) : null);
        }
    },
    // ===== 接待/驱逐访客系统新增字段 =====
    reception_status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: '接待状态：pending待处理/received已接待/expelled已驱逐/ignored已忽略',
        validate: {
            isIn: [['pending', 'received', 'expelled', 'ignored']]
        }
    },
    reception_at: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
        comment: '主人处理时间（接待/驱逐/忽略的操作时间）'
    },
    reception_buff_until: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
        comment: '接待buff到期时间（仅received状态有值，到期后buff失效）'
    }
}, {
    tableName: 'cave_visitors',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
});

module.exports = CaveVisitor;
