/**
 * 世界BOSS玩家伤害记录模型
 *
 * 记录每个玩家对单个 BOSS 实例的累计伤害数据
 * 每个 (boss_id, player_id) 组合唯一，使用 UPSERT 累加伤害
 * 排行榜查询走 (boss_id, total_damage DESC) 索引
 *
 * 冗余字段说明（player_nickname/player_realm/sect_name）：
 *   便于排行榜查询直接返回，避免 JOIN players + sects 表
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WorldBossDamageRecord = sequelize.define('WorldBossDamageRecord', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    boss_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'BOSS实例ID'
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
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '玩家境界（冗余存储）'
    },
    sect_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '玩家所属宗门ID'
    },
    sect_name: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '玩家所属宗门名（冗余）'
    },
    total_damage: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '累计伤害'
    },
    damage_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '攻击次数'
    },
    death_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '被BOSS击杀次数'
    },
    revive_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '复活次数'
    },
    best_single_damage: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '单次最高伤害'
    },
    first_attack_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '首次攻击时间'
    },
    last_attack_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后攻击时间'
    },
    is_participant: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: '是否算作参与（伤害>0）'
    },
    // ========== 多行动机制字段（迁移 0053 新增，2026-07-21） ==========
    // 配置 game_balance.json → world_boss.action_system
    // 记录玩家上次行动类型与连续相同行动次数，用于触发"重复行动惩罚"
    // 4 种行动：assault=强攻 / break_banner=破幡 / suppress_soul=镇魂 / protect_array=护阵
    // 切换行动类型时 action_streak 重置为 1，连续 >=3 次同一行动触发 0.5 倍伤害惩罚
    last_action: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: null,
        comment: '上次行动类型（assault/break_banner/suppress_soul/protect_array）'
    },
    action_streak: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '连续相同行动次数'
    }
}, {
    tableName: 'world_boss_damage_records',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['boss_id', 'player_id'], unique: true },
        { fields: ['boss_id', 'total_damage'] },
        { fields: ['player_id'] },
        { fields: ['sect_id', 'boss_id'] }
    ]
});

module.exports = WorldBossDamageRecord;