/**
 * 道侣护道日志模型
 *
 * 表：dao_companion_protect_log
 * 用途：记录 PVP/宗门战中道侣护道触发的事件详情，用于玩家查询护道历史与统计
 *
 * 字段说明：
 *   - companion_id: 关联 dao_companions.id，便于按道侣关系聚合查询
 *   - attacker_id: 攻击方玩家ID（发起伤害的人）
 *   - defender_id: 被攻击方玩家ID（被护道的人）
 *   - protector_id: 护道方玩家ID（道侣，承担分担伤害的人）
 *   - original_damage / shared_damage / counter_damage: 伤害明细
 *   - heart_contract_level: 触发时的心契等级（2-9）
 *   - battle_type: pvp / sect_war / world_boss 等
 *   - battle_id: 关联战斗记录表ID
 *
 * 索引设计：
 *   - idx_dcpl_defender: 按 defender_id 查询玩家被护道记录（"我被道侣护了多少次"）
 *   - idx_dcpl_protector: 按 protector_id 查询玩家护道他人记录（"我护道了多少次"）
 *   - idx_dcpl_companion: 按道侣关系聚合查询
 *   - idx_dcpl_attacker: 按攻击方查询（用于反作弊：某玩家是否频繁被同一人护道反击）
 *   - idx_dcpl_created_at: 时间排序
 */
'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DaoCompanionProtectLog = sequelize.define('DaoCompanionProtectLog', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '护道日志主键ID'
    },
    companion_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '道侣关系ID（关联 dao_companions.id）'
    },
    attacker_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '攻击方玩家ID'
    },
    defender_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被攻击方玩家ID（护道触发者）'
    },
    protector_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '护道方玩家ID（道侣，承担分担伤害）'
    },
    original_damage: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '原始伤害值'
    },
    shared_damage: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '护道方分担的伤害值'
    },
    counter_damage: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '护道方反击伤害值'
    },
    heart_contract_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '触发时的心契等级（2-9）'
    },
    protect_rate: {
        type: DataTypes.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0.0000,
        comment: '触发概率（0.0000-1.0000）'
    },
    damage_share_rate: {
        type: DataTypes.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0.0000,
        comment: '伤害分担比例'
    },
    counter_attack_rate: {
        type: DataTypes.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0.0000,
        comment: '反击概率'
    },
    battle_type: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'pvp',
        comment: '战斗类型：pvp/sect_war/world_boss 等'
    },
    battle_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '战斗记录ID（关联 pvp_battle_records 或 sect_war_battle_records）'
    },
    battle_round: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '战斗回合数（PVP用）'
    },
    remark: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: '备注（如：心契L2 首次护道/双修共历心劫 等）'
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '护道触发时间'
    }
}, {
    tableName: 'dao_companion_protect_log',
    timestamps: false,  // 仅 created_at，无 updated_at
    underscored: true,
    indexes: [
        // 按被护道方查询：玩家"被护道"历史
        { fields: ['defender_id'], name: 'idx_dcpl_defender' },
        // 按护道方查询：玩家"护道他人"历史
        { fields: ['protector_id'], name: 'idx_dcpl_protector' },
        // 按道侣关系聚合查询
        { fields: ['companion_id'], name: 'idx_dcpl_companion' },
        // 按攻击方查询（反作弊：某玩家是否被同一对道侣频繁反击）
        { fields: ['attacker_id'], name: 'idx_dcpl_attacker' },
        // 时间排序索引
        { fields: ['created_at'], name: 'idx_dcpl_created_at' }
    ]
});

module.exports = DaoCompanionProtectLog;
