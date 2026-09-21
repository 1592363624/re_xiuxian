/**
 * 通知已读回执模型
 *
 * 为什么需要单独一张表：system_notifications.isRead 是"行级"的，一条全服公告只有一行，
 * 任何玩家点"已读"都会把这一行改成已读 —— 等于一个人读了，全服都不再提示未读。
 * 个人通知同样受影响：两个人各有一条指向自己的通知，但已读语义本就该是"人 × 通知"的组合。
 *
 * 已读状态本质上是 (playerId, notificationId) 的二元关系，因此存在这张表里，
 * 每条通知 × 每个玩家最多一行（唯一索引）。
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const NotificationRead = sequelize.define('NotificationRead', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    playerId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    notificationId: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '通知ID'
    },
    readAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '阅读时间'
    }
}, {
    tableName: 'notification_reads',
    timestamps: false,
    indexes: [
        // 唯一约束是"已读"语义的底座：重复点已读只会命中同一行，不会攒出重复回执
        { name: 'uk_player_notification', fields: ['playerId', 'notificationId'], unique: true },
        // 通知被删除时按 notificationId 批量清理回执
        { fields: ['notificationId'] },
        { fields: ['playerId'] }
    ]
});

module.exports = NotificationRead;
