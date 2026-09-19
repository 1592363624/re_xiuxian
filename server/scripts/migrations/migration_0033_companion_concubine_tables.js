/**
 * 数据库迁移脚本
 * 版本: 0033
 * 描述: 道侣/双修/侍妾系统（5 张新表：道侣关系/侍妾/远航/互动日志/心劫事件）
 * 创建时间: 2026-07-20
 *
 * 新建表（按依赖顺序）：
 *   1. dao_companion          - 道侣关系表（1v1 长期社交关系，含心契等级/双修次数/誓言）
 *   2. concubine              - 侍妾表（NPC 角色养成，含魅力/亲密度/忠诚度/觉醒）
 *   3. concubine_voyage       - 侍妾远航记录表（4 种模式：稳妥/均衡/冒险/月殿寻痕）
 *   4. concubine_log          - 侍妾互动日志表（问安/反哺/赠予/觉醒/心劫）
 *   5. heart_tribulation_event - 心劫事件表（心劫/心印/心契，选项：稳/狠/骗）
 *
 * 设计要点：
 *   - dao_companion 表 player_a_id 和 player_b_id 都加 UNIQUE KEY，强制 1v1
 *   - concubine 表 (player_id, concubine_key) 唯一约束，防止同一玩家重复获得同一侍妾
 *   - concubine_voyage 表 status 字段记录远航状态（voyaging/returned/interrupted）
 *   - 互动日志表按 (player_id, created_at) 建复合索引
 *   - 心劫事件表 expires_at 用于事件过期检测
 *   - 文本字段使用 utf8mb4 保证中文与 emoji 存储
 *   - 所有表使用 InnoDB 引擎，支持事务与行级锁
 *
 * 幂等性：每张表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - 字符集 utf8mb4 保证中文存储
 *   - ENGINE=InnoDB 支持事务与行级锁
 *   - JSON 字段使用 LONGTEXT 兜底（MySQL 5.6 无原生 JSON 类型）
 */

module.exports = {
    description: '道侣/双修/侍妾系统：5 张新表（道侣关系/侍妾/远航/互动日志/心劫事件）',
    version: 33,

    /**
     * 执行迁移：创建 5 张道侣/侍妾系统表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0033] 开始创建道侣/侍妾系统表...');

        // ===== 1. dao_companion 表：道侣关系表 =====
        await createTableIfNotExists(sequelize, 'dao_companion', `
            CREATE TABLE dao_companion (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_a_id BIGINT NOT NULL COMMENT '玩家A ID（发起方）',
                player_b_id BIGINT NOT NULL COMMENT '玩家B ID（接受方）',
                relation_state VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '关系状态：pending=待确认，active=已缔结，broken=已解除',
                heart_contract_level INT NOT NULL DEFAULT 0 COMMENT '心契等级（0-5），影响护道/共修加成',
                heart_imprint_count INT NOT NULL DEFAULT 0 COMMENT '已种心印数量',
                dual_cultivation_count_total INT NOT NULL DEFAULT 0 COMMENT '历史双修总次数',
                daily_dual_cultivation_count INT NOT NULL DEFAULT 0 COMMENT '今日双修次数（跨日重置）',
                last_dual_cultivation_date DATE NULL COMMENT '最后双修日期',
                last_dual_cultivation_time DATETIME NULL COMMENT '最后双修时间',
                daily_ask_after_count INT NOT NULL DEFAULT 0 COMMENT '今日问安次数',
                last_ask_after_date DATE NULL COMMENT '最后问安日期',
                vow_type VARCHAR(20) NULL COMMENT '立誓类型：protect/secret/cultivate',
                vow_expire_time DATETIME NULL COMMENT '誓言到期时间',
                vow_broken TINYINT NOT NULL DEFAULT 0 COMMENT '是否毁誓',
                heart_tribulation_count INT NOT NULL DEFAULT 0 COMMENT '心劫触发次数',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '缔结时间',
                broken_at DATETIME NULL COMMENT '解除时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_dc_player_a (player_a_id),
                UNIQUE KEY uk_dc_player_b (player_b_id),
                INDEX idx_dc_state (relation_state),
                INDEX idx_dc_pair (player_a_id, player_b_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='道侣关系表'
        `);

        // ===== 2. concubine 表：侍妾表 =====
        await createTableIfNotExists(sequelize, 'concubine', `
            CREATE TABLE concubine (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '所属玩家ID',
                concubine_key VARCHAR(50) NOT NULL COMMENT '侍妾配置键（如 nangong_wan）',
                concubine_name VARCHAR(50) NOT NULL COMMENT '侍妾名',
                concubine_type VARCHAR(20) NOT NULL DEFAULT 'normal' COMMENT '侍妾类型：normal/awakened（觉醒）/immortal（仙子）',
                realm_rank INT NOT NULL DEFAULT 1 COMMENT '侍妾境界rank',
                exp BIGINT NOT NULL DEFAULT 0 COMMENT '侍妾修为',
                charm INT NOT NULL DEFAULT 50 COMMENT '魅力值（0-100）',
                intimacy INT NOT NULL DEFAULT 0 COMMENT '亲密度（0-100）',
                loyalty INT NOT NULL DEFAULT 80 COMMENT '忠诚度（0-100，低于30触发逃跑）',
                talent_id VARCHAR(50) NULL COMMENT '天赋ID',
                attributes TEXT NULL COMMENT '属性JSON（atk/def/hp_max/support_bonus）',
                is_placed TINYINT NOT NULL DEFAULT 0 COMMENT '是否安置中（0否1是）',
                placement_location VARCHAR(50) NULL COMMENT '安置地点（洞府房间名）',
                is_voyaging TINYINT NOT NULL DEFAULT 0 COMMENT '是否远航中',
                voyage_id BIGINT NULL COMMENT '当前远航记录ID',
                awakened_form VARCHAR(50) NULL COMMENT '觉醒形态（如 nangong_wan_moon_shadow）',
                daily_ask_after_count INT NOT NULL DEFAULT 0 COMMENT '今日问安次数',
                last_ask_after_date DATE NULL COMMENT '最后问安日期',
                last_ask_after_time DATETIME NULL COMMENT '最后问安时间',
                last_backfeed_time DATETIME NULL COMMENT '最后灵力反哺时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '获得时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_con_player_key (player_id, concubine_key),
                INDEX idx_con_player (player_id),
                INDEX idx_con_voyaging (is_voyaging),
                INDEX idx_con_type (concubine_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='侍妾表'
        `);

        // ===== 3. concubine_voyage 表：侍妾远航记录表 =====
        await createTableIfNotExists(sequelize, 'concubine_voyage', `
            CREATE TABLE concubine_voyage (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                concubine_id BIGINT NOT NULL COMMENT '侍妾ID',
                voyage_mode VARCHAR(20) NOT NULL COMMENT '远航模式：safe/balanced/risky/moon_palace',
                started_at DATETIME NOT NULL COMMENT '开始时间',
                expected_end_time DATETIME NOT NULL COMMENT '预计归来时间',
                actual_end_time DATETIME NULL COMMENT '实际归来时间',
                status VARCHAR(20) NOT NULL DEFAULT 'voyaging' COMMENT '状态：voyaging=远航中，returned=已归来，interrupted=被打断',
                rewards TEXT NULL COMMENT '奖励JSON（待领取）',
                risk_modifier FLOAT NOT NULL DEFAULT 1.0 COMMENT '风险系数（safe=0.5，balanced=1.0，risky=1.5，moon_palace=2.0）',
                reward_multiplier FLOAT NOT NULL DEFAULT 1.0 COMMENT '收益系数（safe=0.6，balanced=1.0，risky=1.8，moon_palace=3.0）',
                is_collected TINYINT NOT NULL DEFAULT 0 COMMENT '奖励是否已领取',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_cv_player_status (player_id, status),
                INDEX idx_cv_end_time (expected_end_time),
                INDEX idx_cv_concubine (concubine_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='侍妾远航记录表'
        `);

        // ===== 4. concubine_log 表：侍妾互动日志表 =====
        await createTableIfNotExists(sequelize, 'concubine_log', `
            CREATE TABLE concubine_log (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                concubine_id BIGINT NOT NULL COMMENT '侍妾ID',
                action_type VARCHAR(30) NOT NULL COMMENT '互动类型：ask_after/backfeed/gift/awaken/heart_tribulation',
                action_detail TEXT NULL COMMENT '互动详情JSON',
                charm_change INT NOT NULL DEFAULT 0 COMMENT '魅力变化',
                intimacy_change INT NOT NULL DEFAULT 0 COMMENT '亲密度变化',
                loyalty_change INT NOT NULL DEFAULT 0 COMMENT '忠诚度变化',
                exp_change BIGINT NOT NULL DEFAULT 0 COMMENT '修为变化',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                INDEX idx_cl_player_time (player_id, created_at),
                INDEX idx_cl_concubine (concubine_id),
                INDEX idx_cl_action (action_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='侍妾互动日志表'
        `);

        // ===== 5. heart_tribulation_event 表：心劫事件表 =====
        await createTableIfNotExists(sequelize, 'heart_tribulation_event', `
            CREATE TABLE heart_tribulation_event (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                companion_id BIGINT NULL COMMENT '关联道侣关系ID',
                concubine_id BIGINT NULL COMMENT '关联侍妾ID',
                event_type VARCHAR(30) NOT NULL COMMENT '事件类型：heart_tribulation/heart_imprint/heart_contract',
                event_state VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '事件状态：pending/resolved/failed',
                options TEXT NOT NULL COMMENT '可选选项JSON（如稳/狠/骗）',
                chosen_option VARCHAR(30) NULL COMMENT '玩家选择的选项',
                reward TEXT NULL COMMENT '结算奖励JSON',
                penalty TEXT NULL COMMENT '惩罚JSON',
                expires_at DATETIME NOT NULL COMMENT '事件过期时间',
                resolved_at DATETIME NULL COMMENT '解决时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_hte_player_state (player_id, event_state),
                INDEX idx_hte_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='心劫/心印/心契事件表'
        `);

        console.log('[Migration v0033] 迁移完成：创建 5 张道侣/侍妾系统表');
    },

    /**
     * 回滚迁移：删除 5 张表（按依赖关系倒序）
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0033] 开始回滚道侣/侍妾系统表...');

        // 按依赖关系倒序删除（事件/日志/远航 → 主表）
        const tablesToDrop = [
            'heart_tribulation_event',
            'concubine_log',
            'concubine_voyage',
            'concubine',
            'dao_companion'
        ];
        for (const table of tablesToDrop) {
            try {
                await sequelize.query(`DROP TABLE IF EXISTS ${table}`);
                console.log(`  ✓ 删除表: ${table}`);
            } catch (e) {
                console.log(`  - 删除表失败，跳过: ${table}（${e.message}）`);
            }
        }

        console.log('[Migration v0033] 回滚完成');
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
