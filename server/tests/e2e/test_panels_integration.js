/**
 * 前端面板接口联调测试脚本
 *
 * 目的：验证「灵兽探渊」和「太一门引道」两个新前端面板所依赖的后端接口
 *       能否正常响应，确保前后端数据契约一致。
 *
 * 测试范围：
 *   1. 灵兽探渊（/api/spirit-beast/abyss）：floors / status / config / ranking / history
 *   2. 太一门引道（/api/taoism-gate）：profile / tasks / ranking / resonance
 *
 * 测试账号：1592363624 / 1592363624（admin，化神初期 rank=23）
 *
 * 运行：node server/scripts/test_panels_integration.js
 */
'use strict';

const http = require('http');

// ==================== 配置 ====================
const HOST = '127.0.0.1';
const PORT = 5000;
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

// ==================== 工具函数 ====================

/**
 * 发送 HTTP 请求
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {object|null} body - 请求体（POST/PUT 时使用）
 * @param {string|null} token - JWT token
 * @returns {Promise<{status:number, body:object}>}
 */
function request(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;

        const payload = body ? JSON.stringify(body) : null;
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

        const req = http.request(
            { host: HOST, port: PORT, path, method, headers },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = data; }
                    resolve({ status: res.statusCode, body: parsed });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** 简单断言 */
function assert(condition, message) {
    if (!condition) throw new Error(`❌ 断言失败: ${message}`);
    console.log(`  ✅ ${message}`);
}

/** 测试结果计数 */
let passCount = 0;
let failCount = 0;
async function runStep(name, fn) {
    try {
        console.log(`\n[步骤] ${name}`);
        await fn();
        passCount++;
    } catch (e) {
        console.error(`  ❌ ${e.message}`);
        failCount++;
    }
}

/**
 * 调试工具：打印响应结构（用于排查字段路径）
 * @param {string} label - 标签
 * @param {object} body - 响应体
 */
function debugResp(label, body) {
    console.log(`  🔍 [DEBUG ${label}]`, JSON.stringify(body, null, 2).slice(0, 800));
}

// ==================== 主流程 ====================

async function main() {
    console.log('====================================');
    console.log('  前端面板接口联调测试');
    console.log('  灵兽探渊 + 太一门引道');
    console.log('====================================');

    // ---------- 登录 ----------
    let token = null;
    await runStep('登录测试账号', async () => {
        const resp = await request('POST', '/api/auth/login', {
            username: TEST_ACCOUNT,
            password: TEST_PASSWORD
        });
        assert(resp.status === 200, `登录 HTTP 200（实际 ${resp.status}）`);
        // 登录接口 token 直接在顶层，player 信息在 body.player
        assert(resp.body && resp.body.token, '登录返回 token');
        token = resp.body.token;
        console.log(`  ℹ️  玩家: ${resp.body.player?.nickname} | 境界: ${resp.body.player?.realm} | 角色: ${resp.body.player?.role}`);
    });

    if (!token) {
        console.error('\n❌ 登录失败，终止测试');
        process.exit(1);
    }

    // ==================== 灵兽探渊接口测试 ====================
    console.log('\n--- 灵兽探渊（/api/spirit-beast/abyss） ---');

    await runStep('GET /floors - 获取可用层数', async () => {
        const resp = await request('GET', '/api/spirit-beast/abyss/floors', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data && Array.isArray(data.floors), '返回 floors 数组');
        console.log(`  ℹ️  可用层数: ${data.floors.length} | 同时探渊上限: ${data.max_concurrent_beasts} | 每日次数: ${data.daily_explore_limit}`);
        if (data.floors.length > 0) {
            const f = data.floors[0];
            console.log(`  ℹ️  示例: 第${f.floor}层 ${f.name} (境界要求: ${f.required_realm_rank})`);
        }
    });

    await runStep('GET /status - 获取当前探渊状态', async () => {
        const resp = await request('GET', '/api/spirit-beast/abyss/status', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data && Array.isArray(data.active_explores), '返回 active_explores 数组');
        console.log(`  ℹ️  当前探渊中: ${data.active_explores.length} 只灵兽`);
    });

    await runStep('GET /config - 获取探渊配置', async () => {
        const resp = await request('GET', '/api/spirit-beast/abyss/config', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data && data.abyss, '返回 abyss 配置对象');
        assert(data.abyss.total_floors > 0, `total_floors > 0（实际 ${data.abyss.total_floors}）`);
        // event_types 可能是对象而非数组，打印实际结构
        if (!Array.isArray(data.event_types)) {
            debugResp('event_types 实际结构', data.event_types);
        }
        assert(data.event_types, '返回 event_types 字段');
        console.log(`  ℹ️  总层数: ${data.abyss.total_floors} | 体力上限: ${data.abyss.stamina_max} | 每次消耗: ${data.abyss.stamina_per_explore}`);
        console.log(`  ℹ️  事件类型: ${JSON.stringify(data.event_types).slice(0, 200)}`);
    });

    await runStep('GET /ranking?category=deepest_floor - 探渊排行榜', async () => {
        const resp = await request('GET', '/api/spirit-beast/abyss/ranking?category=deepest_floor&page=1&page_size=10', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data && Array.isArray(data.ranking), '返回 ranking 数组');
        console.log(`  ℹ️  排行榜人数: ${data.ranking.length} | 类别: ${data.category}`);
    });

    await runStep('GET /history - 探渊历史', async () => {
        const resp = await request('GET', '/api/spirit-beast/abyss/history?page=1&page_size=5', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data && Array.isArray(data.history), '返回 history 数组');
        console.log(`  ℹ️  历史记录数: ${data.history.length} | 总数: ${data.total || 'N/A'}`);
    });

    // ==================== 太一门引道接口测试 ====================
    console.log('\n--- 太一门引道（/api/taoism-gate） ---');

    await runStep('GET /profile - 获取道途面板', async () => {
        const resp = await request('GET', '/api/taoism-gate/profile', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data, '返回 data 对象');
        console.log(`  ℹ️  当前道途: ${data.dao_path || '未选择'} | 等级: ${data.dao_level || 0} | 神识: ${data.divine_sense || 0}`);
        if (data.skills) console.log(`  ℹ️  技能数: ${data.skills.length}`);
    });

    await runStep('GET /tasks - 获取今日任务', async () => {
        const resp = await request('GET', '/api/taoism-gate/tasks', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data, '返回 data 对象');
        const tasks = data.tasks || [];
        console.log(`  ℹ️  今日任务数: ${tasks.length}`);
        if (tasks.length > 0) {
            console.log(`  ℹ️  示例任务: ${tasks[0].description || tasks[0].name} (进度 ${tasks[0].progress || 0}/${tasks[0].target || '?'})`);
        }
    });

    await runStep('GET /ranking?category=dao_level - 道途排行榜', async () => {
        const resp = await request('GET', '/api/taoism-gate/ranking?category=dao_level&page=1&page_size=10', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        // ranking 可能是对象，打印实际结构
        if (!data || !Array.isArray(data.ranking)) {
            debugResp('ranking 响应实际结构', data);
        }
        assert(data, '返回 data 对象');
        console.log(`  ℹ️  响应字段: ${Object.keys(data || {}).join(', ')}`);
        const ranking = data?.ranking || data?.list || [];
        console.log(`  ℹ️  排行榜人数: ${ranking.length} | 类别: ${data?.category || 'N/A'}`);
    });

    await runStep('GET /resonance - 查询共鸣状态', async () => {
        const resp = await request('GET', '/api/taoism-gate/resonance', null, token);
        assert(resp.status === 200, `HTTP 200（实际 ${resp.status}）`);
        assert(resp.body && resp.body.code === 200, `code=200（实际 ${resp.body?.code}）`);
        const data = resp.body.data;
        assert(data, '返回 data 对象');
        console.log(`  ℹ️  同道途玩家数: ${data.same_path_count || 0} | 共鸣加成: ${data.resonance_bonus || 0}`);
    });

    // ==================== 测试结果汇总 ====================
    console.log('\n====================================');
    console.log('  测试结果汇总');
    console.log('====================================');
    console.log(`  ✅ 通过: ${passCount}`);
    console.log(`  ❌ 失败: ${failCount}`);
    const total = passCount + failCount;
    console.log(`  总计: ${total} | 通过率: ${total > 0 ? Math.round((passCount / total) * 100) : 0}%`);
    console.log('====================================\n');

    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
