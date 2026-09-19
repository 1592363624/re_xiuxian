/**
 * 数据库迁移脚本
 * 版本: 0043
 * 描述: 坐化遗府系统（玩法文档第16节）
 *      - 4 张新表：cave_legacies / cave_legacy_items / cave_legacy_participants / cave_legacy_distribution_logs
 *
 * 创建时间: 2026-07-21
 *
 * 表设计：
 *   1. cave_legacies（遗府活动主表）
 *      - owner_player_id：坐化玩家ID（已退坑/死亡）
 *      - owner_nickname_snapshot：坐化玩家昵称快照（避免玩家改名后无法追溯）
 *      - owner_ip_snapshot：坐化玩家IP快照（用于同主魂识别）
 *      - status：preview（预览未开启）/ open（开启中）/ closed（已关闭）/ expired（已过期）
 *      - started_at / ends_at：开启/结束时间
 *      - closed_at：实际关闭时间（管理员关闭或自动过期）
 *      - opened_by_admin：开启操作的管理员ID
 *      - closed_by_admin：关闭操作的管理员ID（null=自动关闭）
 *      - items_count：可分配物品种类数
 *      - items_total_quantity：可分配物品总数量
 *      - participants_count：参与分宝的玩家数
 *      - settled：是否已结算（true=已生成参与者分配结果，false=待结算）
 *      - close_reason：关闭原因（admin_close / expired / auto_close）
 *      - summary_json：结算摘要 JSON（含未分配物品处理结果）
 *
 *   2. cave_legacy_items（遗府可分配物品表）
 *      - legacy_id：所属遗府ID
 *      - item_key：物品配置键名（对应 item_data.json items[].id）
 *      - item_name_snapshot：物品名称快照
 *      - item_type_snapshot / item_subtype_snapshot / item_quality_snapshot：物品分类快照
 *      - original_quantity：原始数量（从坐化玩家储物袋中读取的）
 *      - remaining_quantity：剩余可分配数量（分配后递减）
 *      - source：来源 inventory=储物袋 / manual=管理员手动添加（预留扩展）
 *
 *   3. cave_legacy_participants（参与分宝的玩家表）
 *      - legacy_id：所属遗府ID
 *      - player_id：参与玩家ID
 *      - player_nickname_snapshot：参与玩家昵称快照
 *      - player_ip_snapshot：参与玩家IP快照（用于同主魂识别）
 *      - eligible：是否合格（true=可分宝，false=不合格但记录尝试）
 *      - ineligibility_reason：不合格原因（NULL=合格）
 *      - weight：分宝权重（合格玩家参与分宝的权重值）
 *      - lucky_factor：幸运因子（0.8~1.2）
 *      - has_spun：是否已转动分宝（true=已分得物品）
 *      - spun_at：转动时间
 *      - total_item_types：分得物品种类数
 *      - total_quantity：分得总数量
 *      - claimed_at：领取时间（玩家从遗府领走物品的时间）
 *
 *   4. cave_legacy_distribution_logs（分配日志表）
 *      - legacy_id：所属遗府ID
 *      - player_id：领取玩家ID
 *      - item_key：物品配置键名
 *      - item_name_snapshot：物品名称快照
 *      - quantity：分配数量
 *      - distributed_at：分配时间
 *      - source：分配来源 spin=转动分宝 / admin_grant=管理员补偿
 *
 * 设计要点：
 *   - 物品筛选在 Service 层完成（应用配置规则），结果写入 cave_legacy_items
 *   - 同主魂唯一领取通过 player_ip_snapshot 在 Service 层校验（不依赖数据库唯一索引，因合格玩家可能尝试多次）
 *   - 一次分宝事务：扣减 cave_legacy_items.remaining_quantity + 写入 distribution_log + 更新 participant.has_spun
 *   - 幂等性：表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - DATETIME 类型用于时间字段
 *   - VARCHAR 用于字符串字段
 *   - INT 用于数量、ID 等
 *   - TEXT 用于 JSON 快照字段
 *   - ENGINE=InnoDB 支持事务与行级锁
 */

module.exports = {
    description: '坐化遗府系统：4 张新表（活动主表/物品表/参与者表/分配日志表）',
    version: 43,

    /**
     * 执行迁移
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0043] 开始创建坐化遗府系统...');

        // ===== 1. cave_legacies 遗府活动主表 =====
        await createTableIfNotExists(sequelize, 'cave_legacies', `
            CREATE TABLE cave_legacies (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '遗府活动ID',
                owner_player_id INT NOT NULL COMMENT '坐化玩家ID（已退坑/死亡）',
                owner_nickname_snapshot VARCHAR(100) NOT NULL COMMENT '坐化玩家昵称快照',
                owner_ip_snapshot VARCHAR(50) NULL COMMENT '坐化玩家IP快照（同主魂识别）',
                status VARCHAR(20) NOT NULL DEFAULT 'preview' COMMENT 'preview/open/closed/expired',
                duration_hours INT NOT NULL DEFAULT 24 COMMENT '活动时长（小时）',
                started_at DATETIME NULL COMMENT '开启时间',
                ends_at DATETIME NULL COMMENT '计划结束时间',
                closed_at DATETIME NULL COMMENT '实际关闭时间',
                opened_by_admin INT NULL COMMENT '开启操作的管理员ID',
                closed_by_admin INT NULL COMMENT '关闭操作的管理员ID（null=自动关闭）',
                items_count INT NOT NULL DEFAULT 0 COMMENT '可分配物品种类数',
                items_total_quantity INT NOT NULL DEFAULT 0 COMMENT '可分配物品总数量',
                participants_count INT NOT NULL DEFAULT 0 COMMENT '参与分宝的玩家数',
                settled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已结算（0=未结算，1=已结算）',
                close_reason VARCHAR(30) NULL COMMENT '关闭原因：admin_close/expired/auto_close',
                summary_json TEXT NULL COMMENT '结算摘要 JSON',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_cl_owner (owner_player_id),
                INDEX idx_cl_status (status),
                INDEX idx_cl_ends_at (ends_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='坐化遗府活动主表'
        `);

        // ===== 2. cave_legacy_items 遗府可分配物品表 =====
        await createTableIfNotExists(sequelize, 'cave_legacy_items', `
            CREATE TABLE cave_legacy_items (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                legacy_id INT NOT NULL COMMENT '所属遗府ID',
                item_key VARCHAR(100) NOT NULL COMMENT '物品配置键名',
                item_name_snapshot VARCHAR(100) NOT NULL COMMENT '物品名称快照',
                item_type_snapshot VARCHAR(30) NOT NULL COMMENT '物品类型快照（material/consumable）',
                item_subtype_snapshot VARCHAR(50) NULL COMMENT '物品 subtype 快照',
                item_quality_snapshot VARCHAR(30) NOT NULL DEFAULT 'common' COMMENT '物品品质快照',
                original_quantity INT NOT NULL DEFAULT 0 COMMENT '原始数量（从储物袋读取）',
                remaining_quantity INT NOT NULL DEFAULT 0 COMMENT '剩余可分配数量',
                source VARCHAR(20) NOT NULL DEFAULT 'inventory' COMMENT '来源：inventory=储物袋 / manual=管理员手动',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_cli_legacy (legacy_id),
                INDEX idx_cli_item_key (item_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='遗府可分配物品表'
        `);

        // ===== 3. cave_legacy_participants 参与分宝的玩家表 =====
        await createTableIfNotExists(sequelize, 'cave_legacy_participants', `
            CREATE TABLE cave_legacy_participants (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                legacy_id INT NOT NULL COMMENT '所属遗府ID',
                player_id INT NOT NULL COMMENT '参与玩家ID',
                player_nickname_snapshot VARCHAR(100) NOT NULL COMMENT '玩家昵称快照',
                player_ip_snapshot VARCHAR(50) NULL COMMENT '玩家IP快照（同主魂识别）',
                eligible TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否合格（0=不合格，1=合格）',
                ineligibility_reason VARCHAR(200) NULL COMMENT '不合格原因',
                weight DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '分宝权重',
                lucky_factor DECIMAL(4,2) NOT NULL DEFAULT 1.00 COMMENT '幸运因子（0.80~1.20）',
                has_spun TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已转动分宝（0=未转，1=已转）',
                spun_at DATETIME NULL COMMENT '转动时间',
                total_item_types INT NOT NULL DEFAULT 0 COMMENT '分得物品种类数',
                total_quantity INT NOT NULL DEFAULT 0 COMMENT '分得总数量',
                claimed_at DATETIME NULL COMMENT '领取时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_clp_legacy_player (legacy_id, player_id),
                INDEX idx_clp_player (player_id),
                INDEX idx_clp_eligible (legacy_id, eligible),
                INDEX idx_clp_has_spun (legacy_id, has_spun)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='参与分宝的玩家表'
        `);

        // ===== 4. cave_legacy_distribution_logs 分配日志表 =====
        await createTableIfNotExists(sequelize, 'cave_legacy_distribution_logs', `
            CREATE TABLE cave_legacy_distribution_logs (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '日志ID',
                legacy_id INT NOT NULL COMMENT '所属遗府ID',
                player_id INT NOT NULL COMMENT '领取玩家ID',
                item_key VARCHAR(100) NOT NULL COMMENT '物品配置键名',
                item_name_snapshot VARCHAR(100) NOT NULL COMMENT '物品名称快照',
                quantity INT NOT NULL DEFAULT 0 COMMENT '分配数量',
                distributed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '分配时间',
                source VARCHAR(20) NOT NULL DEFAULT 'spin' COMMENT '分配来源：spin=转动分宝 / admin_grant=管理员补偿',
                INDEX idx_cldl_legacy (legacy_id),
                INDEX idx_cldl_player (player_id),
                INDEX idx_cldl_distributed_at (distributed_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='遗府分配日志表'
        `);

        console.log('[Migration v0043] 坐化遗府系统创建完成');
    },

    /**
     * 回滚迁移
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0043] 回滚：删除坐化遗府相关表...');
        // 按依赖反序删除
        await sequelize.query(`DROP TABLE IF EXISTS cave_legacy_distribution_logs`);
        await sequelize.query(`DROP TABLE IF EXISTS cave_legacy_participants`);
        await sequelize.query(`DROP TABLE IF EXISTS cave_legacy_items`);
        await sequelize.query(`DROP TABLE IF EXISTS cave_legacies`);
        console.log('[Migration v0043] 回滚完成');
    }
};

/**
 * 幂等创建表工具函数
 * 通过 INFORMATION_SCHEMA.TABLES 检查表是否已存在
 * @param {Object} sequelize - Sequelize 实例
 * @param {string} tableName - 表名
 * @param {string} createSql - CREATE TABLE 完整 SQL
 */
async function createTableIfNotExists(sequelize, tableName, createSql) {
    const [results] = await sequelize.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        { replacements: [tableName] }
    );
    if (results && results.length > 0) {
        console.log(`[Migration v0043] 表 ${tableName} 已存在，跳过创建`);
        return;
    }
    await sequelize.query(createSql);
    console.log(`[Migration v0043] 表 ${tableName} 创建成功`);
}
