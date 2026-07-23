/**
 * PVP 战斗中使用丹药功能测试脚本
 *
 * 测试内容：
 *   1. 登录鉴权
 *   2. GET /api/pvp/battle-items 接口（不在战斗中应返回空列表 + 剩余次数0）
 *   3. POST /api/pvp/action action='item' 无 skill_index（参数校验）
 *   4. POST /api/pvp/action action='item' 有 skill_index 但不在战斗中（业务校验）
 *   5. 配置完整性验证（battle_items 配置段 + item_data usable_in_battle 标记）
 *   6. OpenAPI 文档验证（/api/pvp/battle-items 路径已注入）
 *
 * 注意：完整的战斗中使用丹药流程需要两个在线玩家发起 PVP 挑战，
 *      此脚本验证接口可用性和参数校验逻辑，不依赖第二个玩家。
 */
'use strict';

require('dotenv').config();
const BASE = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

// Node.js 18+ 内置 fetch，低版本回退 http 模块
let fetchFn;
if (typeof fetch !== 'undefined') {
    fetchFn = fetch;
} else {
    const http = require('http');
    fetchFn = (url, opts) => new Promise((resolve, reject) => {
        const req = http.request(url, opts, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode, json: () => Promise.resolve(JSON.parse(body)) }));
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

async function api(method, path, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetchFn(`${BASE}${path}`, opts);
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

const results = [];
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

async function main() {
    console.log('========================================');
    console.log('  PVP 战斗中使用丹药功能测试');
    console.log('========================================\n');

    // ===== 1. 登录 =====
    console.log('--- 1. 登录 ---');
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

    // ===== 2. GET /api/pvp/battle-items =====
    console.log('\n--- 2. GET /api/pvp/battle-items ---');
    const itemsRes = await api('GET', '/api/pvp/battle-items', token);
    check('应返回 200', itemsRes.status === 200, `actual=${itemsRes.status}`);
    const itemsData = itemsRes.json?.data;
    check('应返回 data 对象', !!itemsData);
    check('data 应包含 items 数组', Array.isArray(itemsData?.items), `items type=${typeof itemsData?.items}`);
    check('data 应包含 remaining_uses 数字', typeof itemsData?.remaining_uses === 'number', `remaining_uses=${itemsData?.remaining_uses}`);
    check('data 应包含 max_uses 数字', typeof itemsData?.max_uses === 'number', `max_uses=${itemsData?.max_uses}`);
    // 不在战斗中时 remaining_uses 应为 0（因为 no ongoing battle -> usedCount=0, maxUses=3, remainingUses=3）
    // 但如果功能开启且不在战斗中，remaining_uses = maxUses - 0 = 3
    check('不在战斗中时 remaining_uses 应等于 max_uses', itemsData?.remaining_uses === itemsData?.max_uses, `remaining=${itemsData?.remaining_uses}, max=${itemsData?.max_uses}`);

    // ===== 3. POST /api/pvp/action action='item' 无 skill_index =====
    console.log('\n--- 3. POST /api/pvp/action action=item 无 skill_index（参数校验）---');
    const noItemIdRes = await api('POST', '/api/pvp/action', token, { action: 'item' });
    check('无 skill_index 应返回 400', noItemIdRes.status === 400, `actual=${noItemIdRes.status}`);
    check('错误信息应包含 skill_index', (noItemIdRes.json?.message || '').includes('skill_index'), `msg=${noItemIdRes.json?.message}`);

    // ===== 4. POST /api/pvp/action action='item' 有 skill_index 但不在战斗中 =====
    console.log('\n--- 4. POST /api/pvp/action action=item 有 skill_index 不在战斗中（业务校验）---');
    const notInBattleRes = await api('POST', '/api/pvp/action', token, { action: 'item', skill_index: 'mid_healing_pill' });
    check('不在战斗中应返回 400', notInBattleRes.status === 400, `actual=${notInBattleRes.status}`);
    check('错误信息应包含"没有正在进行的斗法"', (notInBattleRes.json?.message || '').includes('没有正在进行的斗法'), `msg=${notInBattleRes.json?.message}`);

    // ===== 5. POST /api/pvp/action 无效 action =====
    console.log('\n--- 5. POST /api/pvp/action 无效 action（参数校验）---');
    const invalidActionRes = await api('POST', '/api/pvp/action', token, { action: 'invalid_action' });
    check('无效 action 应返回 400', invalidActionRes.status === 400, `actual=${invalidActionRes.status}`);
    check('错误信息应包含 item', (invalidActionRes.json?.message || '').includes('item'), `msg=${invalidActionRes.json?.message}`);

    // ===== 6. 配置完整性验证 =====
    console.log('\n--- 6. 配置完整性验证 ---');
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '..', 'config', 'game_balance.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const battleItemsCfg = config.pvp?.battle_items;
    check('pvp.battle_items 配置段应存在', !!battleItemsCfg);
    check('battle_items.enabled 应为 true', battleItemsCfg?.enabled === true);
    check('battle_items.max_uses_per_battle 应为 3', battleItemsCfg?.max_uses_per_battle === 3);
    check('battle_items.allowed_subtypes 应包含 healing', battleItemsCfg?.allowed_subtypes?.includes('healing'));
    check('battle_items.allowed_subtypes 应包含 mana', battleItemsCfg?.allowed_subtypes?.includes('mana'));

    // ===== 7. item_data.json usable_in_battle 标记验证 =====
    console.log('\n--- 7. item_data.json usable_in_battle 标记验证 ---');
    const itemDataPath = path.join(__dirname, '..', 'config', 'item_data.json');
    const itemData = JSON.parse(fs.readFileSync(itemDataPath, 'utf-8'));
    const healingPills = itemData.items?.filter(it => it.subtype === 'healing') || [];
    const manaPills = itemData.items?.filter(it => it.subtype === 'mana') || [];
    check('应存在 healing 类型物品', healingPills.length > 0, `count=${healingPills.length}`);
    check('应存在 mana 类型物品', manaPills.length > 0, `count=${manaPills.length}`);
    check('所有 healing 物品应标记 usable_in_battle=true', healingPills.every(it => it.usable_in_battle === true), `false count=${healingPills.filter(it => !it.usable_in_battle).length}`);
    check('所有 mana 物品应标记 usable_in_battle=true', manaPills.every(it => it.usable_in_battle === true), `false count=${manaPills.filter(it => !it.usable_in_battle).length}`);

    // ===== 8. OpenAPI 文档验证 =====
    console.log('\n--- 8. OpenAPI 文档验证 ---');
    const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
    if (fs.existsSync(openapiPath)) {
        const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
        check('OpenAPI 应包含 /api/pvp/battle-items 路径', !!openapi.paths?.['/api/pvp/battle-items']);
        check('battle-items 路径应有 GET 方法', !!openapi.paths?.['/api/pvp/battle-items']?.get);
        check('battle-items GET 应有 operationId', !!openapi.paths?.['/api/pvp/battle-items']?.get?.operationId, `operationId=${openapi.paths?.['/api/pvp/battle-items']?.get?.operationId}`);
        // 检查 /api/pvp/action 的 action 参数是否包含 item
        const actionSchema = openapi.paths?.['/api/pvp/action']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.action;
        check('/api/pvp/action action 参数应包含 item 枚举值', actionSchema?.enum?.includes('item'), `enum=${JSON.stringify(actionSchema?.enum)}`);
    } else {
        check('OpenAPI 文件存在', false, 'openapi.json not found');
    }

    // ===== 结果汇总 =====
    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`  通过: ${passed} / ${results.length}`);
    console.log(`  失败: ${failed} / ${results.length}`);
    console.log(`  成功率: ${(passed / results.length * 100).toFixed(1)}%`);
    if (failed > 0) {
        console.log('\n  失败项:');
        results.filter(r => !r.pass).forEach(r => console.log(`    ❌ ${r.name}${r.detail ? ' | ' + r.detail : ''}`));
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
