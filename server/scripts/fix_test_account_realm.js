/**
 * 修复测试账号 realm 与 realm_rank 不一致的数据修复脚本
 *
 * 背景：
 *   修复 B45（admin 强制突破只改 realm 不改 realm_rank 的 bug）后，
 *   需要把测试账号 ID=1 的 realm 从"凡人"恢复为 realm_rank=23 对应的境界名（化神期）
 *   当前 realm_rank=23 但 realm="凡人"，导致前端按 realm 显示"凡人"但业务按 rank 当化神期处理
 *
 * 修复策略：
 *   1. 读取 player.realm_rank（23）
 *   2. 通过 RealmService.getRealmByRank(23) 获取正确的境界名
 *   3. 更新 player.realm 为正确的境界名，保持 realm_rank 不变
 *   4. 同步检查 lifespan_current 等其他字段（不修改，只报告）
 */
const path = require('path');
const fs = require('fs');

// 加载 .env 环境变量
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Player = require('../models/player');
const { infrastructure } = require('../modules');
const RealmService = require('../game/core/RealmService');

(async () => {
    console.log('========================================');
    console.log('  修复测试账号 realm 与 realm_rank 不一致');
    console.log('========================================\n');

    // 初始化配置加载器
    const configLoader = infrastructure.ConfigLoader;
    if (typeof configLoader.initialize === 'function') {
        await configLoader.initialize();
    }
    console.log('配置加载器初始化完成');

    // 查询测试账号
    const player = await Player.findByPk(1);
    if (!player) {
        console.error('❌ 测试账号 ID=1 不存在');
        process.exit(1);
    }

    console.log('\n修复前状态:');
    console.log(`  nickname: ${player.nickname}`);
    console.log(`  realm: ${player.realm}`);
    console.log(`  realm_rank: ${player.realm_rank}`);
    console.log(`  lifespan_current: ${player.lifespan_current}`);
    console.log(`  lifespan_max: ${player.lifespan_max}`);
    console.log(`  is_dead: ${player.is_dead}`);
    console.log(`  hp_current: ${player.hp_current}`);
    console.log(`  exp: ${player.exp}`);

    // 根据 realm_rank 获取正确的境界名
    const correctRealm = RealmService.getRealmByRank(player.realm_rank);
    if (!correctRealm) {
        console.error(`❌ 找不到 rank=${player.realm_rank} 对应的境界配置`);
        process.exit(1);
    }

    console.log(`\n根据 realm_rank=${player.realm_rank} 推断正确境界:`);
    console.log(`  境界名: ${correctRealm.name}`);
    console.log(`  rank: ${correctRealm.rank}`);
    console.log(`  id: ${correctRealm.id}`);

    if (player.realm === correctRealm.name) {
        console.log('\n✅ realm 与 realm_rank 已一致，无需修复');
        process.exit(0);
    }

    // 执行修复
    console.log(`\n修复: realm 从 "${player.realm}" 改为 "${correctRealm.name}"`);
    player.realm = correctRealm.name;
    // realm_rank 保持不变（已是正确的 23）
    await player.save();

    // 验证修复
    const after = await Player.findByPk(1);
    console.log('\n修复后状态:');
    console.log(`  nickname: ${after.nickname}`);
    console.log(`  realm: ${after.realm}`);
    console.log(`  realm_rank: ${after.realm_rank}`);
    console.log(`  一致性检查: ${after.realm === RealmService.getRealmByRank(after.realm_rank).name ? '✅ 一致' : '❌ 不一致'}`);

    // 检查其他异常字段（仅报告，不修复）
    console.log('\n其他字段检查（仅报告）:');
    if (after.lifespan_current < 100) {
        console.log(`  ⚠️ lifespan_current=${after.lifespan_current} 偏低（化神期寿命应接近 2000）`);
    }
    if (after.hp_current < 1000) {
        console.log(`  ⚠️ hp_current=${after.hp_current} 偏低（化神期 HP 应在上千）`);
    }

    console.log('\n✅ 修复完成');
    process.exit(0);
})().catch(err => {
    console.error('修复失败:', err);
    process.exit(1);
});
