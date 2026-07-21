/**
 * 数据库迁移脚本
 * 版本: 46
 * 描述: 灵兽探渊系统（玩法文档第24节 灵兽探渊）
 * 创建时间: 2026-07-21
 *
 * 设计要点：
 *   1. spirit_beast_abyss_explores 表：探渊记录表（灵兽/开始/结束/层数/事件快照/奖励快照/状态）
 *   2. abyss_encounter_logs 表：遭遇日志表（PVE怪物/PVP玩家/宝箱/陷阱）
 *   3. spirit_beasts 表新增字段：
 *      - is_exploring：是否正在探渊中（探渊期间不能出战/喂养/互动/放养）
 *      - stamina：体力（0-100，探渊消耗，每小时恢复25）
 *      - injury_until：受伤恢复截止时间（HP归零后需恢复2小时）
 *   4. 幂等性：所有 CREATE/ALTER 前先检查存在性
 *   5. 参数化查询防 SQL 注入
 */
'use strict';

module.exports = {
    description: '灵兽探渊系统：探渊记录表 + 遭遇日志表 + 灵兽is_exploring/stamina/injury_until字段',
    version: 46,

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

        // ========== 1. 创建灵兽探渊记录表 ==========
        if (!(await tableExists('spirit_beast_abyss_explores'))) {
            await sequelize.query(`
                CREATE TABLE spirit_beast_abyss_explores (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '探渊记录ID',
                    player_id BIGINT NOT NULL COMMENT '所属玩家ID',
                    beast_id BIGINT NOT NULL COMMENT '灵兽实例ID',
                    beast_snapshot JSON NULL COMMENT '探渊时灵兽快照（名称/属性/元素/星级/等级/HP）',
                    start_floor INT NOT NULL DEFAULT 1 COMMENT '起始层数',
                    max_floor_reached INT NOT NULL DEFAULT 1 COMMENT '到达的最深层数',
                    duration_hours INT NOT NULL COMMENT '预计探渊时长（小时）',
                    start_time DATETIME NOT NULL COMMENT '探渊开始时间',
                    end_time DATETIME NOT NULL COMMENT '预计探渊结束时间',
                    actual_end_time DATETIME NULL COMMENT '实际结束时间（召回/自动结算时填充）',
                    status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT '探渊状态：active探渊中/recalled已召回/auto_settled自动结算/injured受伤返回',
                    recall_type VARCHAR(20) NULL COMMENT '召回类型：manual手动/auto自动/early提前/injured受伤',
                    events_snapshot JSON NULL COMMENT '遭遇事件快照（PVE/PVP/宝箱/陷阱列表）',
                    rewards_snapshot JSON NULL COMMENT '奖励快照（物品/灵石/经验/兽魂）',
                    pvp_encounters INT NOT NULL DEFAULT 0 COMMENT '本次PVP遭遇次数',
                    pvp_wins INT NOT NULL DEFAULT 0 COMMENT '本次PVP胜利次数',
                    pvp_losses INT NOT NULL DEFAULT 0 COMMENT '本次PVP失败次数',
                    monster_kills INT NOT NULL DEFAULT 0 COMMENT '本次怪物击杀数',
                    treasures_found INT NOT NULL DEFAULT 0 COMMENT '本次宝箱发现数',
                    traps_triggered INT NOT NULL DEFAULT 0 COMMENT '本次陷阱触发数',
                    stamina_used INT NOT NULL DEFAULT 0 COMMENT '本次消耗体力',
                    beast_soul_gained INT NOT NULL DEFAULT 0 COMMENT '本次获得兽魂',
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_abyss_player (player_id),
                    INDEX idx_abyss_beast (beast_id),
                    INDEX idx_abyss_status (status),
                    INDEX idx_abyss_end_time (end_time),
                    INDEX idx_abyss_player_status (player_id, status),
                    INDEX idx_abyss_max_floor (max_floor_reached)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽探渊记录表'
            `);
            console.log('[Migration 0046] 表 spirit_beast_abyss_explores 创建成功');
        }

        // ========== 2. 创建遭遇日志表 ==========
        if (!(await tableExists('abyss_encounter_logs'))) {
            await sequelize.query(`
                CREATE TABLE abyss_encounter_logs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '日志ID',
                    explore_id BIGINT NOT NULL COMMENT '关联探渊记录ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    beast_id BIGINT NOT NULL COMMENT '灵兽ID',
                    floor INT NOT NULL COMMENT '遭遇所在层数',
                    encounter_type VARCHAR(20) NOT NULL COMMENT '遭遇类型：monster/PVP/treasure/trap',
                    encounter_detail JSON NULL COMMENT '遭遇详情（怪物信息/对手信息/宝箱内容/陷阱效果）',
                    result VARCHAR(20) NULL COMMENT '遭遇结果：victory/defeat/flee/triggered',
                    hp_after INT NULL COMMENT '遭遇后灵兽HP',
                    stamina_after INT NULL COMMENT '遭遇后体力',
                    exp_gained INT NOT NULL DEFAULT 0 COMMENT '获得经验',
                    items_gained JSON NULL COMMENT '获得物品列表',
                    spirit_stones_gained BIGINT NOT NULL DEFAULT 0 COMMENT '获得灵石',
                    beast_soul_gained INT NOT NULL DEFAULT 0 COMMENT '获得兽魂',
                    opponent_player_id BIGINT NULL COMMENT 'PVP对手玩家ID',
                    opponent_beast_id BIGINT NULL COMMENT 'PVP对手灵兽ID',
                    opponent_beast_name VARCHAR(100) NULL COMMENT 'PVP对手灵兽名称',
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_encounter_explore (explore_id),
                    INDEX idx_encounter_player (player_id),
                    INDEX idx_encounter_type (encounter_type),
                    INDEX idx_encounter_floor (floor),
                    INDEX idx_encounter_opponent (opponent_player_id),
                    INDEX idx_encounter_created (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='探渊遭遇日志表'
            `);
            console.log('[Migration 0046] 表 abyss_encounter_logs 创建成功');
        }

        // ========== 3. spirit_beasts 表新增 is_exploring 字段 ==========
        if (!(await columnExists('spirit_beasts', 'is_exploring'))) {
            await sequelize.query(`
                ALTER TABLE spirit_beasts
                ADD COLUMN is_exploring TINYINT(1) NOT NULL DEFAULT 0
                COMMENT '是否正在探渊中（探渊期间不能出战/喂养/互动/放养）'
                AFTER is_pasturing
            `);
            console.log('[Migration 0046] spirit_beasts.is_exploring 字段添加成功');
        }

        // ========== 4. spirit_beasts 表新增 stamina 字段 ==========
        if (!(await columnExists('spirit_beasts', 'stamina'))) {
            await sequelize.query(`
                ALTER TABLE spirit_beasts
                ADD COLUMN stamina INT NOT NULL DEFAULT 100
                COMMENT '体力（0-100，探渊消耗，每小时恢复25）'
                AFTER is_exploring
            `);
            console.log('[Migration 0046] spirit_beasts.stamina 字段添加成功');
        }

        // ========== 5. spirit_beasts 表新增 injury_until 字段 ==========
        if (!(await columnExists('spirit_beasts', 'injury_until'))) {
            await sequelize.query(`
                ALTER TABLE spirit_beasts
                ADD COLUMN injury_until DATETIME NULL
                COMMENT '受伤恢复截止时间（HP归零后需恢复2小时，期间不能探渊/出战/放养）'
                AFTER stamina
            `);
            console.log('[Migration 0046] spirit_beasts.injury_until 字段添加成功');
        }

        // ========== 6. spirit_beasts 表新增 last_explore_time 字段（每日次数限制用） ==========
        if (!(await columnExists('spirit_beasts', 'last_explore_time'))) {
            await sequelize.query(`
                ALTER TABLE spirit_beasts
                ADD COLUMN last_explore_time DATETIME NULL
                COMMENT '最后探渊时间（用于每日次数限制校验）'
                AFTER injury_until
            `);
            console.log('[Migration 0046] spirit_beasts.last_explore_time 字段添加成功');
        }

        console.log('[Migration 0046] 灵兽探渊系统迁移完成');
    },

    /**
     * 回滚迁移（谨慎使用）
     */
    async down(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;

        async function columnExists(tableName, columnName) {
            const [rows] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
                { replacements: [tableName, columnName], type: QueryTypes.SELECT }
            );
            return rows && rows.length > 0;
        }

        async function tableExists(tableName) {
            const [rows] = await sequelize.query(
                `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                { replacements: [tableName], type: QueryTypes.SELECT }
            );
            return rows && rows.length > 0;
        }

        // 删除字段
        if (await columnExists('spirit_beasts', 'last_explore_time')) {
            await sequelize.query('ALTER TABLE spirit_beasts DROP COLUMN last_explore_time');
        }
        if (await columnExists('spirit_beasts', 'injury_until')) {
            await sequelize.query('ALTER TABLE spirit_beasts DROP COLUMN injury_until');
        }
        if (await columnExists('spirit_beasts', 'stamina')) {
            await sequelize.query('ALTER TABLE spirit_beasts DROP COLUMN stamina');
        }
        if (await columnExists('spirit_beasts', 'is_exploring')) {
            await sequelize.query('ALTER TABLE spirit_beasts DROP COLUMN is_exploring');
        }

        // 删除表
        if (await tableExists('abyss_encounter_logs')) {
            await sequelize.query('DROP TABLE abyss_encounter_logs');
        }
        if (await tableExists('spirit_beast_abyss_explores')) {
            await sequelize.query('DROP TABLE spirit_beast_abyss_explores');
        }

        console.log('[Migration 0046] 回滚完成');
    }
};
