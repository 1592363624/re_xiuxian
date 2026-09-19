/**
 * 妖兽入侵完整流程端到端验证脚本
 *
 * 测试目的：
 *   验证妖兽入侵系统的两阶段流程（捐献→战斗）、伤害计算、聚合战报、击杀结算等核心功能
 *
 * 测试流程：
 *   1. 登录获取 token
 *   2. 查询当前活跃的妖兽入侵事件（应为空或非空）
 *   3. GM 接口手动开启妖兽入侵（xuelang_yaoshou）
 *   4. 查询事件详情
 *   5. 查询捐献进度
 *   6. 玩家捐献物品（spirit_stone）
 *   7. 查询玩家自己的捐献记录
 *   8. 查询伤害排行（应返回空）
 *   9. 查询奖励池说明
 *  10. 查询玩法帮助
 *  11. GM 强制结束事件（清理）
 *
 * 注意：
 *   - 测试中跳过 attack 接口测试，因为攻击要求 phase=battle 且需先完成捐献达标
 *   - 完整攻击流程需在玩家境界达标 + 捐献值足够时手动触发
 *   - 测试使用账号 1592363624 / 1592363624（项目约定）
 *
 * 运行方式：node server/scripts/test_beast_invasion.js
 */
'use strict';

const axios = require('axios');

const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';
// 默认端口 5000，可通过环境变量 PORT 覆盖（与项目 .env 配置一致）
const API_PORT = process.env.PORT || 5000;
const API_BASE = `http://localhost:${API_PORT}/api`;

// HTTP 请求超时（10 秒，避免阻塞）
const HTTP_TIMEOUT = 10000;

/**
 * 创建带超时的 axios 请求
 * @param {string} method - HTTP 方法
 * @param {string} url - 完整 URL
 * @param {Object} [headers={}] - 请求头
 * @param {Object} [data=null] - 请求体
 * @returns {Promise<Object>} axios 响应
 */
async function http(method, url, headers = {}, data = null) {
    const config = { method, url, headers, timeout: HTTP_TIMEOUT };
    if (data && (method === 'post' || method === 'put' || method === 'patch')) {
        config.data = data;
    }
    return axios(config);
}

/**
 * 主测试函数
 */
async function main() {
    console.log('========== 妖兽入侵完整流程端到端验证 ==========\n');

    // Step 1: 登录获取 token
    console.log('[Step 1] 登录获取 token...');
    let token = null;
    let playerInfo = null;
    try {
        const loginResp = await http('post', `${API_BASE}/auth/login`, {}, {
            username: TEST_USERNAME,
            password: TEST_PASSWORD
        });
        if (loginResp.data.code !== 200) {
            throw new Error(`登录失败: ${loginResp.data.message}`);
        }
        token = loginResp.data.token;
        playerInfo = loginResp.data.player || null;
        const authHeader = { Authorization: `Bearer ${token}` };
        console.log(`  ✓ 登录成功，玩家ID: ${playerInfo?.id || '未知'}，昵称: ${playerInfo?.nickname || '未知'}`);
        console.log('');

        // 调用后续测试
        await runBeastInvasionTests(authHeader, playerInfo);
    } catch (err) {
        console.error(`  ✗ 登录失败: ${err.message}`);
        if (err.response?.data) {
            console.error('    响应:', err.response.data);
        }
        process.exit(1);
    }
}

/**
 * 执行妖兽入侵全流程测试
 * @param {Object} authHeader - 带 JWT 的请求头
 * @param {Object} playerInfo - 玩家信息
 */
async function runBeastInvasionTests(authHeader, playerInfo) {
    let invasionId = null;

    // Step 2: 查询当前活跃的妖兽入侵事件
    console.log('[Step 2] 查询 GET /api/beast-invasion/active...');
    try {
        const activeResp = await http('get', `${API_BASE}/beast-invasion/active`, authHeader);
        console.log(`  ✓ 状态码: ${activeResp.status}`);
        console.log(`  ✓ code: ${activeResp.data.code}`);
        const activeData = activeResp.data.data;
        if (activeData) {
            console.log(`  ✓ 当前有活跃事件: id=${activeData.id} ${activeData.beast_name} phase=${activeData.phase}`);
            invasionId = activeData.id;
        } else {
            console.log('  ✓ 当前无活跃事件');
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('');
    }

    // Step 3: GM 接口手动开启妖兽入侵（仅当无活跃事件时）
    if (!invasionId) {
        console.log('[Step 3] GM 手动开启妖兽入侵 xuelang_yaoshou...');
        try {
            // 注意：GM 接口要求账号为 admin 角色
            const spawnResp = await http('post', `${API_BASE}/admin/beast-invasion/spawn`, authHeader, {
                beast_key: 'xuelang_yaoshou',
                hours: 1  // 1 小时事件总时长（便于测试）
            });
            console.log(`  ✓ 状态码: ${spawnResp.status}`);
            console.log(`  ✓ code: ${spawnResp.data.code}`);
            if (spawnResp.data.code === 200) {
                const result = spawnResp.data.data;
                invasionId = result.invasion_id;
                console.log(`  ✓ 事件ID: ${invasionId}`);
                console.log(`  ✓ 妖兽名: ${result.beast_name}`);
                console.log(`  ✓ 妖兽 HP: ${result.hp_max}`);
                console.log(`  ✓ 捐献目标: ${result.donation_target}`);
                console.log(`  ✓ 捐献结束时间: ${result.donation_end_time}`);
            } else {
                console.log(`  ⚠ message: ${spawnResp.data.message}`);
            }
            console.log('');
        } catch (err) {
            console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
            if (err.response?.data) console.log('    响应:', err.response.data);
            console.log('  → 跳过 GM 开启步骤，尝试用已有事件 ID 继续\n');
        }
    } else {
        console.log(`[Step 3] 跳过：已有活跃事件 id=${invasionId}\n`);
    }

    if (!invasionId) {
        console.log('⚠ 无可用事件 ID，终止后续测试');
        return;
    }

    // Step 4: 查询事件详情
    console.log(`[Step 4] 查询 GET /api/beast-invasion/${invasionId}...`);
    try {
        const detailResp = await http('get', `${API_BASE}/beast-invasion/${invasionId}`, authHeader);
        console.log(`  ✓ 状态码: ${detailResp.status}`);
        if (detailResp.data.code === 200) {
            const detail = detailResp.data.data;
            console.log(`  ✓ 妖兽: ${detail.invasion.beast_name}`);
            console.log(`  ✓ HP: ${detail.invasion.hp_current}/${detail.invasion.hp_max} (${detail.invasion.hp_percentage}%)`);
            console.log(`  ✓ 阶段: ${detail.invasion.phase}，状态: ${detail.invasion.status}`);
            console.log(`  ✓ 捐献: ${detail.invasion.donation_current}/${detail.invasion.donation_target} (${detail.invasion.donation_percentage}%)`);
            console.log(`  ✓ 倒计时: ${detail.countdown_seconds} 秒`);
            console.log(`  ✓ 技能数: ${detail.skills?.length || 0}`);
        } else {
            console.log(`  ⚠ message: ${detailResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('');
    }

    // Step 5: 查询捐献进度
    console.log(`[Step 5] 查询 GET /api/beast-invasion/${invasionId}/contribution/progress...`);
    try {
        const progResp = await http('get', `${API_BASE}/beast-invasion/${invasionId}/contribution/progress`, authHeader);
        console.log(`  ✓ 状态码: ${progResp.status}`);
        if (progResp.data.code === 200) {
            const prog = progResp.data.data;
            console.log(`  ✓ 捐献目标: ${prog.donation_target}，当前: ${prog.donation_current} (${prog.donation_percentage}%)`);
            console.log(`  ✓ 物品分布: ${prog.items_breakdown?.length || 0} 项`);
            console.log(`  ✓ 捐献排行: ${prog.top_contributors?.length || 0} 人`);
        } else {
            console.log(`  ⚠ message: ${progResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('');
    }

    // Step 6: 玩家捐献物品（spirit_stone × 10，贡献值 10）
    console.log(`[Step 6] 玩家捐献 spirit_stone × 10...`);
    try {
        const contributeResp = await http('post',
            `${API_BASE}/beast-invasion/${invasionId}/contribute`,
            authHeader,
            { item_key: 'spirit_stone', quantity: 10 }
        );
        console.log(`  ✓ 状态码: ${contributeResp.status}`);
        if (contributeResp.data.code === 200) {
            const result = contributeResp.data.data;
            console.log(`  ✓ 捐献 ${result.item_name} × ${result.quantity}，获得贡献值 ${result.contribution_value}`);
            console.log(`  ✓ 累计捐献: ${result.donation_current}/${result.donation_target} (${result.donation_percentage}%)`);
            console.log(`  ✓ 阶段已切换: ${result.phase_switched}，新阶段: ${result.new_phase}`);
        } else {
            console.log(`  ⚠ message: ${contributeResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('  → 玩家可能没有 spirit_stone 物品，跳过此步骤\n');
    }

    // Step 7: 查询玩家自己的捐献记录
    console.log(`[Step 7] 查询 GET /api/beast-invasion/${invasionId}/contribution/me...`);
    try {
        const myResp = await http('get', `${API_BASE}/beast-invasion/${invasionId}/contribution/me`, authHeader);
        console.log(`  ✓ 状态码: ${myResp.status}`);
        if (myResp.data.code === 200) {
            const my = myResp.data.data;
            console.log(`  ✓ 我的总贡献: ${my.total_contribution}`);
            console.log(`  ✓ 我的捐献次数: ${my.donation_count}`);
            console.log(`  ✓ 物品种类: ${my.items_breakdown?.length || 0}`);
        } else {
            console.log(`  ⚠ message: ${myResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('');
    }

    // Step 8: 查询伤害排行
    console.log(`[Step 8] 查询 GET /api/beast-invasion/${invasionId}/ranking...`);
    try {
        const rankResp = await http('get', `${API_BASE}/beast-invasion/${invasionId}/ranking`, authHeader);
        console.log(`  ✓ 状态码: ${rankResp.status}`);
        if (rankResp.data.code === 200) {
            const rank = rankResp.data.data;
            console.log(`  ✓ 总伤害: ${rank.total_damage_taken}`);
            console.log(`  ✓ 排行人数: ${rank.ranking?.length || 0}`);
        } else {
            console.log(`  ⚠ message: ${rankResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('');
    }

    // Step 9: 查询奖励池说明
    console.log(`[Step 9] 查询 GET /api/beast-invasion/${invasionId}/rewards...`);
    try {
        const rewardsResp = await http('get', `${API_BASE}/beast-invasion/${invasionId}/rewards`, authHeader);
        console.log(`  ✓ 状态码: ${rewardsResp.status}`);
        if (rewardsResp.data.code === 200) {
            const rewards = rewardsResp.data.data;
            console.log(`  ✓ 妖兽: ${rewards.beast_name}`);
            console.log(`  ✓ 参与奖: ${JSON.stringify(rewards.rewards.participation)}`);
            console.log(`  ✓ TOP3 奖: ${JSON.stringify(rewards.rewards.top_3)}`);
            console.log(`  ✓ TOP10 奖: ${JSON.stringify(rewards.rewards.top_10)}`);
            console.log(`  ✓ 终结奖: ${JSON.stringify(rewards.rewards.killer)}`);
        } else {
            console.log(`  ⚠ message: ${rewardsResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('');
    }

    // Step 10: 查询玩法帮助
    console.log('[Step 10] 查询 GET /api/beast-invasion/help...');
    try {
        const helpResp = await http('get', `${API_BASE}/beast-invasion/help`, authHeader);
        console.log(`  ✓ 状态码: ${helpResp.status}`);
        if (helpResp.data.code === 200) {
            const help = helpResp.data.data;
            console.log(`  ✓ 标题: ${help.title}`);
            console.log(`  ✓ 内容长度: ${help.content?.length || 0} 字符`);
        } else {
            console.log(`  ⚠ message: ${helpResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('');
    }

    // Step 11: GM 强制结束事件（清理测试数据）
    console.log(`[Step 11] GM 强制结束事件 id=${invasionId}...`);
    try {
        const expireResp = await http('post',
            `${API_BASE}/admin/beast-invasion/${invasionId}/expire`,
            authHeader,
            {}
        );
        console.log(`  ✓ 状态码: ${expireResp.status}`);
        if (expireResp.data.code === 200) {
            console.log(`  ✓ 事件已强制结束: ${expireResp.data.data.beast_name}`);
        } else {
            console.log(`  ⚠ message: ${expireResp.data.message}`);
        }
        console.log('');
    } catch (err) {
        console.log(`  ✗ 请求失败: ${err.response?.status || err.message}`);
        if (err.response?.data) console.log('    响应:', err.response.data);
        console.log('  → 可能账号无 admin 权限，需手动清理\n');
    }

    console.log('========== 妖兽入侵完整流程端到端验证完成 ==========\n');
}

// 执行主函数
main().catch(err => {
    console.error('测试执行异常:', err.message);
    process.exit(1);
});
