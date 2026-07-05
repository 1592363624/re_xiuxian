/**
 * 数据库迁移脚本
 * 版本: 0016
 * 描述: 创建当铺系统相关表
 * 创建时间: 2026-07-05
 *
 * 创建表：
 *   1. pawnshop_listings - 当铺典当记录表（当票）
 *      存储玩家典当物品的当票信息：估值、赎回价、截止时间、状态等
 *   2. pawnshop_histories - 当铺交易历史表
 *      存储玩家在当铺的所有操作记录（典当/赎回/逾期/拍卖）
 *
 * 设计要点：
 *   - 当票表含 player_id + status 复合索引，便于查询玩家活跃当票
 *   - 当票表含 status + redeem_deadline 复合索引，便于逾期检查调度器
 *   - 历史表含 player_id + created_at 索引，便于查询玩家交易历史
 *   - 历史表含 listing_id 索引，便于反查当票关联操作
 *
 * 幂等性：使用 CREATE TABLE IF NOT EXISTS
 *
 * MySQL 5.6 兼容性：
 *   - 时间戳字段使用 created_at/updated_at（snake_case），配合模型 underscored: true
 *   - BIGINT 用于灵石金额，避免溢出
 */

module.exports = {
    description: '创建当铺系统相关表（典当记录表、交易历史表）',
    version: 16,

    /**
     * 执行迁移：创建 pawnshop_listings 与 pawnshop_histories 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0016] 开始创建当铺系统表...');

        // 当铺典当记录表（当票）
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS pawnshop_listings (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '当票ID',
                player_id BIGINT NOT NULL COMMENT '典当人玩家ID',
                item_key VARCHAR(100) NOT NULL COMMENT '物品key',
                item_name VARCHAR(100) NOT NULL COMMENT '物品名称',
                item_quality VARCHAR(20) NOT NULL DEFAULT 'common' COMMENT '物品品质',
                quantity INT NOT NULL DEFAULT 1 COMMENT '典当数量',
                base_price BIGINT NOT NULL DEFAULT 0 COMMENT '物品基础价值',
                valuation BIGINT NOT NULL DEFAULT 0 COMMENT '估值',
                pawn_amount BIGINT NOT NULL DEFAULT 0 COMMENT '实际获得灵石（估值×折扣率）',
                redeem_amount BIGINT NOT NULL DEFAULT 0 COMMENT '赎回价（含利息）',
                pawn_fee BIGINT NOT NULL DEFAULT 0 COMMENT '手续费',
                pawned_at DATETIME NOT NULL COMMENT '典当时间',
                redeem_deadline DATETIME NOT NULL COMMENT '赎回截止时间',
                redeemed_at DATETIME NULL COMMENT '实际赎回时间',
                status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT '状态：active/redeemed/overdue/auctioned',
                redeemed_by BIGINT NULL COMMENT '赎回操作人玩家ID（GM代赎时记录）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_player (player_id, status),
                INDEX idx_status_deadline (status, redeem_deadline),
                INDEX idx_pawned_at (pawned_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='当铺典当记录表'
        `);
        console.log('  ✓ 创建表: pawnshop_listings');

        // 当铺交易历史表
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS pawnshop_histories (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                listing_id BIGINT NULL COMMENT '关联当票ID',
                action_type VARCHAR(20) NOT NULL COMMENT '操作类型：pawn/redeem/overdue/auction',
                item_key VARCHAR(100) NOT NULL COMMENT '物品key',
                item_name VARCHAR(100) NOT NULL COMMENT '物品名称',
                quantity INT NOT NULL DEFAULT 1 COMMENT '数量',
                amount BIGINT NOT NULL DEFAULT 0 COMMENT '涉及灵石数',
                detail TEXT NULL COMMENT '详情JSON',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_player (player_id, created_at),
                INDEX idx_listing (listing_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='当铺交易历史表'
        `);
        console.log('  ✓ 创建表: pawnshop_histories');

        console.log('[Migration v0016] 当铺系统表创建完成');
    },

    /**
     * 回滚迁移：删除当铺相关表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0016] 开始回滚：删除当铺系统表...');
        await sequelize.query('DROP TABLE IF EXISTS pawnshop_histories');
        console.log('  ✓ 删除表: pawnshop_histories');
        await sequelize.query('DROP TABLE IF EXISTS pawnshop_listings');
        console.log('  ✓ 删除表: pawnshop_listings');
        console.log('[Migration v0016] 回滚完成');
    }
};
