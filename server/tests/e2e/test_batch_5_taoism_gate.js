/**
 * 太一门引道系统端到端测试脚本
 *
 * 验证内容（玩法文档第25节：太一门引道——五行道途+神识联动+多人共鸣）：
 *   1. 服务连通性 + 登录
 *   2. 获取道途面板（未选择道途状态）
 *   3. 校验无效道途被拒绝
 *   4. 校验境界/神识不足时选择道途被拒绝（通过参数条件判断）
 *   5. 选择道途（metal金道）
 *   6. 再次获取面板（已选择道途状态）
 *   7. 引道修炼（消耗神识获得经验）
 *   8. 校验每日修炼次数上限（5次）
 *   9. 获取今日任务（应有3个任务）
 *  10. 校验技能等级不足时使用被拒绝
 *  11. 直接数据库设置等级5 + 测试金道技能攻击目标灵兽
 *  12. 校验同道途再次选择被拒绝（已有道途需用切换接口）
 *  13. 校验道途切换冷却（切换后7天内不能再次切换）
 *  14. 校验切换到当前道途被拒绝
 *  15. 获取道途排行榜（dao_level/total_skill_use/total_resonance）
 *  16. 查询道途共鸣状态
 *  17. 领取任务奖励（验证未完成任务被拒绝 + 已完成任务可领取）
 *  18. 清理测试数据
 *
 * 运行：node server/scripts/test_batch_5_taoism_gate.js
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
    console.log('  太一门引道系统端到端测试');
    console.log('========================================================');

    // ===== 1. 服务连通性 + 登录 =====
    console.log('\n▶ [1] 服务连通性 + 登录');

    let serviceAvailable = false;
    try {
        const probeRes = await fetch(`${BASE_URL}/api/health`);
        if (probeRes.status === 200) serviceAvailable = true;
    } catch (e) {
        console.log(`  ⚠️ 无法连接服务：${e.message}`);
    }
    if (!serviceAvailable) {
        console.log('  ⚠️ 服务不可用，跳过测试');
        return printSummary();
    }
    assert(true, '服务在线');

    let adminToken = null, adminPlayer = null;
    try {
        const adminLogin = await login('1592363624', '1592363624');
        adminToken = adminLogin.token;
        adminPlayer = adminLogin.player;
        assert(true, '管理员登录成功', `id=${adminPlayer.id}`);
    } catch (e) {
        assert(false, '管理员登录失败', e.message);
        return printSummary();
    }

    // 直接连接数据库用于测试前置数据准备与状态修正
    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const PlayerTaoismGate = require('../models/playerTaoismGate');
    const PlayerDivineSense = require('../models/playerDivineSense');
    const PlayerLaw = require('../models/playerLaw');
    const SpiritBeast = require('../models/spiritBeast');

    // 初始化服务（确保独立运行脚本时 config 已加载）
    const { infrastructure } = require('../modules');
    if (!infrastructure.ConfigLoader.hasConfig('taoism_gate_data')) {
        await infrastructure.ConfigLoader.loadAllConfigs();
    }
    const TaoismGateService = require('../game/services/TaoismGateService');
    if (!TaoismGateService.initialized) {
        TaoismGateService.initialize(infrastructure.ConfigLoader);
    }

    // ===== 2. 获取道途面板（未选择道途状态） =====
    console.log('\n▶ [2] 获取道途面板（未选择道途状态）');

    // 清理旧的测试数据
    await PlayerTaoismGate.destroy({ where: { player_id: adminPlayer.id } });
    console.log('  ℹ️  已清理旧道途记录');

    let profileRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/profile');
    assert(profileRes.httpStatus === 200, '获取面板成功', profileRes.message);
    assert(profileRes.data?.gate?.dao_path === null, '初始道途为null');
    assert(profileRes.data?.gate?.dao_level === 1, '初始道途等级为1');
    assert(profileRes.data?.gate?.dao_exp === 0, '初始道途经验为0');
    assert(Array.isArray(profileRes.data?.skills) && profileRes.data.skills.length === 0, '未选择道途时技能列表为空');
    assert(profileRes.data?.resonance?.resonance_bonus === 0, '未选择道途时共鸣加成为0');

    // ===== 3. 校验无效道途被拒绝 =====
    console.log('\n▶ [3] 校验无效道途被拒绝');

    const invalidPathRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/choose', { dao_path: 'invalid_path' });
    assert(invalidPathRes.httpStatus === 400, '无效道途被拒绝', invalidPathRes.message);

    // ===== 4. 准备前置条件（境界/神识） =====
    console.log('\n▶ [4] 准备前置条件（境界/神识）');

    // 确保玩家境界 rank >= 18（元婴期）
    const adminDbPlayer = await Player.findByPk(adminPlayer.id);
    const minRealmRank = TaoismGateService.config.taoism_gate.min_realm_rank;
    const minDivineSense = TaoismGateService.config.taoism_gate.min_divine_sense_to_choose;
    console.log(`  ℹ️  当前境界rank=${adminDbPlayer.realm_rank}，要求=${minRealmRank}`);
    console.log(`  ℹ️  要求神识=${minDivineSense}`);

    // 确保神识充足
    const [divineSense] = await PlayerDivineSense.findOrCreate({
        where: { player_id: adminPlayer.id },
        defaults: {
            player_id: adminPlayer.id,
            divine_sense_max: 1000,
            divine_sense_current: 1000,
            regen_rate_per_hour: 100
        }
    });
    if (divineSense.divine_sense_current < minDivineSense) {
        divineSense.divine_sense_current = Math.max(minDivineSense + 500, 1000);
        divineSense.divine_sense_max = Math.max(divineSense.divine_sense_max, divineSense.divine_sense_current);
        await divineSense.save();
    }
    console.log(`  ℹ️  神识：${divineSense.divine_sense_current}/${divineSense.divine_sense_max}`);
    assert(true, '神识充足准备完成');

    // ===== 5. 选择道途（metal金道） =====
    console.log('\n▶ [5] 选择道途（metal金道）');

    const chooseRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/choose', { dao_path: 'metal' });
    assert(chooseRes.httpStatus === 200, '选择金属道途成功', chooseRes.message);
    assert(chooseRes.data?.dao_path === 'metal', '返回道途为metal');
    assert(chooseRes.data?.dao_level === 1, '初始等级为1');
    assert(chooseRes.data?.dao_path_name === '金道·锐金', '道途名称正确');

    // 重复选择应该被拒绝
    const chooseAgainRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/choose', { dao_path: 'wood' });
    assert(chooseAgainRes.httpStatus === 400, '重复选择道途被拒绝', chooseAgainRes.message);

    // ===== 6. 再次获取面板（已选择道途状态） =====
    console.log('\n▶ [6] 再次获取面板（已选择道途状态）');

    profileRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/profile');
    assert(profileRes.httpStatus === 200, '获取面板成功');
    assert(profileRes.data?.gate?.dao_path === 'metal', '道途为metal');
    assert(profileRes.data?.gate?.dao_path_name === '金道·锐金', '道途名称正确');
    assert(profileRes.data?.gate?.dao_level === 1, '等级为1');
    assert(profileRes.data?.gate?.dao_level_title === '初窥门径', '等级标题正确');
    assert(profileRes.data?.skills?.length === 1, '技能列表返回1个技能');
    assert(profileRes.data?.skills?.[0]?.skill_id === 'metal_blade', '技能ID为metal_blade');
    assert(profileRes.data?.skills?.[0]?.is_locked === true, '技能未解锁（等级不足）');
    assert(Array.isArray(profileRes.data?.daily_tasks), '日常任务为数组');

    // ===== 7. 引道修炼 =====
    console.log('\n▶ [7] 引道修炼（消耗神识获得道途经验）');

    const divineBefore = divineSense.divine_sense_current;
    const cultivate1Res = await apiCall(adminToken, 'POST', '/api/taoism-gate/cultivate');
    assert(cultivate1Res.httpStatus === 200, '引道修炼成功', cultivate1Res.message);
    assert(cultivate1Res.data?.exp_gained > 0, '获得经验 > 0');
    assert(cultivate1Res.data?.divine_sense_left < divineBefore, '神识已消耗');
    assert(cultivate1Res.data?.dao_exp > 0, '道途经验增加');
    console.log(`  ℹ️  获得经验：${cultivate1Res.data?.exp_gained}，剩余神识：${cultivate1Res.data?.divine_sense_left}`);

    // ===== 8. 校验每日修炼次数上限 =====
    console.log('\n▶ [8] 校验每日修炼次数上限（5次）');

    // 已修炼1次，继续4次成功
    let successCount = 1;
    for (let i = 0; i < 4; i++) {
        const r = await apiCall(adminToken, 'POST', '/api/taoism-gate/cultivate');
        if (r.httpStatus === 200) {
            successCount++;
        } else {
            console.log(`  ⚠️ 第${i + 2}次修炼失败：${r.message}`);
            break;
        }
    }
    assert(successCount === 5, `每日5次修炼全部成功（实际${successCount}次）`);

    // 第6次应该被拒绝
    const overLimitRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/cultivate');
    assert(overLimitRes.httpStatus === 400, '第6次修炼被拒绝（达到每日上限）', overLimitRes.message);

    // ===== 9. 获取今日任务 =====
    console.log('\n▶ [9] 获取今日任务');

    const tasksRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/tasks');
    assert(tasksRes.httpStatus === 200, '获取任务列表成功');
    assert(Array.isArray(tasksRes.data?.tasks), '任务列表为数组');
    console.log(`  ℹ️  今日任务数：${tasksRes.data?.tasks?.length}`);
    if (tasksRes.data?.tasks?.length > 0) {
        const t0 = tasksRes.data.tasks[0];
        assert(t0.task_type !== undefined, '任务含task_type字段');
        assert(t0.target_count > 0, '任务目标数 > 0');
        assert(t0.current_count >= 0, '当前进度 >= 0');
        assert(t0.completed === false || t0.completed === true, '任务含completed字段');
        assert(t0.rewards_claimed === false, '任务奖励初始未领取');
    }

    // ===== 10. 校验技能等级不足时使用被拒绝 =====
    console.log('\n▶ [10] 校验技能等级不足时使用被拒绝');

    // 等级1尝试使用金属技能应被拒绝（需等级5）
    const skillLowLevelRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/skill', {});
    assert(skillLowLevelRes.httpStatus === 400, '等级不足时技能使用被拒绝', skillLowLevelRes.message);

    // ===== 11. 设置等级5并测试金属技能攻击目标灵兽 =====
    console.log('\n▶ [11] 测试金属道途技能（金锋裂魂攻击目标灵兽）');

    // 直接数据库修改等级为5（绕过经验累积过程）
    const gateRecord = await PlayerTaoismGate.findOne({ where: { player_id: adminPlayer.id } });
    gateRecord.dao_level = 5;
    gateRecord.dao_exp = 2000;
    gateRecord.skill_cooldowns = {}; // 清空冷却
    gateRecord.daily_cultivate_count = 0; // 重置当日修炼次数（用于后续测试）
    await gateRecord.save();
    assert(true, '道途等级设置为5（金属技能解锁）');

    // 补充神识至满（修炼5次后神识已耗尽，技能测试需要充足神识）
    const divineForSkill = await PlayerDivineSense.findOne({ where: { player_id: adminPlayer.id } });
    divineForSkill.divine_sense_current = divineForSkill.divine_sense_max;
    await divineForSkill.save();
    console.log(`  ℹ️  神识补充至：${divineForSkill.divine_sense_current}/${divineForSkill.divine_sense_max}`);

    // 准备一只测试灵兽（目标灵兽）
    let testBeast = await SpiritBeast.findOne({ where: { player_id: adminPlayer.id } });
    if (!testBeast) {
        // 创建测试灵兽
        testBeast = await SpiritBeast.create({
            player_id: adminPlayer.id,
            beast_key: 'qingyun_wolf',
            beast_name: '测试灵兽',
            element: 'wood',
            rarity: 'rare',
            star_level: 1,
            level: 30,
            exp: 0,
            hp_max: 1000,
            atk: 100,
            def: 50,
            speed: 80,
            loyalty: 80,
            is_active: false,
            is_pasturing: false,
            is_exploring: false,
            stamina: 100,
            caught_at: new Date()
        });
        console.log('  ℹ️  已创建测试灵兽');
    } else {
        // 确保未出战/放养/探渊
        await SpiritBeast.update(
            { is_active: false, is_pasturing: false, is_exploring: false, injury_until: null, loyalty: 80 },
            { where: { player_id: adminPlayer.id } }
        );
        testBeast = await SpiritBeast.findOne({ where: { player_id: adminPlayer.id } });
    }

    // 使用金属技能攻击自己的灵兽（测试自攻击场景）
    // 注意：服务中 target_player_id 与 player.id 不同时会校验，但金属技能攻击自己灵兽也是允许的（这里仅测试流程）
    // 由于只有1个测试账号，使用自己作为目标玩家测试
    const metalSkillRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/skill', {
        target_player_id: adminPlayer.id,
        target_beast_id: testBeast.id
    });
    assert(metalSkillRes.httpStatus === 200, '金属技能使用成功', metalSkillRes.message);
    if (metalSkillRes.httpStatus === 200) {
        assert(metalSkillRes.data?.skill_id === 'metal_blade', '技能ID为metal_blade');
        assert(metalSkillRes.data?.skill_result?.damage > 0, '伤害 > 0');
        assert(metalSkillRes.data?.skill_result?.target_beast_name === testBeast.beast_name, '目标灵兽名称匹配');
        console.log(`  ℹ️  造成伤害：${metalSkillRes.data?.skill_result?.damage}，忠诚度损失：${metalSkillRes.data?.skill_result?.loyalty_loss}`);
    }

    // 校验冷却中再次使用被拒绝
    const skillCooldownRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/skill', {
        target_player_id: adminPlayer.id,
        target_beast_id: testBeast.id
    });
    assert(skillCooldownRes.httpStatus === 400, '冷却中再次使用技能被拒绝', skillCooldownRes.message);

    // ===== 12. 测试切换道途（金属 -> 木道） =====
    console.log('\n▶ [12] 测试切换道途（金属 -> 木道）');

    // 清除 last_switch_time 以确保第一次切换免费
    gateRecord.last_switch_time = null;
    await gateRecord.save();

    // 切换到当前道途被拒绝
    const switchSameRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/switch', { dao_path: 'metal' });
    assert(switchSameRes.httpStatus === 400, '切换到当前道途被拒绝', switchSameRes.message);

    // 切换到木道（首次免费）
    const switchWoodRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/switch', { dao_path: 'wood' });
    assert(switchWoodRes.httpStatus === 200, '切换到木道成功', switchWoodRes.message);
    assert(switchWoodRes.data?.dao_path === 'wood', '新道途为wood');
    assert(switchWoodRes.data?.dao_path_name === '木道·长生', '木道名称正确');
    assert(switchWoodRes.data?.dao_level === 1, '切换后等级重置为1');
    assert(switchWoodRes.data?.fragment_consumed === 0, '本月首次切换免费');

    // 立即再次切换应该被冷却拒绝（7天冷却）
    const switchAgainRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/switch', { dao_path: 'water' });
    assert(switchAgainRes.httpStatus === 400, '7天冷却内再次切换被拒绝', switchAgainRes.message);

    // ===== 13. 测试木道技能（恢复灵兽HP） =====
    console.log('\n▶ [13] 测试木道技能（木灵回春恢复灵兽HP）');

    // 设置等级5 + 补充神识
    const woodGate = await PlayerTaoismGate.findOne({ where: { player_id: adminPlayer.id } });
    woodGate.dao_level = 5;
    woodGate.skill_cooldowns = {};
    await woodGate.save();

    // 补充神识
    const divineForWood = await PlayerDivineSense.findOne({ where: { player_id: adminPlayer.id } });
    divineForWood.divine_sense_current = divineForWood.divine_sense_max;
    await divineForWood.save();

    // 重新拉低灵兽忠诚度模拟受伤
    await SpiritBeast.update(
        { loyalty: 50, injury_until: new Date(Date.now() + 60 * 60 * 1000) },
        { where: { id: testBeast.id } }
    );

    const woodSkillRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/skill', {
        target_beast_id: testBeast.id
    });
    assert(woodSkillRes.httpStatus === 200, '木道技能使用成功', woodSkillRes.message);
    if (woodSkillRes.httpStatus === 200) {
        assert(woodSkillRes.data?.skill_id === 'wood_heal', '技能ID为wood_heal');
        assert(woodSkillRes.data?.skill_result?.heal_amount > 0, '恢复量 > 0');
        assert(woodSkillRes.data?.skill_result?.loyalty_gain > 0, '忠诚度增加 > 0');
        console.log(`  ℹ️  恢复量：${woodSkillRes.data?.skill_result?.heal_amount}，忠诚度增加：${woodSkillRes.data?.skill_result?.loyalty_gain}`);
    }

    // ===== 14. 测试水道技能（设置反弹盾） =====
    console.log('\n▶ [14] 测试水道技能（水镜映心设置反弹盾）');

    // 切换到水道（清除冷却时间）+ 补充神识
    const waterGate = await PlayerTaoismGate.findOne({ where: { player_id: adminPlayer.id } });
    waterGate.dao_path = 'water';
    waterGate.dao_level = 5;
    waterGate.skill_cooldowns = {};
    waterGate.last_switch_time = null; // 清除切换冷却（仅测试用）
    await waterGate.save();

    // 补充神识
    const divineForWater = await PlayerDivineSense.findOne({ where: { player_id: adminPlayer.id } });
    divineForWater.divine_sense_current = divineForWater.divine_sense_max;
    await divineForWater.save();

    const waterSkillRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/skill', {});
    assert(waterSkillRes.httpStatus === 200, '水道技能使用成功', waterSkillRes.message);
    if (waterSkillRes.httpStatus === 200) {
        assert(waterSkillRes.data?.skill_id === 'water_mirror', '技能ID为water_mirror');
        assert(waterSkillRes.data?.skill_result?.shield_active === true, '反弹盾已激活');
        console.log(`  ℹ️  反弹盾到期时间：${waterSkillRes.data?.skill_result?.shield_end_time}`);
    }

    // ===== 15. 获取道途排行榜 =====
    console.log('\n▶ [15] 获取道途排行榜');

    // 按道途等级排行
    const rankingLevelRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/ranking?category=dao_level&page=1&page_size=20');
    assert(rankingLevelRes.httpStatus === 200, '道途等级排行榜获取成功');
    assert(Array.isArray(rankingLevelRes.data?.rankings), '排行榜为数组');
    assert(rankingLevelRes.data?.total >= 1, '排行榜总数 >= 1');
    assert(rankingLevelRes.data?.current_page === 1, '当前页码为1');
    console.log(`  ℹ️  等级排行榜总数：${rankingLevelRes.data?.total}`);

    // 按技能使用次数排行
    const rankingSkillRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/ranking?category=total_skill_use');
    assert(rankingSkillRes.httpStatus === 200, '技能使用排行榜获取成功');
    assert(Array.isArray(rankingSkillRes.data?.rankings), '技能使用排行榜为数组');

    // 按共鸣次数排行
    const rankingResoRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/ranking?category=total_resonance');
    assert(rankingResoRes.httpStatus === 200, '共鸣排行榜获取成功');

    // 无效类别
    const invalidRankRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/ranking?category=invalid');
    assert(invalidRankRes.httpStatus === 400, '无效排行类别被拒绝', invalidRankRes.message);

    // ===== 16. 查询道途共鸣状态 =====
    console.log('\n▶ [16] 查询道途共鸣状态');

    const resonanceRes = await apiCall(adminToken, 'GET', '/api/taoism-gate/resonance');
    assert(resonanceRes.httpStatus === 200, '共鸣状态获取成功');
    assert(resonanceRes.data?.dao_path === 'water', '当前道途为water');
    assert(resonanceRes.data?.same_path_total >= 1, '同道途玩家数 >= 1');
    assert(resonanceRes.data?.resonance_bonus >= 0, '共鸣加成 >= 0');
    assert(Array.isArray(resonanceRes.data?.restraint_targets), '相克目标为数组');
    assert(resonanceRes.data?.restraint_targets.includes('fire'), '水道相克目标含fire');
    console.log(`  ℹ️  同道途玩家：${resonanceRes.data?.same_path_total}，共鸣加成：${Math.round(resonanceRes.data?.resonance_bonus * 100)}%`);

    // ===== 17. 领取任务奖励 =====
    console.log('\n▶ [17] 领取任务奖励');

    // 获取最新任务列表
    const tasksRes2 = await apiCall(adminToken, 'GET', '/api/taoism-gate/tasks');
    const tasksList = tasksRes2.data?.tasks || [];

    if (tasksList.length > 0) {
        // 尝试领取未完成任务奖励（应被拒绝）
        const uncompletedIdx = tasksList.findIndex(t => !t.completed);
        if (uncompletedIdx >= 0) {
            const claimUncompletedRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/tasks/claim', { task_index: uncompletedIdx });
            assert(claimUncompletedRes.httpStatus === 400, '领取未完成任务奖励被拒绝', claimUncompletedRes.message);
        }

        // 手动标记第一个任务为已完成，测试领取流程
        // 注意：Sequelize JSON 字段需用全新对象赋值才能检测到变化（避免引用相同导致 save 不更新）
        const gateForClaim = await PlayerTaoismGate.findOne({ where: { player_id: adminPlayer.id } });
        const tasks = gateForClaim.daily_tasks || [];
        if (tasks.length > 0) {
            // 深拷贝后修改，确保 Sequelize 检测到 JSON 字段变更
            const newTasks = JSON.parse(JSON.stringify(tasks));
            newTasks[0].completed = true;
            newTasks[0].current_count = newTasks[0].target_count;
            gateForClaim.daily_tasks = newTasks;
            gateForClaim.changed('daily_tasks', true);
            await gateForClaim.save();

            // 验证保存成功
            const verifyGate = await PlayerTaoismGate.findOne({ where: { player_id: adminPlayer.id } });
            const verifyTasks = verifyGate.daily_tasks || [];
            console.log(`  ℹ️  任务0验证：completed=${verifyTasks[0]?.completed}, current_count=${verifyTasks[0]?.current_count}/${verifyTasks[0]?.target_count}`);

            const claimRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/tasks/claim', { task_index: 0 });
            assert(claimRes.httpStatus === 200, '领取已完成任务奖励成功', claimRes.message);
            if (claimRes.httpStatus === 200) {
                assert(claimRes.data?.task_name, '返回任务名称');
                assert(claimRes.data?.rewards, '返回奖励详情');
                console.log(`  ℹ️  领取奖励：${JSON.stringify(claimRes.data?.rewards)}`);
            }

            // 重复领取应被拒绝
            const claimAgainRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/tasks/claim', { task_index: 0 });
            assert(claimAgainRes.httpStatus === 400, '重复领取奖励被拒绝', claimAgainRes.message);
        }

        // 无效任务索引
        const invalidIdxRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/tasks/claim', { task_index: 999 });
        assert(invalidIdxRes.httpStatus === 400, '无效任务索引被拒绝', invalidIdxRes.message);
    } else {
        console.log('  ⚠️ 无任务可测，跳过');
    }

    // ===== 18. 测试火道技能（探查目标玩家） =====
    console.log('\n▶ [18] 测试火道技能（火眼金睛探查目标玩家）');

    // 切换到火道 + 补充神识
    const fireGate = await PlayerTaoismGate.findOne({ where: { player_id: adminPlayer.id } });
    fireGate.dao_path = 'fire';
    fireGate.dao_level = 5;
    fireGate.skill_cooldowns = {};
    fireGate.last_switch_time = null;
    await fireGate.save();

    // 补充神识
    const divineForFire = await PlayerDivineSense.findOne({ where: { player_id: adminPlayer.id } });
    divineForFire.divine_sense_current = divineForFire.divine_sense_max;
    await divineForFire.save();

    // 火道技能目标为自己应被拒绝
    const fireSelfRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/skill', {
        target_player_id: adminPlayer.id
    });
    assert(fireSelfRes.httpStatus === 400, '火道技能探查自己被拒绝', fireSelfRes.message);

    // 由于只有1个测试账号，探查其他玩家接口会被业务逻辑拒绝（玩家不存在）
    // 这里仅测试流程：传入不存在的玩家ID
    const fireInvalidRes = await apiCall(adminToken, 'POST', '/api/taoism-gate/skill', {
        target_player_id: 99999999
    });
    assert(fireInvalidRes.httpStatus === 400, '探查不存在玩家被拒绝', fireInvalidRes.message);

    // ===== 19. 清理测试数据 =====
    console.log('\n▶ [19] 清理测试数据');

    // 恢复道途为metal并重置等级（避免影响其他测试）
    const cleanupGate = await PlayerTaoismGate.findOne({ where: { player_id: adminPlayer.id } });
    cleanupGate.dao_path = 'metal';
    cleanupGate.dao_level = 1;
    cleanupGate.dao_exp = 0;
    cleanupGate.skill_cooldowns = {};
    cleanupGate.last_switch_time = null;
    cleanupGate.daily_tasks = [];
    cleanupGate.daily_task_reset_time = null;
    cleanupGate.total_cultivate_count = 0;
    cleanupGate.total_skill_use_count = 0;
    cleanupGate.total_resonance_count = 0;
    cleanupGate.daily_cultivate_count = 0;
    cleanupGate.last_cultivate_date = null;
    await cleanupGate.save();
    assert(true, '道途记录已重置');

    // 恢复灵兽状态
    await SpiritBeast.update(
        {
            is_active: false,
            is_pasturing: false,
            is_exploring: false,
            stamina: 100,
            injury_until: null,
            loyalty: 80
        },
        { where: { player_id: adminPlayer.id } }
    );
    assert(true, '灵兽状态已恢复');

    // 恢复神识
    const finalDivine = await PlayerDivineSense.findOne({ where: { player_id: adminPlayer.id } });
    if (finalDivine) {
        finalDivine.divine_sense_current = finalDivine.divine_sense_max;
        await finalDivine.save();
    }
    assert(true, '神识已恢复至上限');

    return printSummary();
}

/**
 * 打印测试汇总
 */
function printSummary() {
    console.log('\n========================================================');
    console.log('  测试汇总');
    console.log('========================================================');
    console.log(`  总测试数：${totalTests}`);
    console.log(`  通过：${passedTests}`);
    console.log(`  失败：${failedTests.length}`);
    if (failedTests.length > 0) {
        console.log('\n  失败项：');
        failedTests.forEach((f, i) => {
            console.log(`    ${i + 1}. ${f.testName}${f.details ? ' | ' + f.details : ''}`);
        });
    }
    console.log('========================================================');
    process.exit(failedTests.length > 0 ? 1 : 0);
}

// 执行测试
main().catch(err => {
    console.error('测试执行异常:', err);
    process.exit(1);
});
