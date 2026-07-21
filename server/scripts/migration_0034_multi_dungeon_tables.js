/**
 * 数据库迁移脚本
 * 版本: 0034
 * 描述: 多人副本系统（4 张新表：实例/成员/抉择记录/冷却）
 * 创建时间: 2026-07-20
 *
 * 新建表（按依赖顺序）：
 *   1. multi_dungeon_instance  - 多人副本实例表（含状态机、变量、奖励标志、冷却时间）
 *   2. multi_dungeon_member    - 副本成员表（含贡献度、HP、投粽数量、个人冷却）
 *   3. multi_dungeon_choice    - 副本抉择记录表（每幕抉择的变量变化审计）
 *   4. multi_dungeon_cooldown  - 副本冷却表（玩家×副本键粒度的冷却记录）
 *
 * 设计要点：
 *   - multi_dungeon_instance 包含完整状态机字段（preparing/active/cleared/failed/dissolved）
 *   - 4 个变量字段：morale(士气) / vigilance(警戒) / demon_corruption(魔染) / seal_stability(封印)
 *   - harvest_multiplier 为 FLOAT，受抉择影响累加
 *   - multi_dungeon_member 的 (instance_id, player_id) 复合 UNIQUE，防重复加入
 *   - multi_dungeon_choice 记录每次抉择的变量变化，便于审计与回放
 *   - multi_dungeon_cooldown 按 (player_id, dungeon_key) 索引，支持快速查询冷却状态
 *   - 所有表 InnoDB + utf8mb4，支持事务与行级锁，中文存储无障碍
 *
 * 幂等性：每张表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - 无 JSON 类型字段（变量字段均为 INT/FLOAT，配置类字段 TEXT 兜底）
 *   - 字符集 utf8mb4 保证中文与特殊符号存储
 *   - ENGINE=InnoDB 支持事务与行级锁
 */

module.exports = {
    description: '多人副本系统：4 张新表（实例/成员/抉择记录/冷却）',
    version: 34,

    /**
     * 执行迁移：创建 4 张多人副本系统表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0034] 开始创建多人副本系统表...');

        // ===== 1. multi_dungeon_instance 表：多人副本实例表 =====
        await createTableIfNotExists(sequelize, 'multi_dungeon_instance', `
            CREATE TABLE multi_dungeon_instance (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '副本实例ID',
                instance_key VARCHAR(30) NOT NULL COMMENT '副本配置键：yanyue/duanwu',
                instance_name VARCHAR(100) NOT NULL COMMENT '副本显示名',
                leader_player_id BIGINT NOT NULL COMMENT '队长玩家ID',
                leader_nickname VARCHAR(50) NOT NULL COMMENT '队长昵称（冗余）',
                current_act INT NOT NULL DEFAULT 1 COMMENT '当前幕数（掩月1-6，端午1-4）',
                current_act_state VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '当前幕状态：pending/active/resolved/failed',
                instance_state VARCHAR(20) NOT NULL DEFAULT 'preparing' COMMENT '副本状态：preparing/active/cleared/failed/dissolved',
                member_count INT NOT NULL DEFAULT 0 COMMENT '当前成员数',
                member_max INT NOT NULL COMMENT '成员上限（掩月5，端午10）',
                member_min INT NOT NULL COMMENT '成员下限（掩月3，端午10）',
                consume_item_key VARCHAR(50) NULL COMMENT '消耗物品键（掩月=hongling_wedding_invitation）',
                consume_item_count INT NOT NULL DEFAULT 0 COMMENT '消耗数量',
                morale INT NOT NULL DEFAULT 100 COMMENT '队伍士气（0-100，影响战斗）',
                vigilance INT NOT NULL DEFAULT 0 COMMENT '敌方警戒度（0-100，越高越难）',
                demon_corruption INT NOT NULL DEFAULT 0 COMMENT '魔染值（血魔剑相关，0-100）',
                seal_stability INT NOT NULL DEFAULT 100 COMMENT '封印稳定度（端午用，0-100）',
                soul_stability INT NOT NULL DEFAULT 100 COMMENT '神魂稳定度（0-100）',
                harvest_multiplier FLOAT NOT NULL DEFAULT 1.0 COMMENT '收获倍率（受抉择影响）',
                first_clear TINYINT NOT NULL DEFAULT 0 COMMENT '是否首通（0否1是）',
                started_at DATETIME NULL COMMENT '开打时间',
                cleared_at DATETIME NULL COMMENT '通关时间',
                dissolved_at DATETIME NULL COMMENT '解散时间',
                expire_at DATETIME NOT NULL COMMENT '副本过期时间',
                cooldown_hours INT NOT NULL DEFAULT 0 COMMENT '通关后冷却小时数',
                cooldown_until DATETIME NULL COMMENT '全员冷却到期时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_mdi_state (instance_state),
                INDEX idx_mdi_leader (leader_player_id),
                INDEX idx_mdi_key_state (instance_key, instance_state),
                INDEX idx_mdi_expire (expire_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多人副本实例表'
        `);

        // ===== 2. multi_dungeon_member 表：副本成员表 =====
        await createTableIfNotExists(sequelize, 'multi_dungeon_member', `
            CREATE TABLE multi_dungeon_member (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                instance_id BIGINT NOT NULL COMMENT '副本实例ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                player_nickname VARCHAR(50) NOT NULL COMMENT '玩家昵称（冗余）',
                player_realm VARCHAR(30) NOT NULL COMMENT '玩家境界（冗余）',
                player_realm_rank INT NOT NULL COMMENT '玩家境界rank',
                role VARCHAR(20) NOT NULL DEFAULT 'member' COMMENT '成员角色：leader/member',
                join_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '加入时间',
                is_ready TINYINT NOT NULL DEFAULT 0 COMMENT '是否已准备（0否1是）',
                is_present TINYINT NOT NULL DEFAULT 1 COMMENT '是否在场（0离线1在场）',
                contribution INT NOT NULL DEFAULT 0 COMMENT '本副本贡献度',
                hp_remaining BIGINT NOT NULL DEFAULT 0 COMMENT '剩余HP（副本内）',
                zongzi_invested INT NOT NULL DEFAULT 0 COMMENT '已投粽数量（端午用）',
                cooldown_end_time DATETIME NULL COMMENT '个人冷却到期时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_mdm_instance (instance_id),
                INDEX idx_mdm_player (player_id),
                UNIQUE KEY uk_mdm_instance_player (instance_id, player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多人副本成员表'
        `);

        // ===== 3. multi_dungeon_choice 表：副本抉择记录表 =====
        await createTableIfNotExists(sequelize, 'multi_dungeon_choice', `
            CREATE TABLE multi_dungeon_choice (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                instance_id BIGINT NOT NULL COMMENT '副本实例ID',
                act_number INT NOT NULL COMMENT '幕数（1-6）',
                act_name VARCHAR(50) NOT NULL COMMENT '幕名（如「潜踪」「婚仪」）',
                choice_key VARCHAR(50) NOT NULL COMMENT '抉择键（如 stealth_open_distraction）',
                choice_text VARCHAR(200) NOT NULL COMMENT '抉择描述',
                chosen_option VARCHAR(50) NOT NULL COMMENT '选定选项',
                chosen_by BIGINT NOT NULL COMMENT '抉择人ID（队长）',
                chosen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '抉择时间',
                morale_change INT NOT NULL DEFAULT 0 COMMENT '士气变化',
                vigilance_change INT NOT NULL DEFAULT 0 COMMENT '警戒变化',
                demon_corruption_change INT NOT NULL DEFAULT 0 COMMENT '魔染变化',
                seal_stability_change INT NOT NULL DEFAULT 0 COMMENT '封印变化',
                harvest_multiplier_change FLOAT NOT NULL DEFAULT 0 COMMENT '收获倍率变化',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_mdc_instance_act (instance_id, act_number),
                INDEX idx_mdc_chosen_by (chosen_by)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多人副本抉择记录表'
        `);

        // ===== 4. multi_dungeon_cooldown 表：副本冷却表 =====
        await createTableIfNotExists(sequelize, 'multi_dungeon_cooldown', `
            CREATE TABLE multi_dungeon_cooldown (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                dungeon_key VARCHAR(30) NOT NULL COMMENT '副本键：yanyue/duanwu',
                instance_id BIGINT NULL COMMENT '关联副本实例ID',
                cooldown_hours INT NOT NULL COMMENT '冷却小时数',
                cooldown_start_time DATETIME NOT NULL COMMENT '冷却开始时间',
                cooldown_end_time DATETIME NOT NULL COMMENT '冷却到期时间',
                reason VARCHAR(50) NOT NULL COMMENT '冷却原因：cleared/failed/penalty',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_mdc_player_dungeon (player_id, dungeon_key),
                INDEX idx_mdc_end_time (cooldown_end_time)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='多人副本冷却表'
        `);

        console.log('[Migration v0034] 迁移完成：创建 4 张多人副本系统表');
    },

    /**
     * 回滚迁移：删除 4 张表（按依赖关系倒序）
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0034] 开始回滚多人副本系统表...');

        // 按依赖关系倒序删除（冷却/抉择/成员 → 实例）
        const tablesToDrop = [
            'multi_dungeon_cooldown',
            'multi_dungeon_choice',
            'multi_dungeon_member',
            'multi_dungeon_instance'
        ];
        for (const table of tablesToDrop) {
            try {
                await sequelize.query(`DROP TABLE IF EXISTS ${table}`);
                console.log(`  ✓ 删除表: ${table}`);
            } catch (e) {
                console.log(`  - 删除表失败，跳过: ${table}（${e.message}）`);
            }
        }

        console.log('[Migration v0034] 回滚完成');
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
