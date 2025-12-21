/**
 * 系统配置模型
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SystemConfig = sequelize.define('SystemConfig', {
    key: {
        type: DataTypes.STRING,
        primaryKey: true,
        comment: '配置键名'
    },
    value: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '配置值(JSON字符串)'
    },
    description: {
        type: DataTypes.STRING,
        comment: '配置描述'
    }
}, {
    tableName: 'system_configs',
    timestamps: true
});

module.exports = SystemConfig;
