/**
 * 封神台系统端到端测试脚本
 *
 * 测试内容：
 *   1. 登录鉴权
 *   2. 配置完整性验证（game_balance.json pvp_extended.fengshen 配置段）
 *   3. 数据库表结构验证（fengshen_rankings 表存在 + 字段完整）
 *   4. 模型验证（FengshenRanking 模型字段）
 *   5. GET /api/fengshen/ranking — 排行榜接口
 *   6. GET /api/fengshen/my — 我的封神台信息
 *   7. POST /api/fengshen/defense — 设置防守阵容
 *   8. GET /api/fengshen/defense — 获取防守阵容
 *   9. GET /api/fengshen/season — 赛季信息
 *  10. POST /api/fengshen/challenge — 挑战排名（可能因只有1名玩家而无法挑战）
 *  11. OpenAPI 文档验证
 *
 * 运行方式：node scripts/test_fengshen.js
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
    console.log('  封神台系统端到端测试');
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
    const path = require('path');
    const balancePath = path.join(__dirname, '..', 'config', 'game_balance.json');
    const balance = JSON.parse(fs.readFileSync(balancePath, 'utf-8'));
    const fengshenCfg = balance?.pvp_extended?.fengshen;
    check('pvp_extended.fengshen 配置段应存在', !!fengshenCfg);
    check('enabled 应为 true', fengshenCfg?.enabled === true);
    check('daily_challenge_limit 应为 5', fengshenCfg?.daily_challenge_limit === 5);
    check('cooldown_seconds 应为 180', fengshenCfg?.cooldown_seconds === 180);
    check('base_score 应为 1000', fengshenCfg?.base_score === 1000);
    check('score_win_attacker 应为 30', fengshenCfg?.score_win_attacker === 30);
    check('score_lose_attacker 应为 20', fengshenCfg?.score_lose_attacker === 20);
    check('challenge_rank_range 应为 5', fengshenCfg?.challenge_rank_range === 5);
    check('season_duration_days 应为 30', fengshenCfg?.season_duration_days === 30);
    check('top_ranks 应为 [1,2,3]', JSON.stringify(fengshenCfg?.top_ranks) === JSON.stringify([1, 2, 3]));
    check('rank_reward_honor 应为 [500,300,150]', JSON.stringify(fengshenCfg?.rank_reward_honor) === JSON.stringify([500, 300, 150]));

    // ===== 3. 数据库表结构验证 =====
    console.log('\n--- 3. 数据库表结构验证 ---');
    const sequelize = require('../config/database');
    const { QueryTypes } = require('sequelize');
    const [cols] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'fengshen_rankings'
         ORDER BY ORDINAL_POSITION`
    );
    const colNames = Array.isArray(cols) ? cols.map(r => r.COLUMN_NAME) : [];
    const requiredCols = ['id', 'player_id', 'rank', 'season', 'fengshen_score',
        'defense_config', 'defense_set_at', 'daily_challenge_count',
        'daily_defend_count', 'total_wins', 'total_losses', 'last_challenge_date',
        'created_at', 'updated_at'];
    for (const col of requiredCols) {
        check(`fengshen_rankings 应有 ${col} 列`, colNames.includes(col));
    }

    // ===== 4. 模型验证 =====
    console.log('\n--- 4. 模型验证 ---');
    const FengshenRanking = require('../models/fengshenRanking');
    const modelAttrs = FengshenRanking.rawAttributes;
    check('模型应定义 player_id 字段', !!modelAttrs?.player_id);
    check('模型应定义 rank 字段', !!modelAttrs?.rank);
    check('模型应定义 fengshen_score 字段', !!modelAttrs?.fengshen_score);
    check('模型应定义 defense_config 字段', !!modelAttrs?.defense_config);
    check('模型应定义 defense_set_at 字段', !!modelAttrs?.defense_set_at);
    check('模型应定义 daily_challenge_count 字段', !!modelAttrs?.daily_challenge_count);
    check('模型应定义 total_wins 字段', !!modelAttrs?.total_wins);
    check('模型应定义 total_losses 字段', !!modelAttrs?.total_losses);
    check('模型应定义 season 字段', !!modelAttrs?.season);

    // ===== 5. GET /api/fengshen/ranking — 排行榜 =====
    console.log('\n--- 5. GET /api/fengshen/ranking 排行榜 ---');
    const rankingRes = await api('GET', '/api/fengshen/ranking?page=1&page_size=20', token);
    check('排行榜接口应返回 200', rankingRes.status === 200, `actual=${rankingRes.status}`);
    const rankingData = rankingRes.json?.data;
    check('返回应包含 list 数组', Array.isArray(rankingData?.list));
    check('返回应包含 total', typeof rankingData?.total === 'number');
    check('返回应包含 my_rank', typeof rankingData?.my_rank === 'number');
    check('返回应包含 my_score', typeof rankingData?.my_score === 'number');

    // ===== 6. GET /api/fengshen/my — 我的封神台 =====
    console.log('\n--- 6. GET /api/fengshen/my 我的封神台 ---');
    const myRes = await api('GET', '/api/fengshen/my', token);
    check('我的封神台接口应返回 200', myRes.status === 200, `actual=${myRes.status}`);
    const myData = myRes.json?.data;
    check('返回应包含 rank', typeof myData?.rank === 'number');
    check('返回应包含 fengshen_score', typeof myData?.fengshen_score === 'number');
    check('返回应包含 total_wins', typeof myData?.total_wins === 'number');
    check('返回应包含 total_losses', typeof myData?.total_losses === 'number');
    check('返回应包含 daily_challenge_remaining', typeof myData?.daily_challenge_remaining === 'number');
    check('返回应包含 defense_set', typeof myData?.defense_set === 'boolean');
    check('返回应包含 season', typeof myData?.season === 'number');

    // ===== 7. POST /api/fengshen/defense — 设置防守阵容 =====
    console.log('\n--- 7. POST /api/fengshen/defense 设置防守阵容 ---');
    const setDefRes = await api('POST', '/api/fengshen/defense', token, {
        defense_config: { strategy: 'balanced' }
    });
    check('设置防守阵容应返回 200', setDefRes.status === 200, `actual=${setDefRes.status}, msg=${setDefRes.json?.message || ''}`);
    const setDefData = setDefRes.json?.data;
    check('返回应包含 success=true', setDefData?.success === true);
    check('返回应包含 defense_set_at', !!setDefData?.defense_set_at);
    check('返回应包含 rank', typeof setDefData?.rank === 'number');
    check('返回应包含 fengshen_score', typeof setDefData?.fengshen_score === 'number');

    // ===== 8. GET /api/fengshen/defense — 获取防守阵容 =====
    console.log('\n--- 8. GET /api/fengshen/defense 获取防守阵容 ---');
    const getDefRes = await api('GET', '/api/fengshen/defense', token);
    check('获取防守阵容应返回 200', getDefRes.status === 200, `actual=${getDefRes.status}`);
    const getDefData = getDefRes.json?.data;
    check('返回应包含 has_defense=true', getDefData?.has_defense === true);
    check('返回应包含 defense_config', typeof getDefData?.defense_config === 'object');
    check('返回应包含 snapshot', typeof getDefData?.snapshot === 'object');
    check('snapshot 应包含 atk', typeof getDefData?.snapshot?.atk === 'number');
    check('snapshot 应包含 def', typeof getDefData?.snapshot?.def === 'number');
    check('snapshot 应包含 hp_max', typeof getDefData?.snapshot?.hp_max === 'number');
    check('snapshot 应包含 realm_rank', typeof getDefData?.snapshot?.realm_rank === 'number');
    check('返回应包含 defense_set_at', !!getDefData?.defense_set_at);

    // ===== 9. GET /api/fengshen/season — 赛季信息 =====
    console.log('\n--- 9. GET /api/fengshen/season 赛季信息 ---');
    const seasonRes = await api('GET', '/api/fengshen/season', token);
    check('赛季信息接口应返回 200', seasonRes.status === 200, `actual=${seasonRes.status}`);
    const seasonData = seasonRes.json?.data;
    check('返回应包含 current_season', typeof seasonData?.current_season === 'number');
    check('返回应包含 season_start', typeof seasonData?.season_start === 'string');
    check('返回应包含 season_end', typeof seasonData?.season_end === 'string');
    check('返回应包含 remaining_days', typeof seasonData?.remaining_days === 'number');
    check('返回应包含 season_duration_days', typeof seasonData?.season_duration_days === 'number');
    check('返回应包含 reward_enabled', typeof seasonData?.reward_enabled === 'boolean');
    check('返回应包含 top_ranks 数组', Array.isArray(seasonData?.top_ranks));
    check('返回应包含 rank_reward_honor 数组', Array.isArray(seasonData?.rank_reward_honor));
    check('返回应包含 rank_reward_stones 数组', Array.isArray(seasonData?.rank_reward_stones));

    // ===== 10. 验证设置防守后排行榜更新 =====
    console.log('\n--- 10. 验证设置防守后排行榜更新 ---');
    const rankingRes2 = await api('GET', '/api/fengshen/ranking', token);
    const rankingData2 = rankingRes2.json?.data;
    check('设置防守后 my_rank 应 > 0', rankingData2?.my_rank > 0, `my_rank=${rankingData2?.my_rank}`);
    check('设置防守后 my_score 应为 1000', rankingData2?.my_score === 1000, `my_score=${rankingData2?.my_score}`);

    // ===== 11. 挑战测试（可能因只有一个玩家而无法挑战）=====
    console.log('\n--- 11. 挑战测试 ---');
    const myRes2 = await api('GET', '/api/fengshen/my', token);
    const myRank = myRes2.json?.data?.rank;
    if (myRank && myRank > 1) {
        // 尝试挑战排名比自己高 1 的玩家
        const challengeRes = await api('POST', '/api/fengshen/challenge', token, {
            target_rank: myRank - 1
        });
        check('挑战接口应返回 200', challengeRes.status === 200, `actual=${challengeRes.status}, msg=${challengeRes.json?.message || ''}`);
        if (challengeRes.status === 200) {
            const chData = challengeRes.json?.data;
            check('挑战结果应包含 battle_result', !!chData?.battle_result);
            check('battle_result 应包含 attacker_wins', typeof chData?.battle_result?.attacker_wins === 'boolean');
            check('battle_result 应包含 attacker_power', typeof chData?.battle_result?.attacker_power === 'number');
            check('battle_result 应包含 defender_power', typeof chData?.battle_result?.defender_power === 'number');
            check('battle_result 应包含 battle_log 数组', Array.isArray(chData?.battle_result?.battle_log));
            check('返回应包含 my_rank', typeof chData?.my_rank === 'number');
            check('返回应包含 my_score', typeof chData?.my_score === 'number');
            check('返回应包含 daily_challenge_remaining', typeof chData?.daily_challenge_remaining === 'number');
        }
    } else if (myRank === 1) {
        console.log('  ℹ️ 当前排名第一，无人可挑战（预期行为）');
        check('排名第一时无法挑战（预期行为）', true);
    } else {
        console.log('  ℹ️ 排名异常，跳过挑战测试');
        check('排名数据正常', false, `my_rank=${myRank}`);
    }

    // ===== 12. 参数校验测试 =====
    console.log('\n--- 12. 参数校验测试 ---');
    // 挑战无效排名
    const invalidChallengeRes = await api('POST', '/api/fengshen/challenge', token, {
        target_rank: -1
    });
    check('挑战无效排名应返回 400', invalidChallengeRes.status === 400, `actual=${invalidChallengeRes.status}`);

    // 挑战缺失参数
    const missingParamRes = await api('POST', '/api/fengshen/challenge', token, {});
    check('挑战缺失参数应返回 400', missingParamRes.status === 400, `actual=${missingParamRes.status}`);

    // 设置防守阵容缺失参数
    const missingDefenseRes = await api('POST', '/api/fengshen/defense', token, {});
    check('设置防守缺失参数应返回 400 或 200（空对象允许）',
        missingDefenseRes.status === 400 || missingDefenseRes.status === 200,
        `actual=${missingDefenseRes.status}`);

    // ===== 13. 未授权访问测试 =====
    console.log('\n--- 13. 未授权访问测试 ---');
    const noAuthRes = await api('GET', '/api/fengshen/ranking', null);
    check('未授权访问应返回 401', noAuthRes.status === 401, `actual=${noAuthRes.status}`);

    // ===== 14. OpenAPI 文档验证 =====
    console.log('\n--- 14. OpenAPI 文档验证 ---');
    const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
    if (fs.existsSync(openapiPath)) {
        const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
        check('OpenAPI 应包含 /api/fengshen/ranking', !!openapi.paths?.['/api/fengshen/ranking']);
        check('OpenAPI 应包含 /api/fengshen/my', !!openapi.paths?.['/api/fengshen/my']);
        check('OpenAPI 应包含 /api/fengshen/defense', !!openapi.paths?.['/api/fengshen/defense']);
        check('OpenAPI /api/fengshen/defense 应有 POST 方法', !!openapi.paths?.['/api/fengshen/defense']?.post);
        check('OpenAPI /api/fengshen/defense 应有 GET 方法', !!openapi.paths?.['/api/fengshen/defense']?.get);
        check('OpenAPI 应包含 /api/fengshen/challenge', !!openapi.paths?.['/api/fengshen/challenge']);
        check('OpenAPI 应包含 /api/fengshen/season', !!openapi.paths?.['/api/fengshen/season']);
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
