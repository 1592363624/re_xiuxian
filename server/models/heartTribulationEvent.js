/**
 * 心劫事件模型
 *
 * 心劫是道侣/侍妾系统的剧情触发器，增加游戏深度：
 *   - heart_tribulation: 心劫（道侣间触发，选项稳/狠/骗）
 *   - heart_imprint: 心印（道侣间种印，提供加成）
 *   - heart_contract: 心契（道侣间契约，等级提升）
 *
 * 表设计：expires_at 用于事件过期检测，超时未抉择视为失败
 * JSON 字段 options/reward/penalty 在 Model 中配置 getter/setter 自动处理
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const HeartTribulationEvent = sequelize.define('HeartTribulationEvent', {
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
    companion_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联道侣关系ID'
    },
    concubine_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联侍妾ID'
    },
    event_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '事件类型：heart_tribulation/heart_imprint/heart_contract'
    },
    event_state: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: '事件状态：pending/resolved/failed'
    },
    options: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '可选选项JSON（如稳/狠/骗）',
        get() {
            const rawValue = this.getDataValue('options');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('options', JSON.stringify(value));
        }
    },
    chosen_option: {
        type: DataTypes.STRING(30),
        allowNull: true,
        comment: '玩家选择的选项'
    },
    reward: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '结算奖励JSON',
        get() {
            const rawValue = this.getDataValue('reward');
            return rawValue ? JSON.parse(rawValue) : null;
        },
        set(value) {
            this.setDataValue('reward', value ? JSON.stringify(value) : null);
        }
    },
    penalty: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '惩罚JSON',
        get() {
            const rawValue = this.getDataValue('penalty');
            return rawValue ? JSON.parse(rawValue) : null;
        },
        set(value) {
            this.setDataValue('penalty', value ? JSON.stringify(value) : null);
        }
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '事件过期时间'
    },
    resolved_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '解决时间'
    }
}, {
    tableName: 'heart_tribulation_event',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'event_state'], name: 'idx_hte_player_state' },
        { fields: ['expires_at'], name: 'idx_hte_expires' }
    ]
});

module.exports = HeartTribulationEvent;
