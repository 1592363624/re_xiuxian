/**
 * 迁移脚本 0086：创建 notification_reads 表
 *
 * 用途：把"已读"从 system_notifications.isRead（行级、全服共享）搬成
 *       (playerId, notificationId) 的二元关系，让每个玩家有独立的已读状态。
 *
 * 为什么要搬：全服公告在库里只有一行，任何人点已读都会把这一行置为已读，
 * 于是"一个人看过 → 全服都不再显示未读"。个人通知同理，已读语义本就是人 × 通知的组合。
 *
 * 兼容性：旧数据不迁移 —— 迁移前已读的行仍按"未读"呈现一次，
 * 让玩家重新点一次已读即可，比把一整张表的行级状态倒推成每人的回执更可控。
 */
const NotificationRead = require('../../models/notification_read');

const migrationInfo = {
    description: '创建 notification_reads 表，存放 (玩家, 通知) 的已读回执',
    version: '1.0.0'
};

async function up() {
    // sync 仅创建不存在的表，不会改动已有表结构（与项目迁移约定一致）
    await NotificationRead.sync();
    console.log('[Migration 0086] notification_reads 表已就绪');
}

async function down() {
    await NotificationRead.drop();
    console.log('[Migration 0086] 已回滚 notification_reads 表');
}

module.exports = { up, down, migrationInfo };
