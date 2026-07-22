/**
 * 天机回溯（NascentSoulService.tianjiRevert）端到端测试
 *
 * 测试目标（参考需求文档第8节测试流程）：
 *   1. 登录获取 token
 *   2. 查询初始状态 GET /api/nascent-soul/status
 *   3. 直接调用天机回溯（应失败：无需回溯，玩家不虚弱且残魂>=50）
 *   4. GM 直接改库：设置 weakness_end_time 为未来 1 小时（模拟虚弱状态）
 *   5. 再次调用天机回溯（应成功）
 *   6. 验证：weakness_end_time 已清空 / remnant_soul 已恢复 / 灵石扣除 / 神识扣除 / daily_count=1
 *   7. 再次调用天机回溯（应失败：今日已使用 1 次）
 *   8. GM 重置 daily_tianji_revert_count = 0
 *   9. 立即再次调用天机回溯（应失败：冷却中）
 *  10. GM 设置 last_tianji_revert_time 为 2 小时前
 *  11. 再次调用天机回溯（应成功）
 *
 * 由于 admin PUT /api/admin/players/:id 接口字段白名单不包含 weakness_end_time /
 * last_tianji_revert_time / daily_tianji_revert_count，本测试直接通过 sequelize
 * 执行 SQL 修改这些字段（仅测试用途，生产环境应通过 GM 接口扩展）。
 *
 * 运行方式：node scripts/_test_tianji_revert.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const path = require('path');
const rootPath = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(rootPath, '.env') });

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

// 测试账号（由项目规则固定）
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';
const TEST_PLAYER_ID = 1; // 测试账号固定 playerId=1

// 测试结果统计
const stats = {
    total: 0,
    passed: 0,
    failed: 0,
    failedDetails: []
};

/**
 * 断言辅助函数
 * @param {boolean} condition - 条件
 * @param {string} message - 失败描述
 */
function assert(condition, message) {
    stats.total++;
    if (condition) {
        stats.passed++;
        console.log(`  ✓ ${message}`);
    } else {
        stats.failed++;
        stats.failedDetails.push(message);
        console.error(`  ✗ ${message}`);
    }
}

/**
 * 登录获取 token
 * @returns {Promise<string>} JWT token
 */
async function login() {
    const resp = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD })
    });
    const data = await resp.json();
    if (!data.token) {
        throw new Error(`登录失败: ${JSON.stringify(data)}`);
    }
    return data.token;
}

/**
 * 调用天机回溯接口
 * @param {string} token - JWT token
 * @returns {Promise<Object>} 响应数据
 */
async function callTianjiRevert(token) {
    const resp = await fetch(`${BASE_URL}/api/nascent-soul/tianji-revert`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });
    return resp.json();
}

/**
 * 查询元婴系统状态
 * @param {string} token - JWT token
 * @returns {Promise<Object>} 状态数据
 */
async function getStatus(token) {
    const resp = await fetch(`${BASE_URL}/api/nascent-soul/status`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    return resp.json();
}

/**
 * 直接读取玩家关键字段（绕过 ORM 缓存，确保数据库最新值）
 * @param {number} playerId - 玩家ID
 * @returns {Promise<Object>} 玩家关键字段
 */
async function readPlayerFields(playerId) {
    const [row] = await sequelize.query(
        `SELECT spirit_stones, weakness_end_time, remnant_soul,
                daily_tianji_revert_count, last_tianji_revert_date, last_tianji_revert_time,
                attributes
         FROM players WHERE id = :pid`,
        { replacements: { pid: playerId }, type: QueryTypes.SELECT }
    );
    if (!row) throw new Error(`玩家 ${playerId} 不存在`);
    // 解析 attributes JSON
    let attrs = {};
    try {
        attrs = typeof row.attributes === 'string' ? JSON.parse(row.attributes) : (row.attributes || {});
    } catch (e) { /* 忽略解析错误 */ }
    return {
        spirit_stones: BigInt(row.spirit_stones || 0),
        weakness_end_time: row.weakness_end_time,
        remnant_soul: Number(row.remnant_soul ?? 100),
        daily_tianji_revert_count: Number(row.daily_tianji_revert_count || 0),
        last_tianji_revert_date: row.last_tianji_revert_date,
        last_tianji_revert_time: row.last_tianji_revert_time,
        sense: Number(attrs.sense || 0)
    };
}

/**
 * 重置测试账号的天机回溯相关字段到干净状态
 * 在测试开始前调用，确保前次测试的残留状态不影响本次
 * 同时确保 sense 神识足够测试（>= 100），spirit_stones 灵石足够测试（>= 10000）
 * @param {number} playerId - 玩家ID
 */
async function resetTianjiState(playerId) {
    // 1. 重置天机回溯字段 + 清除虚弱
    await sequelize.query(
        `UPDATE players
         SET daily_tianji_revert_count = 0,
             last_tianji_revert_date = NULL,
             last_tianji_revert_time = NULL,
             weakness_end_time = NULL
         WHERE id = :pid`,
        { replacements: { pid: playerId }, type: QueryTypes.UPDATE }
    );

    // 2. 读取当前 attributes JSON，更新 sense 至 200（保证测试期间足够），写回数据库
    const [row] = await sequelize.query(
        `SELECT attributes FROM players WHERE id = :pid`,
        { replacements: { pid: playerId }, type: QueryTypes.SELECT }
    );
    let attrs = {};
    try {
        attrs = typeof row.attributes === 'string' ? JSON.parse(row.attributes) : (row.attributes || {});
    } catch (e) { /* 忽略 */ }
    attrs.sense = 200; // 提升至 200，足够测试 4 次天机回溯（每次消耗 50）
    await sequelize.query(
        `UPDATE players SET attributes = :attrs WHERE id = :pid`,
        { replacements: { attrs: JSON.stringify(attrs), pid: playerId }, type: QueryTypes.UPDATE }
    );

    // 3. 确保灵石 >= 100000（避免历史测试数据消耗后余额不足）
    await sequelize.query(
        `UPDATE players SET spirit_stones = GREATEST(spirit_stones, 100000) WHERE id = :pid`,
        { replacements: { pid: playerId }, type: QueryTypes.UPDATE }
    );

    console.log('[准备] 已重置测试账号天机回溯字段 + sense=200 + 灵石≥100000');
}

/**
 * 直接修改玩家字段（GM 模拟）
 * @param {number} playerId - 玩家ID
 * @param {Object} fields - 要更新的字段键值对
 */
async function gmUpdatePlayer(playerId, fields) {
    const setClauses = [];
    const replacements = { pid: playerId };
    for (const [key, value] of Object.entries(fields)) {
        if (value === null) {
            setClauses.push(`${key} = NULL`);
        } else {
            setClauses.push(`${key} = :${key}`);
            replacements[key] = value;
        }
    }
    if (setClauses.length === 0) return;
    await sequelize.query(
        `UPDATE players SET ${setClauses.join(', ')} WHERE id = :pid`,
        { replacements, type: QueryTypes.UPDATE }
    );
}

/**
 * 主测试流程
 */
async function runTests() {
    console.log('='.repeat(80));
    console.log('[天机回溯] 端到端测试开始');
    console.log('='.repeat(80));

    // ============ 步骤1：登录 ============
    console.log('\n[步骤1] 登录测试账号...');
    const token = await login();
    assert(!!token, '登录成功获取 token');
    console.log(`  token: ${token.substring(0, 30)}...`);

    // ============ 准备：重置测试账号天机回溯状态 ============
    console.log('\n[准备] 重置测试账号天机回溯状态...');
    await resetTianjiState(TEST_PLAYER_ID);

    // ============ 步骤2：查询初始状态 ============
    console.log('\n[步骤2] 查询初始状态 GET /api/nascent-soul/status...');
    const initialStatus = await getStatus(token);
    assert(initialStatus.code === 200, '查询状态接口返回 200');
    const tianjiStatus = initialStatus.data?.tianji_revert;
    assert(!!tianjiStatus, '状态中包含 tianji_revert 字段');
    if (tianjiStatus) {
        console.log(`  天机回溯状态: available=${tianjiStatus.available}, daily_count=${tianjiStatus.daily_count}, daily_limit=${tianjiStatus.daily_limit}`);
        console.log(`  冷却: ready=${tianjiStatus.cooldown_ready}, remaining_sec=${tianjiStatus.cooldown_remaining_sec}`);
        console.log(`  消耗: 灵石=${tianjiStatus.spirit_stone_cost}, 神识=${tianjiStatus.divine_sense_cost}`);
        console.log(`  残魂恢复值: ${tianjiStatus.remnant_soul_restore_value}, 阈值: ${tianjiStatus.min_remnant_soul_threshold}`);
        assert(tianjiStatus.available === true, '测试账号(化神初期 rank=23)应满足天机回溯境界要求');
        assert(tianjiStatus.daily_count === 0, '初始 daily_count 应为 0');
        assert(tianjiStatus.cooldown_ready === true, '初始冷却应已就绪');
        assert(tianjiStatus.spirit_stone_cost === 5000, '灵石消耗应为 5000');
        assert(tianjiStatus.divine_sense_cost === 50, '神识消耗应为 50');
        assert(tianjiStatus.daily_limit === 1, '每日上限应为 1');
    }

    // ============ 步骤3：直接调用天机回溯（应失败：无需回溯） ============
    console.log('\n[步骤3] 直接调用天机回溯（应失败：无需回溯）...');
    const beforeFields = await readPlayerFields(TEST_PLAYER_ID);
    console.log(`  当前状态: weakness_end_time=${beforeFields.weakness_end_time}, remnant_soul=${beforeFields.remnant_soul}`);

    // 确保残魂 >= 50 以触发"无需回溯"分支
    if (beforeFields.remnant_soul < 50) {
        await gmUpdatePlayer(TEST_PLAYER_ID, { remnant_soul: 100 });
        console.log('  已将残魂临时设置为 100 以触发"无需回溯"分支');
    }

    const result1 = await callTianjiRevert(token);
    console.log(`  响应: code=${result1.code}, success=${result1.success}, message=${result1.message}`);
    assert(result1.success === false, '应返回 success=false（无需回溯）');
    assert(result1.message && result1.message.includes('无需回溯'), '消息应包含"无需回溯"');

    // ============ 步骤4：GM 设置虚弱状态 ============
    console.log('\n[步骤4] GM 直接改库：设置 weakness_end_time 为未来 1 小时...');
    const weakEndTime = new Date(Date.now() + 3600 * 1000);
    await gmUpdatePlayer(TEST_PLAYER_ID, { weakness_end_time: weakEndTime });
    console.log(`  已设置 weakness_end_time = ${weakEndTime.toISOString()}`);

    // ============ 步骤5：再次调用天机回溯（应成功） ============
    console.log('\n[步骤5] 再次调用天机回溯（应成功）...');
    const beforeFields2 = await readPlayerFields(TEST_PLAYER_ID);
    console.log(`  操作前: 灵石=${beforeFields2.spirit_stones.toString()}, 神识=${beforeFields2.sense}, 残魂=${beforeFields2.remnant_soul}, weakness_end_time=${beforeFields2.weakness_end_time}`);

    const result2 = await callTianjiRevert(token);
    console.log(`  响应: code=${result2.code}, success=${result2.success}, message=${result2.message}`);
    // 路由层 sendServiceResult 在成功响应中不包含 success 字段（仅失败时返回 success:false）
    // 因此使用 success !== false 判定成功
    assert(result2.success !== false, `天机回溯应成功: ${result2.message}`);

    // ============ 步骤6：验证字段变化 ============
    console.log('\n[步骤6] 验证字段变化...');
    const afterFields = await readPlayerFields(TEST_PLAYER_ID);
    console.log(`  操作后: 灵石=${afterFields.spirit_stones.toString()}, 神识=${afterFields.sense}, 残魂=${afterFields.remnant_soul}, weakness_end_time=${afterFields.weakness_end_time}`);

    // 6.1 虚弱已清除
    assert(afterFields.weakness_end_time === null, `weakness_end_time 应清空，实际 ${afterFields.weakness_end_time}`);

    // 6.2 残魂恢复到 80（如已 >= 80 则保持原值，但这里 before 应该是 100，max(80, 100)=100）
    // 注：根据需求文档"残魂恢复到 80（基础值，配置可调）"，代码实现是 Math.max(80, before)
    // 由于步骤3前面可能将残魂设为 100，所以 after 应保持 100
    assert(afterFields.remnant_soul >= 80, `残魂应至少为 80，实际 ${afterFields.remnant_soul}`);

    // 6.3 灵石扣除 5000
    const expectedStones = beforeFields2.spirit_stones - BigInt(5000);
    assert(afterFields.spirit_stones === expectedStones,
        `灵石应扣除 5000，预期 ${expectedStones.toString()}，实际 ${afterFields.spirit_stones.toString()}`);

    // 6.4 神识扣除 50
    const expectedSense = beforeFields2.sense - 50;
    assert(afterFields.sense === expectedSense,
        `神识应扣除 50，预期 ${expectedSense}，实际 ${afterFields.sense}`);

    // 6.5 daily_count = 1
    assert(afterFields.daily_tianji_revert_count === 1,
        `daily_tianji_revert_count 应为 1，实际 ${afterFields.daily_tianji_revert_count}`);

    // 6.6 last_tianji_revert_date 为今日
    const today = new Date().toISOString().slice(0, 10);
    const lastDateStr = afterFields.last_tianji_revert_date instanceof Date
        ? afterFields.last_tianji_revert_date.toISOString().slice(0, 10)
        : String(afterFields.last_tianji_revert_date).slice(0, 10);
    assert(lastDateStr === today, `last_tianji_revert_date 应为今日 ${today}，实际 ${lastDateStr}`);

    // 6.7 last_tianji_revert_time 不为空
    assert(!!afterFields.last_tianji_revert_time, 'last_tianji_revert_time 应已设置');

    // 6.8 验证响应 data
    if (result2.data) {
        console.log(`  响应 data: ${JSON.stringify(result2.data, null, 2).substring(0, 500)}`);
        assert(result2.data.weakness_cleared === true, '响应 data.weakness_cleared 应为 true');
        assert(result2.data.daily_count === 1, '响应 data.daily_count 应为 1');
        assert(result2.data.daily_limit === 1, '响应 data.daily_limit 应为 1');
        assert(result2.data.spirit_stone_cost === 5000, '响应 data.spirit_stone_cost 应为 5000');
        assert(result2.data.divine_sense_cost === 50, '响应 data.divine_sense_cost 应为 50');
    }

    // ============ 步骤7：再次调用天机回溯（应失败：每日上限） ============
    console.log('\n[步骤7] 再次调用天机回溯（应失败：今日已使用 1 次）...');
    const result3 = await callTianjiRevert(token);
    console.log(`  响应: code=${result3.code}, success=${result3.success}, message=${result3.message}`);
    assert(result3.success === false, '应返回 success=false（每日上限）');
    assert(result3.message && result3.message.includes('今日已使用'), '消息应包含"今日已使用"');

    // ============ 步骤8：GM 重置 daily_count = 0 ============
    console.log('\n[步骤8] GM 重置 daily_tianji_revert_count = 0...');
    await gmUpdatePlayer(TEST_PLAYER_ID, { daily_tianji_revert_count: 0 });
    console.log('  已重置 daily_tianji_revert_count = 0');

    // ============ 步骤9：立即调用天机回溯（应失败：冷却中） ============
    console.log('\n[步骤9] 立即调用天机回溯（应失败：冷却中）...');
    const result4 = await callTianjiRevert(token);
    console.log(`  响应: code=${result4.code}, success=${result4.success}, message=${result4.message}`);
    assert(result4.success === false, '应返回 success=false（冷却中）');
    assert(result4.message && result4.message.includes('冷却中'), '消息应包含"冷却中"');

    // ============ 步骤10：GM 设置 last_tianji_revert_time 为 2 小时前 ============
    // 同时重新设置虚弱状态，确保步骤11满足"虚弱或残魂<50"触发条件
    // （前一次天机回溯已清除虚弱+残魂恢复到80，不再满足触发条件）
    console.log('\n[步骤10] GM 设置 last_tianji_revert_time 为 2 小时前 + 重新设置虚弱状态...');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const weakEndTime2 = new Date(Date.now() + 3600 * 1000);
    await gmUpdatePlayer(TEST_PLAYER_ID, {
        last_tianji_revert_time: twoHoursAgo,
        weakness_end_time: weakEndTime2
    });
    console.log(`  已设置 last_tianji_revert_time = ${twoHoursAgo.toISOString()}`);
    console.log(`  已设置 weakness_end_time = ${weakEndTime2.toISOString()}（重新触发虚弱）`);

    // ============ 步骤11：再次调用天机回溯（应成功） ============
    console.log('\n[步骤11] 再次调用天机回溯（应成功）...');
    const beforeFields3 = await readPlayerFields(TEST_PLAYER_ID);
    console.log(`  操作前: 灵石=${beforeFields3.spirit_stones.toString()}, 神识=${beforeFields3.sense}, 残魂=${beforeFields3.remnant_soul}`);

    const result5 = await callTianjiRevert(token);
    console.log(`  响应: code=${result5.code}, success=${result5.success}, message=${result5.message}`);
    assert(result5.success !== false, `冷却后再次天机回溯应成功: ${result5.message}`);

    // 验证 daily_count 又变回 1
    const afterFields2 = await readPlayerFields(TEST_PLAYER_ID);
    assert(afterFields2.daily_tianji_revert_count === 1,
        `daily_tianji_revert_count 应再次为 1，实际 ${afterFields2.daily_tianji_revert_count}`);

    // 验证灵石再次扣除
    const expectedStones2 = beforeFields3.spirit_stones - BigInt(5000);
    assert(afterFields2.spirit_stones === expectedStones2,
        `灵石应再次扣除 5000，预期 ${expectedStones2.toString()}，实际 ${afterFields2.spirit_stones.toString()}`);

    // ============ 测试总结 ============
    console.log('\n' + '='.repeat(80));
    console.log('[测试总结]');
    console.log('='.repeat(80));
    console.log(`  总断言数: ${stats.total}`);
    console.log(`  通过: ${stats.passed}`);
    console.log(`  失败: ${stats.failed}`);
    if (stats.failedDetails.length > 0) {
        console.log('\n失败详情:');
        stats.failedDetails.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
    }
    console.log('='.repeat(80));

    return stats.failed === 0;
}

// 主入口
(async () => {
    try {
        const ok = await runTests();
        process.exit(ok ? 0 : 1);
    } catch (err) {
        console.error('\n[测试异常]', err);
        process.exit(2);
    }
})();
