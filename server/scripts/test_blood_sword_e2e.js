/**
 * 法宝深线血魔剑线端到端测试脚本
 *
 * 测试场景：
 *   1. 登录测试账号（1592363624）
 *   2. 查询血魔剑状态（验证接口可达 + 字段完整性）
 *   3. 验证未持有血魔剑时返回 has_blood_sword=false
 *   4. 测试各接口的参数校验（imprint_type / material_type 白名单）
 *   5. 测试未持有血魔剑时各操作的拒绝逻辑
 *
 * 使用方式：
 *   node server/scripts/test_blood_sword_e2e.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const http = require('http');

// 测试账号配置（来自项目规则）
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';
const BASE_URL = 'http://127.0.0.1:5000';

// 测试结果统计
let passCount = 0;
let failCount = 0;
const failedCases = [];

/**
 * 发起 HTTP 请求（Promise 封装）
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {Object} [body] - 请求体（POST/PUT 时）
 * @param {string} [token] - JWT token
 * @returns {Promise<Object>} 响应对象 { status, body }
 */
function request(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const payload = body ? JSON.stringify(body) : null;
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

        const req = http.request(
            `${BASE_URL}${path}`,
            { method, headers },
            (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = { raw: data }; }
                    resolve({ status: res.statusCode, body: parsed });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * 断言：实际值 === 预期值
 * @param {string} caseName - 测试用例名
 * @param {any} actual - 实际值
 * @param {any} expected - 预期值
 */
function assertEqual(caseName, actual, expected) {
    const ok = actual === expected;
    if (ok) {
        passCount += 1;
        console.log(`  ✓ ${caseName}`);
    } else {
        failCount += 1;
        failedCases.push({ case: caseName, actual, expected });
        console.log(`  ✗ ${caseName}  期望=${JSON.stringify(expected)}  实际=${JSON.stringify(actual)}`);
    }
}

/**
 * 断言：实际值满足条件
 * @param {string} caseName - 测试用例名
 * @param {boolean} condition - 条件
 * @param {string} [detail] - 失败详情
 */
function assertTrue(caseName, condition, detail = '') {
    if (condition) {
        passCount += 1;
        console.log(`  ✓ ${caseName}`);
    } else {
        failCount += 1;
        failedCases.push({ case: caseName, detail });
        console.log(`  ✗ ${caseName}  ${detail}`);
    }
}

/**
 * 主测试流程
 */
async function main() {
    console.log('='.repeat(60));
    console.log('法宝深线血魔剑线端到端测试');
    console.log('='.repeat(60));

    // ====== 步骤 1：登录获取 token ======
    console.log('\n[步骤 1] 登录测试账号');
    const loginRes = await request('POST', '/api/auth/login', {
        username: TEST_ACCOUNT,
        password: TEST_PASSWORD
    });
    assertEqual('登录返回 200', loginRes.status, 200);
    const token = loginRes.body?.body?.token || loginRes.body?.token;
    assertTrue('获取到 token', !!token, `登录响应：${JSON.stringify(loginRes.body).slice(0, 200)}`);
    if (!token) {
        console.log('❌ 无法获取 token，终止测试');
        process.exit(1);
    }

    // ====== 步骤 2：查询血魔剑状态 ======
    console.log('\n[步骤 2] 查询血魔剑状态 GET /api/artifact-deep-line/blood-sword/status');
    const statusRes = await request('GET', '/api/artifact-deep-line/blood-sword/status', null, token);
    assertEqual('状态查询返回 200', statusRes.status, 200);
    assertEqual('响应 code=200', statusRes.body?.code, 200);
    const statusData = statusRes.body?.data;
    assertTrue('返回 data 对象', !!statusData && typeof statusData === 'object', `data=${statusData}`);

    // 字段完整性校验（不论是否持有血魔剑都应有 item_key / config）
    const dataStr = JSON.stringify(statusData) || 'undefined';
    assertTrue('包含 item_key 字段', !!statusData?.item_key, `data=${dataStr.slice(0, 200)}`);
    assertTrue('包含 config 字段', !!statusData?.config, `data=${dataStr.slice(0, 200)}`);
    assertTrue('config 包含 max_stage', typeof statusData?.config?.max_stage === 'number', `config=${JSON.stringify(statusData?.config)}`);
    assertTrue('config 包含 weekly_limit', typeof statusData?.config?.weekly_limit === 'number', `config=${JSON.stringify(statusData?.config)}`);
    assertTrue('config 包含 sacrifice_cooldown_hours', typeof statusData?.config?.sacrifice_cooldown_hours === 'number', `config=${JSON.stringify(statusData?.config)}`);
    assertTrue('config 包含 thunder_wash_cooldown_hours', typeof statusData?.config?.thunder_wash_cooldown_hours === 'number', `config=${JSON.stringify(statusData?.config)}`);
    assertTrue('config 包含 imprint_cooldown_days', typeof statusData?.config?.imprint_cooldown_days === 'number', `config=${JSON.stringify(statusData?.config)}`);
    assertTrue('config 包含 sheath_duration_hours', typeof statusData?.config?.sheath_duration_hours === 'number', `config=${JSON.stringify(statusData?.config)}`);

    // 根据是否持有血魔剑分支验证
    if (statusData.has_blood_sword === true) {
        console.log('\n[步骤 2a] 已持有血魔剑 - 验证完整字段');
        assertEqual('has_blood_sword=true', statusData.has_blood_sword, true);
        assertTrue('包含 equipment_id', typeof statusData.equipment_id === 'number', `equipment_id=${statusData.equipment_id}`);
        assertTrue('包含 slot', typeof statusData.slot === 'string', `slot=${statusData.slot}`);
        assertTrue('包含 blood_pact_stage', typeof statusData.blood_pact_stage === 'number', `stage=${statusData.blood_pact_stage}`);
        assertTrue('包含 blood_pact_stage_name', typeof statusData.blood_pact_stage_name === 'string', `name=${statusData.blood_pact_stage_name}`);
        assertTrue('包含 corruption', typeof statusData.corruption === 'number', `corruption=${statusData.corruption}`);
        assertTrue('包含 suppression', typeof statusData.suppression === 'number', `suppression=${statusData.suppression}`);
        assertTrue('包含 corruption_level', typeof statusData.corruption_level === 'string', `level=${statusData.corruption_level}`);
        assertTrue('包含 imprint_type', typeof statusData.imprint_type === 'string', `imprint_type=${statusData.imprint_type}`);
        assertTrue('包含 is_sheathed', typeof statusData.is_sheathed === 'boolean', `is_sheathed=${statusData.is_sheathed}`);
        assertTrue('包含 sacrifice_cooldown_remaining', typeof statusData.sacrifice_cooldown_remaining === 'number', `remaining=${statusData.sacrifice_cooldown_remaining}`);
        assertTrue('包含 combat_bonus', !!statusData.combat_bonus, `combat_bonus=${JSON.stringify(statusData.combat_bonus)}`);
        assertTrue('combat_bonus 包含 is_active', typeof statusData.combat_bonus?.is_active === 'boolean', `is_active=${statusData.combat_bonus?.is_active}`);
        assertTrue('combat_bonus 包含 atk_bonus_rate', typeof statusData.combat_bonus?.atk_bonus_rate === 'number', `atk_bonus_rate=${statusData.combat_bonus?.atk_bonus_rate}`);

        console.log(`  ℹ 当前血契阶数：${statusData.blood_pact_stage} (${statusData.blood_pact_stage_name})`);
        console.log(`  ℹ 魔染：${statusData.corruption} / ${statusData.corruption_max}（${statusData.corruption_level}）`);
        console.log(`  ℹ 镇契：${statusData.suppression} / ${statusData.suppression_max}`);
        console.log(`  ℹ 铭印：${statusData.imprint_name}`);
        console.log(`  ℹ 封鞘中：${statusData.is_sheathed}`);
    } else {
        console.log('\n[步骤 2a] 未持有血魔剑 - 验证未持有返回字段');
        assertEqual('has_blood_sword=false', statusData.has_blood_sword, false);
        assertTrue('包含 source_hint', typeof statusData.source_hint === 'string', `source_hint=${statusData.source_hint}`);
        assertTrue('包含 min_realm_rank', typeof statusData.min_realm_rank === 'number', `min_realm_rank=${statusData.min_realm_rank}`);
        assertTrue('包含 meets_realm', typeof statusData.meets_realm === 'boolean', `meets_realm=${statusData.meets_realm}`);
        console.log(`  ℹ 获取途径：${statusData.source_hint}`);
        console.log(`  ℹ 境界要求达成：${statusData.meets_realm}`);
    }

    // ====== 步骤 3：参数校验 - material_type 白名单 ======
    console.log('\n[步骤 3] 参数校验 - 雷洗 material_type 白名单');
    const badMaterialRes = await request('POST', '/api/artifact-deep-line/blood-sword/thunder-wash',
        { material_type: 'invalid_type' }, token);
    assertEqual('无效 material_type 返回 400', badMaterialRes.status, 400);
    assertTrue('响应包含 error_code', !!badMaterialRes.body?.error_code, `body=${JSON.stringify(badMaterialRes.body).slice(0, 200)}`);

    const missingMaterialRes = await request('POST', '/api/artifact-deep-line/blood-sword/thunder-wash',
        {}, token);
    assertEqual('缺失 material_type 返回 400', missingMaterialRes.status, 400);

    // ====== 步骤 4：参数校验 - imprint_type 白名单 ======
    console.log('\n[步骤 4] 参数校验 - 铭印 imprint_type 白名单');
    const badImprintRes = await request('POST', '/api/artifact-deep-line/blood-sword/imprint',
        { imprint_type: 'invalid_type' }, token);
    assertEqual('无效 imprint_type 返回 400', badImprintRes.status, 400);

    const missingImprintRes = await request('POST', '/api/artifact-deep-line/blood-sword/imprint',
        {}, token);
    assertEqual('缺失 imprint_type 返回 400', missingImprintRes.status, 400);

    // ====== 步骤 5：业务校验 - 未持有血魔剑时各操作拒绝 ======
    console.log('\n[步骤 5] 业务校验 - 未持有血魔剑时各操作应被拒绝');
    if (statusData.has_blood_sword === false) {
        const sacRes = await request('POST', '/api/artifact-deep-line/blood-sword/sacrifice', {}, token);
        assertEqual('未持有血魔剑祭血被拒绝（400）', sacRes.status, 400);

        const supRes = await request('POST', '/api/artifact-deep-line/blood-sword/suppress', {}, token);
        assertEqual('未持有血魔剑镇契被拒绝（400）', supRes.status, 400);

        const twRes = await request('POST', '/api/artifact-deep-line/blood-sword/thunder-wash',
            { material_type: 'tianlei' }, token);
        assertEqual('未持有血魔剑雷洗被拒绝（400）', twRes.status, 400);

        const impRes = await request('POST', '/api/artifact-deep-line/blood-sword/imprint',
            { imprint_type: 'blood' }, token);
        assertEqual('未持有血魔剑铭印被拒绝（400）', impRes.status, 400);

        const shRes = await request('POST', '/api/artifact-deep-line/blood-sword/sheath', {}, token);
        assertEqual('未持有血魔剑封鞘被拒绝（400）', shRes.status, 400);
    } else {
        console.log('  ℹ 当前已持有血魔剑，跳过未持有拒绝测试');
    }

    // ====== 步骤 6：未鉴权访问应被拒绝 ======
    console.log('\n[步骤 6] 未鉴权访问应被拒绝');
    const noAuthRes = await request('GET', '/api/artifact-deep-line/blood-sword/status');
    assertTrue('未鉴权返回 401 或 403', noAuthRes.status === 401 || noAuthRes.status === 403, `status=${noAuthRes.status}`);

    // ====== 输出测试结果汇总 ======
    console.log('\n' + '='.repeat(60));
    console.log(`测试结果：✓ 通过 ${passCount}  ✗ 失败 ${failCount}`);
    console.log('='.repeat(60));
    if (failedCases.length > 0) {
        console.log('\n失败用例详情：');
        for (const c of failedCases) {
            console.log(`  - ${c.case}: ${c.detail || `actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}`}`);
        }
    }
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试执行异常:', err);
    process.exit(2);
});
