/**
 * 数据库迁移脚本
 * 版本: 0014
 * 描述: 创建 PVP 斗法系统相关表
 * 创建时间: 2026-07-05
 *
 * 创建表：
 *   1. pvp_battle_records - PVP 战斗记录表
 *      存储玩家间斗法的完整战斗日志、奖励、因果值变化等
 *   2. pvp_rankings - PVP 段位积分表（每玩家一条）
 *      存储玩家本赛季积分、段位、连胜、每日挑战次数等
 *
 * 设计要点：
 *   - 战斗记录表含攻击方/防守方索引，便于查询历史
 *   - 段位积分表 player_id 唯一索引，保证一人一条
 *   - 段位积分表 score 倒序索引，便于排行榜查询
 *   - 因果值（karma）用于跨境界欺凌惩罚机制
 *
 * 幂等性：使用 CREATE TABLE IF NOT EXISTS
 *
 * MySQL 5.6 兼容性：
 *   - 时间戳字段使用 created_at/updated_at（snake_case），配合模型 underscored: true
 *   - BIGINT 用于玩家ID与灵石金额，避免溢出
 */

module.exports = {
    description: '创建 PVP 斗法系统相关表（战斗记录表、段位积分表）',
    version: 14,

    /**
     * 执行迁移：创建 pvp_battle_records 与 pvp_rankings 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0014] 开始创建 PVP 斗法系统表...');

        // PVP 战斗记录表
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS pvp_battle_records (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                attacker_id BIGINT NOT NULL COMMENT '攻击方玩家ID',
                defender_id BIGINT NOT NULL COMMENT '防守方玩家ID',
                battle_type VARCHAR(20) NOT NULL DEFAULT 'normal' COMMENT '战斗类型：normal/match/bounty',
                winner_id BIGINT NULL COMMENT '胜利方玩家ID（NULL表示平局）',
                total_rounds INT NOT NULL DEFAULT 0 COMMENT '总回合数',
                attacker_score_change INT NOT NULL DEFAULT 0 COMMENT '攻击方段位分变化',
                defender_score_change INT NOT NULL DEFAULT 0 COMMENT '防守方段位分变化',
                attacker_honor_gain BIGINT NOT NULL DEFAULT 0 COMMENT '攻击方荣誉值收益',
                defender_honor_gain BIGINT NOT NULL DEFAULT 0 COMMENT '防守方荣誉值收益',
                spirit_stone_reward BIGINT NOT NULL DEFAULT 0 COMMENT '灵石奖励',
                drop_item_key VARCHAR(100) NULL COMMENT '掉落物品key',
                drop_item_quantity INT NOT NULL DEFAULT 0 COMMENT '掉落数量',
                karma_change INT NOT NULL DEFAULT 0 COMMENT '因果值变化（跨境界欺凌增加）',
                battle_log TEXT NULL COMMENT '战斗日志JSON',
                status VARCHAR(20) NOT NULL DEFAULT 'finished' COMMENT '状态：ongoing/finished/cancelled',
                started_at DATETIME NOT NULL COMMENT '战斗开始时间',
                finished_at DATETIME NULL COMMENT '战斗结束时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_attacker (attacker_id, created_at),
                INDEX idx_defender (defender_id, created_at),
                INDEX idx_status (status, started_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PVP斗法战斗记录表'
        `);
        console.log('  ✓ 创建表: pvp_battle_records');

        // PVP 段位积分表（每玩家一条）
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS pvp_rankings (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                score INT NOT NULL DEFAULT 0 COMMENT 'PVP段位积分',
                rank_tier VARCHAR(20) NOT NULL DEFAULT '散修' COMMENT '段位名称',
                season_wins INT NOT NULL DEFAULT 0 COMMENT '本赛季胜场',
                season_losses INT NOT NULL DEFAULT 0 COMMENT '本赛季败场',
                season_draws INT NOT NULL DEFAULT 0 COMMENT '本赛季平局',
                win_streak INT NOT NULL DEFAULT 0 COMMENT '当前连胜',
                max_win_streak INT NOT NULL DEFAULT 0 COMMENT '历史最高连胜',
                daily_challenge_count INT NOT NULL DEFAULT 0 COMMENT '今日挑战次数',
                daily_defend_count INT NOT NULL DEFAULT 0 COMMENT '今日被挑战次数',
                last_challenge_date DATE NULL COMMENT '最后挑战日期（用于跨日重置）',
                last_battle_time DATETIME NULL COMMENT '最后战斗时间（冷却计算）',
                total_battles INT NOT NULL DEFAULT 0 COMMENT '历史总战斗数',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_player_id (player_id),
                INDEX idx_score (score DESC),
                INDEX idx_rank_tier (rank_tier)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PVP段位积分表'
        `);
        console.log('  ✓ 创建表: pvp_rankings');

        console.log('[Migration v0014] PVP 斗法系统表创建完成');
    },

    /**
     * 回滚迁移：删除 PVP 相关表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0014] 开始回滚：删除 PVP 斗法系统表...');
        await sequelize.query('DROP TABLE IF EXISTS pvp_rankings');
        console.log('  ✓ 删除表: pvp_rankings');
        await sequelize.query('DROP TABLE IF EXISTS pvp_battle_records');
        console.log('  ✓ 删除表: pvp_battle_records');
        console.log('[Migration v0014] 回滚完成');
    }
};
