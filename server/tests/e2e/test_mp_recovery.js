/**
 * MP/HP 恢复机制验证脚本
 *
 * 测试目标：
 *   1. 验证 DualTimeService.processOfflineTime 能正确恢复 MP/HP
 *   2. 验证年龄增长（lifespan_current）正确更新
 *   3. 验证 24 小时上限限制
 *
 * 测试场景：
 *   - 场景1：MP=0, HP=3500, 离线 60 分钟 → MP 应恢复 60，HP 不变（已满）
 *   - 场景2：MP=0, HP=0, 离线 120 分钟 → MP 应恢复 120，HP 应恢复 120
 *   - 场景3：MP=3100, HP=3400, 离线 60 分钟 → MP 应恢复 100（不超上限），HP 应恢复 100（不超上限）
 *   - 场景4：离线 48 小时 → 实际恢复时长上限 24 小时
 *
 * 运行方式：
 *   cd server && node scripts/test_mp_recovery.js
 */
'use strict';

const sequelize = require('../config/database');
const Player = require('../models/player');
const { initializeModules } = require('../modules');
const game = require('../game');
const DualTimeService = require('../game/core/DualTimeService');
const AttributeMaxService = require('../game/core/AttributeMaxService');
const RealmService = require('../game/core/RealmService');

const testResults = { passed: 0, failed: 0, total: 0 };

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

async function main() {
    console.log('========================================');
    console.log('  MP/HP 恢复机制验证测试');
    console.log('========================================');

    await initializeModules();
    // 必须调用 initializeGameServices 才能让 AttributeMaxService.initialize 等执行
    // 否则 spiritConfig / attributeConfig 为 null，MP 上限会退化为 1000
    const configLoader = require('../modules/infrastructure/ConfigLoader');
    await game.initializeGameServices(configLoader);

    // 获取测试玩家
    const player = await Player.findByPk(1);
    if (!player) {
        console.error('未找到测试玩家');
        process.exit(1);
    }

    const fullAttrs = AttributeMaxService.calculateAttributeMaxValues(player, RealmService.getRealmByName(player.realm));
    const maxHp = fullAttrs.hp_max || 100;
    const maxMp = fullAttrs.mp_max || 0;
    console.log(`\n玩家: ${player.nickname} 境界: ${player.realm}`);
    console.log(`上限: HP=${maxHp} MP=${maxMp}`);

    // ===== 场景1: MP=0, HP=满, 离线 60 分钟 =====
    console.log('\n[场景1] MP=0, HP=满, 离线 60 分钟');
    player.mp_current = 0n;
    player.hp_current = BigInt(maxHp);
    player.lifespan_current = 17.0;
    const result1 = DualTimeService.processOfflineTime(player, 60 * 60);
    const mpAfter1 = Number(player.mp_current);
    const hpAfter1 = Number(player.hp_current);
    console.log(`  结果: HP ${maxHp}→${hpAfter1} (恢复 ${result1.hp_recovered}), MP 0→${mpAfter1} (恢复 ${result1.mp_recovered})`);
    assert(mpAfter1 === 60, 'MP 应恢复 60（1/分钟×60分钟）', { actual: mpAfter1, expected: 60 });
    assert(hpAfter1 === maxHp, 'HP 应保持满值（已满不再恢复）', { actual: hpAfter1, expected: maxHp });
    assert(result1.mp_recovered === 60, 'mp_recovered 应为 60', { actual: result1.mp_recovered });

    // ===== 场景2: MP=0, HP=0, 离线 120 分钟 =====
    console.log('\n[场景2] MP=0, HP=0, 离线 120 分钟');
    player.mp_current = 0n;
    player.hp_current = 0n;
    const result2 = DualTimeService.processOfflineTime(player, 120 * 60);
    const mpAfter2 = Number(player.mp_current);
    const hpAfter2 = Number(player.hp_current);
    console.log(`  结果: HP 0→${hpAfter2} (恢复 ${result2.hp_recovered}), MP 0→${mpAfter2} (恢复 ${result2.mp_recovered})`);
    assert(mpAfter2 === 120, 'MP 应恢复 120', { actual: mpAfter2, expected: 120 });
    assert(hpAfter2 === 120, 'HP 应恢复 120', { actual: hpAfter2, expected: 120 });

    // ===== 场景3: MP=3100, HP=3400, 离线 60 分钟（未达上限，正常恢复 60）=====
    console.log('\n[场景3] MP=3100, HP=3400, 离线 60 分钟（未达上限，正常恢复 60）');
    player.mp_current = 3100n;
    player.hp_current = 3400n;
    const result3 = DualTimeService.processOfflineTime(player, 60 * 60);
    const mpAfter3 = Number(player.mp_current);
    const hpAfter3 = Number(player.hp_current);
    console.log(`  结果: HP 3400→${hpAfter3} (恢复 ${result3.hp_recovered}), MP 3100→${mpAfter3} (恢复 ${result3.mp_recovered})`);
    // MP 上限很大（100000），60 分钟只恢复 60，不会触顶
    assert(mpAfter3 === 3160, 'MP 应恢复 60（3100+60=3160，未触顶）', { actual: mpAfter3, expected: 3160 });
    // HP 上限 3500，3400 + 60 = 3460，未触顶
    assert(hpAfter3 === 3460, 'HP 应恢复 60（3400+60=3460，未触顶）', { actual: hpAfter3, expected: 3460 });
    assert(result3.mp_recovered === 60, 'mp_recovered 应为 60', { actual: result3.mp_recovered });

    // ===== 场景3b: HP=3499, 离线 60 分钟（接近 HP 上限 3500，应触顶）=====
    console.log('\n[场景3b] HP=3499, MP=0, 离线 60 分钟（HP 接近上限 3500，应触顶）');
    player.mp_current = 0n;
    player.hp_current = 3499n;
    const result3b = DualTimeService.processOfflineTime(player, 60 * 60);
    const hpAfter3b = Number(player.hp_current);
    console.log(`  结果: HP 3499→${hpAfter3b} (恢复 ${result3b.hp_recovered})`);
    // 3499 + 60 = 3559，但上限 3500，所以应触顶为 3500，hp_recovered = 1
    assert(hpAfter3b === maxHp, `HP 应触顶为 ${maxHp}`, { actual: hpAfter3b, expected: maxHp });
    assert(result3b.hp_recovered === 1, 'hp_recovered 应为 1（触顶限制）', { actual: result3b.hp_recovered });

    // ===== 场景4: 离线 48 小时（超过 24 小时上限）=====
    console.log('\n[场景4] 离线 48 小时（超过 24 小时上限）');
    player.mp_current = 0n;
    player.hp_current = 0n;
    const result4 = DualTimeService.processOfflineTime(player, 48 * 3600);
    const mpAfter4 = Number(player.mp_current);
    console.log(`  结果: MP 0→${mpAfter4} (恢复 ${result4.mp_recovered})`);
    // 24小时 = 1440分钟，应恢复 1440，但被 maxMp 上限限制
    const expectedMp4 = Math.min(1440, maxMp);
    assert(mpAfter4 === expectedMp4, `MP 应恢复至 ${expectedMp4}（24小时上限×1/分钟，再被 maxMp 限制）`, { actual: mpAfter4, expected: expectedMp4 });

    // ===== 场景5: 在线时间恢复（processOnlineTime）=====
    console.log('\n[场景5] 在线 30 分钟（processOnlineTime）');
    player.mp_current = 0n;
    player.hp_current = 0n;
    const result5 = DualTimeService.processOnlineTime(player, 30 * 60);
    const mpAfter5 = Number(player.mp_current);
    console.log(`  结果: MP 0→${mpAfter5} (恢复 ${result5.mp_recovered})`);
    assert(mpAfter5 === 30, 'MP 应恢复 30', { actual: mpAfter5, expected: 30 });

    // ===== 场景6: 年龄增长验证 =====
    console.log('\n[场景6] 年龄增长验证（离线 24 小时）');
    player.lifespan_current = 17.0;
    DualTimeService.processOfflineTime(player, 24 * 3600);
    // 24小时 = 1游戏天，1/365 年 ≈ 0.00274 年
    const expectedAge = 17.0 + (24 / 365);
    const ageDiff = Math.abs(player.lifespan_current - expectedAge);
    assert(ageDiff < 0.001, `年龄应增长约 0.0658 年（24小时/365）`, { actual: player.lifespan_current, expected: expectedAge });

    // ===== 场景7: 空值保护（player=null）=====
    console.log('\n[场景7] 空值保护（player=null）');
    const result7 = DualTimeService.processOfflineTime(null, 3600);
    assert(result7.hp_recovered === 0 && result7.mp_recovered === 0, 'null player 应返回 0 恢复值', result7);

    // ===== 测试结果汇总 =====
    console.log('\n========================================');
    console.log(`  测试结果: ${testResults.passed}/${testResults.total} 通过, ${testResults.failed} 失败`);
    console.log('========================================');

    await sequelize.close();
    process.exit(testResults.failed === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('测试执行失败:', err);
    process.exit(1);
});
