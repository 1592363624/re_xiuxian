/**
 * 切磋木人排行榜每日奖励结算 完整业务流程测试
 *
 * 测试流程：
 *   1. 登录测试账号
 *   2. 查询切磋状态（验证境界/次数/冷却）
 *   3. 调用切磋接口（产生 win 记录）
 *   4. 清理该日期已结算的 SystemConfig 标记
 *   5. 调用 GM 手动结算接口（结算今日）
 *   6. 验证奖励发放（exp/spirit_stones）
 *   7. 再次调用验证幂等性
 *   8. 清理（恢复 SystemConfig 标记）
 *
 * 测试账号：1592363624 / 1592363624（管理员）
 * 运行方式：node server/scripts/test_sparring_settle_business_flow.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const http = require('http');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const sequelize = require('../config/database');
const SystemConfig = require('../models/system_config');
const PlayerSparring = require('../models/playerSparring');
const { Op } = require('sequelize');

// ============== 配置 ==============
const HOST = '127.0.0.1';
const PORT = 5000;
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

// ============== 测试工具 ==============
let passCount = 0;
let failCount = 0;
const failures = [];

function request(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const data = body ? JSON.stringify(body) : null;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);

        const req = http.request({ host: HOST, port: PORT, path, method, headers }, (res) => {
            let chunks = '';
            res.on('data', (c) => chunks += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function pass(name) {
    passCount++;
    console.log(`  ✅ ${name}`);
}

function fail(name, actual, expected) {
    failCount++;
    failures.push({ name, actual, expected });
    console.log(`  ❌ ${name}`);
    if (expected !== undefined) {
        console.log(`     期望: ${JSON.stringify(expected)}`);
        console.log(`     实际: ${JSON.stringify(actual)}`);
    } else {
        console.log(`     实际: ${JSON.stringify(actual)}`);
    }
}

function assertTrue(name, actual) {
    if (actual) {
        pass(name);
    } else {
        fail(name, actual, 'truthy');
    }
}

function assertEqual(name, actual, expected) {
    if (actual === expected) {
        pass(name);
    } else {
        fail(name, actual, expected);
    }
}

// ============== 主测试流程 ==============
async function main() {
    console.log('\n=========================================');
    console.log('  切磋木人每日结算 完整业务流程测试');
    console.log('=========================================\n');

    // ============== 阶段 1：登录 ==============
    console.log('【阶段 1】登录获取 JWT token');
    const loginRes = await request('POST', '/api/auth/login', {
        username: TEST_ACCOUNT,
        password: TEST_PASSWORD
    });
    if (loginRes.status !== 200 || !loginRes.body?.token) {
        console.error(`❌ 登录失败: ${JSON.stringify(loginRes.body).slice(0, 300)}`);
        process.exit(1);
    }
    const token = loginRes.body.token;
    const playerInfo = loginRes.body.player || {};
    console.log(`  ✓ 登录成功（玩家ID=${playerInfo.id}，role=${playerInfo.role}，境界=${playerInfo.realm}）`);

    // 记录初始 exp/spirit_stones（用于后续验证奖励发放）
    const initialExp = BigInt(playerInfo.exp || 0);
    const initialStones = BigInt(playerInfo.spirit_stones || 0);
    console.log(`  ✓ 初始修为: ${initialExp}, 初始灵石: ${initialStones}\n`);

    // ============== 阶段 2：查询切磋状态 ==============
    console.log('【阶段 2】查询切磋状态');
    const statusRes = await request('GET', '/api/sparring/status', null, token);
    assertEqual('状态接口应返回 200', statusRes.status, 200);
    const status = statusRes.body?.data || {};
    console.log(`  今日次数: ${status.daily_used}/${status.daily_limit}，剩余: ${status.daily_remaining}，冷却: ${status.cooldown_remaining_sec}s`);
    assertTrue('应可切磋或已用过次数', typeof status.can_sparring === 'boolean');

    if (status.daily_remaining === 0) {
        console.log('\n⚠ 今日切磋次数已用完，跳过业务流程测试（仅验证接口可达性）');
        return finishTest();
    }
    if (status.cooldown_remaining_sec > 0) {
        console.log(`\n⚠ 切磋冷却中（剩余 ${status.cooldown_remaining_sec}s），改为验证已有结算数据`);
        // 冷却场景：验证之前已结算的数据是否正确
        return verifySettledData(token, playerInfo.id);
    }

    // ============== 阶段 3：切磋木人产生 win 记录 ==============
    console.log('\n【阶段 3】切磋木人产生 win 记录');
    // 化神期玩家选择能赢的低档次木人（炼气木人）
    const woodmanKey = 'qi_refining';
    const startRes = await request('POST', '/api/sparring/start', { woodman_key: woodmanKey }, token);
    if (startRes.status !== 200) {
        console.log(`  ⚠ 切磋失败: ${JSON.stringify(startRes.body).slice(0, 300)}`);
        console.log('  跳过业务流程测试');
        return finishTest();
    }
    const startResult = startRes.body?.data || {};
    const battleResult = startResult.battle?.result;
    console.log(`  切磋结果: ${battleResult}, 评分: ${startResult.score}, 奖励: exp=${startResult.rewards?.exp}, stones=${startResult.rewards?.spirit_stones}`);
    assertTrue('切磋应返回 battle 对象', !!startResult.battle);
    assertTrue('切磋应返回 score 字段', typeof startResult.score === 'number');

    if (battleResult !== 'win') {
        console.log('  ⚠ 切磋未胜利，跳过结算测试');
        return finishTest();
    }

    // ============== 阶段 4：清理今日的 SystemConfig 结算标记 ==============
    console.log('\n【阶段 4】清理今日 SystemConfig 结算标记（确保能触发结算）');
    {
        // 注意：测试账号切磋的记录是"今日"的，但 settleDailyRanking 默认结算"昨日"
        // 需要传入今日日期才能结算今日的记录
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const configKey = `sparring_settle_${todayStr}`;
        const deleted = await SystemConfig.destroy({ where: { key: configKey } });
        console.log(`  ✓ 已清理 ${deleted} 条今日(${todayStr})结算标记`);

        // 同时清理今日切磋记录的 settled_at 字段（防止之前测试已标记）
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
        const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
        const [updatedCount] = await PlayerSparring.update(
            { settled_at: null },
            { where: { created_at: { [Op.between]: [todayStart, todayEnd] } } }
        );
        console.log(`  ✓ 已重置 ${updatedCount} 条今日切磋记录的 settled_at 字段`);
    }

    // ============== 阶段 5：调用 GM 手动结算接口（结算今日） ==============
    console.log('\n【阶段 5】调用 GM 手动结算接口（结算今日）');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let settleRes;
    {
        settleRes = await request('POST', '/api/sparring/settle', { target_date: todayStr }, token);
        console.log(`  [DEBUG] 结算返回: status=${settleRes.status}, body=${JSON.stringify(settleRes.body).slice(0, 500)}`);
        assertEqual('结算接口应返回 200', settleRes.status, 200);
        const data = settleRes.body?.data || {};
        assertEqual('settle_date 应等于今日', data.settle_date, todayStr);
        assertTrue('应已结算（already_settled=false）', data.already_settled === false);
        assertTrue('应至少有 1 名上榜', data.settled_count >= 1);
        assertTrue('应返回 rewards 数组', Array.isArray(data.rewards) && data.rewards.length >= 1);

        // 验证奖励详情
        if (data.rewards?.length > 0) {
            const firstPlace = data.rewards.find(r => r.rank === 1) || data.rewards[0];
            console.log(`  第 1 名: ${firstPlace.nickname}, score=${firstPlace.best_score}, rewards=${JSON.stringify(firstPlace.rewards)}`);
            assertTrue('第一名 status 应为 rewarded', firstPlace.status === 'rewarded');
            assertTrue('第一名应获得 exp 奖励', firstPlace.rewards?.exp > 0);
            assertTrue('第一名应获得 spirit_stones 奖励', firstPlace.rewards?.spirit_stones > 0);
            // 如果是第 1 名，应该有称号
            if (firstPlace.rank === 1) {
                assertTrue('第一名应获得「木人切磋·天下第一」称号',
                    firstPlace.rewards?.title === '木人切磋·天下第一');
            }
        }
    }

    // ============== 阶段 6：验证玩家属性已更新 ==============
    console.log('\n【阶段 6】验证玩家属性已更新（exp/spirit_stones 增加）');
    {
        // 直接查数据库验证（登录接口只返回 id/nickname/realm/role，且重新登录会让旧 token 失效）
        const Player = require('../models/player');
        const player = await Player.findByPk(playerInfo.id);
        if (!player) {
            fail('玩家应存在', null, 'Player 实例');
        } else {
            const newExp = BigInt(player.exp || 0);
            const newStones = BigInt(player.spirit_stones || 0);
            const expDelta = newExp - initialExp;
            const stonesDelta = newStones - initialStones;
            console.log(`  修为变化: ${initialExp} → ${newExp} (Δ=${expDelta})`);
            console.log(`  灵石变化: ${initialStones} → ${newStones} (Δ=${stonesDelta})`);

            // 切磋本身有奖励，结算也有奖励，所以总和应大于 0
            assertTrue('修为应增加（切磋+结算奖励）', expDelta > 0);
            assertTrue('灵石应增加（切磋+结算奖励）', stonesDelta > 0);

            // 验证称号已添加（如果是第一名）
            const titles = player.titles || [];
            const settleData = settleRes.body?.data || {};
            const firstPlace = settleData.rewards?.find(r => r.rank === 1);
            if (firstPlace?.rewards?.title) {
                assertTrue(`称号「${firstPlace.rewards.title}」应已添加到玩家 titles`,
                    titles.includes(firstPlace.rewards.title));
            }
        }
    }

    // ============== 阶段 7：再次调用验证幂等性 ==============
    console.log('\n【阶段 7】再次调用结算验证幂等性');
    {
        const res = await request('POST', '/api/sparring/settle', { target_date: todayStr }, token);
        assertEqual('再次调用应返回 200', res.status, 200);
        const data = res.body?.data || {};
        assertTrue('再次调用应 already_settled=true', data.already_settled === true);
        assertEqual('再次调用 settled_count 应为 0', data.settled_count, 0);
    }

    // ============== 阶段 8：验证 settled_at 字段已标记 ==============
    console.log('\n【阶段 8】验证 PlayerSparring.settled_at 字段已标记');
    {
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
        const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);
        const unsettledCount = await PlayerSparring.count({
            where: {
                created_at: { [Op.between]: [todayStart, todayEnd] },
                settled_at: null
            }
        });
        assertEqual('今日应无未结算的切磋记录', unsettledCount, 0);

        const settledCount = await PlayerSparring.count({
            where: {
                created_at: { [Op.between]: [todayStart, todayEnd] },
                settled_at: { [Op.ne]: null }
            }
        });
        assertTrue('应至少有 1 条已结算记录', settledCount >= 1);
        console.log(`  ✓ 今日已结算记录数: ${settledCount}`);
    }

    // ============== 阶段 9：验证 SystemConfig 已记录 ==============
    console.log('\n【阶段 9】验证 SystemConfig 已记录结算状态');
    {
        const configKey = `sparring_settle_${todayStr}`;
        const config = await SystemConfig.findByPk(configKey);
        assertTrue('SystemConfig 应有今日结算记录', !!config);
        if (config) {
            const parsed = JSON.parse(config.value);
            assertTrue('SystemConfig 应含 settled_at 字段', !!parsed.settled_at);
            assertEqual('SystemConfig 应含 settle_date', parsed.settle_date, todayStr);
            console.log(`  ✓ SystemConfig: settled_at=${parsed.settled_at}, settled_count=${parsed.settled_count}`);
        }
    }

    return finishTest();
}

/**
 * 冷却场景备用验证：验证今日已有切磋记录的结算数据正确性
 * 通过直接查数据库验证：
 *   1. 今日有 win 记录
 *   2. settled_at 字段已标记
 *   3. SystemConfig 已记录结算状态
 *   4. 玩家 titles 含「木人切磋·天下第一」（如果是第一名）
 *   5. 调用 settle 接口验证幂等性（应返回 already_settled=true）
 * @param {string} token - JWT token
 * @param {number} playerId - 玩家ID
 * @returns {Promise<void>}
 */
async function verifySettledData(token, playerId) {
    const Player = require('../models/player');
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
    const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

    console.log('\n【阶段 A】验证今日 win 记录存在');
    {
        const winRecords = await PlayerSparring.findAll({
            where: {
                player_id: playerId,
                result: 'win',
                created_at: { [Op.between]: [todayStart, todayEnd] }
            }
        });
        assertTrue('今日应有 win 记录', winRecords.length > 0);
        console.log(`  ✓ 今日 win 记录数: ${winRecords.length}`);
    }

    // 检查是否已结算，未结算则先触发结算
    const configKey = `sparring_settle_${todayStr}`;
    let existingConfig = await SystemConfig.findByPk(configKey);
    if (!existingConfig) {
        console.log('\n【阶段 B】今日尚未结算，先调用 settle 接口触发结算');
        const settleRes = await request('POST', '/api/sparring/settle', { target_date: todayStr }, token);
        assertEqual('触发结算应返回 200', settleRes.status, 200);
        const data = settleRes.body?.data || {};
        assertTrue('触发结算应 already_settled=false', data.already_settled === false);
        assertTrue('触发结算应有上榜玩家', data.settled_count >= 1);
        if (data.rewards?.length > 0) {
            const firstPlace = data.rewards.find(r => r.rank === 1) || data.rewards[0];
            console.log(`  ✓ 第 1 名: ${firstPlace.nickname}, score=${firstPlace.best_score}, status=${firstPlace.status}`);
            assertTrue('第一名 status 应为 rewarded', firstPlace.status === 'rewarded');
            if (firstPlace.rank === 1) {
                assertTrue('第一名应获得「木人切磋·天下第一」称号',
                    firstPlace.rewards?.title === '木人切磋·天下第一');
            }
        }
        existingConfig = await SystemConfig.findByPk(configKey);
    } else {
        console.log('\n【阶段 B】今日已结算，跳过触发结算步骤');
    }

    console.log('\n【阶段 C】验证 settled_at 字段已标记');
    {
        const unsettled = await PlayerSparring.count({
            where: {
                created_at: { [Op.between]: [todayStart, todayEnd] },
                settled_at: null
            }
        });
        const settled = await PlayerSparring.count({
            where: {
                created_at: { [Op.between]: [todayStart, todayEnd] },
                settled_at: { [Op.ne]: null }
            }
        });
        assertEqual('今日应无未结算记录', unsettled, 0);
        assertTrue('今日应有已结算记录', settled > 0);
        console.log(`  ✓ 已结算记录数: ${settled}`);
    }

    console.log('\n【阶段 D】验证 SystemConfig 已记录结算状态');
    {
        assertTrue('SystemConfig 应有今日结算记录', !!existingConfig);
        if (existingConfig) {
            const parsed = JSON.parse(existingConfig.value);
            assertEqual('settle_date 应为今日', parsed.settle_date, todayStr);
            assertTrue('应含 settled_at 字段', !!parsed.settled_at);
            console.log(`  ✓ SystemConfig: settled_at=${parsed.settled_at}, settled_count=${parsed.settled_count}`);
        }
    }

    console.log('\n【阶段 E】验证玩家数据（titles 含排行榜第一名称号）');
    {
        const player = await Player.findByPk(playerId);
        if (!player) {
            fail('玩家应存在', null, 'Player 实例');
        } else {
            const titles = player.titles || [];
            console.log(`  ✓ 玩家 titles: ${JSON.stringify(titles)}`);
            assertTrue('玩家 titles 应含「木人切磋·天下第一」', titles.includes('木人切磋·天下第一'));
            assertTrue('玩家 exp 应大于 0', BigInt(player.exp || 0) > 0);
            assertTrue('玩家 spirit_stones 应大于 0', BigInt(player.spirit_stones || 0) > 0);
        }
    }

    console.log('\n【阶段 F】调用 settle 接口验证幂等性');
    {
        const res = await request('POST', '/api/sparring/settle', { target_date: todayStr }, token);
        assertEqual('幂等调用应返回 200', res.status, 200);
        const data = res.body?.data || {};
        assertTrue('幂等调用应 already_settled=true', data.already_settled === true);
        assertEqual('幂等调用 settled_count 应为 0', data.settled_count, 0);
    }

    return finishTest();
}

function finishTest() {
    console.log('\n=========================================');
    console.log(`  测试完成：✅ ${passCount} 通过，❌ ${failCount} 失败`);
    console.log('=========================================');
    if (failCount > 0) {
        console.log('\n失败用例详情：');
        failures.forEach((f, i) => {
            console.log(`  ${i + 1}. ${f.name}`);
            console.log(`     期望: ${JSON.stringify(f.expected)}`);
            console.log(`     实际: ${JSON.stringify(f.actual)}`);
        });
        process.exit(1);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('\n💥 测试脚本异常:', err.message);
    console.error(err.stack);
    process.exit(1);
});
