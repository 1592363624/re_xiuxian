/**
 * 玩家法则模型
 *
 * 法则是飞升前置的核心资源（用于法则转换提升各种永久/临时属性）：
 *   - law_points：法则点数，由神识/法则碎片转换而来
 *   - 5 类法则碎片：space/time/five_elements/soul/karma
 *   - 每日法则点获取上限：50（防止刷爆）
 *
 * 与玩家表 1:1 关系（UNIQUE KEY player_id）
 * 与 player.law_points 字段并行存在（冗余字段加速查询），本表为详细扩展
 *
 * 关键字段说明：
 *   - daily_earned：今日已获得法则点（跨日重置）
 *   - law_fragments_*：5 类法则碎片当前存量
 *   - total_earned/total_spent：累计统计，用于审计
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerLaw = sequelize.define('PlayerLaw', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_pl_player',
        comment: '玩家ID'
    },
    law_points: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '法则点数（用于法则转换）'
    },
    total_earned: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史累计获得法则点'
    },
    total_spent: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史累计消耗法则点'
    },
    daily_earned: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已获得法则点（跨日重置）'
    },
    last_earn_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后获得日期（跨日重置）'
    },
    law_fragments_space: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '空间法则碎片'
    },
    law_fragments_time: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '时间法则碎片'
    },
    law_fragments_five_elements: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '五行法则碎片'
    },
    law_fragments_soul: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '魂之法则碎片'
    },
    law_fragments_karma: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '因果法则碎片'
    }
}, {
    tableName: 'player_law',
    timestamps: true,
    underscored: true,
    indexes: []
});

module.exports = PlayerLaw;
