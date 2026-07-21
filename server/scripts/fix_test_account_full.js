/**
 * 修复测试账号数据（B46 测试污染修复）
 *
 * 背景：test_batch_4_3_runtime.js 备份字段不完整，导致跑完测试后：
 *   - realm: 化神初期 → 凡人（被 /api/player/reincarnate 重置）
 *   - realm_rank: 23 → 0（被 /api/player/reincarnate 重置）
 *   - lifespan_current: 17.84（保持，被还原）
 *   - lifespan_max: 2000（保持，被还原）
 *   - hp_current: 100（被 reincarnate 重置为凡人基础）
 *   - mp_current: 100（被 reincarnate 重置为凡人基础）
 *
 * 修复策略：
 *   1. realm → "化神初期"，realm_rank → 23
 *   2. lifespan_current → 100（合理值，远离死亡）
 *   3. lifespan_max → 2000（化神期上限）
 *   4. hp_current → hp_max（满血）
 *   5. mp_current → mp_max（满蓝）
 *   6. is_dead → false（确保存活）
 *   7. is_secluded → false（不在闭关）
 *   8. is_meditating → false（不在悟道）
 *
 * 注：此脚本只在 dev 环境用于修复测试账号数据，生产环境不会运行
 */
require('dotenv').config();
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../models/player');
const game = require('../game');

async function main() {
    // 初始化
    configLoader.initialize();
    await require('../config/database').authenticate();
    await game.initializeGameServices(configLoader);

    const player = await Player.findByPk(1);
    if (!player) {
        console.log('测试账号 id=1 不存在');
        process.exit(1);
    }

    console.log('========================================');
    console.log('  测试账号数据修复 (B46)');
    console.log('========================================\n');

    console.log('【修复前】');
    console.log(`  realm: ${player.realm}`);
    console.log(`  realm_rank: ${player.realm_rank}`);
    console.log(`  is_dead: ${player.is_dead}`);
    console.log(`  lifespan_current: ${player.lifespan_current}`);
    console.log(`  lifespan_max: ${player.lifespan_max}`);
    console.log(`  hp_current: ${player.hp_current?.toString()}`);
    console.log(`  mp_current: ${player.mp_current?.toString()}`);
    console.log(`  is_secluded: ${player.is_secluded}`);
    console.log(`  is_meditating: ${player.is_meditating}`);
    console.log();

    // 修复字段
    player.realm = '化神初期';
    player.realm_rank = 23;
    player.is_dead = false;
    player.death_reason = null;
    player.death_time = null;
    player.lifespan_max = 2000; // 化神初期 lifespan_max
    player.lifespan_current = 100; // 合理初始值
    player.is_secluded = false;
    player.seclusion_end_time = null;
    player.last_seclusion_time = null;
    player.is_meditating = false;
    player.bottleneck_state = 'none';
    player.bottleneck_insight = 0;
    player.weakness_end_time = null;

    // 计算化神初期应有的满血满蓝值
    const realmConfig = game.RealmService.getRealmByName('化神初期');
    if (realmConfig) {
        // HP/MP 上限 = base_hp + 装备加成 + 灵根加成 + 灵兽加成等
        // 简化处理：使用 AttributeService 计算后的 final.hp_max
        try {
            const fullAttributes = await game.AttributeService.calculateFullAttributesAsync(player);
            const expectedHpMax = fullAttributes.final?.hp_max || realmConfig.base_hp;
            const expectedMpMax = fullAttributes.final?.mp_max || realmConfig.base_mp;
            player.hp_current = BigInt(expectedHpMax);
            player.mp_current = BigInt(expectedMpMax);
            console.log(`【计算】化神初期 final.hp_max=${expectedHpMax}, final.mp_max=${expectedMpMax}`);
        } catch (e) {
            // fallback：用 base_hp/base_mp
            player.hp_current = BigInt(realmConfig.base_hp);
            player.mp_current = BigInt(realmConfig.base_mp);
            console.log(`【fallback】使用 base_hp=${realmConfig.base_hp}, base_mp=${realmConfig.base_mp}`);
        }
    } else {
        player.hp_current = BigInt(3500);
        player.mp_current = BigInt(3200);
    }

    await player.save();

    console.log('\n【修复后】');
    console.log(`  realm: ${player.realm}`);
    console.log(`  realm_rank: ${player.realm_rank}`);
    console.log(`  is_dead: ${player.is_dead}`);
    console.log(`  lifespan_current: ${player.lifespan_current}`);
    console.log(`  lifespan_max: ${player.lifespan_max}`);
    console.log(`  hp_current: ${player.hp_current?.toString()}`);
    console.log(`  mp_current: ${player.mp_current?.toString()}`);
    console.log(`  is_secluded: ${player.is_secluded}`);
    console.log(`  is_meditating: ${player.is_meditating}`);

    console.log('\n========================================');
    console.log('  修复完成');
    console.log('========================================');
}

main().catch(err => {
    console.error('修复脚本执行失败:', err);
    process.exit(1);
});
