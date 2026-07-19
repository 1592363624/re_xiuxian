/**
 * 洞府访客记录模型
 *
 * 存储玩家拜访他人洞府的访问记录
 * 表名：cave_visitors
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveVisitor = sequelize.define('CaveVisitor', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    cave_owner_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '洞府主人玩家ID'
    },
    visitor_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '访客玩家ID'
    },
    visited_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '拜访时间'
    }
}, {
    tableName: 'cave_visitors',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
});

module.exports = CaveVisitor;
