/**
 * 迁移脚本 0060：为 multi_dungeon_instance / multi_dungeon_choice / multi_dungeon_member 表添加黄龙山专属字段
 *
 * 设计依据：xiuxian_game_guide.md 第11节·副本与组队 + 第20节·副本决策 + 第16节·慕兰烽烟
 *   黄龙山（huanglong）是 5 人固定编制宗门协同阵法副本，差异化玩法：
 *     - 5 人固定编制（member_min=member_max=5）+ 同宗门强制（require_same_sect=true）
 *     - 五大阵眼（forward前阵/center中阵/rear后阵/left左阵/right右阵）+ 相同阵眼共鸣机制
 *     - 6 种宗门特色加成（落云/星宫/天星/凌霄/阴罗/合欢各不同）
 *     - 叛道（defect）机制：成员可放弃共鸣换双倍贡献分
 *
 * 四幕宗门协同阵法流程：
 *   - 第1幕·入阵固守（enter_formation）：5阵眼选择 + 共鸣机制
 *   - 第2幕·截断粮道（cut_supply）：4种截粮策略（奇袭/伪装/强攻/潜行）
 *   - 第3幕·阵法共鸣（formation_resonance）：3种共鸣方向 + 叛道抉择
 *   - 第4幕·黄龙主阵决战（huanglong_boss）：自动5回合决战
 *     伤害公式：damage = 100000 + formation_power × 3000 + resonance_count × 15000
 *     双向腐蚀：每回合 morale -3 / vigilance +5（警戒满100即失败）
 *
 * 字段设计（统一 huanglong_ 前缀，避免与虚天殿 formation_power 等字段冲突）：
 *   - 实例级（multi_dungeon_instance）：
 *       huanglong_formation_power  阵法强度（0-200）
 *       huanglong_resonance_count  共鸣数（0-5）
 *       huanglong_boss_hp          黄龙Boss HP（第4幕决战用，null=未进入第4幕）
 *   - 抉择级（multi_dungeon_choice）：
 *       huanglong_formation_power_change          阵法强度变化（累加）
 *       huanglong_resonance_count_change          共鸣数变化（累加）
 *       huanglong_eye_position                    阵眼位置（直接设置：forward/center/rear/left/right）
 *       huanglong_contribution_score_self_change  自身贡献分变化（可为负）
 *       huanglong_is_defecting_self               是否叛道（直接设置 0/1）
 *   - 成员级（multi_dungeon_member）：
 *       huanglong_eye_position        阵眼位置（默认 unassigned，第1幕选择后更新）
 *       huanglong_contribution_score  个人贡献分（默认 0，影响最终奖励分配）
 *       huanglong_is_defecting        是否已叛道（0=未叛道，1=已叛道，叛道后放弃共鸣换双倍贡献分）
 *
 * 幂等性：所有 ALTER 前先检查 INFORMATION_SCHEMA，已存在则跳过
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

module.exports = {
    name: '0060_huanglong_fields',
    description: '为 multi_dungeon_instance / multi_dungeon_choice / multi_dungeon_member 添加黄龙山专属字段',

    /**
     * 执行迁移：添加黄龙山专属字段
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
                console.log(`[migration_0060] ${tableName}.${columnName} 已存在，跳过`);
                return;
            }
            console.log(`[migration_0060] 添加 ${tableName}.${columnName}`);
            await sequelize.query(
                `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`
            );
        }

        // ========== multi_dungeon_instance 表新增字段 ==========
        // huanglong_formation_power：阵法强度（0-200），第1幕起由阵眼选择与共鸣累加
        //   - 影响第4幕决战伤害（每点 +3000）和称号奖励阈值（≥120 才有 30% 几率给称号）
        await addColumn(
            'multi_dungeon_instance',
            'huanglong_formation_power',
            "INT NOT NULL DEFAULT 0 COMMENT '黄龙山·阵法强度（0-200，影响决战伤害与称号奖励）'"
        );
        // huanglong_resonance_count：共鸣数（0-5），第1/3幕相同阵眼≥2人触发共鸣累加
        //   - 影响第4幕决战伤害（每点 +15000）和完美通关判定（共鸣数=5且无叛道）
        await addColumn(
            'multi_dungeon_instance',
            'huanglong_resonance_count',
            "INT NOT NULL DEFAULT 0 COMMENT '黄龙山·共鸣数（0-5，相同阵眼≥2人触发，影响决战伤害与完美通关）'"
        );
        // huanglong_boss_hp：黄龙Boss HP（第4幕自动决战用，初始1500000，null=未进入第4幕）
        await addColumn(
            'multi_dungeon_instance',
            'huanglong_boss_hp',
            "BIGINT DEFAULT NULL COMMENT '黄龙山·黄龙Boss HP（第4幕自动决战用，初始1500000）'"
        );

        // ========== multi_dungeon_choice 表新增字段 ==========
        // huanglong_formation_power_change：阵法强度变化（累加到 instance.huanglong_formation_power）
        await addColumn(
            'multi_dungeon_choice',
            'huanglong_formation_power_change',
            "INT NOT NULL DEFAULT 0 COMMENT '阵法强度变化（黄龙山专用，累加）'"
        );
        // huanglong_resonance_count_change：共鸣数变化（累加到 instance.huanglong_resonance_count）
        await addColumn(
            'multi_dungeon_choice',
            'huanglong_resonance_count_change',
            "INT NOT NULL DEFAULT 0 COMMENT '共鸣数变化（黄龙山专用，累加）'"
        );
        // huanglong_eye_position：阵眼位置（直接设置，记录抉择时的阵眼选择）
        //   - 取值：forward前阵 / center中阵 / rear后阵 / left左阵 / right右阵
        await addColumn(
            'multi_dungeon_choice',
            'huanglong_eye_position',
            "VARCHAR(20) DEFAULT NULL COMMENT '阵眼位置（黄龙山专用，forward/center/rear/left/right）'"
        );
        // huanglong_contribution_score_self_change：自身贡献分变化（可为负）
        //   - 正常抉择获得基础贡献分，叛道抉择获得双倍贡献分但放弃共鸣
        await addColumn(
            'multi_dungeon_choice',
            'huanglong_contribution_score_self_change',
            "INT NOT NULL DEFAULT 0 COMMENT '自身贡献分变化（黄龙山专用，可为负，叛道双倍）'"
        );
        // huanglong_is_defecting_self：是否叛道（直接设置 0/1，仅第3幕叛道抉择有值）
        //   - 叛道后成员 huanglong_is_defecting 置 1，不再参与共鸣但获得双倍贡献分
        await addColumn(
            'multi_dungeon_choice',
            'huanglong_is_defecting_self',
            "TINYINT(1) DEFAULT NULL COMMENT '是否叛道（黄龙山专用，直接设置 0/1，第3幕叛道抉择用）'"
        );

        // ========== multi_dungeon_member 表新增字段 ==========
        // huanglong_eye_position：阵眼位置（默认 unassigned，第1幕选择后更新为 forward/center/rear/left/right）
        //   - 同一相同阵眼≥2人触发共鸣，5人同阵眼可触发 5 共鸣
        await addColumn(
            'multi_dungeon_member',
            'huanglong_eye_position',
            "VARCHAR(20) NOT NULL DEFAULT 'unassigned' COMMENT '黄龙山·阵眼位置（unassigned/forward/center/rear/left/right）'"
        );
        // huanglong_contribution_score：个人贡献分（默认 0，影响最终奖励分配）
        //   - 由第1-3幕抉择累加，叛道成员获得双倍贡献分
        //   - 影响首通奖励分配权重和宗门贡献奖励加成
        await addColumn(
            'multi_dungeon_member',
            'huanglong_contribution_score',
            "INT NOT NULL DEFAULT 0 COMMENT '黄龙山·个人贡献分（影响奖励分配，叛道双倍）'"
        );
        // huanglong_is_defecting：是否已叛道（0=未叛道，1=已叛道）
        //   - 叛道后成员不再参与共鸣判定，但保留已获得的贡献分
        //   - 影响完美通关判定（perfect_clear_no_defect=true 时全员未叛道才完美通关）
        await addColumn(
            'multi_dungeon_member',
            'huanglong_is_defecting',
            "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '黄龙山·是否已叛道（0=未叛道，1=已叛道）'"
        );

        console.log('[migration_0060] 黄龙山字段迁移完成');
    },

    /**
     * 回滚迁移：删除黄龙山专属字段
     * @param {Object} sequelize - Sequelize 实例
     * @param {Object} QueryTypes - 查询类型枚举
     */
    down: async (sequelize, QueryTypes) => {
        const columnsToDrop = [
            // instance 表
            { table: 'multi_dungeon_instance', column: 'huanglong_formation_power' },
            { table: 'multi_dungeon_instance', column: 'huanglong_resonance_count' },
            { table: 'multi_dungeon_instance', column: 'huanglong_boss_hp' },
            // choice 表
            { table: 'multi_dungeon_choice', column: 'huanglong_formation_power_change' },
            { table: 'multi_dungeon_choice', column: 'huanglong_resonance_count_change' },
            { table: 'multi_dungeon_choice', column: 'huanglong_eye_position' },
            { table: 'multi_dungeon_choice', column: 'huanglong_contribution_score_self_change' },
            { table: 'multi_dungeon_choice', column: 'huanglong_is_defecting_self' },
            // member 表
            { table: 'multi_dungeon_member', column: 'huanglong_eye_position' },
            { table: 'multi_dungeon_member', column: 'huanglong_contribution_score' },
            { table: 'multi_dungeon_member', column: 'huanglong_is_defecting' }
        ];

        for (const { table, column } of columnsToDrop) {
            try {
                await sequelize.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                console.log(`[migration_0060] 已删除 ${table}.${column}`);
            } catch (e) {
                console.log(`[migration_0060] 删除 ${table}.${column} 失败（可能不存在）: ${e.message}`);
            }
        }
    }
};
