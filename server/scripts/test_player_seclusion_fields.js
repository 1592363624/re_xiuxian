/**
 * 检查玩家深度闭关相关字段
 * 排查 daily_deep_seclusion_count=1 的来源
 */
'use strict';

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
require('dotenv').config();

const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../models/player');

async function main() {
    // 等待配置加载
    await new Promise(resolve => setTimeout(resolve, 1000));

    const player = await Player.findByPk(1);
    if (!player) {
        console.log('玩家不存在');
        process.exit(1);
    }

    console.log('========================================');
    console.log('玩家深度闭关相关字段');
    console.log('========================================');
    console.log(`  id: ${player.id}`);
    console.log(`  nickname: ${player.nickname}`);
    console.log(`  realm: ${player.realm}`);
    console.log(`  realm_rank: ${player.realm_rank}`);
    console.log(`  is_secluded: ${player.is_secluded}`);
    console.log(`  seclusion_mode: ${player.seclusion_mode}`);
    console.log(`  seclusion_start_time: ${player.seclusion_start_time}`);
    console.log(`  seclusion_end_time: ${player.seclusion_end_time}`);
    console.log(`  seclusion_duration: ${player.seclusion_duration}`);
    console.log(`  daily_seclusion_count: ${player.daily_seclusion_count}`);
    console.log(`  daily_deep_seclusion_count: ${player.daily_deep_seclusion_count}`);
    console.log(`  last_seclusion_date: ${player.last_seclusion_date}`);
    console.log(`  last_seclusion_time: ${player.last_seclusion_time}`);
    console.log('');

    const today = new Date().toISOString().split('T')[0];
    console.log(`  今天: ${today}`);
    console.log(`  last_seclusion_date 是否今天: ${player.last_seclusion_date === today}`);
    console.log('');

    // 检查是否需要跨日重置
    if (player.last_seclusion_date !== today) {
        console.log('  ⚠️ last_seclusion_date 不是今天，应该触发跨日重置！');
        console.log('  → 但实际 daily_deep_seclusion_count=1，说明跨日重置逻辑没生效');
    } else {
        console.log('  ✅ last_seclusion_date 是今天，无需跨日重置');
        console.log('  → daily_deep_seclusion_count=1 是今天用过一次的结果');
    }

    process.exit(0);
}

main().catch(err => {
    console.error('异常:', err);
    process.exit(1);
});
