/**
 * 数据库迁移脚本
 * 版本: 47
 * 描述: 太一门引道系统（玩法文档第25节 太一门引道，五行道途+神识联动+多人共鸣）
 * 创建时间: 2026-07-21
 *
 * 设计要点：
 *   1. player_taoism_gate 表：玩家太一门道途记录（道途/等级/经验/技能冷却/日常任务）
 *   2. 幂等性：所有 CREATE/ALTER 前先检查存在性
 *   3. 参数化查询防 SQL 注入
 *
 * 字段说明：
 *   - player_id：玩家ID（UNIQUE）
 *   - dao_path：当前道途（metal/wood/water/fire/earth/null=未选择）
 *   - dao_level：道途等级（1-10）
 *   - dao_exp：道途经验（累计，用于升级）
 *   - skill_cooldowns：技能冷却（JSON，{skill_id: cooldown_end_time}）
 *   - last_switch_time：上次道途切换时间（用于切换冷却）
 *   - daily_tasks：今日任务（JSON，[{task_type, target_count, current_count, completed, rewards_claimed}]）
 *   - daily_task_reset_time：任务重置时间（用于跨日重置）
 *   - total_cultivate_count：累计修炼次数（统计）
 *   - total_skill_use_count：累计技能使用次数（统计）
 *   - total_resonance_count：累计共鸣次数（统计）
 */
'use strict';

module.exports = {
    description: '太一门引道系统：player_taoism_gate 表（5种道途+等级+技能+日常任务+共鸣统计）',
    version: 47,

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

        // 1. 创建 player_taoism_gate 表
        const tableName = 'player_taoism_gate';
        if (!(await tableExists(tableName))) {
            await sequelize.query(`
                CREATE TABLE \`${tableName}\` (
                    \`id\` BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    \`player_id\` BIGINT NOT NULL COMMENT '玩家ID',
                    \`dao_path\` VARCHAR(10) NULL DEFAULT NULL COMMENT '当前道途（metal/wood/water/fire/earth，null=未选择）',
                    \`dao_level\` INT NOT NULL DEFAULT 1 COMMENT '道途等级（1-10）',
                    \`dao_exp\` INT NOT NULL DEFAULT 0 COMMENT '道途经验（累计，用于升级）',
                    \`skill_cooldowns\` JSON NULL COMMENT '技能冷却（JSON，{skill_id: cooldown_end_time}）',
                    \`last_switch_time\` DATETIME NULL COMMENT '上次道途切换时间',
                    \`daily_tasks\` JSON NULL COMMENT '今日任务列表（JSON数组）',
                    \`daily_task_reset_time\` DATETIME NULL COMMENT '任务重置时间（跨日重置）',
                    \`total_cultivate_count\` INT NOT NULL DEFAULT 0 COMMENT '累计修炼次数',
                    \`total_skill_use_count\` INT NOT NULL DEFAULT 0 COMMENT '累计技能使用次数',
                    \`total_resonance_count\` INT NOT NULL DEFAULT 0 COMMENT '累计共鸣次数',
                    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                    PRIMARY KEY (\`id\`),
                    UNIQUE KEY \`uk_ptg_player\` (\`player_id\`),
                    INDEX \`idx_ptg_path\` (\`dao_path\`),
                    INDEX \`idx_ptg_level\` (\`dao_level\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='太一门引道系统玩家道途记录';
            `);
            console.log(`[Migration 47] 表 ${tableName} 创建成功`);
        } else {
            console.log(`[Migration 47] 表 ${tableName} 已存在，跳过`);
        }
    },

    /**
     * 回滚迁移（幂等）
     */
    async down(sequelizeInstance, QueryTypes) {
        const sequelize = sequelizeInstance;
        await sequelize.query(`DROP TABLE IF EXISTS \`player_taoism_gate\`;`);
        console.log('[Migration 47] 已回滚：删除 player_taoism_gate 表');
    }
};
