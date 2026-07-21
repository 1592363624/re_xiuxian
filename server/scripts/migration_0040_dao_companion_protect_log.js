/**
 * 数据库迁移脚本
 * 版本: 0040
 * 描述: 道侣护道日志表（1 张新表：dao_companion_protect_log 护道事件记录）
 * 创建时间: 2026-07-20
 *
 * 新建表：
 *   dao_companion_protect_log - 道侣护道日志表
 *     记录每次 PVP/宗门战中道侣护道触发的事件详情
 *     用于玩家查询护道历史、护道统计、双账号协同复盘
 *
 * 设计要点：
 *   - companion_id 关联 dao_companions.id，便于按道侣关系聚合查询
 *   - attacker_id / defender_id / protector_id 三方玩家ID均加索引
 *   - original_damage / shared_damage / counter_damage 使用 BIGINT（与玩家HP一致）
 *   - battle_type 区分 pvp（PvpService）/ sect_war（SectWarService）等战斗场景
 *   - battle_id 关联 pvp_battle_records.id 或 sect_war_battle_records.id
 *   - 字符集 utf8mb4 保证中文备注存储
 *   - ENGINE=InnoDB 支持事务
 *
 * 幂等性：表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - DATETIME 类型用于时间字段
 *   - VARCHAR(32) 用于 battle_type 枚举字符串（避免 ENUM 修改成本）
 *   - BIGINT 用于伤害值（避免溢出）
 */

module.exports = {
    description: '道侣护道日志表：1 张新表（dao_companion_protect_log 护道事件记录）',
    version: 40,

    /**
     * 执行迁移：创建 dao_companion_protect_log 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0040] 开始创建道侣护道日志表...');

        // ===== dao_companion_protect_log 表：道侣护道事件日志 =====
        await createTableIfNotExists(sequelize, 'dao_companion_protect_log', `
            CREATE TABLE dao_companion_protect_log (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '护道日志主键ID',
                companion_id BIGINT NOT NULL COMMENT '道侣关系ID（关联 dao_companions.id）',
                attacker_id BIGINT NOT NULL COMMENT '攻击方玩家ID',
                defender_id BIGINT NOT NULL COMMENT '被攻击方玩家ID（护道触发者）',
                protector_id BIGINT NOT NULL COMMENT '护道方玩家ID（道侣）',
                original_damage BIGINT NOT NULL DEFAULT 0 COMMENT '原始伤害值',
                shared_damage BIGINT NOT NULL DEFAULT 0 COMMENT '护道方分担的伤害值',
                counter_damage BIGINT NOT NULL DEFAULT 0 COMMENT '护道方反击伤害值',
                heart_contract_level INT NOT NULL DEFAULT 0 COMMENT '触发时的心契等级（2-9）',
                protect_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '触发概率（0.0000-1.0000）',
                damage_share_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '伤害分担比例',
                counter_attack_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '反击概率',
                battle_type VARCHAR(32) NOT NULL DEFAULT 'pvp' COMMENT '战斗类型：pvp/sect_war/world_boss 等',
                battle_id BIGINT NULL COMMENT '战斗记录ID（关联 pvp_battle_records 或 sect_war_battle_records）',
                battle_round INT NULL COMMENT '战斗回合数（PVP用）',
                remark VARCHAR(255) NULL COMMENT '备注（如：心契L2 首次护道/双修共历心劫 等）',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '护道触发时间',
                INDEX idx_dcpl_defender (defender_id),
                INDEX idx_dcpl_protector (protector_id),
                INDEX idx_dcpl_companion (companion_id),
                INDEX idx_dcpl_attacker (attacker_id),
                INDEX idx_dcpl_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='道侣护道日志表'
        `);

        console.log('[Migration v0040] 道侣护道日志表创建完成');
    },

    /**
     * 回滚迁移：删除 dao_companion_protect_log 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0040] 回滚：删除 dao_companion_protect_log 表...');
        await sequelize.query(`DROP TABLE IF EXISTS dao_companion_protect_log`);
        console.log('[Migration v0040] 回滚完成');
    }
};

/**
 * 幂等创建表工具函数
 * @param {Object} sequelize - Sequelize 实例
 * @param {string} tableName - 表名
 * @param {string} createSql - CREATE TABLE SQL 语句
 */
async function createTableIfNotExists(sequelize, tableName, createSql) {
    // 检查表是否已存在（INFORMATION_SCHEMA 兼容 MySQL 5.6+）
    const [results] = await sequelize.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        { replacements: [tableName] }
    );
    if (results && results.length > 0) {
        console.log(`[Migration v0040] 表 ${tableName} 已存在，跳过创建`);
        return;
    }
    await sequelize.query(createSql);
    console.log(`[Migration v0040] 表 ${tableName} 创建成功`);
}
