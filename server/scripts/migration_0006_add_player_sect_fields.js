/**
 * 数据库迁移脚本
 * 版本: 0006
 * 描述: 给 players 表增加宗门相关字段（sect_id, sect_contribution）
 * 创建时间: 2026-07-03
 *
 * 字段用途：
 *   - sect_id: 玩家所属宗门ID（冗余字段，便于快速查询玩家宗门归属，避免每次 join player_sects 表）
 *   - sect_contribution: 玩家宗门贡献度（冗余字段，便于排行榜等聚合查询）
 *
 * 兼容性说明：
 *   - MySQL 5.6 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS 语法
 *   - 本脚本通过查询 information_schema.columns 判断列是否存在后再执行 ALTER TABLE，
 *     保证可重复执行（幂等），与 migration_0001 的处理方式一致
 */

module.exports = {
    description: '给 players 表增加宗门相关字段（sect_id, sect_contribution）',
    version: 6,

    /**
     * 执行迁移：向 players 表添加 sect_id、sect_contribution 字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0006] 开始为 players 表添加宗门相关字段...');

        // 检查列是否已存在的 SQL（MySQL 5.6 兼容，避免使用 ADD COLUMN IF NOT EXISTS）
        const checkColumnSQL = `
            SELECT COUNT(*) as count 
            FROM information_schema.columns 
            WHERE table_schema = DATABASE() 
            AND table_name = 'players' 
            AND column_name = ?
        `;

        // ---- sect_id 字段 ----
        const [sectIdResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['sect_id'],
            type: QueryTypes.SELECT
        });
        if (sectIdResult.count === 0) {
            await sequelize.query(`
                ALTER TABLE players 
                ADD COLUMN sect_id VARCHAR(50) NULL 
                COMMENT '所属宗门ID（冗余字段，便于快速查询）'
            `);
            console.log('  ✓ 添加字段: players.sect_id');
        } else {
            console.log('  ⊘ 字段已存在: players.sect_id');
        }

        // ---- sect_contribution 字段 ----
        const [contribResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['sect_contribution'],
            type: QueryTypes.SELECT
        });
        if (contribResult.count === 0) {
            await sequelize.query(`
                ALTER TABLE players 
                ADD COLUMN sect_contribution INT NOT NULL DEFAULT 0 
                COMMENT '宗门贡献度（冗余字段，便于排行榜聚合查询）'
            `);
            console.log('  ✓ 添加字段: players.sect_contribution');
        } else {
            console.log('  ⊘ 字段已存在: players.sect_contribution');
        }

        console.log('[Migration v0006] ✓ 迁移完成');
    },

    /**
     * 回滚迁移：删除 players 表的 sect_id、sect_contribution 字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0006] 开始回滚：移除 players 表宗门相关字段...');

        // 同样需要检查列是否存在后再 DROP，避免 MySQL 5.6 不支持 DROP COLUMN IF EXISTS
        const checkColumnSQL = `
            SELECT COUNT(*) as count 
            FROM information_schema.columns 
            WHERE table_schema = DATABASE() 
            AND table_name = 'players' 
            AND column_name = ?
        `;

        // ---- 移除 sect_contribution ----
        const [contribResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['sect_contribution'],
            type: QueryTypes.SELECT
        });
        if (contribResult.count > 0) {
            await sequelize.query(`ALTER TABLE players DROP COLUMN sect_contribution`);
            console.log('  ✓ 移除字段: players.sect_contribution');
        } else {
            console.log('  ⊘ 字段不存在: players.sect_contribution');
        }

        // ---- 移除 sect_id ----
        const [sectIdResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['sect_id'],
            type: QueryTypes.SELECT
        });
        if (sectIdResult.count > 0) {
            await sequelize.query(`ALTER TABLE players DROP COLUMN sect_id`);
            console.log('  ✓ 移除字段: players.sect_id');
        } else {
            console.log('  ⊘ 字段不存在: players.sect_id');
        }

        console.log('[Migration v0006] ✓ 回滚完成');
    }
};
