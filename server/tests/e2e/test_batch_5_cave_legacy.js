/**
 * 坐化遗府系统测试脚本
 *
 * 验证内容：
 *   1. 配置加载与初始化（ConfigLoader + CaveLegacyService）
 *   2. 管理员预览遗府（preview）
 *   3. 管理员开启遗府（open）
 *   4. 玩家查询当前遗府（active）
 *   5. 玩家转动分宝（spin）- 单人验证 + 同主魂唯一性验证
 *   6. 玩家查询分宝历史（history）
 *   7. 管理员关闭遗府（close）+ 结算未分配物品
 *   8. 调度器自动关闭过期遗府
 *
 * 测试前置条件：
 *   - 服务器已启动（端口 5000）
 *   - 管理员账号：1592363624 / 1592363624（id=1，admin）
 *   - 普通玩家账号：w225155 / w225155（id=9）
 *   - 玩家 id=2 ~ id=8 中至少 1 个作为"坐化玩家"（储物袋需有 material/consumable 物品）
 *   - 测试前自动给坐化玩家添加物品（若不足）
 *
 * 运行：node server/scripts/test_batch_5_cave_legacy.js
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
 * 检查服务连通性
 */
async function checkHealth() {
    try {
        const res = await fetch(`${BASE_URL}/api/health`);
        const data = await res.json();
        return data.code === 200 && data.status === 'ok';
    } catch (e) {
        return false;
    }
}

/**
 * 主测试函数
 */
async function main() {
    console.log('========================================================');
    console.log('批次5 坐化遗府系统测试');
    console.log('========================================================\n');

    // ===== 1. 服务连通性检查 =====
    console.log('▶ [1] 服务连通性检查');
    const healthOk = await checkHealth();
    assert(healthOk, '服务连通性', healthOk ? '' : '服务器未启动或 /api/health 异常');
    if (!healthOk) {
        console.log('\n❌ 服务未启动，终止测试。请先运行 npm start');
        process.exit(1);
    }

    // ===== 2. 登录 =====
    console.log('\n▶ [2] 登录获取 token');
    let adminToken, adminPlayer, playerToken, playerObj;
    try {
        const adminLogin = await login('1592363624', '1592363624');
        adminToken = adminLogin.token;
        adminPlayer = adminLogin.player;
        assert(true, '管理员登录成功', `id=${adminPlayer.id}, nickname=${adminPlayer.nickname}`);
    } catch (e) {
        assert(false, '管理员登录失败', e.message);
        process.exit(1);
    }
    try {
        const playerLogin = await login('w225155', 'w225155');
        playerToken = playerLogin.token;
        playerObj = playerLogin.player;
        assert(true, '玩家登录成功', `id=${playerObj.id}, nickname=${playerObj.nickname}`);
    } catch (e) {
        assert(false, '玩家登录失败', e.message);
        process.exit(1);
    }

    // ===== 2.5 为测试玩家 w225155 注入资格数据（满足 eligibility 阈值） =====
    // 资格要求：last_online 近 7 天 / total_online_time >= 30 分钟 / stats 指令数 >= 50 / exp >= 100 / createdAt >= 3 天前
    console.log('\n▶ [2.5] 为测试玩家注入资格数据（使其满足分宝 eligibility）');
    try {
        const sequelize = require('../config/database');
        const threeDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
        // 注入：last_online=now, total_online_time=2 小时, createdAt=4 天前, stats 含足量指令计数, exp=10000
        const statsJson = JSON.stringify({
            meditation_count: 20,
            breakthrough_count: 10,
            kill_count: 15,
            exploration_count: 30,
            alchemy_count: 5,
            refining_count: 5,
            items_collected: 10,
            achievements_completed: 5
        });
        await sequelize.query(
            `UPDATE players SET
                last_online = ?,
                total_online_time = 7200000,
                createdAt = ?,
                stats = ?,
                exp = 10000
             WHERE id = ?`,
            { replacements: [nowStr, threeDaysAgo, statsJson, playerObj.id] }
        );
        console.log(`  ℹ️  已注入资格数据：last_online=now, online=2h, createdAt=-4d, cmdCount=100, exp=10000`);
        assert(true, '测试玩家资格数据注入成功');
    } catch (e) {
        assert(false, '测试玩家资格数据注入失败', e.message);
    }

    // ===== 3. 给坐化玩家准备物品（通过 admin API 发放物品） =====
    // 选择一个非测试玩家的 ID 作为"坐化玩家"——优先使用 id=2
    // 注意：实际生产中坐化玩家应该是已死亡或长期不上线的玩家
    const ownerId = 2;
    console.log(`\n▶ [3] 为坐化玩家 id=${ownerId} 准备测试物品`);

    // 查询坐化玩家是否存在（GET /api/admin/players 返回 { code, players, total, ... }）
    const playersListRes = await apiCall(adminToken, 'GET', '/api/admin/players?page=1&limit=100');
    let ownerExists = false;
    let ownerNickname = '';
    const playersList = playersListRes.players || playersListRes.data?.players || [];
    if (Array.isArray(playersList)) {
        const owner = playersList.find(p => p.id === ownerId);
        if (owner) {
            ownerExists = true;
            ownerNickname = owner.nickname;
        }
    }
    assert(ownerExists, `坐化玩家 id=${ownerId} 存在`, ownerExists ? `nickname=${ownerNickname}` : '请检查 /api/admin/players 接口');
    if (!ownerExists) {
        console.log('\n❌ 无法获取坐化玩家信息，终止测试');
        process.exit(1);
    }

    // 通过管理员发放物品接口给坐化玩家发放测试物品
    // POST /api/admin/give-item 参数：{ playerId, itemId, quantity }
    // 物品列表（item_data.json 中的真实 key）：material + consumable 各一些
    const testItems = [
        { item_key: 'low_healing_pill', quantity: 10 },   // 回春丹（consumable/healing/common）
        { item_key: 'mid_healing_pill', quantity: 5 },    // 小还丹（consumable/healing/uncommon）
        { item_key: 'high_healing_pill', quantity: 3 },   // 大还丹（consumable/healing/rare）
        { item_key: 'foundation_pill', quantity: 2 },     // 筑基丹（consumable/breakthrough/rare）
        { item_key: 'gold_pill', quantity: 1 }            // 结金丹（consumable/breakthrough/epic）
    ];

    let grantedCount = 0;
    for (const item of testItems) {
        // POST /api/admin/give-item，参数名为 playerId/itemId/quantity
        const grantRes = await apiCall(adminToken, 'POST', '/api/admin/give-item', {
            playerId: ownerId,
            itemId: item.item_key,
            quantity: item.quantity
        });
        if (grantRes.code === 200 && grantRes.success !== false) {
            grantedCount++;
        } else {
            console.log(`  ⚠️ 发放 ${item.item_key} 失败: ${grantRes.message || '未知错误'}`);
        }
    }
    assert(grantedCount >= 1, `至少发放 1 种测试物品（共尝试 ${testItems.length} 种）`, `成功 ${grantedCount}/${testItems.length}`);

    // ===== 4. 管理员预览遗府 =====
    console.log('\n▶ [4] 管理员预览遗府');
    const previewRes = await apiCall(adminToken, 'POST', '/api/cave-legacy/admin/preview', {
        owner_player_id: ownerId
    });
    assert(previewRes.code === 200 && previewRes.success !== false && previewRes.data, '预览接口响应成功');
    if (previewRes.data) {
        assert(previewRes.data.owner?.id === ownerId, '预览返回的 owner.id 正确');
        assert(Array.isArray(previewRes.data.items), '预览返回 items 数组');
        assert(previewRes.data.items.length >= 1, `预览物品数量 >= 1（实际 ${previewRes.data.items.length}）`);
        assert(typeof previewRes.data.eligible_players_estimate === 'number', '预览返回合格玩家估算');
        console.log(`  📊 预览物品数: ${previewRes.data.items.length}, 合格玩家估算: ${previewRes.data.eligible_players_estimate}`);
        if (previewRes.data.items.length > 0) {
            console.log(`  📦 物品示例: ${previewRes.data.items[0].name} x${previewRes.data.items[0].quantity} (${previewRes.data.items[0].quality})`);
        }
    }

    // ===== 5. 管理员开启遗府 =====
    console.log('\n▶ [5] 管理员开启遗府');
    const openRes = await apiCall(adminToken, 'POST', '/api/cave-legacy/admin/open', {
        owner_player_id: ownerId,
        duration_hours: 2
    });
    assert(openRes.code === 200 && openRes.success !== false && openRes.data, '开启接口响应成功');
    let legacyId = null;
    if (openRes.data) {
        legacyId = openRes.data.legacy_id;
        assert(legacyId > 0, `返回 legacy_id > 0 (实际 ${legacyId})`);
        assert(openRes.data.status === 'open', '返回 status=open');
        assert(openRes.data.items_count >= 1, `返回 items_count >= 1 (实际 ${openRes.data.items_count})`);
        console.log(`  🎁 遗府 ${legacyId} 已开启，物品 ${openRes.data.items_count} 种 ${openRes.data.items_total_quantity} 件`);
    }
    if (!legacyId) {
        console.log('\n❌ 未获取到 legacy_id，终止测试');
        process.exit(1);
    }

    // ===== 6. 玩家查询当前遗府 =====
    console.log('\n▶ [6] 玩家查询当前遗府');
    const activeRes = await apiCall(playerToken, 'GET', '/api/cave-legacy/active');
    assert(activeRes.code === 200 && activeRes.success !== false && activeRes.data, '查询接口响应成功');
    if (activeRes.data) {
        assert(Array.isArray(activeRes.data.active_legacies), '返回 active_legacies 数组');
        assert(activeRes.data.active_legacies.length >= 1, `当前至少 1 个开启遗府（实际 ${activeRes.data.active_legacies.length}）`);
        const target = activeRes.data.active_legacies.find(l => l.legacy_id === legacyId);
        assert(!!target, `列表包含刚开启的遗府 id=${legacyId}`);
        if (target) {
            assert(target.owner_nickname === ownerNickname, `返回 owner_nickname=${target.owner_nickname}`);
            assert(target.player_status.has_participated === false, '玩家尚未参与');
            assert(Array.isArray(target.quality_summary), '返回 quality_summary 数组');
            console.log(`  📋 玩家状态: eligible=${target.player_status.eligible}, status=${target.player_status.eligibility_status}`);
            if (target.player_status.ineligibility_reason) {
                console.log(`  ⚠️ 不合格原因: ${target.player_status.ineligibility_reason}`);
            }
        }
    }

    // ===== 7. 玩家转动分宝 =====
    console.log('\n▶ [7] 玩家转动分宝');
    const spinRes = await apiCall(playerToken, 'POST', '/api/cave-legacy/spin', {
        legacy_id: legacyId
    });
    if (spinRes.code === 200 && spinRes.success !== false && spinRes.data) {
        assert(true, '分宝接口响应成功');
        assert(spinRes.data.legacy_id === legacyId, '返回 legacy_id 正确');
        assert(Array.isArray(spinRes.data.distributed_items), '返回 distributed_items 数组');
        assert(spinRes.data.distributed_items.length >= 1, `分得至少 1 种物品（实际 ${spinRes.data.distributed_items.length}）`);
        assert(spinRes.data.total_quantity >= 1, `分得总数量 >= 1（实际 ${spinRes.data.total_quantity}）`);
        console.log(`  🎉 分宝成功：${spinRes.data.total_item_types} 种 ${spinRes.data.total_quantity} 件`);
        for (const item of spinRes.data.distributed_items) {
            console.log(`     - ${item.item_name} x${item.quantity}`);
        }
    } else {
        assert(false, '分宝接口响应失败', spinRes.message || JSON.stringify(spinRes));
        console.log(`  ⚠️ 详情: ${JSON.stringify(spinRes)}`);
    }

    // ===== 8. 玩家重复转动分宝（应失败：每期每人一次） =====
    console.log('\n▶ [8] 玩家重复转动分宝（应被拒绝）');
    const spinAgainRes = await apiCall(playerToken, 'POST', '/api/cave-legacy/spin', {
        legacy_id: legacyId
    });
    assert(spinAgainRes.success === false, '重复分宝被拒绝');
    assert(spinAgainRes.message && spinAgainRes.message.includes('已转动'), `错误消息包含"已转动"（实际: ${spinAgainRes.message}）`);

    // ===== 9. 玩家查询分宝历史 =====
    console.log('\n▶ [9] 玩家查询分宝历史');
    const historyRes = await apiCall(playerToken, 'GET', '/api/cave-legacy/history');
    assert(historyRes.code === 200 && historyRes.success !== false && historyRes.data, '历史接口响应成功');
    if (historyRes.data) {
        assert(Array.isArray(historyRes.data.history), '返回 history 数组');
        assert(historyRes.data.history.length >= 1, `历史记录 >= 1（实际 ${historyRes.data.history.length}）`);
        const record = historyRes.data.history.find(h => h.legacy_id === legacyId);
        assert(!!record, `历史记录包含刚参与的遗府 id=${legacyId}`);
        if (record) {
            assert(record.participant.has_spun === true, '历史记录 has_spun=true');
            assert(record.participant.total_quantity >= 1, `历史记录 total_quantity >= 1（实际 ${record.participant.total_quantity}）`);
            assert(Array.isArray(record.distributed_items), '历史记录包含 distributed_items');
            console.log(`  📜 历史记录: 遗府 ${record.legacy_id}（${record.owner_nickname}），分得 ${record.participant.total_item_types} 种 ${record.participant.total_quantity} 件`);
        }
    }

    // ===== 10. 管理员后台状态查询 =====
    console.log('\n▶ [10] 管理员后台状态查询');
    const statusRes = await apiCall(adminToken, 'GET', '/api/cave-legacy/admin/status?status=open&page=1&page_size=10');
    assert(statusRes.code === 200 && statusRes.success !== false && statusRes.data, '后台状态接口响应成功');
    if (statusRes.data) {
        assert(Array.isArray(statusRes.data.legacies), '返回 legacies 数组');
        const target = statusRes.data.legacies.find(l => l.id === legacyId);
        assert(!!target, `后台列表包含刚开启的遗府 id=${legacyId}`);
        if (target) {
            assert(target.status === 'open', '后台列表 status=open');
            assert(target.participants_count >= 1, `participants_count >= 1（实际 ${target.participants_count}）`);
            console.log(`  📊 后台状态: 遗府 ${target.id}, status=${target.status}, 参与人数=${target.participants_count}`);
        }
    }

    // ===== 11. 管理员手动关闭遗府 =====
    console.log('\n▶ [11] 管理员手动关闭遗府');
    const closeRes = await apiCall(adminToken, 'POST', '/api/cave-legacy/admin/close', {
        legacy_id: legacyId
    });
    assert(closeRes.code === 200 && closeRes.success !== false && closeRes.data, '关闭接口响应成功');
    if (closeRes.data) {
        assert(closeRes.data.status === 'closed', '返回 status=closed');
        assert(closeRes.data.summary && typeof closeRes.data.summary === 'object', '返回 summary 对象');
        console.log(`  📋 结算摘要:`, JSON.stringify(closeRes.data.summary));
    }

    // ===== 12. 关闭后查询应无开启遗府（如果只有测试创建的这一个） =====
    console.log('\n▶ [12] 关闭后查询当前遗府');
    const activeAfterCloseRes = await apiCall(playerToken, 'GET', '/api/cave-legacy/active');
    assert(activeAfterCloseRes.code === 200 && activeAfterCloseRes.success !== false, '查询接口响应成功');
    if (activeAfterCloseRes.data) {
        const stillOpen = activeAfterCloseRes.data.active_legacies.find(l => l.legacy_id === legacyId);
        assert(!stillOpen, '关闭后该遗府不在 active 列表中');
    }

    // ===== 13. 测试调度器自动过期（开启一个 1 小时的遗府，手动修改 ends_at 让其立即过期） =====
    console.log('\n▶ [13] 调度器自动过期（直接调用 Service.checkExpiredLegacies）');
    // 创建一个会立即过期的遗府（通过直接操作数据库或开启 1 小时后手动改 ends_at）
    // 简化：直接通过 API 开启一个 1 小时的遗府，然后通过 SQL 修改 ends_at 为过去时间
    try {
        const { infrastructure } = require('../modules');
        if (!infrastructure.ConfigLoader.isInitialized) {
            await infrastructure.ConfigLoader.initialize();
        }
        const sequelize = require('../config/database');
        const CaveLegacy = require('../models/caveLegacy');
        // 找最近一个 closed 的遗府，将其改为 open + ends_at=过去，触发自动关闭
        const closedLegacy = await CaveLegacy.findOne({
            where: { status: 'closed' },
            order: [['id', 'DESC']]
        });
        if (closedLegacy) {
            // 重新打开此遗府用于测试调度器
            await sequelize.query(
                `UPDATE cave_legacies SET status='open', ends_at=DATE_SUB(NOW(), INTERVAL 1 MINUTE), closed_at=NULL, close_reason=NULL, settled=0 WHERE id=?`,
                { replacements: [closedLegacy.id] }
            );
            console.log(`  📝 修改遗府 ${closedLegacy.id} 为过期状态`);

            // 调用调度器
            const CaveLegacyService = require('../game/services/CaveLegacyService');
            CaveLegacyService.initialize(infrastructure.ConfigLoader);
            const result = await CaveLegacyService.checkExpiredLegacies();
            assert(result.expired_count >= 1, `调度器关闭至少 1 个过期遗府（实际 ${result.expired_count}）`);

            // 验证遗府已被关闭
            const rechecked = await CaveLegacy.findByPk(closedLegacy.id);
            assert(rechecked.status === 'closed', '调度器关闭后 status=closed');
            assert(rechecked.close_reason === 'expired', `close_reason=expired（实际 ${rechecked.close_reason}）`);
            assert(rechecked.settled === true, 'settled=true');
            console.log(`  ✅ 遗府 ${closedLegacy.id} 已被调度器自动关闭（reason=expired）`);
        } else {
            console.log('  ⚠️ 无 closed 遗府可复用，跳过调度器测试');
            assert(true, '调度器测试跳过（无可用 closed 遗府）');
        }
    } catch (e) {
        assert(false, '调度器测试失败', e.message);
    }

    // ===== 测试结果汇总 =====
    console.log('\n========================================================');
    console.log(`测试结果: ${passedTests}/${totalTests} 通过`);
    if (failedTests.length > 0) {
        console.log(`\n失败项 (${failedTests.length}):`);
        for (const f of failedTests) {
            console.log(`  - ${f.testName}${f.details ? ' | ' + f.details : ''}`);
        }
    }
    console.log('========================================================');

    process.exit(failedTests.length > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
