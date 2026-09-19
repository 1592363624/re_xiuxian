/**
 * 灵兽系统接口集成测试脚本
 *
 * 测试流程：
 *   1. 登录获取 token（账号：1592363624 / 密码：1592363624）
 *   2. GET /api/spirit-beast/types - 确认返回4种灵兽
 *   3. GET /api/spirit-beast/daily-status - 查看今日捕获状态
 *   4. POST /api/spirit-beast/catch { beast_key: "qingyun_wolf" } - 捕获青云狼
 *   5. GET /api/spirit-beast/list - 确认列表中有灵兽
 *   6. POST /api/spirit-beast/:beastId/feed - 喂养
 *   7. POST /api/spirit-beast/:beastId/interact - 互动
 *   8. POST /api/spirit-beast/:beastId/set-active - 设置出战
 *   9. GET /api/spirit-beast/:beastId - 查看详情
 *
 * 运行方式：node scripts/test_spirit_beast.js
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

// 请求拦截器：自动添加 Authorization
client.interceptors.request.use(config => {
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

let token = '';
let firstBeastId = null;

/**
 * 打印响应结果
 */
function printResult(label, res) {
    const data = res.data;
    const success = data.success !== false && (data.code === 200 || data.code === undefined);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${success ? '✓' : '✗'} ${label}`);
    console.log(`${'─'.repeat(60)}`);
    if (data.message) console.log(`消息: ${data.message}`);
    if (data.data) {
        console.log('数据:', JSON.stringify(data.data, null, 2).slice(0, 1500));
    }
}

/**
 * 主测试流程
 */
async function main() {
    console.log('═'.repeat(60));
    console.log('  灵兽系统接口集成测试');
    console.log('═'.repeat(60));

    // 1. 登录
    console.log('\n[1/9] 登录获取 token...');
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

    // 2. GET /api/spirit-beast/types - 灵兽图鉴
    console.log('\n[2/9] 获取灵兽图鉴...');
    try {
        const res = await client.get('/spirit-beast/types');
        printResult('GET /spirit-beast/types', res);
        const beasts = res.data.data?.beast_types || [];
        console.log(`\n  → 共 ${beasts.length} 种灵兽（预期 4 种）`);
        beasts.forEach(b => {
            console.log(`    - ${b.name}（${b.rarity_name}/${b.element_name}）| 捕获率: ${Math.floor(b.catch_chance * 100)}% | 灵力消耗: ${b.catch_cost_mp} | 已捕获: ${b.caught ? '是' : '否'}`);
        });
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 3. GET /api/spirit-beast/daily-status - 今日捕获状态
    console.log('\n[3/9] 获取今日捕获状态...');
    try {
        const res = await client.get('/spirit-beast/daily-status');
        printResult('GET /spirit-beast/daily-status', res);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 4. POST /api/spirit-beast/catch - 捕获青云狼
    console.log('\n[4/9] 寻觅/捕获青云狼...');
    try {
        const res = await client.post('/spirit-beast/catch', { beast_key: 'qingyun_wolf' });
        printResult('POST /spirit-beast/catch', res);
        if (res.data.data?.caught && res.data.data.beast_id) {
            firstBeastId = res.data.data.beast_id;
            console.log(`\n  → 捕获成功！灵兽ID: ${firstBeastId}`);
        } else if (!res.data.data?.caught) {
            console.log(`\n  → 本次捕获失败（概率 ${res.data.data?.catch_chance}），重试一次...`);
            // 重试一次
            const retryRes = await client.post('/spirit-beast/catch', { beast_key: 'qingyun_wolf' });
            printResult('POST /spirit-beast/catch (重试)', retryRes);
            if (retryRes.data.data?.caught && retryRes.data.data.beast_id) {
                firstBeastId = retryRes.data.data.beast_id;
                console.log(`\n  → 重试捕获成功！灵兽ID: ${firstBeastId}`);
            }
        }
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    if (!firstBeastId) {
        // 多次尝试仍未捕获，尝试查询是否已有灵兽
        console.log('\n  → 多次捕获失败，查询是否已有灵兽...');
        try {
            const listRes = await client.get('/spirit-beast/list');
            const beasts = listRes.data.data?.beasts || [];
            if (beasts.length > 0) {
                firstBeastId = beasts[0].id;
                console.log(`  → 使用已有灵兽ID: ${firstBeastId}（${beasts[0].display_name}）`);
            }
        } catch (e) {
            console.log('✗ 查询列表异常:', e.response?.data || e.message);
        }
    }

    if (!firstBeastId) {
        console.log('\n✗ 未获取到任何灵兽，无法进行后续测试');
        return;
    }

    // 5. GET /api/spirit-beast/list - 我的灵兽列表
    console.log('\n[5/9] 获取我的灵兽列表...');
    try {
        const res = await client.get('/spirit-beast/list');
        printResult('GET /spirit-beast/list', res);
        const beasts = res.data.data?.beasts || [];
        console.log(`\n  → 共 ${beasts.length} 只灵兽`);
        beasts.forEach(b => {
            console.log(`    - ${b.display_name}（${b.rarity_name}/${b.element_name}）| ★${b.star_level} | Lv.${b.level} | 战力: ${b.combat_power} | ${b.is_active ? '出战中' : '休憩'}`);
        });
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 6. POST /api/spirit-beast/:beastId/feed - 喂养
    console.log(`\n[6/9] 喂养灵兽（ID: ${firstBeastId}）...`);
    try {
        const res = await client.post(`/spirit-beast/${firstBeastId}/feed`, {});
        printResult(`POST /spirit-beast/${firstBeastId}/feed`, res);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 7. POST /api/spirit-beast/:beastId/interact - 互动
    console.log(`\n[7/9] 互动灵兽（ID: ${firstBeastId}）...`);
    try {
        const res = await client.post(`/spirit-beast/${firstBeastId}/interact`, {});
        printResult(`POST /spirit-beast/${firstBeastId}/interact`, res);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 8. POST /api/spirit-beast/:beastId/set-active - 设置出战
    console.log(`\n[8/9] 设置出战灵兽（ID: ${firstBeastId}）...`);
    try {
        const res = await client.post(`/spirit-beast/${firstBeastId}/set-active`, {});
        printResult(`POST /spirit-beast/${firstBeastId}/set-active`, res);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    // 9. GET /api/spirit-beast/:beastId - 灵兽详情
    console.log(`\n[9/9] 查看灵兽详情（ID: ${firstBeastId}）...`);
    try {
        const res = await client.get(`/spirit-beast/${firstBeastId}`);
        printResult(`GET /spirit-beast/${firstBeastId}`, res);
    } catch (e) {
        console.log('✗ 异常:', e.response?.data || e.message);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('  灵兽系统接口测试完成');
    console.log('═'.repeat(60));
}

main().catch(err => {
    console.error('测试执行失败:', err);
    process.exit(1);
});
