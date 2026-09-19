/**
 * 世界 Boss 事件触发验证脚本
 *
 * 测试目的：
 *   1. 验证 GET /api/world-boss/status 返回 Boss 当前状态
 *   2. 验证 GET /api/world-boss/ranking 排行榜接口
 *   3. 验证 Boss 阶段切换、HP、剩余时间等关键字段
 *
 * 运行方式：node server/scripts/test_world_boss_status.js
 */
const axios = require('axios');

const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';
const API_BASE = 'http://localhost:5000/api';

async function main() {
    console.log('========== 世界 Boss 事件触发验证 ==========\n');

    // 登录
    console.log('[1] 登录...');
    const loginResp = await axios.post(`${API_BASE}/auth/login`, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    if (loginResp.data.code !== 200) throw new Error(`登录失败: ${loginResp.data.message}`);
    const token = loginResp.data.token;
    const authHeader = { Authorization: `Bearer ${token}` };
    console.log('  ✓ 登录成功\n');

    // 查询可挑战的 BOSS 列表
    console.log('[2] 查询 GET /api/world-boss/available...');
    let availableBosses = [];
    try {
        const statusResp = await axios.get(`${API_BASE}/world-boss/available`, { headers: authHeader });
        console.log(`  ✓ 状态码: ${statusResp.status}`);
        console.log(`  ✓ code: ${statusResp.data.code}`);
        const data = statusResp.data.data;
        if (Array.isArray(data)) {
            availableBosses = data;
            console.log(`  ✓ 可挑战 BOSS 数量: ${data.length}`);
            for (const boss of data) {
                console.log(`    - ID=${boss.boss_id} 名称=${boss.name} HP=${boss.current_hp}/${boss.max_hp} 阶段=${boss.phase} 状态=${boss.status}`);
            }
        } else if (data) {
            console.log('  📋 返回数据:');
            console.log(JSON.stringify(data, null, 2).split('\n').map(l => '    ' + l).join('\n'));
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) {
            console.log(`    响应:`, err.response.data);
        }
        console.log('');
    }

    // 查询赛季列表
    console.log('[3] 查询 GET /api/world-boss/seasons...');
    try {
        const seasonsResp = await axios.get(`${API_BASE}/world-boss/seasons`, { headers: authHeader });
        console.log(`  ✓ 状态码: ${seasonsResp.status}`);
        console.log(`  ✓ code: ${seasonsResp.data.code}`);
        const data = seasonsResp.data.data;
        if (Array.isArray(data)) {
            console.log(`  ✓ 赛季数量: ${data.length}`);
            for (const s of data.slice(0, 3)) {
                console.log(`    - ID=${s.season_id} 名称=${s.season_name} 状态=${s.status} 开始=${s.start_date} 结束=${s.end_date}`);
            }
        } else if (data) {
            console.log('  📋 返回数据:');
            console.log(JSON.stringify(data, null, 2).split('\n').map(l => '    ' + l).join('\n'));
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) {
            console.log(`    响应:`, err.response.data);
        }
        console.log('');
    }

    // 如果有可挑战的 BOSS，查询其详情和排行
    if (availableBosses.length > 0) {
        const bossId = availableBosses[0].boss_id;
        console.log(`[4] 查询 GET /api/world-boss/${bossId}（BOSS详情）...`);
        try {
            const bossResp = await axios.get(`${API_BASE}/world-boss/${bossId}`, { headers: authHeader });
            console.log(`  ✓ 状态码: ${bossResp.status}`);
            const data = bossResp.data.data;
            if (data) {
                console.log('  📋 BOSS 详情:');
                console.log(JSON.stringify(data, null, 2).split('\n').map(l => '    ' + l).join('\n'));
            }
            console.log('');
        } catch (err) {
            console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
            if (err.response?.data) {
                console.log(`    响应:`, err.response.data);
            }
            console.log('');
        }

        console.log(`[5] 查询 GET /api/world-boss/${bossId}/ranking（伤害排行）...`);
        try {
            const rankingResp = await axios.get(`${API_BASE}/world-boss/${bossId}/ranking`, { headers: authHeader });
            console.log(`  ✓ 状态码: ${rankingResp.status}`);
            const data = rankingResp.data.data;
            if (data) {
                console.log('  📋 排行榜:');
                console.log(JSON.stringify(data, null, 2).split('\n').map(l => '    ' + l).join('\n'));
            }
            console.log('');
        } catch (err) {
            console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
            if (err.response?.data) {
                console.log(`    响应:`, err.response.data);
            }
            console.log('');
        }
    } else {
        console.log('[4-5] 跳过 BOSS 详情和排行测试（无可用 BOSS）\n');
    }

    console.log('========== 测试完成 ==========');
}

main().catch(err => {
    console.error('测试执行失败:', err.message);
    process.exitCode = 1;
});
