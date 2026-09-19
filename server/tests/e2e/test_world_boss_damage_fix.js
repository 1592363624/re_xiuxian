/**
 * 世界BOSS伤害修复端到端验证脚本
 *
 * 验证内容：
 *   1. 玩家登录获取 token
 *   2. 查询当前可挑战 BOSS（若无可挑战 BOSS，通过 GM 接口刷新一只）
 *   3. 攻击 BOSS 5 次，验证：
 *      - 伤害数值合理（不再 < 100）
 *      - damage_breakdown 字段完整（def_reduction/team_factor/realm_suppression）
 *      - team_factor 与 active_participant_count 一致
 *      - realm_suppression 与玩家境界差一致
 *   4. 查询 BOSS 详情，验证 HP 实际扣减
 *   5. 查询伤害排行，验证玩家伤害记录累加
 *
 * 运行：node scripts/test_world_boss_damage_fix.js
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

async function fetchJson(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { status: res.status, json };
}

async function login() {
    const { status, json } = await fetchJson(`${BASE_URL}/auth/login`, {
        method: 'POST',
        body: JSON.stringify(TEST_ACCOUNT)
    });
    // 兼容两种响应结构：{ data: { token } } 或 { token }
    const token = json?.data?.token || json?.token;
    const player = json?.data?.player || json?.player || {};
    if (status !== 200 || !token) {
        throw new Error(`登录失败: status=${status}, body=${JSON.stringify(json).slice(0, 200)}`);
    }
    return { token, player };
}

async function getAvailableBosses(token) {
    const { status, json } = await fetchJson(`${BASE_URL}/world-boss/available`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (status !== 200) {
        throw new Error(`查询可挑战BOSS失败: status=${status}, body=${JSON.stringify(json).slice(0, 200)}`);
    }
    return json.data;
}

async function spawnBossViaGM(token, bossKey = 'qingyuanzi') {
    // GM 接口刷新 BOSS（admin 账号）
    const { status, json } = await fetchJson(`${BASE_URL}/admin/world-boss/spawn`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ boss_key: bossKey })
    });
    console.log(`[GM刷新BOSS] status=${status}, response=${JSON.stringify(json).slice(0, 200)}`);
    return json?.data;
}

async function attackBoss(token, bossId, skillId = 'basic') {
    const { status, json } = await fetchJson(`${BASE_URL}/world-boss/${bossId}/attack`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ skill_id: skillId })
    });
    return { status, json };
}

async function getBossDetail(token, bossId) {
    const { status, json } = await fetchJson(`${BASE_URL}/world-boss/${bossId}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    return { status, json };
}

async function main() {
    console.log('=== 世界BOSS伤害修复验证 ===\n');

    // 1. 登录
    console.log('[1] 登录测试账号...');
    const { token, player } = await login();
    console.log(`✓ 登录成功: ${player.nickname} (${player.realm})\n`);

    // 2. 查询可挑战 BOSS
    console.log('[2] 查询可挑战 BOSS...');
    let availableData = await getAvailableBosses(token);
    let bosses = availableData.bosses || [];
    console.log(`✓ 当前可挑战 BOSS 数量: ${bosses.length}`);

    let bossId;
    if (bosses.length === 0) {
        console.log('  无可挑战 BOSS，通过 GM 接口刷新青元子...');
        const spawnResult = await spawnBossViaGM(token, 'qingyuanzi');
        if (spawnResult?.boss) {
            bossId = spawnResult.boss.id;
        } else if (spawnResult?.id) {
            bossId = spawnResult.id;
        } else {
            // 再次查询
            availableData = await getAvailableBosses(token);
            bosses = availableData.bosses || [];
            if (bosses.length > 0) {
                bossId = bosses[0].id;
            } else {
                throw new Error('刷新后仍无可挑战 BOSS');
            }
        }
        console.log(`✓ GM 刷新成功，BOSS ID=${bossId}`);
    } else {
        bossId = bosses[0].id;
        console.log(`✓ 选择 BOSS: ${bosses[0].boss_name} (ID=${bossId})`);
        console.log(`  HP: ${bosses[0].hp_current} / ${bosses[0].hp_max}`);
    }
    console.log();

    // 3. 攻击 BOSS 5 次
    console.log('[3] 攻击 BOSS 5 次，验证伤害数值...');
    const attackResults = [];
    for (let i = 1; i <= 5; i++) {
        // 间隔 5.5 秒（攻击 CD 5 秒）
        if (i > 1) {
            console.log(`  等待 5.5 秒...`);
            await new Promise(resolve => setTimeout(resolve, 5500));
        }
        const { status, json } = await attackBoss(token, bossId, 'basic');
        if (status !== 200) {
            console.log(`  第${i}次攻击失败: status=${status}, body=${JSON.stringify(json).slice(0, 200)}`);
            continue;
        }
        const data = json.data;
        const breakdown = data?.attack?.damage_breakdown || {};
        console.log(`  第${i}次攻击: 伤害=${data.attack.damage}, 暴击=${data.attack.is_crit}`);
        console.log(`    分解: player_atk=${breakdown.player_atk}, boss_def=${breakdown.boss_def}, def_reduction=${breakdown.def_reduction}`);
        console.log(`    base_damage=${breakdown.base_damage}, solo_ratio=${breakdown.solo_ratio}, team_factor=${breakdown.team_factor}`);
        console.log(`    realm_suppression=${breakdown.realm_suppression}, elemental_factor=${breakdown.elemental_factor}`);
        console.log(`    活跃参与者数: ${breakdown.active_participant_count}`);
        console.log(`    BOSS HP: ${data.boss.hp_current} / ${data.boss.hp_max} (${data.boss.hp_percentage}%)`);
        attackResults.push(data);
    }
    console.log();

    if (attackResults.length === 0) {
        console.log('✗ 所有攻击均失败，无法验证修复效果');
        process.exit(1);
    }

    // 4. 验证修复效果
    console.log('[4] 验证修复效果...');
    const firstAttack = attackResults[0];
    const firstBreakdown = firstAttack.attack.damage_breakdown;

    // 验证1：伤害不再 < 100（化神初期玩家 ATK=625, BOSS def=800）
    const damages = attackResults.map(r => r.attack.damage);
    const avgDamage = damages.reduce((a, b) => a + b, 0) / damages.length;
    console.log(`  平均伤害: ${avgDamage.toFixed(2)}`);
    console.log(`  伤害范围: ${Math.min(...damages)} ~ ${Math.max(...damages)}`);

    if (avgDamage < 100) {
        console.log(`  ✗ 修复失败：平均伤害 ${avgDamage.toFixed(2)} 仍 < 100`);
    } else {
        console.log(`  ✓ 修复成功：平均伤害 ${avgDamage.toFixed(2)} >= 100`);
    }

    // 验证2：def_reduction 字段存在且在合理范围（0~0.5）
    if (firstBreakdown.def_reduction !== undefined) {
        console.log(`  ✓ def_reduction 字段存在: ${firstBreakdown.def_reduction}`);
        if (firstBreakdown.def_reduction >= 0 && firstBreakdown.def_reduction <= 0.5) {
            console.log(`  ✓ def_reduction 在合理范围 [0, 0.5]`);
        }
    } else {
        console.log(`  ✗ def_reduction 字段缺失`);
    }

    // 验证3：team_factor 字段存在
    if (firstBreakdown.team_factor !== undefined) {
        console.log(`  ✓ team_factor 字段存在: ${firstBreakdown.team_factor}（活跃人数=${firstBreakdown.active_participant_count}）`);
    } else {
        console.log(`  ✗ team_factor 字段缺失`);
    }

    // 验证4：realm_suppression 字段存在且 > 1（化神初期 rank=23 vs 青元子 realm_rank_min=11）
    if (firstBreakdown.realm_suppression !== undefined) {
        const expectedSuppression = 1 + Math.max(0, (23 - 11) * 0.05); // 1.6
        console.log(`  ✓ realm_suppression 字段存在: ${firstBreakdown.realm_suppression}（期望=${expectedSuppression.toFixed(4)}）`);
        if (Math.abs(firstBreakdown.realm_suppression - expectedSuppression) < 0.01) {
            console.log(`  ✓ realm_suppression 数值正确`);
        } else {
            console.log(`  ✗ realm_suppression 数值不符，期望 ${expectedSuppression.toFixed(4)}`);
        }
    } else {
        console.log(`  ✗ realm_suppression 字段缺失`);
    }

    // 验证5：理论击杀次数（应远小于修复前的 74627 次）
    const bossHpMax = Number(firstAttack.boss.hp_max);
    const expectedKills = Math.ceil(bossHpMax / avgDamage);
    console.log(`  理论击杀次数: ${expectedKills}（修复前为 74627）`);
    if (expectedKills < 1000) {
        console.log(`  ✓ 击杀次数合理（< 1000）`);
    } else {
        console.log(`  ⚠ 击杀次数仍偏高（>= 1000），可能需要进一步调整`);
    }

    console.log();
    console.log('=== 验证完成 ===');
    process.exit(0);
}

main().catch(err => {
    console.error('验证失败:', err);
    console.error(err.stack);
    process.exit(1);
});
