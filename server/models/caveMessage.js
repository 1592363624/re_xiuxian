/**
 * 洞府留言模型
 *
 * 存储访客在他人洞府的留言记录
 * 表名：cave_messages
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveMessage = sequelize.define('CaveMessage', {
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
        comment: '留言者玩家ID'
    },
    content: {
        type: DataTypes.STRING(200),
        allowNull: false,
        comment: '留言内容（最长200字）'
    }
}, {
    tableName: 'cave_messages',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = CaveMessage;
