/**
 * 神识对决系统端到端测试脚本
 *
 * 测试内容：
 *   1. 登录鉴权
 *   2. 配置完整性验证（game_balance.json pvp_extended.divine_duel 配置段）
 *   3. 数据库表结构验证（divine_duels 表存在 + 字段完整）
 *   4. 模型验证
 *   5. GET /api/divine-sense/duel/active — 查询当前对决（初始应为空）
 *   6. GET /api/divine-sense/duel/history — 查询历史记录
 *   7. 参数校验与未授权访问
 *   8. POST /api/divine-sense/duel/challenge — 发起挑战（可能因无目标玩家而失败）
 *   9. POST /api/divine-sense/duel/action — 执行行动参数校验
 *  10. Service 单元验证
 *  11. 路由文件验证
 *  12. OpenAPI 文档验证（如已注册）
 *
 * 运行方式：node scripts/test_divine_sense_duel.js
 *
 * 注意：本测试为只读为主，不实际发起挑战（避免影响其他玩家），
 *      主要验证接口可达性、参数校验、Service/路由/OpenAPI 完整性。
 */
'use strict';

// 显式指定 .env 路径，确保从 server/.env 加载
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
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

async function api(method, pathStr, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetchFn(`${BASE}${pathStr}`, opts);
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
    console.log('  神识对决系统端到端测试');
    console.log('========================================\n');

    // ===== 1. 登录 =====
    console.log('--- 1. 登录 ---');
    const loginRes = await api('POST', '/api/auth/login', null, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    check('登录应返回 200', loginRes.status === 200, `actual=${loginRes.status}`);
    const token = loginRes.json?.token || loginRes.json?.data?.token;
    check('应返回 token', !!token);
    if (!token) {
        console.log('❌ 无法获取 token，终止测试');
        process.exit(1);
    }

    // ===== 2. 配置完整性验证 =====
    console.log('\n--- 2. 配置完整性验证 ---');
    const fs = require('fs');
    const lateStagePath = path.join(__dirname, '..', 'config', 'late_stage_data.json');
    const lateStage = JSON.parse(fs.readFileSync(lateStagePath, 'utf-8'));
    const duelCfg = lateStage?.divine_duel;
    check('late_stage_data.divine_duel 配置段应存在', !!duelCfg);
    if (duelCfg) {
        check('配置 min_realm_rank 字段', typeof duelCfg.min_realm_rank === 'number');
        check('配置 init_shield 字段', typeof duelCfg.init_shield === 'number');
        check('配置 max_rounds 字段', typeof duelCfg.max_rounds === 'number');
        check('配置 action_timeout_seconds 字段', typeof duelCfg.action_timeout_seconds === 'number');
        check('配置 challenge_timeout_seconds 字段', typeof duelCfg.challenge_timeout_seconds === 'number');
        check('配置 bet_types.spirit_stone.max 字段', typeof duelCfg.bet_types?.spirit_stone?.max === 'number');
        check('配置 bet_types.divine_sense.max 字段', typeof duelCfg.bet_types?.divine_sense?.max === 'number');
    }

    // ===== 3. 数据库表结构验证 =====
    console.log('\n--- 3. 数据库表结构验证 ---');
    const sequelize = require('../config/database');
    const { QueryTypes } = require('sequelize');
    try {
        const tableInfo = await sequelize.query(
            `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_divine_duels'`,
            { type: QueryTypes.SELECT }
        );
        check('player_divine_duels 表存在', tableInfo[0]?.cnt > 0);

        if (tableInfo[0]?.cnt > 0) {
            const [columns] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_divine_duels'`
            );
            const colNames = columns.map(c => c.COLUMN_NAME);
            const requiredCols = [
                'id', 'challenger_id', 'defender_id', 'status', 'bet_type',
                'bet_amount', 'round_number', 'challenger_shield',
                'defender_shield', 'challenger_action', 'defender_action',
                'action_deadline', 'winner_id',
                'settle_reason', 'finished_at', 'created_at', 'updated_at'
            ];
            for (const col of requiredCols) {
                check(`字段 ${col} 存在`, colNames.includes(col));
            }
        }
    } catch (e) {
        check('数据库验证无异常', false, `${e.name}: ${e.message || '(无消息)'}`);
    }

    // ===== 4. Service 单元验证 =====
    console.log('\n--- 4. Service 单元验证 ---');
    try {
        const DivineDuelService = require('../game/services/DivineDuelService');
        check('DivineDuelService 加载成功', !!DivineDuelService);
        check('Service 含 challenge 方法', typeof DivineDuelService.challenge === 'function');
        check('Service 含 accept 方法', typeof DivineDuelService.accept === 'function');
        check('Service 含 action 方法', typeof DivineDuelService.action === 'function');
        check('Service 含 getActiveDuel 方法', typeof DivineDuelService.getActiveDuel === 'function');
        check('Service 含 getHistory 方法', typeof DivineDuelService.getHistory === 'function');
        check('Service 含 surrender 方法', typeof DivineDuelService.surrender === 'function');
    } catch (e) {
        check('Service 加载无异常', false, e.message);
    }

    // ===== 5. GET /api/divine-sense/duel/active — 当前对决 =====
    console.log('\n--- 5. GET /duel/active 当前对决 ---');
    const activeRes = await api('GET', '/api/divine-sense/duel/active', token);
    check('GET /duel/active 状态码 200', activeRes.status === 200, `actual=${activeRes.status}`);
    check('GET /duel/active 返回 code=200', activeRes.json?.code === 200);
    // data 可为 null（无进行中对局）或对象（有进行中对局）
    if (activeRes.json?.data) {
        check('返回 data.duel_id', typeof activeRes.json.data.duel_id === 'number');
        check('返回 data.status', typeof activeRes.json.data.status === 'string');
        check('返回 data.round_number', typeof activeRes.json.data.round_number === 'number');
        check('返回 data.challenger_shield', typeof activeRes.json.data.challenger_shield === 'number');
        check('返回 data.defender_shield', typeof activeRes.json.data.defender_shield === 'number');
        console.log(`  ℹ️ 当前有进行中对决 #${activeRes.json.data.duel_id}，状态 ${activeRes.json.data.status}`);
    } else {
        check('无进行中对决时 data 为 null', activeRes.json?.data === null);
        console.log('  ℹ️ 当前无进行中的对决');
    }

    // ===== 6. GET /api/divine-sense/duel/history — 历史记录 =====
    console.log('\n--- 6. GET /duel/history 历史记录 ---');
    const historyRes = await api('GET', '/api/divine-sense/duel/history?page=1&page_size=5', token);
    check('GET /duel/history 状态码 200', historyRes.status === 200, `actual=${historyRes.status}`);
    check('GET /duel/history 返回 code=200', historyRes.json?.code === 200);
    if (historyRes.json?.data) {
        check('返回 data.total', typeof historyRes.json.data.total === 'number');
        check('返回 data.page', typeof historyRes.json.data.page === 'number');
        check('返回 data.page_size', typeof historyRes.json.data.page_size === 'number');
        check('返回 data.duels 数组', Array.isArray(historyRes.json.data.duels));
        if (historyRes.json.data.duels.length > 0) {
            const first = historyRes.json.data.duels[0];
            check('历史条目含 duel_id', typeof first.duel_id === 'number');
            check('历史条目含 status', typeof first.status === 'string');
            check('历史条目含 bet_type', typeof first.bet_type === 'string');
            check('历史条目含 round_number', typeof first.round_number === 'number');
            check('历史条目含 is_winner', typeof first.is_winner === 'boolean');
            check('历史条目含 is_draw', typeof first.is_draw === 'boolean');
            check('历史条目含 created_at', typeof first.created_at === 'string');
        }
    }

    // ===== 7. 参数校验与未授权 =====
    console.log('\n--- 7. 参数校验与未授权 ---');
    // 未授权访问
    const noAuthRes = await api('GET', '/api/divine-sense/duel/active', null);
    check('未授权访问返回 401', noAuthRes.status === 401, `actual=${noAuthRes.status}`);

    // challenge 参数校验
    const challengeNoTargetRes = await api('POST', '/api/divine-sense/duel/challenge', token, {
        bet_type: 'spirit_stone',
        bet_amount: 100
    });
    check('challenge 缺失 target_player_id 返回 400', challengeNoTargetRes.status === 400, `actual=${challengeNoTargetRes.status}`);

    const challengeBadBetTypeRes = await api('POST', '/api/divine-sense/duel/challenge', token, {
        target_player_id: 1,
        bet_type: 'invalid_type',
        bet_amount: 100
    });
    check('challenge bet_type=invalid 返回 400', challengeBadBetTypeRes.status === 400, `actual=${challengeBadBetTypeRes.status}`);

    const challengeBadAmountRes = await api('POST', '/api/divine-sense/duel/challenge', token, {
        target_player_id: 1,
        bet_type: 'spirit_stone',
        bet_amount: -10
    });
    check('challenge bet_amount=-10 返回 400', challengeBadAmountRes.status === 400, `actual=${challengeBadAmountRes.status}`);

    // action 参数校验
    const actionBadDuelIdRes = await api('POST', '/api/divine-sense/duel/action', token, {
        duel_id: 0,
        action: 'focus'
    });
    check('action duel_id=0 返回 400', actionBadDuelIdRes.status === 400, `actual=${actionBadDuelIdRes.status}`);

    const actionBadActionRes = await api('POST', '/api/divine-sense/duel/action', token, {
        duel_id: 999,
        action: 'invalid'
    });
    check('action action=invalid 返回 400', actionBadActionRes.status === 400, `actual=${actionBadActionRes.status}`);

    // accept 参数校验
    const acceptBadIdRes = await api('POST', '/api/divine-sense/duel/accept', token, { duel_id: 0 });
    check('accept duel_id=0 返回 400', acceptBadIdRes.status === 400, `actual=${acceptBadIdRes.status}`);

    // surrender 参数校验
    const surrenderBadIdRes = await api('POST', '/api/divine-sense/duel/surrender', token, { duel_id: 0 });
    check('surrender duel_id=0 返回 400', surrenderBadIdRes.status === 400, `actual=${surrenderBadIdRes.status}`);

    // ===== 8. challenge 业务校验（挑战不存在的玩家） =====
    console.log('\n--- 8. challenge 业务校验 ---');
    const challengeInvalidPlayerRes = await api('POST', '/api/divine-sense/duel/challenge', token, {
        target_player_id: 999999,
        bet_type: 'spirit_stone',
        bet_amount: 100
    });
    // sendServiceResult 包装逻辑：业务失败时 HTTP 200 但 success=false 且 message 含错误描述
    check('challenge 不存在玩家返回业务失败', challengeInvalidPlayerRes.json?.success === false
        || (challengeInvalidPlayerRes.json?.message && challengeInvalidPlayerRes.json?.message !== 'success'),
        `status=${challengeInvalidPlayerRes.status}, code=${challengeInvalidPlayerRes.json?.code}, msg=${challengeInvalidPlayerRes.json?.message}`);

    // ===== 9. 路由文件验证 =====
    console.log('\n--- 9. 路由文件验证 ---');
    const routePath = path.join(__dirname, '..', 'routes', 'divine-sense.js');
    check('routes/divine-sense.js 文件存在', fs.existsSync(routePath));
    if (fs.existsSync(routePath)) {
        const routeContent = fs.readFileSync(routePath, 'utf-8');
        check('路由含 /duel/challenge 路径', routeContent.includes("'/duel/challenge'"));
        check('路由含 /duel/accept 路径', routeContent.includes("'/duel/accept'"));
        check('路由含 /duel/action 路径', routeContent.includes("'/duel/action'"));
        check('路由含 /duel/active 路径', routeContent.includes("'/duel/active'"));
        check('路由含 /duel/history 路径', routeContent.includes("'/duel/history'"));
        check('路由含 /duel/surrender 路径', routeContent.includes("'/duel/surrender'"));
        check('路由使用 auth 中间件', routeContent.includes('auth,'));
        check('路由引用 DivineDuelService', routeContent.includes('DivineDuelService'));
    }

    // ===== 10. 前端文件验证 =====
    console.log('\n--- 10. 前端文件验证 ---');
    const apiPath = path.join(__dirname, '..', '..', 'client', 'src', 'api', 'divineSenseDuel.ts');
    check('client/src/api/divineSenseDuel.ts 文件存在', fs.existsSync(apiPath));
    if (fs.existsSync(apiPath)) {
        const apiContent = fs.readFileSync(apiPath, 'utf-8');
        check('API 含 challengeDuel 方法', apiContent.includes('export const challengeDuel'));
        check('API 含 acceptDuel 方法', apiContent.includes('export const acceptDuel'));
        check('API 含 performDuelAction 方法', apiContent.includes('export const performDuelAction'));
        check('API 含 getActiveDuel 方法', apiContent.includes('export const getActiveDuel'));
        check('API 含 getDuelHistory 方法', apiContent.includes('export const getDuelHistory'));
        check('API 含 surrenderDuel 方法', apiContent.includes('export const surrenderDuel'));
    }

    const panelPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'panels', 'DivineSenseDuelPanel.vue');
    check('client/src/components/panels/DivineSenseDuelPanel.vue 文件存在', fs.existsSync(panelPath));
    if (fs.existsSync(panelPath)) {
        const panelContent = fs.readFileSync(panelPath, 'utf-8');
        check('面板含 4 个 Tab', panelContent.includes("'active'") && panelContent.includes("'challenge'")
            && panelContent.includes("'history'") && panelContent.includes("'guide'"));
        check('面板使用 Modal 组件', panelContent.includes("import Modal"));
        check('面板含挑战确认弹窗', panelContent.includes('challengeConfirmShow'));
        check('面板含行动确认弹窗', panelContent.includes('actionConfirmShow'));
        check('面板含投降确认弹窗', panelContent.includes('surrenderConfirmShow'));
        check('面板含回合结算弹窗', panelContent.includes('actionResultShow'));
        check('面板使用 useUIStore', panelContent.includes('useUIStore'));
    }

    // GameLayout 注册验证
    const gameLayoutPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'layout', 'GameLayout.vue');
    const gameLayoutContent = fs.readFileSync(gameLayoutPath, 'utf-8');
    check('GameLayout 导入 DivineSenseDuelPanel', gameLayoutContent.includes('DivineSenseDuelPanel'));
    check('GameLayout 注册 isDivineSenseDuelOpen', gameLayoutContent.includes('isDivineSenseDuelOpen'));
    check('GameLayout 处理 divine_sense_duel actionId', gameLayoutContent.includes("'divine_sense_duel'"));

    // ActionBar 按钮验证
    const actionBarPath = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'panels', 'ActionBar.vue');
    const actionBarContent = fs.readFileSync(actionBarPath, 'utf-8');
    check('ActionBar 含 divine_sense_duel 按钮', actionBarContent.includes("id: 'divine_sense_duel'"));

    // ===== 11. OpenAPI 文档验证 =====
    console.log('\n--- 11. OpenAPI 文档验证 ---');
    const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
    if (fs.existsSync(openapiPath)) {
        const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
        const paths = openapi.paths || {};
        const expectedPaths = [
            '/api/divine-sense/duel/challenge',
            '/api/divine-sense/duel/accept',
            '/api/divine-sense/duel/action',
            '/api/divine-sense/duel/active',
            '/api/divine-sense/duel/history',
            '/api/divine-sense/duel/surrender'
        ];
        for (const p of expectedPaths) {
            check(`OpenAPI 含路径 ${p}`, !!paths[p]);
        }
    } else {
        check('openapi.json 文件存在', false);
    }

    // ===== 测试结果汇总 =====
    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`  ✅ 通过: ${passed}`);
    console.log(`  ❌ 失败: ${failed}`);
    console.log(`  总计: ${results.length}`);
    console.log('========================================\n');

    await sequelize.close();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
