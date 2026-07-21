/**
 * 数据库迁移脚本
 * 版本: 0037
 * 描述: 道侣/双修系统（1 张新表：dao_companions 玩家间道侣关系表）
 * 创建时间: 2026-07-20
 *
 * 新建表：
 *   dao_companions - 玩家间道侣关系表（求婚方/被求婚方/亲密度/心契/心印/冷却）
 *
 * 与 server/models/daoCompanion.js 区别：
 *   - 旧表 dao_companion 用于批次3 道侣/侍妾系统（双向 UNIQUE）
 *   - 新表 dao_companions 用于本次"道侣/双修系统"重做版（含 intimacy、心契0-9、心印、心劫冷却）
 *
 * 设计要点：
 *   - player_a_id / player_b_id 分别加索引：按玩家ID查询道侣关系
 *   - status 字段加索引：统计 pending/accepted 关系
 *   - (player_a_id, player_b_id, status) 复合索引：业务层校验唯一性
 *   - intimacy / heart_contract_level / heart_imprint_count 使用 INT（0-100 / 0-9 / 0-27）
 *   - 时间字段使用 DATETIME
 *   - 字符集 utf8mb4 保证中文注释存储
 *   - ENGINE=InnoDB 支持事务与行级锁
 *
 * 幂等性：表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - ENUM 类型兼容
 *   - DATETIME 类型用于时间字段
 *   - 无 JSON 类型字段
 */

module.exports = {
    description: '道侣/双修系统：1 张新表（dao_companions 玩家间道侣关系表）',
    version: 37,

    /**
     * 执行迁移：创建 dao_companions 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0037] 开始创建道侣/双修系统表...');

        // ===== dao_companions 表：玩家间道侣关系表 =====
        await createTableIfNotExists(sequelize, 'dao_companions', `
            CREATE TABLE dao_companions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '道侣关系主键ID',
                player_a_id BIGINT NOT NULL COMMENT '求婚方玩家ID',
                player_b_id BIGINT NOT NULL COMMENT '被求婚方玩家ID',
                status ENUM('pending','accepted','refused','broken') NOT NULL DEFAULT 'pending' COMMENT '关系状态：pending=待响应，accepted=已缔结，refused=已拒绝，broken=已解除',
                intimacy INT NOT NULL DEFAULT 0 COMMENT '亲密度（0-100），影响双修加成比例',
                dual_cultivation_count INT NOT NULL DEFAULT 0 COMMENT '历史双修总次数',
                heart_contract_level INT NOT NULL DEFAULT 0 COMMENT '心契等级（0-9），每级提升双修加成',
                heart_imprint_count INT NOT NULL DEFAULT 0 COMMENT '心印数量（每3个提升1级心契）',
                last_interaction_time DATETIME NULL COMMENT '最后互动（每日问安）时间，用于24小时冷却',
                last_dual_cultivation_time DATETIME NULL COMMENT '最后双修时间，用于24小时冷却',
                last_heart_tribulation_time DATETIME NULL COMMENT '最后心劫触发时间',
                broken_at DATETIME NULL COMMENT '解除时间（用于重新求婚冷却期计算）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_dc_player_a (player_a_id),
                INDEX idx_dc_player_b (player_b_id),
                INDEX idx_dc_status (status),
                INDEX idx_dc_pair_status (player_a_id, player_b_id, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家间道侣关系表（道侣/双修系统）'
        `);

        console.log('[Migration v0037] 迁移完成：创建道侣/双修系统表');
    },

    /**
     * 回滚迁移：删除 dao_companions 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0037] 开始回滚道侣/双修系统表...');

        try {
            await sequelize.query(`DROP TABLE IF EXISTS dao_companions`);
            console.log('  ✓ 删除表: dao_companions');
        } catch (e) {
            console.log(`  - 删除表失败，跳过: dao_companions（${e.message}）`);
        }

        console.log('[Migration v0037] 回滚完成');
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
