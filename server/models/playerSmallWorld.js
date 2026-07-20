/**
 * 玩家小世界模型
 *
 * 后期系统核心资源产出场景：
 *   - 人口：随时间自然增长，受稳定度影响；稳定度<30 时负增长
 *   - 信仰：人口*0.001 每小时累积，用于显灵/神迹/神庙加成
 *   - 稳定度：0-100，<30 触发灾变（人口流失/香火产出降低）
 *   - 香火产出：population * 0.1 * (faith/faith_max) * (stability/100) * temple_level_multiplier
 *
 * 与玩家表 1:1 关系（UNIQUE KEY player_id）
 * 与神庙表 1:1 关系（temple_id 关联 player_divine_temple.id）
 *
 * 关键字段说明：
 *   - world_level：1-10，影响人口上限（population_max = 1000 * world_level）
 *   - last_incense_harvest_time：收割香火时间戳，按公式计算累计产出
 *   - temple_id：关联神庙ID，可空（神庙未创建时为 null）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerSmallWorld = sequelize.define('PlayerSmallWorld', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_psw_player',
        comment: '所属玩家ID'
    },
    world_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '小世界名称（玩家自定义）'
    },
    world_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '小世界等级（1-10）'
    },
    world_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'mortal',
        comment: '世界类型：mortal=凡人界，spirit=灵界'
    },
    population: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '当前人口'
    },
    population_max: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1000,
        comment: '人口上限（受等级影响）'
    },
    faith: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '信仰值（0-10000）'
    },
    faith_max: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 10000,
        comment: '信仰上限'
    },
    stability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '稳定度（0-100，低于30触发灾变）'
    },
    incense_production_rate: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 10,
        comment: '香火产出速率（每小时）'
    },
    last_incense_harvest_time: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '上次收割香火时间'
    },
    temple_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联的神庙ID'
    }
}, {
    tableName: 'player_small_world',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['world_level'], name: 'idx_psw_level' }
    ]
});

module.exports = PlayerSmallWorld;
