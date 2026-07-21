/**
 * 玩家太一门道途模型
 *
 * 太一门引道系统（玩法文档第25节）：
 *   - 玩家选择五行道途（金/木/水/火/土）后获得被动加成
 *   - 通过日常修炼/使用技能/共鸣组队获得道途经验，提升等级
 *   - 等级达到5级后可使用道途专属技能
 *   - 与玩家表 1:1 关系（UNIQUE KEY player_id）
 *
 * 字段说明：
 *   - dao_path：当前道途（metal/wood/water/fire/earth，null=未选择）
 *   - dao_level：道途等级（1-10），每级提供被动加成
 *   - dao_exp：道途经验（累计，按 level_table 升级）
 *   - skill_cooldowns：技能冷却（JSON，{skill_id: 'YYYY-MM-DD HH:mm:ss'}）
 *   - last_switch_time：上次道途切换时间（用于切换冷却，7天）
 *   - daily_tasks：今日任务（JSON数组，{task_type, target_count, current_count, completed, rewards_claimed}）
 *   - daily_task_reset_time：任务重置时间（跨日重置）
 *   - total_*：累计统计，用于审计与排行
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerTaoismGate = sequelize.define('PlayerTaoismGate', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_ptg_player',
        comment: '玩家ID'
    },
    dao_path: {
        type: DataTypes.STRING(10),
        allowNull: true,
        defaultValue: null,
        comment: '当前道途（metal/wood/water/fire/earth，null=未选择）'
    },
    dao_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '道途等级（1-10）'
    },
    dao_exp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '道途经验（累计，用于升级）'
    },
    skill_cooldowns: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {},
        comment: '技能冷却（JSON，{skill_id: cooldown_end_time}）',
        get() {
            const val = this.getDataValue('skill_cooldowns');
            return val || {};
        }
    },
    last_switch_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次道途切换时间'
    },
    daily_tasks: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
        comment: '今日任务列表（JSON数组）',
        get() {
            const val = this.getDataValue('daily_tasks');
            return val || [];
        }
    },
    daily_task_reset_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '任务重置时间（跨日重置）'
    },
    total_cultivate_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '累计修炼次数'
    },
    total_skill_use_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '累计技能使用次数'
    },
    total_resonance_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '累计共鸣次数'
    },
    daily_cultivate_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已修炼次数（跨日重置，上限 daily_cultivate_limit）'
    },
    last_cultivate_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后修炼日期（跨日重置 daily_cultivate_count）'
    }
}, {
    tableName: 'player_taoism_gate',
    timestamps: true,
    underscored: true,
    indexes: []
});

module.exports = PlayerTaoismGate;
