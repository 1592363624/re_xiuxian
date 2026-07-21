/**
 * 妖兽入侵玩法快速验证脚本
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  妖兽入侵玩法验证');
    console.log('═══════════════════════════════════════════\n');

    // 登录
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(TEST_ACCOUNT)
    });
    const loginJson = await loginRes.json();
    const token = loginJson?.data?.token || loginJson?.token;
    if (!token) { console.error('登录失败:', loginJson); process.exit(1); }
    console.log('[1] 登录成功\n');

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 查询活跃妖兽
    console.log('[2] 查询活跃妖兽入侵...');
    const aRes = await fetch(`${BASE_URL}/beast-invasion/active`, { headers });
    const aJson = await aRes.json();
    console.log(`  code: ${aJson.code}, message: ${aJson.message || ''}`);
    console.log(`  data: ${JSON.stringify(aJson.data)?.slice(0, 200)}\n`);

    let invasionId = aJson?.data?.id;

    // 如果没有活跃妖兽，调用管理员接口开启
    if (!invasionId) {
        console.log('[3] 管理员开启妖兽入侵（血狼妖兽，2 小时）...');
        const spRes = await fetch(`${BASE_URL}/admin/beast-invasion/spawn`, {
            method: 'POST', headers,
            body: JSON.stringify({ beast_key: 'xuelang_yaoshou', hours: 2 })
        });
        const spJson = await spRes.json();
        console.log(`  code: ${spJson.code}, message: ${spJson.message || ''}`);
        invasionId = spJson?.data?.invasion?.id || spJson?.data?.invasion_id || spJson?.data?.id;
        console.log(`  invasion_id: ${invasionId}`);
        if (!invasionId) {
            console.error('  开启失败:', JSON.stringify(spJson).slice(0, 500));
            process.exit(1);
        }
    } else {
        console.log(`[3] 已有活跃妖兽入侵 ID=${invasionId}，跳过开启步骤`);
    }

    // 查询详情
    console.log('\n[4] 查询妖兽详情...');
    const dRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}`, { headers });
    const dJson = await dRes.json();
    console.log(`  code: ${dJson.code}`);
    console.log(`  beast_name: ${dJson?.data?.beast_name || dJson?.data?.invasion?.beast_name}`);
    console.log(`  phase: ${dJson?.data?.phase || dJson?.data?.invasion?.phase}`);
    console.log(`  hp: ${dJson?.data?.hp_current || dJson?.data?.invasion?.hp_current} / ${dJson?.data?.hp_max || dJson?.data?.invasion?.hp_max}`);
    console.log(`  donation: ${dJson?.data?.donation_current || dJson?.data?.invasion?.donation_current} / ${dJson?.data?.donation_target || dJson?.data?.invasion?.donation_target}`);

    // 捐献灵石 100
    console.log('\n[5] 捐献灵石 100...');
    const cRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/contribute`, {
        method: 'POST', headers,
        body: JSON.stringify({ item_key: 'spirit_stone', quantity: 100 })
    });
    const cJson = await cRes.json();
    console.log(`  code: ${cJson.code}, message: ${cJson.message || ''}`);
    console.log(`  data: ${JSON.stringify(cJson.data)?.slice(0, 300)}`);

    // 查询捐献进度
    console.log('\n[6] 查询捐献进度...');
    const cpRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/contribution/progress`, { headers });
    const cpJson = await cpRes.json();
    console.log(`  code: ${cpJson.code}`);
    console.log(`  data: ${JSON.stringify(cpJson.data)?.slice(0, 300)}`);

    // 帮助信息
    console.log('\n[7] 查询帮助信息...');
    const hRes = await fetch(`${BASE_URL}/beast-invasion/help`, { headers });
    const hJson = await hRes.json();
    console.log(`  code: ${hJson.code}, message: ${(hJson.message || '').slice(0, 80)}`);

    // 奖励池
    console.log('\n[8] 查询奖励池...');
    const rRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/rewards`, { headers });
    const rJson = await rRes.json();
    console.log(`  code: ${rJson.code}, message: ${(rJson.message || '').slice(0, 80)}`);

    // 如果在战斗阶段，尝试攻击
    const currentPhase = dJson?.data?.phase || dJson?.data?.invasion?.phase;
    if (currentPhase === 'battle') {
        console.log('\n[9] 攻击妖兽 5 次...');
        for (let i = 1; i <= 5; i++) {
            const atkRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/attack`, {
                method: 'POST', headers,
                body: JSON.stringify({})
            });
            const atkJson = await atkRes.json();
            console.log(`  攻击 ${i}: code=${atkJson.code}, message=${(atkJson.message || '').slice(0, 60)}`);
            if (atkJson?.data?.damage !== undefined) {
                console.log(`    damage: ${atkJson.data.damage}, counter: ${atkJson.data.counter_damage || 0}`);
            }
            await new Promise(r => setTimeout(r, 11000)); // 攻击冷却 10s
        }
    } else {
        console.log(`\n[9] 当前阶段为 ${currentPhase}，跳过攻击测试`);
    }

    // 伤害排行
    console.log('\n[10] 查询伤害排行...');
    const rkRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/ranking`, { headers });
    const rkJson = await rkRes.json();
    console.log(`  code: ${rkJson.code}`);
    console.log(`  data: ${JSON.stringify(rkJson.data)?.slice(0, 300)}`);

    console.log('\n═══════════════════════════════════════════');
    console.log('  妖兽入侵玩法验证完成');
    console.log('═══════════════════════════════════════════');
}

main().catch(err => { console.error('脚本异常:', err); process.exit(1); });
