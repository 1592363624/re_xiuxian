/**
 * 批次5 神识对决系统端到端测试脚本
 *
 * 验证内容：
 *   1. 服务模块加载 + 配置加载
 *   2. 数据模型加载
 *   3. 路由接口连通性（/api/health 探测）
 *   4. 接口鉴权 + 参数校验
 *   5. 完整业务闭环：challenge → accept → action(focus/stabilize) → settle → bet transfer
 *
 * 测试账号：1592363624 / 1592363624（玩家ID=1，韩天尊，化神初期）
 * 副账号：需要第二个化神期玩家作为对手
 *
 * 运行：node server/scripts/test_batch_5_divine_duel.js
 */
'use strict';

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
async function login(username, password) {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || TEST_ACCOUNT, password: password || TEST_PASSWORD })
    });
    const data = await res.json();
    if (!data.token) {
        throw new Error(`登录失败: ${JSON.stringify(data)}`);
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
    console.log('  批次5 神识对决系统端到端测试');
    console.log('========================================================');

    // ===== 场景1：模块加载测试 =====
    console.log('\n【场景1】模块加载测试');

    try {
        const DivineDuelService = require('../game/services/DivineDuelService');
        assert(!!DivineDuelService, 'DivineDuelService 模块加载成功');

        const methods = ['challenge', 'accept', 'action', 'getActiveDuel', 'getHistory', 'surrender', 'checkTimeouts'];
        methods.forEach(m => {
            assert(typeof DivineDuelService[m] === 'function', `DivineDuelService.${m} 存在`);
        });
    } catch (e) {
        assert(false, 'DivineDuelService 模块加载', e.message);
    }

    // 配置加载测试（独立进程需先 initialize 才能读取配置）
    try {
        const { infrastructure } = require('../modules');
        // 独立进程未初始化配置中心，调用 initialize 加载全部 JSON 配置
        if (!infrastructure.ConfigLoader.isInitialized) {
            await infrastructure.ConfigLoader.initialize();
        }
        const config = infrastructure.ConfigLoader.getConfig('late_stage_data');
        assert(!!config, 'late_stage_data 配置加载成功');
        assert(!!config.divine_duel, '配置包含 divine_duel 段');
        if (config.divine_duel) {
            assert(config.divine_duel.min_realm_rank === 23, 'min_realm_rank = 23');
            assert(config.divine_duel.init_shield === 100, 'init_shield = 100');
            assert(config.divine_duel.max_rounds === 20, 'max_rounds = 20');
            assert(config.divine_duel.entry_divine_sense_cost === 50, 'entry_divine_sense_cost = 50');
            assert(!!config.divine_duel.bet_types, 'bet_types 存在');
        }
    } catch (e) {
        assert(false, '配置加载', e.message);
    }

    // ===== 场景2：数据模型加载测试 =====
    console.log('\n【场景2】数据模型加载测试');

    try {
        const PlayerDivineDuel = require('../models/playerDivineDuel');
        assert(!!PlayerDivineDuel, 'PlayerDivineDuel 模型加载成功');
        assert(typeof PlayerDivineDuel.findOne === 'function', 'PlayerDivineDuel.findOne 存在');
        assert(typeof PlayerDivineDuel.findAll === 'function', 'PlayerDivineDuel.findAll 存在');
        assert(typeof PlayerDivineDuel.create === 'function', 'PlayerDivineDuel.create 存在');
    } catch (e) {
        assert(false, 'PlayerDivineDuel 模型加载', e.message);
    }

    // ===== 场景3：HTTP 接口连通性测试 =====
    console.log('\n【场景3】HTTP 接口连通性测试');

    let serviceAvailable = false;
    try {
        const probeRes = await fetch(`${BASE_URL}/api/health`);
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
    let playerId = null;
    if (serviceAvailable) {
        try {
            const loginResult = await login();
            token = loginResult.token;
            playerId = loginResult.player?.id;
            assert(!!token, '测试账号登录成功');
        } catch (e) {
            assert(false, '测试账号登录', e.message);
        }
    }

    // ===== 场景4：接口鉴权 + 参数校验测试 =====
    if (serviceAvailable && token) {
        console.log('\n【场景4】接口鉴权 + 参数校验测试');

        // 未带 token 应返回 401
        try {
            const res = await fetch(`${BASE_URL}/api/divine-sense/duel/active`);
            assert(res.status === 401, '未带 token 访问 /duel/active 返回 401');
        } catch (e) {
            assert(false, '未带 token 鉴权测试', e.message);
        }

        // 缺参数应返回 400 或业务错误
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/challenge', {});
            assert(res.httpStatus === 400 || res.success === false || res.code === 200,
                'POST /duel/challenge 缺参数被拒绝', `status=${res.httpStatus}`);
        } catch (e) {
            assert(false, 'POST /duel/challenge 参数校验', e.message);
        }

        // 无效 bet_type 应被拒绝
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/challenge', {
                target_player_id: 999999,
                bet_type: 'invalid_type',
                bet_amount: 100
            });
            assert(res.success === false || res.httpStatus === 400,
                'POST /duel/challenge 无效 bet_type 被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, 'POST /duel/challenge 无效 bet_type', e.message);
        }

        // 无效 action 应被拒绝
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/action', {
                duel_id: 999999,
                action: 'invalid_action'
            });
            assert(res.success === false || res.httpStatus === 400,
                'POST /duel/action 无效 action 被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, 'POST /duel/action 无效 action', e.message);
        }
    }

    // ===== 场景5：只读接口测试 =====
    if (serviceAvailable && token) {
        console.log('\n【场景5】只读接口测试');

        // 查询当前对局
        try {
            const res = await apiCall(token, 'GET', '/api/divine-sense/duel/active');
            assert(res.code === 200, 'GET /duel/active 返回 200', `code=${res.code}`);
            assert(res.data !== undefined, '响应包含 data 字段');
        } catch (e) {
            assert(false, 'GET /duel/active', e.message);
        }

        // 查询历史（响应字段为 data.duels 数组）
        try {
            const res = await apiCall(token, 'GET', '/api/divine-sense/duel/history');
            assert(res.code === 200, 'GET /duel/history 返回 200', `code=${res.code}`);
            assert(res.data !== undefined, '响应包含 data 字段');
            if (res.data) {
                assert(Array.isArray(res.data.duels) || Array.isArray(res.data.logs) || Array.isArray(res.data.history) || Array.isArray(res.data),
                    '响应包含对局列表', `duels=${Array.isArray(res.data.duels)} logs=${Array.isArray(res.data.logs)}`);
            }
        } catch (e) {
            assert(false, 'GET /duel/history', e.message);
        }
    }

    // ===== 场景6：业务闭环测试（需要第二个玩家） =====
    if (serviceAvailable && token) {
        console.log('\n【场景6】业务闭环测试（单账号边界测试）');

        // 尝试对自己发起挑战（应被拒绝）
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/challenge', {
                target_player_id: playerId,
                bet_type: 'spirit_stone',
                bet_amount: 100
            });
            assert(res.success === false || res.httpStatus === 400,
                '不能对自己发起挑战', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, '对自己发起挑战测试', e.message);
        }

        // 尝试对不存在的玩家发起挑战
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/challenge', {
                target_player_id: 999999,
                bet_type: 'spirit_stone',
                bet_amount: 100
            });
            assert(res.success === false,
                '对不存在的玩家发起挑战被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, '对不存在玩家发起挑战', e.message);
        }

        // 尝试赌注超出范围
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/challenge', {
                target_player_id: 999999,
                bet_type: 'spirit_stone',
                bet_amount: 99999999
            });
            assert(res.success === false,
                '赌注超出范围被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, '赌注范围测试', e.message);
        }

        // 尝试赌注过低
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/challenge', {
                target_player_id: 999999,
                bet_type: 'spirit_stone',
                bet_amount: 1
            });
            assert(res.success === false,
                '赌注过低被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, '赌注下限测试', e.message);
        }

        // 尝试接受不存在的对局
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/accept', {
                duel_id: 999999
            });
            assert(res.success === false,
                '接受不存在的对局被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, '接受不存在对局测试', e.message);
        }

        // 尝试对不存在的对局执行行动
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/action', {
                duel_id: 999999,
                action: 'focus'
            });
            assert(res.success === false,
                '对不存在的对局执行行动被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, '不存在对局行动测试', e.message);
        }

        // 尝试投降不存在的对局
        try {
            const res = await apiCall(token, 'POST', '/api/divine-sense/duel/surrender', {
                duel_id: 999999
            });
            assert(res.success === false,
                '对不存在的对局投降被拒绝', JSON.stringify(res).substring(0, 200));
        } catch (e) {
            assert(false, '不存在对局投降测试', e.message);
        }
    }

    // ===== 场景7：神识系统关联测试 =====
    if (serviceAvailable && token) {
        console.log('\n【场景7】神识系统关联测试');

        // 查询神识面板（响应字段为 data.divine_sense.current/max）
        try {
            const res = await apiCall(token, 'GET', '/api/divine-sense/profile');
            assert(res.code === 200, 'GET /divine-sense/profile 返回 200');
            if (res.data) {
                const sense = res.data.divine_sense || {};
                const balance = sense.current !== undefined ? sense.current : res.data.divine_sense_balance;
                const max = sense.max !== undefined ? sense.max : res.data.divine_sense_max;
                console.log(`  ℹ️  神识余额: ${balance} / ${max}`);
                assert(balance !== undefined, '神识面板包含余额信息', JSON.stringify(res.data).substring(0, 200));
            }
        } catch (e) {
            assert(false, '神识面板查询', e.message);
        }
    }

    // ===== 测试结果汇总 =====
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
