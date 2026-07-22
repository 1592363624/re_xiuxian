/**
 * 迁移脚本 0061：创建 player_sparring 表，用于切磋木人玩法
 *
 * 设计依据：xiuxian_game_guide.md 第17节·战力与阵法
 *   切磋木人是战力测试功能，玩家选择不同境界的木人傀儡进行切磋，
 *   获得修为奖励和战力评分，参与每日排行榜竞争。
 *
 * 表设计：
 *   - player_sparring：玩家切磋记录表，记录每次切磋的完整信息
 *     · 基础信息：player_id / woodman_tier / woodman_key / woodman_name
 *     · 战斗数据：rounds_used / player_hp_remaining / player_hp_max / player_mp_used
 *     · 结果：result（win/lose/timeout/flee）/ score / is_first_clear
 *     · 奖励：exp_gained / spirit_stones_gained / title_awarded
 *     · 时间：created_at / settled_at
 *
 * 索引设计：
 *   - idx_ps_player：按玩家查询切磋历史
 *   - idx_ps_player_date：按玩家+日期查询每日次数
 *   - idx_ps_score：按分数排序用于排行榜
 *   - idx_ps_tier_date：按档次+日期排序用于分档次排行榜
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0061_sparring_records',
    description: '创建 player_sparring 表用于切磋木人玩法',

    /**
     * 执行迁移：创建 player_sparring 表
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

        if (await tableExists('player_sparring')) {
            console.log('[migration_0061] 表 player_sparring 已存在，跳过创建');
            return;
        }

        console.log('[migration_0061] 创建表 player_sparring');
        await sequelize.query(`
            CREATE TABLE player_sparring (
                id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                player_nickname VARCHAR(50) NOT NULL COMMENT '玩家昵称（冗余便于排行展示）',
                player_realm_rank INT NOT NULL COMMENT '玩家境界rank（冗余便于排行展示）',
                player_realm_name VARCHAR(30) NOT NULL COMMENT '玩家境界名（冗余便于排行展示）',
                woodman_tier INT NOT NULL COMMENT '木人档次（1-5）',
                woodman_key VARCHAR(30) NOT NULL COMMENT '木人键（qi_refining/foundation/core_formation/nascent_soul/spirit_severing）',
                woodman_name VARCHAR(50) NOT NULL COMMENT '木人名称（炼气木人/筑基木人/...）',
                rounds_used INT NOT NULL DEFAULT 0 COMMENT '战斗使用回合数',
                max_rounds INT NOT NULL DEFAULT 30 COMMENT '最大回合数上限',
                player_hp_remaining BIGINT NOT NULL DEFAULT 0 COMMENT '玩家剩余HP',
                player_hp_max BIGINT NOT NULL DEFAULT 0 COMMENT '玩家最大HP',
                player_mp_used BIGINT NOT NULL DEFAULT 0 COMMENT '玩家消耗MP',
                total_damage_dealt BIGINT NOT NULL DEFAULT 0 COMMENT '对木人造成的总伤害',
                total_damage_taken BIGINT NOT NULL DEFAULT 0 COMMENT '受到木人的总伤害',
                result VARCHAR(20) NOT NULL COMMENT '切磋结果（win/lose/timeout）',
                score INT NOT NULL DEFAULT 0 COMMENT '战力评分（基础分+效率分+HP保留分+完美分）',
                is_first_clear TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否首次击败该档次木人（0否1是）',
                exp_gained BIGINT NOT NULL DEFAULT 0 COMMENT '获得修为',
                spirit_stones_gained BIGINT NOT NULL DEFAULT 0 COMMENT '获得灵石',
                title_awarded VARCHAR(50) DEFAULT NULL COMMENT '获得的称号ID（如有）',
                battle_log TEXT COMMENT '战斗日志（JSON格式，可选存储）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '切磋时间',
                settled_at DATETIME DEFAULT NULL COMMENT '排行榜结算时间（如参与每日结算）',
                PRIMARY KEY (id),
                INDEX idx_ps_player (player_id),
                INDEX idx_ps_player_date (player_id, created_at),
                INDEX idx_ps_score (score),
                INDEX idx_ps_tier_date (woodman_tier, created_at),
                INDEX idx_ps_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='切磋木人记录表'
        `);

        console.log('[migration_0061] 表 player_sparring 创建完成');
    },

    /**
     * 回滚迁移：删除 player_sparring 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        console.log('[migration_0061] 删除表 player_sparring');
        await sequelize.query('DROP TABLE IF EXISTS player_sparring');
        console.log('[migration_0061] 回滚完成');
    }
};
