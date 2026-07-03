/**
 * 数据库迁移脚本
 * 版本: 0005
 * 描述: 创建玩家宗门成员关系表 player_sects
 * 创建时间: 2026-07-03
 *
 * 表用途：
 *   - 存储玩家与宗门的归属关系及宗门内动态数据（贡献度、身份、点卯、传功、日常任务进度）
 *   - 通过 player_id 唯一索引约束"一个玩家同时只能加入一个宗门"
 *   - 宗门的静态属性（名称、宝库、任务）从 sect_data.json 读取，不入库
 *
 * 字段说明：
 *   - daily_quests_completed 使用 TEXT 存 JSON 数组字符串，由模型 get/set 访问器序列化
 *   - 时间字段使用 DATETIME（Sequelize DataTypes.DATE 在 MySQL 的映射），需精确到时分秒以支持冷却判断
 */

module.exports = {
    description: '创建玩家宗门成员关系表 player_sects',
    version: 5,

    /**
     * 执行迁移：创建 player_sects 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0005] 开始创建 player_sects 表...');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS player_sects (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID（一个玩家只能加入一个宗门）',
                sect_id VARCHAR(50) NOT NULL COMMENT '宗门ID（对应 sect_data.json 的 sects[].id）',
                contribution INT NOT NULL DEFAULT 0 COMMENT '宗门贡献度（用于兑换宝库物品）',
                role VARCHAR(20) NOT NULL DEFAULT 'disciple' COMMENT '在宗门身份（disciple弟子/elder长老）',
                joined_at DATETIME NULL COMMENT '加入宗门时间',
                last_check_in DATETIME NULL COMMENT '上次点卯时间（用于24小时冷却判断）',
                last_transfer DATETIME NULL COMMENT '上次传功时间（用于传功冷却判断）',
                daily_quests_completed TEXT COMMENT '当日已完成任务ID（JSON数组字符串）',
                quests_reset_at DATETIME NULL COMMENT '任务重置时间（用于判断每日任务是否需要清零）',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_player_sect (player_id),
                KEY idx_sect_id (sect_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家宗门成员关系表'
        `);

        console.log('  ✓ 创建表: player_sects');
        console.log('[Migration v0005] player_sects 表创建完成');
    },

    /**
     * 回滚迁移：删除 player_sects 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0005] 回滚：删除 player_sects 表...');
        await sequelize.query('DROP TABLE IF EXISTS player_sects');
        console.log('[Migration v0005] 回滚完成');
    }
};
