/**
 * 地图数据模型
 * 基于 map_data.json 静态配置的数据结构
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Map = sequelize.define('Map', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '地图ID'
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '地图名称'
    },
    type: {
        type: DataTypes.ENUM('country', 'sect', 'mountain', 'ocean', 'talent', 'world'),
        allowNull: false,
        comment: '地图类型: country-国度, sect-门派, mountain-山脉, ocean-海域, talent-秘境, world-界域'
    },
    description: {
        type: DataTypes.TEXT,
        comment: '地图描述'
    },
    environment: {
        type: DataTypes.STRING,
        defaultValue: 'plains',
        comment: '环境类型: plains-平原, mountain-山脉, ocean-海洋, cave-洞穴, mixed-混合, celestial-天界'
    },
    required_realm: {
        type: DataTypes.STRING,
        defaultValue: '凡人',
        comment: '进入所需的境界要求'
    },
    safety_level: {
        type: DataTypes.ENUM('SAFE', 'LOW_RISK', 'MID_RISK', 'HIGH_RISK', 'EXTREME_RISK'),
        defaultValue: 'SAFE',
        comment: '安全等级'
    },
    danger_level: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '危险等级(1-20)'
    },
    travel_time: {
        type: DataTypes.INTEGER,
        defaultValue: 5,
        comment: '基础移动时间(分钟)'
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
    monsters: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('monsters');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('monsters', JSON.stringify(value));
        },
        comment: '怪物列表 JSON'
    },
    npcs: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('npcs');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('npcs', JSON.stringify(value));
        },
        comment: 'NPC列表 JSON'
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
    special: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '特殊标识(如成就触发等)'
    }
}, {
    tableName: 'maps',
    timestamps: true
});

module.exports = Map;
