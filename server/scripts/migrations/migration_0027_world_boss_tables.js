/**
 * 数据库迁移脚本
 * 版本: 0027
 * 描述: 世界BOSS系统（4 张新表）
 * 创建时间: 2026-07-19
 *
 * 新建表：
 *   1. world_bosses                 - BOSS 实例表（当前HP/阶段/状态）
 *   2. world_boss_damage_records    - 玩家对 BOSS 的伤害记录（用于排行）
 *   3. world_boss_season_rankings   - 赛季个人排行表
 *   4. world_boss_seasons           - 赛季配置表
 *
 * 设计要点：
 *   - BOSS HP 用 BIGINT 防止高境界玩家溢出
 *   - damage_records 用 (boss_id, player_id) 唯一键防止重复
 *   - season_rankings 用 (season_id, player_id) 唯一键
 *   - 排行榜查询走 (boss_id, total_damage DESC) 索引，避免全表扫描
 *
 * 幂等性：每张表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - 字符集 utf8mb4 保证中文存储
 *   - ENGINE=InnoDB 支持事务与行级锁
 *   - JSON 字段使用 LONGTEXT 兜底（MySQL 5.6 原生 JSON 支持有限）
 */

module.exports = {
    description: '世界BOSS系统：4 张表（BOSS实例/伤害记录/赛季排行/赛季配置）',
    version: 27,

    /**
     * 执行迁移：创建 4 张新表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0027] 开始创建世界BOSS系统表...');

        // ===== 1. world_bosses 表：BOSS 实例表 =====
        await createTableIfNotExists(sequelize, 'world_bosses', `
            CREATE TABLE world_bosses (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT 'BOSS实例ID',
                boss_key VARCHAR(50) NOT NULL COMMENT 'BOSS配置键（如 qingyuanzi/yaoshou/mulan）',
                boss_name VARCHAR(100) NOT NULL COMMENT 'BOSS显示名称',
                realm_rank_min INT NOT NULL COMMENT '推荐参与最低境界rank',
                hp_max BIGINT NOT NULL DEFAULT 1000000 COMMENT 'BOSS最大血量',
                hp_current BIGINT NOT NULL DEFAULT 1000000 COMMENT 'BOSS当前血量',
                atk INT NOT NULL DEFAULT 1000 COMMENT 'BOSS攻击力',
                def INT NOT NULL DEFAULT 500 COMMENT 'BOSS防御力',
                speed INT NOT NULL DEFAULT 100 COMMENT 'BOSS速度',
                phase INT NOT NULL DEFAULT 1 COMMENT '当前阶段（1/2/3）',
                status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'BOSS状态：pending/active/defeated/expired',
                spawn_time DATETIME NOT NULL COMMENT '刷新时间',
                active_start_time DATETIME NULL COMMENT '激活开始时间（首次被攻击时）',
                defeat_time DATETIME NULL COMMENT '被击杀时间',
                expire_time DATETIME NOT NULL COMMENT '过期时间（未击杀则消失）',
                season_id INT NOT NULL DEFAULT 0 COMMENT '赛季ID（每赛季重置）',
                total_damage_dealt BIGINT NOT NULL DEFAULT 0 COMMENT 'BOSS对玩家造成的总伤害',
                total_damage_taken BIGINT NOT NULL DEFAULT 0 COMMENT '玩家对BOSS造成的总伤害',
                participant_count INT NOT NULL DEFAULT 0 COMMENT '参与玩家数',
                killer_player_id INT NULL COMMENT '最后一击玩家ID',
                killer_nickname VARCHAR(50) NULL COMMENT '最后一击玩家昵称',
                first_kill_server TINYINT NOT NULL DEFAULT 0 COMMENT '是否全服首杀（0否1是）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_world_bosses_status (status),
                INDEX idx_world_bosses_spawn_time (spawn_time),
                INDEX idx_world_bosses_boss_key_season (boss_key, season_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='世界BOSS实例表'
        `);

        // ===== 2. world_boss_damage_records 表：玩家伤害记录表 =====
        await createTableIfNotExists(sequelize, 'world_boss_damage_records', `
            CREATE TABLE world_boss_damage_records (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                boss_id INT NOT NULL COMMENT 'BOSS实例ID',
                player_id INT NOT NULL COMMENT '玩家ID',
                player_nickname VARCHAR(50) NOT NULL COMMENT '玩家昵称（冗余存储便于排行查询）',
                player_realm VARCHAR(30) NOT NULL COMMENT '玩家境界（冗余存储）',
                sect_id VARCHAR(50) NULL COMMENT '玩家所属宗门ID',
                sect_name VARCHAR(100) NULL COMMENT '玩家所属宗门名（冗余）',
                total_damage BIGINT NOT NULL DEFAULT 0 COMMENT '累计伤害',
                damage_count INT NOT NULL DEFAULT 0 COMMENT '攻击次数',
                death_count INT NOT NULL DEFAULT 0 COMMENT '被BOSS击杀次数',
                revive_count INT NOT NULL DEFAULT 0 COMMENT '复活次数',
                best_single_damage BIGINT NOT NULL DEFAULT 0 COMMENT '单次最高伤害',
                first_attack_time DATETIME NULL COMMENT '首次攻击时间',
                last_attack_time DATETIME NULL COMMENT '最后攻击时间',
                is_participant TINYINT NOT NULL DEFAULT 1 COMMENT '是否算作参与（伤害>0）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_wbdr_boss_player (boss_id, player_id),
                INDEX idx_wbdr_boss_damage (boss_id, total_damage DESC),
                INDEX idx_wbdr_player (player_id),
                INDEX idx_wbdr_sect (sect_id, boss_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='世界BOSS玩家伤害记录表'
        `);

        // ===== 3. world_boss_season_rankings 表：赛季个人排行表 =====
        await createTableIfNotExists(sequelize, 'world_boss_season_rankings', `
            CREATE TABLE world_boss_season_rankings (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                season_id INT NOT NULL COMMENT '赛季ID',
                player_id INT NOT NULL COMMENT '玩家ID',
                player_nickname VARCHAR(50) NOT NULL COMMENT '玩家昵称',
                sect_id VARCHAR(50) NULL COMMENT '宗门ID',
                sect_name VARCHAR(100) NULL COMMENT '宗门名',
                total_damage BIGINT NOT NULL DEFAULT 0 COMMENT '赛季累计伤害',
                boss_kill_count INT NOT NULL DEFAULT 0 COMMENT '赛季参与击杀BOSS数',
                first_kill_count INT NOT NULL DEFAULT 0 COMMENT '赛季首杀次数',
                best_rank INT NOT NULL DEFAULT 999999 COMMENT '历史最佳单次排名',
                last_rank INT NOT NULL DEFAULT 999999 COMMENT '最近一次排名',
                honor_rewarded INT NOT NULL DEFAULT 0 COMMENT '已发放荣誉值',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_wbsr_season_player (season_id, player_id),
                INDEX idx_wbsr_season_damage (season_id, total_damage DESC),
                INDEX idx_wbsr_season_sect (season_id, sect_id, total_damage DESC)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='世界BOSS赛季个人排行表'
        `);

        // ===== 4. world_boss_seasons 表：赛季配置表 =====
        await createTableIfNotExists(sequelize, 'world_boss_seasons', `
            CREATE TABLE world_boss_seasons (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '赛季ID',
                season_name VARCHAR(100) NOT NULL COMMENT '赛季名称（如 "甲辰年夏季赛"）',
                start_date DATE NOT NULL COMMENT '赛季开始日期',
                end_date DATE NOT NULL COMMENT '赛季结束日期',
                status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '状态：pending/active/ended',
                total_bosses_killed INT NOT NULL DEFAULT 0 COMMENT '本赛季击杀BOSS总数',
                total_damage_dealt BIGINT NOT NULL DEFAULT 0 COMMENT '本赛季总伤害',
                settlement_time DATETIME NULL COMMENT '结算时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_wbss_status (status),
                INDEX idx_wbss_dates (start_date, end_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='世界BOSS赛季配置表'
        `);

        console.log('[Migration v0027] 迁移完成：创建 4 张世界BOSS系统表');
    },

    /**
     * 回滚迁移：删除 4 张表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0027] 开始回滚世界BOSS系统...');

        // 按依赖关系倒序删除
        const tablesToDrop = [
            'world_boss_seasons',
            'world_boss_season_rankings',
            'world_boss_damage_records',
            'world_bosses'
        ];
        for (const table of tablesToDrop) {
            try {
                await sequelize.query(`DROP TABLE IF EXISTS ${table}`);
                console.log(`  ✓ 删除表: ${table}`);
            } catch (e) {
                console.log(`  - 删除表失败，跳过: ${table}（${e.message}）`);
            }
        }

        console.log('[Migration v0027] 回滚完成');
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
