/**
 * 数据库迁移脚本
 * 版本: 0032
 * 描述: 后期系统（8 张新表：第二元神/元神残篇/小世界/神庙/香火流水/神识/法则/法则碎片流水）
 * 创建时间: 2026-07-20
 *
 * 新建表（按依赖顺序）：
 *   1. player_second_soul     - 玩家第二元神表（主元神+副元神，调度模式/独立修炼）
 *   2. player_soul_fragment   - 玩家元神残篇记录表（凝练第二元神的 5 类材料流水）
 *   3. player_small_world     - 玩家小世界表（人口/信仰/稳定度/香火产出）
 *   4. player_divine_temple   - 玩家神庙表（10 级升级/护界禁制/供奉兑换池）
 *   5. player_incense_log     - 香火流水记录表（收割/神迹/淬炼/显灵/兑换）
 *   6. player_divine_sense    - 玩家神识表（上限/当前/恢复速率/累计淬炼/消耗）
 *   7. player_law             - 玩家法则表（法则点/5 类法则碎片存量）
 *   8. player_law_fragment    - 法则碎片流水表（碎片获取/消耗审计）
 *
 * 设计要点：
 *   - second_soul 表 (player_id, soul_index) 唯一约束，防止同一玩家重复元神序号
 *   - small_world 与 divine_temple 表 player_id 唯一约束，1:1 关系
 *   - divine_sense 与 law 表 player_id 唯一约束，1:1 关系
 *   - 流水表（incense_log/law_fragment/soul_fragment）按 (player_id, created_at) 建复合索引
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
    description: '后期系统：8 张新表（第二元神/元神残篇/小世界/神庙/香火流水/神识/法则/法则碎片流水）',
    version: 32,

    /**
     * 执行迁移：创建 8 张后期系统表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0032] 开始创建后期系统表...');

        // ===== 1. player_second_soul 表：玩家第二元神表 =====
        await createTableIfNotExists(sequelize, 'player_second_soul', `
            CREATE TABLE player_second_soul (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '所属玩家ID',
                soul_index INT NOT NULL COMMENT '元神序号（1=第一元神/主，2=第二元神，3=第三元神）',
                soul_name VARCHAR(50) NOT NULL COMMENT '元神名称（玩家自定义）',
                soul_type VARCHAR(20) NOT NULL DEFAULT 'normal' COMMENT '元神类型：normal=普通，magic=魔元神（五子同心魔线）',
                realm VARCHAR(30) NOT NULL COMMENT '元神境界',
                realm_rank INT NOT NULL COMMENT '元神境界rank',
                exp BIGINT NOT NULL DEFAULT 0 COMMENT '元神修为',
                attributes TEXT NOT NULL COMMENT '元神属性JSON（atk/def/hp_max/speed/sense）',
                inherit_ratio FLOAT NOT NULL DEFAULT 0.6 COMMENT '主元神属性继承比例',
                is_active TINYINT NOT NULL DEFAULT 0 COMMENT '是否当前激活（0否1是，同时只能激活一个）',
                is_cultivating TINYINT NOT NULL DEFAULT 0 COMMENT '是否在独立修炼（独立挂机成长）',
                cultivate_started_at DATETIME NULL COMMENT '开始修炼时间',
                cultivate_end_time DATETIME NULL COMMENT '预计结束时间',
                last_dispatch_mode VARCHAR(20) NULL COMMENT '上次调度模式：combat/cultivate/scout/defend',
                dispatch_until DATETIME NULL COMMENT '调度结束时间',
                combat_count INT NOT NULL DEFAULT 0 COMMENT '历史参战次数',
                cultivate_count INT NOT NULL DEFAULT 0 COMMENT '历史独立修炼次数',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_pss_player_index (player_id, soul_index),
                INDEX idx_pss_player_active (player_id, is_active),
                INDEX idx_pss_dispatch (dispatch_until)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家第二元神表'
        `);

        // ===== 2. player_soul_fragment 表：玩家元神残篇记录表 =====
        await createTableIfNotExists(sequelize, 'player_soul_fragment', `
            CREATE TABLE player_soul_fragment (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                fragment_type VARCHAR(30) NOT NULL COMMENT '残篇类型：ning_shi/fen_nian/kong_gui/qian_ji/yan_shen',
                fragment_name VARCHAR(50) NOT NULL COMMENT '残篇名（凝识残篇/分念残篇/控傀残篇/千机残篇/衍神残篇）',
                source VARCHAR(50) NOT NULL COMMENT '获取来源：ldc_shop/kunwu_mountain/cangkun_dungeon/qingyuanzi_boss',
                count INT NOT NULL DEFAULT 1 COMMENT '数量',
                obtained_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '获取时间',
                INDEX idx_psf_player_type (player_id, fragment_type),
                INDEX idx_psf_obtained (obtained_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家元神残篇记录表'
        `);

        // ===== 3. player_small_world 表：玩家小世界表 =====
        await createTableIfNotExists(sequelize, 'player_small_world', `
            CREATE TABLE player_small_world (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '所属玩家ID',
                world_name VARCHAR(50) NOT NULL COMMENT '小世界名称（玩家自定义）',
                world_level INT NOT NULL DEFAULT 1 COMMENT '小世界等级（1-10）',
                world_type VARCHAR(20) NOT NULL DEFAULT 'mortal' COMMENT '世界类型：mortal=凡人界，spirit=灵界',
                population INT NOT NULL DEFAULT 100 COMMENT '当前人口',
                population_max INT NOT NULL DEFAULT 1000 COMMENT '人口上限（受等级影响）',
                faith INT NOT NULL DEFAULT 0 COMMENT '信仰值（0-10000）',
                faith_max INT NOT NULL DEFAULT 10000 COMMENT '信仰上限',
                stability INT NOT NULL DEFAULT 100 COMMENT '稳定度（0-100，低于30触发灾变）',
                incense_production_rate INT NOT NULL DEFAULT 10 COMMENT '香火产出速率（每小时）',
                last_incense_harvest_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上次收割香火时间',
                temple_id BIGINT NULL COMMENT '关联的神庙ID',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_psw_player (player_id),
                INDEX idx_psw_level (world_level)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家小世界表'
        `);

        // ===== 4. player_divine_temple 表：玩家神庙表 =====
        await createTableIfNotExists(sequelize, 'player_divine_temple', `
            CREATE TABLE player_divine_temple (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '所属玩家ID',
                small_world_id BIGINT NOT NULL COMMENT '所属小世界ID',
                temple_level INT NOT NULL DEFAULT 1 COMMENT '神庙等级（1-10）',
                temple_name VARCHAR(50) NOT NULL DEFAULT '神庙' COMMENT '神庙名称',
                defense_power INT NOT NULL DEFAULT 100 COMMENT '护界禁制强度（0-10000）',
                defense_max INT NOT NULL DEFAULT 1000 COMMENT '护界禁制上限',
                offering_pool TEXT NULL COMMENT '供奉兑换池JSON（记录已解锁供奉项）',
                last_upgrade_time DATETIME NULL COMMENT '最后升级时间',
                last_defense_repair_time DATETIME NULL COMMENT '最后禁制修复时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_pdt_player (player_id),
                INDEX uk_pdt_world (small_world_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家神庙表'
        `);

        // ===== 5. player_incense_log 表：香火流水记录表 =====
        await createTableIfNotExists(sequelize, 'player_incense_log', `
            CREATE TABLE player_incense_log (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                change_type VARCHAR(30) NOT NULL COMMENT '变动类型：harvest/temple_upgrade/divine_miracle/quench/manifest/offering_exchange/gm_grant',
                change_amount INT NOT NULL COMMENT '变动数量（正数+，负数-）',
                balance_after INT NOT NULL COMMENT '变动后余额',
                reason VARCHAR(200) NULL COMMENT '变动原因描述',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                INDEX idx_pil_player_time (player_id, created_at),
                INDEX idx_pil_type (change_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='香火流水记录表'
        `);

        // ===== 6. player_divine_sense 表：玩家神识表 =====
        await createTableIfNotExists(sequelize, 'player_divine_sense', `
            CREATE TABLE player_divine_sense (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                divine_sense_max INT NOT NULL DEFAULT 100 COMMENT '神识上限（受境界/大衍诀影响）',
                divine_sense_current INT NOT NULL DEFAULT 100 COMMENT '当前神识',
                regen_rate_per_hour INT NOT NULL DEFAULT 10 COMMENT '每小时自然恢复量',
                last_regen_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最后恢复时间',
                last_quench_time DATETIME NULL COMMENT '最后淬炼时间（CD 计算）',
                daily_quench_count INT NOT NULL DEFAULT 0 COMMENT '今日淬炼次数（跨日重置）',
                last_quench_date DATE NULL COMMENT '最后淬炼日期（跨日重置）',
                total_quenched INT NOT NULL DEFAULT 0 COMMENT '历史累计淬炼获得神识',
                total_consumed INT NOT NULL DEFAULT 0 COMMENT '历史累计消耗神识',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_pds_player (player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家神识表'
        `);

        // ===== 7. player_law 表：玩家法则表 =====
        await createTableIfNotExists(sequelize, 'player_law', `
            CREATE TABLE player_law (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                law_points INT NOT NULL DEFAULT 0 COMMENT '法则点数（用于法则转换）',
                total_earned INT NOT NULL DEFAULT 0 COMMENT '历史累计获得法则点',
                total_spent INT NOT NULL DEFAULT 0 COMMENT '历史累计消耗法则点',
                daily_earned INT NOT NULL DEFAULT 0 COMMENT '今日已获得法则点（跨日重置）',
                last_earn_date DATE NULL COMMENT '最后获得日期（跨日重置）',
                law_fragments_space INT NOT NULL DEFAULT 0 COMMENT '空间法则碎片',
                law_fragments_time INT NOT NULL DEFAULT 0 COMMENT '时间法则碎片',
                law_fragments_five_elements INT NOT NULL DEFAULT 0 COMMENT '五行法则碎片',
                law_fragments_soul INT NOT NULL DEFAULT 0 COMMENT '魂之法则碎片',
                law_fragments_karma INT NOT NULL DEFAULT 0 COMMENT '因果法则碎片',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_pl_player (player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家法则表'
        `);

        // ===== 8. player_law_fragment 表：法则碎片流水表 =====
        await createTableIfNotExists(sequelize, 'player_law_fragment', `
            CREATE TABLE player_law_fragment (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                fragment_type VARCHAR(30) NOT NULL COMMENT '碎片类型：space/time/five_elements/soul/karma',
                change_amount INT NOT NULL COMMENT '变动数量（正数+，负数-）',
                source VARCHAR(50) NOT NULL COMMENT '来源：fracture_explore/world_boss/dungeon/law_convert/gm_grant',
                balance_after INT NOT NULL COMMENT '变动后余额',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                INDEX idx_plf_player_time (player_id, created_at),
                INDEX idx_plf_type (fragment_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='法则碎片流水表'
        `);

        console.log('[Migration v0032] 迁移完成：创建 8 张后期系统表');
    },

    /**
     * 回滚迁移：删除 8 张表（按依赖关系倒序）
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0032] 开始回滚后期系统表...');

        // 按依赖关系倒序删除（流水表 → 主表）
        const tablesToDrop = [
            'player_law_fragment',
            'player_law',
            'player_divine_sense',
            'player_incense_log',
            'player_divine_temple',
            'player_small_world',
            'player_soul_fragment',
            'player_second_soul'
        ];
        for (const table of tablesToDrop) {
            try {
                await sequelize.query(`DROP TABLE IF EXISTS ${table}`);
                console.log(`  ✓ 删除表: ${table}`);
            } catch (e) {
                console.log(`  - 删除表失败，跳过: ${table}（${e.message}）`);
            }
        }

        console.log('[Migration v0032] 回滚完成');
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
