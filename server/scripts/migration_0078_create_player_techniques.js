/**
 * 迁移 0078：创建 player_techniques 表（功法系统）
 *
 * 用途：承载玩家功法习得与修炼进度数据，打通"功法加成"此前在
 *       AttributeService.calculateFullAttributes 中的硬编码占位（cultivation: 全 0）。
 *
 * 表结构说明：
 *   - 功法静态数据（品阶/加成/五行）存于 technique_data.json，本表只存玩家侧动态进度
 *   - uk_player_technique 唯一索引保证同一玩家同一功法只有一条记录
 *   - idx_player_equip 用于属性计算时快速查询已装备功法（高频路径）
 */
module.exports = {
    description: '创建 player_techniques 表（功法系统：习得记录、层数、熟练度、装备槽位、已领悟神通）',

    async up(sequelize, QueryTypes) {
        // 检查表是否已存在，避免重复执行报错
        const [tables] = await sequelize.query(`
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_techniques'
        `);

        if (tables.length > 0) {
            console.log('[Migration 0078] ⏭ 表已存在，跳过: player_techniques');
            return;
        }

        await sequelize.query(`
            CREATE TABLE \`player_techniques\` (
                \`id\` BIGINT NOT NULL AUTO_INCREMENT COMMENT '记录ID',
                \`player_id\` BIGINT NOT NULL COMMENT '玩家ID',
                \`technique_id\` VARCHAR(100) NOT NULL COMMENT '功法ID（对应 technique_data.json）',
                \`layer\` INT NOT NULL DEFAULT 1 COMMENT '当前功法层数',
                \`proficiency\` INT NOT NULL DEFAULT 0 COMMENT '当前层熟练度',
                \`equip_slot\` VARCHAR(20) NULL DEFAULT NULL COMMENT '装备槽位（main/auxiliary/NULL）',
                \`comprehended_skills\` JSON NOT NULL COMMENT '已领悟的神通ID数组',
                \`fail_streak\` INT NOT NULL DEFAULT 0 COMMENT '连续突破失败次数（保底机制）',
                \`practice_count\` INT NOT NULL DEFAULT 0 COMMENT '累计修炼次数',
                \`daily_practice_count\` INT NOT NULL DEFAULT 0 COMMENT '今日修炼次数',
                \`daily_practice_date\` DATE NULL DEFAULT NULL COMMENT '今日次数对应日期（跨天重置）',
                \`last_practice_at\` DATETIME NULL DEFAULT NULL COMMENT '上次修炼时间（冷却判断）',
                \`last_comprehend_at\` DATETIME NULL DEFAULT NULL COMMENT '上次领悟时间（冷却判断）',
                \`acquired_at\` DATETIME NULL DEFAULT NULL COMMENT '习得时间',
                \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (\`id\`),
                UNIQUE KEY \`uk_player_technique\` (\`player_id\`, \`technique_id\`),
                KEY \`idx_player\` (\`player_id\`),
                KEY \`idx_player_equip\` (\`player_id\`, \`equip_slot\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家功法表'
        `);

        console.log('[Migration 0078] ✓ 已创建表: player_techniques');
        console.log('[Migration 0078] ✓ 迁移完成');
    },

    async down(sequelize, QueryTypes) {
        await sequelize.query('DROP TABLE IF EXISTS `player_techniques`');
        console.log('[Migration 0078] ✓ 已删除表: player_techniques');
        console.log('[Migration 0078] ✓ 回滚完成');
    }
};
