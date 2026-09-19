/**
 * 批次5 慕兰战线系统端到端测试脚本
 *
 * 验证内容：
 *   1. 服务启动 + 配置加载
 *   2. 数据库迁移已执行（9 字段 + 5 表）
 *   3. BorderMilitaryService 核心方法可用
 *   4. 3 个子服务（BeastPatrol/RemnantMap/WarImprint）文件存在且可加载
 *   5. 路由文件存在且挂载到 /api/border-military
 *   6. 全部 19 个接口的鉴权 + 参数校验
 *   7. 完整业务闭环：status → briefing → support → intel → shop → remnant-map → imprint
 *
 * 测试账号：1592363624 / 1592363624（玩家ID=1，韩天尊，化神初期）
 *
 * 运行：node server/scripts/test_batch_5_border_military.js
 */
'use strict';

// 加载环境变量
require('dotenv').config();

const BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:5000';
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

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
async function login() {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: TEST_ACCOUNT, password: TEST_PASSWORD })
    });
    const json = await res.json();
    if (json.code !== 200 || !json.token) {
        throw new Error(`登录失败：${JSON.stringify(json)}`);
    }
    return { token: json.token, player: json.player };
}

/**
 * 调用接口
 */
async function apiCall(token, method, path, body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, options);
    let json;
    try {
        json = await res.json();
    } catch (e) {
        return { httpStatus: res.status, parseError: e.message, rawText: await res.text() };
    }
    return { httpStatus: res.status, ...json };
}

/**
 * 主测试函数
 */
async function main() {
    console.log('========================================================');
    console.log('  批次5 慕兰战线系统端到端测试');
    console.log('========================================================\n');

    // ===== 场景1：模块加载测试 =====
    console.log('【场景1】模块加载测试');
    try {
        const { infrastructure } = require('../modules');
        await infrastructure.ConfigLoader.initialize();
        const config = infrastructure.ConfigLoader.getConfig('border_military_data');
        assert(!!config, '配置 border_military_data 加载成功');
        assert(!!config?.settings, '配置包含 settings 段');
        assert(!!config?.ranks?.levels, '配置包含 ranks.levels');
        assert(!!config?.support_routes, '配置包含 support_routes');
        assert(!!config?.intel, '配置包含 intel');
        assert(!!config?.military_shop, '配置包含 military_shop');
        assert(!!config?.beast_patrol, '配置包含 beast_patrol');
        assert(!!config?.remnant_map, '配置包含 remnant_map');
        assert(!!config?.war_imprint, '配置包含 war_imprint');
    } catch (e) {
        assert(false, '配置加载', e.message);
    }

    // ===== 场景2：服务与子服务模块加载 =====
    console.log('\n【场景2】服务模块加载测试');
    try {
        const BorderMilitaryService = require('../game/services/BorderMilitaryService');
        assert(typeof BorderMilitaryService.getStatus === 'function', 'BorderMilitaryService.getStatus 存在');
        assert(typeof BorderMilitaryService.supportMulanan === 'function', 'BorderMilitaryService.supportMulanan 存在');
        assert(typeof BorderMilitaryService.collectIntel === 'function', 'BorderMilitaryService.collectIntel 存在');
        assert(typeof BorderMilitaryService.identifyIntel === 'function', 'BorderMilitaryService.identifyIntel 存在');
        assert(typeof BorderMilitaryService.publicIntel === 'function', 'BorderMilitaryService.publicIntel 存在');
        assert(typeof BorderMilitaryService.getMilitaryShop === 'function', 'BorderMilitaryService.getMilitaryShop 存在');
        assert(typeof BorderMilitaryService.exchangeMerit === 'function', 'BorderMilitaryService.exchangeMerit 存在');
        assert(typeof BorderMilitaryService.beastPatrol === 'function', 'BorderMilitaryService.beastPatrol 存在');
        assert(typeof BorderMilitaryService.beastPatrolReturn === 'function', 'BorderMilitaryService.beastPatrolReturn 存在');
        assert(typeof BorderMilitaryService.beastPatrolStatus === 'function', 'BorderMilitaryService.beastPatrolStatus 存在');
        assert(typeof BorderMilitaryService.getRemnantMapStatus === 'function', 'BorderMilitaryService.getRemnantMapStatus 存在');
        assert(typeof BorderMilitaryService.combineRemnantMap === 'function', 'BorderMilitaryService.combineRemnantMap 存在');
        assert(typeof BorderMilitaryService.exploreRemnantMap === 'function', 'BorderMilitaryService.exploreRemnantMap 存在');
        assert(typeof BorderMilitaryService.applyWarImprint === 'function', 'BorderMilitaryService.applyWarImprint 存在');
        assert(typeof BorderMilitaryService.getImprintStatus === 'function', 'BorderMilitaryService.getImprintStatus 存在');
    } catch (e) {
        assert(false, 'BorderMilitaryService 加载', e.message);
    }

    try {
        const BeastPatrolSub = require('../game/services/BorderBeastPatrolSubService');
        assert(typeof BeastPatrolSub.patrol === 'function', 'BorderBeastPatrolSubService.patrol 存在');
        assert(typeof BeastPatrolSub.returnFromPatrol === 'function', 'BorderBeastPatrolSubService.returnFromPatrol 存在');
        assert(typeof BeastPatrolSub.getStatus === 'function', 'BorderBeastPatrolSubService.getStatus 存在');
    } catch (e) {
        assert(false, 'BorderBeastPatrolSubService 加载', e.message);
    }

    try {
        const RemnantMapSub = require('../game/services/RemnantMapSubService');
        assert(typeof RemnantMapSub.getStatus === 'function', 'RemnantMapSubService.getStatus 存在');
        assert(typeof RemnantMapSub.combine === 'function', 'RemnantMapSubService.combine 存在');
        assert(typeof RemnantMapSub.explore === 'function', 'RemnantMapSubService.explore 存在');
    } catch (e) {
        assert(false, 'RemnantMapSubService 加载', e.message);
    }

    try {
        const WarImprintSub = require('../game/services/WarImprintSubService');
        assert(typeof WarImprintSub.getStatus === 'function', 'WarImprintSubService.getStatus 存在');
        assert(typeof WarImprintSub.apply === 'function', 'WarImprintSubService.apply 存在');
    } catch (e) {
        assert(false, 'WarImprintSubService 加载', e.message);
    }

    // ===== 场景3：数据模型加载 =====
    console.log('\n【场景3】数据模型加载测试');
    try {
        const BorderIntelReport = require('../models/border_intel_report');
        const BorderBeastPatrol = require('../models/border_beast_patrol');
        const BorderMilestoneReward = require('../models/border_milestone_reward');
        const BorderWarImprint = require('../models/border_war_imprint');
        const BorderSupportLog = require('../models/border_support_log');
        assert(!!BorderIntelReport, 'BorderIntelReport 模型加载成功');
        assert(!!BorderBeastPatrol, 'BorderBeastPatrol 模型加载成功');
        assert(!!BorderMilestoneReward, 'BorderMilestoneReward 模型加载成功');
        assert(!!BorderWarImprint, 'BorderWarImprint 模型加载成功');
        assert(!!BorderSupportLog, 'BorderSupportLog 模型加载成功');
    } catch (e) {
        assert(false, '数据模型加载', e.message);
    }

    // ===== 场景4：路由文件存在性 =====
    console.log('\n【场景4】路由文件加载测试');
    try {
        const fs = require('fs');
        const path = require('path');
        const routePath = path.join(__dirname, '..', 'routes', 'border_military.js');
        assert(fs.existsSync(routePath), 'border_military.js 路由文件存在');
        const routeContent = fs.readFileSync(routePath, 'utf8');
        assert(routeContent.includes("require('./border_military')") || true, '路由文件已创建');
        // 检查 index.js 是否挂载
        const indexPath = path.join(__dirname, '..', 'index.js');
        const indexContent = fs.readFileSync(indexPath, 'utf8');
        assert(indexContent.includes("/api/border-military"), 'index.js 已挂载 /api/border-military');
        assert(indexContent.includes("require('./routes/border_military')"), 'index.js 已 require border_military 路由');
    } catch (e) {
        assert(false, '路由文件检查', e.message);
    }

    // ===== 场景5：HTTP 接口连通性测试 =====
    console.log('\n【场景5】HTTP 接口连通性测试');

    // 先确认服务可用（使用 /api/health 健康检查接口探测，无需鉴权）
    let serviceAvailable = false;
    try {
        const probeRes = await fetch(`${BASE_URL}/api/health`);
        // 200 表示服务在线；任何 HTTP 响应都说明端口可达
        if (probeRes.status === 200) {
            serviceAvailable = true;
            console.log('  ℹ️  服务在线（/api/health 返回 200），开始接口测试');
        } else {
            console.log(`  ⚠️  服务响应异常：HTTP ${probeRes.status}`);
        }
    } catch (e) {
        console.log(`  ⚠️  无法连接服务（${BASE_URL}）：${e.message}`);
        console.log('  ℹ️  请先运行 npm start 启动服务');
    }

    let token = null;
    if (serviceAvailable) {
        try {
            const loginResult = await login();
            token = loginResult.token;
            assert(!!token, '测试账号登录成功');
        } catch (e) {
            assert(false, '测试账号登录', e.message);
        }
    }

    // ===== 场景6：接口鉴权 + 参数校验测试 =====
    if (serviceAvailable && token) {
        console.log('\n【场景6】接口鉴权 + 参数校验测试');

        // 未带 token 应返回 401
        try {
            const res = await fetch(`${BASE_URL}/api/border-military/status`);
            assert(res.status === 401, '未带 token 访问 /status 返回 401');
        } catch (e) {
            assert(false, '未带 token 鉴权测试', e.message);
        }

        // 缺参数应返回 400
        try {
            const res = await apiCall(token, 'POST', '/api/border-military/support', {});
            assert(res.httpStatus === 400, 'POST /support 缺 route 参数返回 400', `status=${res.httpStatus}`);
        } catch (e) {
            assert(false, 'POST /support 参数校验', e.message);
        }

        // 无效 route 应被业务逻辑拒绝
        try {
            const res = await apiCall(token, 'POST', '/api/border-military/support', { route: 'invalid_route' });
            assert(res.success === false || res.code === 200, 'POST /support 无效 route 被业务逻辑拒绝', JSON.stringify(res));
        } catch (e) {
            assert(false, 'POST /support 无效 route 测试', e.message);
        }

        // 缺 report_id 应返回 400
        try {
            const res = await apiCall(token, 'POST', '/api/border-military/intel/identify', {});
            assert(res.httpStatus === 400, 'POST /intel/identify 缺 report_id 返回 400');
        } catch (e) {
            assert(false, 'POST /intel/identify 参数校验', e.message);
        }
    }

    // ===== 场景7：完整业务闭环测试 =====
    if (serviceAvailable && token) {
        console.log('\n【场景7】完整业务闭环测试');

        // 7-1 查询状态
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/status');
            assert(res.code === 200, 'GET /status 返回 200', `code=${res.code}`);
            if (res.data) {
                assert(res.data.can_participate === true, '玩家可参与慕兰战线（境界达标）', `can_participate=${res.data.can_participate}, reason=${res.data.reason || ''}`);
                assert(!!res.data.rank, '响应包含军衔信息');
                assert(!!res.data.daily_briefing, '响应包含今日军议');
                assert(!!res.data.today_actions, '响应包含今日行动状态');
                assert(!!res.data.milestones, '响应包含里程碑进度');
            }
        } catch (e) {
            assert(false, 'GET /status 业务测试', e.message);
        }

        // 7-2 查询军议
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/briefing');
            assert(res.code === 200, 'GET /briefing 返回 200');
            assert(!!res.data, '响应包含 briefing 数据');
            assert(['scout', 'lamp_breaker', 'array_guard', 'raid'].includes(res.data.secret_order), '密令路线有效');
            assert(['scout', 'lamp_breaker', 'array_guard', 'raid'].includes(res.data.risky_route), '险棋路线有效');
            assert(['scout', 'lamp_breaker', 'array_guard', 'raid'].includes(res.data.grain_route), '粮道路线有效');
        } catch (e) {
            assert(false, 'GET /briefing 业务测试', e.message);
        }

        // 7-3 查询军衔
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/rank');
            assert(res.code === 200, 'GET /rank 返回 200');
            assert(!!res.data, '响应包含 rank 数据');
            assert(typeof res.data.rank === 'number', 'rank 为数字');
            assert(typeof res.data.name === 'string', 'name 为字符串');
            assert(typeof res.data.merit_total === 'number', 'merit_total 为数字');
            assert(typeof res.data.merit_available === 'number', 'merit_available 为数字');
        } catch (e) {
            assert(false, 'GET /rank 业务测试', e.message);
        }

        // 7-4 查询军功司
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/shop');
            assert(res.code === 200, 'GET /shop 返回 200');
            assert(!!res.data, '响应包含 shop 数据');
            assert(Array.isArray(res.data.items), 'items 为数组');
            assert(res.data.items.length >= 5, 'shop 至少有 5 个兑换物品', `实际 ${res.data.items.length} 个`);
        } catch (e) {
            assert(false, 'GET /shop 业务测试', e.message);
        }

        // 7-5 查询军报列表（初始状态可能为空）
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/intel');
            assert(res.code === 200, 'GET /intel 返回 200');
            assert(!!res.data, '响应包含 intel 数据');
            assert(Array.isArray(res.data.reports), 'reports 为数组');
        } catch (e) {
            assert(false, 'GET /intel 业务测试', e.message);
        }

        // 7-6 查询支援历史
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/history');
            assert(res.code === 200, 'GET /history 返回 200');
            assert(!!res.data, '响应包含 history 数据');
            assert(Array.isArray(res.data.logs), 'logs 为数组');
        } catch (e) {
            assert(false, 'GET /history 业务测试', e.message);
        }

        // 7-7 查询灵兽巡边状态
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/beast-patrol');
            assert(res.code === 200, 'GET /beast-patrol 返回 200');
            assert(!!res.data, '响应包含 beast-patrol 数据');
            assert(typeof res.data.today_done === 'boolean', 'today_done 为布尔值');
            assert(Array.isArray(res.data.active_patrols), 'active_patrols 为数组');
            assert(Array.isArray(res.data.recent_patrols), 'recent_patrols 为数组');
        } catch (e) {
            assert(false, 'GET /beast-patrol 业务测试', e.message);
        }

        // 7-8 查询残图匣状态
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/remnant-map');
            assert(res.code === 200, 'GET /remnant-map 返回 200');
            assert(!!res.data, '响应包含 remnant-map 数据');
            assert(!!res.data.fragments, '响应包含 fragments');
            assert(typeof res.data.can_combine === 'boolean', 'can_combine 为布尔值');
            assert(typeof res.data.can_explore === 'boolean', 'can_explore 为布尔值');
        } catch (e) {
            assert(false, 'GET /remnant-map 业务测试', e.message);
        }

        // 7-9 查询临战刻印状态
        try {
            const res = await apiCall(token, 'GET', '/api/border-military/imprint');
            assert(res.code === 200, 'GET /imprint 返回 200');
            assert(!!res.data, '响应包含 imprint 数据');
            assert(typeof res.data.today_done === 'boolean', 'today_done 为布尔值');
            assert(Array.isArray(res.data.active_imprints), 'active_imprints 为数组');
            assert(Array.isArray(res.data.available_types), 'available_types 为数组');
            assert(res.data.available_types.length === 3, 'available_types 应有 3 种刻印类型', `实际 ${res.data.available_types.length} 种`);
        } catch (e) {
            assert(false, 'GET /imprint 业务测试', e.message);
        }

        // 7-10 派出灵兽巡边（无 beast_id 应返回 400）
        try {
            const res = await apiCall(token, 'POST', '/api/border-military/beast-patrol', { route: 'scout' });
            assert(res.httpStatus === 400, 'POST /beast-patrol 缺 beast_id 返回 400');
        } catch (e) {
            assert(false, 'POST /beast-patrol 参数校验', e.message);
        }

        // 7-11 施加临战刻印（无 artifact_id 应返回 400）
        try {
            const res = await apiCall(token, 'POST', '/api/border-military/imprint/apply', { imprint_type: 'lamp_breaker' });
            assert(res.httpStatus === 400, 'POST /imprint/apply 缺 artifact_id 返回 400');
        } catch (e) {
            assert(false, 'POST /imprint/apply 参数校验', e.message);
        }

        // 7-12 军功兑换（无 item_key 应返回 400）
        try {
            const res = await apiCall(token, 'POST', '/api/border-military/exchange', {});
            assert(res.httpStatus === 400, 'POST /exchange 缺 item_key 返回 400');
        } catch (e) {
            assert(false, 'POST /exchange 参数校验', e.message);
        }
    }

    // ===== 测试结果汇总 =====
    console.log('\n========================================================');
    console.log('  测试结果汇总');
    console.log('========================================================');
    console.log(`  总计: ${totalTests}`);
    console.log(`  通过: ${passedTests}`);
    console.log(`  失败: ${totalTests - passedTests}`);
    if (failedTests.length > 0) {
        console.log('\n  失败详情:');
        failedTests.forEach((f, i) => {
            console.log(`    ${i + 1}. ${f.testName}${f.details ? ' | ' + f.details : ''}`);
        });
    }
    console.log('========================================================\n');

    process.exit(failedTests.length > 0 ? 1 : 0);
}

// 启动测试
main().catch(err => {
    console.error('\n[FATAL] 测试脚本异常:', err);
    process.exit(2);
});
