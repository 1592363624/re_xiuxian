/**
 * MP/HP 恢复机制 HTTP 集成测试
 *
 * 测试目标：
 *   1. 验证登录时根据 last_online 自动恢复离线 HP/MP
 *   2. 验证闭关结算后 HP/MP 恢复满值
 *
 * 测试流程：
 *   场景A：离线恢复
 *     1. 通过数据库直接设置 player.mp_current=0, hp_current=低值, last_online=10分钟前
 *     2. 调用登录接口
 *     3. 查询数据库验证 mp_current 和 hp_current 是否恢复
 *
 *   场景B：闭关结算恢复满 HP/MP
 *     1. 登录获取 token
 *     2. 通过数据库设置 mp_current=0, hp_current=低值
 *     3. 调用 /api/seclusion/start 开始常规闭关（短时长）
 *     4. 调用 /api/seclusion/end 结束闭关
 *     5. 验证响应中 hp_restored/mp_restored > 0
 *     6. 验证数据库中 hp_current/mp_current 已恢复到满值
 *
 * 运行方式：
 *   cd server && node scripts/test_mp_recovery_http.js
 */
'use strict';

const sequelize = require('../config/database');
const Player = require('../models/player');
const { initializeModules } = require('../modules');
const game = require('../game');

const BASE_URL = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

const testResults = { passed: 0, failed: 0, total: 0 };

function assert(condition, message, extra = null) {
    testResults.total++;
    if (condition) {
        testResults.passed++;
        console.log(`  ✅ ${message}`);
    } else {
        testResults.failed++;
        console.error(`  ❌ ${message}`);
        if (extra) console.error('     附加信息:', JSON.stringify(extra, null, 2));
    }
}

/**
 * HTTP 请求封装（使用 Node 18+ 内置 fetch）
 */
async function http(method, path, body = null, token = null) {
    const url = `${BASE_URL}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const resp = await fetch(url, options);
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
    return { status: resp.status, body: json };
}

async function main() {
    console.log('========================================');
    console.log('  MP/HP 恢复机制 HTTP 集成测试');
    console.log('========================================');

    await initializeModules();
    const configLoader = require('../modules/infrastructure/ConfigLoader');
    await game.initializeGameServices(configLoader);

    // 获取测试玩家
    const player = await Player.findByPk(1);
    if (!player) {
        console.error('未找到测试玩家');
        process.exit(1);
    }

    // 计算预期上限
    const AttributeMaxService = require('../game/core/AttributeMaxService');
    const RealmService = require('../game/core/RealmService');
    const realmConfig = RealmService.getRealmByName(player.realm);
    const maxValues = AttributeMaxService.calculateAttributeMaxValues(player, realmConfig);
    const maxHp = maxValues.hp_max;
    const maxMp = maxValues.mp_max;
    console.log(`\n玩家: ${player.nickname} 境界: ${player.realm}`);
    console.log(`预期上限: HP=${maxHp} MP=${maxMp}`);

    // ========== 场景A: 离线恢复 ==========
    console.log('\n[场景A] 离线恢复测试');
    console.log('  步骤1: 通过数据库设置 MP=0, HP=100, last_online=10分钟前');

    // 取消任何闭关状态
    player.is_secluded = false;
    player.seclusion_start_time = null;
    player.seclusion_end_time = null;
    player.seclusion_duration = 0;
    player.seclusion_mode = 'normal';
    // 设置低 HP/MP
    player.hp_current = 100n;
    player.mp_current = 0n;
    // 设置 last_online 为 10 分钟前
    player.last_online = new Date(Date.now() - 10 * 60 * 1000);
    await player.save();

    console.log('  步骤2: 调用登录接口');
    const loginResp = await http('POST', '/api/auth/login', {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });

    assert(loginResp.status === 200, `登录应返回 200`, { actual: loginResp.status, body: loginResp.body });
    if (loginResp.status !== 200) {
        console.error('登录失败，终止测试');
        process.exit(1);
    }
    const token = loginResp.body.token;
    assert(!!token, '应返回 token', { hasToken: !!token });

    console.log('  步骤3: 查询数据库验证 MP/HP 恢复');
    // 等待 500ms 让 player.save() 完成
    await new Promise(r => setTimeout(r, 500));
    const playerAfterLogin = await Player.findByPk(1);
    const hpAfter = Number(playerAfterLogin.hp_current);
    const mpAfter = Number(playerAfterLogin.mp_current);
    console.log(`  结果: HP 100→${hpAfter}, MP 0→${mpAfter}`);

    // 离线 10 分钟，自然恢复速率 HP=1/分钟，MP=1/分钟
    // 但 HP 上限 3500，从 100 恢复 10 分钟=10，应为 110
    // MP 上限 100000，从 0 恢复 10，应为 10
    assert(mpAfter === 10, 'MP 应恢复 10（10分钟×1/分钟）', { actual: mpAfter, expected: 10 });
    assert(hpAfter === 110, 'HP 应恢复 10（100+10=110）', { actual: hpAfter, expected: 110 });

    // ========== 场景B: 闭关结算恢复满 HP/MP ==========
    console.log('\n[场景B] 闭关结算恢复满 HP/MP 测试');
    console.log('  步骤1: 通过数据库设置 MP=100, HP=200（低值）');
    player.hp_current = 200n;
    player.mp_current = 100n;
    // 清除闭关冷却
    player.last_seclusion_time = null;
    player.daily_seclusion_count = 0;
    player.last_seclusion_date = null;
    await player.save();

    console.log('  步骤2: 查询闭关状态');
    const seclusionStatusResp = await http('GET', '/api/seclusion/status', null, token);
    assert(seclusionStatusResp.status === 200, '闭关状态查询应返回 200', { status: seclusionStatusResp.status });

    console.log('  步骤3: 开始常规闭关（最短时长）');
    const startResp = await http('POST', '/api/seclusion/start', {
        mode: 'normal',
        duration: 60  // 1 分钟
    }, token);
    assert(startResp.status === 200, '开始闭关应返回 200', { status: startResp.status, body: startResp.body });

    if (startResp.status === 200) {
        console.log('  步骤4: 立即结束闭关（强行出关）');
        const endResp = await http('POST', '/api/seclusion/end', {}, token);
        assert(endResp.status === 200, '结束闭关应返回 200', { status: endResp.status, body: endResp.body });

        if (endResp.status === 200) {
            console.log(`  响应: ${JSON.stringify(endResp.body, null, 2)}`);

            // 验证响应中包含 hp_restored / mp_restored 字段（在 data 子对象里）
            const endData = endResp.body.data || {};
            assert(endData.hp_restored !== undefined, '响应应包含 data.hp_restored 字段', { hasField: 'hp_restored' in endData });
            assert(endData.mp_restored !== undefined, '响应应包含 data.mp_restored 字段', { hasField: 'mp_restored' in endData });

            // 验证恢复量
            const hpRestored = endData.hp_restored || 0;
            const mpRestored = endData.mp_restored || 0;
            console.log(`  恢复量: HP +${hpRestored}, MP +${mpRestored}`);
            assert(hpRestored > 0, 'HP 恢复量应 > 0', { actual: hpRestored });
            assert(mpRestored > 0, 'MP 恢复量应 > 0', { actual: mpRestored });

            // 验证数据库中 HP/MP 是否已恢复到满值
            await new Promise(r => setTimeout(r, 500));
            const playerAfterSeclusion = await Player.findByPk(1);
            const hpFinal = Number(playerAfterSeclusion.hp_current);
            const mpFinal = Number(playerAfterSeclusion.mp_current);
            console.log(`  最终: HP=${hpFinal}/${maxHp}, MP=${mpFinal}/${maxMp}`);
            assert(hpFinal === maxHp, `HP 应恢复到满值 ${maxHp}`, { actual: hpFinal, expected: maxHp });
            assert(mpFinal === maxMp, `MP 应恢复到满值 ${maxMp}`, { actual: mpFinal, expected: maxMp });
        }
    }

    // ========== 测试结果汇总 ==========
    console.log('\n========================================');
    console.log(`  测试结果: ${testResults.passed}/${testResults.total} 通过, ${testResults.failed} 失败`);
    console.log('========================================');

    await sequelize.close();
    process.exit(testResults.failed === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('测试执行失败:', err);
    process.exit(1);
});
