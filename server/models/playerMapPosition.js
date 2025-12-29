/**
 * 玩家地图位置数据模型
 * 
 * 仅存储玩家在地图上的动态数据（探索进度、最后访问时间等）
 * 静态地图配置从 map_data.json 读取
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerMapPosition = sequelize.define('PlayerMapPosition', {
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
        unique: 'uk_player_map'
    },
    map_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '当前所在地图ID'
    },
    exploration_progress: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        comment: '地图探索进度 (0-100)'
    },
    visited_nodes: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('visited_nodes');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('visited_nodes', JSON.stringify(value));
        },
        comment: '已访问的地点节点ID列表'
    },
    last_visit_time: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '最后访问该地图的时间'
    },
    resource_gather_count: {
        type: DataTypes.TEXT,
        defaultValue: '{}',
        get() {
            const rawValue = this.getDataValue('resource_gather_count');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('resource_gather_count', JSON.stringify(value));
        },
        comment: '资源采集次数统计 { resourceId: count }'
    },
    monster_defeat_count: {
        type: DataTypes.TEXT,
        defaultValue: '{}',
        get() {
            const rawValue = this.getDataValue('monster_defeat_count');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('monster_defeat_count', JSON.stringify(value));
        },
        comment: '怪物击败次数统计 { monsterId: count }'
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '首次进入地图时间'
    }
}, {
    tableName: 'player_map_positions',
    timestamps: true,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['map_id'] },
        { fields: ['last_visit_time'] }
    ]
});

module.exports = PlayerMapPosition;
