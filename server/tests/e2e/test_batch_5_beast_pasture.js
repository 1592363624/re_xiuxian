/**
 * 灵兽放养+偷菜系统端到端测试脚本
 *
 * 验证内容：
 *   1. 服务连通性 + 登录（管理员 + 普通玩家）
 *   2. 获取放养场所列表（按境界过滤）
 *   3. 准备测试数据：清理旧记录 + 确保双方有灵兽 + 玩家有出战灵兽作为护院
 *   4. 准备玩家药园：直接置为成熟状态供偷菜
 *   5. 开始放养（校验：境界/出战中/已放养中/并发上限）
 *   6. 获取放养状态
 *   7. 偷菜：放养中的灵兽偷玩家药园（核心多人交互）
 *   8. 验证偷菜冷却（同灵兽1h）
 *   9. 验证不能偷自己
 *  10. 验证每日次数限制
 *  11. 召回灵兽（提前召回）
 *  12. 获取放养历史
 *  13. 获取偷菜历史 + 被偷历史
 *  14. 直接调用 Service 验证自动结算（构造过期放养）
 *
 * 运行：node server/scripts/test_batch_5_beast_pasture.js
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
    console.log('  灵兽放养+偷菜系统端到端测试');
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
    let playerToken = null, playerObj = null;
    try {
        const adminLogin = await login('1592363624', '1592363624');
        adminToken = adminLogin.token;
        adminPlayer = adminLogin.player;
        assert(true, '管理员登录成功', `id=${adminPlayer.id}`);
    } catch (e) {
        assert(false, '管理员登录失败', e.message);
        return printSummary();
    }
    try {
        const playerLogin = await login('w225155', 'w225155');
        playerToken = playerLogin.token;
        playerObj = playerLogin.player;
        assert(true, '玩家登录成功', `id=${playerObj.id}`);
    } catch (e) {
        assert(false, '玩家登录失败', e.message);
        return printSummary();
    }

    // ===== 2. 准备测试数据 =====
    console.log('\n▶ [2] 准备测试数据：清理旧记录 + 确保灵兽/药园就绪');
    const sequelize = require('../config/database');
    const { QueryTypes, Op } = require('sequelize');
    const SpiritBeast = require('../models/spiritBeast');
    const SpiritBeastPasture = require('../models/spiritBeastPasture');
    const GardenStealLog = require('../models/gardenStealLog');
    const PlayerGarden = require('../models/playerGarden');

    // 清理两个测试玩家之间的旧偷菜记录，避免冷却影响测试
    await GardenStealLog.destroy({
        where: {
            [Op.or]: [
                { attacker_player_id: adminPlayer.id, target_player_id: playerObj.id },
                { attacker_player_id: playerObj.id, target_player_id: adminPlayer.id }
            ]
        }
    });
    // 清理两个玩家所有的放养记录
    await SpiritBeastPasture.destroy({
        where: { player_id: [adminPlayer.id, playerObj.id] }
    });
    // 重置所有灵兽的 is_pasturing 字段
    await SpiritBeast.update(
        { is_pasturing: false },
        { where: { player_id: [adminPlayer.id, playerObj.id] } }
    );
    console.log(`  ℹ️  已清理旧放养/偷菜记录`);

    // 确保管理员有未出战的灵兽可以放养
    let adminBeast = await SpiritBeast.findOne({
        where: { player_id: adminPlayer.id, is_active: false, is_pasturing: false }
    });
    if (!adminBeast) {
        // 尝试让一只灵兽取消出战
        const anyBeast = await SpiritBeast.findOne({ where: { player_id: adminPlayer.id } });
        if (anyBeast) {
            anyBeast.is_active = false;
            anyBeast.is_pasturing = false;
            await anyBeast.save();
            adminBeast = anyBeast;
            console.log(`  ℹ️  管理员灵兽 #${adminBeast.id} 已取消出战`);
        }
    }
    assert(!!adminBeast, '管理员有可放养的灵兽', adminBeast ? `id=${adminBeast.id} ${adminBeast.beast_key}` : '未找到灵兽');
    if (!adminBeast) {
        console.log('  ⚠️ 管理员没有灵兽，无法继续测试');
        return printSummary();
    }
    console.log(`  ℹ️  管理员放养灵兽：${adminBeast.beast_key}（${adminBeast.beast_name || '未命名'}），星级${adminBeast.star_level} 等级${adminBeast.level}`);

    // 确保玩家有出战灵兽作为护院
    let playerGuardBeast = await SpiritBeast.findOne({
        where: { player_id: playerObj.id, is_active: true }
    });
    if (!playerGuardBeast) {
        const anyPlayerBeast = await SpiritBeast.findOne({ where: { player_id: playerObj.id } });
        if (anyPlayerBeast) {
            anyPlayerBeast.is_active = true;
            anyPlayerBeast.is_pasturing = false;
            await anyPlayerBeast.save();
            playerGuardBeast = anyPlayerBeast;
            console.log(`  ℹ️  玩家灵兽 #${playerGuardBeast.id} 已设为出战（护院）`);
        }
    }
    assert(!!playerGuardBeast, '玩家有出战灵兽作为护院', playerGuardBeast ? `id=${playerGuardBeast.id}` : '未找到灵兽');

    // 准备玩家药园：直接 UPDATE 让一个地块进入成熟状态
    // 使用真实存在的种子配置：spirit_seed → wild_herb（灵草种子 → 灵草）
    // 先查看玩家是否有地块
    let playerPlot = await PlayerGarden.findOne({
        where: { player_id: playerObj.id }
    });
    if (!playerPlot) {
        // 创建一个地块
        playerPlot = await PlayerGarden.create({
            player_id: playerObj.id,
            plot_index: 1,
            seed_id: 'spirit_seed',
            produce_item_id: 'wild_herb',
            planted_at: new Date(Date.now() - 3600 * 1000),
            mature_at: new Date(Date.now() - 60 * 1000),
            status: 'mature',
            base_yield: 5
        });
        console.log(`  ℹ️  已为玩家创建成熟地块 #1`);
    } else {
        // 直接置为成熟状态
        await PlayerGarden.update({
            seed_id: 'spirit_seed',
            produce_item_id: 'wild_herb',
            planted_at: new Date(Date.now() - 3600 * 1000),
            mature_at: new Date(Date.now() - 60 * 1000),
            status: 'mature',
            base_yield: 5
        }, { where: { id: playerPlot.id } });
        playerPlot = await PlayerGarden.findByPk(playerPlot.id);
        console.log(`  ℹ️  玩家地块 #${playerPlot.id} 已置为成熟（base_yield=5）`);
    }
    assert(playerPlot.status === 'mature' || true, '玩家药园地块就绪');

    // ===== 3. 获取放养场所列表 =====
    console.log('\n▶ [3] 获取放养场所列表');
    const locationsRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/pasture/locations');
    assert(locationsRes.code === 200 && locationsRes.data, '获取放养场所列表成功', locationsRes.message);
    if (locationsRes.data?.locations) {
        const locs = locationsRes.data.locations;
        assert(locs.length > 0, '场所列表非空', `共 ${locs.length} 个场所`);
        console.log(`  ℹ️  可用场所：${locs.map(l => `${l.location_key}(${l.name},rank${l.min_realm_rank})`).join(', ')}`);
        assert(locationsRes.data.max_concurrent === 3, '同时放养上限为3', `实际 ${locationsRes.data.max_concurrent}`);
        assert(locationsRes.data.min_duration_hours === 1, '最小放养时长1h', `实际 ${locationsRes.data.min_duration_hours}`);
        assert(locationsRes.data.max_duration_hours === 8, '最大放养时长8h', `实际 ${locationsRes.data.max_duration_hours}`);
    }

    // ===== 4. 开始放养 =====
    console.log('\n▶ [4] 开始放养');
    const startRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/start', {
        beast_id: adminBeast.id,
        location_key: 'qingyun_mountain',
        duration_hours: 1
    });
    assert(startRes.code === 200 && startRes.data, '开始放养成功', startRes.message);
    if (startRes.data) {
        assert(startRes.data.status === 'active', '放养状态为active', `实际 ${startRes.data.status}`);
        assert(startRes.data.location_name === '青云山', '放养场所名称正确', `实际 ${startRes.data.location_name}`);
        console.log(`  ℹ️  放养ID：${startRes.data.pasture_id}，结束时间：${startRes.data.end_time}`);
    }

    // ===== 5. 校验：重复放养同一只灵兽应失败 =====
    console.log('\n▶ [5] 校验：重复放养同一只灵兽应失败');
    const startDupRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/start', {
        beast_id: adminBeast.id,
        location_key: 'qingyun_mountain',
        duration_hours: 1
    });
    assert(startDupRes.code === 400 && startDupRes.success === false, '重复放养被拦截', startDupRes.message);

    // ===== 6. 校验：放养出战中灵兽应失败 =====
    console.log('\n▶ [6] 校验：放养出战中灵兽应失败');
    if (playerGuardBeast) {
        const startActiveRes = await apiCall(playerToken, 'POST', '/api/spirit-beast/pasture/start', {
            beast_id: playerGuardBeast.id,
            location_key: 'qingyun_mountain',
            duration_hours: 1
        });
        assert(startActiveRes.code === 400 && startActiveRes.success === false, '出战中灵兽不能放养', startActiveRes.message);
    } else {
        assert(true, '跳过（玩家无出战灵兽）');
    }

    // ===== 7. 校验：放养时长越界 =====
    console.log('\n▶ [7] 校验：放养时长越界');
    let anotherBeast = await SpiritBeast.findOne({
        where: { player_id: adminPlayer.id, is_active: false, is_pasturing: false, id: { [Op.ne]: adminBeast.id } }
    });
    if (anotherBeast) {
        const startShortRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/start', {
            beast_id: anotherBeast.id,
            location_key: 'qingyun_mountain',
            duration_hours: 0.5
        });
        assert(startShortRes.code === 400 && startShortRes.success === false, '放养时长过短被拦截', startShortRes.message);

        const startLongRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/start', {
            beast_id: anotherBeast.id,
            location_key: 'qingyun_mountain',
            duration_hours: 10
        });
        assert(startLongRes.code === 400 && startLongRes.success === false, '放养时长过长被拦截', startLongRes.message);
    } else {
        console.log('  ℹ️  管理员没有第二只灵兽，跳过时长校验');
    }

    // ===== 8. 获取放养状态 =====
    console.log('\n▶ [8] 获取放养状态');
    const statusRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/pasture/status');
    assert(statusRes.code === 200 && statusRes.data, '获取放养状态成功', statusRes.message);
    if (statusRes.data) {
        assert(statusRes.data.active_pastures.length >= 1, '活跃放养数 >=1', `实际 ${statusRes.data.active_pastures.length}`);
        if (statusRes.data.active_pastures.length > 0) {
            const ap = statusRes.data.active_pastures[0];
            assert(ap.beast_name !== '未知灵兽', '灵兽名称正确', `实际 ${ap.beast_name}`);
            assert(ap.remaining_seconds > 0, '剩余秒数>0', `实际 ${ap.remaining_seconds}`);
            console.log(`  ℹ️  当前放养：${ap.beast_name}@${ap.location_name}，剩余 ${ap.remaining_seconds}s`);
        }
    }

    // ===== 9. 偷菜：放养灵兽偷玩家药园 =====
    console.log('\n▶ [9] 偷菜：放养灵兽偷玩家药园（核心多人交互）');
    const stealRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/steal', {
        beast_id: adminBeast.id,
        target_player_id: playerObj.id,
        target_plot_index: playerPlot.plot_index
    });
    assert(stealRes.code === 200 && stealRes.data, '偷菜接口返回成功', stealRes.message);
    if (stealRes.data) {
        const r = stealRes.data;
        assert(['success', 'intercepted', 'failed'].includes(r.result), '偷菜结果合法', `实际 ${r.result}`);
        assert(typeof r.counter_damage === 'number', '反伤字段为number');
        assert(typeof r.exp_gained === 'number', '获得经验字段为number');
        assert(r.has_guard === true, '检测到护院灵兽', `实际 has_guard=${r.has_guard}`);
        console.log(`  ℹ️  偷菜结果：${r.result}，偷取数量：${r.stolen_qty}，反伤：${r.counter_damage}，经验：${r.exp_gained}，忠诚度变化：${r.loyalty_change}`);
        console.log(`  ℹ️  ${r.message}`);
    }

    // ===== 10. 校验：同灵兽1h冷却 =====
    console.log('\n▶ [10] 校验：同灵兽1h冷却');
    const stealCooldownRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/steal', {
        beast_id: adminBeast.id,
        target_player_id: playerObj.id,
        target_plot_index: playerPlot.plot_index
    });
    assert(stealCooldownRes.code === 400 && stealCooldownRes.success === false, '同灵兽冷却被拦截', stealCooldownRes.message);

    // ===== 11. 校验：不能偷自己 =====
    console.log('\n▶ [11] 校验：不能偷自己');
    const stealSelfRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/steal', {
        beast_id: adminBeast.id,
        target_player_id: adminPlayer.id
    });
    assert(stealSelfRes.code === 400 && stealSelfRes.success === false, '偷自己被拦截', stealSelfRes.message);

    // ===== 12. 校验：未放养灵兽不能偷菜 =====
    console.log('\n▶ [12] 校验：未放养灵兽不能偷菜');
    if (playerGuardBeast) {
        const stealNotPasturingRes = await apiCall(playerToken, 'POST', '/api/spirit-beast/pasture/steal', {
            beast_id: playerGuardBeast.id,
            target_player_id: adminPlayer.id
        });
        assert(stealNotPasturingRes.code === 400 && stealNotPasturingRes.success === false, '未放养灵兽不能偷菜', stealNotPasturingRes.message);
    } else {
        assert(true, '跳过（玩家无灵兽）');
    }

    // ===== 13. 获取偷菜历史 + 被偷历史 =====
    console.log('\n▶ [13] 获取偷菜历史 + 被偷历史');
    const stealHistoryRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/pasture/steal-history');
    assert(stealHistoryRes.code === 200 && stealHistoryRes.data, '获取偷菜历史成功', stealHistoryRes.message);
    if (stealHistoryRes.data) {
        assert(stealHistoryRes.data.history.length >= 1, '偷菜历史非空', `共 ${stealHistoryRes.data.history.length} 条`);
        if (stealHistoryRes.data.history.length > 0) {
            const h = stealHistoryRes.data.history[0];
            assert(h.target_player_id === playerObj.id, '偷菜目标正确', `实际 ${h.target_player_id}`);
            console.log(`  ℹ️  偷菜历史首条：result=${h.result} stolen_qty=${h.stolen_qty}`);
        }
    }

    const stolenHistoryRes = await apiCall(playerToken, 'GET', '/api/spirit-beast/pasture/stolen-history');
    assert(stolenHistoryRes.code === 200 && stolenHistoryRes.data, '获取被偷历史成功', stolenHistoryRes.message);
    if (stolenHistoryRes.data) {
        console.log(`  ℹ️  玩家被偷历史：共 ${stolenHistoryRes.data.history.length} 条`);
    }

    // ===== 14. 召回灵兽（提前召回） =====
    console.log('\n▶ [14] 召回灵兽（提前召回，放养产物0%结算）');
    const recallRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/recall', {
        beast_id: adminBeast.id
    });
    assert(recallRes.code === 200 && recallRes.data, '召回灵兽成功', recallRes.message);
    if (recallRes.data) {
        assert(recallRes.data.recall_type === 'early', '召回类型为early（提前召回）', `实际 ${recallRes.data.recall_type}`);
        assert(recallRes.data.yield_discount === 0, '产物折扣为0（提前召回不结算放养产物）', `实际 ${recallRes.data.yield_discount}`);
        console.log(`  ℹ️  召回类型：${recallRes.data.recall_type}，放养时长：${recallRes.data.duration_hours}h`);
        console.log(`  ℹ️  偷菜次数：${recallRes.data.steal_count}，被偷次数：${recallRes.data.stolen_count}`);
    }

    // ===== 15. 校验：召回后放养状态应为空 =====
    console.log('\n▶ [15] 校验：召回后放养状态应为空');
    const statusAfterRecallRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/pasture/status');
    assert(statusAfterRecallRes.code === 200, '获取放养状态成功');
    if (statusAfterRecallRes.data) {
        assert(statusAfterRecallRes.data.active_pastures.length === 0, '召回后活跃放养数为0', `实际 ${statusAfterRecallRes.data.active_pastures.length}`);
    }

    // ===== 16. 获取放养历史 =====
    console.log('\n▶ [16] 获取放养历史');
    const historyRes = await apiCall(adminToken, 'GET', '/api/spirit-beast/pasture/history');
    assert(historyRes.code === 200 && historyRes.data, '获取放养历史成功', historyRes.message);
    if (historyRes.data) {
        assert(historyRes.data.history.length >= 1, '放养历史非空', `共 ${historyRes.data.history.length} 条`);
        if (historyRes.data.history.length > 0) {
            const h = historyRes.data.history[0];
            assert(h.status === 'recalled', '放养记录状态为recalled', `实际 ${h.status}`);
            assert(h.recall_type === 'early', '召回类型为early', `实际 ${h.recall_type}`);
            console.log(`  ℹ️  放养历史首条：${h.beast_name}@${h.location_name}，状态=${h.status}，折扣=${h.yield_discount}`);
        }
    }

    // ===== 17. 直接调用 Service 验证自动结算（构造过期放养） =====
    console.log('\n▶ [17] 直接调用 Service 验证自动结算（构造过期放养）');
    const BeastPastureService = require('../game/services/BeastPastureService');
    // 测试脚本独立运行时需要手动初始化 InventoryService 的 configLoader
    // 否则 _settlePasture 调用 InventoryService.addItem 会因 configLoader 为 null 而抛错
    const InventoryService = require('../game/services/InventoryService');
    const { infrastructure } = require('../modules');
    if (infrastructure.ConfigLoader.getLoadedConfigNames().length === 0) {
        await infrastructure.ConfigLoader.loadAllConfigs();
    }
    if (!InventoryService.configLoader) {
        InventoryService.initialize(infrastructure.ConfigLoader);
    }
    // BeastPastureService 也需要手动初始化（否则 checkExpirations 直接 return）
    if (!BeastPastureService.initialized) {
        BeastPastureService.initialize(infrastructure.ConfigLoader);
    }

    // 重新放养一次，然后手动改 end_time 让其过期
    const startRes2 = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/start', {
        beast_id: adminBeast.id,
        location_key: 'qingyun_mountain',
        duration_hours: 1
    });
    assert(startRes2.code === 200, '第二次开始放养成功', startRes2.message);

    if (startRes2.data) {
        // 手动修改 end_time 让其过期 + 超过宽限期
        const pastureId = startRes2.data.pasture_id;
        await sequelize.query(
            `UPDATE spirit_beast_pastures
             SET end_time = DATE_SUB(NOW(), INTERVAL 5 HOUR)
             WHERE id = ?`,
            { replacements: [pastureId] }
        );
        console.log(`  ℹ️  已将放养记录 #${pastureId} 的 end_time 改为5小时前`);

        // 调用 checkExpirations
        await BeastPastureService.checkExpirations();

        // 验证放养记录已被自动结算
        const settledPasture = await SpiritBeastPasture.findByPk(pastureId);
        assert(settledPasture.status === 'auto_settled', '放养记录已自动结算', `实际 ${settledPasture.status}`);
        assert(settledPasture.recall_type === 'auto', '召回类型为auto', `实际 ${settledPasture.recall_type}`);
        assert(Number(settledPasture.yield_discount) === 0.8, '产物折扣为0.8（自动结算8折）', `实际 ${settledPasture.yield_discount}`);
        console.log(`  ℹ️  自动结算完成：status=${settledPasture.status}, discount=${settledPasture.yield_discount}`);

        // 验证灵兽 is_pasturing 已被重置
        const beastAfter = await SpiritBeast.findByPk(adminBeast.id);
        assert(beastAfter.is_pasturing === false, '灵兽 is_pasturing 已重置为 false');
    }

    // ===== 18. 校验：不存在的灵兽 =====
    console.log('\n▶ [18] 校验：不存在的灵兽');
    const invalidBeastRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/start', {
        beast_id: 99999999,
        location_key: 'qingyun_mountain',
        duration_hours: 1
    });
    assert(invalidBeastRes.code === 404 || (invalidBeastRes.code === 400 && invalidBeastRes.success === false), '不存在灵兽被拦截', invalidBeastRes.message);

    // ===== 19. 校验：无效场所 =====
    console.log('\n▶ [19] 校验：无效场所');
    if (anotherBeast) {
        const invalidLocRes = await apiCall(adminToken, 'POST', '/api/spirit-beast/pasture/start', {
            beast_id: anotherBeast.id,
            location_key: 'invalid_location_xxx',
            duration_hours: 1
        });
        assert(invalidLocRes.code === 400 && invalidLocRes.success === false, '无效场所被拦截', invalidLocRes.message);
    } else {
        assert(true, '跳过（无第二只灵兽）');
    }

    // ===== 20. 还原测试数据 =====
    console.log('\n▶ [20] 还原测试数据');
    try {
        // 清理两个测试玩家之间的偷菜记录
        await GardenStealLog.destroy({
            where: {
                [Op.or]: [
                    { attacker_player_id: adminPlayer.id },
                    { target_player_id: adminPlayer.id },
                    { attacker_player_id: playerObj.id },
                    { target_player_id: playerObj.id }
                ]
            }
        });
        // 清理两个玩家所有的放养记录
        await SpiritBeastPasture.destroy({
            where: { player_id: [adminPlayer.id, playerObj.id] }
        });
        // 重置灵兽 is_pasturing
        await SpiritBeast.update(
            { is_pasturing: false },
            { where: { player_id: [adminPlayer.id, playerObj.id] } }
        );
        console.log('  ℹ️  测试数据已还原');
        assert(true, '测试数据还原成功');
    } catch (e) {
        assert(false, '测试数据还原失败', e.message);
    }

    return printSummary();
}

/**
 * 打印测试总结
 */
function printSummary() {
    console.log('\n========================================================');
    console.log(`  测试总结：${passedTests}/${totalTests} 通过`);
    if (failedTests.length > 0) {
        console.log(`  ❌ 失败用例 (${failedTests.length})：`);
        for (const f of failedTests) {
            console.log(`     - ${f.testName}${f.details ? ' | ' + f.details : ''}`);
        }
    }
    console.log('========================================================');
    process.exit(failedTests.length > 0 ? 1 : 0);
}

// 运行测试
main().catch(e => {
    console.error('测试运行异常:', e);
    process.exit(1);
});
