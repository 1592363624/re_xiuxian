/**
 * 端到端验证用户原始问题：化神期玩家能使用筑基期解锁的深度闭关
 *
 * 用户报告："我都化神了,为什么筑基期解锁的深度闭关我还不能使用"
 *
 * 根因（B1 + B45 已修复）：
 *   1. B1：旧逻辑用 REALM_ORDER.indexOf 比较，"化神中期"等子境界名不在数组中，被错误拦截
 *   2. B45：admin 强制突破/重置玩家 + 玩家轮回三处只更新 player.realm 未同步 player.realm_rank，
 *      导致测试账号 realm="凡人" 但 realm_rank=23，meetsRealmRequirement 按 realm="凡人" 当低境界处理
 *
 * 验证：
 *   1. 测试账号 (化神初期 rank=23) 调用 /api/seclusion/status，应返回 can_deep=true
 *   2. 测试账号调用 /api/seclusion/start (mode=deep)，应返回 200（不因境界被拒）
 *   3. 验证 /api/player/me 返回的 realm 和 realm_rank 一致
 */
require('dotenv').config();
const BASE = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

async function api(method, path, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json };
}

const results = [];
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

async function main() {
    console.log('========================================');
    console.log('  端到端验证：化神期玩家能使用深度闭关');
    console.log('========================================\n');

    // ===== 场景1：登录 =====
    console.log('[场景1] 登录测试账号');
    const loginRes = await api('POST', '/api/auth/login', null, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    check('登录应返回 200', loginRes.status === 200, `actual=${loginRes.status}`);
    const token = loginRes.json?.token;
    check('应返回 token', !!token);
    if (!token) {
        console.log('❌ 无法获取 token，终止测试');
        process.exit(1);
    }

    // ===== 场景2：验证 /api/player/me 返回的 realm 和 realm_rank 一致 =====
    console.log('\n[场景2] 验证玩家境界信息一致性');
    const meRes = await api('GET', '/api/player/me', token);
    check('/api/player/me 应返回 200', meRes.status === 200);
    const me = meRes.json?.data;
    console.log(`  玩家: ${me?.nickname}, realm: ${me?.realm}, realm_rank: ${me?.realm_rank}, realmInfo.rank: ${me?.realmInfo?.rank}`);

    check('玩家应为化神期（rank >= 23）',
        (me?.realm_rank || 0) >= 23,
        `realm=${me?.realm}, realm_rank=${me?.realm_rank}`);
    check('realm 与 realm_rank 应一致',
        me?.realmInfo?.rank === me?.realm_rank,
        `realmInfo.rank=${me?.realmInfo?.rank}, realm_rank=${me?.realm_rank}`);
    check('realm 字段应为"化神初期"',
        me?.realm === '化神初期',
        `actual=${me?.realm}`);

    // ===== 场景3：调用 /api/seclusion/status 验证 can_deep=true =====
    console.log('\n[场景3] 查询闭关状态（应返回 can_deep=true）');
    const statusRes = await api('GET', '/api/seclusion/status', token);
    check('/api/seclusion/status 应返回 200', statusRes.status === 200, `actual=${statusRes.status}, msg=${statusRes.json?.message || ''}`);
    const status = statusRes.json?.data || statusRes.json;
    console.log(`  can_deep: ${status?.can_deep}, deep_remaining: ${status?.deep_remaining}, deep_cooldown_remaining: ${status?.deep_cooldown_remaining}`);

    // 核心断言：化神期玩家应能使用深度闭关
    check('can_deep 应为 true（化神期 >= 筑基期）',
        status?.can_deep === true,
        `can_deep=${status?.can_deep}`);

    if (status?.can_deep === false) {
        console.log('  ❌ 用户原始问题未修复：化神期玩家仍无法使用深度闭关');
        console.log(`     可能原因：`);
        console.log(`     1. realm/realm_rank 不一致（B45 修复未生效）`);
        console.log(`     2. RealmService.meetsRealmRequirement 逻辑有误（B1 修复未生效）`);
        console.log(`     3. 测试账号数据被污染（B46 修复未生效）`);
    } else {
        console.log('  ✅ 用户原始问题已修复：化神期玩家可以使用深度闭关');
    }

    // ===== 场景4：调用 /api/seclusion/start (mode=deep) 应返回 200 =====
    console.log('\n[场景4] 尝试开始深度闭关（应不被境界拦截）');

    // 先检查是否已在闭关中
    if (status?.is_secluded) {
        console.log('  ℹ️ 玩家已在闭关中，先结束当前闭关');
        await api('POST', '/api/seclusion/end', token);
    }

    // 检查冷却时间
    if (status?.deep_cooldown_remaining && status.deep_cooldown_remaining > 0) {
        console.log(`  ℹ️ 深度闭关冷却中，剩余 ${status.deep_cooldown_remaining} 秒，跳过 start 测试`);
    } else if (status?.deep_remaining !== undefined && status.deep_remaining <= 0) {
        console.log('  ℹ️ 今日深度闭关次数已用尽，跳过 start 测试');
    } else {
        // 尝试开始深度闭关（duration=14400 即 4 小时，最短时长）
        const startRes = await api('POST', '/api/seclusion/start', token, {
            mode: 'deep',
            duration: 14400
        });
        console.log(`  start 响应: status=${startRes.status}, code=${startRes.json?.code}, message=${startRes.json?.message || ''}`);

        // 核心断言：不应因境界问题被拒（400 + "深度闭关需达到" 是境界拦截的特征）
        const isRealmBlocked = startRes.status === 400 &&
            (startRes.json?.message || '').includes('深度闭关需达到');

        check('深度闭关 start 不应被境界拦截',
            !isRealmBlocked,
            isRealmBlocked ? `被拦截：${startRes.json?.message}` : `actual=${startRes.status}`);

        if (startRes.status === 200) {
            console.log('  ✅ 深度闭关启动成功（或返回成功响应）');
            // 立即结束，避免影响后续测试
            console.log('  ℹ️ 立即结束闭关以还原状态');
            const endRes = await api('POST', '/api/seclusion/end', token);
            console.log(`  end 响应: status=${endRes.status}, message=${endRes.json?.message || ''}`);
        } else if (!isRealmBlocked) {
            console.log(`  ℹ️ 深度闭关未启动（业务原因，非境界拦截）：${startRes.json?.message}`);
        }
    }

    // ===== 场景5：RealmService 单元测试 - 化神期应满足筑基期要求 =====
    console.log('\n[场景5] RealmService.meetsRealmRequirement 单元验证');
    try {
        const { infrastructure } = require('../modules');
        infrastructure.ConfigLoader.initialize();
        const game = require('../game');
        await require('../config/database').authenticate();
        await game.initializeGameServices(infrastructure.ConfigLoader);

        const Player = require('../models/player');
        const player = await Player.findByPk(1);

        const check1 = game.RealmService.meetsRealmRequirement(player, '筑基期');
        check('化神初期 player 应满足筑基期要求',
            check1.met === true,
            `met=${check1.met}, reason=${check1.reason || ''}`);

        const check2 = game.RealmService.meetsRealmRequirement(player, '化神期');
        check('化神初期 player 应满足化神期要求',
            check2.met === true,
            `met=${check2.met}, reason=${check2.reason || ''}`);

        const check3 = game.RealmService.meetsRealmRequirement(player, '炼虚期');
        check('化神初期 player 应不满足炼虚期要求',
            check3.met === false,
            `met=${check3.met}, reason=${check3.reason || ''}`);

        const check4 = game.RealmService.meetsRealmRequirement('化神初期', '筑基期');
        check('字符串"化神初期"应满足筑基期要求',
            check4.met === true,
            `met=${check4.met}, reason=${check4.reason || ''}`);

        // 测试 B45 防御性逻辑：模拟 realm/realm_rank 不一致
        const inconsistentPlayer = { realm: '凡人', realm_rank: 23 };
        const check5 = game.RealmService.meetsRealmRequirement(inconsistentPlayer, '筑基期');
        check('B45 防御：realm="凡人" 但 realm_rank=23 应满足筑基期要求（优先用 realm_rank）',
            check5.met === true,
            `met=${check5.met}, reason=${check5.reason || ''}`);

        const consistentLowPlayer = { realm: '凡人', realm_rank: 1 };
        const check6 = game.RealmService.meetsRealmRequirement(consistentLowPlayer, '筑基期');
        check('realm="凡人" realm_rank=1 应不满足筑基期要求',
            check6.met === false,
            `met=${check6.met}, reason=${check6.reason || ''}`);
    } catch (e) {
        check('RealmService 单元测试应无异常', false, `异常: ${e.message}`);
    }

    // ===== 汇总 =====
    console.log('\n========================================');
    console.log('  端到端验证结果汇总');
    console.log('========================================');
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    console.log(`  通过: ${passed} / ${total}`);
    console.log(`  失败: ${total - passed} / ${total}`);
    console.log(`  成功率: ${(passed / total * 100).toFixed(1)}%\n`);

    const failed = results.filter(r => !r.pass);
    if (failed.length > 0) {
        console.log('失败项明细：');
        failed.forEach(f => console.log(`  ❌ ${f.name} | ${f.detail}`));
    }

    // ===== 清理测试副作用：清除闭关冷却，避免污染后续测试 =====
    try {
        const Player = require('../models/player');
        const player = await Player.findByPk(1);
        if (player) {
            player.is_secluded = false;
            player.seclusion_end_time = null;
            player.seclusion_mode = 'normal';
            player.seclusion_start_time = null;
            player.seclusion_duration = 0;
            // 清除 last_seclusion_time 以解除 60 分钟冷却限制
            player.last_seclusion_time = null;
            await player.save();
            console.log('✅ 已清除闭关冷却状态（last_seclusion_time=null）');
        }
    } catch (e) {
        console.log(`⚠️ 清除闭关冷却失败: ${e.message}`);
    }

    if (failed.length === 0) {
        console.log('\n✅ 用户原始问题"化神期玩家不能使用深度闭关"已彻底修复');
    }

    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('测试脚本异常:', err);
    process.exit(1);
});
