/**
 * 玩家飞升进度模型
 *
 * 存储玩家飞升灵界的完整进度数据：
 *   - 大衍诀修炼层数（0-5，5=衍神为飞升前置）
 *   - 空间法则碎片收集进度（飞升需≥5）
 *   - 逆灵通道坐标（定星成功后获得）
 *   - 飞升状态机：preparing/ascending/success/failed/reverting
 *   - 历史飞升记录与天机回溯次数
 *
 * 与 players 表 1:1 关系（UNIQUE KEY player_id）
 * 飞升成功后 is_ascended=1，玩家进入灵界场景
 *
 * 关键字段说明：
 *   - ascension_state：飞升生命周期状态
 *       preparing - 准备中（默认）
 *       ascending - 飞升尝试中（状态机锁定）
 *       success   - 飞升成功（已飞升灵界）
 *       failed    - 飞升失败（残魂<30可触发夺舍）
 *       reverting - 天机回溯中（飞升失败后的回退尝试）
 *   - revert_count：天机回溯剩余次数，每日跨日重置为 1
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerAscension = sequelize.define('PlayerAscension', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_pa_player',
        comment: '玩家ID'
    },
    ascension_state: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'preparing',
        comment: '飞升状态：preparing/ascending/success/failed/reverting'
    },
    dayan_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '大衍诀层数（0-5），飞升需达 5=衍神'
    },
    dayan_exp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '大衍诀当前层数熟练度'
    },
    dayan_meditate_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日参悟次数（跨日重置为0）'
    },
    last_meditate_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后参悟时间（冷却计算用）'
    },
    last_meditate_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后参悟日期（跨日重置判断用）'
    },
    reverse_channel_coord: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '逆灵通道坐标（定星成功获得）'
    },
    law_fragments_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '空间法则碎片数量（飞升需≥5）'
    },
    ascension_attempt_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史飞升尝试次数'
    },
    ascension_success_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史飞升成功次数'
    },
    last_ascension_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后飞升时间（冷却用）'
    },
    last_revert_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后天机回溯时间'
    },
    revert_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日天机回溯剩余次数（跨日重置为1）'
    },
    last_revert_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后回溯日期（跨日重置）'
    },
    is_ascended: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否已飞升灵界（0否1是）'
    },
    ascended_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '飞升成功时间'
    },
    ascension_realm: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '飞升后所在界域（lingji=灵界）'
    }
}, {
    tableName: 'player_ascension',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['ascension_state'] },
        { fields: ['is_ascended'] }
    ]
});

module.exports = PlayerAscension;
