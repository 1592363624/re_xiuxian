/**
 * 神识对决真实多人对局端到端测试脚本
 *
 * 验证内容：
 *   - 用两个真实化神期账号进行完整对局：challenge → accept → action×2 → settle
 *   - 验证赌注扣减/发放、护盾结算矩阵、回合推进、胜负判定
 *   - 验证只读接口（active/history）返回数据正确性
 *
 * 使用方式：
 *   1. 数据库中需要至少 2 个化神期玩家
 *   2. 若不足，可使用 GM 接口或直接 SQL 创建/提升
 *
 * 运行：node server/scripts/test_batch_5_divine_duel_e2e.js
 */
'use strict';

require('dotenv').config();

const BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:5000';

// 测试统计
let totalTests = 0;
let passedTests = 0;
const failedTests = [];

/**
 * 断言工具
 */
function assert(condition, testName, details = '') {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log(`  ✅ ${testName}`);
    } else {
        failedTests.push({ testName, details });
        console.log(`  ❌ ${testName}${details ? ' | ' + details : ''}`);
    }
}

/**
 * 登录获取 token
 */
async function login(username, password) {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!data.token) {
        throw new Error(`登录失败(${username}): ${JSON.stringify(data)}`);
    }
    return { token: data.token, player: data.player || data.data };
}

/**
 * 统一 API 调用
 */
async function apiCall(token, method, path, body) {
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    };
    if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE_URL}${path}`, options);
    const data = await res.json().catch(() => ({}));
    data.httpStatus = res.status;
    return data;
}

/**
 * 主测试函数
 */
async function main() {
    console.log('========================================================');
    console.log('  神识对决真实多人对局端到端测试');
    console.log('========================================================');

    // ===== 步骤1：服务连通性 + 寻找两个化神期账号 =====
    console.log('\n【步骤1】探测服务连通性 + 查询化神期玩家');

    let serviceAvailable = false;
    try {
        const probeRes = await fetch(`${BASE_URL}/api/health`);
        if (probeRes.status === 200) {
            serviceAvailable = true;
            console.log('  ℹ️  服务在线');
        }
    } catch (e) {
        console.log(`  ⚠️  无法连接服务：${e.message}`);
    }
    if (!serviceAvailable) {
        console.log('  ⚠️  服务不可用，跳过 HTTP 测试');
        return printSummary();
    }

    // 直接查询数据库找两个化神期玩家（rank >= 23）
    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const [players] = await sequelize.query(
        `SELECT id, username, nickname, realm, realm_rank, divine_sense_balance, spirit_stones
         FROM players
         WHERE realm_rank >= 23 AND is_banned = 0 AND is_dead = 0
         ORDER BY id ASC
         LIMIT 10`
    );

    console.log(`  ℹ️  数据库中化神期玩家数：${players.length}`);
    if (players.length < 2) {
        console.log('  ⚠️  化神期玩家不足 2 个，无法进行真实多人对局测试');
        console.log('  ℹ️  需先使用 GM 后台创建/提升第二个化神期账号');
        assert(false, '化神期玩家数量 >= 2', `当前 ${players.length}`);
        return printSummary();
    }

    console.log('  化神期玩家列表：');
    players.forEach(p => {
        console.log(`    - id=${p.id}, username=${p.username}, nickname=${p.nickname}, realm=${p.realm}(rank=${p.realm_rank}), 神识=${p.divine_sense_balance}, 灵石=${p.spirit_stones}`);
    });

    const challengerInfo = players[0];
    const defenderInfo = players[1];
    console.log(`  ℹ️  挑战方：${challengerInfo.nickname} (id=${challengerInfo.id})`);
    console.log(`  ℹ️  应战方：${defenderInfo.nickname} (id=${defenderInfo.id})`);

    // 尝试登录两个账号（需要密码；默认密码用 username）
    let challengerToken = null;
    let defenderToken = null;

    try {
        const loginRes = await login(challengerInfo.username, challengerInfo.username);
        challengerToken = loginRes.token;
        console.log(`  ℹ️  挑战方登录成功`);
    } catch (e) {
        console.log(`  ⚠️  挑战方登录失败：${e.message}`);
        // 尝试已知测试账号
        if (challengerInfo.username === '1592363624') {
            try {
                const loginRes = await login('1592363624', '1592363624');
                challengerToken = loginRes.token;
                console.log(`  ℹ️  挑战方用已知密码登录成功`);
            } catch (e2) {
                console.log(`  ⚠️  挑战方用已知密码仍登录失败：${e2.message}`);
            }
        }
    }

    try {
        const loginRes = await login(defenderInfo.username, defenderInfo.username);
        defenderToken = loginRes.token;
        console.log(`  ℹ️  应战方登录成功`);
    } catch (e) {
        console.log(`  ⚠️  应战方登录失败：${e.message}`);
    }

    if (!challengerToken || !defenderToken) {
        console.log('  ⚠️  无法登录两个账号，跳过对局测试');
        assert(false, '双方账号登录成功', `challenger=${!!challengerToken}, defender=${!!defenderToken}`);
        return printSummary();
    }

    assert(true, '双方账号登录成功');

    // ===== 步骤2：清理可能存在的进行中对局 =====
    console.log('\n【步骤2】清理可能存在的进行中对局');

    // 双方都查询 active，如有则投降
    for (const [token, label] of [[challengerToken, '挑战方'], [defenderToken, '应战方']]) {
        const activeRes = await apiCall(token, 'GET', '/api/divine-sense/duel/active');
        if (activeRes.code === 200 && activeRes.data) {
            const duelId = activeRes.data.duel_id;
            console.log(`  ℹ️  ${label}有进行中对局 duel_id=${duelId}，尝试投降清理`);
            const surrRes = await apiCall(token, 'POST', '/api/divine-sense/duel/surrender', { duel_id: duelId });
            console.log(`  ℹ️  投降结果：${surrRes.success ? '成功' : surrRes.message}`);
        }
    }

    // ===== 步骤3：记录初始余额 =====
    console.log('\n【步骤3】记录双方初始余额');

    const challengerProfileBefore = await apiCall(challengerToken, 'GET', '/api/divine-sense/profile');
    const defenderProfileBefore = await apiCall(defenderToken, 'GET', '/api/divine-sense/profile');
    const challengerSenseBefore = challengerProfileBefore.data?.divine_sense?.current;
    const defenderSenseBefore = defenderProfileBefore.data?.divine_sense?.current;
    console.log(`  ℹ️  挑战方初始神识：${challengerSenseBefore}`);
    console.log(`  ℹ️  应战方初始神识：${defenderSenseBefore}`);

    // 重新查询数据库获取最新灵石
    const [challengerRow] = await sequelize.query(
        `SELECT spirit_stones, divine_sense_balance FROM players WHERE id = ?`,
        { replacements: [challengerInfo.id] }
    );
    const [defenderRow] = await sequelize.query(
        `SELECT spirit_stones, divine_sense_balance FROM players WHERE id = ?`,
        { replacements: [defenderInfo.id] }
    );
    const challengerStonesBefore = BigInt(challengerRow[0].spirit_stones || 0);
    const defenderStonesBefore = BigInt(defenderRow[0].spirit_stones || 0);
    console.log(`  ℹ️  挑战方初始灵石：${challengerStonesBefore.toString()}`);
    console.log(`  ℹ️  应战方初始灵石：${defenderStonesBefore.toString()}`);

    assert(challengerSenseBefore !== undefined, '挑战方神识余额可读');
    assert(defenderSenseBefore !== undefined, '应战方神识余额可读');

    // ===== 步骤4：发起挑战（用神识赌注，便于快速结算） =====
    console.log('\n【步骤4】发起挑战（神识赌注 10）');

    const betType = 'divine_sense';
    const betAmount = 10;
    const challengeRes = await apiCall(challengerToken, 'POST', '/api/divine-sense/duel/challenge', {
        target_player_id: defenderInfo.id,
        bet_type: betType,
        bet_amount: betAmount
    });

    // 注意：HTTP 响应在成功时不返回 success 字段（仅失败时返回 success:false）
    // 判断成功：code===200 且 success !== false 且 data 不为 null
    const challengeOk = challengeRes.code === 200 && challengeRes.success !== false && challengeRes.data;
    if (!challengeOk) {
        console.log(`  ⚠️  挑战失败：${challengeRes.message}`);
        assert(false, '发起挑战成功', challengeRes.message);
        return printSummary();
    }
    assert(true, '发起挑战成功');
    const duelId = challengeRes.data.duel_id;
    console.log(`  ℹ️  对局ID：${duelId}`);
    console.log(`  ℹ️  入场神识消耗：${challengeRes.data.entry_divine_sense_cost}`);
    console.log(`  ℹ️  双方初始护盾：${challengeRes.data.challenger_shield} / ${challengeRes.data.defender_shield}`);

    // ===== 步骤5：应战方查询待接受对局 + 接受 =====
    console.log('\n【步骤5】应战方查询对局 + 接受');

    const defenderActiveRes = await apiCall(defenderToken, 'GET', '/api/divine-sense/duel/active');
    assert(defenderActiveRes.code === 200 && defenderActiveRes.data, '应战方查到 pending 对局');
    if (defenderActiveRes.data) {
        assert(defenderActiveRes.data.duel_id === duelId, '对局ID一致');
        assert(defenderActiveRes.data.status === 'pending', '对局状态为 pending');
    }

    const acceptRes = await apiCall(defenderToken, 'POST', '/api/divine-sense/duel/accept', { duel_id: duelId });
    const acceptOk = acceptRes.code === 200 && acceptRes.success !== false && acceptRes.data;
    assert(acceptOk, '应战方接受挑战', acceptRes.message);
    if (acceptOk) {
        console.log(`  ℹ️  进入第 ${acceptRes.data.round_number} 回合`);
        console.log(`  ℹ️  行动截止时间：${acceptRes.data.action_deadline}`);
    }

    // ===== 步骤6：第1回合——挑战方先行动（凝神） =====
    console.log('\n【步骤6】第1回合——挑战方先行动（凝神 focus）');

    const action1Res = await apiCall(challengerToken, 'POST', '/api/divine-sense/duel/action', {
        duel_id: duelId,
        action: 'focus'
    });
    const action1Ok = action1Res.code === 200 && action1Res.success !== false && action1Res.data;
    assert(action1Ok, '挑战方提交行动 focus', action1Res.message);
    if (action1Ok) {
        assert(action1Res.data.waiting_opponent === true, '应返回 waiting_opponent=true（等待对方）');
        console.log(`  ℹ️  当前回合：${action1Res.data.round_number}，等待对方行动`);
    }

    // 应战方查询 active，应能看到 your_action=null（自己未行动）
    const defenderActiveMid = await apiCall(defenderToken, 'GET', '/api/divine-sense/duel/active');
    if (defenderActiveMid.data) {
        assert(defenderActiveMid.data.your_action === null, '应战方自己 your_action 为 null');
        console.log(`  ℹ️  应战方 your_action=${defenderActiveMid.data.your_action}（未提交）`);
    }

    // ===== 步骤7：应战方提交行动（固元 stabilize），触发回合结算 =====
    console.log('\n【步骤7】应战方提交行动（固元 stabilize），触发回合结算');

    const action2Res = await apiCall(defenderToken, 'POST', '/api/divine-sense/duel/action', {
        duel_id: duelId,
        action: 'stabilize'
    });
    const action2Ok = action2Res.code === 200 && action2Res.success !== false && action2Res.data;
    assert(action2Ok, '应战方提交行动 stabilize', action2Res.message);
    if (action2Ok) {
        const data = action2Res.data;
        assert(data.settled === true, '本回合已结算');
        assert(data.challenger_action === 'focus', '挑战方行动记录正确');
        assert(data.defender_action === 'stabilize', '应战方行动记录正确');
        console.log(`  ℹ️  结算结果：A护盾 ${data.challenger_shield}（变化 ${data.challenger_shield_change}），B护盾 ${data.defender_shield}（变化 ${data.defender_shield_change}）`);

        // 验证结算矩阵：focus vs stabilize
        // 实际逻辑（看 _settleRound 代码）：
        //   A 凝神：aShieldChange = -focusCost = -15；A 不受到伤害（固元不反击）→ A 变化 = -15
        //   B 固元：bShieldChange = +stabilizeRecover = +10；B 受到 focusDamage * 0.5 = 10 伤害 → B 变化 = +10 - 10 = 0
        // 即：凝神只消耗自身护盾攻击对方；固元恢复护盾并减半受到的伤害；固元不反击
        const expectedAChange = -15; // 仅凝神消耗，无受到伤害
        const expectedBChange = 10 - 10; // +10 恢复 - 10 减半伤害 = 0
        assert(data.challenger_shield_change === expectedAChange,
            `挑战方护盾变化正确（focus vs stabilize）应为 ${expectedAChange}，实际 ${data.challenger_shield_change}`);
        assert(data.defender_shield_change === expectedBChange,
            `应战方护盾变化正确（focus vs stabilize）应为 ${expectedBChange}，实际 ${data.defender_shield_change}`);

        if (data.duel_finished) {
            console.log(`  ℹ️  对局已结束（${data.settle_reason}），胜者：${data.winner_id}`);
        } else {
            console.log(`  ℹ️  进入第 ${data.next_round} 回合，截止：${data.next_action_deadline}`);
        }
    }

    // ===== 步骤8：持续进行多回合直到对局结束 =====
    console.log('\n【步骤8】持续多回合直到对局结束（最多 20 回合）');

    let roundNum = 1;
    let duelFinished = action2Res.data?.duel_finished || false;
    let finalWinnerId = action2Res.data?.winner_id;
    let settleReason = action2Res.data?.settle_reason;

    // 双方交替选择不同行动以观察不同结算矩阵
    const actionSequence = [
        { c: 'stabilize', d: 'stabilize' }, // 双方都固元
        { c: 'focus',     d: 'focus'     }, // 双方都凝神（互相伤害）
        { c: 'stabilize', d: 'focus'     }, // A固元B凝神
        { c: 'focus',     d: 'stabilize' }, // A凝神B固元
        { c: 'focus',     d: 'focus'     }, // 加速结束
    ];

    while (!duelFinished && roundNum < 20) {
        roundNum++;
        const seqIdx = (roundNum - 2) % actionSequence.length;
        const seq = actionSequence[seqIdx];

        console.log(`  ℹ️  第 ${roundNum} 回合：挑战方=${seq.c}，应战方=${seq.d}`);

        // 挑战方先行动
        const cRes = await apiCall(challengerToken, 'POST', '/api/divine-sense/duel/action', {
            duel_id: duelId,
            action: seq.c
        });
        const cOk = cRes.code === 200 && cRes.success !== false && cRes.data;
        if (!cOk) {
            console.log(`  ⚠️  挑战方第${roundNum}回合行动失败：${cRes.message}`);
            break;
        }

        // 应战方行动（触发结算）
        const dRes = await apiCall(defenderToken, 'POST', '/api/divine-sense/duel/action', {
            duel_id: duelId,
            action: seq.d
        });
        const dOk = dRes.code === 200 && dRes.success !== false && dRes.data;
        if (!dOk) {
            console.log(`  ⚠️  应战方第${roundNum}回合行动失败：${dRes.message}`);
            break;
        }

        console.log(`    结算：A护盾 ${dRes.data.challenger_shield}（${dRes.data.challenger_shield_change}），B护盾 ${dRes.data.defender_shield}（${dRes.data.defender_shield_change}）`);

        if (dRes.data.duel_finished) {
            duelFinished = true;
            finalWinnerId = dRes.data.winner_id;
            settleReason = dRes.data.settle_reason;
            console.log(`  ✅ 对局第 ${roundNum} 回合结束，胜者：${finalWinnerId}，原因：${settleReason}`);
            break;
        }
    }

    assert(duelFinished, `对局在 ${roundNum} 回合内结束`);
    console.log(`  ℹ️  最终胜者：${finalWinnerId || '平局'}，原因：${settleReason}`);

    // ===== 步骤9：验证赌注结算 =====
    console.log('\n【步骤9】验证赌注结算');

    // 重新查询余额
    const [challengerRowAfter] = await sequelize.query(
        `SELECT spirit_stones, divine_sense_balance FROM players WHERE id = ?`,
        { replacements: [challengerInfo.id] }
    );
    const [defenderRowAfter] = await sequelize.query(
        `SELECT spirit_stones, divine_sense_balance FROM players WHERE id = ?`,
        { replacements: [defenderInfo.id] }
    );

    const challengerSenseAfter = Number(challengerRowAfter[0].divine_sense_balance);
    const defenderSenseAfter = Number(defenderRowAfter[0].divine_sense_balance);
    console.log(`  ℹ️  挑战方神识：${challengerSenseBefore} → ${challengerSenseAfter}（差值 ${challengerSenseAfter - challengerSenseBefore}）`);
    console.log(`  ℹ️  应战方神识：${defenderSenseBefore} → ${defenderSenseAfter}（差值 ${defenderSenseAfter - defenderSenseBefore}）`);

    // 入场消耗 50 + 赌注 10 = 60（挑战方扣减）
    // 赌注 10（应战方扣减）
    // 胜者获得 2 * 10 = 20（含本金，实际净赚 10）
    const entryCost = 50;
    const bet = 10;
    const totalCost = entryCost + bet; // 60

    let expectedChallengerDelta, expectedDefenderDelta;
    if (finalWinnerId === challengerInfo.id) {
        // 挑战方胜：扣 60，得 20，净 -40
        expectedChallengerDelta = -totalCost + (bet * 2);
        expectedDefenderDelta = -bet;
    } else if (finalWinnerId === defenderInfo.id) {
        // 应战方胜：扣 10，得 20，净 +10
        expectedChallengerDelta = -totalCost;
        expectedDefenderDelta = -bet + (bet * 2);
    } else {
        // 平局：双方各退还 5
        expectedChallengerDelta = -totalCost + Math.floor(bet * 0.5);
        expectedDefenderDelta = -bet + Math.floor(bet * 0.5);
    }

    const actualChallengerDelta = challengerSenseAfter - challengerSenseBefore;
    const actualDefenderDelta = defenderSenseAfter - defenderSenseBefore;
    console.log(`  ℹ️  预期差值：挑战方 ${expectedChallengerDelta}，应战方 ${expectedDefenderDelta}`);

    assert(actualChallengerDelta === expectedChallengerDelta,
        `挑战方神识结算正确`, `预期 ${expectedChallengerDelta}，实际 ${actualChallengerDelta}`);
    assert(actualDefenderDelta === expectedDefenderDelta,
        `应战方神识结算正确`, `预期 ${expectedDefenderDelta}，实际 ${actualDefenderDelta}`);

    // ===== 步骤10：验证历史记录 =====
    console.log('\n【步骤10】验证历史记录');

    const historyRes = await apiCall(challengerToken, 'GET', '/api/divine-sense/duel/history');
    assert(historyRes.code === 200, '查询历史返回 200');
    if (historyRes.data && Array.isArray(historyRes.data.duels)) {
        const latestDuel = historyRes.data.duels[0];
        assert(!!latestDuel, '历史列表包含至少 1 条记录');
        if (latestDuel) {
            assert(latestDuel.duel_id === duelId, '最近对局ID一致');
            assert(latestDuel.status === 'finished', '最近对局状态为 finished');
            assert(latestDuel.winner_id === finalWinnerId, '历史记录的胜者一致');
            console.log(`  ℹ️  历史记录首条：duel_id=${latestDuel.duel_id}, winner=${latestDuel.winner_id}, is_winner=${latestDuel.is_winner}`);
        }
    }

    // ===== 步骤11：active 对局已清空 =====
    console.log('\n【步骤11】验证 active 对局已清空');

    const activeAfter = await apiCall(challengerToken, 'GET', '/api/divine-sense/duel/active');
    assert(activeAfter.code === 200 && activeAfter.data === null, '挑战方 active 返回 null（无进行中对局）');

    // ===== 测试结果汇总 =====
    return printSummary();
}

/**
 * 打印测试汇总
 */
function printSummary() {
    console.log('\n========================================================');
    console.log('  测试结果汇总');
    console.log('========================================================');
    console.log(`  总计: ${totalTests}`);
    console.log(`  通过: ${passedTests}`);
    console.log(`  失败: ${failedTests.length}`);
    if (failedTests.length > 0) {
        console.log('\n  失败详情:');
        failedTests.forEach((f, i) => {
            console.log(`    ${i + 1}. ${f.testName}${f.details ? ' | ' + f.details : ''}`);
        });
    }
    console.log('========================================================');

    process.exit(failedTests.length > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('测试脚本异常:', e);
    process.exit(1);
});
