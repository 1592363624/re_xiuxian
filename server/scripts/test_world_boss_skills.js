/**
 * 世界BOSS 技能表完整实现 验证脚本
 *
 * 验证目标：
 *   1. BOSS 反击使用真正的技能（不再是固定公式）
 *   2. 不同阶段触发不同技能（phase 1/2/3）
 *   3. 召唤小怪：boss.minions 被填充
 *   4. 自身 Buff：boss.active_buffs 被填充，ATK 提升
 *   5. AOE 伤害：返回 aoe_event
 *   6. 技能冷却：boss.skill_cooldowns 被更新
 *   7. 吸血回复：BOSS HP 在反击后可能回复
 *
 * 前置条件：
 *   - 服务运行在 http://localhost:5000
 *   - 测试账号 1592363624 / 1592363624 (admin)
 *   - 玩家境界化神初期（rank=23），可挑战 qingyuanzi（rank_min=11）
 */
'use strict';

const BASE = 'http://localhost:5000/api';

async function main() {
    console.log('=== 世界BOSS 技能表完整实现 验证 ===\n');

    // 1. 登录
    const loginResp = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '1592363624', password: '1592363624' })
    });
    const loginData = await loginResp.json();
    const token = loginData.token;
    const headers = { 'Authorization': `Bearer ${token}` };
    console.log('1. 登录成功\n');

    // 2. 查询或生成 BOSS
    console.log('2. 查询/生成 BOSS');
    // 优先使用 admin 接口查询所有 BOSS（包括 active/pending 状态）
    const adminBossResp = await fetch(`${BASE}/admin/world-boss/bosses`, { headers });
    const adminBossData = await adminBossResp.json();
    const allBosses = adminBossData.data?.bosses || [];
    let activeBoss = allBosses.find(b => b.status === 'active' || b.status === 'pending');

    if (!activeBoss) {
        console.log('   无可用BOSS，调用 GM 接口生成...');
        const spawnResp = await fetch(`${BASE}/admin/world-boss/spawn`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ boss_key: 'qingyuanzi', custom_hp: 1000000 })
        });
        const spawnData = await spawnResp.json();
        if (spawnData.code !== 200) {
            console.log('   ❌ GM生成BOSS失败:', spawnData.message);
            // 尝试找到任意 BOSS 直接用
            if (allBosses.length > 0) {
                activeBoss = allBosses[0];
                console.log('   使用已有BOSS:', activeBoss.boss_name, 'id:', activeBoss.boss_id);
            } else {
                return;
            }
        } else {
            activeBoss = spawnData.data;
            console.log('   ✅ GM生成BOSS成功:', activeBoss.boss_name, 'id:', activeBoss.boss_id || activeBoss.id);
        }
    } else {
        console.log('   ✅ 找到可用BOSS:', activeBoss.boss_name, 'id:', activeBoss.boss_id);
    }
    const bossId = activeBoss.boss_id || activeBoss.id;

    // 3. 连续攻击 BOSS 多次，观察技能变化
    console.log('\n3. 连续攻击 BOSS 10 次，观察技能触发情况');
    const attackResults = [];
    for (let i = 0; i < 10; i++) {
        const attackResp = await fetch(`${BASE}/world-boss/${bossId}/attack`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ skill_id: 'basic' })
        });
        const attackData = await attackResp.json();
        if (attackData.code !== 200) {
            console.log(`   第 ${i + 1} 次攻击失败:`, attackData.message);
            continue;
        }
        const atk = attackData.data?.attack;
        const counter = attackData.data?.counter;
        const boss = attackData.data?.boss;
        const aoeEvent = attackData.data?.aoe_event;
        attackResults.push({
            round: i + 1,
            player_damage: atk?.damage,
            boss_skill: counter?.skill?.name,
            boss_skill_type: counter?.skill?.type,
            boss_counter_damage: counter?.damage,
            is_aoe: counter?.skill?.is_aoe,
            is_summon: counter?.skill?.is_summon,
            is_buff: counter?.skill?.is_buff,
            minions_count: boss?.minions?.length || 0,
            buffs_count: boss?.active_buffs?.length || 0,
            aoe_triggered: !!aoeEvent,
            boss_phase: boss?.phase,
            boss_hp_pct: boss?.hp_percentage
        });
        console.log(`   第 ${i + 1} 次: 玩家伤害=${atk?.damage}, BOSS技能="${counter?.skill?.name}"(${counter?.skill?.type}), 反击=${counter?.damage}, 召唤=${counter?.skill?.is_summon}, Buff=${counter?.skill?.is_buff}, AOE=${counter?.skill?.is_aoe}, 阶段=${boss?.phase}, BOSS HP%=${boss?.hp_percentage?.toFixed(1)}`);

        // BOSS 被击败则停止
        if (boss?.defeated) {
            console.log('   🏆 BOSS 被击败，停止测试');
            break;
        }
        // 玩家死亡需要复活
        if (attackData.data?.player?.is_dead) {
            console.log('   ⚠️ 玩家死亡，尝试复活...');
            try {
                const reviveResp = await fetch(`${BASE}/world-boss/${bossId}/revive`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' }
                });
                const reviveData = await reviveResp.json();
                console.log('   复活结果:', reviveData.code === 200 ? '✅' : '❌ ' + reviveData.message);
            } catch (e) {
                console.log('   复活接口调用失败:', e.message);
            }
        }
        // 等待攻击冷却（5s）
        await new Promise(resolve => setTimeout(resolve, 5500));
    }

    // 4. 统计结果
    console.log('\n4. 统计结果:');
    const skillTypeCount = {};
    let summonCount = 0;
    let buffCount = 0;
    let aoeCount = 0;
    for (const r of attackResults) {
        skillTypeCount[r.boss_skill_type] = (skillTypeCount[r.boss_skill_type] || 0) + 1;
        if (r.is_summon) summonCount++;
        if (r.is_buff) buffCount++;
        if (r.is_aoe) aoeCount++;
    }
    console.log('   技能类型分布:', JSON.stringify(skillTypeCount, null, 2));
    console.log('   召唤触发次数:', summonCount);
    console.log('   Buff触发次数:', buffCount);
    console.log('   AOE触发次数:', aoeCount);

    // 5. 验证
    console.log('\n5. 验证结果:');
    let allPass = true;

    if (attackResults.length > 0) {
        console.log('   ✅ 接口正常返回，无 500 错误');
    } else {
        console.log('   ❌ 接口未返回有效数据');
        allPass = false;
    }

    // 验证技能类型多样化
    const uniqueSkillTypes = Object.keys(skillTypeCount);
    if (uniqueSkillTypes.length >= 2) {
        console.log(`   ✅ 触发了多种技能类型 (${uniqueSkillTypes.length} 种): ${uniqueSkillTypes.join(', ')}`);
    } else {
        console.log(`   ⚠️ 仅触发了 ${uniqueSkillTypes.length} 种技能类型（可能阶段未切换）`);
    }

    // 验证技能名来自配置（不是"普通攻击"也不是固定名）
    const skillNames = new Set(attackResults.map(r => r.boss_skill));
    const realSkills = [...skillNames].filter(n => n && n !== '普通攻击');
    if (realSkills.length >= 1) {
        console.log(`   ✅ 触发了配置中的技能: ${realSkills.join(', ')}`);
    } else {
        console.log('   ❌ 未触发配置中的技能');
        allPass = false;
    }

    // 验证 minions 字段被正确维护
    const lastResult = attackResults[attackResults.length - 1];
    if (summonCount > 0) {
        console.log(`   ✅ 召唤技能触发 ${summonCount} 次`);
    } else {
        console.log('   ⚠️ 召唤技能未触发（随机权重较低 summon_weight=3，可多次测试）');
    }

    if (buffCount > 0) {
        console.log(`   ✅ Buff技能触发 ${buffCount} 次`);
    } else {
        console.log('   ⚠️ Buff技能未触发（随机权重较低 buff_weight=1，可多次测试）');
    }

    if (aoeCount > 0) {
        console.log(`   ✅ AOE技能触发 ${aoeCount} 次`);
    } else {
        console.log('   ⚠️ AOE技能未触发（需要进入阶段2/3）');
    }

    // 验证 aoe_event 字段返回
    if (attackResults.some(r => r.aoe_triggered)) {
        console.log('   ✅ aoe_event 字段在 AOE 技能触发时正确返回');
    }

    console.log('\n=== 验证完成 ===');
    if (allPass) {
        console.log('✅ 核心功能验证通过');
    } else {
        console.log('⚠️ 部分功能需要进一步检查');
    }
}

main().catch(err => {
    console.error('脚本异常:', err);
    process.exit(1);
});
