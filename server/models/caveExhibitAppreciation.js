/**
 * 万宝阁展品鉴赏记录模型
 *
 * 存储玩家鉴赏他人洞府展品的记录
 * 表名：cave_exhibit_appreciations
 *
 * 系统说明：
 *   拜访他人洞府后可鉴赏展品，获得修为灵感奖励。
 *   - 每日鉴赏次数有上限（appreciate.daily_limit）
 *   - 同一展品每日只能鉴赏一次（防刷）
 *   - 鉴赏有概率触发"顿悟"（is_enlightened=1），奖励翻倍 + 临时修炼buff
 *   - 鉴赏记录用于：每日次数校验、顿悟统计、热度计算
 *
 * exp_gained 字段：本次鉴赏获得的修为值（顿悟时为 base × multiplier）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveExhibitAppreciation = sequelize.define('CaveExhibitAppreciation', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    exhibit_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '展品ID'
    },
    appreciator_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '鉴赏者玩家ID'
    },
    is_enlightened: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否触发顿悟（0=普通鉴赏，1=顿悟，奖励翻倍+临时buff）'
    },
    exp_gained: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次鉴赏获得的修为值'
    }
}, {
    tableName: 'cave_exhibit_appreciations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
        { fields: ['exhibit_id', 'created_at'] },
        { fields: ['appreciator_id', 'created_at'] }
    ]
});

module.exports = CaveExhibitAppreciation;
