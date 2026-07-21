/**
 * 多人副本奖励显示数值验证脚本
 *
 * 测试目的：
 *   验证修复后的 GET /api/multi-dungeon/rewards 接口返回的字段结构
 *   符合前端 MultiDungeonPanel.vue 期望的 normal_rewards / first_clear_rewards / rare_rewards
 *
 * 测试覆盖：
 *   1. yanyue（掩月抢亲）：无 base_rewards，有 normal_drops + first_clear_bonus + rare_drop
 *   2. duanwu（端午镇蛟）：有 base_rewards + rare_drops_by_contribution + first_clear_bonus
 *   3. kunwu（昆吾山·封魔塔）：有 base_rewards + normal_drops + first_clear_bonus + rare_drop + 特殊机制
 *   4. xutian（虚天殿）：有 base_rewards + normal_drops + first_clear_bonus + rare_drop + 特殊机制
 *
 * 运行方式：node server/scripts/test_multi_dungeon_rewards_display.js
 */
const axios = require('axios');

const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';
const API_BASE = 'http://localhost:5000/api';

// 4 个副本的期望值（基于 multi_dungeon_data.json 配置）
const EXPECTED = {
    yanyue: {
        name: '掩月抢亲',
        // yanyue 没有 base_rewards，只有 normal_drops（8 种）
        normal_rewards_min: 8,    // 月华玉露、断红绫、阴阳剑丝、掩月镜砂、素女禁纹、血剑铁髓、法宝图谱、灵石
        first_clear_rewards_min: 3, // 称号、月华玉露×5、灵石50000
        rare_rewards_min: 1,        // 血魔剑（0.1%）
        rare_item_name: '血魔剑'
    },
    duanwu: {
        name: '端午镇蛟',
        // duanwu 没有 normal_drops，但有 base_rewards（3 种），归入 normal_rewards
        normal_rewards_min: 3,    // 沧龙江灵石红包、修为+5000、荣誉值+50
        first_clear_rewards_min: 3, // 称号、红包×3、全服公告
        rare_rewards_min: 6,        // rare_drops_by_contribution 有 6 种
        rare_item_name: '五色丝'
    },
    kunwu: {
        name: '昆吾山·封魔塔',
        // kunwu 有 base_rewards（3 种）+ normal_drops（7 种）= 10 种
        normal_rewards_min: 10,
        first_clear_rewards_min: 4, // 称号、法宝图谱×3、灵石50000、全服公告
        rare_rewards_min: 1,        // 八灵尺（0.2%）
        rare_item_name: '八灵尺'
    },
    xutian: {
        name: '虚天殿',
        // xutian 有 base_rewards（3 种）+ normal_drops（7 种）= 10 种
        normal_rewards_min: 10,
        first_clear_rewards_min: 4, // 称号、法宝图谱×3、灵石60000、全服公告
        rare_rewards_min: 1,        // 虚天鼎（0.1%）
        rare_item_name: '虚天鼎'
    }
};

async function main() {
    console.log('========== 多人副本奖励显示数值验证 ==========\n');

    // Step 1: 登录
    console.log('[Step 1] 登录获取 token...');
    const loginResp = await axios.post(`${API_BASE}/auth/login`, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    if (loginResp.data.code !== 200) {
        throw new Error(`登录失败: ${loginResp.data.message}`);
    }
    const token = loginResp.data.token;
    const authHeader = { Authorization: `Bearer ${token}` };
    console.log(`  ✓ 登录成功\n`);

    let allPassed = true;

    // Step 2: 测试 4 个副本的 rewards 接口
    for (const [dungeonKey, expected] of Object.entries(EXPECTED)) {
        console.log(`[Step 2.${dungeonKey}] 测试 ${expected.name}（${dungeonKey}）奖励池...`);

        const resp = await axios.get(`${API_BASE}/multi-dungeon/rewards`, {
            params: { dungeon_key: dungeonKey },
            headers: authHeader
        });

        if (resp.data.code !== 200) {
            console.log(`  ✗ 接口返回错误: ${resp.data.message}\n`);
            allPassed = false;
            continue;
        }

        const data = resp.data.data;
        console.log(`  ✓ 副本名: ${data.dungeon_name}`);
        console.log(`  ✓ 副本key: ${data.dungeon_key}`);

        // 验证顶层字段存在
        const hasNormal = Array.isArray(data.normal_rewards);
        const hasFirstClear = Array.isArray(data.first_clear_rewards);
        const hasRare = Array.isArray(data.rare_rewards);
        console.log(`  ✓ normal_rewards 字段: ${hasNormal ? '存在' : '缺失'}（${data.normal_rewards?.length || 0} 项）`);
        console.log(`  ✓ first_clear_rewards 字段: ${hasFirstClear ? '存在' : '缺失'}（${data.first_clear_rewards?.length || 0} 项）`);
        console.log(`  ✓ rare_rewards 字段: ${hasRare ? '存在' : '缺失'}（${data.rare_rewards?.length || 0} 项）`);

        // 验证数量符合预期
        const normalCount = data.normal_rewards?.length || 0;
        const firstClearCount = data.first_clear_rewards?.length || 0;
        const rareCount = data.rare_rewards?.length || 0;

        const normalOk = normalCount >= expected.normal_rewards_min;
        const firstClearOk = firstClearCount >= expected.first_clear_rewards_min;
        const rareOk = rareCount >= expected.rare_rewards_min;

        console.log(`  ${normalOk ? '✓' : '✗'} 普通掉落数量: ${normalCount}（期望 ≥ ${expected.normal_rewards_min}）`);
        console.log(`  ${firstClearOk ? '✓' : '✗'} 首通奖励数量: ${firstClearCount}（期望 ≥ ${expected.first_clear_rewards_min}）`);
        console.log(`  ${rareOk ? '✓' : '✗'} 稀有掉落数量: ${rareCount}（期望 ≥ ${expected.rare_rewards_min}）`);

        if (!normalOk || !firstClearOk || !rareOk) {
            allPassed = false;
        }

        // 验证每项字段结构完整
        if (hasNormal && data.normal_rewards.length > 0) {
            const r = data.normal_rewards[0];
            const hasFields = r.reward_key && r.name && r.description !== undefined && r.amount !== undefined && r.type;
            console.log(`  ${hasFields ? '✓' : '✗'} 字段结构完整: reward_key=${r.reward_key}, name=${r.name}, amount=${r.amount}, type=${r.type}`);
            if (!hasFields) allPassed = false;
        }

        // 验证稀有掉落名称
        if (hasRare && data.rare_rewards.length > 0) {
            const rareItem = data.rare_rewards.find(r => r.name === expected.rare_item_name);
            if (rareItem) {
                console.log(`  ✓ 稀有掉落 ${expected.rare_item_name} 存在: amount=${rareItem.amount}`);
            } else {
                console.log(`  ✗ 稀有掉落 ${expected.rare_item_name} 未找到`);
                console.log(`    实际稀有掉落: ${data.rare_rewards.map(r => r.name).join(', ')}`);
                allPassed = false;
            }
        }

        // 打印前 3 项普通掉落作为示例
        if (hasNormal) {
            console.log(`  📋 普通掉落示例（前 3 项）:`);
            for (const r of data.normal_rewards.slice(0, 3)) {
                console.log(`     - ${r.name} | ${r.amount} | ${r.description || '无描述'}`);
            }
        }

        console.log('');
    }

    console.log('========== 测试结果汇总 ==========');
    if (allPassed) {
        console.log('✓ 所有 4 个副本的奖励池接口字段结构正确');
        console.log('  - 顶层暴露 normal_rewards / first_clear_rewards / rare_rewards 数组');
        console.log('  - 每项结构: { reward_key, name, description, amount, type }');
        console.log('  - yanyue 的 normal_drops 已正确转换为 normal_rewards');
        console.log('  - duanwu 的 rare_drops_by_contribution 已归入 rare_rewards');
        console.log('  - kunwu/xutian 的 base_rewards 已归入 normal_rewards');
    } else {
        console.log('✗ 部分测试未通过，请检查上述 ✗ 标记项');
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('测试执行失败:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
});
