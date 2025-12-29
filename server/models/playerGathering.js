/**
 * 玩家采集记录模型
 * 
 * 存储玩家在各地图的采集历史和熟练度
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerGathering = sequelize.define('PlayerGathering', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID',
        unique: 'uk_player_resource'
    },
    resource_id: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '资源ID（对应 item_data.json 中的物品ID）'
    },
    map_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '采集所在地图ID'
    },
    total_gather_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '总采集次数'
    },
    proficiency_level: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '熟练度等级 (1-100)'
    },
    proficiency_exp: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '熟练度经验值'
    },
    last_gather_time: {
        type: DataTypes.DATE,
        comment: '最后采集时间'
    },
    consecutive_days: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '连续采集天数（用于每日奖励）'
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '首次采集时间'
    },
    updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '最后更新时间'
    }
}, {
    tableName: 'player_gatherings',
    timestamps: true,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['resource_id'] },
        { fields: ['map_id'] },
        { fields: ['last_gather_time'] }
    ]
});

module.exports = PlayerGathering;
