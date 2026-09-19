/**
 * 数据库迁移脚本
 * 版本: 0009
 * 描述: 闭关系统重构——新增闭关模式、每日次数、每日计数重置日期字段
 * 创建时间: 2026-07-03
 *
 * 字段用途：
 *   - seclusion_mode: 闭关模式（normal=常规闭关 / deep=深度闭关），区分两种修炼方式
 *   - seclusion_end_time: 闭关预计结束时间（深度闭关为长线挂机，需要明确结束时间点）；已存在则复用
 *   - daily_seclusion_count: 今日常规闭关已用次数（每日按 last_seclusion_date 重置）
 *   - daily_deep_seclusion_count: 今日深度闭关已用次数（每日按 last_seclusion_date 重置）
 *   - last_seclusion_date: 最后一次闭关日期（DATEONLY），用于跨日重置每日次数
 *
 * 兼容性说明：
 *   - MySQL 5.6 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS 语法
 *   - 本脚本通过查询 information_schema.columns 判断列是否存在后再执行 ALTER TABLE，保证幂等
 */

module.exports = {
    description: '闭关系统重构——新增闭关模式与每日次数字段',
    version: 9,

    /**
     * 执行迁移：向 players 表添加闭关模式与每日次数相关字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0009] 开始为 players 表添加闭关重构字段...');

        // 检查列是否已存在（MySQL 5.6 兼容，避免使用 ADD COLUMN IF NOT EXISTS）
        const checkColumnSQL = `
            SELECT COUNT(*) as count 
            FROM information_schema.columns 
            WHERE table_schema = DATABASE() 
            AND table_name = 'players' 
            AND column_name = ?
        `;

        // ---- seclusion_mode 字段：闭关模式 ----
        const [modeResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['seclusion_mode'],
            type: QueryTypes.SELECT
        });
        if (modeResult.count === 0) {
            await sequelize.query(`
                ALTER TABLE players 
                ADD COLUMN seclusion_mode VARCHAR(10) NOT NULL DEFAULT 'normal' 
                COMMENT '闭关模式：normal=常规闭关，deep=深度闭关'
            `);
            console.log('  ✓ 添加字段: players.seclusion_mode');
        } else {
            console.log('  ⊘ 字段已存在: players.seclusion_mode');
        }

        // ---- daily_seclusion_count 字段：今日常规闭关次数 ----
        const [dailyCountResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['daily_seclusion_count'],
            type: QueryTypes.SELECT
        });
        if (dailyCountResult.count === 0) {
            await sequelize.query(`
                ALTER TABLE players 
                ADD COLUMN daily_seclusion_count INT NOT NULL DEFAULT 0 
                COMMENT '今日常规闭关已用次数（跨日重置）'
            `);
            console.log('  ✓ 添加字段: players.daily_seclusion_count');
        } else {
            console.log('  ⊘ 字段已存在: players.daily_seclusion_count');
        }

        // ---- daily_deep_seclusion_count 字段：今日深度闭关次数 ----
        const [dailyDeepResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['daily_deep_seclusion_count'],
            type: QueryTypes.SELECT
        });
        if (dailyDeepResult.count === 0) {
            await sequelize.query(`
                ALTER TABLE players 
                ADD COLUMN daily_deep_seclusion_count INT NOT NULL DEFAULT 0 
                COMMENT '今日深度闭关已用次数（跨日重置）'
            `);
            console.log('  ✓ 添加字段: players.daily_deep_seclusion_count');
        } else {
            console.log('  ⊘ 字段已存在: players.daily_deep_seclusion_count');
        }

        // ---- last_seclusion_date 字段：最后闭关日期（用于跨日重置每日次数）----
        const [lastDateResult] = await sequelize.query(checkColumnSQL, {
            replacements: ['last_seclusion_date'],
            type: QueryTypes.SELECT
        });
        if (lastDateResult.count === 0) {
            await sequelize.query(`
                ALTER TABLE players 
                ADD COLUMN last_seclusion_date DATE NULL 
                COMMENT '最后闭关日期（DATEONLY，跨日重置每日次数）'
            `);
            console.log('  ✓ 添加字段: players.last_seclusion_date');
        } else {
            console.log('  ⊘ 字段已存在: players.last_seclusion_date');
        }

        console.log('[Migration v0009] ✓ 迁移完成');
    },

    /**
     * 回滚迁移：删除闭关重构新增字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0009] 开始回滚：移除 players 表闭关重构字段...');

        const checkColumnSQL = `
            SELECT COUNT(*) as count 
            FROM information_schema.columns 
            WHERE table_schema = DATABASE() 
            AND table_name = 'players' 
            AND column_name = ?
        `;

        // 按添加的逆序移除
        const columnsToRemove = [
            'last_seclusion_date',
            'daily_deep_seclusion_count',
            'daily_seclusion_count',
            'seclusion_mode'
        ];

        for (const col of columnsToRemove) {
            const [result] = await sequelize.query(checkColumnSQL, {
                replacements: [col],
                type: QueryTypes.SELECT
            });
            if (result.count > 0) {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${col}`);
                console.log(`  ✓ 移除字段: players.${col}`);
            } else {
                console.log(`  ⊘ 字段不存在: players.${col}`);
            }
        }

        console.log('[Migration v0009] ✓ 回滚完成');
    }
};
