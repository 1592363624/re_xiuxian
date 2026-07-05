/**
 * 数据库迁移脚本
 * 版本: 0012
 * 描述: 为 player_equipment 表扩展法宝深度系统字段（耐久度、祭炼、本命法器、祭出）
 * 创建时间: 2026-07-04
 *
 * 新增字段：
 *   - durability / max_durability：耐久度系统，战斗损耗，需修理
 *   - refine_level：祭炼（精炼）等级 0~15
 *   - is_benming / benming_slot：本命法器标记与所在槽位
 *   - spirit_power：本命法器法力值
 *   - sort_order：装备排序顺序
 *   - is_summoned：本命法器是否已祭出
 *
 * 新增索引：
 *   - idx_player_benming：按玩家+本命标记查询（GM 后台查询本命列表）
 *   - idx_player_summoned：按玩家+祭出状态查询（战斗系统查询已祭出法器）
 *
 * MySQL 5.6 兼容性：
 *   - BOOLEAN 使用 TINYINT(1)
 *   - ALTER TABLE 添加多列时使用多个 ADD COLUMN 子句
 *   - 添加索引使用 CREATE INDEX
 */

module.exports = {
    description: '扩展 player_equipment 表，新增耐久度/祭炼/本命法器/祭出字段',
    version: 12,

    /**
     * 执行迁移：为 player_equipment 表添加新列与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async up(sequelize, QueryTypes) {
        console.log('[Migration v0012] 开始扩展 player_equipment 表...');

        // 1. 检查并添加新字段（每个字段单独检查，保证幂等）
        const columnsToAdd = [
            { name: 'durability', ddl: "ADD COLUMN durability INT NOT NULL DEFAULT 100 COMMENT '当前耐久度（<=0 时装备破碎）'" },
            { name: 'max_durability', ddl: "ADD COLUMN max_durability INT NOT NULL DEFAULT 100 COMMENT '最大耐久度（每次修理会扣减上限）'" },
            { name: 'refine_level', ddl: "ADD COLUMN refine_level INT NOT NULL DEFAULT 0 COMMENT '祭炼（精炼）等级 0~15'" },
            { name: 'is_benming', ddl: "ADD COLUMN is_benming TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否本命法器'" },
            { name: 'benming_slot', ddl: "ADD COLUMN benming_slot INT NULL COMMENT '本命槽位编号（1~max_slots）'" },
            { name: 'spirit_power', ddl: "ADD COLUMN spirit_power INT NOT NULL DEFAULT 0 COMMENT '本命法器法力值'" },
            { name: 'sort_order', ddl: "ADD COLUMN sort_order INT NOT NULL DEFAULT 0 COMMENT '装备排序顺序'" },
            { name: 'is_summoned', ddl: "ADD COLUMN is_summoned TINYINT(1) NOT NULL DEFAULT 0 COMMENT '本命法器是否已祭出'" }
        ];

        // 查询当前 player_equipment 表的所有列
        const [columns] = await sequelize.query(`
            SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_equipment'
        `);
        const existingColumns = columns.map(c => c.COLUMN_NAME);

        // 逐个添加缺失字段（MySQL 5.6 ALTER TABLE 一次只能一个 ADD COLUMN 较稳妥）
        for (const col of columnsToAdd) {
            if (!existingColumns.includes(col.name)) {
                await sequelize.query(`ALTER TABLE player_equipment ${col.ddl}`);
                console.log(`  ✓ 添加字段: ${col.name}`);
            } else {
                console.log(`  - 字段已存在，跳过: ${col.name}`);
            }
        }

        // 2. 添加辅助索引（先查询是否存在，幂等保证）
        const [indexes] = await sequelize.query(`
            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_equipment'
            GROUP BY INDEX_NAME
        `);
        const existingIndexes = indexes.map(i => i.INDEX_NAME);

        if (!existingIndexes.includes('idx_player_benming')) {
            await sequelize.query('CREATE INDEX idx_player_benming ON player_equipment(player_id, is_benming)');
            console.log('  ✓ 创建索引: idx_player_benming');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_benming');
        }

        if (!existingIndexes.includes('idx_player_summoned')) {
            await sequelize.query('CREATE INDEX idx_player_summoned ON player_equipment(player_id, is_summoned)');
            console.log('  ✓ 创建索引: idx_player_summoned');
        } else {
            console.log('  - 索引已存在，跳过: idx_player_summoned');
        }

        // 3. 旧数据初始化：所有现有装备的 max_durability 补齐为 100（DEFAULT 已生效，此处仅冗余保护）
        // DEFAULT 在 ALTER TABLE 时已自动为旧行填充，无需额外 UPDATE

        console.log('[Migration v0012] player_equipment 表扩展完成');
    },

    /**
     * 回滚迁移：移除新字段与索引
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    async down(sequelize, QueryTypes) {
        console.log('[Migration v0012] 回滚：移除 player_equipment 扩展字段...');

        // 先删除索引
        try { await sequelize.query('DROP INDEX idx_player_benming ON player_equipment'); } catch (e) { /* 索引可能不存在 */ }
        try { await sequelize.query('DROP INDEX idx_player_summoned ON player_equipment'); } catch (e) { /* 索引可能不存在 */ }

        // 再删除字段（MySQL 5.6 DROP COLUMN 一次只能一个）
        const colsToDrop = ['is_summoned', 'sort_order', 'spirit_power', 'benming_slot', 'is_benming', 'refine_level', 'max_durability', 'durability'];
        for (const col of colsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE player_equipment DROP COLUMN ${col}`);
                console.log(`  ✓ 删除字段: ${col}`);
            } catch (e) {
                console.log(`  - 字段不存在，跳过: ${col}`);
            }
        }

        console.log('[Migration v0012] 回滚完成');
    }
};
