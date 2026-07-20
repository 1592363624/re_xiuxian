/**
 * 玩家神识模型
 *
 * 神识是后期系统的核心资源（用于凝练第二元神/法宝祭炼/飞升/法则转换等）：
 *   - divine_sense_max：上限公式 = 100 + (realm_rank - 14) * 50 + dayan_level * 100
 *   - divine_sense_current：当前神识值，每小时自然恢复 10 点
 *   - 淬炼：100 香火 = 1 神识，每日 3 次，CD 1 小时
 *
 * 与玩家表 1:1 关系（UNIQUE KEY player_id）
 * 与 player.attributes.sense 字段并行存在，本表为后期系统专用扩展
 *
 * 关键字段说明：
 *   - total_quenched/total_consumed：累计统计，用于审计
 *   - daily_quench_count：今日淬炼次数（跨日重置）
 *   - last_quench_time：淬炼冷却基准时间
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerDivineSense = sequelize.define('PlayerDivineSense', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_pds_player',
        comment: '玩家ID'
    },
    divine_sense_max: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '神识上限（受境界/大衍诀影响）'
    },
    divine_sense_current: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '当前神识'
    },
    regen_rate_per_hour: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 10,
        comment: '每小时自然恢复量'
    },
    last_regen_time: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '最后恢复时间'
    },
    last_quench_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后淬炼时间（CD 计算）'
    },
    daily_quench_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日淬炼次数（跨日重置）'
    },
    last_quench_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后淬炼日期（跨日重置）'
    },
    total_quenched: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史累计淬炼获得神识'
    },
    total_consumed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史累计消耗神识'
    }
}, {
    tableName: 'player_divine_sense',
    timestamps: true,
    underscored: true,
    indexes: []
});

module.exports = PlayerDivineSense;
