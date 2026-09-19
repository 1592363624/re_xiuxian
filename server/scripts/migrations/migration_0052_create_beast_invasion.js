/**
 * 数据库迁移脚本
 * 版本: 0052
 * 描述: 妖兽入侵系统（玩法文档第16节 妖兽入侵）
 * 创建时间: 2026-07-21
 *
 * 新建 3 张表：
 *   1. beast_invasions           - 妖兽入侵事件表（HP/阶段/捐献/状态/击杀信息/聚合战报）
 *   2. beast_invasion_donations  - 玩家捐献记录表（物品/数量/贡献值）
 *   3. beast_invasion_attacks    - 玩家攻击记录表（伤害/暴击/反击/HP变化/技能）
 *
 * 设计要点：
 *   - 妖兽 HP 用 BIGINT 防止高境界玩家溢出
 *   - 捐献/攻击记录均建立 (invasion_id, player_id) 复合索引，便于按玩家聚合
 *   - 攻击记录建立 (invasion_id, damage) 索引，便于伤害排行查询
 *   - 攻击记录建立 (invasion_id, created_at) 索引，便于聚合战报按时间窗口查询
 *   - 聚合战报字段使用 LONGTEXT 兜底（MySQL 5.6 原生 JSON 支持有限，Sequelize 会自动序列化）
 *
 * 幂等性：每张表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - 字符集 utf8mb4 保证中文存储
 *   - ENGINE=InnoDB 支持事务与行级锁
 *   - JSON 字段使用 LONGTEXT 兜底
 */

'use strict';

module.exports = {
    description: '妖兽入侵系统：3 张表（事件实例/捐献记录/攻击记录）',
    version: 52,

    /**
     * 执行迁移：创建 3 张新表
     * @param {Object} sequelizeInstance - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;
        console.log('[Migration v0052] 开始创建妖兽入侵系统表...');

        // ===== 1. beast_invasions 表：妖兽入侵事件实例表 =====
        await createTableIfNotExists(sequelize, 'beast_invasions', `
            CREATE TABLE beast_invasions (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '妖兽入侵事件ID',
                beast_key VARCHAR(50) NOT NULL COMMENT '妖兽配置键（如 xuelang_yaoshou/tianhu_yaoshou/kuimu_yaoshou）',
                beast_name VARCHAR(100) NOT NULL COMMENT '妖兽显示名称',
                realm_rank_min INT NOT NULL DEFAULT 1 COMMENT '推荐参与最低境界rank',
                hp_max BIGINT NOT NULL DEFAULT 1000000 COMMENT '妖兽最大血量',
                hp_current BIGINT NOT NULL DEFAULT 1000000 COMMENT '妖兽当前血量',
                atk INT NOT NULL DEFAULT 1000 COMMENT '妖兽攻击力',
                def INT NOT NULL DEFAULT 500 COMMENT '妖兽防御力',
                speed INT NOT NULL DEFAULT 100 COMMENT '妖兽速度',
                phase VARCHAR(20) NOT NULL DEFAULT 'donation' COMMENT '事件阶段：donation/battle/ended',
                donation_target INT NOT NULL DEFAULT 0 COMMENT '捐献目标值（达到后切换战斗阶段）',
                donation_current INT NOT NULL DEFAULT 0 COMMENT '当前捐献累计值',
                status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT '事件状态：active/defeated/escaped/expired',
                start_time DATETIME NOT NULL COMMENT '事件开始时间（捐献阶段开始）',
                donation_end_time DATETIME NULL COMMENT '捐献阶段结束时间',
                battle_end_time DATETIME NULL COMMENT '战斗阶段结束时间',
                defeat_time DATETIME NULL COMMENT '被击杀时间',
                killer_player_id INT NULL COMMENT '最后一击玩家ID',
                killer_nickname VARCHAR(50) NULL COMMENT '最后一击玩家昵称',
                total_damage_taken BIGINT NOT NULL DEFAULT 0 COMMENT '玩家对妖兽造成的总伤害',
                total_damage_dealt BIGINT NOT NULL DEFAULT 0 COMMENT '妖兽对玩家造成的总伤害',
                participant_count INT NOT NULL DEFAULT 0 COMMENT '参与玩家数',
                aggregated_battle_log LONGTEXT NULL COMMENT '聚合战报JSON',
                season_id INT NOT NULL DEFAULT 0 COMMENT '赛季ID（预留）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_beast_invasions_status (status),
                INDEX idx_beast_invasions_phase (phase),
                INDEX idx_beast_invasions_start_time (start_time),
                INDEX idx_beast_invasions_key_season (beast_key, season_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='妖兽入侵事件实例表'
        `);

        // ===== 2. beast_invasion_donations 表：玩家捐献记录表 =====
        await createTableIfNotExists(sequelize, 'beast_invasion_donations', `
            CREATE TABLE beast_invasion_donations (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '捐献记录ID',
                invasion_id INT NOT NULL COMMENT '妖兽入侵事件ID',
                player_id INT NOT NULL COMMENT '玩家ID',
                player_nickname VARCHAR(50) NOT NULL COMMENT '玩家昵称（冗余）',
                item_key VARCHAR(50) NOT NULL COMMENT '捐献物品配置键',
                item_name VARCHAR(100) NOT NULL COMMENT '物品显示名称（冗余）',
                quantity INT NOT NULL DEFAULT 0 COMMENT '本次捐献数量',
                contribution_value INT NOT NULL DEFAULT 0 COMMENT '本次捐献获得的贡献值',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_beast_inv_donations_invasion (invasion_id),
                INDEX idx_beast_inv_donations_player (player_id),
                INDEX idx_beast_inv_donations_invasion_player (invasion_id, player_id),
                INDEX idx_beast_inv_donations_invasion_contrib (invasion_id, contribution_value)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='妖兽入侵玩家捐献记录表'
        `);

        // ===== 3. beast_invasion_attacks 表：玩家攻击记录表 =====
        await createTableIfNotExists(sequelize, 'beast_invasion_attacks', `
            CREATE TABLE beast_invasion_attacks (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '攻击记录ID',
                invasion_id INT NOT NULL COMMENT '妖兽入侵事件ID',
                player_id INT NOT NULL COMMENT '玩家ID',
                player_nickname VARCHAR(50) NOT NULL COMMENT '玩家昵称（冗余）',
                player_realm VARCHAR(50) NOT NULL DEFAULT '凡人' COMMENT '玩家境界（冗余）',
                damage BIGINT NOT NULL DEFAULT 0 COMMENT '本次攻击造成的伤害',
                is_critical TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否暴击',
                counter_damage INT NOT NULL DEFAULT 0 COMMENT '妖兽反击造成的伤害',
                beast_hp_before BIGINT NOT NULL DEFAULT 0 COMMENT '攻击前妖兽HP',
                beast_hp_after BIGINT NOT NULL DEFAULT 0 COMMENT '攻击后妖兽HP',
                skill_used VARCHAR(50) NULL COMMENT '本次使用的技能名',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_beast_inv_attacks_invasion (invasion_id),
                INDEX idx_beast_inv_attacks_player (player_id),
                INDEX idx_beast_inv_attacks_invasion_player (invasion_id, player_id),
                INDEX idx_beast_inv_attacks_invasion_damage (invasion_id, damage),
                INDEX idx_beast_inv_attacks_invasion_time (invasion_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='妖兽入侵玩家攻击记录表'
        `);

        console.log('[Migration v0052] 迁移完成：创建 3 张妖兽入侵系统表');
    },

    /**
     * 回滚迁移：删除 3 张表
     * @param {Object} sequelizeInstance - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;
        console.log('[Migration v0052] 开始回滚妖兽入侵系统...');

        // 按依赖关系倒序删除
        const tablesToDrop = [
            'beast_invasion_attacks',
            'beast_invasion_donations',
            'beast_invasions'
        ];
        for (const table of tablesToDrop) {
            try {
                await sequelize.query(`DROP TABLE IF EXISTS ${table}`);
                console.log(`  ✓ 删除表: ${table}`);
            } catch (e) {
                console.log(`  - 删除表失败，跳过: ${table}（${e.message}）`);
            }
        }

        console.log('[Migration v0052] 回滚完成');
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
