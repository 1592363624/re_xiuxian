/**
 * migration_0073: 创建灵溪垂钓系统数据表
 *
 * 新建三张表：
 *   1. player_fishing — 玩家钓鱼状态（钓竿/熟练度/日竿数/日上限/活跃会话/统计）
 *   2. player_fish_catches — 玩家鱼获记录（鱼获本体不可流转，剖鱼后标记已剖）
 *   3. player_fish_album — 玩家鱼谱图鉴（记录已发现鱼类/首次钓获/总次数/最大重量）
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   灵溪垂钓是单人异步小游戏：钓竿4级/鱼饵/鱼塘/钓术熟练度/剖鱼机缘/伴生物品/LDC产出
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

module.exports = {
    /**
     * 执行迁移：创建 player_fishing / player_fish_catches / player_fish_album 三张表
     */
    async up() {
        // ===== 1. 创建 player_fishing 表（玩家钓鱼主状态，1:1 与 player） =====
        if (!(await tableExists('player_fishing'))) {
            await sequelize.query(`
                CREATE TABLE player_fishing (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    rod_tier TINYINT NOT NULL DEFAULT 0 COMMENT '当前钓竿等级：0=无钓竿 1=青竹 2=银竹 3=金竹 4=金雷竹',
                    skill_level INT NOT NULL DEFAULT 0 COMMENT '钓术熟练度等级（0-100）',
                    skill_exp INT NOT NULL DEFAULT 0 COMMENT '钓术熟练度当前经验',
                    daily_casts INT NOT NULL DEFAULT 0 COMMENT '今日已用竿数',
                    daily_reset_date DATE NULL COMMENT '日重置日期（跨日重置竿数和日上限）',
                    daily_stone_earned BIGINT NOT NULL DEFAULT 0 COMMENT '今日已获灵石（BIGINT，有日上限）',
                    daily_cultivation_earned BIGINT NOT NULL DEFAULT 0 COMMENT '今日已获修为（BIGINT，有日上限）',
                    buff_casts_remaining INT NOT NULL DEFAULT 0 COMMENT '炼鳞符剩余增益竿数',
                    buff_luck_bonus DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT '当前幸运加成（0-1）',
                    active_session TEXT NULL COMMENT '当前活跃钓鱼会话JSON（null=无活跃会话，含鱼讯时间/试探次数/预选鱼等）',
                    total_catches INT NOT NULL DEFAULT 0 COMMENT '总抛竿次数',
                    total_success INT NOT NULL DEFAULT 0 COMMENT '成功钓获次数',
                    biggest_catch_kg DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '最大鱼获重量(kg)',
                    rarest_catch_quality VARCHAR(20) NOT NULL DEFAULT '' COMMENT '最稀有鱼获品质',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                    PRIMARY KEY (id),
                    UNIQUE KEY uk_fishing_player (player_id),
                    INDEX idx_fishing_skill (skill_level),
                    INDEX idx_fishing_biggest (biggest_catch_kg)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家灵溪垂钓状态表'
            `);
            console.log('[migration_0073] player_fishing 表创建成功');
        } else {
            console.log('[migration_0073] player_fishing 表已存在，跳过');
        }

        // ===== 2. 创建 player_fish_catches 表（鱼获记录，本体不可流转） =====
        if (!(await tableExists('player_fish_catches'))) {
            await sequelize.query(`
                CREATE TABLE player_fish_catches (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    fish_id VARCHAR(30) NOT NULL COMMENT '鱼类ID（如 minnow/crucian/spirit_carp 等）',
                    fish_name VARCHAR(50) NOT NULL COMMENT '鱼名',
                    quality VARCHAR(20) NOT NULL COMMENT '品质：common/uncommon/rare/epic/legendary/mythic',
                    weight_kg DECIMAL(10,2) NOT NULL COMMENT '鱼获重量(kg)',
                    pond_id VARCHAR(30) NOT NULL COMMENT '钓获鱼塘ID',
                    is_filleted TINYINT NOT NULL DEFAULT 0 COMMENT '是否已剖鱼：0=未剖 1=已剖',
                    bonus_items TEXT NULL COMMENT '伴生物品JSON（功能道具/稀有材料/LDC，null=无伴生）',
                    caught_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '钓获时间',
                    PRIMARY KEY (id),
                    INDEX idx_fish_catches_player (player_id),
                    INDEX idx_fish_catches_quality (quality),
                    INDEX idx_fish_catches_filleted (is_filleted),
                    INDEX idx_fish_catches_caught_at (caught_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家鱼获记录表（本体不可流转）'
            `);
            console.log('[migration_0073] player_fish_catches 表创建成功');
        } else {
            console.log('[migration_0073] player_fish_catches 表已存在，跳过');
        }

        // ===== 3. 创建 player_fish_album 表（鱼谱图鉴） =====
        if (!(await tableExists('player_fish_album'))) {
            await sequelize.query(`
                CREATE TABLE player_fish_album (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    fish_id VARCHAR(30) NOT NULL COMMENT '鱼类ID',
                    fish_name VARCHAR(50) NOT NULL COMMENT '鱼名',
                    quality VARCHAR(20) NOT NULL COMMENT '品质',
                    first_caught_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '首次钓获时间',
                    total_caught INT NOT NULL DEFAULT 1 COMMENT '总钓获次数',
                    biggest_kg DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT '该鱼类最大重量(kg)',
                    PRIMARY KEY (id),
                    UNIQUE KEY uk_album_player_fish (player_id, fish_id),
                    INDEX idx_fish_album_player (player_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家鱼谱图鉴表'
            `);
            console.log('[migration_0073] player_fish_album 表创建成功');
        } else {
            console.log('[migration_0073] player_fish_album 表已存在，跳过');
        }
    },

    /**
     * 回滚迁移：删除三张表
     */
    async down() {
        await sequelize.query('DROP TABLE IF EXISTS player_fish_album');
        await sequelize.query('DROP TABLE IF EXISTS player_fish_catches');
        await sequelize.query('DROP TABLE IF EXISTS player_fishing');
        console.log('[migration_0073] 回滚完成：已删除 player_fishing / player_fish_catches / player_fish_album 三张表');
    }
};
