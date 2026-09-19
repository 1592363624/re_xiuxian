/**
 * migration_0072: 创建傀儡工坊系统数据表
 *
 * 新建两张表：
 *   1. player_puppets — 玩家持有的傀儡（制造/淬炼/维修/出战/护法/回收）
 *   2. player_puppet_blueprints — 玩家已参悟的傀儡图谱
 *
 * 玩法文档对照：第23节·大衍诀与傀儡路线
 *   大衍诀第三层·控傀解锁傀儡制造；影傀需第四层·千机；大衍灵傀需第五层·衍神
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
     * 执行迁移：创建 player_puppets 和 player_puppet_blueprints 表
     */
    async up() {
        // ===== 1. 创建 player_puppets 表 =====
        if (!(await tableExists('player_puppets'))) {
            await sequelize.query(`
                CREATE TABLE player_puppets (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    puppet_type VARCHAR(30) NOT NULL COMMENT '傀儡类型：mechanical_wood/iron_armor/five_element/shadow/dayan_spirit',
                    name VARCHAR(50) NOT NULL COMMENT '傀儡名称',
                    level INT NOT NULL DEFAULT 1 COMMENT '傀儡等级（1-20）',
                    exp INT NOT NULL DEFAULT 0 COMMENT '当前经验（预留，淬炼暂用等级直接提升）',
                    durability INT NOT NULL DEFAULT 100 COMMENT '当前耐久度',
                    max_durability INT NOT NULL DEFAULT 100 COMMENT '最大耐久度',
                    atk INT NOT NULL DEFAULT 0 COMMENT '攻击力（含等级加成）',
                    def INT NOT NULL DEFAULT 0 COMMENT '防御力（含等级加成）',
                    hp INT NOT NULL DEFAULT 0 COMMENT '生命值（含等级加成）',
                    speed INT NOT NULL DEFAULT 0 COMMENT '速度（含等级加成）',
                    status VARCHAR(20) NOT NULL DEFAULT 'idle' COMMENT '状态：idle闲置/battle出战/guard护法',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
                    PRIMARY KEY (id),
                    INDEX idx_player_puppets_player (player_id),
                    INDEX idx_player_puppets_status (status),
                    INDEX idx_player_puppets_type (puppet_type)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家傀儡表'
            `);
            console.log('[migration_0072] player_puppets 表创建成功');
        } else {
            console.log('[migration_0072] player_puppets 表已存在，跳过');
        }

        // ===== 2. 创建 player_puppet_blueprints 表 =====
        if (!(await tableExists('player_puppet_blueprints'))) {
            await sequelize.query(`
                CREATE TABLE player_puppet_blueprints (
                    id BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键ID',
                    player_id BIGINT NOT NULL COMMENT '玩家ID',
                    blueprint_key VARCHAR(50) NOT NULL COMMENT '图谱key：mechanical_wood_blueprint等',
                    blueprint_name VARCHAR(50) NOT NULL COMMENT '图谱名称',
                    puppet_type VARCHAR(30) NOT NULL COMMENT '对应傀儡类型',
                    learned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '参悟时间',
                    PRIMARY KEY (id),
                    UNIQUE KEY uk_player_blueprint (player_id, blueprint_key),
                    INDEX idx_puppet_blueprints_player (player_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家傀儡图谱表'
            `);
            console.log('[migration_0072] player_puppet_blueprints 表创建成功');
        } else {
            console.log('[migration_0072] player_puppet_blueprints 表已存在，跳过');
        }
    },

    /**
     * 回滚迁移：删除表
     */
    async down() {
        await sequelize.query('DROP TABLE IF EXISTS player_puppet_blueprints');
        await sequelize.query('DROP TABLE IF EXISTS player_puppets');
        console.log('[migration_0072] 回滚完成：已删除 player_puppets 和 player_puppet_blueprints 表');
    }
};
