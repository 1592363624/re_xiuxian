/**
 * 迁移 0039：世界BOSS 技能系统字段
 *
 * 为 world_bosses 表新增 3 个字段，支持完整的 BOSS 技能表实现：
 *   - skill_cooldowns: JSON，存储各技能的冷却结束时间戳
 *       例：{ "飞剑斩": 0, "青元剑诀": 1784555900000, "万剑归宗": 0 }
 *   - active_buffs: JSON，存储 BOSS 当前激活的 Buff 列表
 *       例：[{ "name": "剑意狂暴", "effect": "self_buff_atk_up_50_percent",
 *             "atk_up_percent": 50, "expire_at": 1784555960000 }]
 *   - minions: JSON，存储 BOSS 召唤的小怪列表
 *       例：[{ "minion_id": "m_001", "name": "剑灵分身", "hp": 5000, "atk": 200 }]
 *
 * 设计说明：
 *   - 使用 JSON 类型而非关联表，避免多表 JOIN 性能开销
 *   - 小怪数量有限（通常 2-5 个），JSON 存储足够
 *   - Buff 与冷却时间戳都是临时状态，BOSS 死亡后随实例归档
 *
 * 幂等性：通过检查字段是否存在决定是否执行
 */
'use strict';

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const sequelize = require('../config/database');
const queryInterface = sequelize.getQueryInterface();
const logger = require('../modules').infrastructure.logger || console;

async function up() {
    const tableName = 'world_bosses';
    console.log(`[migration_0039] 开始为 ${tableName} 添加技能系统字段...`);

    // 获取现有字段列表
    const tableDesc = await queryInterface.describeTable(tableName);

    // 1. skill_cooldowns 字段
    if (!tableDesc.skill_cooldowns) {
        await queryInterface.addColumn(tableName, 'skill_cooldowns', {
            type: sequelize.Sequelize.JSON,
            allowNull: true,
            defaultValue: null,
            comment: '技能冷却结束时间戳映射 { skill_name: expire_timestamp_ms }'
        });
        console.log(`[migration_0039] ✅ 已添加 skill_cooldowns 字段`);
    } else {
        console.log(`[migration_0039] ⏭ skill_cooldowns 字段已存在，跳过`);
    }

    // 2. active_buffs 字段
    if (!tableDesc.active_buffs) {
        await queryInterface.addColumn(tableName, 'active_buffs', {
            type: sequelize.Sequelize.JSON,
            allowNull: true,
            defaultValue: null,
            comment: 'BOSS 当前激活的 Buff 列表 [{ name, effect, atk_up_percent, lifesteal_percent, immune_control, expire_at }]'
        });
        console.log(`[migration_0039] ✅ 已添加 active_buffs 字段`);
    } else {
        console.log(`[migration_0039] ⏭ active_buffs 字段已存在，跳过`);
    }

    // 3. minions 字段
    if (!tableDesc.minions) {
        await queryInterface.addColumn(tableName, 'minions', {
            type: sequelize.Sequelize.JSON,
            allowNull: true,
            defaultValue: null,
            comment: 'BOSS 召唤的小怪列表 [{ minion_id, name, hp_max, hp_current, atk, def, spawn_time }]'
        });
        console.log(`[migration_0039] ✅ 已添加 minions 字段`);
    } else {
        console.log(`[migration_0039] ⏭ minions 字段已存在，跳过`);
    }

    console.log(`[migration_0039] 迁移完成`);
}

async function down() {
    const tableName = 'world_bosses';
    const tableDesc = await queryInterface.describeTable(tableName);

    if (tableDesc.skill_cooldowns) {
        await queryInterface.removeColumn(tableName, 'skill_cooldowns');
        console.log(`[migration_0039] 已移除 skill_cooldowns 字段`);
    }
    if (tableDesc.active_buffs) {
        await queryInterface.removeColumn(tableName, 'active_buffs');
        console.log(`[migration_0039] 已移除 active_buffs 字段`);
    }
    if (tableDesc.minions) {
        await queryInterface.removeColumn(tableName, 'minions');
        console.log(`[migration_0039] 已移除 minions 字段`);
    }
}

if (require.main === module) {
    up().then(() => {
        console.log('[migration_0039] 直接运行完成');
        process.exit(0);
    }).catch(err => {
        console.error('[migration_0039] 迁移失败:', err);
        process.exit(1);
    });
}

module.exports = { up, down };
