/**
 * 妖兽入侵战斗阶段测试 - 通过大量捐献触发战斗阶段，再测试攻击
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  妖兽入侵战斗阶段测试');
    console.log('═══════════════════════════════════════════\n');

    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(TEST_ACCOUNT)
    });
    const loginJson = await loginRes.json();
    const token = loginJson?.data?.token || loginJson?.token;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 查询活跃妖兽
    const aRes = await fetch(`${BASE_URL}/beast-invasion/active`, { headers });
    const aJson = await aRes.json();
    const invasionId = aJson?.data?.id;
    if (!invasionId) { console.error('无活跃妖兽入侵'); process.exit(1); }
    console.log(`[1] 当前妖兽入侵 ID=${invasionId}（${aJson.data.beast_name}，phase=${aJson.data.phase}）`);

    // 如果还在捐献阶段，捐献大量灵石触发战斗阶段
    if (aJson.data.phase === 'donation') {
        const target = aJson.data.donation_target;
        const current = Number(aJson.data.donation_current || 0);
        const need = target - current;
        console.log(`\n[2] 捐献进度 ${current}/${target}，需捐献 ${need} 灵石触发战斗阶段`);
        // 每次捐献 10000 灵石，循环到达标
        let donated = 0;
        while (donated < need) {
            const cRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/contribute`, {
                method: 'POST', headers,
                body: JSON.stringify({ item_key: 'spirit_stone', quantity: 10000 })
            });
            const cJson = await cRes.json();
            if (cJson.code !== 200) {
                console.log(`  捐献失败: ${cJson.message}`);
                break;
            }
            donated += 10000;
            if (cJson?.data?.phase_switched) {
                console.log(`  ✅ 锁灵大阵完成！已切换到战斗阶段`);
                break;
            }
        }
    }

    // 再次查询详情（注意：getInvasionDetail 返回 { data: { invasion: {...}, description, skills } }）
    const dRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}`, { headers });
    const dJson = await dRes.json();
    const invasionDetail = dJson?.data?.invasion || dJson?.data || {};
    console.log(`\n[3] 当前阶段: ${invasionDetail.phase}, hp: ${invasionDetail.hp_current}/${invasionDetail.hp_max}`);

    if (invasionDetail.phase !== 'battle') {
        console.log('  未进入战斗阶段，结束测试');
        process.exit(0);
    }

    // 攻击妖兽 3 次（注意：攻击接口冷却 10s，需间隔 11s）
    console.log('\n[4] 攻击妖兽 3 次...');
    for (let i = 1; i <= 3; i++) {
        const atkRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/attack`, {
            method: 'POST', headers,
            body: JSON.stringify({})
        });
        const atkJson = await atkRes.json();
        console.log(`  攻击 ${i}: code=${atkJson.code}, message=${(atkJson.message || '').slice(0, 60)}`);
        if (atkJson?.data?.attack) {
            const a = atkJson.data.attack;
            const b = atkJson.data.beast || {};
            const c = atkJson.data.counter || {};
            const p = atkJson.data.player || {};
            console.log(`    伤害=${a.damage} 暴击=${a.is_crit} 技能=${a.skill_used}`);
            console.log(`    妖兽HP=${b.hp_after}/${b.hp_max} (${b.hp_percentage}%)`);
            console.log(`    反击伤害=${c.damage} 触发=${c.triggered}`);
            console.log(`    玩家战斗HP=${p.battle_hp_after}/${p.battle_hp_max} 死亡次数=${p.death_count}`);
        }
        if (i < 3) await new Promise(r => setTimeout(r, 11000)); // 攻击冷却 10s
    }

    // 查询伤害排行
    console.log('\n[5] 查询伤害排行...');
    const rkRes = await fetch(`${BASE_URL}/beast-invasion/${invasionId}/ranking`, { headers });
    const rkJson = await rkRes.json();
    console.log(`  code: ${rkJson.code}`);
    if (rkJson?.data?.ranking?.length > 0) {
        console.log(`  排行第 1: ${rkJson.data.ranking[0].player_nickname}, damage=${rkJson.data.ranking[0].total_damage}`);
    }

    // 验证状态机互斥（妖兽战斗中尝试开始历练应被拦截）
    console.log('\n[6] 验证状态机互斥（尝试开始历练应被拦截）...');
    const startRes = await fetch(`${BASE_URL}/map/explore/start`, {
        method: 'POST', headers,
        body: JSON.stringify({ durationType: 'short' })
    });
    const startJson = await startRes.json();
    console.log(`  code: ${startJson.code}, message: ${startJson.message?.slice(0, 80)}`);
    if (startJson.code === 400) {
        console.log('  ✅ 状态机互斥校验生效（被正确拦截）');
    } else {
        console.log('  ⚠️ 警告：历练未被拦截，可能状态机配置有问题');
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('  妖兽入侵战斗阶段测试完成');
    console.log('═══════════════════════════════════════════');
}

main().catch(err => { console.error('脚本异常:', err); process.exit(1); });
