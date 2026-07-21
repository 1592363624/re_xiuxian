/**
 * 道侣护道机制端到端测试脚本
 *
 * 测试目标：
 *   1. 验证数据库迁移 v0040 成功执行，dao_companion_protect_log 表已创建
 *   2. 验证 DaoCompanionService.tryProtect 在各种条件下的判定逻辑
 *   3. 验证护道日志写入、亲密度更新、统计查询
 *   4. 验证冷却机制（同一对道侣1小时内不重复触发）
 *
 * 测试场景：
 *   - 场景1：无道侣关系 → 不触发护道
 *   - 场景2：道侣心契等级 < 2 → 不触发护道
 *   - 场景3：亲密度 < 50 → 不触发护道
 *   - 场景4：心契 L2 + 亲密度 50 + 概率命中 → 触发护道，验证日志和亲密度
 *   - 场景5：冷却期内 → 不触发护道
 *   - 场景6：护道日志分页查询
 *   - 场景7：护道统计查询
 *
 * 运行方式：
 *   cd server && node scripts/test_dao_companion_protect.js
 */
'use strict';

const sequelize = require('../config/database');
const { QueryTypes, Op } = require('sequelize');
const DaoCompanionService = require('../game/services/DaoCompanionService');
const DaoCompanions = require('../models/daoCompanions');
const DaoCompanionProtectLog = require('../models/daoCompanionProtectLog');
const Player = require('../models/player');
const migrationManager = require('./migration_manager');
const { initializeModules } = require('../modules');
const { infrastructure } = require('../modules');

// 测试结果统计
const testResults = { passed: 0, failed: 0, skipped: 0, total: 0 };

/**
 * 断言工具
 * @param {boolean} condition - 条件
 * @param {string} message - 描述
 * @param {Object} [extra] - 附加信息
 */
function assert(condition, message, extra = null) {
    testResults.total++;
    if (condition) {
        testResults.passed++;
        console.log(`  ✅ ${message}`);
    } else {
        testResults.failed++;
        console.error(`  ❌ ${message}`);
        if (extra) console.error('     附加信息:', JSON.stringify(extra, null, 2));
    }
}

/**
 * 测试用例：无道侣关系
 */
async function testCase1_NoCompanion() {
    console.log('\n[场景1] 无道侣关系 → 不触发护道');
    // 找一个没有道侣关系的玩家（id 999999 假设不存在）
    const result = await DaoCompanionService.tryProtect(999999, 1000);
    assert(result.triggered === false, '应返回 triggered=false', result);
    assert(result.reason === 'no_companion', 'reason 应为 no_companion', result);
}

/**
 * 测试用例：心契等级 < 2
 */
async function testCase2_LowHeartLevel() {
    console.log('\n[场景2] 道侣心契等级 < 2 → 不触发护道');
    // 查找一个有道侣但心契等级 < 2 的玩家
    const companion = await DaoCompanions.findOne({
        where: {
            status: 'accepted',
            heart_contract_level: { [Op.lt]: 2 }
        }
    });
    if (!companion) {
        console.log('  ⏭️ 跳过：数据库中无符合条件的道侣关系');
        testResults.skipped++;
        testResults.total++;
        return;
    }
    const defenderId = companion.player_a_id;
    const result = await DaoCompanionService.tryProtect(defenderId, 1000);
    assert(result.triggered === false, '应返回 triggered=false', result);
    assert(result.reason && result.reason.startsWith('heart_level_too_low'),
        'reason 应以 heart_level_too_low 开头', result);
}

/**
 * 测试用例：亲密度 < 50
 */
async function testCase3_LowIntimacy() {
    console.log('\n[场景3] 亲密度 < 50 → 不触发护道');
    const companion = await DaoCompanions.findOne({
        where: {
            status: 'accepted',
            heart_contract_level: { [Op.gte]: 2 },
            intimacy: { [Op.lt]: 50 }
        }
    });
    if (!companion) {
        console.log('  ⏭️ 跳过：数据库中无符合条件的道侣关系');
        testResults.skipped++;
        testResults.total++;
        return;
    }
    const defenderId = companion.player_a_id;
    const result = await DaoCompanionService.tryProtect(defenderId, 1000);
    assert(result.triggered === false, '应返回 triggered=false', result);
    assert(result.reason && result.reason.startsWith('intimacy_too_low'),
        'reason 应以 intimacy_too_low 开头', result);
}

/**
 * 测试用例：心契 L2 + 亲密度 50 + 强制概率命中
 * 为了保证测试稳定，我们临时修改概率配置
 */
async function testCase4_TriggeredProtect() {
    console.log('\n[场景4] 心契 L2 + 亲密度 50 + 100%概率 → 触发护道');
    // 临时备份并修改配置
    const configLoader = infrastructure.ConfigLoader;
    const originalConfig = configLoader.getConfig('dao_companion_data');
    const testConfig = JSON.parse(JSON.stringify(originalConfig));
    // 强制 100% 触发
    testConfig.heart_contract_protect.level_protect_rate = {
        '2': 1.0, '3': 1.0, '4': 1.0, '5': 1.0, '6': 1.0, '7': 1.0, '8': 1.0, '9': 1.0
    };
    testConfig.heart_contract_protect.counter_attack_rate = 1.0;  // 反击也100%
    testConfig.heart_contract_protect.cooldown_seconds = 0;  // 测试时无冷却

    // 直接覆盖配置缓存（configCache 是 Map）
    configLoader.configCache.set('dao_companion_data', testConfig);

    try {
        // 查找符合条件的道侣
        let companion = await DaoCompanions.findOne({
            where: {
                status: 'accepted',
                heart_contract_level: { [Op.gte]: 2 },
                intimacy: { [Op.gte]: 50 }
            }
        });

        if (!companion) {
            console.log('  ⏭️ 跳过：数据库中无符合条件的道侣关系（需要先建立道侣并提升心契/亲密度）');
            testResults.skipped++;
            testResults.total++;
            return;
        }

        const defenderId = companion.player_a_id;
        const originalIntimacy = companion.intimacy;
        const incomingDamage = 1000;

        const result = await DaoCompanionService.tryProtect(defenderId, incomingDamage, {
            battleType: 'pvp',
            attackerId: 888888,
            protectorAtk: 200,
            battleRound: 1
        });

        assert(result.triggered === true, '应触发护道', result);
        if (result.triggered) {
            assert(result.shared_damage !== '0', '分担伤害应 > 0', result);
            assert(result.counter_damage !== '0', '反击伤害应 > 0（100%反击率）', result);
            assert(result.actual_damage_to_defender < incomingDamage,
                '被攻击方实际承受伤害应 < 原始伤害', {
                    actual: result.actual_damage_to_defender,
                    original: incomingDamage
                });
            assert(result.protector_id !== null, '护道方ID不应为空', result);
            assert(result.log_id !== null, '日志ID不应为空', result);

            // 验证日志记录
            const logRecord = await DaoCompanionProtectLog.findByPk(result.log_id);
            assert(logRecord !== null, '护道日志应已写入数据库', { log_id: result.log_id });
            if (logRecord) {
                assert(Number(logRecord.original_damage) === incomingDamage,
                    '日志中原始伤害应匹配', { expected: incomingDamage, actual: logRecord.original_damage });
                assert(Number(logRecord.defender_id) === Number(defenderId),
                    '日志中 defender_id 应匹配', { expected: defenderId, actual: logRecord.defender_id });
            }

            // 验证亲密度增加
            const updatedCompanion = await DaoCompanions.findByPk(companion.id);
            const expectedIntimacy = Math.min(100, originalIntimacy + 2);
            assert(Number(updatedCompanion.intimacy) === expectedIntimacy,
                '亲密度应增加 2', {
                    expected: expectedIntimacy,
                    actual: updatedCompanion.intimacy,
                    original: originalIntimacy
                });
        }
    } finally {
        // 恢复原始配置
        configLoader.configCache.set('dao_companion_data', originalConfig);
    }
}

/**
 * 测试用例：冷却机制
 */
async function testCase5_Cooldown() {
    console.log('\n[场景5] 冷却期内 → 不触发护道');
    // 找一对最近1小时内有护道记录的道侣
    const recentLog = await DaoCompanionProtectLog.findOne({
        where: {
            created_at: { [require('sequelize').Op.gt]: new Date(Date.now() - 3600 * 1000) }
        },
        order: [['created_at', 'DESC']]
    });
    if (!recentLog) {
        console.log('  ⏭️ 跳过：数据库中无近期护道记录');
        testResults.skipped++;
        testResults.total++;
        return;
    }
    const result = await DaoCompanionService.tryProtect(recentLog.defender_id, 1000);
    assert(result.triggered === false, '应返回 triggered=false（冷却中）', result);
    assert(result.reason === 'in_cooldown', 'reason 应为 in_cooldown', result);
}

/**
 * 测试用例：护道日志查询
 */
async function testCase6_QueryLogs() {
    console.log('\n[场景6] 护道日志分页查询');
    // 找一个有护道记录的玩家
    const logRecord = await DaoCompanionProtectLog.findOne();
    if (!logRecord) {
        console.log('  ⏭️ 跳过：数据库中无护道记录');
        testResults.skipped++;
        testResults.total++;
        return;
    }
    const playerId = logRecord.defender_id;
    const result = await DaoCompanionService.getProtectLogs(playerId, { page: 1, limit: 5 });
    assert(result.success === true, '查询应成功', result);
    assert(Array.isArray(result.data.logs), 'logs 应为数组', result.data);
    assert(result.data.page === 1, '当前页应为 1', result.data);
    assert(result.data.limit === 5, '每页条数应为 5', result.data);

    // 测试 role=defender
    const defenderResult = await DaoCompanionService.getProtectLogs(playerId, { role: 'defender', limit: 50 });
    assert(defenderResult.success === true, 'role=defender 查询应成功', defenderResult);
    // 验证所有返回的记录的 defender_id 都是 playerId
    const allDefender = defenderResult.data.logs.every(l => Number(l.defender_id) === Number(playerId));
    assert(allDefender, '所有记录的 defender_id 应匹配查询玩家', { player_id: playerId });
}

/**
 * 测试用例：护道统计
 */
async function testCase7_Stats() {
    console.log('\n[场景7] 护道统计查询');
    const logRecord = await DaoCompanionProtectLog.findOne();
    if (!logRecord) {
        console.log('  ⏭️ 跳过：数据库中无护道记录');
        testResults.skipped++;
        testResults.total++;
        return;
    }
    const playerId = logRecord.defender_id;
    const result = await DaoCompanionService.getProtectStats(playerId);
    assert(result.success === true, '统计查询应成功', result);
    assert(result.data.as_defender && typeof result.data.as_defender.total_count === 'number',
        'as_defender.total_count 应为数字', result.data);
    assert(result.data.as_protector && typeof result.data.as_protector.total_count === 'number',
        'as_protector.total_count 应为数字', result.data);
    assert(result.data.as_defender.total_count > 0,
        '该玩家作为被护道方的次数应 > 0', result.data.as_defender);
    console.log('     被护道方统计:', result.data.as_defender);
    console.log('     护道方统计:', result.data.as_protector);
}

/**
 * 主测试入口
 */
async function main() {
    console.log('========================================');
    console.log('  道侣护道机制端到端测试');
    console.log('========================================');

    try {
        // 步骤0：初始化模块（加载配置）
        console.log('[步骤0] 初始化模块（加载配置）...');
        await initializeModules();

        // 步骤1：执行迁移
        console.log('\n[步骤1] 执行数据库迁移 v0040...');
        await migrationManager.migrate();

        // 步骤2：验证表已创建
        console.log('\n[步骤2] 验证 dao_companion_protect_log 表...');
        const [tableCheck] = await sequelize.query(
            `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dao_companion_protect_log'`,
            { type: QueryTypes.SELECT }
        );
        assert(!!tableCheck, 'dao_companion_protect_log 表应存在', tableCheck);

        // 步骤3：验证表结构
        console.log('\n[步骤3] 验证表结构...');
        const [columns] = await sequelize.query(
            `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dao_companion_protect_log' ORDER BY ORDINAL_POSITION`
        );
        const columnNames = columns.map(c => c.COLUMN_NAME);
        const expectedColumns = ['id', 'companion_id', 'attacker_id', 'defender_id', 'protector_id',
            'original_damage', 'shared_damage', 'counter_damage', 'heart_contract_level',
            'protect_rate', 'damage_share_rate', 'counter_attack_rate', 'battle_type',
            'battle_id', 'battle_round', 'remark', 'created_at'];
        const missingColumns = expectedColumns.filter(c => !columnNames.includes(c));
        assert(missingColumns.length === 0,
            `表应包含所有预期字段（缺失: ${missingColumns.join(',')}）`, { actual: columnNames });

        // 步骤4：运行测试场景
        await testCase1_NoCompanion();
        await testCase2_LowHeartLevel();
        await testCase3_LowIntimacy();
        await testCase4_TriggeredProtect();
        await testCase5_Cooldown();
        await testCase6_QueryLogs();
        await testCase7_Stats();

        // 输出总结
        console.log('\n========================================');
        console.log('  测试总结');
        console.log('========================================');
        console.log(`  总用例: ${testResults.total}`);
        console.log(`  通过:   ${testResults.passed}`);
        console.log(`  失败:   ${testResults.failed}`);
        console.log(`  跳过:   ${testResults.skipped}`);
        console.log('========================================\n');

        if (testResults.failed > 0) {
            process.exit(1);
        } else {
            process.exit(0);
        }
    } catch (err) {
        console.error('\n[测试执行失败]', err);
        process.exit(2);
    }
}

// 启动测试
main();
