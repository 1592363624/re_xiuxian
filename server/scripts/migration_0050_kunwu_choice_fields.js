/**
 * 迁移脚本 0050：为 multi_dungeon_choice 表添加昆吾山·封魔塔专属变量变化字段
 *
 * 新增字段：
 *   - demonic_qi_change       INT NOT NULL DEFAULT 0  魔气变化
 *   - mountain_seal_change    INT NOT NULL DEFAULT 0  山禁变化
 *   - treasure_pressure_change INT NOT NULL DEFAULT 0 宝压变化
 *   - linglong_change         INT NOT NULL DEFAULT 0  玲珑变化
 *   - seal_progress_change    INT NOT NULL DEFAULT 0  封印推进变化
 *   - tower_shadow_hp_change  BIGINT NULL              塔心魔影HP变化（第四幕自动战斗记录用）
 *   - round_number            INT NULL                 第四幕自动战斗回合数（仅第四幕有值）
 *   - eye_key                 VARCHAR(50) NULL          第三幕阵眼键（如 baling_eye/dragon_eye/blackwind_eye）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 */
'use strict';

module.exports = {
    name: '0050_kunwu_choice_fields',
    description: '为 multi_dungeon_choice 添加昆吾山专属变量变化字段',
    up: async (sequelize, QueryTypes) => {
        // 检查列是否存在的辅助函数
        async function columnExists(columnName) {
            const [result] = await sequelize.query(
                `SELECT COUNT(*) AS cnt
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'multi_dungeon_choice'
                   AND COLUMN_NAME = :colName`,
                { replacements: { colName: columnName }, type: QueryTypes.SELECT }
            );
            return result && result.cnt > 0;
        }

        async function addColumn(columnName, columnDef) {
            if (await columnExists(columnName)) {
                console.log(`[migration_0050] 列 ${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0050] 添加列 ${columnName}`);
            await sequelize.query(
                `ALTER TABLE multi_dungeon_choice ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // 依次添加 8 个新字段（幂等）
        await addColumn('demonic_qi_change', "INT NOT NULL DEFAULT 0 COMMENT '魔气变化（昆吾山专用）'");
        await addColumn('mountain_seal_change', "INT NOT NULL DEFAULT 0 COMMENT '山禁变化（昆吾山专用）'");
        await addColumn('treasure_pressure_change', "INT NOT NULL DEFAULT 0 COMMENT '宝压变化（昆吾山专用）'");
        await addColumn('linglong_change', "INT NOT NULL DEFAULT 0 COMMENT '玲珑变化（昆吾山专用）'");
        await addColumn('seal_progress_change', "INT NOT NULL DEFAULT 0 COMMENT '封印推进变化（昆吾山第四幕专用）'");
        await addColumn('tower_shadow_hp_change', "BIGINT NULL COMMENT '塔心魔影HP变化（昆吾山第四幕专用，负值表示削减）'");
        await addColumn('round_number', "INT NULL COMMENT '第四幕自动战斗回合数（1-5，仅第四幕有值）'");
        await addColumn('eye_key', "VARCHAR(50) NULL COMMENT '第三幕阵眼键（baling_eye/dragon_eye/blackwind_eye）'");

        console.log('[migration_0050] 昆吾山·封魔塔抉择记录字段迁移完成');
    },

    down: async (sequelize, QueryTypes) => {
        // 回滚：删除新增字段
        const columnsToDrop = [
            'demonic_qi_change', 'mountain_seal_change', 'treasure_pressure_change',
            'linglong_change', 'seal_progress_change', 'tower_shadow_hp_change',
            'round_number', 'eye_key'
        ];

        for (const col of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE multi_dungeon_choice DROP COLUMN ${col}`);
                console.log(`[migration_0050] 已删除列 ${col}`);
            } catch (e) {
                console.log(`[migration_0050] 删除列 ${col} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
