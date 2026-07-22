/**
 * 迁移脚本 0059：为 multi_dungeon_instance / multi_dungeon_choice / multi_dungeon_member 表添加坠魔谷专属字段
 *
 * 设计依据：xiuxian_game_guide.md 第11节·副本与组队 + 第20节·副本决策
 *   坠魔谷（zhuimo）是 3-5 人 PVE 心魔博弈副本，差异化玩法：
 *     - 玩家面对自身心魔考验，抉择影响心魔与道心两个对立变量
 *     - 心魔满100则堕魔淘汰，道心归0则道心破碎淘汰
 *     - 队员可护道降低他人心魔，也可试道增加他人心魔换取自身收益
 *
 * 三幕 PVE 抉择：
 *   - 第1幕·入谷遇魔：净化/斩魔/护道，影响心魔与道心
 *   - 第2幕·心魔试炼：静心/血祭/护道，全队心魔博弈
 *   - 第3幕·道心抉择：守道/入魔/平衡，道心与心魔的最终博弈
 *   - 第4幕·心魔决战：自动 5 回合决战，伤害 = 80000 + (100-avg_heart_demon)×2000 + avg_dao_heart×1500
 *
 * 字段设计：
 *   - 实例级（multi_dungeon_instance）：avg_heart_demon / avg_dao_heart / demon_boss_hp
 *   - 抉择级（multi_dungeon_choice）：heart_demon_self_change / heart_demon_others_change /
 *       heart_demon_others_change_highest / dao_heart_self_change / dao_heart_others_change
 *   - 成员级（multi_dungeon_member）：heart_demon / dao_heart / is_fallen
 *
 * 成员级字段说明：
 *   - heart_demon  INT NOT NULL DEFAULT 0    个人心魔（0-100），满100则堕魔淘汰
 *   - dao_heart    INT NOT NULL DEFAULT 100  个人道心（0-100），归0则道心破碎淘汰
 *   - is_fallen    TINYINT(1) NOT NULL DEFAULT 0  是否已堕魔（0=未堕魔，1=已堕魔）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0059_zhuimo_fields',
    description: '为 multi_dungeon_instance / multi_dungeon_choice / multi_dungeon_member 添加坠魔谷专属字段',

    /**
     * 执行迁移：添加坠魔谷专属字段
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
                console.log(`[migration_0059] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0059] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== multi_dungeon_instance 表新增字段 ==========
        // avg_heart_demon：团队平均心魔（0-100），第4幕决战中每回合 +5，满100团灭
        await addColumn(
            'multi_dungeon_instance',
            'avg_heart_demon',
            "INT NOT NULL DEFAULT 0 COMMENT '坠魔谷·团队平均心魔（0-100，第4幕决战每回合+5，满100团灭）'"
        );
        // avg_dao_heart：团队平均道心（0-100），第4幕决战中每回合 -5，归0团灭
        await addColumn(
            'multi_dungeon_instance',
            'avg_dao_heart',
            "INT NOT NULL DEFAULT 100 COMMENT '坠魔谷·团队平均道心（0-100，第4幕决战每回合-5，归0团灭）'"
        );
        // demon_boss_hp：心魔Boss HP（第4幕自动决战用，初始1000000，null=未进入第4幕）
        await addColumn(
            'multi_dungeon_instance',
            'demon_boss_hp',
            "BIGINT DEFAULT NULL COMMENT '坠魔谷·心魔Boss HP（第4幕自动决战用，初始1000000）'"
        );

        // ========== multi_dungeon_choice 表新增字段 ==========
        // heart_demon_self_change：自身心魔变化（可为负，负值表示降低心魔）
        await addColumn(
            'multi_dungeon_choice',
            'heart_demon_self_change',
            "INT NOT NULL DEFAULT 0 COMMENT '自身心魔变化（坠魔谷专用，可为负）'"
        );
        // heart_demon_others_change：他人心魔变化（可为负，影响其他在场未堕魔成员）
        await addColumn(
            'multi_dungeon_choice',
            'heart_demon_others_change',
            "INT NOT NULL DEFAULT 0 COMMENT '他人心魔变化（坠魔谷专用，影响其他成员，可为负）'"
        );
        // heart_demon_others_change_highest：心魔最高者心魔变化（特殊：仅影响心魔最高的队员，护道专用）
        await addColumn(
            'multi_dungeon_choice',
            'heart_demon_others_change_highest',
            "INT NOT NULL DEFAULT 0 COMMENT '心魔最高者心魔变化（坠魔谷专用，仅影响心魔最高的队员，护道专用）'"
        );
        // dao_heart_self_change：自身道心变化（可为负，负值表示降低道心）
        await addColumn(
            'multi_dungeon_choice',
            'dao_heart_self_change',
            "INT NOT NULL DEFAULT 0 COMMENT '自身道心变化（坠魔谷专用，可为负）'"
        );
        // dao_heart_others_change：他人道心变化（可为正，提升他人道心）
        await addColumn(
            'multi_dungeon_choice',
            'dao_heart_others_change',
            "INT NOT NULL DEFAULT 0 COMMENT '他人道心变化（坠魔谷专用，可为正）'"
        );

        // ========== multi_dungeon_member 表新增字段 ==========
        // heart_demon：个人心魔（0-100），满100则堕魔淘汰
        await addColumn(
            'multi_dungeon_member',
            'heart_demon',
            "INT NOT NULL DEFAULT 0 COMMENT '坠魔谷·个人心魔（0-100，满100则堕魔淘汰）'"
        );
        // dao_heart：个人道心（0-100），归0则道心破碎淘汰
        await addColumn(
            'multi_dungeon_member',
            'dao_heart',
            "INT NOT NULL DEFAULT 100 COMMENT '坠魔谷·个人道心（0-100，归0则道心破碎淘汰）'"
        );
        // is_fallen：是否已堕魔（0=未堕魔，1=已堕魔），堕魔后 is_present 同步置 0
        await addColumn(
            'multi_dungeon_member',
            'is_fallen',
            "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '坠魔谷·是否已堕魔（0=未堕魔，1=已堕魔）'"
        );

        console.log('[migration_0059] 坠魔谷字段迁移完成');
    },

    /**
     * 回滚迁移：删除坠魔谷专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        const columnsToDrop = [
            // instance 表
            { table: 'multi_dungeon_instance', column: 'avg_heart_demon' },
            { table: 'multi_dungeon_instance', column: 'avg_dao_heart' },
            { table: 'multi_dungeon_instance', column: 'demon_boss_hp' },
            // choice 表
            { table: 'multi_dungeon_choice', column: 'heart_demon_self_change' },
            { table: 'multi_dungeon_choice', column: 'heart_demon_others_change' },
            { table: 'multi_dungeon_choice', column: 'heart_demon_others_change_highest' },
            { table: 'multi_dungeon_choice', column: 'dao_heart_self_change' },
            { table: 'multi_dungeon_choice', column: 'dao_heart_others_change' },
            // member 表
            { table: 'multi_dungeon_member', column: 'heart_demon' },
            { table: 'multi_dungeon_member', column: 'dao_heart' },
            { table: 'multi_dungeon_member', column: 'is_fallen' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0059] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0059] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
