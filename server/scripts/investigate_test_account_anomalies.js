/**
 * 调查测试账号 lifespan_current 和 hp_current 异常偏低问题
 *
 * 背景：测试账号 (id=1, 韩天尊, 化神初期 rank=23)
 *   - lifespan_current=17.8122（化神期寿命应接近 2000，远低于正常值）
 *   - hp_current=100（化神期 HP 应在上千，远低于正常值）
 *   - attributes.hp_max=175（与 hp_current=100 不一致）
 *
 * 目标：定位根因并报告
 */
require('dotenv').config();
const path = require('path');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../models/player');
const game = require('../game');

async function main() {
    // 初始化配置
    configLoader.initialize();
    await require('../config/database').authenticate();
    await game.initializeGameServices(configLoader);

    const player = await Player.findByPk(1);
    if (!player) {
        console.log('测试账号 id=1 不存在');
        return;
    }

    console.log('========================================');
    console.log('  测试账号异常调查报告');
    console.log('========================================\n');

    // 1. 玩家基础信息
    console.log('【1】玩家基础信息');
    console.log(`  id: ${player.id}`);
    console.log(`  username: ${player.username}`);
    console.log(`  nickname: ${player.nickname}`);
    console.log(`  realm: ${player.realm}`);
    console.log(`  realm_rank: ${player.realm_rank}`);
    console.log(`  role: ${player.role}`);
    console.log(`  is_dead: ${player.is_dead}`);
    console.log(`  death_reason: ${player.death_reason}`);
    console.log(`  death_time: ${player.death_time}`);
    console.log(`  reincarnation_count: ${player.reincarnation_count}`);
    console.log(`  created_at: ${player.created_at}`);
    console.log(`  last_online: ${player.last_online}`);
    console.log();

    // 2. 寿命相关
    console.log('【2】寿元相关字段');
    console.log(`  lifespan_current: ${player.lifespan_current}`);
    console.log(`  lifespan_max: ${player.lifespan_max}`);
    const expectedLifespanMax = game.LifespanService.calculateMaxLifespan?.(player);
    console.log(`  [期望] 化神初期 lifespan_max: ${expectedLifespanMax || '未知（无 calculateMaxLifespan 方法）'}`);
    console.log();

    // 3. HP/MP 相关
    console.log('【3】HP/MP 字段');
    console.log(`  hp_current (原始): ${player.hp_current?.toString()}`);
    console.log(`  mp_current (原始): ${player.mp_current?.toString()}`);
    console.log(`  attributes: ${JSON.stringify(player.attributes, null, 2)}`);
    console.log();

    // 4. 计算应有属性
    console.log('【4】后端计算属性');
    try {
        const fullAttributes = await game.AttributeService.calculateFullAttributesAsync(player);
        console.log(`  最终属性 (final): ${JSON.stringify(fullAttributes.final, null, 2)}`);
        console.log(`  breakdown keys: ${Object.keys(fullAttributes.breakdown || {}).join(', ')}`);
    } catch (e) {
        console.log(`  计算失败: ${e.message}`);
    }
    console.log();

    // 5. 境界配置
    console.log('【5】化神初期境界配置');
    const realmConfig = game.RealmService.getRealmByName('化神初期');
    if (realmConfig) {
        console.log(`  境界配置: ${JSON.stringify(realmConfig, null, 2)}`);
    } else {
        console.log('  未找到"化神初期"境界配置');
    }
    console.log();

    // 6. 寿命配置
    console.log('【6】寿命相关配置');
    const gameBalance = configLoader.getConfig('game_balance');
    if (gameBalance?.lifespan) {
        console.log(`  lifespan 配置: ${JSON.stringify(gameBalance.lifespan, null, 2)}`);
    }
    if (gameBalance?.realm_lifespan) {
        console.log(`  realm_lifespan 配置: ${JSON.stringify(gameBalance.realm_lifespan, null, 2)}`);
    }
    console.log();

    // 7. 检查 LifespanService.getLifespanStatus
    console.log('【7】LifespanService.getLifespanStatus');
    try {
        const status = game.LifespanService.getLifespanStatus(player);
        console.log(`  status: ${JSON.stringify(status, null, 2)}`);
    } catch (e) {
        console.log(`  失败: ${e.message}`);
    }
    console.log();

    // 8. 突破历史 - 如果有 admin_log
    console.log('【8】最近 admin 操作历史');
    try {
        const AdminLog = require('../models/admin_log');
        const logs = await AdminLog.findAll({
            where: { admin_id: 1 },
            order: [['createdAt', 'DESC']],
            limit: 20
        });
        if (logs.length === 0) {
            console.log('  无 admin 操作日志');
        } else {
            logs.forEach(log => {
                console.log(`  [${log.createdAt}] action=${log.action}, details=${log.details}`);
            });
        }
    } catch (e) {
        console.log(`  查询失败: ${e.message}`);
    }
    console.log();

    // 9. 判断根因
    console.log('【9】根因分析');
    const hpCurrent = Number(player.hp_current?.toString() || '0');
    const lifespanCurrent = Number(player.lifespan_current || 0);

    if (hpCurrent === 100 && player.realm_rank >= 23) {
        console.log('  ⚠️ HP=100 异常：化神期玩家 HP 应在上千');
        console.log('     可能原因：admin 重置玩家/轮回重生后 hp_current 被重置为 100');
    }

    if (lifespanCurrent < 60 && player.realm_rank >= 23) {
        console.log('  ⚠️ lifespan_current=' + lifespanCurrent + ' 异常：化神期寿命应接近 2000');
        console.log('     可能原因 1: admin 重置玩家后未恢复 lifespan_current');
        console.log('     可能原因 2: admin time-travel 加速后寿命被错误重置');
        console.log('     可能原因 3: 玩家死亡后轮回，lifespan_current 被重置为 16（凡人初始值）');
    }

    if (player.lifespan_max < 2000 && player.realm_rank >= 23) {
        console.log('  ⚠️ lifespan_max=' + player.lifespan_max + ' 异常：化神期应=2000');
        console.log('     可能原因：境界变更未同步更新 lifespan_max');
    }

    console.log('\n========================================');
    console.log('  调查完成');
    console.log('========================================');
}

main().catch(err => {
    console.error('调查脚本执行失败:', err);
    process.exit(1);
});
