/**
 * 迁移脚本 0058：为 multi_dungeon_instance / multi_dungeon_choice / multi_dungeon_member 表添加血色试炼专属字段
 *
 * 设计依据：xiuxian_game_guide.md 第11节·副本与组队 + 第20节·副本决策
 *   血色试炼（xuese）是 4-6 人 PVPvE 淘汰制副本，差异化玩法：
 *     - 前3幕玩家互相博弈累积杀戮分、削减他人血气，每幕淘汰血气最低者
 *     - 第4幕幸存者合作对抗血色尊者（HP=1200000）
 *     - 双重压力机制：侵略（高伤害高杀戮分）vs 共生（保血气多幸存）
 *
 * 三幕 PVP 抉择：
 *   - 第1幕·血色试炼场：猎杀/潜行/挑战，血气最低者被淘汰
 *   - 第2幕·血魂祭坛：献祭/夺取/守护，不淘汰但累积血怒
 *   - 第3幕·血雾迷踪：追击/躲避/伏击，血气最低者被淘汰
 *   - 第4幕·血色尊者决战：自动 6 回合决战，伤害 = 100000 + 血怒×3000 + 幸存人数×20000
 *
 * 字段设计：
 *   - 实例级（multi_dungeon_instance）：blood_qi_avg / blood_fury / eliminations / survivor_count / xuese_boss_hp
 *   - 抉择级（multi_dungeon_choice）：blood_qi_self_change / blood_qi_others_change / kill_score_change / blood_fury_change
 *   - 成员级（multi_dungeon_member）：blood_qi / kill_score / is_eliminated
 *
 * 成员级字段说明：
 *   - blood_qi       INT NOT NULL DEFAULT 100  个人血气（0-100），归零即被淘汰
 *   - kill_score     INT NOT NULL DEFAULT 0    杀戮分（0-200），影响最终奖励
 *   - is_eliminated  TINYINT(1) NOT NULL DEFAULT 0  是否已被淘汰（0=幸存，1=淘汰）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0058_xuese_fields',
    description: '为 multi_dungeon_instance / multi_dungeon_choice / multi_dungeon_member 添加血色试炼专属字段',

    /**
     * 执行迁移：添加血色试炼专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    up: async (sequelize, QueryTypes) => {
        /**
         * 检查列是否已存在（幂等性保障）
         * @param {string} tableName - 表名
         * @param {string} columnName - 列名
         * @returns {Promise<boolean>} 是否存在
         */
        async function columnExists(tableName, columnName) {
            const [result] = await sequelize.query(
                `SELECT COUNT(*) AS cnt
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = :tbl
                   AND COLUMN_NAME = :col`,
                { replacements: { tbl: tableName, col: columnName }, type: QueryTypes.SELECT }
            );
            return result && result.cnt > 0;
        }

        /**
         * 添加列（幂等）
         * @param {string} tableName - 表名
         * @param {string} columnName - 列名
         * @param {string} columnDef - 列定义 SQL 片段
         */
        async function addColumn(tableName, columnName, columnDef) {
            if (await columnExists(tableName, columnName)) {
                console.log(`[migration_0058] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0058] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== multi_dungeon_instance 表新增字段 ==========
        // blood_qi_avg：团队平均血气（0-100），第4幕决战中每回合 -10，归零即团灭
        await addColumn(
            'multi_dungeon_instance',
            'blood_qi_avg',
            "INT NOT NULL DEFAULT 100 COMMENT '血色试炼·团队平均血气（0-100，第4幕决战每回合-10，归零团灭）'"
        );
        // blood_fury：血怒（0-200），第4幕决战伤害加成
        await addColumn(
            'multi_dungeon_instance',
            'blood_fury',
            "INT NOT NULL DEFAULT 0 COMMENT '血色试炼·血怒（0-200，第4幕决战伤害加成）'"
        );
        // eliminations：累计淘汰人数
        await addColumn(
            'multi_dungeon_instance',
            'eliminations',
            "INT NOT NULL DEFAULT 0 COMMENT '血色试炼·累计淘汰人数（前3幕每幕最多淘汰1人）'"
        );
        // survivor_count：最终幸存人数
        await addColumn(
            'multi_dungeon_instance',
            'survivor_count',
            "INT NOT NULL DEFAULT 0 COMMENT '血色试炼·最终幸存人数（进入第4幕决战的人数）'"
        );
        // xuese_boss_hp：血色尊者 HP（第4幕自动决战用）
        await addColumn(
            'multi_dungeon_instance',
            'xuese_boss_hp',
            "BIGINT DEFAULT NULL COMMENT '血色试炼·血色尊者HP（第4幕自动决战用，初始1200000）'"
        );

        // ========== multi_dungeon_choice 表新增字段 ==========
        // blood_qi_self_change：自身血气变化（可为负）
        await addColumn(
            'multi_dungeon_choice',
            'blood_qi_self_change',
            "INT NOT NULL DEFAULT 0 COMMENT '自身血气变化（血色试炼专用，可为负）'"
        );
        // blood_qi_others_change：他人血气变化（可为负，对其他在场成员造成血气伤害）
        await addColumn(
            'multi_dungeon_choice',
            'blood_qi_others_change',
            "INT NOT NULL DEFAULT 0 COMMENT '他人血气变化（血色试炼专用，对其他成员造成伤害，可为负）'"
        );
        // kill_score_change：杀戮分变化（可为负）
        await addColumn(
            'multi_dungeon_choice',
            'kill_score_change',
            "INT NOT NULL DEFAULT 0 COMMENT '杀戮分变化（血色试炼专用，可为负）'"
        );
        // blood_fury_change：血怒变化（仅实例级累积）
        await addColumn(
            'multi_dungeon_choice',
            'blood_fury_change',
            "INT NOT NULL DEFAULT 0 COMMENT '血怒变化（血色试炼专用，累加到 instance.blood_fury）'"
        );

        // ========== multi_dungeon_member 表新增字段 ==========
        // blood_qi：个人血气（0-100），归零即被淘汰
        await addColumn(
            'multi_dungeon_member',
            'blood_qi',
            "INT NOT NULL DEFAULT 100 COMMENT '血色试炼·个人血气（0-100，归零即被淘汰）'"
        );
        // kill_score：杀戮分（0-200），影响最终奖励
        await addColumn(
            'multi_dungeon_member',
            'kill_score',
            "INT NOT NULL DEFAULT 0 COMMENT '血色试炼·杀戮分（0-200，影响最终奖励）'"
        );
        // is_eliminated：是否已被淘汰（0=幸存，1=淘汰）
        await addColumn(
            'multi_dungeon_member',
            'is_eliminated',
            "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '血色试炼·是否已被淘汰（0=幸存，1=淘汰）'"
        );

        console.log('[migration_0058] 血色试炼字段迁移完成');
    },

    /**
     * 回滚迁移：删除血色试炼专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        const columnsToDrop = [
            // instance 表
            { table: 'multi_dungeon_instance', column: 'blood_qi_avg' },
            { table: 'multi_dungeon_instance', column: 'blood_fury' },
            { table: 'multi_dungeon_instance', column: 'eliminations' },
            { table: 'multi_dungeon_instance', column: 'survivor_count' },
            { table: 'multi_dungeon_instance', column: 'xuese_boss_hp' },
            // choice 表
            { table: 'multi_dungeon_choice', column: 'blood_qi_self_change' },
            { table: 'multi_dungeon_choice', column: 'blood_qi_others_change' },
            { table: 'multi_dungeon_choice', column: 'kill_score_change' },
            { table: 'multi_dungeon_choice', column: 'blood_fury_change' },
            // member 表
            { table: 'multi_dungeon_member', column: 'blood_qi' },
            { table: 'multi_dungeon_member', column: 'kill_score' },
            { table: 'multi_dungeon_member', column: 'is_eliminated' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0058] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0058] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
