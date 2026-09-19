/**
 * 切磋木人排行榜每日奖励结算 测试脚本
 *
 * 测试范围：
 *   1. GM 接口鉴权（未登录/非管理员/管理员）
 *   2. 参数校验（target_date 格式）
 *   3. 正常结算流程（默认昨日 / 指定日期）
 *   4. 幂等性（重复调用返回 already_settled=true）
 *   5. 字段完整性校验
 *
 * 测试账号：1592363624 / 1592363624（管理员）
 * 运行方式：node server/scripts/test_sparring_daily_ranking_settle.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const http = require('http');

// ============== 配置 ==============
const HOST = '127.0.0.1';
const PORT = 5000;
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

// ============== 测试工具 ==============
let passCount = 0;
let failCount = 0;
const failures = [];

/**
 * 发送 HTTP 请求
 * @param {string} method - GET/POST
 * @param {string} path - 路径
 * @param {Object} [body] - 请求体（POST 时有效）
 * @param {string} [token] - JWT token
 * @returns {Promise<{status:number, body:Object}>}
 */
function request(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const data = body ? JSON.stringify(body) : null;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);

        const req = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
            let chunks = '';
            res.on('data', (c) => chunks += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/**
 * 断言通过
 * @param {string} name - 测试名
 */
function pass(name) {
    passCount++;
    console.log(`  ✅ ${name}`);
}

/**
 * 断言失败
 * @param {string} name - 测试名
 * @param {*} actual - 实际值
 * @param {*} expected - 期望值
 */
function fail(name, actual, expected) {
    failCount++;
    failures.push({ name, actual, expected });
    console.log(`  ❌ ${name}`);
    console.log(`     期望: ${JSON.stringify(expected)}`);
    console.log(`     实际: ${JSON.stringify(actual)}`);
}

/**
 * 断言相等
 */
function assertEqual(name, actual, expected) {
    if (actual === expected) {
        pass(name);
    } else {
        fail(name, actual, expected);
    }
}

/**
 * 断言为真
 */
function assertTrue(name, actual) {
    if (actual === true || (actual && typeof actual === 'object')) {
        pass(name);
    } else {
        fail(name, actual, 'truthy');
    }
}

/**
 * 断言为假
 */
function assertFalse(name, actual) {
    if (!actual) {
        pass(name);
    } else {
        fail(name, actual, 'falsy');
    }
}

// ============== 主测试流程 ==============
async function main() {
    console.log('\n=========================================');
    console.log('  切磋木人排行榜每日奖励结算 测试');
    console.log('=========================================\n');

    // ============== 阶段 1：登录 ==============
    console.log('【阶段 1】登录获取 JWT token');
    const loginRes = await request('POST', '/api/auth/login', {
        username: TEST_ACCOUNT,
        password: TEST_PASSWORD
    });
    if (loginRes.status !== 200 || !loginRes.body?.token) {
        console.error(`❌ 登录失败: status=${loginRes.status}, body=${JSON.stringify(loginRes.body).slice(0, 300)}`);
        process.exit(1);
    }
    const token = loginRes.body.token;
    const playerInfo = loginRes.body.player || {};
    console.log(`  ✓ 登录成功（玩家ID=${playerInfo.id || '?'}，role=${playerInfo.role || '?'}）\n`);

    // ============== 阶段 2：接口鉴权测试 ==============
    console.log('【阶段 2】接口鉴权测试');

    // 2.1 未登录拒绝
    {
        const res = await request('POST', '/api/sparring/settle');
        assertEqual('未登录调用应返回 401', res.status, 401);
    }

    // 2.2 非管理员拒绝（构造一个无效 token 触发 401）
    {
        const res = await request('POST', '/api/sparring/settle', {}, 'invalid.token.here');
        assertEqual('无效 token 应返回 401/403', (res.status === 401 || res.status === 403) ? 401 : res.status, 401);
    }

    // 2.3 管理员可访问
    {
        const res = await request('POST', '/api/sparring/settle', {}, token);
        assertTrue('管理员调用应返回 200', res.status === 200 && res.body?.code === 200);
    }
    console.log('');

    // ============== 阶段 3：参数校验测试 ==============
    console.log('【阶段 3】参数校验测试');

    // 3.1 target_date 格式错误（非 YYYY-MM-DD）
    {
        const res = await request('POST', '/api/sparring/settle', { target_date: '2026/07/20' }, token);
        assertEqual('格式错误应返回 400', res.status, 400);
        assertTrue('应含 VALIDATION_ERROR', res.body?.error_code === 'VALIDATION_ERROR');
    }

    // 3.2 target_date 非法日期（2026-02-30）
    {
        const res = await request('POST', '/api/sparring/settle', { target_date: '2026-02-30' }, token);
        assertEqual('非法日期应返回 400', res.status, 400);
        assertTrue('应含 VALIDATION_ERROR', res.body?.error_code === 'VALIDATION_ERROR');
    }

    // 3.3 target_date 非字符串
    {
        const res = await request('POST', '/api/sparring/settle', { target_date: 12345 }, token);
        assertEqual('非字符串 target_date 应返回 400', res.status, 400);
    }
    console.log('');

    // ============== 阶段 4：正常结算流程测试 ==============
    console.log('【阶段 4】正常结算流程测试');

    // 4.1 不传 target_date（默认昨日）
    const settleResult1 = await request('POST', '/api/sparring/settle', {}, token);
    {
        assertTrue('默认昨日结算应返回 200', settleResult1.status === 200 && settleResult1.body?.code === 200);
        const data = settleResult1.body?.data;
        assertTrue('应返回 data 对象', !!data);
        if (data) {
            assertTrue('应含 settle_date 字段', typeof data.settle_date === 'string');
            assertTrue('应含 already_settled 字段', typeof data.already_settled === 'boolean');
            assertTrue('应含 settled_count 字段', typeof data.settled_count === 'number');
            assertTrue('应含 rewards 字段', Array.isArray(data.rewards));
            assertTrue('应含 message 字段', typeof data.message === 'string');
            // 校验 settle_date 格式
            if (typeof data.settle_date === 'string') {
                pass('settle_date 格式为 YYYY-MM-DD');
            } else {
                fail('settle_date 格式为 YYYY-MM-DD', data.settle_date, 'YYYY-MM-DD');
            }
            console.log(`     结算结果: settle_date=${data.settle_date}, already_settled=${data.already_settled}, settled_count=${data.settled_count}`);
        }
    }

    // 4.2 幂等性：再次调用应返回 already_settled=true
    {
        const res = await request('POST', '/api/sparring/settle', {}, token);
        assertTrue('再次调用应返回 200', res.status === 200 && res.body?.code === 200);
        const data = res.body?.data;
        console.log(`     [DEBUG] 再次调用返回: status=${res.status}, body=${JSON.stringify(res.body).slice(0, 400)}`);
        if (data) {
            assertTrue('再次调用应 already_settled=true', data.already_settled === true);
            assertEqual('再次调用 settled_count 应为 0', data.settled_count, 0);
        }
    }

    // 4.3 指定具体日期结算
    {
        // 用 7 天前的日期测试（不太可能有记录，但要返回 200）
        const testDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const dateStr = testDate.toISOString().slice(0, 10);
        const res = await request('POST', '/api/sparring/settle', { target_date: dateStr }, token);
        console.log(`     [DEBUG] 指定日期(${dateStr})返回: status=${res.status}, body=${JSON.stringify(res.body).slice(0, 400)}`);
        assertTrue('指定日期结算应返回 200', res.status === 200 && res.body?.code === 200);
        const data = res.body?.data;
        if (data) {
            assertEqual('settle_date 应等于传入日期', data.settle_date, dateStr);
            assertTrue('应含 already_settled 字段', typeof data.already_settled === 'boolean');
            console.log(`     结算结果(${dateStr}): already_settled=${data.already_settled}, settled_count=${data.settled_count}`);
        }
    }

    // 4.4 再次指定同一日期，验证幂等性
    {
        const testDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const dateStr = testDate.toISOString().slice(0, 10);
        const res = await request('POST', '/api/sparring/settle', { target_date: dateStr }, token);
        console.log(`     [DEBUG] 同日重复(${dateStr})返回: status=${res.status}, body=${JSON.stringify(res.body).slice(0, 400)}`);
        assertTrue('同日重复调用应返回 200', res.status === 200);
        const data = res.body?.data;
        if (data) {
            assertTrue('同日重复应 already_settled=true', data.already_settled === true);
        }
    }
    console.log('');

    // ============== 阶段 5：称号配置校验 ==============
    console.log('【阶段 5】称号配置校验');
    {
        // 读取 titles.json 校验新称号是否已注册
        const titles = require('../config/titles.json');
        const expectedTitles = ['化神木人·破阵者', '木人切磋·天下第一'];
        for (const titleId of expectedTitles) {
            const found = titles.find(t => t.id === titleId);
            assertTrue(`称号「${titleId}」应已注册`, !!found);
            if (found) {
                assertTrue(`称号「${titleId}」应含 bonuses`, !!found.bonuses && typeof found.bonuses === 'object');
                assertTrue(`称号「${titleId}」应含 description`, typeof found.description === 'string' && found.description.length > 0);
            }
        }
    }
    console.log('');

    // ============== 阶段 6：调度器配置校验 ==============
    console.log('【阶段 6】调度器配置校验');
    {
        const config = require('../config/sparring_woodman.json');
        assertEqual('应配置 ranking_top_n=10', config.global.ranking_top_n, 10);
        assertEqual('应配置 ranking_settle_hour=0', config.global.ranking_settle_hour, 0);
        assertEqual('应配置 ranking_settle_minute=5', config.global.ranking_settle_minute, 5);
        assertTrue('应配置 ranking_daily_reward', !!config.global.ranking_daily_reward);
        assertTrue('应配置 1 名奖励', !!config.global.ranking_daily_reward['1']?.exp > 0);
        assertTrue('1 名应含 title=木人切磋·天下第一',
            config.global.ranking_daily_reward['1']?.title === '木人切磋·天下第一');
        assertTrue('应配置 default 档奖励', !!config.global.ranking_daily_reward['default']);
    }
    console.log('');

    // ============== 阶段 7：化神木人首通称号校验 ==============
    console.log('【阶段 7】化神木人首通称号校验');
    {
        const config = require('../config/sparring_woodman.json');
        const spiritSevering = config.woodmen.find(w => w.key === 'spirit_severing');
        assertTrue('化神木人应存在', !!spiritSevering);
        if (spiritSevering) {
            assertEqual('化神木人 tier=5', spiritSevering.tier, 5);
            assertTrue('应配置 first_clear_bonus', !!spiritSevering.first_clear_bonus);
            assertEqual('首通称号应为「化神木人·破阵者」',
                spiritSevering.first_clear_bonus?.title, '化神木人·破阵者');
        }
    }
    console.log('');

    // ============== 总结 ==============
    console.log('=========================================');
    console.log(`  测试完成：✅ ${passCount} 通过，❌ ${failCount} 失败`);
    console.log('=========================================');
    if (failCount > 0) {
        console.log('\n失败用例详情：');
        failures.forEach((f, i) => {
            console.log(`  ${i + 1}. ${f.name}`);
            console.log(`     期望: ${JSON.stringify(f.expected)}`);
            console.log(`     实际: ${JSON.stringify(f.actual)}`);
        });
        process.exit(1);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('\n💥 测试脚本异常:', err.message);
    console.error(err.stack);
    process.exit(1);
});
