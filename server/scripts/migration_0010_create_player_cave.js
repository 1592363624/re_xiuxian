/**
 * 数据库迁移脚本
 * 版本: 0010
 * 描述: 创建玩家洞府表 player_caves
 * 创建时间: 2026-07-04
 *
 * 表用途：
 *   - 存储玩家洞府信息（灵脉/静室/丹房/器室/大阵等级）
 *   - 灵脉按时间累计产出灵石（玩家可领取）
 *   - player_id 唯一索引约束一人一洞府
 */

module.exports = {
    description: '创建玩家洞府表 player_caves',
    version: 10,

    async up(sequelize, QueryTypes) {
        console.log('[Migration v0010] 开始创建 player_caves 表...');

        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS player_caves (
                id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
                player_id BIGINT NOT NULL COMMENT '玩家ID',
                is_opened TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已开辟洞府',
                opened_at DATETIME NULL COMMENT '开辟洞府时间',
                spirit_vein_level INT NOT NULL DEFAULT 0 COMMENT '灵脉等级0-10',
                quiet_room_level INT NOT NULL DEFAULT 0 COMMENT '静室等级0-10',
                pill_room_level INT NOT NULL DEFAULT 0 COMMENT '丹房等级0-10',
                tool_room_level INT NOT NULL DEFAULT 0 COMMENT '器室等级0-10',
                grand_formation_level INT NOT NULL DEFAULT 0 COMMENT '护山大阵等级0-10',
                spirit_vein_accumulated BIGINT NOT NULL DEFAULT 0 COMMENT '灵脉累计产出灵石',
                spirit_vein_pending BIGINT NOT NULL DEFAULT 0 COMMENT '灵脉待领取灵石',
                last_spirit_vein_collect DATETIME NULL COMMENT '上次领取灵脉灵石时间',
                garden_plots INT NOT NULL DEFAULT 3 COMMENT '药园已开垦地块数',
                createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                UNIQUE KEY uk_player_id (player_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='玩家洞府表'
        `);

        console.log('  ✓ 创建表: player_caves');
        console.log('[Migration v0010] player_caves 表创建完成');
    },

    async down(sequelize, QueryTypes) {
        console.log('[Migration v0010] 回滚：删除 player_caves 表...');
        await sequelize.query('DROP TABLE IF EXISTS player_caves');
        console.log('[Migration v0010] 回滚完成');
    }
};
