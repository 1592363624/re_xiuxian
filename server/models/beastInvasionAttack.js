/**
 * 妖兽入侵攻击记录模型
 *
 * 记录玩家在妖兽入侵战斗阶段每次攻击妖兽的明细
 * 每条记录对应一次攻击行为，用于：
 *   1. 伤害排行：按 damage 排序结算 top_3 / top_10 奖励
 *   2. 攻击冷却：通过最近一条记录的 createdAt 判定 cooldown
 *   3. 聚合战报：按时间窗口聚合所有玩家的攻击记录形成滚动战报
 *   4. 审计：保留玩家攻击历史便于追溯
 *
 * 与 world_boss_damage_records（累计单条）不同：
 *   本表为"流水明细"，每次攻击一条记录，便于聚合战报细粒度展示
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BeastInvasionAttack = sequelize.define('BeastInvasionAttack', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '攻击记录ID'
    },
    invasion_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '妖兽入侵事件ID'
    },
    player_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称（冗余存储便于排行查询）'
    },
    player_realm: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: '凡人',
        comment: '玩家境界（冗余存储）'
    },
    damage: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '本次攻击造成的伤害'
    },
    is_critical: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否暴击'
    },
    counter_damage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '妖兽反击造成的伤害'
    },
    beast_hp_before: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '攻击前妖兽 HP'
    },
    beast_hp_after: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '攻击后妖兽 HP'
    },
    skill_used: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '本次使用的技能名（未配置技能时为 null）'
    }
}, {
    tableName: 'beast_invasion_attacks',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['invasion_id'] },
        { fields: ['player_id'] },
        { fields: ['invasion_id', 'player_id'] },
        { fields: ['invasion_id', 'damage'] },
        { fields: ['invasion_id', 'created_at'] }
    ]
});

module.exports = BeastInvasionAttack;
