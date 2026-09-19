/**
 * 迁移脚本 0066：创建 cave_treasure_logs 表，用于洞天寻宝系统
 *
 * 设计依据：xiuxian_game_guide.md 第26节·洞府社交
 *   洞天寻宝是多人交互玩法，玩家拜访他人洞府后可主动探索地块寻宝，
 *   涉及资源真实转移（从洞府主人灵石中借取）、陷阱/护阵惩罚、被发现通知等社交博弈。
 *
 * 表设计：
 *   - cave_treasure_logs：寻宝日志表
 *     · hunter_id：寻宝者玩家ID
 *     · cave_owner_id：洞府主人玩家ID
 *     · plot_number：探索地块编号（1-9）
 *     · result_type：结果类型（treasure/trap/encounter/empty）
 *     · rewards：奖励/损失明细 JSON
 *     · is_discovered：是否被洞府主人发现
 *     · created_at：寻宝时间
 *
 * 索引设计：
 *   - idx_ctl_hunter_date：按寻宝者+日期查询每日次数（每日上限校验）
 *   - idx_ctl_hunter_owner：按寻宝者+洞府主人查询同洞府冷却（24h冷却校验）
 *   - idx_ctl_owner：按洞府主人查询被寻宝记录（通知/统计）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-22
 */
'use strict';

module.exports = {
    name: '0066_cave_treasure_logs',
    description: '创建 cave_treasure_logs 表用于洞天寻宝系统',

    /**
     * 执行迁移：创建 cave_treasure_logs 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    up: async (sequelize, QueryTypes) => {
        /**
         * 检查表是否已存在（幂等性保障）
         * @param {string} tableName - 表名
         * @returns {Promise<boolean>} 是否存在
         */
        async function tableExists(tableName) {
            const [result] = await sequelize.query(
                `SELECT COUNT(*) AS cnt
                 FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = :tbl`,
                { replacements: { tbl: tableName }, type: QueryTypes.SELECT }
            );
            return result && result.cnt > 0;
        }

        if (await tableExists('cave_treasure_logs')) {
            console.log('[migration_0066] cave_treasure_logs 表已存在，跳过创建');
            return;
        }

        // 创建 cave_treasure_logs 表
        await sequelize.query(`
            CREATE TABLE cave_treasure_logs (
                id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                hunter_id BIGINT NOT NULL COMMENT '寻宝者玩家ID',
                cave_owner_id BIGINT NOT NULL COMMENT '洞府主人玩家ID',
                plot_number INT NOT NULL COMMENT '探索地块编号（1-9）',
                result_type VARCHAR(20) NOT NULL COMMENT '寻宝结果类型：treasure/trap/encounter/empty',
                rewards TEXT NULL DEFAULT NULL COMMENT '奖励/损失明细 JSON',
                is_discovered TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否被洞府主人发现（0=未发现，1=被发现）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '寻宝时间',
                PRIMARY KEY (id),
                INDEX idx_ctl_hunter_date (hunter_id, created_at),
                INDEX idx_ctl_hunter_owner (hunter_id, cave_owner_id),
                INDEX idx_ctl_owner (cave_owner_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='洞天寻宝日志表';
        `);
        console.log('[migration_0066] cave_treasure_logs 表创建成功');
    },

    /**
     * 回滚迁移：删除 cave_treasure_logs 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        await sequelize.query('DROP TABLE IF EXISTS cave_treasure_logs;');
        console.log('[migration_0066] cave_treasure_logs 表已删除');
    }
};
