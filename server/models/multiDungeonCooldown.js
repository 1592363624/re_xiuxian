/**
 * 多人副本冷却模型
 *
 * 对应数据库表 multi_dungeon_cooldown，记录玩家在某副本键下的冷却记录：
 *   - 玩家×副本键粒度：player_id + dungeon_key（yanyue/duanwu）
 *   - 冷却时长：cooldown_hours + cooldown_start_time + cooldown_end_time
 *   - 冷却原因：reason（cleared/failed/penalty）
 *   - 关联实例：instance_id（便于审计）
 *
 * 表设计要点：
 *   - 索引 idx_mdc_player_dungeon 支持按（玩家, 副本键）快速查询当前冷却
 *   - 索引 idx_mdc_end_time 支持按到期时间扫描清理过期记录
 *   - 不设 UNIQUE，允许保留历史冷却记录（业务上只查最新的）
 *
 * 业务查询范式：
 *   - 查询玩家某副本是否在冷却：SELECT ... WHERE player_id=? AND dungeon_key=?
 *     ORDER BY cooldown_end_time DESC LIMIT 1，校验 cooldown_end_time > NOW()
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MultiDungeonCooldown = sequelize.define('MultiDungeonCooldown', {
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
    dungeon_key: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '副本键：yanyue/duanwu'
    },
    instance_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联副本实例ID'
    },
    cooldown_hours: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '冷却小时数'
    },
    cooldown_start_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '冷却开始时间'
    },
    cooldown_end_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '冷却到期时间'
    },
    reason: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '冷却原因：cleared/failed/penalty'
    }
}, {
    tableName: 'multi_dungeon_cooldown',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'dungeon_key'], name: 'idx_mdc_player_dungeon' },
        { fields: ['cooldown_end_time'], name: 'idx_mdc_end_time' }
    ]
});

module.exports = MultiDungeonCooldown;
