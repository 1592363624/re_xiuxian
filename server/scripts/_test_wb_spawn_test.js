/**
 * 世界 Boss 多行动机制验证（spawn 新 BOSS 避免 cooldown 卡死）
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
    console.log('  世界 Boss 多行动机制验证（新 BOSS）');
    console.log('═══════════════════════════════════════════\n');

    const loginJson = await fetchJson(`${BASE_URL}/auth/login`, {
        method: 'POST',
        body: JSON.stringify(TEST_ACCOUNT)
    });
    const token = loginJson?.data?.token || loginJson?.token;
    const headers = { 'Authorization': `Bearer ${token}` };

    // 查询当前 BOSS 列表，先 expire 旧的
    const avJson = await fetchJson(`${BASE_URL}/world-boss/available`, { headers });
    const bosses = avJson?.data?.bosses || [];
    console.log(`[1] 当前 BOSS 数量: ${bosses.length}`);
    for (const b of bosses) {
        console.log(`  - ID=${b.id}, ${b.boss_name}, status=${b.status}, hp=${b.hp_percentage}%`);
        // 让旧 BOSS 过期
        if (b.status === 'active' || b.status === 'pending') {
            const r = await fetchJson(`${BASE_URL}/admin/world-boss/${b.id}/expire`, {
                method: 'POST', headers
            });
            console.log(`    过期: code=${r.code}, message=${r.message}`);
        }
    }

    // spawn 新 BOSS
    console.log('\n[2] spawn 新 BOSS...');
    const spawnRes = await fetchJson(`${BASE_URL}/admin/world-boss/spawn`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ boss_key: 'qingyuanzi' })
    });
    console.log(`  spawn: code=${spawnRes.code}, message=${spawnRes.message}`);
    if (spawnRes.code !== 200) {
        console.log('  spawn 失败，详细:', JSON.stringify(spawnRes, null, 2).slice(0, 500));
        process.exit(1);
    }
    const newBoss = spawnRes.data?.boss || spawnRes.data;
    const bossId = newBoss?.id || newBoss?.boss_id;
    console.log(`  新 BOSS ID=${bossId}, name=${newBoss?.boss_name}, hp_max=${newBoss?.hp_max}\n`);

    // 依次执行 4 种行动
    console.log('[3] 依次执行 4 种行动...');
    const actions = ['assault', 'break_banner', 'suppress_soul', 'protect_array'];
    for (const action of actions) {
        const r = await fetchJson(`${BASE_URL}/world-boss/${bossId}/action`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action_type: action })
        });
        if (r.code !== 200) {
            console.log(`  ❌ ${action}: code=${r.code}, message=${r.message}`);
            await new Promise(r => setTimeout(r, 6000));
            continue;
        }
        const d = r.data || {};
        // 字段名兼容：可能是 d.damage.final / d.damage / d.attack.damage
        const dmgVal = d?.damage?.final ?? d?.attack?.damage ?? d?.damage ?? '?';
        console.log(`[行动] ${action}`);
        console.log(`  伤害: ${dmgVal}, 倍率: ${d.action?.damage_multiplier}, 重复惩罚: ${d.action?.repetition_penalty_applied}`);
        console.log(`  BOSS: HP ${d.boss?.hp_before} → ${d.boss?.hp_after} (${d.boss?.hp_percentage}%)`);
        console.log(`  状态: 幡魂=${d.boss?.banner_soul}, 魔压=${d.boss?.magic_pressure}, 阵势=${d.boss?.array_integrity}`);
        console.log(`  反击: ${d.counter?.triggered ? `触发（伤害${d.counter.damage}）` : '未触发'}`);
        if (action === 'assault') {
            console.log('  完整返回结构（前 1500 字符）:');
            console.log(JSON.stringify(r, null, 2).slice(0, 1500));
        }
        console.log('');
        await new Promise(r => setTimeout(r, 6000));
    }

    console.log('═══════════════════════════════════════════');
    console.log('  验证完成');
    console.log('═══════════════════════════════════════════');
}

main().catch(err => { console.error('脚本异常:', err); process.exit(1); });
