/**
 * 迁移 0053：世界BOSS 多行动机制（玩法文档第16节 世界 Boss 多行动机制）
 *
 * 为 world_bosses 表新增 3 个字段，支持阶段机制（幡魂/魔压/阵势）：
 *   - banner_soul      : 幡魂值（0-100，初始100，高时 Boss 减伤）
 *   - magic_pressure   : 魔压值（0-100，初始0，高时 Boss 攻击加强、玩家伤害下降）
 *   - array_integrity  : 阵势值（0-100，初始100，低时 Boss 全属性加强）
 *
 * 为 world_boss_damage_records 表新增 2 个字段，支持连续行动惩罚：
 *   - last_action    : 上次行动类型（assault/break_banner/suppress_soul/protect_array）
 *   - action_streak  : 连续相同行动次数（>=3 触发重复行动惩罚）
 *
 * 设计说明：
 *   - 幡魂/魔压/阵势 是阶段内动态状态，会随玩家行动变化
 *   - 行动类型记录在 damage_records 而非新建表，避免多表 JOIN，仅按 (boss_id, player_id) 维度统计
 *   - action_streak 用于"连续相同行动惩罚"判定，切换行动类型时重置为 1
 *
 * 幂等性：通过 describeTable 检查字段是否存在决定是否执行
 *
 * MySQL 5.6 兼容性：
 *   - 字符集 utf8mb4
 *   - ENGINE=InnoDB 支持事务与行级锁
 *   - VARCHAR(20) 存储 action_type 枚举字符串
 *
 * 创建时间：2026-07-21
 */
'use strict';

const path = require('path');
// 切换工作目录到 server 根，保证 require 数据库配置路径正确
process.chdir(path.resolve(__dirname, '..'));

const sequelize = require('../config/database');
const queryInterface = sequelize.getQueryInterface();
const logger = require('../modules').infrastructure.logger || console;

/**
 * 执行迁移：为 world_bosses 与 world_boss_damage_records 添加字段
 */
async function up() {
    console.log('[migration_0053] 开始执行世界BOSS 多行动机制迁移...');

    // ========== 1. world_bosses 表新增字段 ==========
    const bossTable = 'world_bosses';
    const bossDesc = await queryInterface.describeTable(bossTable);

    // 1.1 banner_soul 字段：幡魂值
    if (!bossDesc.banner_soul) {
        await queryInterface.addColumn(bossTable, 'banner_soul', {
            type: sequelize.Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 100,
            comment: '幡魂值（0-100，初始100，高时Boss减伤）'
        });
        console.log('[migration_0053] ✅ 已添加 world_bosses.banner_soul 字段');
    } else {
        console.log('[migration_0053] ⏭ world_bosses.banner_soul 字段已存在，跳过');
    }

    // 1.2 magic_pressure 字段：魔压值
    if (!bossDesc.magic_pressure) {
        await queryInterface.addColumn(bossTable, 'magic_pressure', {
            type: sequelize.Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
            comment: '魔压值（0-100，初始0，高时Boss攻击加强）'
        });
        console.log('[migration_0053] ✅ 已添加 world_bosses.magic_pressure 字段');
    } else {
        console.log('[migration_0053] ⏭ world_bosses.magic_pressure 字段已存在，跳过');
    }

    // 1.3 array_integrity 字段：阵势值
    if (!bossDesc.array_integrity) {
        await queryInterface.addColumn(bossTable, 'array_integrity', {
            type: sequelize.Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 100,
            comment: '阵势值（0-100，初始100，低时Boss全属性加强）'
        });
        console.log('[migration_0053] ✅ 已添加 world_bosses.array_integrity 字段');
    } else {
        console.log('[migration_0053] ⏭ world_bosses.array_integrity 字段已存在，跳过');
    }

    // ========== 2. world_boss_damage_records 表新增字段 ==========
    const recordTable = 'world_boss_damage_records';
    const recordDesc = await queryInterface.describeTable(recordTable);

    // 2.1 last_action 字段：上次行动类型
    if (!recordDesc.last_action) {
        await queryInterface.addColumn(recordTable, 'last_action', {
            type: sequelize.Sequelize.STRING(20),
            allowNull: true,
            defaultValue: null,
            comment: '上次行动类型（assault/break_banner/suppress_soul/protect_array）'
        });
        console.log('[migration_0053] ✅ 已添加 world_boss_damage_records.last_action 字段');
    } else {
        console.log('[migration_0053] ⏭ world_boss_damage_records.last_action 字段已存在，跳过');
    }

    // 2.2 action_streak 字段：连续相同行动次数
    if (!recordDesc.action_streak) {
        await queryInterface.addColumn(recordTable, 'action_streak', {
            type: sequelize.Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
            comment: '连续相同行动次数'
        });
        console.log('[migration_0053] ✅ 已添加 world_boss_damage_records.action_streak 字段');
    } else {
        console.log('[migration_0053] ⏭ world_boss_damage_records.action_streak 字段已存在，跳过');
    }

    console.log('[migration_0053] 迁移完成');
}

/**
 * 回滚迁移：移除所有新增字段
 */
async function down() {
    const bossTable = 'world_bosses';
    const recordTable = 'world_boss_damage_records';

    const bossDesc = await queryInterface.describeTable(bossTable);
    const recordDesc = await queryInterface.describeTable(recordTable);

    // world_bosses 字段移除（倒序）
    if (bossDesc.array_integrity) {
        await queryInterface.removeColumn(bossTable, 'array_integrity');
        console.log('[migration_0053] 已移除 world_bosses.array_integrity 字段');
    }
    if (bossDesc.magic_pressure) {
        await queryInterface.removeColumn(bossTable, 'magic_pressure');
        console.log('[migration_0053] 已移除 world_bosses.magic_pressure 字段');
    }
    if (bossDesc.banner_soul) {
        await queryInterface.removeColumn(bossTable, 'banner_soul');
        console.log('[migration_0053] 已移除 world_bosses.banner_soul 字段');
    }

    // world_boss_damage_records 字段移除
    if (recordDesc.action_streak) {
        await queryInterface.removeColumn(recordTable, 'action_streak');
        console.log('[migration_0053] 已移除 world_boss_damage_records.action_streak 字段');
    }
    if (recordDesc.last_action) {
        await queryInterface.removeColumn(recordTable, 'last_action');
        console.log('[migration_0053] 已移除 world_boss_damage_records.last_action 字段');
    }
}

// 支持直接运行：node server/scripts/migration_0053_world_boss_action_system.js
if (require.main === module) {
    up().then(() => {
        console.log('[migration_0053] 直接运行完成');
        process.exit(0);
    }).catch(err => {
        console.error('[migration_0053] 迁移失败:', err);
        process.exit(1);
    });
}

module.exports = { up, down };
