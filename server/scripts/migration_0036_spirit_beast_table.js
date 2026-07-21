/**
 * 数据库迁移脚本
 * 版本: 0036
 * 描述: 灵兽系统（1 张新表：spirit_beasts 灵兽实例表）
 * 创建时间: 2026-07-20
 *
 * 新建表：
 *   spirit_beasts - 灵兽实例表（玩家捕获的每只灵兽完整信息）
 *
 * 设计要点：
 *   - player_id 单字段索引：按玩家查灵兽列表（最高频查询）
 *   - (player_id, is_active) 复合索引：快速查询玩家出战灵兽（同时仅1只）
 *   - beast_key 索引：按种类统计图鉴捕获情况
 *   - exp/hp_max 使用 BIGINT，避免高等级数值溢出
 *   - 字符集 utf8mb4 保证中文昵称/描述存储
 *   - ENGINE=InnoDB 支持事务与行级锁
 *
 * 幂等性：表创建前检查 INFORMATION_SCHEMA.TABLES
 *
 * MySQL 5.6 兼容性：
 *   - 使用 TINYINT(1) 表示 BOOLEAN（Sequelize 会自动转换）
 *   - DATETIME 类型用于时间字段
 *   - 无 JSON 类型字段
 */

module.exports = {
    description: '灵兽系统：1 张新表（spirit_beasts 灵兽实例表）',
    version: 36,

    /**
     * 执行迁移：创建 spirit_beasts 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0036] 开始创建灵兽系统表...');

        // ===== spirit_beasts 表：灵兽实例表 =====
        await createTableIfNotExists(sequelize, 'spirit_beasts', `
            CREATE TABLE spirit_beasts (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '灵兽实例ID',
                player_id BIGINT NOT NULL COMMENT '所属玩家ID',
                beast_key VARCHAR(50) NOT NULL COMMENT '灵兽种类key（如 qingyun_wolf）',
                beast_name VARCHAR(50) NULL COMMENT '自定义昵称（null 时显示默认名）',
                element VARCHAR(20) NOT NULL COMMENT '元素属性：metal/wood/water/fire/earth',
                rarity VARCHAR(20) NOT NULL COMMENT '稀有度：common/rare/epic/legendary',
                star_level INT NOT NULL DEFAULT 1 COMMENT '星级（1-10）',
                level INT NOT NULL DEFAULT 1 COMMENT '等级（1-100）',
                exp BIGINT NOT NULL DEFAULT 0 COMMENT '当前经验值',
                hp_max BIGINT NOT NULL DEFAULT 0 COMMENT '气血上限',
                atk INT NOT NULL DEFAULT 0 COMMENT '攻击',
                def INT NOT NULL DEFAULT 0 COMMENT '防御',
                speed INT NOT NULL DEFAULT 0 COMMENT '速度',
                loyalty INT NOT NULL DEFAULT 50 COMMENT '忠诚度（0-100）',
                is_active TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否出战中（同一玩家同时仅1只true）',
                last_feed_time DATETIME NULL COMMENT '最后喂养时间（冷却1小时）',
                last_interact_time DATETIME NULL COMMENT '最后互动时间（冷却10分钟）',
                caught_at DATETIME NULL COMMENT '捕获时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                INDEX idx_sb_player (player_id),
                INDEX idx_sb_player_active (player_id, is_active),
                INDEX idx_sb_beast_key (beast_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='灵兽实例表'
        `);

        console.log('[Migration v0036] 迁移完成：创建灵兽系统表');
    },

    /**
     * 回滚迁移：删除 spirit_beasts 表
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0036] 开始回滚灵兽系统表...');

        try {
            await sequelize.query(`DROP TABLE IF EXISTS spirit_beasts`);
            console.log('  ✓ 删除表: spirit_beasts');
        } catch (e) {
            console.log(`  - 删除表失败，跳过: spirit_beasts（${e.message}）`);
        }

        console.log('[Migration v0036] 回滚完成');
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
