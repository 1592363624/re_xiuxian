/**
 * 迁移脚本：创建 player_artifact_spirits 表（器灵系统）
 *
 * 玩法文档第7节/第895-909行 法宝、器灵与徽章。
 * 器灵系统为完全未实现功能，本迁移创建独立表存储玩家法宝器灵状态：
 *   - 唤醒器灵 / 我的器灵 / 器灵试炼 / 器灵护主
 *   - 催发器灵 / 抚摸法宝 / 温养器灵 / 器灵试炼榜
 *
 * 表结构：
 *   - 关联 player_equipment.id（每件已装备的法宝可唤醒一个器灵）
 *   - 器灵4种类型（attack/defense/support/balance），影响战斗加成
 *   - 亲密度/力量值/等级/经验，多维度养成
 *   - 试炼累计分数用于排行榜（多人竞争维度）
 *
 * 幂等：通过 INFORMATION_SCHEMA 检查表是否存在，重复执行不会报错
 */
'use strict';

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

/**
 * 检查表是否存在
 * @param {string} tableName - 表名
 * @returns {Promise<boolean>}
 */
async function tableExists(tableName) {
    const [result] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        { replacements: [tableName], type: QueryTypes.SELECT }
    );
    return result.cnt > 0;
}

/**
 * 检查索引是否存在
 * @param {string} tableName - 表名
 * @param {string} indexName - 索引名
 * @returns {Promise<boolean>}
 */
async function indexExists(tableName, indexName) {
    const [result] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        { replacements: [tableName, indexName], type: QueryTypes.SELECT }
    );
    return result.cnt > 0;
}

/**
 * 升级：创建 player_artifact_spirits 表
 */
async function up() {
    console.log('[migration_0065] 开始执行：创建 player_artifact_spirits 表');

    if (await tableExists('player_artifact_spirits')) {
        console.log('  ⏭️ 表已存在：player_artifact_spirits');
        return;
    }

    // 创建表（MySQL 5.6 兼容：DATETIME DEFAULT CURRENT_TIMESTAMP 需用 TIMESTAMP 替代或显式 NULL）
    await sequelize.query(`
        CREATE TABLE player_artifact_spirits (
            id BIGINT NOT NULL AUTO_INCREMENT COMMENT '器灵记录ID',
            player_id BIGINT NOT NULL COMMENT '玩家ID',
            equipment_id BIGINT NOT NULL COMMENT '关联player_equipment.id（每件法宝一个器灵）',
            item_key VARCHAR(100) NOT NULL COMMENT '法宝配置键名（冗余存储便于查询）',
            spirit_type VARCHAR(20) NOT NULL COMMENT '器灵类型（attack攻灵/defense防灵/support辅灵/balance平灵）',
            spirit_name VARCHAR(50) DEFAULT NULL COMMENT '器灵自定义名称（玩家可命名）',
            spirit_level INT NOT NULL DEFAULT 1 COMMENT '器灵等级 1~10',
            spirit_exp INT NOT NULL DEFAULT 0 COMMENT '器灵当前经验值',
            intimacy INT NOT NULL DEFAULT 0 COMMENT '亲密度 0~100，影响护主/催发效果',
            power INT NOT NULL DEFAULT 0 COMMENT '力量值 0~1000，影响试炼分数与催发',
            is_awakened TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已唤醒（0未唤醒/1已唤醒）',
            awakened_at DATETIME DEFAULT NULL COMMENT '唤醒时间',
            last_pet_at DATETIME DEFAULT NULL COMMENT '上次抚摸时间（用于CD计算）',
            last_nurture_at DATETIME DEFAULT NULL COMMENT '上次温养时间（用于CD计算）',
            trial_best_score INT NOT NULL DEFAULT 0 COMMENT '试炼历史最高分',
            trial_total_count INT NOT NULL DEFAULT 0 COMMENT '试炼累计次数',
            trial_total_score BIGINT NOT NULL DEFAULT 0 COMMENT '试炼累计总分（排行榜依据）',
            last_trial_at DATETIME DEFAULT NULL COMMENT '上次试炼时间',
            last_trial_date DATE DEFAULT NULL COMMENT '上次试炼日期（用于每日次数重置）',
            daily_trial_count INT NOT NULL DEFAULT 0 COMMENT '今日试炼次数',
            protect_active_until DATETIME DEFAULT NULL COMMENT '护主状态结束时间（null=未护主）',
            activate_active_until DATETIME DEFAULT NULL COMMENT '催发状态结束时间（null=未催发）',
            last_protect_at DATETIME DEFAULT NULL COMMENT '上次护主时间（CD）',
            last_activate_at DATETIME DEFAULT NULL COMMENT '上次催发时间（CD）',
            state VARCHAR(20) NOT NULL DEFAULT 'idle' COMMENT '器灵当前状态（idle/protecting/activating）',
            created_at DATETIME DEFAULT NULL COMMENT '创建时间',
            updated_at DATETIME DEFAULT NULL COMMENT '更新时间',
            PRIMARY KEY (id),
            UNIQUE KEY uk_player_equipment (player_id, equipment_id),
            INDEX idx_player_id (player_id),
            INDEX idx_trial_total_score (trial_total_score),
            INDEX idx_trial_best_score (trial_best_score),
            INDEX idx_spirit_type (spirit_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='玩家法宝器灵表'
    `);
    console.log('  ✅ 创建表：player_artifact_spirits');

    console.log('[migration_0065] 执行完成');
}

/**
 * 回滚：删除 player_artifact_spirits 表
 */
async function down() {
    console.log('[migration_0065] 回滚：删除 player_artifact_spirits 表');
    if (await tableExists('player_artifact_spirits')) {
        await sequelize.query('DROP TABLE IF EXISTS player_artifact_spirits');
        console.log('  ✅ 已删除表：player_artifact_spirits');
    } else {
        console.log('  ⏭️ 表不存在：player_artifact_spirits');
    }
    console.log('[migration_0065] 回滚完成');
}

module.exports = { up, down };
