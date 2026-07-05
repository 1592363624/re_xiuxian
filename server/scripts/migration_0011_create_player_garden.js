/**
 * 数据库迁移脚本
 * 版本: 0011
 * 描述: 创建玩家药园表 player_gardens
 * 创建时间: 2026-07-04
 *
 * 表用途：
 *   - 存储玩家洞府药园中每个地块的种植记录
 *   - 一个玩家最多9个地块，每个地块可种植一种灵草
 *   - 联合唯一索引约束一个玩家一个地块只能有一条记录
 */

module.exports = {
    description: '创建玩家药园表 player_gardens',
    version: 11,

    async up(sequelize, QueryTypes) {
        console.log('[Migration v0011] 开始创建 player_gardens 表...');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS player_gardens (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                plot_index INT NOT NULL COMMENT '地块序号1-9',
                seed_id VARCHAR(50) NULL COMMENT '种子ID',
                produce_item_id VARCHAR(100) NULL COMMENT '成熟后产出物品ID',
                planted_at DATETIME NULL COMMENT '种植时间',
                mature_at DATETIME NULL COMMENT '成熟时间',
                status VARCHAR(20) NOT NULL DEFAULT 'empty' COMMENT '地块状态empty/planted/mature',
                base_yield INT NOT NULL DEFAULT 0 COMMENT '基础产量',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_player_plot (player_id, plot_index),
                INDEX idx_player_id (player_id),
                INDEX idx_status (status),
                INDEX idx_mature_at (mature_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家药园表'
        `);

        console.log('  ✓ 创建表: player_gardens');
        console.log('[Migration v0011] player_gardens 表创建完成');
    },

    async down(sequelize, QueryTypes) {
        console.log('[Migration v0011] 回滚：删除 player_gardens 表...');
        await sequelize.query('DROP TABLE IF EXISTS player_gardens');
        console.log('[Migration v0011] 回滚完成');
    }
};
