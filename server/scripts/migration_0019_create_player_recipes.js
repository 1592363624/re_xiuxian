/**
 * 迁移脚本 0019：创建玩家炼制配方表
 *
 * 功能：创建 player_recipes 表，存储玩家已学习的炼制配方及炼制技能信息
 * 设计：
 *   - player_id + recipe_id 唯一索引，防止重复学习
 *   - skill_exp / skill_level 记录炼制技能成长（所有配方共享）
 *   - last_craft_at 用于冷却时间判断
 *
 * 运行时机：服务器启动时由 migration_manager 自动执行
 */
module.exports = {
    version: '0019',
    description: '创建玩家炼制配方表 player_recipes',

    /**
     * 执行迁移（创建表）
     * @param {Object} sequelize - Sequelize 实例
     */
    async up(sequelize) {
        const { QueryTypes } = require('sequelize');

        // 检查表是否已存在
        const [results] = await sequelize.query(
            `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_recipes'`,
            { type: QueryTypes.SELECT }
        ).catch(() => [null]);

        if (results) {
            console.log('[迁移0019] player_recipes 表已存在，跳过创建');
            return;
        }

        // 创建 player_recipes 表
        await sequelize.query(`
            CREATE TABLE player_recipes (
                id BIGINT NOT NULL AUTO_INCREMENT COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                recipe_id VARCHAR(100) NOT NULL COMMENT '配方ID',
                craft_type VARCHAR(20) NOT NULL COMMENT '炼制类型（alchemy炼丹/refining炼器）',
                craft_count INT NOT NULL DEFAULT 0 COMMENT '累计炼制次数',
                skill_exp INT NOT NULL DEFAULT 0 COMMENT '炼制技能经验值',
                skill_level INT NOT NULL DEFAULT 1 COMMENT '炼制技能等级（1~10）',
                last_craft_at DATETIME NULL COMMENT '上次炼制时间',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '学习时间',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                PRIMARY KEY (id),
                UNIQUE KEY uk_player_recipe (player_id, recipe_id),
                KEY idx_player_id (player_id),
                KEY idx_player_craft_type (player_id, craft_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家炼制配方表'
        `);

        console.log('[迁移0019] player_recipes 表创建成功');
    },

    /**
     * 回滚迁移（删除表）
     * @param {Object} sequelize - Sequelize 实例
     */
    async down(sequelize) {
        await sequelize.query('DROP TABLE IF EXISTS player_recipes');
        console.log('[迁移0019] player_recipes 表已删除');
    }
};
