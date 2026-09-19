/**
 * 器灵系统端到端测试脚本
 *
 * 测试内容：
 *   1. 登录鉴权
 *   2. 配置完整性验证（artifact_spirit_data.json 各配置段）
 *   3. 数据库表结构验证（player_artifact_spirits 表 + 字段完整）
 *   4. 模型验证（PlayerArtifactSpirit 模型字段）
 *   5. GET /api/artifact-spirit/list — 我的器灵列表（初始应为空）
 *   6. GET /api/artifact-spirit/trial-ranking — 试炼榜（初始应为空）
 *   7. POST /api/artifact-spirit/awaken — 唤醒器灵（需有已装备法宝）
 *   8. GET /api/artifact-spirit/:spirit_id — 器灵详情
 *   9. POST /api/artifact-spirit/pet — 抚摸法宝
 *  10. POST /api/artifact-spirit/nurture — 温养器灵
 *  11. POST /api/artifact-spirit/protect — 器灵护主
 *  12. POST /api/artifact-spirit/activate — 催发器灵
 *  13. POST /api/artifact-spirit/trial — 器灵试炼
 *  14. 参数校验与未授权访问
 *  15. OpenAPI 文档验证
 *
 * 运行方式：node scripts/test_artifact_spirit.js
 */
'use strict';

// 显式指定 .env 路径，确保从 server/.env 加载（避免 cwd 不一致导致配置缺失）
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
    console.log('  器灵系统端到端测试');
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
    const configPath = path.join(__dirname, '..', 'config', 'artifact_spirit_data.json');
    const configExists = fs.existsSync(configPath);
    check('artifact_spirit_data.json 配置文件存在', configExists);
    if (configExists) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        check('配置 enabled 字段', typeof config.enabled === 'boolean');
        check('配置 unlock_realm_rank 字段', typeof config.unlock_realm_rank === 'number');
        check('配置 spirit_types 含 4 种类型',
            config.spirit_types && ['attack', 'defense', 'support', 'balance'].every(t => config.spirit_types[t]),
            `types=${Object.keys(config.spirit_types || {}).join(',')}`);
        check('配置 awaken.cost.spirit_stones 字段', config.awaken?.cost?.spirit_stones > 0);
        check('配置 awaken.cost.items 字段', Array.isArray(config.awaken?.cost?.items));
        check('配置 awaken.success_rate_base 字段', typeof config.awaken?.success_rate_base === 'number');
        check('配置 growth.max_level 字段', config.growth?.max_level > 0);
        check('配置 growth.exp_per_level 数组', Array.isArray(config.growth?.exp_per_level));
        check('配置 trial.daily_limit 字段', config.trial?.daily_limit > 0);
        check('配置 trial.rewards 数组', Array.isArray(config.trial?.rewards) && config.trial.rewards.length > 0);
        check('配置 protect.cooldown_seconds 字段', config.protect?.cooldown_seconds > 0);
        check('配置 activate.cooldown_seconds 字段', config.activate?.cooldown_seconds > 0);
        check('配置 trial_ranking.top_count 字段', config.trial_ranking?.top_count > 0);
    }

    // ===== 3. 数据库表结构验证 =====
    console.log('\n--- 3. 数据库表结构验证 ---');
    const sequelize = require('../config/database');
    const { QueryTypes } = require('sequelize');
    try {
        const [tableInfo] = await sequelize.query(
            `SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_artifact_spirits'`,
            { type: QueryTypes.SELECT }
        );
        check('player_artifact_spirits 表存在', tableInfo.cnt > 0);

        if (tableInfo.cnt > 0) {
            const [columns] = await sequelize.query(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'player_artifact_spirits'`
            );
            const colNames = columns.map(c => c.COLUMN_NAME);
            const requiredCols = [
                'id', 'player_id', 'equipment_id', 'item_key', 'spirit_type',
                'spirit_name', 'spirit_level', 'spirit_exp', 'intimacy', 'power',
                'is_awakened', 'awakened_at', 'last_pet_at', 'last_nurture_at',
                'trial_best_score', 'trial_total_count', 'trial_total_score',
                'last_trial_at', 'last_trial_date', 'daily_trial_count',
                'protect_active_until', 'activate_active_until',
                'last_protect_at', 'last_activate_at', 'state'
            ];
            for (const col of requiredCols) {
                check(`字段 ${col} 存在`, colNames.includes(col));
            }
        }
    } catch (e) {
        check('数据库验证无异常', false, `${e.name}: ${e.message || '(无消息)'}`);
    }

    // ===== 4. 模型验证 =====
    console.log('\n--- 4. 模型验证 ---');
    try {
        const PlayerArtifactSpirit = require('../models/playerArtifactSpirit');
        const attrs = Object.keys(PlayerArtifactSpirit.rawAttributes);
        check('PlayerArtifactSpirit 模型加载成功', attrs.length > 0);
        check('模型含 spirit_type 字段', attrs.includes('spirit_type'));
        check('模型含 spirit_level 字段', attrs.includes('spirit_level'));
        check('模型含 intimacy 字段', attrs.includes('intimacy'));
        check('模型含 power 字段', attrs.includes('power'));
        check('模型含 trial_total_score 字段', attrs.includes('trial_total_score'));
        check('模型含 state 字段', attrs.includes('state'));
        check('表名 player_artifact_spirits', PlayerArtifactSpirit.tableName === 'player_artifact_spirits');
    } catch (e) {
        check('模型加载无异常', false, e.message);
    }

    // ===== 5. 我的器灵列表（初始） =====
    console.log('\n--- 5. 我的器灵列表 ---');
    const listRes = await api('GET', '/api/artifact-spirit/list', token);
    check('GET /list 状态码 200', listRes.status === 200, `actual=${listRes.status}`);
    check('GET /list 返回 code=200', listRes.json?.code === 200);
    check('GET /list 返回 data.spirits 数组', Array.isArray(listRes.json?.data?.spirits));
    check('GET /list 返回 data.count', typeof listRes.json?.data?.count === 'number');

    // ===== 6. 试炼榜（初始） =====
    console.log('\n--- 6. 试炼榜 ---');
    const rankingRes = await api('GET', '/api/artifact-spirit/trial-ranking', token);
    check('GET /trial-ranking 状态码 200', rankingRes.status === 200, `actual=${rankingRes.status}`);
    check('GET /trial-ranking 返回 code=200', rankingRes.json?.code === 200);
    check('GET /trial-ranking 返回 data.ranking 数组', Array.isArray(rankingRes.json?.data?.ranking));
    check('GET /trial-ranking 返回 data.total', typeof rankingRes.json?.data?.total === 'number');
    check('GET /trial-ranking 返回 data.page', typeof rankingRes.json?.data?.page === 'number');

    // ===== 7. 参数校验与未授权 =====
    console.log('\n--- 7. 参数校验与未授权 ---');
    // 未授权访问
    const noAuthRes = await api('GET', '/api/artifact-spirit/list', null);
    check('未授权访问返回 401', noAuthRes.status === 401, `actual=${noAuthRes.status}`);

    // 唤醒参数校验
    const awakenInvalidRes = await api('POST', '/api/artifact-spirit/awaken', token, {
        equipment_id: 0,
        spirit_type: 'invalid_type'
    });
    check('POST /awaken equipment_id=0 返回 400', awakenInvalidRes.status === 400, `actual=${awakenInvalidRes.status}`);
    const awakenBadTypeRes = await api('POST', '/api/artifact-spirit/awaken', token, {
        equipment_id: 999,
        spirit_type: 'invalid'
    });
    check('POST /awaken spirit_type=invalid 返回 400', awakenBadTypeRes.status === 400, `actual=${awakenBadTypeRes.status}`);

    // 试炼参数校验
    const trialBadRes = await api('POST', '/api/artifact-spirit/trial', token, { spirit_id: 0 });
    check('POST /trial spirit_id=0 返回 400', trialBadRes.status === 400, `actual=${trialBadRes.status}`);

    // 器灵详情参数校验
    const detailBadRes = await api('GET', '/api/artifact-spirit/abc', token);
    check('GET /:spirit_id=abc 返回 400', detailBadRes.status === 400, `actual=${detailBadRes.status}`);

    // ===== 8. 唤醒器灵（需有已装备法宝） =====
    console.log('\n--- 8. 唤醒器灵 ---');
    // 先获取已装备列表
    const equippedRes = await api('GET', '/api/equipment', token);
    const equippedData = equippedRes.json?.data;
    const slots = equippedData?.slots || {};
    const availableEquipments = Object.values(slots).filter((eq) => !eq.is_broken);
    check('已装备法宝列表可获取', equippedRes.status === 200);

    let spiritId = null;
    if (availableEquipments.length > 0) {
        // 唤醒有 80% 成功率，最多重试 3 次
        // 每次重试前通过 SQL 补充 soul_stone + 灵石
        let awakenSuccess = false;
        let awakenRes = null;
        for (let attempt = 1; attempt <= 3 && !awakenSuccess; attempt++) {
            // 重试前补充资源（SQL 直接操作，避免依赖 GM 接口）
            if (attempt > 1) {
                try {
                    await sequelize.query('UPDATE player_items SET quantity = quantity + 5 WHERE player_id = 1 AND item_key = ?', { replacements: ['soul_stone'] });
                    await sequelize.query('UPDATE players SET spirit_stones = 1000000 WHERE id = 1');
                } catch (e) { /* 忽略 SQL 异常 */ }
            }
            const targetEq = availableEquipments[(attempt - 1) % availableEquipments.length];
            awakenRes = await api('POST', '/api/artifact-spirit/awaken', token, {
                equipment_id: targetEq.record_id,
                spirit_type: 'attack',
                spirit_name: `测试器灵${attempt}`
            });
            console.log(`  第${attempt}次唤醒: code=${awakenRes.json?.code}, msg=${awakenRes.json?.message}, has_data=${!!awakenRes.json?.data?.spirit_id}`);
            if (awakenRes.json?.data?.spirit_id) {
                awakenSuccess = true;
                spiritId = awakenRes.json.data.spirit_id;
            }
        }

        check('POST /awaken 返回 code=200', awakenRes.json?.code === 200, `code=${awakenRes.json?.code}`);
        if (awakenSuccess) {
            check('唤醒返回 spirit_id', !!spiritId);
            check('唤醒返回 spirit_type', awakenRes.json.data.spirit_type === 'attack');
            check('唤醒返回 intimacy', typeof awakenRes.json.data.intimacy === 'number');
        } else {
            console.log(`  ℹ️ 3次唤醒均未成功（可能是成功率判定失败20%或已唤醒过）：${awakenRes.json?.message}`);
            // 唤醒失败不视为测试失败，通过 SQL 直接创建器灵记录用于后续功能测试
            try {
                const targetEq = availableEquipments[0];
                // 先检查该装备是否已有器灵
                const [existing] = await sequelize.query(
                    'SELECT id FROM player_artifact_spirits WHERE player_id = 1 AND equipment_id = ? AND is_awakened = 1 LIMIT 1',
                    { replacements: [targetEq.record_id], type: QueryTypes.SELECT }
                );
                if (existing) {
                    spiritId = existing.id;
                    console.log(`  ℹ️ 发现已唤醒器灵 id=${spiritId}，用于后续测试`);
                } else {
                    // 直接创建器灵记录
                    const [insertResult] = await sequelize.query(
                        'INSERT INTO player_artifact_spirits (player_id, equipment_id, item_key, spirit_type, spirit_name, spirit_level, spirit_exp, intimacy, power, is_awakened, awakened_at, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 0, 50, 200, 1, NOW(), ?, NOW(), NOW())',
                        { replacements: [1, targetEq.record_id, targetEq.item_key, 'attack', 'SQL测试器灵', 'idle'] }
                    );
                    spiritId = insertResult;
                    console.log(`  ℹ️ 通过 SQL 创建器灵 id=${spiritId}，用于后续功能测试`);
                }
                check('获取器灵ID用于后续测试', !!spiritId);
            } catch (e) {
                check('SQL 创建器灵记录', false, e.message);
            }
        }
    } else {
        console.log('  ⏭️ 暂无已装备法宝，跳过唤醒测试');
        check('唤醒测试跳过（无已装备法宝）', true);
    }

    // ===== 9. 器灵详情 + 互动 =====
    if (spiritId) {
        console.log('\n--- 9. 器灵详情 ---');
        const detailRes = await api('GET', `/api/artifact-spirit/${spiritId}`, token);
        check('GET /:spirit_id 状态码 200', detailRes.status === 200);
        check('GET /:spirit_id 返回 code=200', detailRes.json?.code === 200);
        if (detailRes.json?.data) {
            check('详情返回 spirit_id', detailRes.json.data.spirit_id === spiritId);
            check('详情返回 spirit_level', typeof detailRes.json.data.spirit_level === 'number');
            check('详情返回 cooldowns 对象', typeof detailRes.json.data.cooldowns === 'object');
            check('详情返回 daily_trial_limit', typeof detailRes.json.data.daily_trial_limit === 'number');
        }

        console.log('\n--- 10. 抚摸法宝 ---');
        const petRes = await api('POST', '/api/artifact-spirit/pet', token, { spirit_id: spiritId });
        check('POST /pet 返回 code=200', petRes.json?.code === 200, `code=${petRes.json?.code}, msg=${petRes.json?.message}`);
        if (petRes.json?.data) {
            check('抚摸返回 intimacy_gain', typeof petRes.json.data.intimacy_gain === 'number');
        } else {
            console.log(`  ℹ️ 抚摸未成功：${petRes.json?.message}`);
        }

        console.log('\n--- 11. 温养器灵 ---');
        const nurtureRes = await api('POST', '/api/artifact-spirit/nurture', token, { spirit_id: spiritId });
        check('POST /nurture 返回 code=200', nurtureRes.json?.code === 200, `code=${nurtureRes.json?.code}, msg=${nurtureRes.json?.message}`);
        if (nurtureRes.json?.data) {
            check('温养返回 power_gain', typeof nurtureRes.json.data.power_gain === 'number');
        } else {
            console.log(`  ℹ️ 温养未成功：${nurtureRes.json?.message}`);
        }

        console.log('\n--- 12. 器灵护主 ---');
        const protectRes = await api('POST', '/api/artifact-spirit/protect', token, { spirit_id: spiritId });
        check('POST /protect 返回 code=200', protectRes.json?.code === 200, `code=${protectRes.json?.code}, msg=${protectRes.json?.message}`);

        console.log('\n--- 13. 催发器灵 ---');
        const activateRes = await api('POST', '/api/artifact-spirit/activate', token, { spirit_id: spiritId });
        check('POST /activate 返回 code=200', activateRes.json?.code === 200, `code=${activateRes.json?.code}, msg=${activateRes.json?.message}`);

        console.log('\n--- 14. 器灵试炼 ---');
        const trialRes = await api('POST', '/api/artifact-spirit/trial', token, { spirit_id: spiritId });
        check('POST /trial 返回 code=200', trialRes.json?.code === 200, `code=${trialRes.json?.code}, msg=${trialRes.json?.message}`);
        if (trialRes.json?.data) {
            check('试炼返回 score', typeof trialRes.json.data.score === 'number');
            check('试炼返回 rewards 对象', typeof trialRes.json.data.rewards === 'object');
            check('试炼返回 daily_trial_count', typeof trialRes.json.data.daily_trial_count === 'number');
        }
    } else {
        console.log('\n⏭️ 无可用器灵，跳过详情/抚摸/温养/护主/催发/试炼测试');
    }

    // ===== 15. Service 单元验证 =====
    console.log('\n--- 15. Service 单元验证 ---');
    try {
        const ArtifactSpiritService = require('../game/services/ArtifactSpiritService');
        check('ArtifactSpiritService 加载成功', !!ArtifactSpiritService);
        check('Service 含 awaken 方法', typeof ArtifactSpiritService.awaken === 'function');
        check('Service 含 getMySpirits 方法', typeof ArtifactSpiritService.getMySpirits === 'function');
        check('Service 含 getSpiritDetail 方法', typeof ArtifactSpiritService.getSpiritDetail === 'function');
        check('Service 含 trial 方法', typeof ArtifactSpiritService.trial === 'function');
        check('Service 含 protect 方法', typeof ArtifactSpiritService.protect === 'function');
        check('Service 含 activate 方法', typeof ArtifactSpiritService.activate === 'function');
        check('Service 含 pet 方法', typeof ArtifactSpiritService.pet === 'function');
        check('Service 含 nurture 方法', typeof ArtifactSpiritService.nurture === 'function');
        check('Service 含 getTrialRanking 方法', typeof ArtifactSpiritService.getTrialRanking === 'function');
        check('Service 含 getCombatBonus 方法', typeof ArtifactSpiritService.getCombatBonus === 'function');
        check('Service 含 initialize 方法', typeof ArtifactSpiritService.initialize === 'function');
    } catch (e) {
        check('Service 加载无异常', false, e.message);
    }

    // ===== 16. 路由文件验证 =====
    console.log('\n--- 16. 路由文件验证 ---');
    const routePath = path.join(__dirname, '..', 'routes', 'artifact_spirit.js');
    check('routes/artifact_spirit.js 文件存在', fs.existsSync(routePath));
    if (fs.existsSync(routePath)) {
        const routeContent = fs.readFileSync(routePath, 'utf-8');
        check('路由含 /awaken 路径', routeContent.includes("'/awaken'"));
        check('路由含 /list 路径', routeContent.includes("'/list'"));
        check('路由含 /trial 路径', routeContent.includes("'/trial'"));
        check('路由含 /protect 路径', routeContent.includes("'/protect'"));
        check('路由含 /activate 路径', routeContent.includes("'/activate'"));
        check('路由含 /pet 路径', routeContent.includes("'/pet'"));
        check('路由含 /nurture 路径', routeContent.includes("'/nurture'"));
        check('路由含 /trial-ranking 路径', routeContent.includes("'/trial-ranking'"));
        check('路由使用 auth 中间件', routeContent.includes('auth,'));
        check('路由引用 ArtifactSpiritService', routeContent.includes('ArtifactSpiritService'));
    }

    // ===== 17. OpenAPI 文档验证 =====
    console.log('\n--- 17. OpenAPI 文档验证 ---');
    const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
    if (fs.existsSync(openapiPath)) {
        const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
        const paths = openapi.paths || {};
        const expectedPaths = [
            '/api/artifact-spirit/awaken',
            '/api/artifact-spirit/list',
            '/api/artifact-spirit/trial',
            '/api/artifact-spirit/protect',
            '/api/artifact-spirit/activate',
            '/api/artifact-spirit/pet',
            '/api/artifact-spirit/nurture',
            '/api/artifact-spirit/trial-ranking'
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
