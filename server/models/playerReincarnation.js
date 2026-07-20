/**
 * 玩家夺舍记录模型
 *
 * 记录玩家历史夺舍操作的完整日志，用于审计与统计：
 *   - 原境界/原修为：夺舍前的境界与修为快照
 *   - 目标信息：夺舍的目标ID/名称
 *   - 新境界/新修为：夺舍后的境界与修为
 *   - 继承属性：夺舍后继承的攻击/防御/气血
 *   - 死亡原因：lifespan_out/pvp_kill/breakthrough_fail/ascension_fail
 *
 * 与玩家表 N:1 关系（一个玩家可多次夺舍，每次产生一条记录）
 * 夺舍冷却 72 小时，通过 cooldown_end_time 字段判断是否可再次夺舍
 *
 * 关键字段说明：
 *   - success：夺舍是否成功（失败也保留记录，便于审计）
 *   - death_reason：触发夺舍的死亡原因
 *       lifespan_out      - 寿元耗尽
 *       pvp_kill          - PVP 被杀
 *       breakthrough_fail - 突破失败
 *       ascension_fail    - 飞升失败（最常见）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerReincarnation = sequelize.define('PlayerReincarnation', {
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
    origin_realm: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '原境界'
    },
    origin_realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '原境界rank'
    },
    origin_exp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '原修为'
    },
    target_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '夺舍目标ID'
    },
    target_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '夺舍目标名'
    },
    new_realm: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '夺舍后境界'
    },
    new_realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '夺舍后境界rank'
    },
    new_exp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '夺舍后修为'
    },
    inherited_atk: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '继承的攻击'
    },
    inherited_def: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '继承的防御'
    },
    inherited_hp_max: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '继承的气血上限'
    },
    inherit_ratio: {
        type: DataTypes.FLOAT,
        allowNull: false,
        comment: '实际继承比例'
    },
    success: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: '是否夺舍成功（0否1是）'
    },
    death_reason: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '死亡原因（lifespan_out/pvp_kill/breakthrough_fail/ascension_fail）'
    },
    reincarnated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '夺舍时间'
    },
    cooldown_end_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '夺舍冷却结束时间（72小时）'
    }
}, {
    tableName: 'player_reincarnation',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['reincarnated_at'] }
    ]
});


module.exports = PlayerReincarnation;
