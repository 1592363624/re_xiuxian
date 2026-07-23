/**
 * 大衍诀修炼系统端到端测试脚本
 *
 * 测试场景：
 *   1. 登录获取 token（使用测试账号 1592363624）
 *   2. 获取大衍诀配置（无需鉴权）
 *   3. 获取玩家大衍诀状态（需鉴权）
 *   4. 参悟大衍诀（需鉴权，消耗修为获经验）
 *   5. 突破大衍诀层数（需鉴权，消耗残篇+成功率判定）
 *   6. 飞升前置检查（需鉴权）
 *   7. 未鉴权访问受保护接口（应返回 401）
 *   8. 神识系统联动验证（神识上限应受 dayan_level 影响）
 *
 * 用法：node scripts/_test_dayan.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const BASE = 'http://localhost:5000/api';

/**
 * 发起 HTTP 请求的辅助函数（避免依赖 axios）
 * @param {string} method - HTTP 方法
 * @param {string} path - 路径
 * @param {Object} [data] - 请求体（POST/PUT）
 * @param {string} [token] - JWT token
 * @returns {Promise<Object>} 响应 JSON
 */
async function request(method, path, data = null, token = null) {
    const url = new URL(BASE + path);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (data && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(data);
    }

    const res = await fetch(url, options);
    const json = await res.json();
    return { status: res.status, body: json };
}

/**
 * 日志输出辅助
 */
function log(title, obj) {
    console.log(`\n===== ${title} =====`);
    console.log(JSON.stringify(obj, null, 2).slice(0, 1000));
}

/**
 * 断言辅助
 */
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ 断言失败: ${message}`);
        process.exitCode = 1;
    } else {
        console.log(`✅ ${message}`);
    }
}

async function main() {
    console.log('========== 大衍诀修炼系统端到端测试开始 ==========');

    // ===== 1. 登录 =====
    const loginRes = await request('POST', '/auth/login', {
        username: '1592363624',
        password: '1592363624'
    });
    log('1. 登录', { status: loginRes.status, code: loginRes.body.code });
    assert(loginRes.status === 200 && loginRes.body.code === 200, '登录成功');
    const token = loginRes.body.token;
    assert(!!token, '获取到 token');
    const playerId = loginRes.body.player?.id;
    console.log(`玩家ID: ${playerId}, 道号: ${loginRes.body.player?.nickname}, 境界: ${loginRes.body.player?.realm}, rank: ${loginRes.body.player?.realm_rank}`);

    // ===== 2. 获取大衍诀配置（无需鉴权） =====
    const cfgRes = await request('GET', '/dayan/config');
    log('2. 获取配置', { status: cfgRes.status, enabled: cfgRes.body.data?.enabled });
    assert(cfgRes.status === 200, '配置接口返回 200');
    assert(cfgRes.body.data?.enabled === true, '大衍诀系统已启用');
    const cfg = cfgRes.body.data;
    assert(cfg.max_level === 5, '最高层数为 5');
    assert(cfg.levels && cfg.levels['5']?.name === '第五层·衍神', '第五层名称为 衍神');
    assert(cfg.ascension_requirement?.required_level === 5, '飞升前置层数为 5');
    assert(Object.keys(cfg.fragments || {}).length >= 5, '残篇配置至少 5 种');

    // ===== 3. 获取玩家大衍诀状态（需鉴权） =====
    const statusRes = await request('GET', '/dayan/status', null, token);
    log('3. 获取修炼状态', {
        status: statusRes.status,
        level: statusRes.body.data?.current_level,
        level_name: statusRes.body.data?.current_level_name,
        sense_multiplier: statusRes.body.data?.sense_multiplier
    });
    assert(statusRes.status === 200 && statusRes.body.code === 200, '状态接口返回 200');
    const status = statusRes.body.data;
    assert(status !== undefined && status !== null, '获取到修炼状态');
    assert(typeof status.current_level === 'number', '当前层数为数字');
    assert(typeof status.sense_multiplier === 'number', '神识倍率为数字');
    assert(status.meditate && typeof status.meditate.daily_limit === 'number', '参悟配置存在');
    assert(status.ascension_requirement && status.ascension_requirement.required_level === 5, '飞升前置配置存在');

    // ===== 4. 参悟大衍诀（需鉴权） =====
    const meditateRes = await request('POST', '/dayan/meditate', {}, token);
    log('4. 参悟大衍诀', {
        status: meditateRes.status,
        code: meditateRes.body.code,
        message: meditateRes.body.message || meditateRes.body.error_code
    });
    // 参悟可能成功也可能因条件不满足失败（次数上限/冷却/修为不足/已达最高层），两种都是合法响应
    if (meditateRes.body.code === 200 && meditateRes.body.data?.success) {
        assert(meditateRes.body.data.exp_gained > 0, '参悟获得经验 > 0');
        assert(typeof meditateRes.body.data.player_exp_after === 'string', '修为余额为字符串（大数安全）');
        console.log(`   参悟成功：获得 ${meditateRes.body.data.exp_gained} 经验，消耗 ${meditateRes.body.data.cost_exp} 修为`);
    } else {
        // 业务错误（次数上限/冷却/修为不足/最高层）属于合法边界
        console.log(`   参悟未成功（边界情况）：${meditateRes.body.message || meditateRes.body.error_code}`);
        assert(meditateRes.status === 400 || meditateRes.status === 200, '参悟边界情况返回 200 或 400');
    }

    // ===== 5. 再次获取状态，验证参悟是否生效 =====
    const statusRes2 = await request('GET', '/dayan/status', null, token);
    log('5. 参悟后状态', {
        level: statusRes2.body.data?.current_level,
        exp: statusRes2.body.data?.current_exp,
        daily_used: statusRes2.body.data?.meditate?.daily_used
    });
    assert(statusRes2.body.code === 200, '参悟后状态查询成功');

    // ===== 6. 突破大衍诀层数（需鉴权） =====
    const breakthroughRes = await request('POST', '/dayan/breakthrough', {}, token);
    log('6. 突破大衍诀', {
        status: breakthroughRes.status,
        code: breakthroughRes.body.code,
        message: breakthroughRes.body.message || breakthroughRes.body.error_code
    });
    // 突破可能成功/失败/条件不满足，三种都是合法响应
    if (breakthroughRes.body.code === 200 && breakthroughRes.body.data?.success) {
        if (breakthroughRes.body.data.breakthrough) {
            assert(typeof breakthroughRes.body.data.new_level === 'number', '突破成功：新层数为数字');
            console.log(`   突破成功：${breakthroughRes.body.data.new_level_name}，倍率 ×${breakthroughRes.body.data.sense_multiplier}`);
        } else {
            assert(typeof breakthroughRes.body.data.success_rate === 'number', '突破失败：返回成功率');
            console.log(`   突破失败（成功率 ${(breakthroughRes.body.data.success_rate * 100).toFixed(0)}%），经验保留 ${breakthroughRes.body.data.exp_current}`);
        }
    } else {
        // 业务错误（经验不足/残篇不足/未初始化）属于合法边界
        console.log(`   突破未执行（边界情况）：${breakthroughRes.body.message || breakthroughRes.body.error_code}`);
        assert(breakthroughRes.status === 400 || breakthroughRes.status === 200, '突破边界情况返回 200 或 400');
    }

    // ===== 7. 飞升前置检查（需鉴权） =====
    const ascRes = await request('GET', '/dayan/ascension-check', null, token);
    log('7. 飞升前置检查', {
        status: ascRes.status,
        required_level: ascRes.body.data?.required_level,
        current_level: ascRes.body.data?.current_level,
        met: ascRes.body.data?.met
    });
    assert(ascRes.status === 200 && ascRes.body.code === 200, '飞升前置检查接口返回 200');
    assert(ascRes.body.data?.required_level === 5, '飞升所需层数为 5');
    assert(typeof ascRes.body.data?.met === 'boolean', 'met 为布尔值');

    // ===== 8. 未鉴权访问受保护接口（应返回 401） =====
    const noAuthRes = await request('GET', '/dayan/status');
    log('8. 未鉴权访问', { status: noAuthRes.status });
    assert(noAuthRes.status === 401, '未鉴权访问 status 返回 401');

    // ===== 9. 神识系统联动验证（神识上限应受 dayan_level 影响） =====
    const senseRes = await request('GET', '/divine-sense/profile', null, token);
    log('9. 神识系统联动', {
        status: senseRes.status,
        sense_max: senseRes.body.data?.divine_sense?.max,
        sense_current: senseRes.body.data?.divine_sense?.current
    });
    if (senseRes.body.code === 200 && senseRes.body.data?.divine_sense) {
        const senseMax = senseRes.body.data.divine_sense.max;
        const dayanLevel = statusRes2.body.data?.current_level || 0;
        // 神识上限公式：100 + max(0, realm_rank - 14) * 50 + dayan_level * 100
        // dayan_level * 100 部分应体现在神识上限中
        console.log(`   当前大衍诀层数：${dayanLevel}，神识上限：${senseMax}（含 dayan 加成 ${dayanLevel * 100}）`);
        assert(senseMax >= 100 + dayanLevel * 100, '神识上限包含大衍诀加成');
    } else {
        console.log(`   神识系统未就绪或境界不足（边界）：${senseRes.body.message || ''}`);
    }

    console.log('\n========== 大衍诀修炼系统端到端测试完成 ==========');
    if (process.exitCode === 1) {
        console.log('❌ 存在断言失败');
    } else {
        console.log('✅ 全部断言通过');
    }
}

main().catch(err => {
    console.error('测试执行异常:', err);
    process.exitCode = 1;
});
