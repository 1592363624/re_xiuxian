/**
 * 数据库迁移脚本
 * 版本: 2
 * 描述: 添加玩家历练记录表 player_adventures
 * 创建时间: 2024-12-31
 */

module.exports = {
    description: '添加玩家历练记录表 player_adventures',
    version: 2,

    async up(sequelize, QueryTypes) {
        console.log('[Migration v2] 创建 player_adventures 表...');

        try {
            const checkTableSQL = `
                SELECT COUNT(*) as count
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                AND table_name = 'player_adventures'
            `;

            const [tableResult] = await sequelize.query(checkTableSQL, {
                type: QueryTypes.SELECT
            });

            if (tableResult.count === 0) {
                await sequelize.query(`
                    CREATE TABLE player_adventures (
                        id BIGINT AUTO_INCREMENT PRIMARY KEY,
                        player_id BIGINT NOT NULL COMMENT '玩家ID',
                        map_id INTEGER NOT NULL COMMENT '历练所在地图ID',
                        map_name VARCHAR(100) NOT NULL COMMENT '历练所在地图名称',
                        event_id VARCHAR(50) NOT NULL COMMENT '事件模板ID或AI生成事件ID',
                        event_type ENUM('peaceful', 'combat', 'treasure', 'encounter', 'discovery') NOT NULL COMMENT '事件类型',
                        event_data TEXT NOT NULL COMMENT '事件完整数据(JSON)',
                        start_time DATETIME NOT NULL COMMENT '历练开始时间',
                        end_time DATETIME NOT NULL COMMENT '预计结束时间',
                        status ENUM('in_progress', 'completed', 'cancelled') DEFAULT 'in_progress' COMMENT '历练状态',
                        rewards_claimed TINYINT(1) DEFAULT FALSE COMMENT '是否已领取奖励',
                        rewards TEXT COMMENT '获得的奖励(JSON)',
                        combat_battle_id VARCHAR(36) COMMENT '关联的战斗记录ID',
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        INDEX idx_player_adventures_player_id (player_id),
                        INDEX idx_player_adventures_status (status),
                        INDEX idx_player_adventures_player_status (player_id, status)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家历练记录表'
                `);
                console.log('[Migration v2] ✅ player_adventures 表创建完成');
            } else {
                console.log('[Migration v2] ⏩ player_adventures 表已存在，跳过创建');
            }
        } catch (error) {
            console.error('[Migration v2] ✗ 迁移失败:', error.message);
            throw error;
        }
    },

    async down(sequelize, QueryTypes) {
        console.log('[Migration v2] 删除 player_adventures 表...');

        try {
            await sequelize.query(`DROP TABLE IF EXISTS player_adventures`);
            console.log('[Migration v2] ✅ player_adventures 表已删除');
        } catch (error) {
            console.error('[Migration v2] ✗ 回滚失败:', error.message);
            throw error;
        }
    }
};
