/**
 * 数据库迁移脚本
 * 版本: 0042
 * 描述: 神识对决系统（玩法文档第18节）
 *      - 2 个新字段加到 players 表（每日挑战/接受次数日期标记）
 *      - 1 张新表（player_divine_duels：对局记录）
 *
 * 创建时间: 2026-07-21
 *
 * 新增字段（players 表）：
 *   divine_duel_challenge_date   DATE  上次发起挑战日期（每日重置 3 次）
 *   divine_duel_accept_date      DATE  上次接受挑战日期（每日重置 5 次）
 *
 * 新建表：
 *   player_divine_duels - 神识对决对局记录
 *      - challenger_id / defender_id：双方玩家
 *      - bet_type / bet_amount：赌注（灵石或神识）
 *      - status：pending（待接受）/ active（进行中）/ finished（已结束）/ cancelled（已取消）
 *      - 双方神识护盾、本回合行动、回合数、操作截止时间
 *      - winner_id：胜者ID（null=平局或未结束）
 *      - settle_reason：shield_zero（护盾归零）/ rounds_limit（回合上限）/ surrender（投降）/ timeout（超时）
 *
 * 设计要点：
 *   - 初始护盾 100，护盾上限 100（保证公平，不取决于玩家神识余额）
 *   - 同时选择博弈：双方都提交行动后才结算（focus 凝神 / stabilize 固元）
 *   - 每日次数用 DATE 字段：跨日自动重置，无需后台任务
 *   - 操作超时（60s）和对局创建超时（60s）由调度器检查
 *   - 幂等性：字段/表添加前检查 INFORMATION_SCHEMA
 *
 * MySQL 5.6 兼容性：
 *   - DATETIME 类型用于时间字段
 *   - VARCHAR(20) 用于枚举字符串
 *   - INT 用于护盾/赌注等数值
 *   - ENGINE=InnoDB 支持事务与行级锁
 */

module.exports = {
    description: '神识对决系统：2 个 player 字段 + 1 张新表（对局记录）',
    version: 42,

    /**
     * 执行迁移
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0042] 开始创建神识对决系统...');

        // ===== 1. players 表新增 2 个字段 =====
        console.log('[Migration v0042] 添加 players 表神识对决字段...');
        await addColumnIfNotExists(sequelize, 'players', 'divine_duel_challenge_date',
            'ADD COLUMN divine_duel_challenge_date DATE NULL COMMENT \'上次发起挑战日期（每日重置 3 次）\'');
        await addColumnIfNotExists(sequelize, 'players', 'divine_duel_accept_date',
            'ADD COLUMN divine_duel_accept_date DATE NULL COMMENT \'上次接受挑战日期（每日重置 5 次）\'');

        // ===== 2. 创建神识对决对局记录表 =====
        await createTableIfNotExists(sequelize, 'player_divine_duels', `
            CREATE TABLE player_divine_duels (
                id INT AUTO_INCREMENT PRIMARY KEY COMMENT '对局主键ID',
                challenger_id INT NOT NULL COMMENT '发起方玩家ID',
                defender_id INT NOT NULL COMMENT '应战方玩家ID',
                bet_type VARCHAR(20) NOT NULL COMMENT '赌注类型：spirit_stone/divine_sense',
                bet_amount INT NOT NULL COMMENT '赌注数量',
                status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/active/finished/cancelled',
                winner_id INT NULL COMMENT '胜者ID（null=平局或未结束）',
                challenger_shield INT NOT NULL DEFAULT 100 COMMENT '发起方神识护盾',
                defender_shield INT NOT NULL DEFAULT 100 COMMENT '应战方神识护盾',
                challenger_action VARCHAR(20) NULL COMMENT '发起方本回合行动：focus/stabilize',
                defender_action VARCHAR(20) NULL COMMENT '应战方本回合行动：focus/stabilize',
                round_number INT NOT NULL DEFAULT 0 COMMENT '当前回合数',
                action_deadline DATETIME NULL COMMENT '本回合操作截止时间',
                settle_reason VARCHAR(50) NULL COMMENT '结算原因：shield_zero/rounds_limit/surrender/timeout',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                finished_at DATETIME NULL COMMENT '对局结束时间',
                INDEX idx_pdd_challenger (challenger_id),
                INDEX idx_pdd_defender (defender_id),
                INDEX idx_pdd_status (status),
                INDEX idx_pdd_action_deadline (action_deadline)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='神识对决对局记录表'
        `);

        console.log('[Migration v0042] 神识对决系统创建完成');
    },

    /**
     * 回滚迁移
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0042] 回滚：删除神识对决相关表和字段...');
        await sequelize.query(`DROP TABLE IF EXISTS player_divine_duels`);

        // 删除 players 表字段（按反序）
        const columnsToRemove = [
            'divine_duel_accept_date',
            'divine_duel_challenge_date'
        ];
        for (const col of columnsToRemove) {
            await sequelize.query(`ALTER TABLE players DROP COLUMN IF EXISTS ${col}`);
        }
        console.log('[Migration v0042] 回滚完成');
    }
};

/**
 * 幂等添加列工具函数
 * 通过 INFORMATION_SCHEMA.COLUMNS 检查字段是否已存在
 * @param {Object} sequelize - Sequelize 实例
 * @param {string} tableName - 表名
 * @param {string} columnName - 字段名
 * @param {string} addColumnSql - ALTER TABLE 添加字段的 SQL 片段
 */
async function addColumnIfNotExists(sequelize, tableName, columnName, addColumnSql) {
    const [results] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        { replacements: [tableName, columnName] }
    );
    if (results && results.length > 0) {
        console.log(`[Migration v0042] 字段 ${tableName}.${columnName} 已存在，跳过`);
        return;
    }
    await sequelize.query(`ALTER TABLE ${tableName} ${addColumnSql}`);
    console.log(`[Migration v0042] 字段 ${tableName}.${columnName} 添加成功`);
}

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
        console.log(`[Migration v0042] 表 ${tableName} 已存在，跳过创建`);
        return;
    }
    await sequelize.query(createSql);
    console.log(`[Migration v0042] 表 ${tableName} 创建成功`);
}
