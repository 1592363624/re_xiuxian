/**
 * migration_0075: 创建赌石系统数据表
 *
 * 新建两张表：
 *   1. player_gambling_stone — 玩家赌石状态（熟练度/日次数/统计/诅咒状态）
 *   2. player_stone_records  — 原石记录（生成/线索/切开/产出，支持未切开原石流转）
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   赌石流程是 `.赌石` 生成三块原石，再用 `.切 <编号>` 购买切开。
 *
 * 设计深化：
 *   - 4+1产地差异化产出池（乱星海岛/黄枫谷矿脉/昆吾山深处/虚天殿遗矿/诅咒矿脉）
 *   - 4档品质（普通/灵纹/宝光/仙雾）+4维线索（皮壳/重量/灵气/色泽）+假线索博弈
 *   - 3种切法（粗切/精切/神识切）+熟练度0-100级成长
 *   - 全服每日保底LDC1-2/稀有道具1-2 + 诅咒原石PVP劫掠
 *   - 未切开原石可上架拍卖行流转
 *
 * 幂等性：建表前检查表是否存在，字段添加前检查字段是否存在
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const sequelize = require('../config/database');

/**
 * 检查表是否存在
 * @param {string} tableName - 表名
 * @returns {Promise<boolean>}
 */
async function tableExists(tableName) {
    const [results] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
        { replacements: [tableName] }
    );
    return results[0].cnt > 0;
}

/**
 * 检查字段是否存在
 * @param {string} tableName - 表名
 * @param {string} columnName - 字段名
 * @returns {Promise<boolean>}
 */
async function columnExists(tableName, columnName) {
    const [results] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        { replacements: [tableName, columnName] }
    );
    return results[0].cnt > 0;
}

module.exports = {
    /**
     * 执行迁移：创建 player_gambling_stone / player_stone_records 两张表
     */
    async up() {
        // ===== 1. 创建 player_gambling_stone 表（玩家赌石主状态，1:1 与 player） =====
        if (!(await tableExists('player_gambling_stone'))) {
            await sequelize.query(`
                CREATE TABLE player_gambling_stone (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    skill_level INT NOT NULL DEFAULT 0 COMMENT '赌石熟练度等级（0-100）',
                    skill_exp INT NOT NULL DEFAULT 0 COMMENT '赌石熟练度当前经验',
                    daily_generates INT NOT NULL DEFAULT 0 COMMENT '今日已生成次数',
                    daily_reset_date DATE NULL COMMENT '日重置日期（跨日重置次数和上限）',
                    daily_spirit_stone_earned BIGINT NOT NULL DEFAULT 0 COMMENT '今日已获灵石（BIGINT，有日上限）',
                    daily_cultivation_earned BIGINT NOT NULL DEFAULT 0 COMMENT '今日已获修为（BIGINT，有日上限）',
                    curse_until DATETIME NULL COMMENT '诅咒到期时间（NULL=无诅咒，诅咒期间产出可被劫）',
                    total_cuts INT NOT NULL DEFAULT 0 COMMENT '总切开次数',
                    total_spirit_stone_earned BIGINT NOT NULL DEFAULT 0 COMMENT '累计灵石收益',
                    total_cultivation_earned BIGINT NOT NULL DEFAULT 0 COMMENT '累计修为收益',
                    total_profit BIGINT NOT NULL DEFAULT 0 COMMENT '累计净收益（产出-成本，含切石费用）',
                    biggest_win BIGINT NOT NULL DEFAULT 0 COMMENT '单块最大收益（按灵石等价折算）',
                    rare_drop_count INT NOT NULL DEFAULT 0 COMMENT '稀有掉落累计次数',
                    ldc_earned INT NOT NULL DEFAULT 0 COMMENT '累计获得LDC数量',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                    PRIMARY KEY (id),
                    UNIQUE KEY uk_gambling_player (player_id),
                    INDEX idx_gambling_skill (skill_level),
                    INDEX idx_gambling_biggest (biggest_win),
                    INDEX idx_gambling_profit (total_profit)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家赌石状态表'
            `);
            console.log('[migration_0075] player_gambling_stone 表创建成功');
        } else {
            console.log('[migration_0075] player_gambling_stone 表已存在，跳过');
        }

        // ===== 2. 创建 player_stone_records 表（原石记录，支持未切开原石流转） =====
        if (!(await tableExists('player_stone_records'))) {
            await sequelize.query(`
                CREATE TABLE player_stone_records (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '当前持有者玩家ID（流转时更新）',
                    origin_player_id BIGINT NOT NULL COMMENT '原始生成者玩家ID（不随流转变化）',
                    origin VARCHAR(30) NOT NULL COMMENT '产地ID（luan_xing_island/huang_feng_mine/kun_wu_depth/xu_tian_relic/cursed_vein）',
                    quality VARCHAR(20) NOT NULL COMMENT '品质ID（common/spirit_vein/treasure_glow/fairy_mist）',
                    base_price INT NOT NULL COMMENT '基础价（灵石，按品质决定）',
                    clues TEXT NOT NULL COMMENT '4维线索JSON（crust/weight/aura/color，可能含假线索）',
                    real_quality VARCHAR(20) NOT NULL COMMENT '真实品质（玩家不可见，切开时校验）',
                    is_cut TINYINT NOT NULL DEFAULT 0 COMMENT '是否已切开：0=未切开 1=已切开',
                    cut_method VARCHAR(20) NULL COMMENT '切开方式（rough/fine/divine_sense）',
                    cut_at DATETIME NULL COMMENT '切开时间',
                    cut_cost BIGINT NOT NULL DEFAULT 0 COMMENT '切开消耗（灵石，精切100/神识切0）',
                    yield_data TEXT NULL COMMENT '产出JSON（spirit_stones/cultivation/items/ldc/rare/curse等）',
                    yield_value BIGINT NOT NULL DEFAULT 0 COMMENT '产出等价灵石价值（用于统计和保底）',
                    is_listed TINYINT NOT NULL DEFAULT 0 COMMENT '是否已上架拍卖行：0=未上架 1=已上架',
                    listing_price BIGINT NULL COMMENT '上架价格（灵石）',
                    generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                    PRIMARY KEY (id),
                    INDEX idx_stone_player (player_id, is_cut),
                    INDEX idx_stone_origin_player (origin_player_id),
                    INDEX idx_stone_listed (is_listed),
                    INDEX idx_stone_yield (yield_value)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家原石记录表'
            `);
            console.log('[migration_0075] player_stone_records 表创建成功');
        } else {
            console.log('[migration_0075] player_stone_records 表已存在，跳过');
        }

        console.log('[migration_0075] 赌石系统数据表迁移完成');
    },

    /**
     * 回滚迁移：删除两张表（谨慎操作，会丢失数据）
     */
    async down() {
        await sequelize.query('DROP TABLE IF EXISTS player_stone_records');
        await sequelize.query('DROP TABLE IF EXISTS player_gambling_stone');
        console.log('[migration_0075] 赌石系统数据表已回滚');
    }
};
