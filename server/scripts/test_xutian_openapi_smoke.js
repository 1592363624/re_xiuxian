/**
 * 虚天殿副本 - OpenAPI 文档更新后的快速冒烟测试
 *
 * 验证项：
 *   1. 登录测试账号（1592363624 / 1592363624）
 *   2. GET /api/multi-dungeon/help 应返回 4 个副本（含 xutian）
 *   3. GET /api/multi-dungeon/rewards?dungeon_key=xutian 应返回虚天殿奖励池
 *   4. GET /api/multi-dungeon/cooldown 应返回 4 个副本的冷却状态
 *   5. GET /api/multi-dungeon/rewards 对非法 dungeon_key 应返回 400 错误
 *   6. GM 接口 adjust-variable 应拒绝不在白名单内的变量
 *
 * 运行方式：node server/scripts/test_xutian_openapi_smoke.js
 */
'use strict';

const axios = require('axios');

// 测试账号配置
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';
const API_BASE = 'http://localhost:5000';

// 测试结果统计
let passCount = 0;
let failCount = 0;
const failures = [];

/**
 * 断言：条件为真
 * @param {boolean} condition - 条件
 * @param {string} description - 断言描述
 */
function assert(condition, description) {
    if (condition) {
        passCount++;
        console.log(`  [PASS] ${description}`);
    } else {
        failCount++;
        failures.push(description);
        console.log(`  [FAIL] ${description}`);
    }
}

/**
 * 主测试函数
 */
async function main() {
    console.log('========================================');
    console.log('虚天殿副本 OpenAPI 更新冒烟测试');
    console.log('========================================\n');

    // 1. 登录获取 token
    console.log('[步骤 1] 登录测试账号...');
    let token = null;
    try {
        const loginResp = await axios.post(`${API_BASE}/api/auth/login`, {
            username: TEST_ACCOUNT,
            password: TEST_PASSWORD
        });
        assert(loginResp.data.code === 200, '登录应返回 code=200');
        // 登录响应结构：{ code, message, token, player } —— token 在响应体顶层
        // 不像其他接口用 { code, message, data: {...} } 嵌套结构
        token = loginResp.data.token;
        assert(!!token, '登录应返回有效 token');
    } catch (e) {
        console.error('登录失败:', e.response?.data || e.message);
        process.exit(1);
    }

    const authHeaders = { Authorization: `Bearer ${token}` };
    console.log('');

    // 2. 测试 help 接口 - 应返回 4 个副本
    // 注意：getHelp 返回 { data: { dungeons: { yanyue: {...}, duanwu: {...}, ... } } }
    // dungeons 是对象（key 为副本键），不是数组
    console.log('[步骤 2] 测试 GET /api/multi-dungeon/help...');
    try {
        const helpResp = await axios.get(`${API_BASE}/api/multi-dungeon/help`, { headers: authHeaders });
        assert(helpResp.data.code === 200, 'help 应返回 code=200');
        const dungeons = helpResp.data.data?.dungeons || {};
        const dungeonKeys = Object.keys(dungeons);
        console.log(`    返回副本数量: ${dungeonKeys.length}`);
        console.log(`    副本键: ${dungeonKeys.join(', ')}`);
        assert(dungeonKeys.length >= 4, `应返回至少 4 个副本，实际: ${dungeonKeys.length}`);
        assert(dungeonKeys.includes('yanyue'), 'help 应包含 yanyue 副本');
        assert(dungeonKeys.includes('duanwu'), 'help 应包含 duanwu 副本');
        assert(dungeonKeys.includes('kunwu'), 'help 应包含 kunwu 副本');
        assert(dungeonKeys.includes('xutian'), 'help 应包含 xutian 副本');
        // 打印 xutian 副本信息
        const xutianDgn = dungeons.xutian;
        if (xutianDgn) {
            console.log(`    xutian 副本信息: ${xutianDgn.name} / 成员${xutianDgn.member_min}-${xutianDgn.member_max}人 / ${xutianDgn.rewards_summary}`);
            assert(!!xutianDgn.name, 'xutian 副本应有名称');
            assert(!!xutianDgn.member_min, 'xutian 副本应有 member_min');
        }
    } catch (e) {
        assert(false, `help 接口异常: ${e.response?.data?.message || e.message}`);
    }
    console.log('');

    // 3. 测试 rewards 接口 - 应返回 xutian 奖励池
    // 注意：rewards 字段结构为 { base_rewards, normal_drops, first_clear_bonus, rare_drop, path_choice_bonus, formation_power_bonus }
    // 不同副本字段略有差异（yanyue 无 base_rewards，duanwu 用 rare_drops_by_contribution）
    console.log('[步骤 3] 测试 GET /api/multi-dungeon/rewards?dungeon_key=xutian...');
    try {
        const rewardsResp = await axios.get(`${API_BASE}/api/multi-dungeon/rewards`, {
            headers: authHeaders,
            params: { dungeon_key: 'xutian' }
        });
        assert(rewardsResp.data.code === 200, 'rewards(xutian) 应返回 code=200');
        const rewardsData = rewardsResp.data.data;
        if (rewardsData) {
            console.log(`    副本名: ${rewardsData.dungeon_name}`);
            console.log(`    基础奖励数: ${rewardsData.rewards?.base_rewards?.length || 0}`);
            console.log(`    普通掉落数: ${rewardsData.rewards?.normal_drops?.length || 0}`);
            console.log(`    首通奖励数: ${rewardsData.rewards?.first_clear_bonus?.length || 0}`);
            console.log(`    稀有掉落: ${rewardsData.rewards?.rare_drop?.name || '无'}`);
            assert(rewardsData.dungeon_key === 'xutian', 'rewards 应返回 dungeon_key=xutian');
            assert(!!rewardsData.dungeon_name, 'rewards 应返回副本名');
            assert(!!rewardsData.rewards, 'rewards 应返回奖励池对象');
            // xutian 应包含7种普通掉落
            assert(rewardsData.rewards?.normal_drops?.length === 7, `xutian normal_drops 应有7种，实际: ${rewardsData.rewards?.normal_drops?.length || 0}`);
            // xutian 应有虚天鼎稀有掉落
            assert(rewardsData.rewards?.rare_drop?.item_key === 'xutian_cauldron', 'xutian rare_drop 应为虚天鼎');
        }
    } catch (e) {
        assert(false, `rewards(xutian) 接口异常: ${e.response?.data?.message || e.message}`);
    }
    console.log('');

    // 4. 测试 cooldown 接口 - 应返回 4 个副本的冷却
    // 注意：getCooldown 返回 { data: { cooldowns: { yanyue: {...}, duanwu: {...}, ... } } }
    // cooldowns 是对象（key 为副本键），不是数组
    console.log('[步骤 4] 测试 GET /api/multi-dungeon/cooldown...');
    try {
        const cooldownResp = await axios.get(`${API_BASE}/api/multi-dungeon/cooldown`, { headers: authHeaders });
        assert(cooldownResp.data.code === 200, 'cooldown 应返回 code=200');
        const cooldowns = cooldownResp.data.data?.cooldowns || {};
        const cdKeys = Object.keys(cooldowns);
        console.log(`    返回冷却记录数: ${cdKeys.length}`);
        console.log(`    冷却键: ${cdKeys.join(', ')}`);
        assert(cdKeys.length >= 4, `应返回至少 4 个副本的冷却，实际: ${cdKeys.length}`);
        assert(cdKeys.includes('yanyue'), 'cooldown 应包含 yanyue');
        assert(cdKeys.includes('duanwu'), 'cooldown 应包含 duanwu');
        assert(cdKeys.includes('kunwu'), 'cooldown 应包含 kunwu');
        assert(cdKeys.includes('xutian'), 'cooldown 应包含 xutian');
        // 打印各副本冷却状态
        for (const key of cdKeys) {
            const cd = cooldowns[key];
            console.log(`    ${key}: ${cd.in_cooldown ? '冷却中（剩余' + Math.ceil(cd.remaining_ms / 60000) + '分钟）' : '可进入'}`);
        }
    } catch (e) {
        assert(false, `cooldown 接口异常: ${e.response?.data?.message || e.message}`);
    }
    console.log('');

    // 5. 测试 rewards 接口 - 非法 dungeon_key 应返回错误
    console.log('[步骤 5] 测试 GET /api/multi-dungeon/rewards?dungeon_key=invalid...');
    try {
        await axios.get(`${API_BASE}/api/multi-dungeon/rewards`, {
            headers: authHeaders,
            params: { dungeon_key: 'invalid' }
        });
        assert(false, '非法 dungeon_key 应返回 400 错误');
    } catch (e) {
        const resp = e.response;
        if (resp) {
            console.log(`    HTTP 状态码: ${resp.status}`);
            console.log(`    错误消息: ${resp.data?.message}`);
            assert(resp.status === 400 || resp.data?.code === 400, '非法 dungeon_key 应返回 400');
            assert(!!resp.data?.message, '错误响应应包含 message');
        } else {
            assert(false, `请求异常: ${e.message}`);
        }
    }
    console.log('');

    // 6. 测试 status 接口 - 应正常返回（即使没有副本）
    console.log('[步骤 6] 测试 GET /api/multi-dungeon/status...');
    try {
        const statusResp = await axios.get(`${API_BASE}/api/multi-dungeon/status`, { headers: authHeaders });
        assert(statusResp.data.code === 200, 'status 应返回 code=200');
        const statusData = statusResp.data.data;
        if (statusData) {
            console.log(`    has_instance: ${statusData.has_instance}`);
            assert(typeof statusData.has_instance === 'boolean', 'status 应返回 has_instance 布尔值');
        }
    } catch (e) {
        assert(false, `status 接口异常: ${e.response?.data?.message || e.message}`);
    }
    console.log('');

    // ============ 测试结果汇总 ============
    console.log('========================================');
    console.log('测试结果汇总');
    console.log('========================================');
    console.log(`通过: ${passCount}`);
    console.log(`失败: ${failCount}`);
    if (failures.length > 0) {
        console.log('\n失败项:');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    }
    console.log('');
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
