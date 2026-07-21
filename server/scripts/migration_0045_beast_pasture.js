/**
 * 数据库迁移脚本
 * 版本: 45
 * 描述: 灵兽放养与偷菜系统（玩法文档第8节）
 * 创建时间: 2026-07-21
 *
 * 设计要点：
 *   1. spirit_beast_pastures 表：记录灵兽放养状态（场所/开始/结束/产物快照/状态）
 *   2. garden_steal_logs 表：偷菜日志（偷菜方/被偷方/灵兽快照/作物/护院结果）
 *   3. spirit_beasts 表新增 is_pasturing 字段：标记灵兽是否正在放养
 *   4. 幂等性：所有 CREATE/ALTER 前先检查存在性
 *   5. 参数化查询防 SQL 注入
 */
'use strict';

module.exports = {
    description: '灵兽放养与偷菜系统：放养记录表 + 偷菜日志表 + 灵兽is_pasturing字段',
    version: 45,

    /**
     * 执行迁移
     * @param {import('sequelize').Sequelize} sequelizeInstance - sequelize 实例
     * @param {object} QueryTypes - QueryTypes 对象
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

        // 辅助函数：检查列是否存在
        async function columnExists(tableName, columnName) {
            const [rows] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
                { replacements: [tableName, columnName], type: QueryTypes.SELECT }
            );
            return rows && rows.length > 0;
        }

        // ========== 1. 创建灵兽放养记录表 ==========
        if (!(await tableExists('spirit_beast_pastures'))) {
            await sequelize.query(`
                CREATE TABLE spirit_beast_pastures (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '放养记录ID',
                    player_id BIGINT NOT NULL COMMENT '所属玩家ID',
                    beast_id BIGINT NOT NULL COMMENT '灵兽实例ID',
                    beast_snapshot JSON NULL COMMENT '放养时灵兽快照（名称/属性/元素/星级/等级）',
                    location_key VARCHAR(50) NOT NULL COMMENT '放养场所key',
                    location_name VARCHAR(50) NOT NULL COMMENT '放养场所名称',
                    start_time DATETIME NOT NULL COMMENT '放养开始时间',
                    end_time DATETIME NOT NULL COMMENT '放养预计结束时间',
                    actual_end_time DATETIME NULL COMMENT '实际结束时间（召回/自动结算时填充）',
                    status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT '放养状态：active放养中/recalled已召回/auto_settled自动结算/expired已过期',
                    recall_type VARCHAR(20) NULL COMMENT '召回类型：manual手动/auto自动/early提前',
                    yield_snapshot JSON NULL COMMENT '产物快照（结算时填充，含物品ID/数量/品质）',
                    steal_count INT NOT NULL DEFAULT 0 COMMENT '本期间偷菜成功次数',
                    stolen_count INT NOT NULL DEFAULT 0 COMMENT '本期间被偷次数',
                    steal_yields JSON NULL COMMENT '偷菜收获快照',
                    yield_discount DECIMAL(3,2) NOT NULL DEFAULT 1.00 COMMENT '产物折扣（提前召回0/自动结算0.8/正常1.0）',
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_pasture_player (player_id),
                    INDEX idx_pasture_beast (beast_id),
                    INDEX idx_pasture_status (status),
                    INDEX idx_pasture_end_time (end_time),
                    INDEX idx_pasture_player_status (player_id, status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽放养记录表'
            `);
            console.log('[Migration 0045] 表 spirit_beast_pastures 创建成功');
        }

        // ========== 2. 创建偷菜日志表 ==========
        if (!(await tableExists('garden_steal_logs'))) {
            await sequelize.query(`
                CREATE TABLE garden_steal_logs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '偷菜日志ID',
                    attacker_player_id BIGINT NOT NULL COMMENT '偷菜方玩家ID',
                    attacker_beast_id BIGINT NOT NULL COMMENT '偷菜方灵兽ID',
                    attacker_beast_snapshot JSON NULL COMMENT '偷菜方灵兽快照',
                    target_player_id BIGINT NOT NULL COMMENT '被偷方玩家ID',
                    target_plot_index INT NULL COMMENT '被偷地块序号',
                    target_seed_id VARCHAR(50) NULL COMMENT '被偷作物种子ID',
                    target_produce_item_id VARCHAR(100) NULL COMMENT '被偷作物产出物品ID',
                    stolen_qty INT NOT NULL DEFAULT 0 COMMENT '被偷数量',
                    stolen_quality VARCHAR(20) NULL COMMENT '被偷作物品质',
                    guard_beast_id BIGINT NULL COMMENT '护院灵兽ID（无护院为null）',
                    guard_beast_snapshot JSON NULL COMMENT '护院灵兽快照',
                    result VARCHAR(20) NOT NULL COMMENT '偷菜结果：success成功/intercepted被拦截/failed失败',
                    counter_damage INT NOT NULL DEFAULT 0 COMMENT '反伤伤害（被拦截时护院灵兽造成）',
                    exp_gained INT NOT NULL DEFAULT 0 COMMENT '获得经验',
                    loyalty_change INT NOT NULL DEFAULT 0 COMMENT '忠诚度变化',
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_steal_attacker (attacker_player_id, created_at),
                    INDEX idx_steal_target (target_player_id, created_at),
                    INDEX idx_steal_beast (attacker_beast_id, created_at),
                    INDEX idx_steal_result (result, created_at),
                    INDEX idx_steal_target_plot (target_player_id, target_plot_index, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽偷菜日志表'
            `);
            console.log('[Migration 0045] 表 garden_steal_logs 创建成功');
        }

        // ========== 3. spirit_beasts 表新增 is_pasturing 字段 ==========
        if (!(await columnExists('spirit_beasts', 'is_pasturing'))) {
            await sequelize.query(`
                ALTER TABLE spirit_beasts
                ADD COLUMN is_pasturing TINYINT(1) NOT NULL DEFAULT 0
                COMMENT '是否正在放养中（放养期间不能出战/喂养/互动）'
                AFTER is_active
            `);
            console.log('[Migration 0045] spirit_beasts.is_pasturing 字段添加成功');
        }

        console.log('[Migration 0045] 灵兽放养与偷菜系统迁移完成');
    },

    /**
     * 回滚迁移
     */
    async down(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;
        await sequelize.query('DROP TABLE IF EXISTS garden_steal_logs');
        await sequelize.query('DROP TABLE IF EXISTS spirit_beast_pastures');
        // 回滚 is_pasturing 字段
        try {
            await sequelize.query('ALTER TABLE spirit_beasts DROP COLUMN is_pasturing');
        } catch (e) {
            // 字段可能不存在，忽略
        }
        console.log('[Migration 0045] 回滚完成');
    }
};
