/**
 * 灵兽系统 9 接口端到端连通性测试脚本（运行时版）
 *
 * 测试目标：验证灵兽系统 9 个 HTTP 接口的端到端连通性
 * 测试账号：1592363624 / 1592363624
 * 服务地址：http://localhost:5000
 *
 * 测试流程：
 *   0. POST /api/auth/login                 - 登录获取 token（token 在响应顶层）
 *   1. GET  /api/spirit-beast/types         - 灵兽图鉴
 *   2. GET  /api/spirit-beast/list          - 我的灵兽列表
 *   3. GET  /api/spirit-beast/daily-status   - 今日捕获次数
 *   4. POST /api/spirit-beast/catch          - 捕获灵兽 { beast_key: "qingyun_wolf" }
 *   5. GET  /api/spirit-beast/:beastId       - 灵兽详情
 *   6. POST /api/spirit-beast/:beastId/feed  - 喂养灵兽
 *   7. POST /api/spirit-beast/:beastId/interact - 互动灵兽
 *   8. POST /api/spirit-beast/:beastId/set-active - 设置出战
 *   9. POST /api/spirit-beast/:beastId/release - 放生灵兽（仅做参数校验测试，避免销毁灵兽）
 *
 * 实现要求：
 *   - 仅使用 Node.js 内置 fetch（Node 18+），不依赖 axios
 *   - 对每个接口输出 HTTP 状态码 + 关键字段
 *   - 测试中如发生 catch 失败（如已捕获过），记录错误但继续测试其他接口
 *   - 输出汇总表（9 个接口的通过/失败状态）
 *
 * 运行方式：node server/scripts/test_spirit_beast_runtime.js
 */

'use strict';

// ============== 测试常量配置 ==============
const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';
const CATCH_BEAST_KEY = 'qingyun_wolf'; // 青云狼，捕获率 60%，最易测试
const REQUEST_TIMEOUT_MS = 15000; // 单请求超时 15s

// ============== 全局状态 ==============
let token = ''; // 登录令牌
let firstBeastId = null; // 用于详情/喂养/互动/出战的灵兽 ID
const results = []; // 收集每个接口测试结果，用于最终汇总

// ============== 工具函数 ==============

/**
 * 带超时的 fetch 封装
 * Node 内置 fetch 本身无超时机制，使用 AbortController 实现
 * @param {string} url - 完整请求 URL
 * @param {Object} options - fetch 配置项
 * @returns {Promise<Object>} { status, body, ok }
 */
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        // 尝试解析 JSON，失败则保留原始文本
        const text = await res.text();
        let body = null;
        try {
            body = JSON.parse(text);
        } catch (_) {
            body = { _rawText: text.slice(0, 500) };
        }
        return { status: res.status, ok: res.ok, body };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 构造请求头（带 Authorization）
 * @returns {Object} 包含 Content-Type 与 Authorization 的请求头
 */
function buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/**
 * 统一调用接口并打印结果
 * @param {string} index - 测试序号（用于汇总表）
 * @param {string} name - 接口名称
 * @param {string} method - HTTP 方法
 * @param {string} path - 接口路径（相对 BASE_URL）
 * @param {Object|null} bodyObj - 请求体对象（POST 才需要）
 * @param {Function|null} inspectFn - 用于从响应中提取关键字段的回调 (body) => string
 * @returns {Promise<Object>} { success, status, body, error }
 */
async function callApi(index, name, method, path, bodyObj = null, inspectFn = null) {
    const url = `${BASE_URL}${path}`;
    const options = {
        method,
        headers: buildHeaders()
    };
    if (bodyObj && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.body = JSON.stringify(bodyObj);
    }

    console.log(`\n────────────────────────────────────────────────────────────`);
    console.log(`[${index}] ${method} ${path}`);
    console.log(`    名称：${name}`);
    if (bodyObj) console.log(`    请求体：${JSON.stringify(bodyObj)}`);

    try {
        const { status, ok, body } = await fetchWithTimeout(url, options);
        // 业务成功判定：HTTP 200 + body.success !== false + body.code 不是 4xx/5xx
        const bizSuccess = body && body.success !== false && !(body.code && body.code >= 400);
        const passed = ok && bizSuccess;
        const inspectText = inspectFn ? inspectFn(body) : '';

        console.log(`    HTTP 状态：${status}`);
        if (body) {
            // 截断过长 body 输出
            const bodyStr = JSON.stringify(body);
            console.log(`    响应：${bodyStr.length > 800 ? bodyStr.slice(0, 800) + '...(已截断)' : bodyStr}`);
        }
        if (inspectText) console.log(`    关键信息：${inspectText}`);
        console.log(`    结果：${passed ? '✓ 通过' : '✗ 失败'}`);

        const result = { index, name, method, path, status, passed, body, inspectText };
        results.push(result);
        return result;
    } catch (err) {
        const errMsg = err.name === 'AbortError' ? `请求超时（>${REQUEST_TIMEOUT_MS}ms）` : err.message;
        console.log(`    HTTP 状态：-`);
        console.log(`    异常：${errMsg}`);
        console.log(`    结果：✗ 失败`);
        const result = { index, name, method, path, status: 0, passed: false, error: errMsg };
        results.push(result);
        return result;
    }
}

/**
 * 从响应体提取简短展示信息
 * 各接口字段不同，按需定制提取逻辑
 */
const inspectors = {
    // 登录：返回 token 前缀 + 玩家昵称
    login: (b) => b?.token ? `token=${String(b.token).slice(0, 20)}... | 玩家=${b.player?.nickname} | 境界=${b.player?.realm}` : '无 token',
    // 灵兽图鉴：返回种类数量
    types: (b) => `灵兽种类数=${b?.data?.beast_types?.length ?? 0} | 已捕获种类=${b?.data?.beast_types?.filter(x => x.caught).length ?? 0}`,
    // 我的灵兽列表：返回灵兽数量 + 第一只灵兽 ID
    list: (b) => {
        const beasts = b?.data?.beasts || [];
        return `灵兽数量=${beasts.length}${beasts[0] ? ` | 首只 ID=${beasts[0].id} 名=${beasts[0].display_name}` : ''}`;
    },
    // 今日捕获状态：今日次数/上限/剩余
    dailyStatus: (b) => `今日已捕=${b?.data?.today_catches ?? '?'} / 上限=${b?.data?.daily_limit ?? '?'} | 剩余=${b?.data?.remaining ?? '?'} | 容量=${b?.data?.max_beasts ?? '?'}`,
    // 捕获：是否成功 + 灵兽 ID
    catch: (b) => {
        if (b?.data?.caught) return `捕获成功！灵兽ID=${b.data.beast_id} 名称=${b.data.beast?.display_name ?? ''}`;
        return `捕获失败（success=${b?.success}）| 原因=${b?.message ?? '未知'}`;
    },
    // 灵兽详情：灵兽名 + 等级 + 战力
    detail: (b) => `灵兽=${b?.data?.display_name ?? b?.data?.name ?? '?'} | Lv.${b?.data?.level ?? '?'} | ★${b?.data?.star_level ?? '?'} | 战力=${b?.data?.combat_power ?? '?'}`,
    // 喂养：是否成功 + 等级/经验变化
    feed: (b) => b?.success !== false ? `喂养成功 | Lv.${b?.data?.level ?? '?'} | 经验=${b?.data?.exp ?? '?'}/${b?.data?.exp_cap ?? '?'} | 忠诚=${b?.data?.loyalty ?? '?'}` : `喂养失败：${b?.message}`,
    // 互动：是否成功 + 忠诚度变化
    interact: (b) => b?.success !== false ? `互动成功 | 忠诚=${b?.data?.loyalty ?? '?'} | 经验=${b?.data?.exp ?? '?'}` : `互动失败：${b?.message}`,
    // 设置出战：是否成功
    setActive: (b) => b?.success !== false ? `出战设置成功 | 当前出战=${b?.data?.active_beast_id ?? '?'}` : `出战失败：${b?.message}`,
    // 放生（参数校验）：预期返回 400 验证错误
    release: (b) => `参数校验测试：status=${b?.code ?? '?'} | error_code=${b?.error_code ?? '?'} | msg=${b?.message ?? '?'}`
};

// ============== 主测试流程 ==============

async function main() {
    console.log('═'.repeat(60));
    console.log('  灵兽系统 9 接口端到端连通性测试');
    console.log('═'.repeat(60));
    console.log(`测试时间：${new Date().toLocaleString('zh-CN')}`);
    console.log(`服务地址：${BASE_URL}`);
    console.log(`测试账号：${TEST_ACCOUNT}`);

    // ===== 步骤 0：登录 =====
    console.log('\n\n[0/9] 登录获取 token...');
    const loginRes = await callApi('0', '登录', 'POST', '/auth/login', {
        username: TEST_ACCOUNT,
        password: TEST_PASSWORD
    }, inspectors.login);

    if (!loginRes.passed || !loginRes.body?.token) {
        console.log('\n✗ 登录失败，后续测试无法继续。');
        printSummary();
        return;
    }
    token = loginRes.body.token;
    console.log(`\n  → 登录成功，token 已保存，长度=${token.length}`);

    // ===== 步骤 1：GET /types - 灵兽图鉴 =====
    await callApi('1', '灵兽图鉴', 'GET', '/spirit-beast/types', null, inspectors.types);

    // ===== 步骤 2：GET /list - 我的灵兽列表 =====
    const listRes = await callApi('2', '我的灵兽列表', 'GET', '/spirit-beast/list', null, inspectors.list);
    // 从列表中获取第一只灵兽 ID（用于后续详情/喂养/互动/出战）
    const beasts = listRes.body?.data?.beasts || [];
    if (beasts.length > 0) {
        firstBeastId = beasts[0].id;
        console.log(`  → 已记录第一只灵兽 ID=${firstBeastId}，用于后续接口测试`);
    }

    // ===== 步骤 3：GET /daily-status - 今日捕获状态 =====
    await callApi('3', '今日捕获状态', 'GET', '/spirit-beast/daily-status', null, inspectors.dailyStatus);

    // ===== 步骤 4：POST /catch - 捕获灵兽 =====
    const catchRes = await callApi('4', '捕获灵兽（青云狼）', 'POST', '/spirit-beast/catch', {
        beast_key: CATCH_BEAST_KEY
    }, inspectors.catch);

    // 若捕获成功，更新 firstBeastId 为新捕获灵兽（更可靠）
    if (catchRes.body?.data?.caught && catchRes.body.data.beast_id) {
        firstBeastId = catchRes.body.data.beast_id;
        console.log(`  → 捕获成功！使用新灵兽 ID=${firstBeastId} 进行后续测试`);
    } else {
        // 捕获失败（可能已捕获过、概率失败、灵力不足等），重试一次
        console.log(`  → 首次捕获未成功（${catchRes.body?.message ?? '原因未知'}），重试一次...`);
        const retryRes = await callApi('4', '捕获灵兽（重试）', 'POST', '/spirit-beast/catch', {
            beast_key: CATCH_BEAST_KEY
        }, inspectors.catch);
        if (retryRes.body?.data?.caught && retryRes.body.data.beast_id) {
            firstBeastId = retryRes.body.data.beast_id;
            console.log(`  → 重试成功！使用新灵兽 ID=${firstBeastId} 进行后续测试`);
        }
    }

    // 若捕获都失败，且列表也没灵兽，则详情/喂养等接口无法测试
    if (!firstBeastId) {
        console.log('\n  ⚠ 未获取到任何灵兽 ID，详情/喂养/互动/出战接口将使用无效 ID 测试（预期失败）');
    }

    // ===== 步骤 5：GET /:beastId - 灵兽详情 =====
    const detailId = firstBeastId || 1; // 无灵兽时用 1 测试，预期失败
    await callApi('5', '灵兽详情', 'GET', `/spirit-beast/${detailId}`, null, inspectors.detail);

    // 若仍无灵兽 ID，跳过 6/7/8 的实战测试（改测参数校验）
    if (!firstBeastId) {
        console.log('\n  ⚠ 无可用灵兽，对 6/7/8 接口仅做参数校验测试（beastId=0 预期返回 400）');
        // 用 beastId=0 测试参数校验
        await callApi('6', '喂养（参数校验 beastId=0）', 'POST', '/spirit-beast/0/feed', {}, inspectors.release);
        await callApi('7', '互动（参数校验 beastId=0）', 'POST', '/spirit-beast/0/interact', {}, inspectors.release);
        await callApi('8', '出战（参数校验 beastId=0）', 'POST', '/spirit-beast/0/set-active', {}, inspectors.release);
    } else {
        // ===== 步骤 6：POST /:beastId/feed - 喂养 =====
        await callApi('6', '喂养灵兽', 'POST', `/spirit-beast/${firstBeastId}/feed`, {}, inspectors.feed);

        // ===== 步骤 7：POST /:beastId/interact - 互动 =====
        await callApi('7', '互动灵兽', 'POST', `/spirit-beast/${firstBeastId}/interact`, {}, inspectors.interact);

        // ===== 步骤 8：POST /:beastId/set-active - 设置出战 =====
        await callApi('8', '设置出战', 'POST', `/spirit-beast/${firstBeastId}/set-active`, {}, inspectors.setActive);
    }

    // ===== 步骤 9：POST /:beastId/release - 放生（仅参数校验）=====
    // 用 beastId=0 测试参数校验，避免销毁真实灵兽
    await callApi('9', '放生灵兽（参数校验 beastId=0）', 'POST', '/spirit-beast/0/release', {}, inspectors.release);

    // ===== 输出汇总 =====
    printSummary();
}

/**
 * 打印最终汇总表
 */
function printSummary() {
    console.log('\n\n' + '═'.repeat(60));
    console.log('  灵兽系统 9 接口测试汇总');
    console.log('═'.repeat(60));

    // 表头
    console.log('┌─────┬──────────────────────────────────────┬────────┬──────────┐');
    console.log('│ 序号│ 接口名称                              │ HTTP   │ 结果     │');
    console.log('├─────┼──────────────────────────────────────┼────────┼──────────┤');

    // 跳过登录（序号 0），只统计 1-9 的灵兽接口
    const apiResults = results.filter(r => r.index !== '0');
    let passCount = 0;
    let failCount = 0;

    for (const r of apiResults) {
        const idx = r.index.padEnd(3, ' ');
        // 截断接口名称为 36 字符宽
        const name = (r.name.length > 36 ? r.name.slice(0, 34) + '..' : r.name).padEnd(36, '　'); // 中文用全角空格补齐
        const status = String(r.status || '-').padEnd(6, ' ');
        const result = (r.passed ? '✓ 通过' : '✗ 失败').padEnd(8, ' ');
        console.log(`│ ${idx} │ ${name} │ ${status} │ ${result} │`);
        if (r.passed) passCount++;
        else failCount++;
    }

    console.log('└─────┴──────────────────────────────────────┴────────┴──────────┘');
    console.log(`\n  总计：${apiResults.length} 个接口 | 通过：${passCount} | 失败：${failCount}`);

    // 失败详情
    const failed = apiResults.filter(r => !r.passed);
    if (failed.length > 0) {
        console.log('\n  ─── 失败接口详情 ───');
        for (const f of failed) {
            console.log(`\n  [${f.index}] ${f.method} ${f.path}`);
            console.log(`      名称：${f.name}`);
            console.log(`      HTTP：${f.status || '-'}`);
            if (f.body) {
                const bodyStr = JSON.stringify(f.body);
                console.log(`      响应：${bodyStr.length > 500 ? bodyStr.slice(0, 500) + '...(已截断)' : bodyStr}`);
            }
            if (f.error) {
                console.log(`      异常：${f.error}`);
            }
        }
    }

    console.log('\n' + '═'.repeat(60));
    console.log('  测试完成');
    console.log('═'.repeat(60));
}

// 执行主流程
main().catch(err => {
    console.error('\n测试执行失败:', err);
    process.exit(1);
});
