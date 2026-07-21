/**
 * 世界 Boss 多行动机制快速验证
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

async function fetchJson(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, { ...options, headers });
    return res.json();
}

async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  世界 Boss 多行动机制快速验证');
    console.log('═══════════════════════════════════════════\n');

    const loginJson = await fetchJson(`${BASE_URL}/auth/login`, {
        method: 'POST',
        body: JSON.stringify(TEST_ACCOUNT)
    });
    const token = loginJson?.data?.token || loginJson?.token;
    const headers = { 'Authorization': `Bearer ${token}` };

    // 查询可用 BOSS（返回可能是数组或 { bosses: [...] } 或 { list: [...] }）
    const avJson = await fetchJson(`${BASE_URL}/world-boss/available`, { headers });
    console.log('=== /available 返回结构（前 800 字符）===');
    console.log(JSON.stringify(avJson, null, 2).slice(0, 800));
    console.log('');

    const data = avJson?.data;
    const bosses = Array.isArray(data) ? data :
                   (Array.isArray(data?.bosses) ? data.bosses :
                   (Array.isArray(data?.list) ? data.list : []));
    const boss = bosses.find(b => b.status === 'active' || b.status === 'pending') || bosses[0];
    if (!boss) {
        console.error('无可用 BOSS');
        process.exit(1);
    }
    console.log(`[1] 目标 BOSS: ID=${boss.boss_id || boss.id}, name=${boss.boss_name}, status=${boss.status}\n`);

    // 先尝试撤退（清理可能的死亡状态）
    console.log('[0] 先撤退清理状态...');
    const retreatRes = await fetchJson(`${BASE_URL}/world-boss/${boss.boss_id || boss.id}/retreat`, {
        method: 'POST', headers
    });
    console.log(`  撤退: code=${retreatRes.code}, message=${retreatRes.message}\n`);

    // 依次执行 4 种行动
    const actions = ['assault', 'break_banner', 'suppress_soul', 'protect_array'];
    for (const action of actions) {
        const r = await fetchJson(`${BASE_URL}/world-boss/${boss.boss_id || boss.id}/action`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action_type: action })
        });
        if (r.code !== 200) {
            console.log(`  ❌ ${action}: code=${r.code}, message=${r.message}`);
            continue;
        }
        const d = r.data || {};
        console.log(`[行动] ${action}`);
        console.log(`  伤害: ${d.damage?.final || '?'}, 倍率: ${d.action?.damage_multiplier}, 重复惩罚: ${d.action?.repetition_penalty_applied}`);
        console.log(`  BOSS: HP ${d.boss?.hp_before} → ${d.boss?.hp_after} (${d.boss?.hp_percentage}%)`);
        console.log(`  状态: 幡魂=${d.boss?.banner_soul}, 魔压=${d.boss?.magic_pressure}, 阵势=${d.boss?.array_integrity}`);
        console.log(`  反击: ${d.counter?.triggered ? `触发（伤害${d.counter.damage}，技能${d.counter.skill_used}）` : '未触发'}`);
        console.log('');
        await new Promise(r => setTimeout(r, 6000)); // 攻击 CD 5s
    }

    console.log('═══════════════════════════════════════════');
    console.log('  验证完成');
    console.log('═══════════════════════════════════════════');
}

main().catch(err => { console.error('脚本异常:', err); process.exit(1); });
