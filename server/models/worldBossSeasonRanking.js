/**
 * 世界BOSS赛季个人排行模型
 *
 * 每赛季每玩家一条记录，聚合本赛季所有BOSS的伤害/击杀/首杀数据
 * 赛季结算时按 total_damage 排名发放奖励
 *
 * 关键字段：
 *   - best_rank：本赛季所有BOSS中最佳单次排名
 *   - last_rank：最近一次BOSS的排名
 *   - honor_rewarded：已发放荣誉值（防止重复发放）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WorldBossSeasonRanking = sequelize.define('WorldBossSeasonRanking', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '赛季ID'
    },
    player_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称'
    },
    sect_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '宗门ID'
    },
    sect_name: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '宗门名'
    },
    total_damage: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '赛季累计伤害'
    },
    boss_kill_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '赛季参与击杀BOSS数'
    },
    first_kill_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '赛季首杀次数'
    },
    best_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 999999,
        comment: '历史最佳单次排名'
    },
    last_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 999999,
        comment: '最近一次排名'
    },
    honor_rewarded: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '已发放荣誉值'
    }
}, {
    tableName: 'world_boss_season_rankings',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['season_id', 'player_id'], unique: true },
        { fields: ['season_id', 'total_damage'] },
        { fields: ['season_id', 'sect_id', 'total_damage'] }
    ]
});

module.exports = WorldBossSeasonRanking;