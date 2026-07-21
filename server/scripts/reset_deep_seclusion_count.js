/**
 * 重置测试账号的深度闭关每日次数
 * 用于让用户能立即测试深度闭关功能
 *
 * 注意：仅用于测试环境数据还原，生产环境慎用
 */
'use strict';

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
require('dotenv').config();

const Player = require('../models/player');

async function main() {
    const player = await Player.findByPk(1);
    if (!player) {
        console.log('玩家不存在');
        process.exit(1);
    }

    console.log('重置前:');
    console.log(`  daily_seclusion_count: ${player.daily_seclusion_count}`);
    console.log(`  daily_deep_seclusion_count: ${player.daily_deep_seclusion_count}`);
    console.log(`  last_seclusion_date: ${player.last_seclusion_date}`);

    // 重置每日次数（不修改 last_seclusion_time，保留冷却记录）
    player.daily_seclusion_count = 0;
    player.daily_deep_seclusion_count = 0;
    await player.save();

    console.log('\n重置后:');
    console.log(`  daily_seclusion_count: ${player.daily_seclusion_count}`);
    console.log(`  daily_deep_seclusion_count: ${player.daily_deep_seclusion_count}`);
    console.log('\n✅ 已重置，用户可立即测试深度闭关功能');
    process.exit(0);
}

main().catch(err => {
    console.error('异常:', err);
    process.exit(1);
});
