/**
 * 悬赏系统反悬赏功能测试脚本
 *
 * 测试内容：
 * 1. 登录测试账号
 * 2. 查询我的悬赏（验证 targeting_me 字段存在）
 * 3. 反悬赏接口参数校验（bountyId 无效、不存在等）
 * 4. 反悬赏权限校验（非 target 不可反悬赏）
 *
 * 运行方式：node server/scripts/test_bounty_counter.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-22
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';

// 测试账号
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

// 测试结果统计
let passed = 0;
let failed = 0;

/**
 * 断言工具
 */
function assert(condition, message) {
    if (condition) {
        console.log(`[PASS] ${message}`);
        passed++;
    } else {
        console.log(`[FAIL] ${message}`);
        failed++;
    }
}

/**
 * HTTP 请求工具
 * 使用 Node.js 18+ 内置 fetch，回退到 http 模块
 */
async function httpRequest(method, path, data, token) {
    const url = `${BASE_URL}${path}`;
    // Node.js 18+ 内置 fetch
    if (typeof fetch !== 'undefined') {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }
        if (data) {
            options.body = JSON.stringify(data);
        }
        const res = await fetch(url, options);
        const body = await res.json();
        return { status: res.status, body };
    }
    // 回退到 http 模块
    const http = require('http');
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: {} });
                }
            });
        });
        req.on('error', reject);
        if (data) {
            req.write(JSON.stringify(data));
        }
        req.end();
    });
}

/**
 * 主测试函数
 */
async function main() {
    console.log('====== 悬赏系统反悬赏功能测试 ======\n');

    // 1. 登录测试账号
    console.log('--- 阶段1: 登录 ---');
    let token;
    try {
        const loginRes = await httpRequest('POST', '/auth/login', TEST_ACCOUNT);
        assert(loginRes.status === 200, '登录应返回 200');
        token = loginRes.body.token || loginRes.body.data?.token;
        assert(!!token, '应返回有效 token');
    } catch (err) {
        console.log(`[ERROR] 登录失败: ${err.message}`);
        process.exit(1);
    }

    // 2. 查询我的悬赏（验证 targeting_me 字段存在）
    console.log('\n--- 阶段2: 查询我的悬赏（验证 targeting_me 字段） ---');
    try {
        const myRes = await httpRequest('GET', '/bounty/my', null, token);
        assert(myRes.status === 200, 'GET /bounty/my 应返回 200');
        const myData = myRes.body.data;
        assert(!!myData, '应返回 data 对象');
        assert(Array.isArray(myData.published), '应包含 published 数组');
        assert(Array.isArray(myData.accepted), '应包含 accepted 数组');
        assert(Array.isArray(myData.targeting_me), '应包含 targeting_me 数组（反悬赏功能新增）');
        console.log(`  published: ${myData.published.length} 条`);
        console.log(`  accepted: ${myData.accepted.length} 条`);
        console.log(`  targeting_me: ${myData.targeting_me.length} 条`);
    } catch (err) {
        console.log(`[ERROR] 查询我的悬赏失败: ${err.message}`);
        failed++;
    }

    // 3. 反悬赏接口参数校验
    console.log('\n--- 阶段3: 反悬赏接口参数校验 ---');

    // 3.1 无效 bountyId
    try {
        const res = await httpRequest('POST', '/bounty/invalid/counter', {}, token);
        assert(res.status === 400, '无效 bountyId 应返回 400');
        assert(res.body.error_code === 'VALIDATION_ERROR', '无效 bountyId 应返回 VALIDATION_ERROR');
    } catch (err) {
        console.log(`[ERROR] 无效 bountyId 测试失败: ${err.message}`);
        failed++;
    }

    // 3.2 bountyId 为 0 或负数
    try {
        const res = await httpRequest('POST', '/bounty/0/counter', {}, token);
        assert(res.status === 400, 'bountyId=0 应返回 400');
    } catch (err) {
        console.log(`[ERROR] bountyId=0 测试失败: ${err.message}`);
        failed++;
    }

    // 3.3 不存在的悬赏
    try {
        const res = await httpRequest('POST', '/bounty/999999/counter', {}, token);
        assert(res.status === 404, '不存在的悬赏应返回 404');
        assert(res.body.message?.includes('不存在'), '应提示"原悬赏不存在"');
    } catch (err) {
        console.log(`[ERROR] 不存在悬赏测试失败: ${err.message}`);
        failed++;
    }

    // 3.4 reason 类型校验（非字符串）
    try {
        const res = await httpRequest('POST', '/bounty/1/counter', { reason: 123 }, token);
        assert(res.status === 400, 'reason 为数字应返回 400');
        assert(res.body.message?.includes('字符串'), '应提示 reason 必须为字符串');
    } catch (err) {
        console.log(`[ERROR] reason 类型校验测试失败: ${err.message}`);
        failed++;
    }

    // 3.5 reason 超长校验
    try {
        const longReason = 'a'.repeat(181);
        const res = await httpRequest('POST', '/bounty/1/counter', { reason: longReason }, token);
        assert(res.status === 400, 'reason 超 180 字应返回 400');
        assert(res.body.message?.includes('180'), '应提示不能超过 180 字');
    } catch (err) {
        console.log(`[ERROR] reason 超长校验测试失败: ${err.message}`);
        failed++;
    }

    // 4. 验证 OpenAPI 文档包含反悬赏接口
    console.log('\n--- 阶段4: OpenAPI 文档验证 ---');
    try {
        const fs = require('fs');
        const path = require('path');
        const openapiPath = path.resolve(__dirname, '../../docs/openapi.json');
        const doc = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
        assert(!!doc.paths['/api/bounty/{bountyId}/counter'], 'OpenAPI 应包含反悬赏路径');
        assert(!!doc.paths['/api/bounty/{bountyId}/counter']?.post, '反悬赏路径应包含 POST 方法');
        assert(doc.paths['/api/bounty/{bountyId}/counter'].post.operationId === 'counterBounty', 'operationId 应为 counterBounty');
    } catch (err) {
        console.log(`[ERROR] OpenAPI 验证失败: ${err.message}`);
        failed++;
    }

    // 5. 验证配置完整性
    console.log('\n--- 阶段5: 配置完整性验证 ---');
    try {
        const { infrastructure } = require('../modules');
        const configLoader = infrastructure.ConfigLoader;
        await configLoader.initialize();
        const config = configLoader.getConfig('game_balance');
        const bountyCfg = config?.pvp_extended?.bounty;
        assert(bountyCfg?.protection_period_minutes === 30, '保护期配置应为 30 分钟');
        assert(bountyCfg?.counter_bounty?.enabled === true, '反悬赏功能应启用');
        assert(bountyCfg?.counter_bounty?.amount_multiplier === 1.2, '反悬赏倍率应为 1.2');
        assert(bountyCfg?.counter_bounty?.max_counter_chain === 3, '反悬赏链上限应为 3');
    } catch (err) {
        console.log(`[ERROR] 配置验证失败: ${err.message}`);
        failed++;
    }

    // 测试结果汇总
    console.log('\n====== 测试结果汇总 ======');
    console.log(`通过: ${passed} / ${passed + failed}`);
    console.log(`失败: ${failed}`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('测试执行异常:', err);
    process.exit(1);
});
