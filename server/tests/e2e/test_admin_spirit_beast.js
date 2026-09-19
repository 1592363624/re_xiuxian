/**
 * GM 灵兽系统管理接口端到端测试
 *
 * 测试覆盖：
 *   1. 登录获取 token（管理员账号 1592363624）
 *   2. GET  /api/admin/spirit-beast/stats           全局统计
 *   3. GET  /api/admin/spirit-beast/beasts           分页查询
 *   4. GET  /api/admin/spirit-beast/players/:id/beasts 玩家灵兽列表
 *   5. POST /api/admin/spirit-beast/give             GM 发放灵兽（绕过境界/灵力限制）
 *   6. PUT  /api/admin/spirit-beast/beasts/:id       修改灵兽属性（含 recalculate）
 *   7. POST /api/admin/spirit-beast/beasts/:id/set-active 强制出战
 *   8. POST /api/admin/spirit-beast/beasts/:id/reset-cooldowns 重置冷却
 *   9. DELETE /api/admin/spirit-beast/beasts/:id     删除灵兽
 *
 * 测试策略：
 *   - 使用 HTTP 接口测试（与玩家端路由相同的方式）
 *   - 测试账号：1592363624 / 1592363624（玩家ID=1，admin 角色）
 *   - 发放一只测试灵兽 → 修改 → 强制出战 → 重置冷却 → 删除（避免污染数据）
 *   - 验证每个接口的响应结构、关键字段、错误码
 */
'use strict';

const http = require('http');

const API_BASE = {
    hostname: 'localhost',
    port: 5000,
    headers: { 'Content-Type': 'application/json' }
};

const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

let token = '';
let testBeastId = 0;
let passedCount = 0;
let failedCount = 0;

/**
 * 发送 HTTP 请求的 Promise 封装
 * @param {string} method HTTP 方法
 * @param {string} path 路径
 * @param {Object} [body] 请求体
 * @param {Object} [extraHeaders] 额外请求头
 * @returns {Promise<Object>} 响应数据
 */
function httpRequest(method, path, body, extraHeaders) {
    return new Promise((resolve, reject) => {
        const options = {
            ...API_BASE,
            method,
            path,
            headers: { ...API_BASE.headers, ...(extraHeaders || {}) }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
                } catch (err) {
                    resolve({ status: res.statusCode, data: { raw: data } });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

/**
 * 断言函数：检查条件并打印结果
 * @param {string} name 测试用例名
 * @param {boolean} condition 条件
 * @param {string} [detail] 失败时的详情
 */
function assert(name, condition, detail) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passedCount++;
    } else {
        console.log(`  ❌ ${name}`);
        if (detail) console.log(`     ${detail}`);
        failedCount++;
    }
}

async function main() {
    console.log('====== GM 灵兽系统管理接口端到端测试 ======\n');

    // ============ 1. 登录获取 token ============
    console.log('【1】管理员登录...');
    const loginRes = await httpRequest('POST', '/api/auth/login', TEST_ACCOUNT);
    assert('登录成功返回 token', !!loginRes.data.token, JSON.stringify(loginRes.data));
    token = loginRes.data.token;
    if (!token) {
        console.error('无法获取 token，测试终止');
        process.exit(1);
    }

    const authHeaders = { 'Authorization': `Bearer ${token}` };

    // ============ 2. 获取全局统计 ============
    console.log('\n【2】GET /api/admin/spirit-beast/stats 全局统计...');
    const statsRes = await httpRequest('GET', '/api/admin/spirit-beast/stats', null, authHeaders);
    assert('统计接口返回 200', statsRes.status === 200, JSON.stringify(statsRes.data));
    assert('统计包含 total_beasts 字段', typeof statsRes.data?.data?.total_beasts === 'number');
    assert('统计包含 active_beasts 字段', typeof statsRes.data?.data?.active_beasts === 'number');
    assert('统计包含 rarity_distribution 数组', Array.isArray(statsRes.data?.data?.rarity_distribution));
    assert('统计包含 element_distribution 数组', Array.isArray(statsRes.data?.data?.element_distribution));
    assert('统计包含 top_players 数组', Array.isArray(statsRes.data?.data?.top_players));
    console.log(`     当前总灵兽数: ${statsRes.data?.data?.total_beasts}`);

    // ============ 3. 分页查询灵兽列表 ============
    console.log('\n【3】GET /api/admin/spirit-beast/beasts 分页查询...');
    const listRes = await httpRequest('GET', '/api/admin/spirit-beast/beasts?page=1&limit=5', null, authHeaders);
    assert('列表接口返回 200', listRes.status === 200, JSON.stringify(listRes.data));
    assert('列表包含 beasts 数组', Array.isArray(listRes.data?.data?.beasts));
    assert('列表包含 total 字段', typeof listRes.data?.data?.total === 'number');
    console.log(`     查询到 ${listRes.data?.data?.beasts?.length || 0} / ${listRes.data?.data?.total} 条`);

    // ============ 4. 查询玩家1的全部灵兽 ============
    console.log('\n【4】GET /api/admin/spirit-beast/players/1/beasts 玩家灵兽...');
    const playerBeastsRes = await httpRequest('GET', '/api/admin/spirit-beast/players/1/beasts', null, authHeaders);
    assert('玩家灵兽接口返回 200', playerBeastsRes.status === 200, JSON.stringify(playerBeastsRes.data));
    assert('玩家灵兽包含 player 信息', !!playerBeastsRes.data?.data?.player);
    assert('玩家灵兽包含 beasts 数组', Array.isArray(playerBeastsRes.data?.data?.beasts));
    const initialCount = playerBeastsRes.data?.data?.beasts?.length || 0;
    console.log(`     玩家1当前灵兽数: ${initialCount}`);

    // ============ 5. GM 发放灵兽 ============
    console.log('\n【5】POST /api/admin/spirit-beast/give GM 发放灵兽...');
    const giveRes = await httpRequest('POST', '/api/admin/spirit-beast/give', {
        player_id: 1,
        beast_key: 'tenglong_snake', // 传说级腾蛇（GM 绕过境界限制）
        star_level: 5,
        level: 50,
        loyalty: 100,
        is_active: false,
        beast_name: 'GM测试腾蛇'
    }, authHeaders);
    assert('发放接口返回 200', giveRes.status === 200, JSON.stringify(giveRes.data));
    assert('发放返回 beast_id', !!giveRes.data?.data?.beast_id, JSON.stringify(giveRes.data));
    assert('发放的 beast_key 为 tenglong_snake', giveRes.data?.data?.beast_key === 'tenglong_snake');
    assert('发放的 star_level 为 5', giveRes.data?.data?.star_level === 5);
    assert('发放的 level 为 50', giveRes.data?.data?.level === 50);
    assert('发放的 loyalty 为 100', giveRes.data?.data?.loyalty === 100);
    assert('发放的 beast_name 为 GM测试腾蛇', giveRes.data?.data?.beast_name === 'GM测试腾蛇');

    // 验证属性计算公式：base * (1 + (level-1)*0.1) * star_level
    // 腾蛇 base_atk=200, base_def=150, base_hp=1200, base_speed=100
    // level=50, star=5: 200 * (1 + 49*0.1) * 5 = 200 * 5.9 * 5 = 5900
    const expectedAtk = Math.floor(200 * (1 + 49 * 0.1) * 5);
    assert(`发放的 atk 应为 ${expectedAtk}`, giveRes.data?.data?.atk === expectedAtk, `实际: ${giveRes.data?.data?.atk}`);

    testBeastId = giveRes.data?.data?.beast_id;
    if (!testBeastId) {
        console.error('发放失败，测试终止');
        process.exit(1);
    }
    console.log(`     发放成功，灵兽 ID: ${testBeastId}`);

    // ============ 6. 修改灵兽属性 ============
    console.log('\n【6】PUT /api/admin/spirit-beast/beasts/:id 修改灵兽属性...');
    const updateRes = await httpRequest('PUT', `/api/admin/spirit-beast/beasts/${testBeastId}`, {
        star_level: 8,
        level: 80,
        loyalty: 80,
        beast_name: 'GM测试腾蛇-改名',
        recalculate: true // 按新 level/star 重算属性
    }, authHeaders);
    assert('修改接口返回 200', updateRes.status === 200, JSON.stringify(updateRes.data));
    assert('修改后 star_level 为 8', updateRes.data?.data?.star_level === 8);
    assert('修改后 level 为 80', updateRes.data?.data?.level === 80);
    assert('修改后 loyalty 为 80', updateRes.data?.data?.loyalty === 80);
    assert('修改后 beast_name 为 GM测试腾蛇-改名', updateRes.data?.data?.beast_name === 'GM测试腾蛇-改名');

    // 验证重算属性：level=80, star=8: 200 * (1 + 79*0.1) * 8 = 200 * 8.9 * 8 = 14240
    const expectedAtkAfterRecalc = Math.floor(200 * (1 + 79 * 0.1) * 8);
    assert(`重算后 atk 应为 ${expectedAtkAfterRecalc}`, updateRes.data?.data?.atk === expectedAtkAfterRecalc, `实际: ${updateRes.data?.data?.atk}`);

    // ============ 7. 强制出战 ============
    console.log('\n【7】POST /api/admin/spirit-beast/beasts/:id/set-active 强制出战...');
    const setActiveRes = await httpRequest('POST', `/api/admin/spirit-beast/beasts/${testBeastId}/set-active`, { active: true }, authHeaders);
    assert('强制出战接口返回 200', setActiveRes.status === 200, JSON.stringify(setActiveRes.data));
    assert('强制出战返回 is_active=true', setActiveRes.data?.data?.is_active === true);

    // 验证其他灵兽被取消出战（查询玩家灵兽）
    const afterSetActive = await httpRequest('GET', '/api/admin/spirit-beast/players/1/beasts', null, authHeaders);
    const activeBeasts = (afterSetActive.data?.data?.beasts || []).filter(b => b.is_active);
    assert('玩家1仅有1只出战灵兽', activeBeasts.length === 1, `实际出战数: ${activeBeasts.length}`);
    assert('出战的灵兽是测试灵兽', activeBeasts[0]?.beast_id === testBeastId);

    // ============ 8. 重置冷却 ============
    console.log('\n【8】POST /api/admin/spirit-beast/beasts/:id/reset-cooldowns 重置冷却...');
    const resetCdRes = await httpRequest('POST', `/api/admin/spirit-beast/beasts/${testBeastId}/reset-cooldowns`, { type: 'all' }, authHeaders);
    assert('重置冷却接口返回 200', resetCdRes.status === 200, JSON.stringify(resetCdRes.data));
    assert('重置后 last_feed_time 为 null', resetCdRes.data?.data?.last_feed_time === null);
    assert('重置后 last_interact_time 为 null', resetCdRes.data?.data?.last_interact_time === null);

    // ============ 9. 删除灵兽 ============
    console.log('\n【9】DELETE /api/admin/spirit-beast/beasts/:id 删除灵兽...');
    // 中文 reason 需要编码避免 ERR_UNESCAPED_CHARACTERS
    const delRes = await httpRequest('DELETE', `/api/admin/spirit-beast/beasts/${testBeastId}?reason=${encodeURIComponent('测试结束清理')}`, null, authHeaders);
    assert('删除接口返回 200', delRes.status === 200, JSON.stringify(delRes.data));
    assert('删除返回 deleted=true', delRes.data?.data?.deleted === true);

    // 验证已删除（再次查询详情应 404）
    const detailAfterDel = await httpRequest('GET', `/api/admin/spirit-beast/beasts/${testBeastId}`, null, authHeaders);
    assert('删除后查询详情返回 404', detailAfterDel.status === 404, JSON.stringify(detailAfterDel.data));

    // ============ 10. 错误参数校验测试 ============
    console.log('\n【10】错误参数校验测试...');
    // 不存在的 beast_key
    const invalidKeyRes = await httpRequest('POST', '/api/admin/spirit-beast/give', {
        player_id: 1,
        beast_key: 'not_exist_key'
    }, authHeaders);
    assert('不存在的 beast_key 返回 400', invalidKeyRes.status === 400, JSON.stringify(invalidKeyRes.data));

    // 缺失 player_id
    const missingPlayerRes = await httpRequest('POST', '/api/admin/spirit-beast/give', {
        beast_key: 'qingyun_wolf'
    }, authHeaders);
    assert('缺失 player_id 返回 400', missingPlayerRes.status === 400, JSON.stringify(missingPlayerRes.data));

    // 超范围 star_level
    const invalidStarRes = await httpRequest('POST', '/api/admin/spirit-beast/give', {
        player_id: 1,
        beast_key: 'qingyun_wolf',
        star_level: 99
    }, authHeaders);
    assert('超范围 star_level 返回 400', invalidStarRes.status === 400, JSON.stringify(invalidStarRes.data));

    // 无 token 访问应 401
    const noTokenRes = await httpRequest('GET', '/api/admin/spirit-beast/stats');
    assert('无 token 访问返回 401', noTokenRes.status === 401, JSON.stringify(noTokenRes.data));

    // ============ 测试总结 ============
    console.log('\n====== 测试总结 ======');
    console.log(`通过: ${passedCount}  失败: ${failedCount}`);
    if (failedCount > 0) {
        console.error('❌ 测试未全部通过');
        process.exit(1);
    } else {
        console.log('✅ 所有测试用例通过');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('测试执行异常:', err);
    process.exit(1);
});
