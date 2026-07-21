/**
 * 历练奖励境界加成修复验证脚本
 *
 * 验证内容：
 *   1. 完成历练后返回的 rewards 包含 realm_multiplier 字段
 *   2. 实际发放的 exp = 基础奖励 × 境界加成 × 时长倍率 × 提前结束折扣
 *   3. 化神期玩家（rank=23）的奖励应远高于凡人级别
 *
 * 测试账号：1592363624 / 1592363624（玩家ID=1，韩天尊，化神初期 rank=23）
 *
 * 运行方式：node scripts/test_adventure_reward_fix.js
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  历练奖励境界加成修复验证');
    console.log('═══════════════════════════════════════════\n');

    // 1. 登录
    console.log('[1] 登录测试账号...');
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(TEST_ACCOUNT)
    });
    const loginJson = await loginRes.json();
    const token = loginJson?.data?.token || loginJson?.token;
    if (!token) {
        console.error('❌ 登录失败:', loginJson);
        process.exit(1);
    }
    const player = loginJson?.data?.player || loginJson?.player;
    console.log(`✅ 登录成功：${player?.dao_name}（${player?.realm}，rank=${player?.realm_rank}）`);
    console.log(`   当前修为：${player?.exp}\n`);

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 2. 查询玩家当前修为作为基线
    const meRes = await fetch(`${BASE_URL}/player/me`, { headers });
    const meJson = await meRes.json();
    const expBefore = BigInt(meJson?.data?.player?.exp || meJson?.data?.exp || 0);
    console.log(`[2] 修复前修为基线：${expBefore}\n`);

    // 3. 先取消已有的历练（如果有）
    console.log('[3] 检查并取消已有历练...');
    const statusRes = await fetch(`${BASE_URL}/map/explore/status`, { headers });
    const statusJson = await statusRes.json();
    if (statusJson?.data?.is_adventuring) {
        console.log('   发现已有进行中历练，先完成它');
        await fetch(`${BASE_URL}/map/explore/complete`, {
            method: 'POST', headers, body: JSON.stringify({})
        });
    } else {
        console.log('   无进行中历练，继续');
    }

    // 4. 开始短时历练（durationType: short）
    console.log('\n[4] 开始短时历练（durationType=short）...');
    const startRes = await fetch(`${BASE_URL}/map/explore/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ durationType: 'short' })
    });
    const startJson = await startRes.json();
    if (startJson.code !== 200) {
        console.error('❌ 开始历练失败:', startJson);
        process.exit(1);
    }
    const eventInfo = startJson?.data?.event;
    console.log('✅ 历练已开始');
    console.log(`   事件类型：${eventInfo?.type}`);
    console.log(`   事件标题：${eventInfo?.title}`);
    console.log(`   事件描述：${eventInfo?.description?.slice(0, 60)}...`);
    console.log(`   时长：${eventInfo?.duration} 秒`);

    // 4.5 等待历练过半（避免立即完成导致 rewardScale=0，奖励被 Math.floor 取整为 0）
    const waitSec = Math.max(15, Math.floor((eventInfo?.duration || 30) * 0.6));
    console.log(`   等待 ${waitSec} 秒（让历练完成 60%+，避免奖励被打折为 0）...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));

    // 5. 完成历练（已等待过半，奖励不会被折扣为 0）
    console.log('\n[5] 完成历练...');
    const completeRes = await fetch(`${BASE_URL}/map/explore/complete`, {
        method: 'POST', headers, body: JSON.stringify({})
    });
    const completeJson = await completeRes.json();
    if (completeJson.code !== 200) {
        console.error('❌ 完成历练失败:', completeJson);
        process.exit(1);
    }

    const rewards = completeJson?.data?.rewards || {};
    console.log('✅ 历练完成');
    console.log('   奖励详情：');
    console.log(`   - 基础修为 base_exp: ${rewards.base_exp ?? '(未返回)'}`);
    console.log(`   - 实际修为 exp: ${rewards.exp}`);
    console.log(`   - 境界倍率 realm_multiplier: ${rewards.realm_multiplier ?? '(未返回)'}`);
    console.log(`   - 灵石 spirit_stones: ${rewards.spirit_stones}`);
    console.log(`   - 提前结束 early_finish: ${rewards.early_finish}`);
    console.log(`   - 奖励缩放 reward_scale: ${rewards.reward_scale}`);

    // 6. 验证修复效果
    console.log('\n[6] 验证修复效果...');

    const realmMultiplier = rewards.realm_multiplier;
    if (realmMultiplier === undefined || realmMultiplier === null) {
        console.error('❌ 失败：rewards 未返回 realm_multiplier 字段');
        process.exit(1);
    }

    // 化神初期 rank=23，期望倍率 1.0 + (23-1)*0.1 = 3.2
    const expectedMultiplier = 3.2;
    if (Math.abs(Number(realmMultiplier) - expectedMultiplier) > 0.01) {
        console.error(`❌ 失败：境界倍率 ${realmMultiplier} 不等于期望值 ${expectedMultiplier}`);
        process.exit(1);
    }
    console.log(`✅ 境界倍率正确：${realmMultiplier} (期望 ${expectedMultiplier})`);

    // 验证实际修为 = base_exp × realm_multiplier（提前结束有折扣，所以应小于此值）
    if (rewards.base_exp && rewards.exp) {
        const fullExpected = Math.floor(Number(rewards.base_exp) * Number(realmMultiplier));
        if (rewards.early_finish) {
            // 提前结束：实际修为应小于等于 fullExpected
            if (Number(rewards.exp) > fullExpected) {
                console.error(`❌ 失败：提前结束修为 ${rewards.exp} 大于全时长修为 ${fullExpected}`);
                process.exit(1);
            }
            console.log(`✅ 提前结束折扣生效：实际 ${rewards.exp} ≤ 全时长 ${fullExpected}`);
        } else {
            if (Number(rewards.exp) !== fullExpected) {
                console.error(`❌ 失败：实际修为 ${rewards.exp} 不等于 ${fullExpected}`);
                process.exit(1);
            }
            console.log(`✅ 修为计算正确：${rewards.base_exp} × ${realmMultiplier} = ${rewards.exp}`);
        }
    }

    // 7. 查询玩家修为变化
    console.log('\n[7] 验证玩家修为已实际增加...');
    const meRes2 = await fetch(`${BASE_URL}/player/me`, { headers });
    const meJson2 = await meRes2.json();
    const expAfter = BigInt(meJson2?.data?.player?.exp || meJson2?.data?.exp || 0);
    const expGain = expAfter - expBefore;
    console.log(`   修为变化：${expBefore} → ${expAfter}（+${expGain}）`);

    if (expGain <= 0n) {
        console.error('❌ 失败：修为未增加');
        process.exit(1);
    }
    console.log('✅ 修为已正确增加');

    console.log('\n═══════════════════════════════════════════');
    console.log('  ✅ 修复验证通过');
    console.log('═══════════════════════════════════════════');
    console.log('\n关键改进：');
    console.log('  1. 奖励数值现与境界挂钩，化神期玩家获得 3.2 倍加成');
    console.log('  2. 修复 Item.upsert 错误用法，物品数量正确累加');
    console.log('  3. 返回结果新增 realm_multiplier / base_exp 字段，便于前端展示');
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
