/**
 * 数据库迁移脚本
 * 版本: 0007
 * 描述: 创建坊市挂单表 market_listings，用于万宝楼换物交易系统
 * 创建时间: 2026-07-03
 *
 * 表用途：
 *   - 存储玩家在坊市上架的物品挂单（万宝楼为换物系统，非灵石交易）
 *   - seller_id 关联 players 表，记录卖家信息
 *   - item_key / want_item_key 关联 item_data.json 静态配置
 *   - item_name / want_item_name 冗余存储，便于列表展示无需关联查询配置
 *   - status 标识挂单生命周期：active（上架中）/ sold（已售出）/ cancelled（已下架）
 *
 * 索引设计：
 *   - idx_seller_id：按卖家查询货摊（高频查询）
 *   - idx_status：按状态筛选上架中挂单（列表展示高频查询）
 *   - idx_item_key：按物品键名查询（用于校验同物品已有挂单数等）
 */

module.exports = {
    description: '创建坊市挂单表 market_listings',
    version: 7,

    /**
     * 执行迁移：创建 market_listings 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0007] 开始创建 market_listings 表...');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS market_listings (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键 ID',
                seller_id BIGINT NOT NULL COMMENT '卖家玩家ID',
                item_key VARCHAR(100) NOT NULL COMMENT '出售物品配置键名',
                item_name VARCHAR(100) NOT NULL COMMENT '出售物品名称（冗余存储便于列表展示）',
                quantity INT NOT NULL DEFAULT 1 COMMENT '出售数量',
                want_item_key VARCHAR(100) NOT NULL COMMENT '换取的物品键名（万宝楼为换物系统）',
                want_item_name VARCHAR(100) NOT NULL COMMENT '换取物品名称（冗余存储便于列表展示）',
                want_quantity INT NOT NULL DEFAULT 1 COMMENT '换取数量',
                status VARCHAR(20) DEFAULT 'active' COMMENT '挂单状态：active上架中 / sold已售出 / cancelled已下架',
                buyer_id BIGINT NULL COMMENT '买家玩家ID（成交时写入）',
                sold_at DATETIME NULL COMMENT '成交时间',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_seller_id (seller_id),
                INDEX idx_status (status),
                INDEX idx_item_key (item_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='坊市挂单表（万宝楼换物交易）'
        `);

        console.log('  ✓ 创建表: market_listings');
        console.log('[Migration v0007] market_listings 表创建完成');
    },

    /**
     * 回滚迁移：删除 market_listings 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0007] 回滚：删除 market_listings 表...');
        await sequelize.query('DROP TABLE IF EXISTS market_listings');
        console.log('[Migration v0007] 回滚完成');
    }
};
