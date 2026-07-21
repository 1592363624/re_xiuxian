/**
 * 数据库迁移脚本
 * 版本: 0044
 * 描述: 灵兽PVP竞技场系统（3 张表：对局记录 + 赛季 + 赛季排行）
 * 创建时间: 2026-07-21
 *
 * 设计要点：
 *   1. spirit_beast_pvp_matches：对局主表，记录每场挑战的双方信息/战斗过程/结果
 *   2. spirit_beast_pvp_seasons：赛季配置表，记录赛季时间段/状态/结算信息
 *   3. spirit_beast_pvp_rankings：赛季排行表，记录玩家在赛季中的段位/胜点/战绩
 *
 * 玩法文档第8节：灵兽PVP对战，玩家选择灵兽+战术，自动回合制战斗，押注灵石，赛季排行
 */
'use strict';

module.exports = {
    description: '灵兽PVP竞技场系统：对局记录 + 赛季配置 + 赛季排行',

    version: 44,

    /**
     * 执行迁移：创建 3 张表
     * @param {import('sequelize').Sequelize} sequelizeInstance - sequelize 实例（migration_manager 传入）
     * @param {object} QueryTypes - QueryTypes 对象（migration_manager 传入）
     */
    async up(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;

        // 辅助函数：检查表是否存在（幂等性保证）
        async function tableExists(tableName) {
            const [rows] = await sequelize.query(
                `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                { replacements: [tableName], type: QueryTypes.SELECT }
            );
            return rows && rows.length > 0;
        }

        // ==================== 表1：灵兽PVP对局记录 ====================
        if (!(await tableExists('spirit_beast_pvp_matches'))) {
            await sequelize.query(`
                CREATE TABLE spirit_beast_pvp_matches (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '对局ID',
                    season_id INT NOT NULL COMMENT '所属赛季ID',
                    challenger_player_id BIGINT NOT NULL COMMENT '挑战方玩家ID',
                    challenger_beast_id BIGINT NOT NULL COMMENT '挑战方灵兽ID',
                    challenger_beast_snapshot JSON NOT NULL COMMENT '挑战方灵兽快照（名称/属性/元素/星级）',
                    challenger_tactic VARCHAR(20) NOT NULL DEFAULT 'balanced' COMMENT '挑战方战术：all_out/balanced/counter',
                    defender_player_id BIGINT NOT NULL COMMENT '防守方玩家ID',
                    defender_beast_id BIGINT NOT NULL COMMENT '防守方灵兽ID',
                    defender_beast_snapshot JSON NOT NULL COMMENT '防守方灵兽快照',
                    defender_tactic VARCHAR(20) NOT NULL DEFAULT 'balanced' COMMENT '防守方战术',
                    bet_spirit_stones BIGINT NOT NULL DEFAULT 0 COMMENT '押注灵石（0=友谊赛）',
                    is_friendly TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否友谊赛（不计赛季）',
                    status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '状态：pending/finished/cancelled',
                    winner_player_id BIGINT NULL COMMENT '胜者玩家ID（平局为null）',
                    winner_side VARCHAR(10) NULL COMMENT '胜方：challenger/defender/draw',
                    total_rounds INT NOT NULL DEFAULT 0 COMMENT '总回合数',
                    final_challenger_hp BIGINT NOT NULL DEFAULT 0 COMMENT '挑战方最终HP',
                    final_defender_hp BIGINT NOT NULL DEFAULT 0 COMMENT '防守方最终HP',
                    battle_log JSON NULL COMMENT '战斗日志（关键回合摘要）',
                    points_change INT NOT NULL DEFAULT 0 COMMENT '胜点变化（胜+10/负-5/平0）',
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    finished_at TIMESTAMP NULL COMMENT '结束时间',
                    INDEX idx_pvp_challenger (challenger_player_id, created_at),
                    INDEX idx_pvp_defender (defender_player_id, created_at),
                    INDEX idx_pvp_season (season_id, created_at),
                    INDEX idx_pvp_status (status, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽PVP对局记录表'
            `);
            console.log('[Migration 0044] 表 spirit_beast_pvp_matches 创建成功');
        } else {
            console.log('[Migration 0044] 表 spirit_beast_pvp_matches 已存在，跳过');
        }

        // ==================== 表2：灵兽PVP赛季配置 ====================
        if (!(await tableExists('spirit_beast_pvp_seasons'))) {
            await sequelize.query(`
                CREATE TABLE spirit_beast_pvp_seasons (
                    id INT AUTO_INCREMENT PRIMARY KEY COMMENT '赛季ID',
                    season_name VARCHAR(50) NOT NULL COMMENT '赛季名称（如：青云赛季）',
                    start_time TIMESTAMP NOT NULL COMMENT '赛季开始时间',
                    end_time TIMESTAMP NOT NULL COMMENT '赛季结束时间',
                    status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT '状态：active/settled/cancelled',
                    settled_at TIMESTAMP NULL COMMENT '结算时间',
                    settlement_summary JSON NULL COMMENT '结算摘要（Top100奖励发放情况）',
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_season_name (season_name),
                    INDEX idx_season_status (status, end_time)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽PVP赛季配置表'
            `);
            console.log('[Migration 0044] 表 spirit_beast_pvp_seasons 创建成功');

            // 创建初始赛季（持续28天，从当前时间开始）
            await sequelize.query(`
                INSERT INTO spirit_beast_pvp_seasons (season_name, start_time, end_time, status)
                VALUES (
                    CONCAT('第', YEAR(NOW()), '季'),
                    NOW(),
                    DATE_ADD(NOW(), INTERVAL 28 DAY),
                    'active'
                )
            `);
            console.log('[Migration 0044] 初始赛季已创建');
        } else {
            console.log('[Migration 0044] 表 spirit_beast_pvp_seasons 已存在，跳过');
        }

        // ==================== 表3：灵兽PVP赛季排行 ====================
        if (!(await tableExists('spirit_beast_pvp_rankings'))) {
            await sequelize.query(`
                CREATE TABLE spirit_beast_pvp_rankings (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '排行记录ID',
                    season_id INT NOT NULL COMMENT '赛季ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    player_nickname_snapshot VARCHAR(50) NOT NULL COMMENT '玩家昵称快照',
                    tier VARCHAR(20) NOT NULL DEFAULT 'bronze' COMMENT '段位：bronze/silver/gold/platinum/diamond/king',
                    ranking_points INT NOT NULL DEFAULT 0 COMMENT '胜点（累计）',
                    total_wins INT NOT NULL DEFAULT 0 COMMENT '总胜场',
                    total_losses INT NOT NULL DEFAULT 0 COMMENT '总负场',
                    total_draws INT NOT NULL DEFAULT 0 COMMENT '总平局',
                    total_matches INT NOT NULL DEFAULT 0 COMMENT '总对局数',
                    win_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00 COMMENT '胜率（自动计算）',
                    best_beast_id BIGINT NULL COMMENT '主力灵兽ID（胜场最多的灵兽）',
                    total_bet_won BIGINT NOT NULL DEFAULT 0 COMMENT '累计赢得押注灵石',
                    total_bet_lost BIGINT NOT NULL DEFAULT 0 COMMENT '累计输掉押注灵石',
                    daily_challenge_count INT NOT NULL DEFAULT 0 COMMENT '今日挑战次数',
                    daily_first_win_claimed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '今日是否已领首胜奖励',
                    daily_reset_at TIMESTAMP NULL COMMENT '每日重置时间',
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_pvp_season_player (season_id, player_id),
                    INDEX idx_pvp_ranking_points (season_id, ranking_points DESC),
                    INDEX idx_pvp_player (player_id, season_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽PVP赛季排行表'
            `);
            console.log('[Migration 0044] 表 spirit_beast_pvp_rankings 创建成功');
        } else {
            console.log('[Migration 0044] 表 spirit_beast_pvp_rankings 已存在，跳过');
        }

        console.log('[Migration 0044] 灵兽PVP竞技场系统迁移完成');
    },

    /**
     * 回滚迁移：删除 3 张表
     */
    async down(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;
        await sequelize.query('DROP TABLE IF EXISTS spirit_beast_pvp_rankings');
        await sequelize.query('DROP TABLE IF EXISTS spirit_beast_pvp_seasons');
        await sequelize.query('DROP TABLE IF EXISTS spirit_beast_pvp_matches');
        console.log('[Migration 0044] 回滚完成：3 张表已删除');
    }
};
