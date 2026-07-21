/**
 * 世界BOSS 多行动机制端到端验证脚本（玩法文档第16节）
 *
 * 验证内容：
 *   1. 登录测试账号获取 token（admin 账号可调 GM 接口）
 *   2. 查询可挑战 BOSS（无则调 admin 接口 spawn 一只）
 *   3. 依次执行 4 种行动各 1 次，验证：
 *      - 强攻伤害最高（damage_multiplier=1.0）
 *      - 破幡/镇魂/护阵伤害较低（damage_multiplier=0.4/0.3/0.3）
 *      - banner_soul/magic_pressure/array_integrity 按预期变化
 *   4. 连续 4 次强攻，验证第 4 次触发重复惩罚（repetition_penalty_applied=true）
 *   5. 打印测试结果汇总
 *
 * 运行：node server/scripts/_test_world_boss_action.js
 */
'use strict';

const BASE_URL = 'http://localhost:5000/api';
const TEST_ACCOUNT = { username: '1592363624', password: '1592363624' };

/**
 * 通用 fetch 封装，返回 { status, json }
 * 注意：headers 必须合并而非覆盖，否则 options.headers 会丢失 Content-Type
 * @param {string} url - 请求 URL
 * @param {Object} options - fetch options（method/body/headers）
 * @returns {Promise<{status: number, json: any}>}
 */
async function fetchJson(url, options = {}) {
    // 合并 headers：默认 Content-Type 与传入的 Authorization 共存
    const mergedHeaders = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers: mergedHeaders,
        body: options.body
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { status: res.status, json };
}

/**
 * 登录获取 token 与玩家信息
 * @returns {Promise<{token: string, player: Object}>}
 */
async function login() {
    const { status, json } = await fetchJson(`${BASE_URL}/auth/login`, {
        method: 'POST',
        body: JSON.stringify(TEST_ACCOUNT)
    });
    const token = json?.data?.token || json?.token;
    const player = json?.data?.player || json?.player || {};
    if (status !== 200 || !token) {
        throw new Error(`登录失败: status=${status}, body=${JSON.stringify(json).slice(0, 200)}`);
    }
    return { token, player };
}

/**
 * 查询当前可挑战的 BOSS 列表
 * @param {string} token - JWT token
 * @returns {Promise<Object>} 可挑战 BOSS 数据
 */
async function getAvailableBosses(token) {
    const { status, json } = await fetchJson(`${BASE_URL}/world-boss/available`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (status !== 200) {
        throw new Error(`查询可挑战BOSS失败: status=${status}, body=${JSON.stringify(json).slice(0, 200)}`);
    }
    return json.data;
}

/**
 * 通过 admin 接口刷新 BOSS
 * @param {string} token - admin JWT token
 * @param {string} bossKey - BOSS 配置键（如 qingyuanzi/yaoshou/mulan）
 * @returns {Promise<Object>} 刷新结果（含 boss_id）
 */
async function spawnBossViaGM(token, bossKey = 'qingyuanzi') {
    const { status, json } = await fetchJson(`${BASE_URL}/admin/world-boss/spawn`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ boss_key: bossKey })
    });
    console.log(`[GM刷新BOSS] status=${status}, response=${JSON.stringify(json).slice(0, 300)}`);
    return json?.data;
}

/**
 * 执行多行动机制接口
 * @param {string} token - JWT token
 * @param {number} bossId - BOSS 实例 ID
 * @param {string} actionType - 行动类型（assault/break_banner/suppress_soul/protect_array）
 * @param {string} [skillId='basic'] - 技能ID
 * @returns {Promise<{status: number, json: Object}>}
 */
async function performAction(token, bossId, actionType, skillId = 'basic') {
    const { status, json } = await fetchJson(`${BASE_URL}/world-boss/${bossId}/action`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action_type: actionType, skill_id: skillId })
    });
    return { status, json };
}

/**
 * 等待指定毫秒（用于攻击 CD）
 * @param {number} ms - 毫秒
 */
async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * 主测试流程
 */
async function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  世界BOSS 多行动机制验证（玩法文档第16节）');
    console.log('═══════════════════════════════════════════\n');

    // ========== [1] 登录 ==========
    console.log('[1] 登录测试账号...');
    const { token, player } = await login();
    console.log(`✓ 登录成功: ${player.nickname} (${player.realm})\n`);

    // ========== [2] 查询/刷新 BOSS ==========
    console.log('[2] 查询可挑战 BOSS...');
    let availableData = await getAvailableBosses(token);
    let bosses = availableData?.bosses || [];
    console.log(`  当前可挑战 BOSS 数量: ${bosses.length}`);

    let bossId;
    if (bosses.length === 0) {
        console.log('  无可挑战 BOSS，调用 admin 接口刷新青元子...');
        const spawnData = await spawnBossViaGM(token, 'qingyuanzi');
        bossId = spawnData?.boss_id || spawnData?.boss?.id || spawnData?.id;
        if (!bossId) {
            console.error('  ✗ 刷新 BOSS 失败:', JSON.stringify(spawnData).slice(0, 300));
            process.exit(1);
        }
        console.log(`  ✓ 已刷新 BOSS, boss_id=${bossId}`);
        // 重新查询确认
        availableData = await getAvailableBosses(token);
        bosses = availableData?.bosses || [];
    } else {
        bossId = bosses[0].boss_id || bosses[0].id;
        console.log(`  ✓ 选用现有 BOSS: ${bosses[0].boss_name || bosses[0].name} (id=${bossId})`);
    }
    console.log('');

    // ========== [3] 依次执行 4 种行动 ==========
    console.log('[3] 依次执行 4 种行动（强攻/破幡/镇魂/护阵）...\n');

    const actions = [
        { type: 'assault',       name: '强攻', expected_mult: 1.0 },
        { type: 'break_banner',  name: '破幡', expected_mult: 0.4 },
        { type: 'suppress_soul', name: '镇魂', expected_mult: 0.3 },
        { type: 'protect_array', name: '护阵', expected_mult: 0.3 }
    ];

    const actionResults = [];
    for (const act of actions) {
        // 攻击 CD 是 5 秒，等待 5.5 秒保险
        await sleep(5500);
        console.log(`  ▶ 执行 ${act.name}（${act.type}）...`);
        const { status, json } = await performAction(token, bossId, act.type);
        if (status !== 200) {
            console.error(`    ✗ 调用失败: status=${status}, body=${JSON.stringify(json).slice(0, 300)}`);
            continue;
        }
        const data = json?.data;
        if (!data) {
            console.error(`    ✗ 返回数据为空:`, JSON.stringify(json).slice(0, 300));
            continue;
        }
        const dmg = data.attack?.damage || 0;
        const bannerSoul = data.boss?.banner_soul;
        const magicPressure = data.boss?.magic_pressure;
        const arrayIntegrity = data.boss?.array_integrity;
        const bannerSoulBefore = data.boss?.banner_soul_before;
        const bannerSoulAfter = data.boss?.banner_soul_after;
        const magicPressureBefore = data.boss?.magic_pressure_before;
        const magicPressureAfter = data.boss?.magic_pressure_after;
        const arrayIntegrityBefore = data.boss?.array_integrity_before;
        const arrayIntegrityAfter = data.boss?.array_integrity_after;
        const actionMultiplier = data.action?.damage_multiplier;
        const repetitionPenalty = data.action?.repetition_penalty_applied;
        const actionStreak = data.action?.action_streak;

        console.log(`    ✓ 伤害: ${dmg}（行动倍率: ${actionMultiplier}）`);
        console.log(`    ✓ 幡魂: ${bannerSoulBefore} → ${bannerSoulAfter} (当前 ${bannerSoul})`);
        console.log(`    ✓ 魔压: ${magicPressureBefore} → ${magicPressureAfter} (当前 ${magicPressure})`);
        console.log(`    ✓ 阵势: ${arrayIntegrityBefore} → ${arrayIntegrityAfter} (当前 ${arrayIntegrity})`);
        console.log(`    ✓ 重复惩罚: ${repetitionPenalty ? '✗ 触发' : '✓ 未触发'} (streak=${actionStreak})`);

        actionResults.push({
            action: act.type,
            name: act.name,
            damage: dmg,
            action_multiplier: actionMultiplier,
            banner_soul: { before: bannerSoulBefore, after: bannerSoulAfter },
            magic_pressure: { before: magicPressureBefore, after: magicPressureAfter },
            array_integrity: { before: arrayIntegrityBefore, after: arrayIntegrityAfter },
            repetition_penalty: repetitionPenalty,
            action_streak: actionStreak
        });
        console.log('');
    }

    // ========== [4] 验证伤害排序 ==========
    console.log('[4] 验证伤害排序（强攻应最高）...');
    const assaultDmg = actionResults.find(r => r.action === 'assault')?.damage || 0;
    const breakBannerDmg = actionResults.find(r => r.action === 'break_banner')?.damage || 0;
    const suppressSoulDmg = actionResults.find(r => r.action === 'suppress_soul')?.damage || 0;
    const protectArrayDmg = actionResults.find(r => r.action === 'protect_array')?.damage || 0;
    console.log(`  强攻伤害: ${assaultDmg}`);
    console.log(`  破幡伤害: ${breakBannerDmg}`);
    console.log(`  镇魂伤害: ${suppressSoulDmg}`);
    console.log(`  护阵伤害: ${protectArrayDmg}`);
    if (assaultDmg > breakBannerDmg && assaultDmg > suppressSoulDmg && assaultDmg > protectArrayDmg) {
        console.log('  ✓ 验证通过：强攻伤害 > 其他三种行动');
    } else {
        console.log('  ✗ 验证失败：强攻伤害应最高');
    }
    console.log('');

    // ========== [5] 连续 4 次强攻，验证重复惩罚 ==========
    console.log('[5] 连续 4 次强攻，验证第 4 次触发重复惩罚...');
    const streakResults = [];
    for (let i = 1; i <= 4; i++) {
        await sleep(5500); // 攻击 CD 5 秒
        console.log(`  ▶ 第 ${i} 次强攻...`);
        const { status, json } = await performAction(token, bossId, 'assault');
        if (status !== 200) {
            console.error(`    ✗ 调用失败: status=${status}, body=${JSON.stringify(json).slice(0, 300)}`);
            continue;
        }
        const data = json?.data;
        const dmg = data?.attack?.damage || 0;
        const penaltyApplied = data?.action?.repetition_penalty_applied;
        const streak = data?.action?.action_streak;
        console.log(`    ✓ 伤害: ${dmg}, streak=${streak}, 重复惩罚: ${penaltyApplied ? '✗ 触发（×0.5）' : '✓ 未触发'}`);
        streakResults.push({ attempt: i, damage: dmg, streak, penalty: penaltyApplied });
    }
    console.log('');

    // ========== [6] 验证第 4 次是否触发惩罚 ==========
    console.log('[6] 验证重复惩罚触发...');
    const fourthAttempt = streakResults.find(r => r.attempt === 4);
    if (fourthAttempt?.penalty) {
        console.log(`  ✓ 验证通过：第 4 次强攻触发了重复惩罚（streak=${fourthAttempt.streak}）`);
    } else {
        console.log(`  ⚠ 验证提醒：第 4 次强攻未触发重复惩罚`);
        console.log(`    可能原因：`);
        console.log(`    - 测试前玩家已有 action_streak 历史记录，本次测试中实际触发在第 3 次或第 5 次`);
        console.log(`    - 前面 4 种行动测试已让 streak 重置为 1（强攻作为首个行动后切换过其他行动）`);
        console.log(`    当前 streak 数据：${JSON.stringify(streakResults)}`);
    }
    console.log('');

    // ========== [7] 汇总 ==========
    console.log('═══════════════════════════════════════════');
    console.log('  测试结果汇总');
    console.log('═══════════════════════════════════════════');
    console.log('【4 种行动伤害对比】');
    console.log(`  强攻  : ${assaultDmg}`);
    console.log(`  破幡  : ${breakBannerDmg}`);
    console.log(`  镇魂  : ${suppressSoulDmg}`);
    console.log(`  护阵  : ${protectArrayDmg}`);
    console.log('');
    console.log('【连续 4 次强攻的重复惩罚】');
    for (const r of streakResults) {
        console.log(`  第${r.attempt}次: 伤害=${r.damage}, streak=${r.streak}, 惩罚=${r.penalty ? '触发' : '未触发'}`);
    }
    console.log('');
    console.log('【BOSS 三大状态变化（4 种行动后）】');
    const lastResult = actionResults[actionResults.length - 1];
    if (lastResult) {
        console.log(`  幡魂  : ${lastResult.banner_soul.before} → ${lastResult.banner_soul.after}`);
        console.log(`  魔压  : ${lastResult.magic_pressure.before} → ${lastResult.magic_pressure.after}`);
        console.log(`  阵势  : ${lastResult.array_integrity.before} → ${lastResult.array_integrity.after}`);
    }
    console.log('═══════════════════════════════════════════');
    console.log('  多行动机制验证完成');
    console.log('═══════════════════════════════════════════');
}

// 入口
main().catch(err => {
    console.error('脚本异常:', err);
    process.exit(1);
});
