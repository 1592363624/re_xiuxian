/**
 * 玩家历练记录模型
 * 
 * 记录玩家的历练探索历史和当前进行中的历练
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerAdventure = sequelize.define('PlayerAdventure', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    map_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '历练所在地图ID'
    },
    map_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '历练所在地图名称'
    },
    event_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '事件模板ID或AI生成事件ID'
    },
    event_type: {
        type: DataTypes.ENUM('peaceful', 'combat', 'treasure', 'encounter', 'discovery'),
        allowNull: false,
        comment: '事件类型'
    },
    event_data: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '事件完整数据(JSON)'
    },
    start_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '历练开始时间'
    },
    end_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '预计结束时间'
    },
    status: {
        type: DataTypes.ENUM('in_progress', 'completed', 'cancelled'),
        defaultValue: 'in_progress',
        comment: '历练状态'
    },
    rewards_claimed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否已领取奖励'
    },
    rewards: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '获得的奖励(JSON)'
    },
    combat_battle_id: {
        type: DataTypes.STRING(36),
        allowNull: true,
        comment: '关联的战斗记录ID'
    }
}, {
    tableName: 'player_adventures',
    timestamps: true,
    indexes: [
        {
            name: 'idx_player_adventures_player_id',
            fields: ['player_id']
        },
        {
            name: 'idx_player_adventures_status',
            fields: ['status']
        },
        {
            name: 'idx_player_adventures_player_status',
            fields: ['player_id', 'status']
        }
    ]
});

module.exports = PlayerAdventure;
