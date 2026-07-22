/**
 * 端到端测试：避世/入世 PVP 模式切换
 *
 * 测试目标（玩法文档第17节：避世/入世）：
 *   1. 静态代码扫描：后端 Service 层、路由层、前端 API/UI、OpenAPI 文档同步
 *   2. 接口可用性：GET/POST /api/pvp/mode
 *   3. GET /api/pvp/status 返回 pvp_mode 字段
 *   4. 切换为避世后：PVP 挑战/决斗/封神台挑战均被拒绝
 *   5. 切换回入世后：所有 PVP 玩法恢复正常
 *   6. 边界场景：未鉴权、无效 mode、空 body
 *   7. 数据还原：测试结束后玩家 pvp_mode 恢复为 active
 *
 * 运行方式：node scripts/test_pvp_mode_e2e.js
 *
 * 测试账号：1592363624 / 1592363624（玩家ID=1）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// ============ 配置 ============
const CONFIG = {
    host: '127.0.0.1',
    port: 5000,
    account: '1592363624',
    password: '1592363624'
};

// ============ 测试结果统计 ============
const results = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: []
};

/**
 * 记录单条测试结果
 * @param {string} name - 测试名
 * @param {boolean} pass - 是否通过
 * @param {string} [detail] - 失败详情
 */
function record(name, pass, detail) {
    results.total++;
    if (pass) {
        results.passed++;
        console.log(`  ✅ ${name}`);
    } else {
        results.failed++;
        results.failures.push({ name, detail: detail || '' });
        console.log(`  ❌ ${name}`);
        if (detail) console.log(`     → ${detail}`);
    }
}

/**
 * 跳过测试（不计入失败）
 */
function skip(name, reason) {
    results.total++;
    results.skipped++;
    console.log(`  ⏭️  ${name}（跳过：${reason}）`);
}

// ============ HTTP 请求工具 ============
/**
 * 发送 HTTP 请求
 * @param {Object} opts - { method, path, headers, body }
 * @returns {Promise<{status:number, body:Object, raw:string}>}
 */
function request(opts) {
    return new Promise((resolve, reject) => {
        const bodyStr = opts.body ? JSON.stringify(opts.body) : null;
        const headers = { ...opts.headers };
        if (bodyStr) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        const req = http.request({
            hostname: CONFIG.host,
            port: CONFIG.port,
            path: opts.path,
            method: opts.method,
            headers
        }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                let body = null;
                try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = raw; }
                resolve({ status: res.statusCode, body, raw });
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

/** 登录并返回 JWT */
async function login() {
    const res = await request({
        method: 'POST',
        path: '/api/auth/login',
        body: { username: CONFIG.account, password: CONFIG.password }
    });
    // 登录响应 token 可能位于 body.token 或 body.data.token（兼容不同版本）
    const token = res.body?.token || res.body?.data?.token;
    if (res.status !== 200 || !token) {
        throw new Error(`登录失败：status=${res.status}, body=${JSON.stringify(res.body).slice(0, 300)}`);
    }
    return token;
}

/** 构造鉴权头 */
function authHeader(token) {
    return { 'Authorization': `Bearer ${token}` };
}

// ============ 主测试流程 ============
async function main() {
    console.log('\n========================================');
    console.log('  避世/入世 PVP 模式 端到端测试');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 后端 PvpService =====
    console.log('【场景1】静态代码扫描 - PvpService.setPvpMode/getPvpMode');
    const pvpServicePath = path.join(__dirname, '../game/services/PvpService.js');
    const pvpServiceCode = fs.readFileSync(pvpServicePath, 'utf-8');
    record('PvpService.setPvpMode 方法已定义', /static\s+async\s+setPvpMode\s*\(/.test(pvpServiceCode));
    record('PvpService.getPvpMode 方法已定义', /static\s+async\s+getPvpMode\s*\(/.test(pvpServiceCode));
    record('PvpService.challenge 校验 attacker.pvp_mode', pvpServiceCode.includes("attacker.pvp_mode === 'recluse'"));
    record('PvpService.challenge 校验 defender.pvp_mode', pvpServiceCode.includes("defender.pvp_mode === 'recluse'"));
    record('PvpService.getStatus 返回 pvp_mode 字段', /pvp_mode:\s*player\.pvp_mode\s*\|\|\s*'active'/.test(pvpServiceCode));
    record('PvpService.getStatus 返回 pvp_mode_name 字段', pvpServiceCode.includes("pvp_mode_name: (player.pvp_mode === 'recluse') ? '避世' : '入世'"));

    // ===== 场景2：静态代码扫描 - 路由层 =====
    console.log('\n【场景2】静态代码扫描 - routes/pvp.js');
    const pvpRoutePath = path.join(__dirname, '../routes/pvp.js');
    const pvpRouteCode = fs.readFileSync(pvpRoutePath, 'utf-8');
    record("POST /api/pvp/mode 路由已挂载", /router\.post\('\/mode'/.test(pvpRouteCode));
    record("GET /api/pvp/mode 路由已挂载", /router\.get\('\/mode'/.test(pvpRouteCode));
    record('GET /api/pvp/mode 调用 PvpService.getPvpMode', pvpRouteCode.includes('PvpService.getPvpMode(req.player.id)'));

    // ===== 场景3：静态代码扫描 - 前端 API =====
    console.log('\n【场景3】静态代码扫描 - 前端 pvp.ts');
    const pvpApiPath = path.join(__dirname, '../../client/src/api/pvp.ts');
    if (fs.existsSync(pvpApiPath)) {
        const pvpApiCode = fs.readFileSync(pvpApiPath, 'utf-8');
        record("前端 setPvpMode API 已导出", /export\s+const\s+setPvpMode\s*=/.test(pvpApiCode));
        record("前端 getPvpMode API 已导出", /export\s+const\s+getPvpMode\s*=/.test(pvpApiCode));
        record("PvpModeType 类型已定义", /export\s+type\s+PvpModeType\s*=/.test(pvpApiCode));
        record("PvpModeInfo 接口已定义", /export\s+interface\s+PvpModeInfo/.test(pvpApiCode));
    } else {
        skip('前端 pvp.ts 静态扫描', '文件不存在');
    }

    // ===== 场景4：静态代码扫描 - 前端 PvpPanel.vue =====
    console.log('\n【场景4】静态代码扫描 - 前端 PvpPanel.vue');
    const pvpPanelPath = path.join(__dirname, '../../client/src/components/panels/PvpPanel.vue');
    if (fs.existsSync(pvpPanelPath)) {
        const pvpPanelCode = fs.readFileSync(pvpPanelPath, 'utf-8');
        record('PvpPanel 引入 setPvpMode', /import\s*\{[^}]*setPvpMode[^}]*\}\s*from\s*'\.\.\/\.\.\/api\/pvp'/.test(pvpPanelCode) ||
            pvpPanelCode.includes('setPvpMode'));
        record('PvpPanel 有避世/入世模式卡 UI', pvpPanelCode.includes('避世/入世模式卡') || pvpPanelCode.includes('isRecluseMode'));
        record('PvpPanel 有切换按钮', pvpPanelCode.includes('openPvpModeConfirm'));
        record('PvpPanel 有 Modal 二次确认', pvpPanelCode.includes('pvpModeConfirmShow'));
        record('PvpPanel 有 confirmSwitchPvpMode 方法', pvpPanelCode.includes('confirmSwitchPvpMode'));
    } else {
        skip('前端 PvpPanel.vue 静态扫描', '文件不存在');
    }

    // ===== 场景5：静态代码扫描 - 5 个 Service 的避世校验 =====
    console.log('\n【场景5】静态代码扫描 - 多 Service 避世校验集成');
    const servicesToCheck = [
        { name: 'PvpService', file: 'game/services/PvpService.js', keyword: "pvp_mode === 'recluse'" },
        { name: 'DuelService', file: 'game/services/DuelService.js', keyword: "pvp_mode !== 'active'" },
        { name: 'FengshenService', file: 'game/services/FengshenService.js', keyword: "pvp_mode !== 'active'" },
        { name: 'BountyService', file: 'game/services/BountyService.js', keyword: "target.pvp_mode !== 'active'" },
        { name: 'TaoismGateService', file: 'game/services/TaoismGateService.js', keyword: "pvp_mode === 'recluse'" }
    ];
    for (const svc of servicesToCheck) {
        const filePath = path.join(__dirname, '..', svc.file);
        if (fs.existsSync(filePath)) {
            const code = fs.readFileSync(filePath, 'utf-8');
            record(`${svc.name} 集成 pvp_mode 校验`, code.includes(svc.keyword));
        } else {
            skip(`${svc.name} 静态扫描`, '文件不存在');
        }
    }

    // ===== 场景6：静态代码扫描 - Player 模型 pvp_mode 字段 =====
    console.log('\n【场景6】静态代码扫描 - Player 模型 pvp_mode 字段');
    const playerModelPath = path.join(__dirname, '../models/player.js');
    const playerModelCode = fs.readFileSync(playerModelPath, 'utf-8');
    record("Player 模型定义 pvp_mode 字段", /pvp_mode:\s*\{/.test(playerModelCode));
    record("pvp_mode 默认值为 'active'", /defaultValue:\s*'active'/.test(playerModelCode));

    // ===== 场景7：OpenAPI 文档同步 =====
    console.log('\n【场景7】OpenAPI 文档同步校验');
    const openapiPath = path.join(__dirname, '../../docs/openapi.json');
    const openapiCode = fs.readFileSync(openapiPath, 'utf-8');
    record('OpenAPI 包含 /api/pvp/mode 路径', openapiCode.includes('"/api/pvp/mode"'));
    record('OpenAPI 包含 GET /api/pvp/mode', /"\/api\/pvp\/mode":\s*\{[\s\S]*?"get":/.test(openapiCode));
    record('OpenAPI 包含 POST /api/pvp/mode', /"\/api\/pvp\/mode":\s*\{[\s\S]*?"post":/.test(openapiCode));
    record('OpenAPI GET /api/pvp/mode 描述包含避世', openapiCode.includes('查询当前玩家 PVP 模式'));

    // ===== 场景8：登录 =====
    console.log('\n【场景8】登录测试账号');
    let token;
    try {
        token = await login();
        record('登录成功并获取 Token', !!token);
    } catch (e) {
        record('登录成功并获取 Token', false, e.message);
        console.log('\n⚠️  登录失败，后续接口测试无法进行，终止测试');
        return printSummary();
    }

    // ===== 场景9：GET /api/pvp/status 返回 pvp_mode 字段 =====
    console.log('\n【场景9】GET /api/pvp/status 接口校验');
    let initialMode = 'active'; // 假设初始为 active，后续从接口读取实际值
    try {
        const res = await request({
            method: 'GET',
            path: '/api/pvp/status',
            headers: authHeader(token)
        });
        record('GET /api/pvp/status 返回 200', res.status === 200);
        const data = res.body?.data || {};
        record('响应包含 pvp_mode 字段', data.pvp_mode !== undefined, `实际：${JSON.stringify(data).slice(0, 200)}`);
        record('响应包含 pvp_mode_name 字段', data.pvp_mode_name !== undefined);
        record('pvp_mode 值为 active 或 recluse', ['active', 'recluse'].includes(data.pvp_mode));
        if (data.pvp_mode) initialMode = data.pvp_mode;
    } catch (e) {
        record('GET /api/pvp/status 接口校验', false, e.message);
    }

    // ===== 场景10：GET /api/pvp/mode 接口 =====
    console.log('\n【场景10】GET /api/pvp/mode 接口');
    try {
        const res = await request({
            method: 'GET',
            path: '/api/pvp/mode',
            headers: authHeader(token)
        });
        record('GET /api/pvp/mode 返回 200', res.status === 200);
        const data = res.body?.data || {};
        record('响应包含 player_id', data.player_id !== undefined);
        record('响应包含 pvp_mode', data.pvp_mode !== undefined);
        record('响应包含 mode_name', data.mode_name !== undefined);
        record('mode_name 与 pvp_mode 对应', (data.pvp_mode === 'recluse' && data.mode_name === '避世') ||
            (data.pvp_mode === 'active' && data.mode_name === '入世'));
    } catch (e) {
        record('GET /api/pvp/mode 接口', false, e.message);
    }

    // ===== 场景11：边界场景 - 未鉴权访问 =====
    console.log('\n【场景11】边界场景 - 未鉴权访问');
    try {
        const res1 = await request({ method: 'GET', path: '/api/pvp/mode' });
        record('未鉴权 GET /api/pvp/mode 返回 401', res1.status === 401);
    } catch (e) {
        record('未鉴权 GET /api/pvp/mode', false, e.message);
    }
    try {
        const res2 = await request({ method: 'POST', path: '/api/pvp/mode', body: { mode: 'recluse' } });
        record('未鉴权 POST /api/pvp/mode 返回 401', res2.status === 401);
    } catch (e) {
        record('未鉴权 POST /api/pvp/mode', false, e.message);
    }

    // ===== 场景12：边界场景 - 无效 mode 参数 =====
    console.log('\n【场景12】边界场景 - 无效 mode 参数');
    try {
        const res = await request({
            method: 'POST',
            path: '/api/pvp/mode',
            headers: authHeader(token),
            body: { mode: 'invalid_mode' }
        });
        record('无效 mode 返回 400', res.status === 400, `实际 status=${res.status}`);
        record('错误信息提示可选值', (res.body?.message || '').includes('active') && (res.body?.message || '').includes('recluse'));
    } catch (e) {
        record('无效 mode 参数', false, e.message);
    }

    // ===== 场景13：边界场景 - 空 body / 缺 mode =====
    console.log('\n【场景13】边界场景 - 空 body / 缺 mode 参数');
    try {
        const res = await request({
            method: 'POST',
            path: '/api/pvp/mode',
            headers: authHeader(token),
            body: {}
        });
        record('空 body 返回 400', res.status === 400, `实际 status=${res.status}`);
    } catch (e) {
        record('空 body', false, e.message);
    }

    // ===== 场景14：切换为避世 =====
    console.log('\n【场景14】切换为避世模式');
    try {
        const res = await request({
            method: 'POST',
            path: '/api/pvp/mode',
            headers: authHeader(token),
            body: { mode: 'recluse' }
        });
        record('POST /api/pvp/mode (recluse) 返回 200', res.status === 200, `实际 status=${res.status}, body=${JSON.stringify(res.body).slice(0, 200)}`);
        const data = res.body?.data || {};
        record('响应 pvp_mode=recluse', data.pvp_mode === 'recluse');
        record('响应 mode_name=避世', data.mode_name === '避世');
    } catch (e) {
        record('切换为避世模式', false, e.message);
    }

    // ===== 场景15：验证 status 接口同步返回避世 =====
    console.log('\n【场景15】验证 status 接口同步返回避世状态');
    try {
        const res = await request({
            method: 'GET',
            path: '/api/pvp/status',
            headers: authHeader(token)
        });
        const data = res.body?.data || {};
        record('GET /api/pvp/status 返回 pvp_mode=recluse', data.pvp_mode === 'recluse', `实际 pvp_mode=${data.pvp_mode}`);
        record('GET /api/pvp/status 返回 pvp_mode_name=避世', data.pvp_mode_name === '避世');
    } catch (e) {
        record('status 接口同步校验', false, e.message);
    }

    // ===== 场景16：避世时尝试 PVP 挑战（应被拒绝） =====
    console.log('\n【场景16】避世时 PVP 挑战拦截验证');
    try {
        // target_player_id 用一个不存在的 ID（避免实际发起战斗）
        // 即使目标不存在，attacker.pvp_mode 校验应先于目标校验触发
        const res = await request({
            method: 'POST',
            path: '/api/pvp/challenge',
            headers: authHeader(token),
            body: { target_player_id: 999999, battle_type: 'normal' }
        });
        record('避世时 PVP 挑战返回 400', res.status === 400, `实际 status=${res.status}`);
        record('错误信息提示避世', (res.body?.message || '').includes('避世'), `实际 message=${res.body?.message}`);
    } catch (e) {
        record('避世时 PVP 挑战拦截', false, e.message);
    }

    // ===== 场景17：避世时尝试决斗（应被拒绝） =====
    console.log('\n【场景17】避世时决斗拦截验证');
    try {
        const res = await request({
            method: 'POST',
            path: '/api/duel/challenge',
            headers: authHeader(token),
            body: { target_id: 999999, bet_amount: 100 }
        });
        record('避世时决斗返回 400', res.status === 400, `实际 status=${res.status}`);
        record('错误信息提示避世', (res.body?.message || '').includes('避世'), `实际 message=${res.body?.message}`);
    } catch (e) {
        record('避世时决斗拦截', false, e.message);
    }

    // ===== 场景18：避世时尝试封神台挑战（应被拒绝） =====
    console.log('\n【场景18】避世时封神台挑战拦截验证');
    try {
        const res = await request({
            method: 'POST',
            path: '/api/fengshen/challenge',
            headers: authHeader(token),
            body: { target_rank: 1 }
        });
        record('避世时封神台挑战返回 400', res.status === 400, `实际 status=${res.status}`);
        record('错误信息提示避世', (res.body?.message || '').includes('避世'), `实际 message=${res.body?.message}`);
    } catch (e) {
        record('避世时封神台挑战拦截', false, e.message);
    }

    // ===== 场景19：切换回入世 =====
    console.log('\n【场景19】切换回入世模式');
    try {
        const res = await request({
            method: 'POST',
            path: '/api/pvp/mode',
            headers: authHeader(token),
            body: { mode: 'active' }
        });
        record('POST /api/pvp/mode (active) 返回 200', res.status === 200, `实际 status=${res.status}`);
        const data = res.body?.data || {};
        record('响应 pvp_mode=active', data.pvp_mode === 'active');
        record('响应 mode_name=入世', data.mode_name === '入世');
    } catch (e) {
        record('切换回入世', false, e.message);
    }

    // ===== 场景20：验证 status 接口恢复入世 =====
    console.log('\n【场景20】验证 status 接口恢复入世');
    try {
        const res = await request({
            method: 'GET',
            path: '/api/pvp/status',
            headers: authHeader(token)
        });
        const data = res.body?.data || {};
        record('GET /api/pvp/status 返回 pvp_mode=active', data.pvp_mode === 'active', `实际 pvp_mode=${data.pvp_mode}`);
        record('GET /api/pvp/status 返回 pvp_mode_name=入世', data.pvp_mode_name === '入世');
    } catch (e) {
        record('status 接口恢复入世校验', false, e.message);
    }

    // ===== 场景21：还原测试账号 pvp_mode 至初始值 =====
    console.log('\n【场景21】数据还原');
    if (initialMode && initialMode !== 'active') {
        try {
            await request({
                method: 'POST',
                path: '/api/pvp/mode',
                headers: authHeader(token),
                body: { mode: initialMode }
            });
            record(`还原 pvp_mode 至初始值 ${initialMode}`, true);
        } catch (e) {
            record(`还原 pvp_mode 至初始值 ${initialMode}`, false, e.message);
        }
    } else {
        record('初始值即为 active，无需还原', true);
    }

    return printSummary();
}

/**
 * 打印测试总结
 */
function printSummary() {
    console.log('\n========================================');
    console.log('  测试总结');
    console.log('========================================');
    console.log(`  总计：${results.total}`);
    console.log(`  通过：${results.passed}`);
    console.log(`  失败：${results.failed}`);
    console.log(`  跳过：${results.skipped}`);
    console.log('========================================\n');
    if (results.failures.length > 0) {
        console.log('失败详情：');
        results.failures.forEach((f, i) => {
            console.log(`  ${i + 1}. ${f.name}`);
            if (f.detail) console.log(`     → ${f.detail}`);
        });
        console.log('');
    }
    process.exit(results.failed > 0 ? 1 : 0);
}

// 执行
main().catch(err => {
    console.error('\n❌ 测试执行异常：', err);
    process.exit(2);
});
