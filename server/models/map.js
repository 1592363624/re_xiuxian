/**
 * 地图数据模型
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Map = sequelize.define('Map', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '地图名称'
    },
    type: {
        type: DataTypes.ENUM('NOVICE', 'LOW', 'MID', 'HIGH', 'SPECIAL'),
        allowNull: false,
        comment: '地图层级类型'
    },
    min_realm_rank: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '最低境界等级要求'
    },
    safety_level: {
        type: DataTypes.ENUM('SAFE', 'LOW_RISK', 'MID_RISK', 'HIGH_RISK', 'EXTREME_RISK'),
        defaultValue: 'SAFE',
        comment: '安全等级'
    },
    description: {
        type: DataTypes.TEXT,
        comment: '地图描述'
    },
    resources: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('resources');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('resources', JSON.stringify(value));
        },
        comment: '资源列表 JSON'
    },
    events: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('events');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('events', JSON.stringify(value));
        },
        comment: '随机事件列表 JSON'
    },
    connections: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('connections');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('connections', JSON.stringify(value));
        },
        comment: '连接的地图ID列表 JSON'
    },
    environment_cost: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '环境消耗(每小时灵力)'
    }
}, {
    tableName: 'maps',
    timestamps: true
});

module.exports = Map;
