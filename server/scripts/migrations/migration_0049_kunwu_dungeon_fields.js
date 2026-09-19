/**
 * 迁移脚本 0049：为 multi_dungeon_instance 表添加昆吾山·封魔塔专属字段
 *
 * 新增字段：
 *   - demonic_qi       INT NOT NULL DEFAULT 0  魔气值（0-100，>=100 副本失败）
 *   - mountain_seal    INT NOT NULL DEFAULT 30 山禁值（0-100，影响推进压力）
 *   - treasure_pressure INT NOT NULL DEFAULT 0 宝压值（0-100，夺宝反噬与爆发收益）
 *   - linglong         INT NOT NULL DEFAULT 50 玲珑值（0-100，塔影线索与神念清明）
 *   - tower_shadow_hp  BIGINT NULL             塔心魔影HP（第四幕使用）
 *   - seal_progress    INT NULL                封印推进值（第四幕使用，需>=80通关）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 */
'use strict';

module.exports = {
    name: '0049_kunwu_dungeon_fields',
    description: '为 multi_dungeon_instance 添加昆吾山·封魔塔专属字段',
    up: async (sequelize, QueryTypes) => {
        // 检查列是否存在的辅助函数
        async function columnExists(columnName) {
            const [result] = await sequelize.query(
                `SELECT COUNT(*) AS cnt
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'multi_dungeon_instance'
                   AND COLUMN_NAME = :colName`,
                { replacements: { colName: columnName }, type: QueryTypes.SELECT }
            );
            return result && result.cnt > 0;
        }

        async function addColumn(columnName, columnDef) {
            if (await columnExists(columnName)) {
                console.log(`[migration_0049] 列 ${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0049] 添加列 ${columnName}`);
            await sequelize.query(
                `ALTER TABLE multi_dungeon_instance ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // 依次添加 6 个新字段（幂等）
        await addColumn('demonic_qi', 'INT NOT NULL DEFAULT 0 COMMENT \'昆吾山·魔气值（0-100，>=100 副本失败）\'');
        await addColumn('mountain_seal', 'INT NOT NULL DEFAULT 30 COMMENT \'昆吾山·山禁值（0-100，影响推进压力）\'');
        await addColumn('treasure_pressure', 'INT NOT NULL DEFAULT 0 COMMENT \'昆吾山·宝压值（0-100，夺宝反噬与爆发收益）\'');
        await addColumn('linglong', 'INT NOT NULL DEFAULT 50 COMMENT \'昆吾山·玲珑值（0-100，塔影线索与神念清明）\'');
        await addColumn('tower_shadow_hp', 'BIGINT NULL COMMENT \'昆吾山·塔心魔影HP（第四幕使用）\'');
        await addColumn('seal_progress', 'INT NULL COMMENT \'昆吾山·封印推进值（第四幕使用，需>=80通关）\'');

        console.log('[migration_0049] 昆吾山·封魔塔字段迁移完成');
    },

    down: async (sequelize, QueryTypes) => {
        // 回滚：删除新增字段（MySQL 5.6 支持单条 ALTER DROP 多列）
        const columnsToDrop = [
            'demonic_qi', 'mountain_seal', 'treasure_pressure',
            'linglong', 'tower_shadow_hp', 'seal_progress'
        ];

        for (const col of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE multi_dungeon_instance DROP COLUMN ${col}`);
                console.log(`[migration_0049] 已删除列 ${col}`);
            } catch (e) {
                console.log(`[migration_0049] 删除列 ${col} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
