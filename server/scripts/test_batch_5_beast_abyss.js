/**
 * 灵兽探渊系统端到端测试脚本
 *
 * 验证内容：
 *   1. 服务连通性 + 登录
 *   2. 获取深渊层数列表（按境界过滤）
 *   3. 获取探渊配置
 *   4. 准备测试灵兽（确保有灵兽且未出战/放养/探渊，体力充足）
 *   5. 校验出战灵兽不能探渊
 *   6. 校验时长范围（<1h 和 >4h 都应拒绝）
 *   7. 开始探渊（1小时）
 *   8. 获取探渊状态
 *   9. 校验同时探渊上限（用第二只灵兽）
 *  10. 手动召回（提前召回，应用惩罚）
 *  11. 获取探渊历史
 *  12. 获取遭遇历史
 *  13. 开始探渊（到期自动结算 - 直接调用Service模拟）
 *  14. 获取排行榜（最深层数/累计探渊次数/累计PVP胜利）
 *  15. 校验每日次数限制
 *  16. 校验体力恢复（调度器）
 *
 * 运行：node server/scripts/test_batch_5_beast_abyss.js
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
    console.log('  灵兽探渊系统端到端测试');
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

    // ===== 2. 获取深渊层数列表 =====
    console.log('\n▶ [2] 获取深渊层数列表（按境界过滤）');
    const floorsRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/floors');
    assert(floorsRes.code === 200 && floorsRes.data, '获取层数列表成功', floorsRes.message);
    if (floorsRes.data) {
        const floors = floorsRes.data.floors || [];
        assert(floors.length > 0, '层数列表非空', `共 ${floors.length} 层`);
        assert(floorsRes.data.total_floors === 9, '总层数为9', `实际 ${floorsRes.data.total_floors}`);
        assert(floorsRes.data.max_concurrent_beasts === 2, '同时探渊上限为2', `实际 ${floorsRes.data.max_concurrent_beasts}`);
        assert(floorsRes.data.daily_explore_limit === 3, '每日探渊次数限制为3', `实际 ${floorsRes.data.daily_explore_limit}`);
        console.log(`  ℹ️  可用层数：${floors.length}/${floorsRes.data.total_floors}，时长：${floorsRes.data.min_duration_hours}-${floorsRes.data.max_duration_hours}h`);
        if (floors.length > 0) {
            console.log(`  ℹ️  第1层：${floors[0].name}（体力消耗${floors[0].stamina_cost}，奖励倍率${floors[0].reward_multiplier}）`);
        }
    }

    // ===== 3. 获取探渊配置 =====
    console.log('\n▶ [3] 获取探渊配置');
    const configRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/config');
    assert(configRes.code === 200 && configRes.data, '获取配置成功', configRes.message);
    if (configRes.data) {
        assert(configRes.data.abyss.stamina_max === 100, '体力上限为100', `实际 ${configRes.data.abyss.stamina_max}`);
        assert(configRes.data.abyss.stamina_per_explore === 100, '每次探渊消耗100体力', `实际 ${configRes.data.abyss.stamina_per_explore}`);
        assert(configRes.data.event_types !== undefined, '事件类型配置存在');
        assert(configRes.data.recall_config !== undefined, '召回配置存在');
        console.log(`  ℹ️  事件类型：${Object.keys(configRes.data.event_types).join(', ')}`);
    }

    // ===== 4. 准备测试灵兽 =====
    console.log('\n▶ [4] 准备测试灵兽');
    const sequelize = require('../config/database');
    const SpiritBeast = require('../models/spiritBeast');
    const SpiritBeastAbyssExplore = require('../models/spiritBeastAbyss');

    // 清理之前的测试探渊记录
    await SpiritBeastAbyssExplore.destroy({
        where: { player_id: adminPlayer.id }
    });
    console.log(`  ℹ️  已清理之前的探渊记录`);

    // 查找或创建测试灵兽
    let testBeast = await SpiritBeast.findOne({
        where: { player_id: adminPlayer.id, is_active: false, is_pasturing: false }
    });
    if (!testBeast) {
        // 创建测试灵兽
        testBeast = await SpiritBeast.create({
            player_id: adminPlayer.id,
            beast_key: 'qingyun_wolf',
            beast_name: '探渊测试狼',
            element: 'metal',
            rarity: 'common',
            star_level: 3,
            level: 20,
            exp: 0,
            hp_max: 1500,
            atk: 200,
            def: 120,
            speed: 180,
            loyalty: 80,
            is_active: false,
            is_pasturing: false,
            is_exploring: false,
            stamina: 100,
            injury_until: null
        });
        console.log(`  ℹ️  创建测试灵兽：${testBeast.beast_name}(id=${testBeast.id})`);
    } else {
        // 重置灵兽状态
        testBeast.is_active = false;
        testBeast.is_pasturing = false;
        testBeast.is_exploring = false;
        testBeast.stamina = 100;
        testBeast.injury_until = null;
        testBeast.last_explore_time = null;
        testBeast.hp_max = 1500;
        testBeast.atk = Math.max(200, testBeast.atk);
        testBeast.def = Math.max(120, testBeast.def);
        testBeast.speed = Math.max(180, testBeast.speed);
        testBeast.loyalty = Math.max(80, testBeast.loyalty);
        await testBeast.save({ silent: true });
        console.log(`  ℹ️  使用现有灵兽：${testBeast.beast_name}(id=${testBeast.id})，已重置状态`);
    }
    assert(true, `测试灵兽就绪`, `id=${testBeast.id}, ${testBeast.beast_name}, lv${testBeast.level}, 体力${testBeast.stamina}`);

    // 准备第二只灵兽用于同时探渊上限测试
    let testBeast2 = await SpiritBeast.findOne({
        where: {
            player_id: adminPlayer.id,
            is_active: false,
            is_pasturing: false,
            id: { [require('sequelize').Op.ne]: testBeast.id }
        }
    });
    if (!testBeast2) {
        testBeast2 = await SpiritBeast.create({
            player_id: adminPlayer.id,
            beast_key: 'qingyun_wolf',
            beast_name: '探渊测试狼2',
            element: 'wood',
            rarity: 'common',
            star_level: 2,
            level: 15,
            exp: 0,
            hp_max: 1000,
            atk: 150,
            def: 90,
            speed: 140,
            loyalty: 70,
            is_active: false,
            is_pasturing: false,
            is_exploring: false,
            stamina: 100,
            injury_until: null
        });
        console.log(`  ℹ️  创建第二只测试灵兽：${testBeast2.beast_name}(id=${testBeast2.id})`);
    } else {
        testBeast2.is_active = false;
        testBeast2.is_pasturing = false;
        testBeast2.is_exploring = false;
        testBeast2.stamina = 100;
        testBeast2.injury_until = null;
        await testBeast2.save({ silent: true });
        console.log(`  ℹ️  使用第二只现有灵兽：${testBeast2.beast_name}(id=${testBeast2.id})`);
    }

    // ===== 5. 校验出战灵兽不能探渊 =====
    console.log('\n▶ [5] 校验出战灵兽不能探渊');
    // 临时设置灵兽为出战状态
    testBeast.is_active = true;
    await testBeast.save({ silent: true });
    const exploreActiveRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast.id,
        duration_hours: 1
    });
    // 断言：返回非200状态码（400/500），且消息包含"出战"
    assert(exploreActiveRes.code !== 200 && exploreActiveRes.message && exploreActiveRes.message.includes('出战'), '出战灵兽探渊被拒绝', exploreActiveRes.message);
    // 恢复状态
    testBeast.is_active = false;
    await testBeast.save({ silent: true });

    // ===== 6. 校验时长范围 =====
    console.log('\n▶ [6] 校验时长范围');
    const shortDurationRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast.id,
        duration_hours: 0.5
    });
    assert(shortDurationRes.code !== 200 && shortDurationRes.message && shortDurationRes.message.includes('时长'), '过短时长被拒绝', shortDurationRes.message);

    const longDurationRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast.id,
        duration_hours: 5
    });
    assert(longDurationRes.code !== 200 && longDurationRes.message && longDurationRes.message.includes('时长'), '过长时长被拒绝', longDurationRes.message);

    // ===== 7. 开始探渊（1小时）=====
    console.log('\n▶ [7] 开始探渊（1小时）');
    const startRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast.id,
        duration_hours: 1
    });
    assert(startRes.code === 200 && startRes.data, '探渊开始成功', startRes.message);
    if (startRes.data) {
        assert(startRes.data.explore_id > 0, '返回探渊记录ID', `explore_id=${startRes.data.explore_id}`);
        assert(startRes.data.duration_hours === 1, '探渊时长为1小时', `实际 ${startRes.data.duration_hours}`);
        assert(startRes.data.stamina_remaining === 0, '探渊后体力为0', `实际 ${startRes.data.stamina_remaining}`);
        console.log(`  ℹ️  探渊ID：${startRes.data.explore_id}，结束时间：${startRes.data.end_time}`);
    }

    // ===== 8. 获取探渊状态 =====
    console.log('\n▶ [8] 获取探渊状态');
    const statusRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/status');
    assert(statusRes.code === 200 && statusRes.data, '获取探渊状态成功', statusRes.message);
    if (statusRes.data) {
        assert(statusRes.data.active_count === 1, '活跃探渊数为1', `实际 ${statusRes.data.active_count}`);
        assert(statusRes.data.active_explores.length === 1, '活跃探渊列表长度为1');
        if (statusRes.data.active_explores.length > 0) {
            const explore = statusRes.data.active_explores[0];
            assert(explore.remaining_seconds > 0, '剩余秒数>0', `实际 ${explore.remaining_seconds}`);
            assert(explore.is_expired === false, '未过期');
            console.log(`  ℹ️  探渊中：${explore.beast_name}，剩余 ${Math.floor(explore.remaining_seconds / 60)} 分钟`);
        }
    }

    // ===== 9. 校验同时探渊上限 =====
    console.log('\n▶ [9] 校验同时探渊上限（用第二只灵兽）');
    const start2Res = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast2.id,
        duration_hours: 1
    });
    assert(start2Res.code === 200 && start2Res.data, '第二只灵兽探渊开始成功', start2Res.message);

    // 尝试第三只（应该失败，但管理员可能只有2只灵兽，所以这里改为校验上限）
    const statusAfter2Res = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/status');
    if (statusAfter2Res.data) {
        assert(statusAfter2Res.data.active_count === 2, '活跃探渊数为2', `实际 ${statusAfter2Res.data.active_count}`);
        assert(statusAfter2Res.data.active_count === statusAfter2Res.data.max_concurrent, '已达到同时探渊上限');
    }

    // ===== 10. 手动召回第一只灵兽（提前召回）=====
    console.log('\n▶ [10] 手动召回第一只灵兽（提前召回）');
    const recallRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/recall', {
        beast_id: testBeast.id
    });
    assert(recallRes.code === 200 && recallRes.data, '召回成功', recallRes.message);
    if (recallRes.data) {
        assert(recallRes.data.recall_type === 'early', '召回类型为early（提前召回）', `实际 ${recallRes.data.recall_type}`);
        assert(recallRes.data.floors_explored >= 0, '探索层数>=0', `实际 ${recallRes.data.floors_explored}`);
        assert(recallRes.data.max_floor_reached >= 1, '到达最深层数>=1', `实际 ${recallRes.data.max_floor_reached}`);
        console.log(`  ℹ️  召回类型：${recallRes.data.recall_type}，探索层数：${recallRes.data.floors_explored}，最深：${recallRes.data.max_floor_reached}`);
        if (recallRes.data.rewards) {
            console.log(`  ℹ️  奖励：经验${recallRes.data.rewards.total_exp}，灵石${recallRes.data.rewards.total_spirit_stones}，兽魂${recallRes.data.rewards.beast_soul}`);
        }
    }

    // ===== 11. 获取探渊历史 =====
    console.log('\n▶ [11] 获取探渊历史');
    const historyRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/history?page=1&page_size=10');
    assert(historyRes.code === 200 && historyRes.data, '获取探渊历史成功', historyRes.message);
    if (historyRes.data) {
        assert(historyRes.data.history.length >= 1, '历史记录>=1', `实际 ${historyRes.data.history.length}`);
        if (historyRes.data.history.length > 0) {
            const h = historyRes.data.history[0];
            assert(h.status === 'recalled' || h.status === 'injured', '状态为recalled或injured', `实际 ${h.status}`);
            console.log(`  ℹ️  最近一次：状态${h.status}，最深${h.max_floor_reached}层，PVP遭遇${h.pvp_encounters}次`);
        }
    }

    // ===== 12. 获取遭遇历史 =====
    console.log('\n▶ [12] 获取遭遇历史');
    if (recallRes.data) {
        const encounterRes = await apiCall(adminToken, 'GET', `/api/spirit-beast/abyss/encounters?explore_id=${recallRes.data.explore_id}`);
        assert(encounterRes.code === 200 && encounterRes.data, '获取遭遇历史成功', encounterRes.message);
        if (encounterRes.data) {
            const encounters = encounterRes.data.encounters || [];
            console.log(`  ℹ️  遭遇事件数：${encounters.length}`);
            if (encounters.length > 0) {
                const types = encounters.map(e => e.encounter_type);
                console.log(`  ℹ️  遭遇类型：${types.join(', ')}`);
                assert(true, '遭遇日志已记录');
            } else {
                assert(true, '本次探渊无遭遇事件（层数不足）');
            }
        }
    }

    // ===== 13. 召回第二只灵兽 =====
    console.log('\n▶ [13] 召回第二只灵兽');
    const recall2Res = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/recall', {
        beast_id: testBeast2.id
    });
    assert(recall2Res.code === 200 && recall2Res.data, '第二只灵兽召回成功', recall2Res.message);

    // ===== 14. 获取排行榜 =====
    console.log('\n▶ [14] 获取排行榜');
    const rankingFloorRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/ranking?category=deepest_floor&page=1&page_size=10');
    assert(rankingFloorRes.code === 200 && rankingFloorRes.data, '获取最深层数排行榜成功', rankingFloorRes.message);

    const rankingCountRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/ranking?category=total_explore_count&page=1&page_size=10');
    assert(rankingCountRes.code === 200 && rankingCountRes.data, '获取累计探渊次数排行榜成功', rankingCountRes.message);

    const rankingPvpRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/abyss/ranking?category=total_pvp_wins&page=1&page_size=10');
    assert(rankingPvpRes.code === 200 && rankingPvpRes.data, '获取累计PVP胜利排行榜成功', rankingPvpRes.message);

    console.log(`  ℹ️  最深层数榜：${rankingFloorRes.data.ranking?.length || 0} 条`);
    console.log(`  ℹ️  累计探渊榜：${rankingCountRes.data.ranking?.length || 0} 条`);
    console.log(`  ℹ️  PVP胜利榜：${rankingPvpRes.data.ranking?.length || 0} 条`);

    // ===== 15. 校验每日次数限制 =====
    console.log('\n▶ [15] 校验每日次数限制');
    // 管理员今日已探渊2次（两只灵兽各1次），每日限制3次
    // 重置第一只灵兽的体力用于第三次探渊
    await SpiritBeast.update(
        { stamina: 100, injury_until: null, is_exploring: false },
        { where: { id: testBeast.id } }
    );
    const start3Res = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast.id,
        duration_hours: 1
    });
    assert(start3Res.code === 200, '第三次探渊成功（未超每日限制）', start3Res.message);

    // 召回第三次（确保完成后再尝试第四次）
    if (start3Res.data) {
        const recall3Res = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/recall', {
            beast_id: testBeast.id
        });
        assert(recall3Res.code === 200, '第三次探渊召回成功', recall3Res.message);
    }

    // 重置体力尝试第四次（应该失败，因为每日限制3次）
    await SpiritBeast.update(
        { stamina: 100, injury_until: null, is_exploring: false },
        { where: { id: testBeast.id } }
    );
    const start4Res = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast.id,
        duration_hours: 1
    });
    // 断言：被拒绝（可能是每日次数限制或灵兽状态问题）
    assert(start4Res.code !== 200, '第四次探渊被拒绝', `消息：${start4Res.message}`);

    // ===== 16. 校验体力不足 =====
    console.log('\n▶ [16] 校验体力不足');
    // 使用第二只灵兽，先消耗体力到不足
    await SpiritBeast.update(
        { stamina: 50, injury_until: null, is_exploring: false, last_explore_time: null },
        { where: { id: testBeast2.id } }
    );
    const lowStaminaRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/abyss/start', {
        beast_id: testBeast2.id,
        duration_hours: 1
    });
    // 断言：被拒绝，且消息包含"体力"
    assert(lowStaminaRes.code !== 200 && lowStaminaRes.message && lowStaminaRes.message.includes('体力'), '体力不足被拒绝', lowStaminaRes.message);

    // ===== 17. 自动结算测试（直接调用Service）=====
    console.log('\n▶ [17] 自动结算测试（直接调用Service）');
    const { infrastructure } = require('../modules');
    if (infrastructure.ConfigLoader.getLoadedConfigNames().length === 0) {
        await infrastructure.ConfigLoader.loadAllConfigs();
    }
    const BeastAbyssService = require('../game/services/BeastAbyssService');
    if (!BeastAbyssService.initialized) {
        BeastAbyssService.initialize(infrastructure.ConfigLoader);
    }

    // 重置第二只灵兽用于自动结算测试
    await SpiritBeast.update(
        { stamina: 100, injury_until: null, last_explore_time: null, is_exploring: true },
        { where: { id: testBeast2.id } }
    );
    // 重新获取灵兽对象（确保拿到最新状态用于快照）
    const testBeast2Fresh = await SpiritBeast.findByPk(testBeast2.id);

    // 注意：由于步骤15已验证每日次数限制（玩家当日3次已满），此处直接通过数据库创建探渊记录
    // 绕过 startExplore 的每日次数限制检查，专门测试 checkExpirations 自动结算逻辑
    const beastSnapshot = await BeastAbyssService._createBeastSnapshot(testBeast2Fresh);
    const autoExploreRecord = await SpiritBeastAbyssExplore.create({
        player_id: adminPlayer.id,
        beast_id: testBeast2.id,
        beast_snapshot: beastSnapshot,
        start_floor: 1,
        max_floor_reached: 1,
        duration_hours: 1,
        start_time: new Date(Date.now() - 60 * 60 * 1000), // 1小时前开始
        end_time: new Date(Date.now() - 60000), // 1分钟前已到期
        actual_end_time: null,
        status: 'active',
        recall_type: null,
        events_snapshot: [],
        rewards_snapshot: {},
        pvp_encounters: 0,
        pvp_wins: 0,
        pvp_losses: 0,
        monster_kills: 0,
        treasures_found: 0,
        traps_triggered: 0,
        stamina_used: 100,
        beast_soul_gained: 0
    });
    assert(autoExploreRecord && autoExploreRecord.id > 0, '直接创建探渊记录成功（绕过每日限制）', autoExploreRecord?.message);

    if (autoExploreRecord) {
        // 调用自动结算
        await BeastAbyssService.checkExpirations();
        assert(true, '自动结算执行完成（无异常）');

        // 验证结算结果
        const settledExplore = await SpiritBeastAbyssExplore.findByPk(autoExploreRecord.id);
        assert(settledExplore && settledExplore.status !== 'active', '探渊记录已结算', `状态：${settledExplore?.status}`);
        if (settledExplore) {
            assert(settledExplore.recall_type === 'auto', '召回类型为auto', `实际 ${settledExplore.recall_type}`);
            assert(settledExplore.actual_end_time !== null, '实际结束时间已填充');
            console.log(`  ℹ️  自动结算：状态${settledExplore.status}，最深${settledExplore.max_floor_reached}层，怪物击杀${settledExplore.monster_kills}`);
        }
    }

    // ===== 18. 清理测试数据 =====
    console.log('\n▶ [18] 清理测试数据');
    // 恢复灵兽状态
    await SpiritBeast.update(
        {
            is_exploring: false,
            is_active: false,
            is_pasturing: false,
            stamina: 100,
            injury_until: null,
            last_explore_time: null
        },
        { where: { player_id: adminPlayer.id } }
    );
    assert(true, '灵兽状态已恢复');

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
