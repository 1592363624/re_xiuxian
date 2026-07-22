/**
 * 迁移脚本 0057：为 multi_dungeon_instance 与 multi_dungeon_choice 表添加苍坤洞府专属字段
 *
 * 设计依据：xiuxian_game_guide.md 第11节·副本与组队 + 第20节·副本决策 + 第23节·大衍诀与傀儡路线
 *   苍坤洞府是掩月抢亲的前置副本，也是大衍诀"千机残篇"的来源。
 *   核心机制：动态权重掉落——门票线索（月影传书残页/掩月密讯）的掉率会随
 *           禁制裂隙（forbidden_rift）、卷轴线索（scroll_clue）、脱身抉择（escape_choice）动态提高。
 *
 * 四幕流程：
 *   - 第1幕·入府探秘：选择入府方式（强破禁制/寻隙潜入/秘纹开路），影响 forbidden_rift
 *   - 第2幕·搜寻宝物：随机3选1，影响 scroll_clue 与千机残篇掉率
 *   - 第3幕·禁制触发：处理苍坤旧禁禁制（镇压/绕行/破禁），影响 forbidden_rift 与 escape_difficulty
 *   - 第4幕·脱身抉择：自动决战 + 脱身方式（强行突围/借阵脱身/隐遁潜行）
 *     - 强行突围：escape_difficulty 大涨，门票线索掉率加成 0.0
 *     - 借阵脱身：escape_difficulty 小涨，门票线索掉率加成 +0.3
 *     - 隐遁潜行：escape_difficulty 不变，门票线索掉率加成 +0.5
 *
 * 动态权重掉落公式（门票线索）：
 *   final_chance = base_chance × (1 + scroll_clue/100 + forbidden_rift/100 + escape_choice_bonus)
 *   - 月影传书残页 base_chance = 0.0759（7.59%）
 *   - 掩月密讯     base_chance = 0.0316（3.16%）
 *
 * 新增字段（multi_dungeon_instance）：
 *   - forbidden_rift        INT NOT NULL DEFAULT 0     禁制裂隙（0-100）
 *   - scroll_clue           INT NOT NULL DEFAULT 0     卷轴线索（0-100）
 *   - escape_difficulty     INT NOT NULL DEFAULT 30    脱身难度（0-100，初始30）
 *   - escape_choice         VARCHAR(50) DEFAULT NULL   第4幕脱身抉择键
 *   - cangkun_guardian_hp   BIGINT DEFAULT NULL        苍坤守灵HP（第4幕自动决战用）
 *
 * 新增字段（multi_dungeon_choice）：
 *   - forbidden_rift_change        INT NOT NULL DEFAULT 0  禁制裂隙变化（累加）
 *   - scroll_clue_change           INT NOT NULL DEFAULT 0  卷轴线索变化（累加）
 *   - escape_difficulty_change     INT NOT NULL DEFAULT 0  脱身难度变化（累加）
 *   - cangkun_guardian_hp_change   BIGINT DEFAULT NULL     苍坤守灵HP变化（负值表示削减）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0057_cangkun_fields',
    description: '为 multi_dungeon_instance / multi_dungeon_choice 添加苍坤洞府专属字段',

    /**
     * 执行迁移：添加苍坤洞府专属字段
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
                console.log(`[migration_0057] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0057] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== multi_dungeon_instance 表新增字段 ==========
        // forbidden_rift：禁制裂隙（0-100），苍坤旧禁被破开的程度
        await addColumn(
            'multi_dungeon_instance',
            'forbidden_rift',
            "INT NOT NULL DEFAULT 0 COMMENT '苍坤洞府·禁制裂隙（0-100，影响门票线索掉率与脱身难度）'"
        );
        // scroll_clue：卷轴线索（0-100），千机残篇线索累积度
        await addColumn(
            'multi_dungeon_instance',
            'scroll_clue',
            "INT NOT NULL DEFAULT 0 COMMENT '苍坤洞府·卷轴线索（0-100，千机残篇线索累积度）'"
        );
        // escape_difficulty：脱身难度（0-100），第4幕自动决战中累积
        await addColumn(
            'multi_dungeon_instance',
            'escape_difficulty',
            "INT NOT NULL DEFAULT 30 COMMENT '苍坤洞府·脱身难度（0-100，影响决战回合数与门票掉率）'"
        );
        // escape_choice：第4幕脱身抉择键（forced_breakout/formation_escape/stealth_escape）
        await addColumn(
            'multi_dungeon_instance',
            'escape_choice',
            "VARCHAR(50) DEFAULT NULL COMMENT '苍坤洞府·第4幕脱身抉择键'"
        );
        // cangkun_guardian_hp：苍坤守灵 HP（第4幕自动决战用）
        await addColumn(
            'multi_dungeon_instance',
            'cangkun_guardian_hp',
            "BIGINT DEFAULT NULL COMMENT '苍坤洞府·守灵HP（第4幕自动决战用）'"
        );

        // ========== multi_dungeon_choice 表新增字段 ==========
        // forbidden_rift_change：禁制裂隙变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'forbidden_rift_change',
            "INT NOT NULL DEFAULT 0 COMMENT '禁制裂隙变化（苍坤洞府专用，累加）'"
        );
        // scroll_clue_change：卷轴线索变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'scroll_clue_change',
            "INT NOT NULL DEFAULT 0 COMMENT '卷轴线索变化（苍坤洞府专用，累加）'"
        );
        // escape_difficulty_change：脱身难度变化（累加）
        await addColumn(
            'multi_dungeon_choice',
            'escape_difficulty_change',
            "INT NOT NULL DEFAULT 0 COMMENT '脱身难度变化（苍坤洞府专用，累加）'"
        );
        // cangkun_guardian_hp_change：苍坤守灵HP变化（负值表示削减）
        await addColumn(
            'multi_dungeon_choice',
            'cangkun_guardian_hp_change',
            "BIGINT DEFAULT NULL COMMENT '苍坤守灵HP变化（苍坤洞府第4幕专用，负值表示削减）'"
        );

        console.log('[migration_0057] 苍坤洞府字段迁移完成');
    },

    /**
     * 回滚迁移：删除苍坤洞府专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        const columnsToDrop = [
            { table: 'multi_dungeon_instance', column: 'forbidden_rift' },
            { table: 'multi_dungeon_instance', column: 'scroll_clue' },
            { table: 'multi_dungeon_instance', column: 'escape_difficulty' },
            { table: 'multi_dungeon_instance', column: 'escape_choice' },
            { table: 'multi_dungeon_instance', column: 'cangkun_guardian_hp' },
            { table: 'multi_dungeon_choice', column: 'forbidden_rift_change' },
            { table: 'multi_dungeon_choice', column: 'scroll_clue_change' },
            { table: 'multi_dungeon_choice', column: 'escape_difficulty_change' },
            { table: 'multi_dungeon_choice', column: 'cangkun_guardian_hp_change' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0057] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0057] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
