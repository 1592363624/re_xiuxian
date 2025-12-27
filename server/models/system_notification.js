/**
 * 系统通知模型
 * 存储全服广播通知、玩家事件通知等
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SystemNotification = sequelize.define('SystemNotification', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    type: {
        type: DataTypes.ENUM('breakthrough', 'death', 'achievement', 'event', 'announcement', 'warning', 'milestone'),
        allowNull: false,
        comment: '通知类型'
    },
    title: {
        type: DataTypes.STRING(200),
        allowNull: false,
        comment: '通知标题'
    },
    content: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '通知内容'
    },
    priority: {
        type: DataTypes.ENUM('low', 'normal', 'high', 'critical'),
        defaultValue: 'normal',
        comment: '优先级'
    },
    targetPlayerId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '目标玩家ID，null表示全服通知'
    },
    actorPlayerId: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '触发事件玩家ID'
    },
    actorNickname: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '触发事件玩家昵称'
    },
    metadata: {
        type: DataTypes.TEXT,
        defaultValue: '{}',
        comment: '附加数据JSON'
    },
    isRead: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否已读'
    },
    readAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '阅读时间'
    },
    expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '过期时间'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: '是否有效'
    }
}, {
    tableName: 'system_notifications',
    indexes: [
        { fields: ['type'] },
        { fields: ['priority'] },
        { fields: ['targetPlayerId'] },
        { fields: ['actorPlayerId'] },
        { fields: ['createdAt'] },
        { fields: ['isActive', 'expiresAt'] }
    ]
});

module.exports = SystemNotification;
