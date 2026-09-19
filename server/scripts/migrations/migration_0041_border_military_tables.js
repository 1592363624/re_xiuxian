/**
 * 数据库迁移脚本
 * 版本: 0041
 * 描述: 慕兰战线完整闭环系统（玩法文档第16节）
 *      - 9 个新字段加到 players 表（军功/今日行动标记）
 *      - 5 张新表（军报/灵兽巡边/里程碑奖励/临战刻印/支援日志）
 *
 * 创建时间: 2026-07-21
 *
 * 新增字段（players 表）：
 *   border_military_merit_total       INT         累计军功（决定军衔，不可消耗）
 *   border_military_merit_available   INT         可用军功（兑换消耗）
 *   border_last_support_date          DATE        上次支援日期（每日重置判断）
 *   border_today_support_route        VARCHAR(32) 今日已支援路线（null=未支援）
 *   border_intel_collected_date       DATE        今日已搜集军报日期
 *   border_intel_public_done          TINYINT(1)  今日是否已公开军报
 *   border_beast_patrol_date          DATE        今日灵兽巡边日期
 *   border_remnant_explore_date       DATE        今日残图探禁日期
 *   border_imprint_date               DATE        今日临战刻印日期
 *
 * 新建表：
 *   border_intel_reports         - 玩家搜集的军报记录（含真假标记、辨报结果、公开状态）
 *   border_beast_patrols         - 灵兽巡边记录（派出/归来/结算）
 *   border_milestone_rewards     - 里程碑奖励发放记录（幂等防止重复发放）
 *   border_war_imprints          - 临战刻印记录（法宝刻印状态+材料消耗）
 *   border_support_logs          - 支援行动日志（每次支援的详细记录）
 *
 * 设计要点：
 *   - 累计军功与可用军功分离：军衔不可倒退（看 total），兑换只消耗 available
 *   - 每日行动标记用 DATE 字段：跨日即重置，无需后台任务
 *   - 5 张表均使用 utf8mb4 字符集，支持中文
 *   - ENGINE=InnoDB 支持事务
 *
 * 幂等性：字段添加前检查 INFORMATION_SCHEMA.COLUMNS，表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - DATETIME 类型用于时间字段
 *   - TINYINT(1) 用于布尔值
 *   - DECIMAL(5,4) 用于概率（0.0000-1.0000）
 *   - VARCHAR(32) 用于枚举字符串
 */

module.exports = {
    description: '慕兰战线完整闭环：9 个 player 字段 + 5 张新表（军报/灵兽巡边/里程碑/刻印/支援日志）',
    version: 41,

    /**
     * 执行迁移
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0041] 开始创建慕兰战线系统...');

        // ===== 1. players 表新增 9 个字段 =====
        console.log('[Migration v0041] 添加 players 表慕兰战线字段...');
        await addColumnIfNotExists(sequelize, 'players', 'border_military_merit_total',
            'ADD COLUMN border_military_merit_total INT NOT NULL DEFAULT 0 COMMENT \'累计军功（决定军衔，不可消耗）\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_military_merit_available',
            'ADD COLUMN border_military_merit_available INT NOT NULL DEFAULT 0 COMMENT \'可用军功（兑换消耗）\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_last_support_date',
            'ADD COLUMN border_last_support_date DATE NULL COMMENT \'上次支援日期（每日重置判断）\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_today_support_route',
            'ADD COLUMN border_today_support_route VARCHAR(32) NULL COMMENT \'今日已支援路线（scout/lamp_breaker/array_guard/raid）\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_intel_collected_date',
            'ADD COLUMN border_intel_collected_date DATE NULL COMMENT \'今日已搜集军报日期\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_intel_public_done',
            'ADD COLUMN border_intel_public_done TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'今日是否已公开军报\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_beast_patrol_date',
            'ADD COLUMN border_beast_patrol_date DATE NULL COMMENT \'今日灵兽巡边日期\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_remnant_explore_date',
            'ADD COLUMN border_remnant_explore_date DATE NULL COMMENT \'今日残图探禁日期\'');
        await addColumnIfNotExists(sequelize, 'players', 'border_imprint_date',
            'ADD COLUMN border_imprint_date DATE NULL COMMENT \'今日临战刻印日期\'');

        // 添加军功索引（支持排行榜查询）
        await addIndexIfNotExists(sequelize, 'players', 'idx_players_border_merit_total',
            'ADD INDEX idx_players_border_merit_total (border_military_merit_total)');

        // ===== 2. 创建 5 张新表 =====

        // 2.1 border_intel_reports：军报记录表
        await createTableIfNotExists(sequelize, 'border_intel_reports', `
            CREATE TABLE border_intel_reports (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '军报主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                report_date DATE NOT NULL COMMENT '军报日期（每日重置）',
                report_index INT NOT NULL COMMENT '当日军报序号（1-3）',
                report_type VARCHAR(32) NOT NULL COMMENT '军报类型（troop_movement/supply_line/lamp_status/array_intel/elite_movement）',
                is_true TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否真实军报（0=假，1=真）',
                content VARCHAR(500) NOT NULL COMMENT '军报内容文本',
                confusion_rate DECIMAL(5,4) NOT NULL DEFAULT 0.1000 COMMENT '混淆度（影响辨报难度）',
                identified TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已辨报（0=未辨，1=已辨）',
                identified_result VARCHAR(32) NULL COMMENT '辨报结果（correct/wrong）',
                identified_at DATETIME NULL COMMENT '辨报时间',
                public_status VARCHAR(32) NOT NULL DEFAULT \'pending\' COMMENT '公开状态（pending/publiced/discarded）',
                publiced_at DATETIME NULL COMMENT '公开时间',
                merit_change INT NOT NULL DEFAULT 0 COMMENT '公开后军功变化（+3真/-1假）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '搜集时间',
                INDEX idx_bir_player_date (player_id, report_date),
                INDEX idx_bir_public_status (public_status),
                INDEX idx_bir_report_date (report_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='慕兰谍影军报记录表'
        `);

        // 2.2 border_beast_patrols：灵兽巡边记录表
        await createTableIfNotExists(sequelize, 'border_beast_patrols', `
            CREATE TABLE border_beast_patrols (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '巡边记录主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                beast_id BIGINT NOT NULL COMMENT '灵兽ID',
                patrol_route VARCHAR(32) NOT NULL COMMENT '巡边路线（scout/grain_guard/camp_raid）',
                start_time DATETIME NOT NULL COMMENT '派出时间',
                end_time DATETIME NOT NULL COMMENT '预计归来时间',
                settled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已结算（0=未结算，1=已结算）',
                settled_at DATETIME NULL COMMENT '结算时间',
                merit_gained INT NOT NULL DEFAULT 0 COMMENT '获得军功',
                spirit_stones_gained BIGINT NOT NULL DEFAULT 0 COMMENT '获得灵石',
                exp_gained BIGINT NOT NULL DEFAULT 0 COMMENT '灵兽获得经验',
                beast_exp_gained INT NOT NULL DEFAULT 0 COMMENT '灵兽经验',
                items_dropped TEXT NULL COMMENT '掉落物品JSON',
                failed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否失败（袭营有失败概率）',
                failure_penalty TEXT NULL COMMENT '失败惩罚JSON',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                INDEX idx_bbp_player (player_id),
                INDEX idx_bbp_beast (beast_id),
                INDEX idx_bbp_settled (settled),
                INDEX idx_bbp_end_time (end_time)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽边境巡边记录表'
        `);

        // 2.3 border_milestone_rewards：里程碑奖励发放记录
        await createTableIfNotExists(sequelize, 'border_milestone_rewards', `
            CREATE TABLE border_milestone_rewards (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '里程碑发放主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                milestone_merit INT NOT NULL COMMENT '里程碑军功阈值（7/21/49/81）',
                milestone_title VARCHAR(64) NOT NULL COMMENT '里程碑标题',
                rewards_data TEXT NOT NULL COMMENT '奖励内容JSON',
                granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '发放时间',
                UNIQUE KEY uk_bmr_player_milestone (player_id, milestone_merit),
                INDEX idx_bmr_player (player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='慕兰战线里程碑奖励发放记录表'
        `);

        // 2.4 border_war_imprints：临战刻印记录表
        await createTableIfNotExists(sequelize, 'border_war_imprints', `
            CREATE TABLE border_war_imprints (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '刻印记录主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                artifact_id BIGINT NOT NULL COMMENT '法宝ID（玩家装备实例ID）',
                artifact_name VARCHAR(128) NOT NULL COMMENT '法宝名称（快照）',
                imprint_type VARCHAR(32) NOT NULL COMMENT '刻印类型（lamp_breaker/array_guard/scout_stealth）',
                matched_route VARCHAR(64) NOT NULL COMMENT '匹配路线（单路线或多路线逗号分隔）',
                bonus_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '加成比例',
                materials_consumed TEXT NOT NULL COMMENT '消耗材料JSON',
                triggered TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已触发（支援时自动触发）',
                triggered_at DATETIME NULL COMMENT '触发时间',
                trigger_route VARCHAR(32) NULL COMMENT '触发时支援路线',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '刻印时间',
                expires_at DATETIME NOT NULL COMMENT '过期时间（24小时后）',
                INDEX idx_bwi_player (player_id),
                INDEX idx_bwi_artifact (artifact_id),
                INDEX idx_bwi_triggered (triggered),
                INDEX idx_bwi_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='临战刻印记录表'
        `);

        // 2.5 border_support_logs：支援行动日志表
        await createTableIfNotExists(sequelize, 'border_support_logs', `
            CREATE TABLE border_support_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '支援日志主键ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                support_route VARCHAR(32) NOT NULL COMMENT '支援路线（scout/lamp_breaker/array_guard/raid）',
                support_date DATE NOT NULL COMMENT '支援日期',
                is_secret_order TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否密令路线（军议押中）',
                is_risky_route TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否险棋路线',
                is_grain_route TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否粮道路线',
                base_merit INT NOT NULL DEFAULT 0 COMMENT '基础军功',
                final_merit INT NOT NULL DEFAULT 0 COMMENT '最终军功（含加成）',
                merit_bonus_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '军功加成比例',
                spirit_stones_gained BIGINT NOT NULL DEFAULT 0 COMMENT '获得灵石',
                items_dropped TEXT NULL COMMENT '掉落物品JSON',
                imprint_triggered TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否触发临战刻印',
                imprint_bonus_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '刻印加成比例',
                intel_bonus_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '军报加成比例',
                failed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否失败',
                failure_penalty TEXT NULL COMMENT '失败惩罚JSON',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '支援时间',
                INDEX idx_bsl_player_date (player_id, support_date),
                INDEX idx_bsl_route (support_route),
                INDEX idx_bsl_date (support_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='慕兰战线支援行动日志表'
        `);

        console.log('[Migration v0041] 慕兰战线系统创建完成');
    },

    /**
     * 回滚迁移
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0041] 回滚：删除慕兰战线相关表和字段...');
        await sequelize.query(`DROP TABLE IF EXISTS border_support_logs`);
        await sequelize.query(`DROP TABLE IF EXISTS border_war_imprints`);
        await sequelize.query(`DROP TABLE IF EXISTS border_milestone_rewards`);
        await sequelize.query(`DROP TABLE IF EXISTS border_beast_patrols`);
        await sequelize.query(`DROP TABLE IF EXISTS border_intel_reports`);

        // 删除 players 表字段（按反序）
        const columnsToRemove = [
            'border_imprint_date',
            'border_remnant_explore_date',
            'border_beast_patrol_date',
            'border_intel_public_done',
            'border_intel_collected_date',
            'border_today_support_route',
            'border_last_support_date',
            'border_military_merit_available',
            'border_military_merit_total'
        ];
        for (const col of columnsToRemove) {
            await sequelize.query(`ALTER TABLE players DROP COLUMN IF EXISTS ${col}`);
        }
        await sequelize.query(`ALTER TABLE players DROP INDEX IF EXISTS idx_players_border_merit_total`);
        console.log('[Migration v0041] 回滚完成');
    }
};

/**
 * 幂等添加列工具函数
 */
async function addColumnIfNotExists(sequelize, tableName, columnName, addColumnSql) {
    const [results] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        { replacements: [tableName, columnName] }
    );
    if (results && results.length > 0) {
        console.log(`[Migration v0041] 字段 ${tableName}.${columnName} 已存在，跳过`);
        return;
    }
    await sequelize.query(`ALTER TABLE ${tableName} ${addColumnSql}`);
    console.log(`[Migration v0041] 字段 ${tableName}.${columnName} 添加成功`);
}

/**
 * 幂等添加索引工具函数
 */
async function addIndexIfNotExists(sequelize, tableName, indexName, addIndexSql) {
    const [results] = await sequelize.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        { replacements: [tableName, indexName] }
    );
    if (results && results.length > 0) {
        console.log(`[Migration v0041] 索引 ${indexName} 已存在，跳过`);
        return;
    }
    await sequelize.query(`ALTER TABLE ${tableName} ${addIndexSql}`);
    console.log(`[Migration v0041] 索引 ${indexName} 添加成功`);
}

/**
 * 幂等创建表工具函数
 */
async function createTableIfNotExists(sequelize, tableName, createSql) {
    const [results] = await sequelize.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        { replacements: [tableName] }
    );
    if (results && results.length > 0) {
        console.log(`[Migration v0041] 表 ${tableName} 已存在，跳过创建`);
        return;
    }
    await sequelize.query(createSql);
    console.log(`[Migration v0041] 表 ${tableName} 创建成功`);
}
