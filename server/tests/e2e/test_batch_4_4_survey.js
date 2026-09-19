/**
 * 批次4-4 多人玩法系统调研测试
 *
 * 目的：
 *   验证三大多人玩法系统（道侣/多人副本/宗门特色）的核心接口是否真的可用，
 *   识别未实现/有 bug 的功能点，为后续修复与测试编写提供依据。
 *
 * 测试范围：
 *   1. 道侣系统：GET /api/dao-companion/my（查询当前道侣关系）
 *   2. 多人副本：GET /api/multi-dungeon/help（查询副本规则说明）
 *   3. 宗门特色：GET /api/sect-special/info（查询当前宗门特色信息）
 *
 * 不修改任何业务数据，只读验证。
 */
const BASE = 'http://localhost:5000';

// 测试账号
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

// 简易 fetch 封装
async function api(method, path, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

// 测试结果收集
const results = [];
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
    console.log('========================================');
    console.log('  批次4-4 多人玩法系统调研测试');
    console.log('========================================\n');

    // 1. 登录获取 token
    console.log('[1] 登录测试账号');
    const loginRes = await api('POST', '/api/auth/login', null, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    check('登录应返回 200', loginRes.status === 200, `actual=${loginRes.status}`);
    const token = loginRes.json?.token;
    check('应返回 token', !!token);
    if (!token) {
        console.log('❌ 无法获取 token，终止测试');
        process.exit(1);
    }
    console.log('');

    // 2. 道侣系统
    console.log('[2] 道侣系统：GET /api/dao-companion/my');
    try {
        const r = await api('GET', '/api/dao-companion/my', token);
        check('dao-companion/my 应返回 200', r.status === 200, `actual=${r.status}, msg=${r.json?.message || ''}`);
        check('dao-companion/my 应返回 code 字段', r.json?.code !== undefined);
        if (r.json?.data) {
            console.log('  道侣数据字段:', Object.keys(r.json.data).join(', '));
        }
    } catch (e) {
        check('dao-companion/my 接口不报错', false, e.message);
    }
    console.log('');

    // 3. 道侣求婚列表
    console.log('[3] 道侣系统：GET /api/dao-companion/proposals');
    try {
        const r = await api('GET', '/api/dao-companion/proposals', token);
        check('dao-companion/proposals 应返回 200', r.status === 200, `actual=${r.status}`);
    } catch (e) {
        check('dao-companion/proposals 接口不报错', false, e.message);
    }
    console.log('');

    // 4. 多人副本
    console.log('[4] 多人副本：GET /api/multi-dungeon/help');
    try {
        const r = await api('GET', '/api/multi-dungeon/help', token);
        check('multi-dungeon/help 应返回 200', r.status === 200, `actual=${r.status}, msg=${r.json?.message || ''}`);
        if (r.json?.data?.dungeons) {
            const keys = Object.keys(r.json.data.dungeons);
            check('multi-dungeon/help 应返回副本列表', keys.length > 0, `dungeons=${keys.join(',')}`);
        } else {
            check('multi-dungeon/help 应返回 dungeons 字段', false, `实际返回: ${JSON.stringify(r.json).slice(0, 200)}`);
        }
    } catch (e) {
        check('multi-dungeon/help 接口不报错', false, e.message);
    }
    console.log('');

    // 5. 多人副本状态
    console.log('[5] 多人副本：GET /api/multi-dungeon/status');
    try {
        const r = await api('GET', '/api/multi-dungeon/status', token);
        check('multi-dungeon/status 应返回 200', r.status === 200, `actual=${r.status}`);
    } catch (e) {
        check('multi-dungeon/status 接口不报错', false, e.message);
    }
    console.log('');

    // 6. 多人副本奖励列表
    console.log('[6] 多人副本：GET /api/multi-dungeon/rewards');
    try {
        const r = await api('GET', '/api/multi-dungeon/rewards', token);
        check('multi-dungeon/rewards 应返回 200', r.status === 200, `actual=${r.status}`);
    } catch (e) {
        check('multi-dungeon/rewards 接口不报错', false, e.message);
    }
    console.log('');

    // 7. 宗门特色
    console.log('[7] 宗门特色：GET /api/sect-special/info');
    try {
        const r = await api('GET', '/api/sect-special/info', token);
        check('sect-special/info 应返回 200', r.status === 200, `actual=${r.status}, msg=${r.json?.message || ''}`);
        if (r.json?.data) {
            console.log('  宗门特色数据字段:', Object.keys(r.json.data).join(', '));
        }
    } catch (e) {
        check('sect-special/info 接口不报错', false, e.message);
    }
    console.log('');

    // 8. 宗门特色子接口（树/星/命/阶/魔/炉）
    const subApis = [
        '/api/sect-special/tree',
        '/api/sect-special/star',
        '/api/sect-special/fate',
        '/api/sect-special/stairs',
        '/api/sect-special/dark-arts',
        '/api/sect-special/furnace'
    ];
    console.log('[8] 宗门特色 6 大子系统查询接口');
    for (const p of subApis) {
        try {
            const r = await api('GET', p, token);
            check(`${p} 应返回 200`, r.status === 200, `actual=${r.status}, msg=${r.json?.message || ''}`);
        } catch (e) {
            check(`${p} 接口不报错`, false, e.message);
        }
    }
    console.log('');

    // 9. 护道日志
    console.log('[9] 道侣护道：GET /api/dao-companion/protect-logs');
    try {
        const r = await api('GET', '/api/dao-companion/protect-logs', token);
        check('protect-logs 应返回 200', r.status === 200, `actual=${r.status}`);
    } catch (e) {
        check('protect-logs 接口不报错', false, e.message);
    }
    console.log('');

    // 汇总
    console.log('========================================');
    console.log('  调研测试结果汇总');
    console.log('========================================');
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    console.log(`  通过: ${passed} / ${total}`);
    console.log(`  失败: ${total - passed} / ${total}`);
    console.log(`  成功率: ${(passed / total * 100).toFixed(1)}%\n`);

    // 输出失败项明细
    const failed = results.filter(r => !r.pass);
    if (failed.length > 0) {
        console.log('失败项明细：');
        failed.forEach(f => console.log(`  ❌ ${f.name} | ${f.detail}`));
    }

    process.exit(failed.length === 0 ? 0 : 1);
})();
