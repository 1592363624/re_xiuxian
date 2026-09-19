/**
 * 数据库迁移脚本
 * 版本: 0015
 * 描述: 为 players 表新增 PVP/当铺/股市相关字段
 * 创建时间: 2026-07-05
 *
 * 新增字段（共 9 个）：
 *   PVP 系统：
 *   - pvp_score：PVP 积分（冗余字段，便于查询）
 *   - pvp_rank：PVP 段位名称
 *   - honor：荣誉值（PVP 专用货币）
 *   - karma：因果值（跨境界欺凌累积，影响心魔）
 *   - weakness_end_time：虚弱状态结束时间（PVP 失败惩罚）
 *
 *   当铺系统：
 *   - pawnshop_credit：当铺信用额度（影响典当折扣率）
 *
 *   股市系统：
 *   - stock_account_balance：股市账户余额（与 spirit_stones 分账）
 *   - stock_margin_debt：融资负债金额
 *   - is_stock_trading_locked：是否禁止股市交易（GM 可锁定）
 *
 * 新增索引：
 *   - idx_player_pvp_score：按 PVP 积分倒序，便于排行榜
 *   - idx_player_weakness：按虚弱结束时间，便于状态清理
 *
 * 幂等性：每个字段单独检查 INFORMATION_SCHEMA.COLUMNS 后 ADD COLUMN
 *
 * MySQL 5.6 兼容性：
 *   - BOOLEAN 使用 TINYINT(1)
 *   - 每列单独 ALTER TABLE，避免多列同时 ADD 失败
 */

module.exports = {
    description: '为 players 表新增 PVP/当铺/股市相关字段（共 9 个字段 + 2 个索引）',
    version: 15,

    /**
     * 执行迁移：为 players 表添加 PVP/当铺/股市相关字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0015] 开始扩展 players 表（PVP/当铺/股市字段）...');

        // 待添加字段列表（按业务分组）
        const columnsToAdd = [
            // ===== PVP 系统字段 =====
            { name: 'pvp_score', ddl: "ADD COLUMN pvp_score INT NOT NULL DEFAULT 0 COMMENT 'PVP积分（冗余字段，便于查询）'" },
            { name: 'pvp_rank', ddl: "ADD COLUMN pvp_rank VARCHAR(20) NOT NULL DEFAULT '散修' COMMENT 'PVP段位名称'" },
            { name: 'honor', ddl: "ADD COLUMN honor BIGINT NOT NULL DEFAULT 0 COMMENT '荣誉值（PVP专用货币）'" },
            { name: 'karma', ddl: "ADD COLUMN karma INT NOT NULL DEFAULT 0 COMMENT '因果值（跨境界欺凌累积，影响心魔）'" },
            { name: 'weakness_end_time', ddl: "ADD COLUMN weakness_end_time DATETIME NULL COMMENT '虚弱状态结束时间（PVP失败惩罚）'" },
            // ===== 当铺系统字段 =====
            { name: 'pawnshop_credit', ddl: "ADD COLUMN pawnshop_credit INT NOT NULL DEFAULT 0 COMMENT '当铺信用额度（影响典当折扣率）'" },
            // ===== 股市系统字段 =====
            { name: 'stock_account_balance', ddl: "ADD COLUMN stock_account_balance BIGINT NOT NULL DEFAULT 0 COMMENT '股市账户余额（与spirit_stones分账）'" },
            { name: 'stock_margin_debt', ddl: "ADD COLUMN stock_margin_debt BIGINT NOT NULL DEFAULT 0 COMMENT '融资负债金额'" },
            { name: 'is_stock_trading_locked', ddl: "ADD COLUMN is_stock_trading_locked TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否禁止股市交易（GM可锁定）'" }
        ];

        // 查询当前 players 表的所有列
        const [columns] = await sequelize.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingColumns = columns.map(c => c.COLUMN_NAME);

        // 逐个添加缺失字段
        let addedCount = 0;
        for (const col of columnsToAdd) {
            if (!existingColumns.includes(col.name)) {
                await sequelize.query(`ALTER TABLE players ${col.ddl}`);
                console.log(`  ✓ 添加字段: ${col.name}`);
                addedCount++;
            } else {
                console.log(`  - 字段已存在，跳过: ${col.name}`);
            }
        }

        // 新增索引
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        // PVP 积分倒序索引（排行榜查询用）
        if (!existingIndexes.includes('idx_player_pvp_score')) {
            await sequelize.query('CREATE INDEX idx_player_pvp_score ON players (pvp_score DESC)');
            console.log('  ✓ 添加索引: idx_player_pvp_score');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_pvp_score');
        }

        // 虚弱状态索引（状态清理调度器用）
        if (!existingIndexes.includes('idx_player_weakness')) {
            await sequelize.query('CREATE INDEX idx_player_weakness ON players (weakness_end_time)');
            console.log('  ✓ 添加索引: idx_player_weakness');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_weakness');
        }

        console.log(`[Migration v0015] 迁移完成：新增 ${addedCount} 个字段`);
    },

    /**
     * 回滚迁移：删除新增字段与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0015] 开始回滚 players 表扩展字段...');

        // 删除索引
        try { await sequelize.query('DROP INDEX idx_player_weakness ON players'); console.log('  ✓ 删除索引: idx_player_weakness'); } catch (e) { console.log('  - 索引不存在，跳过'); }
        try { await sequelize.query('DROP INDEX idx_player_pvp_score ON players'); console.log('  ✓ 删除索引: idx_player_pvp_score'); } catch (e) { console.log('  - 索引不存在，跳过'); }

        // 删除字段（倒序删除，避免依赖问题）
        const fieldsToDrop = [
            'is_stock_trading_locked',
            'stock_margin_debt',
            'stock_account_balance',
            'pawnshop_credit',
            'weakness_end_time',
            'karma',
            'honor',
            'pvp_rank',
            'pvp_score'
        ];

        for (const f of fieldsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE players DROP COLUMN ${f}`);
                console.log(`  ✓ 删除字段: ${f}`);
            } catch (e) {
                console.log(`  - 字段不存在或删除失败，跳过: ${f}`);
            }
        }

        console.log('[Migration v0015] 回滚完成');
    }
};
