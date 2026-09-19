/**
 * 数据库迁移脚本
 * 版本: 0028
 * 描述: 宗门战/领地争夺系统（5 张新表 + 1 张宗门资金表）
 * 创建时间: 2026-07-19
 *
 * 新建表：
 *   1. sect_wars                       - 战役表（攻方/守方/状态/积分）
 *   2. sect_war_territories            - 资源点表（占领归属/驻防）
 *   3. sect_war_participants           - 参战记录表（击杀/死亡/贡献）
 *   4. sect_war_seasons                - 宗门战赛季表
 *   5. sect_war_season_rankings        - 赛季宗门排行表
 *   6. sect_funds                      - 宗门资金与积分表（动态数据）
 *
 * 设计要点：
 *   - 战役状态机：preparing → announced → active → settled
 *   - 资源点用 (territory_key, season_id) 唯一键，每赛季重置归属
 *   - 参战记录用 (war_id, player_id) 唯一键防止重复
 *   - 宗门资金表独立于静态宗门配置，便于动态更新
 *
 * 幂等性：每张表创建前检查 INFORMATION_SCHEMA.TABLES
 */

module.exports = {
    description: '宗门战/领地争夺系统：5 张表 + 1 张宗门资金表',
    version: 28,

    /**
     * 执行迁移：创建 6 张新表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0028] 开始创建宗门战系统表...');

        // ===== 1. sect_wars 表：战役表 =====
        await createTableIfNotExists(sequelize, 'sect_wars', `
            CREATE TABLE sect_wars (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '战役ID',
                war_name VARCHAR(100) NOT NULL COMMENT '战役名称',
                season_id INT NOT NULL COMMENT '赛季ID',
                attacker_sect_id VARCHAR(50) NOT NULL COMMENT '进攻方宗门ID',
                attacker_sect_name VARCHAR(100) NOT NULL COMMENT '进攻方宗门名',
                defender_sect_id VARCHAR(50) NOT NULL COMMENT '防守方宗门ID',
                defender_sect_name VARCHAR(100) NOT NULL COMMENT '防守方宗门名',
                target_territory_id INT NULL COMMENT '争夺的资源点ID（NULL表示纯荣誉战）',
                status VARCHAR(20) NOT NULL DEFAULT 'preparing' COMMENT '状态：preparing/announced/active/settled/cancelled',
                announce_time DATETIME NULL COMMENT '宣战时间',
                prepare_end_time DATETIME NULL COMMENT '准备期结束时间',
                active_start_time DATETIME NULL COMMENT '交战期开始时间',
                active_end_time DATETIME NULL COMMENT '交战期结束时间',
                settle_time DATETIME NULL COMMENT '结算时间',
                winner_sect_id VARCHAR(50) NULL COMMENT '获胜方宗门ID',
                loser_sect_id VARCHAR(50) NULL COMMENT '失败方宗门ID',
                attacker_score INT NOT NULL DEFAULT 0 COMMENT '攻方得分',
                defender_score INT NOT NULL DEFAULT 0 COMMENT '守方得分',
                attacker_kills INT NOT NULL DEFAULT 0 COMMENT '攻方击杀数',
                defender_kills INT NOT NULL DEFAULT 0 COMMENT '守方击杀数',
                attacker_participants INT NOT NULL DEFAULT 0 COMMENT '攻方参战人数',
                defender_participants INT NOT NULL DEFAULT 0 COMMENT '守方参战人数',
                war_chest BIGINT NOT NULL DEFAULT 0 COMMENT '战争赌注（灵石）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_sw_status (status),
                INDEX idx_sw_season (season_id, status),
                INDEX idx_sw_sect (attacker_sect_id, defender_sect_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='宗门战役表'
        `);

        // ===== 2. sect_war_territories 表：资源点表 =====
        await createTableIfNotExists(sequelize, 'sect_war_territories', `
            CREATE TABLE sect_war_territories (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '资源点ID',
                territory_key VARCHAR(50) NOT NULL COMMENT '资源点配置键',
                territory_name VARCHAR(100) NOT NULL COMMENT '资源点名称（如 "青云灵脉"）',
                territory_type VARCHAR(30) NOT NULL COMMENT '资源点类型：spirit_vein/mine/secret_realm/strategic',
                map_x INT NOT NULL COMMENT '地图X坐标',
                map_y INT NOT NULL COMMENT '地图Y坐标',
                owner_sect_id VARCHAR(50) NULL COMMENT '当前占领宗门ID（NULL=无主）',
                owner_sect_name VARCHAR(100) NULL COMMENT '当前占领宗门名',
                owner_since DATETIME NULL COMMENT '占领起始时间',
                defense_level INT NOT NULL DEFAULT 1 COMMENT '驻防等级（1-10）',
                defense_formation VARCHAR(50) NULL COMMENT '驻防阵法ID',
                defender_player_ids LONGTEXT NULL COMMENT '驻防玩家ID列表（JSON数组）',
                daily_production INT NOT NULL DEFAULT 0 COMMENT '每日产出量',
                production_type VARCHAR(30) NOT NULL DEFAULT 'spirit_stones' COMMENT '产出类型：spirit_stones/materials/contribution',
                is_under_attack TINYINT NOT NULL DEFAULT 0 COMMENT '是否正在被攻击（0否1是）',
                last_battle_time DATETIME NULL COMMENT '上次战斗时间',
                season_id INT NOT NULL DEFAULT 0 COMMENT '所属赛季',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_swt_territory_season (territory_key, season_id),
                INDEX idx_swt_owner (owner_sect_id),
                INDEX idx_swt_season (season_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='宗门战资源点表'
        `);

        // ===== 3. sect_war_participants 表：参战记录表 =====
        await createTableIfNotExists(sequelize, 'sect_war_participants', `
            CREATE TABLE sect_war_participants (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                war_id INT NOT NULL COMMENT '战役ID',
                player_id INT NOT NULL COMMENT '玩家ID',
                player_nickname VARCHAR(50) NOT NULL COMMENT '玩家昵称',
                sect_id VARCHAR(50) NOT NULL COMMENT '所属宗门ID',
                sect_name VARCHAR(100) NOT NULL COMMENT '所属宗门名',
                side VARCHAR(10) NOT NULL COMMENT '阵营：attacker/defender',
                kill_count INT NOT NULL DEFAULT 0 COMMENT '击杀数',
                death_count INT NOT NULL DEFAULT 0 COMMENT '死亡数',
                damage_dealt BIGINT NOT NULL DEFAULT 0 COMMENT '造成伤害',
                damage_taken BIGINT NOT NULL DEFAULT 0 COMMENT '承受伤害',
                contribution_score INT NOT NULL DEFAULT 0 COMMENT '贡献分',
                honor_rewarded INT NOT NULL DEFAULT 0 COMMENT '已发放荣誉',
                spirit_stone_rewarded BIGINT NOT NULL DEFAULT 0 COMMENT '已发放灵石',
                is_online TINYINT NOT NULL DEFAULT 0 COMMENT '是否在线参战',
                join_time DATETIME NOT NULL COMMENT '加入时间',
                leave_time DATETIME NULL COMMENT '离开时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_swp_war_player (war_id, player_id),
                INDEX idx_swp_war (war_id),
                INDEX idx_swp_player (player_id),
                INDEX idx_swp_sect (sect_id, war_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='宗门战参战记录表'
        `);

        // ===== 4. sect_war_seasons 表：赛季表 =====
        await createTableIfNotExists(sequelize, 'sect_war_seasons', `
            CREATE TABLE sect_war_seasons (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '赛季ID',
                season_name VARCHAR(100) NOT NULL COMMENT '赛季名称',
                start_date DATE NOT NULL COMMENT '开始日期',
                end_date DATE NOT NULL COMMENT '结束日期',
                status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '状态：pending/active/ended',
                total_wars INT NOT NULL DEFAULT 0 COMMENT '总战役数',
                total_participants INT NOT NULL DEFAULT 0 COMMENT '总参战人数',
                settlement_time DATETIME NULL COMMENT '结算时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_swss_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='宗门战赛季表'
        `);

        // ===== 5. sect_war_season_rankings 表：赛季宗门排行表 =====
        await createTableIfNotExists(sequelize, 'sect_war_season_rankings', `
            CREATE TABLE sect_war_season_rankings (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                season_id INT NOT NULL COMMENT '赛季ID',
                sect_id VARCHAR(50) NOT NULL COMMENT '宗门ID',
                sect_name VARCHAR(100) NOT NULL COMMENT '宗门名',
                total_score INT NOT NULL DEFAULT 0 COMMENT '赛季总积分',
                war_wins INT NOT NULL DEFAULT 0 COMMENT '胜场',
                war_losses INT NOT NULL DEFAULT 0 COMMENT '败场',
                war_draws INT NOT NULL DEFAULT 0 COMMENT '平场',
                territories_held INT NOT NULL DEFAULT 0 COMMENT '当前占领资源点数',
                total_kills INT NOT NULL DEFAULT 0 COMMENT '总击杀',
                total_participants INT NOT NULL DEFAULT 0 COMMENT '总参战人次',
                final_rank INT NULL COMMENT '最终排名',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_swsr_season_sect (season_id, sect_id),
                INDEX idx_swsr_season_score (season_id, total_score DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='宗门战赛季宗门排行表'
        `);

        // ===== 6. sect_funds 表：宗门资金与积分表（动态数据） =====
        // 宗门静态数据（名称/宝库/任务）在 sect_data.json，动态数据（资金/积分）存此表
        await createTableIfNotExists(sequelize, 'sect_funds', `
            CREATE TABLE sect_funds (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                sect_id VARCHAR(50) NOT NULL UNIQUE COMMENT '宗门ID',
                sect_name VARCHAR(100) NOT NULL COMMENT '宗门名',
                fund_balance BIGINT NOT NULL DEFAULT 0 COMMENT '宗门资金（灵石）',
                war_score INT NOT NULL DEFAULT 0 COMMENT '历史总宗门战积分',
                season_war_score INT NOT NULL DEFAULT 0 COMMENT '本赛季宗门战积分',
                territories_count INT NOT NULL DEFAULT 0 COMMENT '当前占领资源点数',
                leader_player_id INT NULL COMMENT '宗主玩家ID',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_sf_war_score (war_score DESC),
                INDEX idx_sf_season_score (season_war_score DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='宗门资金与积分表'
        `);

        console.log('[Migration v0028] 迁移完成：创建 6 张宗门战系统表');
    },

    /**
     * 回滚迁移：删除 6 张表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0028] 开始回滚宗门战系统...');

        // 按依赖关系倒序删除
        const tablesToDrop = [
            'sect_funds',
            'sect_war_season_rankings',
            'sect_war_seasons',
            'sect_war_participants',
            'sect_war_territories',
            'sect_wars'
        ];
        for (const table of tablesToDrop) {
            try {
                await sequelize.query(`DROP TABLE IF EXISTS ${table}`);
                console.log(`  ✓ 删除表: ${table}`);
            } catch (e) {
                console.log(`  - 删除表失败，跳过: ${table}（${e.message}）`);
            }
        }

        console.log('[Migration v0028] 回滚完成');
    }
};

/**
 * 工具函数：检查表是否存在，不存在则创建
 * @param {Object} sequelize - Sequelize 实例
 * @param {string} tableName - 表名
 * @param {string} createSql - CREATE TABLE SQL
 */
async function createTableIfNotExists(sequelize, tableName, createSql) {
    const [tables] = await sequelize.query(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tableName}'
    `);
    if (tables.length === 0) {
        await sequelize.query(createSql);
        console.log(`  ✓ 创建表: ${tableName}`);
    } else {
        console.log(`  - 表已存在，跳过: ${tableName}`);
    }
}
