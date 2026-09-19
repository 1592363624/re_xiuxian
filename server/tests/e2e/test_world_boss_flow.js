/**
 * 世界 Boss 完整流程验证脚本
 *
 * 测试目的：
 *   验证修复后的世界 Boss 调度器和接口能否正常工作
 *
 * 测试流程：
 *   1. 登录获取 token
 *   2. GM 接口手动刷新青元子 Boss
 *   3. 查询可挑战 Boss 列表，确认 Boss 已生成
 *   4. 查询 Boss 详情（HP/阶段/技能）
 *   5. 玩家攻击 Boss
 *   6. 查询伤害排行榜
 *   7. 查询 Boss 当前 HP 变化
 *
 * 运行方式：node server/scripts/test_world_boss_flow.js
 */
const axios = require('axios');

const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';
const API_BASE = 'http://localhost:5000/api';

async function main() {
    console.log('========== 世界 Boss 完整流程验证 ==========\n');

    // Step 1: 登录
    console.log('[Step 1] 登录...');
    const loginResp = await axios.post(`${API_BASE}/auth/login`, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    if (loginResp.data.code !== 200) throw new Error(`登录失败: ${loginResp.data.message}`);
    const token = loginResp.data.token;
    const authHeader = { Authorization: `Bearer ${token}` };
    console.log('  ✓ 登录成功\n');

    // Step 2: GM 手动刷新青元子 Boss
    console.log('[Step 2] GM 手动刷新青元子 Boss...');
    let spawnedBossId = null;
    try {
        const spawnResp = await axios.post(`${API_BASE}/admin/world-boss/spawn`, {
            boss_key: 'qingyuanzi'
        }, { headers: authHeader });
        console.log(`  ✓ 状态码: ${spawnResp.status}`);
        console.log(`  ✓ code: ${spawnResp.data.code}`);
        if (spawnResp.data.code === 200) {
            const boss = spawnResp.data.data;
            // 兼容多种字段名
            spawnedBossId = boss.id || boss.boss_id;
            console.log(`  ✓ Boss ID: ${spawnedBossId}`);
            console.log(`  ✓ Boss 名称: ${boss.boss_name || boss.name}`);
            console.log(`  ✓ Boss HP: ${boss.hp_current || boss.current_hp}/${boss.hp_max || boss.max_hp}`);
            console.log(`  ✓ Boss 状态: ${boss.status}`);
            console.log(`  ✓ Boss 阶段: ${boss.phase}`);
        } else {
            console.log(`  ⚠ message: ${spawnResp.data.message}`);
            // 可能已存在活跃 Boss，继续后续测试
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) {
            console.log(`    响应:`, err.response.data);
        }
        console.log('');
    }

    // Step 3: 查询可挑战 Boss 列表
    console.log('[Step 3] 查询 GET /api/world-boss/available...');
    let bossId = null;
    try {
        const availResp = await axios.get(`${API_BASE}/world-boss/available`, { headers: authHeader });
        console.log(`  ✓ 状态码: ${availResp.status}`);
        const data = availResp.data.data;
        const bosses = data?.bosses || [];
        console.log(`  ✓ 可挑战 Boss 数量: ${bosses.length}`);
        for (const boss of bosses) {
            // 实际字段名：id / boss_name / hp_current / hp_max / phase / status
            console.log(`    - id=${boss.id} boss_key=${boss.boss_key} 名称=${boss.boss_name} HP=${boss.hp_current}/${boss.hp_max} 阶段=${boss.phase} 状态=${boss.status}`);
        }
        if (bosses.length > 0) {
            bossId = bosses[0].id;
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log(`    响应:`, err.response.data);
        console.log('');
        return;
    }

    if (!bossId) {
        console.log('[Step 4-7] 跳过（无可用 Boss）\n');
        return;
    }

    // Step 4: 查询 Boss 详情
    console.log(`[Step 4] 查询 GET /api/world-boss/${bossId}（Boss详情）...`);
    try {
        const bossResp = await axios.get(`${API_BASE}/world-boss/${bossId}`, { headers: authHeader });
        console.log(`  ✓ 状态码: ${bossResp.status}`);
        const data = bossResp.data.data;
        if (data) {
            console.log(`  ✓ Boss 名称: ${data.name || data.boss_name}`);
            console.log(`  ✓ Boss HP: ${data.current_hp}/${data.max_hp}`);
            console.log(`  ✓ Boss 阶段: ${data.phase}`);
            console.log(`  ✓ Boss 状态: ${data.status}`);
            console.log(`  ✓ Boss 元素: ${data.element}`);
            console.log(`  ✓ Boss 攻击: ${data.atk || data.base_atk}`);
            console.log(`  ✓ Boss 防御: ${data.def || data.base_def}`);
            if (data.skills) {
                console.log(`  ✓ Boss 技能数: ${data.skills.length}`);
            }
            if (data.ranking) {
                console.log(`  ✓ 当前排行人数: ${data.ranking.length}`);
            }
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log(`    响应:`, err.response.data);
        console.log('');
    }

    // Step 5: 攻击 Boss
    console.log(`[Step 5] 攻击 Boss（POST /api/world-boss/${bossId}/attack）...`);
    try {
        const attackResp = await axios.post(`${API_BASE}/world-boss/${bossId}/attack`, {}, { headers: authHeader });
        console.log(`  ✓ 状态码: ${attackResp.status}`);
        console.log(`  ✓ code: ${attackResp.data.code}`);
        if (attackResp.data.code === 200) {
            const data = attackResp.data.data;
            console.log(`  ✓ 造成伤害: ${data.damage_dealt || data.damage}`);
            console.log(`  ✓ 玩家剩余 HP: ${data.player_hp_after ?? '未返回'}`);
            console.log(`  ✓ Boss 剩余 HP: ${data.boss_hp_after ?? data.boss_current_hp ?? '未返回'}`);
            if (data.rewards) {
                console.log(`  ✓ 获得奖励:`, JSON.stringify(data.rewards));
            }
            if (data.phase_changed) {
                console.log(`  ✓ Boss 阶段切换: ${data.new_phase}`);
            }
        } else {
            console.log(`  ⚠ message: ${attackResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) {
            console.log(`    响应:`, err.response.data);
        }
        console.log('');
    }

    // Step 6: 查询伤害排行
    console.log(`[Step 6] 查询 GET /api/world-boss/${bossId}/ranking...`);
    try {
        const rankResp = await axios.get(`${API_BASE}/world-boss/${bossId}/ranking`, { headers: authHeader });
        console.log(`  ✓ 状态码: ${rankResp.status}`);
        const data = rankResp.data.data;
        if (Array.isArray(data)) {
            console.log(`  ✓ 排行榜人数: ${data.length}`);
            for (const r of data.slice(0, 3)) {
                console.log(`    - 玩家=${r.player_name || r.username} 伤害=${r.total_damage || r.damage}`);
            }
        } else if (data) {
            console.log('  📋 排行榜数据:');
            console.log(JSON.stringify(data, null, 2).split('\n').map(l => '    ' + l).join('\n'));
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log(`    响应:`, err.response.data);
        console.log('');
    }

    // Step 7: 查询 Boss 当前 HP
    console.log(`[Step 7] 查询 Boss 当前 HP 变化...`);
    try {
        const bossResp = await axios.get(`${API_BASE}/world-boss/${bossId}`, { headers: authHeader });
        const data = bossResp.data.data;
        if (data) {
            console.log(`  ✓ Boss 当前 HP: ${data.current_hp}/${data.max_hp}`);
            const damagePercent = ((1 - data.current_hp / data.max_hp) * 100).toFixed(2);
            console.log(`  ✓ HP 损失百分比: ${damagePercent}%`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}\n`);
    }

    console.log('========== 测试完成 ==========');
}

main().catch(err => {
    console.error('测试执行失败:', err.message);
    process.exitCode = 1;
});
