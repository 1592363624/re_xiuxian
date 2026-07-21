/**
 * 多人副本成员模型
 *
 * 对应数据库表 multi_dungeon_member，记录每个副本实例的成员信息：
 *   - 基础信息：player_id / player_nickname / player_realm（冗余便于查询）
 *   - 角色与状态：role（leader/member）/ is_ready / is_present
 *   - 战斗与贡献：contribution（贡献度）/ hp_remaining（剩余HP）/ zongzi_invested（投粽数）
 *   - 冷却字段：cooldown_end_time（个人冷却到期时间）
 *
 * 表设计要点：
 *   - (instance_id, player_id) UNIQUE KEY，防止同一玩家重复加入同一副本
 *   - 索引 idx_mdm_instance 支持按实例查成员列表
 *   - 索引 idx_mdm_player 支持按玩家查参与副本
 *
 * 关联关系：
 *   - belongsTo MultiDungeonInstance
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MultiDungeonMember = sequelize.define('MultiDungeonMember', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    instance_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '副本实例ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称（冗余）'
    },
    player_realm: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '玩家境界（冗余）'
    },
    player_realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '玩家境界rank'
    },
    role: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'member',
        comment: '成员角色：leader/member'
    },
    join_time: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '加入时间'
    },
    is_ready: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否已准备（0否1是）'
    },
    is_present: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: '是否在场（0离线1在场）'
    },
    contribution: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本副本贡献度'
    },
    hp_remaining: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '剩余HP（副本内）'
    },
    zongzi_invested: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '已投粽数量（端午用）'
    },
    cooldown_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '个人冷却到期时间'
    }
}, {
    tableName: 'multi_dungeon_member',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['instance_id'], name: 'idx_mdm_instance' },
        { fields: ['player_id'], name: 'idx_mdm_player' },
        // 复合唯一约束防止重复加入同一副本
        { fields: ['instance_id', 'player_id'], unique: true, name: 'uk_mdm_instance_player' }
    ]
});

module.exports = MultiDungeonMember;
