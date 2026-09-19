/**
 * 道侣系统境界修复验证脚本
 *
 * 验证 migration_0038 修复后，道侣系统境界判断是否正常：
 *   1. 玩家1（韩天尊，化神初期，rank=23）的 can_propose 应为 true
 *   2. 查询其他玩家列表，找到合适的求婚目标
 *   3. 尝试求婚流程（创建求婚 + 查询求婚列表）
 */
'use strict';

const BASE = 'http://localhost:5000/api';

async function main() {
    console.log('=== 道侣系统境界修复验证 ===\n');

    // 1. 登录
    const loginResp = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '1592363624', password: '1592363624' })
    });
    const loginData = await loginResp.json();
    const token = loginData.token;
    console.log('1. 登录:', loginData.player?.nickname, '境界:', loginData.player?.realm);

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 2. 查询道侣信息，验证 can_propose
    const myResp = await fetch(`${BASE}/dao-companion/my`, { headers });
    const myData = await myResp.json();
    console.log('\n2. 道侣信息:');
    console.log('   has_companion:', myData.data?.has_companion);
    console.log('   can_propose:', myData.data?.can_propose);
    console.log('   current_realm_rank:', myData.data?.current_realm_rank);
    console.log('   min_realm_rank:', myData.data?.min_realm_rank);

    if (myData.data?.can_propose === true) {
        console.log('   ✅ 境界修复验证通过！化神初期(rank=23) >= 15，可以求婚');
    } else {
        console.log('   ❌ 境界修复失败！can_propose 应为 true');
    }

    // 3. 查询其他玩家作为求婚目标
    console.log('\n3. 查询可求婚的目标玩家...');
    const playersResp = await fetch(`${BASE}/ranking?limit=10`, { headers });
    const playersData = await playersResp.json();
    const players = playersData.data?.ranking || playersData.data?.players || [];
    let targetPlayer = null;
    for (const p of players) {
        if (p.player_id !== 1 && p.id !== 1) {
            targetPlayer = p;
            break;
        }
    }

    if (!targetPlayer) {
        console.log('   ⚠️ 没有找到其他玩家作为求婚目标（需要至少2个玩家）');
        console.log('   当前玩家列表:', players.map(p => ({ id: p.player_id || p.id, name: p.nickname, realm: p.realm })).slice(0, 5));
        return;
    }

    console.log('   找到目标玩家:', targetPlayer.nickname || targetPlayer.player_name, 'ID:', targetPlayer.player_id || targetPlayer.id);

    // 4. 尝试求婚
    const targetId = targetPlayer.player_id || targetPlayer.id;
    console.log(`\n4. 尝试向玩家 ${targetId} 求婚...`);
    const proposeResp = await fetch(`${BASE}/dao-companion/propose`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ target_player_id: targetId })
    });
    const proposeData = await proposeResp.json();
    console.log('   HTTP状态:', proposeResp.status);
    console.log('   响应:', JSON.stringify(proposeData, null, 2));

    if (proposeData.success) {
        console.log('   ✅ 求婚成功！境界校验通过');

        // 5. 查询求婚列表
        const proposalsResp = await fetch(`${BASE}/dao-companion/proposals`, { headers });
        const proposalsData = await proposalsResp.json();
        console.log('\n5. 目标玩家收到的求婚列表:');
        console.log('   求婚数量:', proposalsData.data?.count);
    } else {
        console.log('   求婚失败:', proposeData.message);
        if (proposeData.message?.includes('境界不足')) {
            console.log('   ❌ 境界校验仍失败，需要进一步排查');
        } else {
            console.log('   ℹ️ 非境界原因失败（如已有道侣/目标已有道侣等），属正常业务逻辑');
        }
    }

    console.log('\n=== 验证完成 ===');
}

main().catch(err => {
    console.error('脚本异常:', err);
    process.exit(1);
});
