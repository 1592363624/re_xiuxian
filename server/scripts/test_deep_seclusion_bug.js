/**
 * 深度闭关 bug 排查测试
 *
 * 重现用户报告：化神期玩家无法使用筑基期解锁的深度闭关
 * 测试步骤：
 *   1. 登录测试账号（玩家ID=1，admin，化神初期 realm_rank=23）
 *   2. 查询玩家信息，确认 realm / realm_rank
 *   3. 调用 RealmService.meetsRealmRequirement 验证境界校验
 *   4. 调用 POST /api/seclusion/start { mode: 'deep' }，观察是否被拦截
 *
 * 运行：node server/scripts/test_deep_seclusion_bug.js
 */
'use strict';

const axios = require('axios');

const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';
const API_BASE = 'http://localhost:5000';

async function main() {
    console.log('========================================');
    console.log('深度闭关 bug 排查测试');
    console.log('========================================\n');

    // 1. 登录
    console.log('[步骤 1] 登录测试账号...');
    const loginResp = await axios.post(`${API_BASE}/api/auth/login`, {
        username: TEST_ACCOUNT,
        password: TEST_PASSWORD
    });
    if (loginResp.data.code !== 200) {
        console.error('登录失败:', loginResp.data);
        process.exit(1);
    }
    const token = loginResp.data.token;
    const playerBasic = loginResp.data.player;
    console.log(`    登录成功：ID=${playerBasic.id}, nickname=${playerBasic.nickname}, realm=${playerBasic.realm}, role=${playerBasic.role}`);
    const authHeaders = { Authorization: `Bearer ${token}` };
    console.log('');

    // 2. 查询玩家完整信息（/api/player/me）
    console.log('[步骤 2] 查询玩家完整信息 GET /api/player/me...');
    const meResp = await axios.get(`${API_BASE}/api/player/me`, { headers: authHeaders });
    if (meResp.data.code !== 200) {
        console.error('查询玩家信息失败:', meResp.data);
        process.exit(1);
    }
    const me = meResp.data.data || meResp.data;
    console.log(`    realm: ${me.realm}`);
    console.log(`    realm_rank: ${me.realm_rank}`);
    console.log(`    role: ${me.role}`);
    console.log(`    is_secluded: ${me.is_secluded}`);
    console.log(`    daily_deep_seclusion_count: ${me.daily_deep_seclusion_count}`);
    console.log(`    last_seclusion_time: ${me.last_seclusion_time}`);
    console.log('');

    // 3. 尝试启动深度闭关
    console.log('[步骤 3] 尝试启动深度闭关 POST /api/seclusion/start { mode: "deep", duration: 14400 }...');
    try {
        const startResp = await axios.post(`${API_BASE}/api/seclusion/start`, {
            mode: 'deep',
            duration: 14400
        }, { headers: authHeaders });
        console.log(`    [成功] HTTP ${startResp.status}`);
        console.log(`    响应: ${JSON.stringify(startResp.data, null, 2)}`);

        // 立即结束闭关（避免影响后续测试）
        console.log('\n[步骤 3.1] 立即结束闭关以还原状态...');
        try {
            const endResp = await axios.post(`${API_BASE}/api/seclusion/end`, {}, { headers: authHeaders });
            console.log(`    结束闭关响应: code=${endResp.data.code}, message=${endResp.data.message}`);
            if (endResp.data.data?.forced_end) {
                console.log(`    强行出关惩罚已生效（损失50%收益），exp_gain=${endResp.data.data.exp_gain}`);
            }
        } catch (endErr) {
            console.log(`    结束闭关失败: ${endErr.response?.data?.message || endErr.message}`);
        }
    } catch (startErr) {
        console.log(`    [失败] HTTP ${startErr.response?.status || 'N/A'}`);
        console.log(`    错误响应: ${JSON.stringify(startErr.response?.data, null, 2)}`);
        console.log('');

        // 4. 解析错误原因
        const errMsg = startErr.response?.data?.message || '';
        console.log('[步骤 4] 错误原因分析:');
        if (errMsg.includes('境界')) {
            console.log(`    → 境界校验拦截。player realm=${me.realm}, realm_rank=${me.realm_rank}`);
            console.log(`    → 配置要求 min_realm='筑基期'（rank=11）`);
            console.log(`    → 若 playerRank < 11 才应被拦截，化神 rank=23 不应被拦截`);
        } else if (errMsg.includes('冷却')) {
            console.log(`    → 冷却时间未到。需等待 last_seclusion_time + cooldown`);
        } else if (errMsg.includes('次数')) {
            console.log(`    → 今日深度闭关次数已用尽（每日1次）`);
        } else if (errMsg.includes('已在闭关')) {
            console.log(`    → 玩家已在闭关中（is_secluded=true）`);
        } else {
            console.log(`    → 其他原因: ${errMsg}`);
        }
    }
    console.log('');

    console.log('========================================');
    console.log('测试完成');
    console.log('========================================');
}

main().catch(err => {
    console.error('测试脚本异常:', err.message);
    process.exit(1);
});
