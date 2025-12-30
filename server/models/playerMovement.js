/**
 * 玩家移动记录模型
 * 
 * 记录玩家的地图移动历史
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerMovement = sequelize.define('PlayerMovement', {
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
    from_map_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '出发地图ID'
    },
    from_map_name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '出发地图名称'
    },
    to_map_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '目标地图ID'
    },
    to_map_name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '目标地图名称'
    },
    distance: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        comment: '移动距离'
    },
    mp_consumed: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '消耗灵力'
    },
    duration_seconds: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '实际耗时(秒)'
    },
    status: {
        type: DataTypes.ENUM('moving', 'completed', 'cancelled'),
        defaultValue: 'moving',
        comment: '移动状态'
    },
    started_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '移动开始时间'
    },
    completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '移动完成时间'
    }
}, {
    tableName: 'player_movements',
    timestamps: true,
    indexes: [
        {
            name: 'idx_player_movements_player_id',
            fields: ['player_id']
        },
        {
            name: 'idx_player_movements_status',
            fields: ['status']
        }
    ]
});

module.exports = PlayerMovement;
