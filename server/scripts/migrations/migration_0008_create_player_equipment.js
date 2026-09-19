/**
 * 数据库迁移脚本
 * 版本: 0008
 * 描述: 创建玩家装备表 player_equipment，用于装备穿戴系统
 * 创建时间: 2026-07-03
 *
 * 表用途：
 *   - 存储玩家已穿戴的装备记录（每个槽位一件）
 *   - player_id 关联 players 表
 *   - slot 标识装备槽位（weapon/armor/accessory/boots/dharma）
 *   - item_key 关联 item_data.json 静态配置
 *
 * 索引设计：
 *   - uk_player_slot：唯一索引，约束一个玩家每个槽位只能装备一件
 *   - idx_player_id：按玩家查询所有装备（高频查询）
 *
 * MySQL 5.6 兼容性：
 *   - 使用 BIGINT AUTO_INCREMENT 主键
 *   - 字符集 utf8mb4，排序规则 utf8mb4_unicode_ci
 */

module.exports = {
    description: '创建玩家装备表 player_equipment',
    version: 8,

    /**
     * 执行迁移：创建 player_equipment 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0008] 开始创建 player_equipment 表...');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS player_equipment (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                slot VARCHAR(20) NOT NULL COMMENT '装备槽位（weapon武器/armor护甲/accessory饰品/boots靴子/dharma法器）',
                item_key VARCHAR(100) NOT NULL COMMENT '装备的物品配置键名',
                equipped_at DATETIME NULL COMMENT '装备穿戴时间',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                UNIQUE KEY uk_player_slot (player_id, slot),
                INDEX idx_player_id (player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家装备表（已穿戴的装备）'
        `);

        console.log('  ✓ 创建表: player_equipment');
        console.log('[Migration v0008] player_equipment 表创建完成');
    },

    /**
     * 回滚迁移：删除 player_equipment 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0008] 回滚：删除 player_equipment 表...');
        await sequelize.query('DROP TABLE IF EXISTS player_equipment');
        console.log('[Migration v0008] 回滚完成');
    }
};
