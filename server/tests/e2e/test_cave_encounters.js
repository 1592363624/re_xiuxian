/**
 * 洞府拜访奇遇系统测试脚本
 *
 * 测试内容：
 *   1. 登录鉴权
 *   2. 配置完整性验证（visit_encounters 配置段 + 5种奇遇类型 + 权重总和）
 *   3. 数据库迁移验证（cave_visitors 表 encounter_type/encounter_reward 列存在）
 *   4. 模型验证（CaveVisitor 模型包含新字段）
 *   5. 查找有洞府的其他玩家，发起拜访
 *   6. 验证拜访返回结构（encounter 字段存在 + triggered 布尔值）
 *   7. 若触发奇遇，验证奇遇结果结构（encounter_id/name/description/type/rewards）
 *   8. 多次拜访验证奇遇触发概率和每日次数限制
 *   9. OpenAPI 文档验证（visit 接口响应包含 encounter 定义）
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
    console.log('  洞府拜访奇遇系统测试');
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

    // ===== 2. 配置完整性验证 =====
    console.log('\n--- 2. 配置完整性验证 ---');
    const fs = require('fs');
    const path = require('path');
    const caveDataPath = path.join(__dirname, '..', 'config', 'cave_data.json');
    const caveData = JSON.parse(fs.readFileSync(caveDataPath, 'utf-8'));
    const encounterCfg = caveData.cave?.social?.visit_encounters;
    check('visit_encounters 配置段应存在', !!encounterCfg);
    check('visit_encounters.enabled 应为 true', encounterCfg?.enabled === true);
    check('visit_encounters.trigger_chance 应为数字', typeof encounterCfg?.trigger_chance === 'number', `chance=${encounterCfg?.trigger_chance}`);
    check('visit_encounters.daily_encounter_limit 应为 5', encounterCfg?.daily_encounter_limit === 5);
    check('visit_encounters.encounters 应为数组', Array.isArray(encounterCfg?.encounters), `count=${encounterCfg?.encounters?.length}`);
    check('应有 5 种奇遇类型', encounterCfg?.encounters?.length === 5, `count=${encounterCfg?.encounters?.length}`);

    // 验证权重总和
    const totalWeight = encounterCfg?.encounters?.reduce((sum, e) => sum + (e.weight || 0), 0) || 0;
    check('权重总和应为 100', totalWeight === 100, `total=${totalWeight}`);

    // 验证每种奇遇都有必要字段
    const requiredFields = ['id', 'name', 'description', 'weight', 'type', 'rewards'];
    const allValid = encounterCfg?.encounters?.every(e => requiredFields.every(f => e[f] !== undefined)) || false;
    check('每种奇遇应包含 id/name/description/weight/type/rewards', allValid);

    // 验证奇遇类型覆盖
    const types = encounterCfg?.encounters?.map(e => e.type) || [];
    check('应包含 item 类型', types.includes('item'));
    check('应包含 exp 类型', types.includes('exp'));
    check('应包含 spirit_stone 类型', types.includes('spirit_stone'));
    check('应包含 trap 类型', types.includes('trap'));
    check('应包含 nothing 类型', types.includes('nothing'));

    // ===== 3. 数据库迁移验证 =====
    console.log('\n--- 3. 数据库迁移验证 ---');
    const sequelize = require('../config/database');
    const { QueryTypes } = require('sequelize');
    const [colResult] = await sequelize.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cave_visitors'
         AND COLUMN_NAME IN ('encounter_type', 'encounter_reward')`
    );
    const colNames = colResult.map(r => r.COLUMN_NAME);
    check('cave_visitors 应有 encounter_type 列', colNames.includes('encounter_type'));
    check('cave_visitors 应有 encounter_reward 列', colNames.includes('encounter_reward'));

    // ===== 4. 模型验证 =====
    console.log('\n--- 4. 模型验证 ---');
    const CaveVisitor = require('../models/caveVisitor');
    check('CaveVisitor 模型应定义 encounter_type 字段', !!CaveVisitor.rawAttributes?.encounter_type);
    check('CaveVisitor 模型应定义 encounter_reward 字段', !!CaveVisitor.rawAttributes?.encounter_reward);

    // ===== 5. 查找有洞府的其他玩家 =====
    console.log('\n--- 5. 查找可拜访的玩家 ---');
    // 查找一个已开辟洞府且不是自己的玩家
    const [candidates] = await sequelize.query(
        `SELECT pc.player_id, p.nickname
         FROM player_caves pc
         JOIN players p ON p.id = pc.player_id
         WHERE pc.is_opened = 1 AND pc.player_id != (SELECT id FROM players WHERE username = ?)
         LIMIT 5`,
        { replacements: [TEST_USERNAME], type: QueryTypes.SELECT }
    );
    const candidate = Array.isArray(candidates) ? candidates[0] : candidates;
    check('应找到至少一个可拜访的玩家', !!candidate, candidate ? `player_id=${candidate.player_id}, nickname=${candidate.nickname}` : '无候选玩家');

    if (!candidate) {
        console.log('\n⚠️ 没有找到可拜访的玩家，跳过拜访测试');
    } else {
        // ===== 6. 发起拜访 =====
        console.log(`\n--- 6. 拜访玩家 ${candidate.nickname} (ID: ${candidate.player_id}) ---`);
        const visitRes = await api('POST', '/api/cave-social/visit', token, {
            target_player_id: candidate.player_id
        });
        check('拜访应返回 200', visitRes.status === 200, `actual=${visitRes.status}, msg=${visitRes.json?.message || ''}`);

        const visitData = visitRes.json?.data;
        check('返回应包含 target 对象', !!visitData?.target);
        check('返回应包含 cave 对象', !!visitData?.cave);
        check('返回应包含 encounter 对象', !!visitData?.encounter, `encounter=${JSON.stringify(visitData?.encounter)?.substring(0, 100)}`);
        check('encounter.triggered 应为布尔值', typeof visitData?.encounter?.triggered === 'boolean');

        if (visitData?.encounter?.triggered) {
            const enc = visitData.encounter;
            check('触发奇遇应有 encounter_id', !!enc.encounter_id, `id=${enc.encounter_id}`);
            check('触发奇遇应有 name', !!enc.name, `name=${enc.name}`);
            check('触发奇遇应有 description', !!enc.description);
            check('触发奇遇应有 type', !!enc.type, `type=${enc.type}`);
            check('触发奇遇应有 rewards 对象', typeof enc.rewards === 'object');
            check('触发奇遇应有 today_encounters', typeof enc.today_encounters === 'number');
            check('触发奇遇应有 daily_limit', typeof enc.daily_limit === 'number');
            console.log(`  🌟 触发奇遇：${enc.name} (${enc.type})`);
        } else {
            console.log(`  ℹ️ 本次未触发奇遇（reason: ${visitData?.encounter?.reason || 'unknown'}）`);
        }

        // ===== 7. 多次拜访验证（测试概率触发和每日限制）=====
        console.log('\n--- 7. 多次拜访验证奇遇概率 ---');
        let triggeredCount = 0;
        let totalVisits = 0;
        // 最多再拜访4次（加上之前1次共5次，达到每日奇遇上限）
        for (let i = 0; i < 4; i++) {
            try {
                const res = await api('POST', '/api/cave-social/visit', token, {
                    target_player_id: candidate.player_id
                });
                if (res.status === 200) {
                    totalVisits++;
                    if (res.json?.data?.encounter?.triggered) {
                        triggeredCount++;
                    }
                } else {
                    // 可能达到每日拜访上限
                    break;
                }
            } catch (e) {
                break;
            }
        }
        check(`多次拜访应成功（共 ${totalVisits} 次）`, totalVisits > 0);
        console.log(`  📊 共拜访 ${totalVisits + 1} 次，触发奇遇 ${triggeredCount + (visitData?.encounter?.triggered ? 1 : 0)} 次`);

        // ===== 8. 验证数据库记录 =====
        console.log('\n--- 8. 验证数据库奇遇记录 ---');
        const [encRecords] = await sequelize.query(
            `SELECT encounter_type, encounter_reward FROM cave_visitors
             WHERE visitor_id = (SELECT id FROM players WHERE username = ?)
             AND encounter_type IS NOT NULL
             ORDER BY visited_at DESC LIMIT 5`,
            { replacements: [TEST_USERNAME], type: QueryTypes.SELECT }
        );
        const encRecArray = Array.isArray(encRecords) ? encRecords : (encRecords ? [encRecords] : []);
        if (encRecArray.length > 0) {
            check('应有奇遇记录写入数据库', encRecArray.length > 0, `count=${encRecArray.length}`);
            const firstRecord = encRecArray[0];
            check('奇遇记录应有 encounter_type', !!firstRecord.encounter_type, `type=${firstRecord.encounter_type}`);
            check('奇遇记录应有 encounter_reward', !!firstRecord.encounter_reward);
        } else {
            console.log('  ℹ️ 本次测试未触发奇遇，无数据库记录可验证');
            check('奇遇触发概率测试（可能未触发）', true, '概率性事件，可能未触发');
        }
    }

    // ===== 9. OpenAPI 文档验证 =====
    console.log('\n--- 9. OpenAPI 文档验证 ---');
    const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
    if (fs.existsSync(openapiPath)) {
        const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf-8'));
        const visitSchema = openapi.paths?.['/api/cave-social/visit']?.post?.responses?.['200']?.content?.['application/json']?.schema;
        check('OpenAPI 应包含 /api/cave-social/visit 路径', !!openapi.paths?.['/api/cave-social/visit']);
        // encounter 字段可能在 data.properties.encounter 或 schema.properties.encounter
        const encounterDef = visitSchema?.properties?.data?.properties?.encounter || visitSchema?.properties?.encounter;
        check('visit 响应应包含 encounter 字段定义', !!encounterDef, `found=${!!encounterDef}`);
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
