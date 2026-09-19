/**
 * 测试 /api/seclusion/status 接口返回的 can_deep 字段
 * 验证后端是否正确判定化神期玩家可使用深度闭关
 */
'use strict';

const axios = require('axios');

const API_BASE = 'http://localhost:5000';

async function main() {
    console.log('========================================');
    console.log('闭关状态接口测试');
    console.log('========================================\n');

    // 1. 登录
    const loginResp = await axios.post(`${API_BASE}/api/auth/login`, {
        username: '1592363624',
        password: '1592363624'
    });
    const token = loginResp.data.token;
    console.log(`登录: realm=${loginResp.data.player.realm}\n`);
    const authHeaders = { Authorization: `Bearer ${token}` };

    // 2. 查询闭关状态
    console.log('[GET /api/seclusion/status]');
    const statusResp = await axios.get(`${API_BASE}/api/seclusion/status`, { headers: authHeaders });
    const status = statusResp.data.data || statusResp.data;

    console.log(`  is_secluded: ${status.is_secluded}`);
    console.log(`  seclusion_mode: ${status.seclusion_mode}`);
    console.log(`  can_deep: ${status.can_deep}`);
    console.log(`  deep_remaining: ${status.deep_remaining}`);
    console.log(`  deep_cooldown_remaining: ${status.deep_cooldown_remaining}`);
    console.log(`  normal_remaining: ${status.normal_remaining}`);
    console.log(`  normal_cooldown_remaining: ${status.normal_cooldown_remaining}`);
    console.log(`  daily_seclusion_count: ${status.daily_seclusion_count}`);
    console.log(`  daily_deep_seclusion_count: ${status.daily_deep_seclusion_count}`);
    console.log(`  deep_config: ${JSON.stringify(status.deep_config)}`);
    console.log('');

    // 3. 判定分析
    console.log('[分析]');
    if (status.can_deep === true) {
        console.log('  ✅ can_deep=true，后端境界校验通过');
    } else {
        console.log('  ❌ can_deep=false 或 undefined，前端会显示"境界不足"');
    }

    if (status.deep_remaining !== undefined && status.deep_remaining <= 0) {
        console.log('  ⚠️ 今日深度闭关次数已用尽（前端会显示"今日深度闭关已用尽"）');
    }

    if (status.deep_cooldown_remaining > 0) {
        console.log(`  ⚠️ 深度闭关冷却中，剩余 ${status.deep_cooldown_remaining} 秒`);
    }
}

main().catch(err => {
    console.error('异常:', err.response?.data || err.message);
    process.exit(1);
});
