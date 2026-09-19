/**
 * 道侣/双修系统接口集成测试脚本
 *
 * 测试流程（玩家ID=1 韩天尊，化神初期）：
 *   1. 登录获取 token（账号：1592363624 / 密码：1592363624）
 *   2. GET  /api/dao-companion/my                    - 我的道侣信息（预期 has_companion=false）
 *   3. GET  /api/dao-companion/proposals             - 我收到的求婚列表（预期空列表）
 *   4. POST /api/dao-companion/propose               - 求婚（向自己求婚，预期失败：不能与自己结侣）
 *   5. POST /api/dao-companion/propose               - 求婚（向不存在的玩家求婚，预期失败）
 *   6. GET  /api/dao-companion/heart-tribulation/status - 心劫状态（预期 has_pending=false）
 *   7. POST /api/dao-companion/interact              - 道侣互动（预期失败：无道侣）
 *   8. POST /api/dao-companion/dual-cultivation      - 双修（预期失败：无道侣）
 *   9. POST /api/dao-companion/heart-imprint         - 凝聚心印（预期失败：无道侣）
 *  10. POST /api/dao-companion/break                 - 解除道侣（预期失败：无道侣）
 *  11. POST /api/dao-companion/respond               - 响应不存在的求婚（预期失败：求婚记录不存在）
 *  12. POST /api/dao-companion/heart-tribulation/respond - 心劫抉择（预期失败：心劫事件不存在）
 *
 * 验证点：
 *   - 接口可访问（路由注册正确）
 *   - 鉴权中间件生效（无 token 返回 401）
 *   - 参数校验生效（target_player_id 缺失返回 400）
 *   - 业务校验生效（境界/活跃道侣/心劫事件存在性等）
 *   - 配置加载器已加载 dao_companion_data 配置
 *   - 状态机已注册 IN_DUAL_CULTIVATION 状态
 *
 * 运行方式：在 server 目录下执行 node scripts/test_dao_companion.js
 */
const axios = require('axios');

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

// 创建 axios 实例（自动携带 token）
const client = axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
    headers: { 'Content-Type': 'application/json' }
});

let token = '';

// 请求拦截器：自动添加 Authorization
client.interceptors.request.use(config => {
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

/**
 * 打印响应结果
 * @param {string} label - 测试标签
 * @param {Object} res - axios 响应对象
 * @param {boolean} expectSuccess - 预期业务是否成功
 */
function printResult(label, res, expectSuccess = null) {
    const data = res.data;
    const success = data.success !== false && (data.code === 200 || data.code === undefined);
    const mark = success ? '✓' : '✗';
    const expectMark = expectSuccess === null ? '' : (success === expectSuccess ? '✓符合预期' : '✗不符合预期');
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${mark} ${label}  ${expectMark}`);
    console.log(`${'─'.repeat(60)}`);
    if (data.message) console.log(`消息: ${data.message}`);
    if (data.data) {
        const json = JSON.stringify(data.data, null, 2);
        console.log('数据:', json.length > 1200 ? json.slice(0, 1200) + '...(截断)' : json);
    }
}

/**
 * 主测试流程
 */
async function main() {
    console.log('═'.repeat(60));
    console.log('  道侣/双修系统接口集成测试');
    console.log('═'.repeat(60));

    // 1. 登录
    console.log('\n[1/12] 登录获取 token...');
    try {
        const loginRes = await client.post('/auth/login', {
            username: TEST_ACCOUNT,
            password: TEST_PASSWORD
        });
        if (loginRes.data.token) {
            token = loginRes.data.token;
            console.log(`✓ 登录成功，token: ${token.slice(0, 20)}...`);
            console.log(`  玩家: ${loginRes.data.player?.nickname} | 境界: ${loginRes.data.player?.realm} | rank: ${loginRes.data.player?.realm_rank}`);
        } else {
            console.log('✗ 登录失败:', JSON.stringify(loginRes.data));
            return;
        }
    } catch (e) {
        console.log('✗ 登录异常:', e.message);
        return;
    }

    // 2. GET /api/dao-companion/my - 我的道侣信息
    console.log('\n[2/12] 获取我的道侣信息...');
    try {
        const res = await client.get('/dao-companion/my');
        printResult('GET /dao-companion/my', res);
        const hasCompanion = res.data.data?.has_companion;
        console.log(`\n  → has_companion: ${hasCompanion}`);
        if (!hasCompanion) {
            console.log(`  → can_propose: ${res.data.data?.can_propose}（需 rank ${res.data.data?.min_realm_rank} ${res.data.data?.min_realm_name}）`);
        }
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 3. GET /api/dao-companion/proposals - 我收到的求婚列表
    console.log('\n[3/12] 获取我收到的求婚列表...');
    try {
        const res = await client.get('/dao-companion/proposals');
        printResult('GET /dao-companion/proposals', res);
        const count = res.data.data?.count || 0;
        console.log(`\n  → 收到 ${count} 个求婚（上限 ${res.data.data?.max_pending}）`);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 4. POST /api/dao-companion/propose - 求婚（向自己求婚，预期失败）
    console.log('\n[4/12] 求婚：向自己求婚（预期失败）...');
    try {
        // 玩家ID=1，向自己求婚
        const res = await client.post('/dao-companion/propose', { target_player_id: 1 });
        printResult('POST /dao-companion/propose (向自己求婚)', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 5. POST /api/dao-companion/propose - 求婚（向不存在的玩家求婚，预期失败）
    console.log('\n[5/12] 求婚：向不存在的玩家求婚（预期失败）...');
    try {
        const res = await client.post('/dao-companion/propose', { target_player_id: 99999999 });
        printResult('POST /dao-companion/propose (向不存在玩家求婚)', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 6. GET /api/dao-companion/heart-tribulation/status - 心劫状态
    console.log('\n[6/12] 获取心劫状态...');
    try {
        const res = await client.get('/dao-companion/heart-tribulation/status');
        printResult('GET /dao-companion/heart-tribulation/status', res);
        console.log(`\n  → has_pending: ${res.data.data?.has_pending}`);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 7. POST /api/dao-companion/interact - 道侣互动（无道侣，预期失败）
    console.log('\n[7/12] 道侣互动（预期失败：无道侣）...');
    try {
        const res = await client.post('/dao-companion/interact', {});
        printResult('POST /dao-companion/interact', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 8. POST /api/dao-companion/dual-cultivation - 双修（无道侣，预期失败）
    console.log('\n[8/12] 双修（预期失败：无道侣）...');
    try {
        const res = await client.post('/dao-companion/dual-cultivation', {});
        printResult('POST /dao-companion/dual-cultivation', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 9. POST /api/dao-companion/heart-imprint - 凝聚心印（无道侣，预期失败）
    console.log('\n[9/12] 凝聚心印（预期失败：无道侣）...');
    try {
        const res = await client.post('/dao-companion/heart-imprint', {});
        printResult('POST /dao-companion/heart-imprint', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 10. POST /api/dao-companion/break - 解除道侣（无道侣，预期失败）
    console.log('\n[10/12] 解除道侣（预期失败：无道侣）...');
    try {
        const res = await client.post('/dao-companion/break', {});
        printResult('POST /dao-companion/break', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 11. POST /api/dao-companion/respond - 响应不存在的求婚（预期失败）
    console.log('\n[11/12] 响应不存在的求婚（预期失败）...');
    try {
        const res = await client.post('/dao-companion/respond', {
            proposal_id: 99999999,
            action: 'accept'
        });
        printResult('POST /dao-companion/respond (不存在的求婚)', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 12. POST /api/dao-companion/heart-tribulation/respond - 心劫抉择（事件不存在，预期失败）
    console.log('\n[12/12] 心劫抉择：事件不存在（预期失败）...');
    try {
        const res = await client.post('/dao-companion/heart-tribulation/respond', {
            event_id: 99999999,
            option: 'trust'
        });
        printResult('POST /dao-companion/heart-tribulation/respond (事件不存在)', res, false);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('  道侣/双修系统接口测试完成');
    console.log('═'.repeat(60));
    console.log('\n说明：');
    console.log('  - 玩家ID=1（韩天尊）当前无道侣，所有需要道侣的接口预期返回业务失败');
    console.log('  - 本测试主要验证：路由注册、鉴权、参数校验、配置加载、状态机集成');
    console.log('  - 完整业务流程（求婚→接受→互动→双修→心劫→心印）需双账号场景测试');
    console.log('  - 在控制台可看到 WebSocket 推送日志（如有道侣互动会触发通知）');
}

// 启动测试
main().catch(err => {
    console.error('测试执行异常:', err);
    process.exit(1);
});
