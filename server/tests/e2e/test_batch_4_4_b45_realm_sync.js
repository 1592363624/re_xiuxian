/**
 * 批次4-4 B45 修复验证测试
 *
 * 目的：验证 admin 强制突破/重置玩家、玩家轮回三处都已同步 realm_rank
 *      同时验证 RealmService.meetsRealmRequirement 优先使用 player.realm_rank
 *
 * 测试内容：
 *   1. 静态代码扫描：三处修复点都包含 realm_rank 同步代码
 *   2. RealmService.meetsRealmRequirement 单元测试：传入对象时优先用 realm_rank
 *   3. 测试账号 realm/realm_rank 一致性验证
 *   4. /api/player/me 接口返回的 realm 与 realm_rank 一致
 *
 * 测试账号：1592363624 / 1592363624（韩天尊，化神初期 rank=23）
 */
const fs = require('fs');
const path = require('path');

// 加载 .env 环境变量
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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

(async () => {
    console.log('========================================');
    console.log('  批次4-4 B45 修复验证测试');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 三处修复点 =====
    console.log('[场景1] 静态代码扫描 - 三处修复点');

    // 1. admin.js reset-player 应同步 realm_rank
    const adminCode = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf-8');
    check('admin.js reset-player 应包含 realm_rank = RealmService.getRealmRank(\'凡人\')',
        adminCode.includes("player.realm_rank = RealmService.getRealmRank('凡人')"),
        '缺失 realm_rank 同步代码');

    // 2. admin.js breakthrough 应同步 realm_rank
    check('admin.js breakthrough 应包含 realm_rank = RealmService.getRealmRank(targetRealm)',
        adminCode.includes('player.realm_rank = RealmService.getRealmRank(targetRealm)'),
        '缺失 realm_rank 同步代码');

    // 3. admin.js 应已引入 RealmService
    check('admin.js 应已引入 RealmService',
        adminCode.includes("require('../game/core/RealmService')"),
        '缺失 RealmService 引入');

    // 4. player.js reincarnate 应同步 realm_rank
    const playerRouteCode = fs.readFileSync(path.join(__dirname, '../routes/player.js'), 'utf-8');
    check('player.js reincarnate 应包含 realm_rank = game.RealmService.getRealmRank(\'凡人\')',
        playerRouteCode.includes("player.realm_rank = game.RealmService.getRealmRank('凡人')"),
        '缺失 realm_rank 同步代码');

    // 5. RealmService.meetsRealmRequirement 应优先使用 realm_rank
    const realmServiceCode = fs.readFileSync(path.join(__dirname, '../game/core/RealmService.js'), 'utf-8');
    check('RealmService.meetsRealmRequirement 应优先使用 player.realm_rank',
        realmServiceCode.includes('playerOrRealm?.realm_rank && playerOrRealm.realm_rank > 0'),
        '缺失 realm_rank 优先逻辑');

    // ===== 场景2：RealmService 单元测试 - 传入对象优先用 realm_rank =====
    console.log('\n[场景2] RealmService.meetsRealmRequirement 单元测试');
    // 初始化配置加载器（RealmService 依赖 realm_breakthrough 配置）
    const { infrastructure } = require('../modules');
    const configLoader = infrastructure.ConfigLoader;
    if (typeof configLoader.initialize === 'function') {
        await configLoader.initialize();
    }
    const RealmService = require('../game/core/RealmService');

    // 模拟 realm="凡人" 但 realm_rank=23 的不一致玩家对象
    const inconsistentPlayer = { realm: '凡人', realm_rank: 23 };
    const result = RealmService.meetsRealmRequirement(inconsistentPlayer, '筑基期');
    check('realm="凡人" realm_rank=23 应满足筑基期要求（按 realm_rank 判断）',
        result.met === true && result.playerRank === 23,
        `met=${result.met}, playerRank=${result.playerRank}, reason=${result.reason || ''}`);

    // 模拟 realm="化神初期" realm_rank=23 的一致玩家对象
    const consistentPlayer = { realm: '化神初期', realm_rank: 23 };
    const result2 = RealmService.meetsRealmRequirement(consistentPlayer, '筑基期');
    check('realm="化神初期" realm_rank=23 应满足筑基期要求',
        result2.met === true && result2.playerRank === 23,
        `met=${result2.met}, playerRank=${result2.playerRank}`);

    // 模拟 realm="凡人" realm_rank=1 的低境界玩家
    const lowPlayer = { realm: '凡人', realm_rank: 1 };
    const result3 = RealmService.meetsRealmRequirement(lowPlayer, '筑基期');
    check('realm="凡人" realm_rank=1 应不满足筑基期要求',
        result3.met === false,
        `met=${result3.met}, reason=${result3.reason || ''}`);

    // 模拟传入字符串（兼容旧调用方式）
    const result4 = RealmService.meetsRealmRequirement('化神初期', '筑基期');
    check('字符串"化神初期"应满足筑基期要求（兼容字符串调用）',
        result4.met === true && result4.playerRank === 23,
        `met=${result4.met}, playerRank=${result4.playerRank}`);

    // ===== 场景3：登录测试账号 =====
    console.log('\n[场景3] 登录测试账号');
    const loginRes = await api('POST', '/api/auth/login', null, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    check('登录应返回 200', loginRes.status === 200);
    const token = loginRes.json?.token;
    check('应返回 token', !!token);
    if (!token) process.exit(1);

    // ===== 场景4：/api/player/me 接口验证 realm/realm_rank 一致性 =====
    console.log('\n[场景4] /api/player/me 接口验证 realm/realm_rank 一致性');
    const meRes = await api('GET', '/api/player/me', token);
    check('/api/player/me 应返回 200', meRes.status === 200);
    if (meRes.status === 200 && meRes.json?.data) {
        const me = meRes.json.data;
        console.log(`  nickname: ${me.nickname}`);
        console.log(`  realm: ${me.realm}`);
        console.log(`  realm_rank: ${me.realm_rank}`);
        check('realm 应为"化神初期"（rank=23 对应境界）',
            me.realm === '化神初期', `actual=${me.realm}`);
        check('realm_rank 应为 23',
            me.realm_rank === 23, `actual=${me.realm_rank}`);
        // 一致性校验：根据 realm_rank 推断的境界名应等于 realm
        const expectedRealm = RealmService.getRealmByRank(me.realm_rank);
        check(`realm="${me.realm}" 应与 realm_rank=${me.realm_rank} 对应的境界名 "${expectedRealm?.name}" 一致`,
            me.realm === expectedRealm?.name,
            `expected=${expectedRealm?.name}, actual=${me.realm}`);
    }

    // ===== 场景5：深度闭关解锁验证（化神期可用）=====
    console.log('\n[场景5] 深度闭关境界校验（化神期应可用）');
    // 静态检查 seclusion 配置中 min_realm 是筑基期，化神期（rank=23）应满足
    const seclusionCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/seclusion.json'), 'utf-8'));
    const minRealm = seclusionCfg.deep_seclusion?.min_realm || seclusionCfg.min_realm;
    console.log(`  深度闭关 min_realm: ${minRealm}`);
    const reqCheck = RealmService.meetsRealmRequirement(
        { realm: '化神初期', realm_rank: 23 },
        minRealm || '筑基期'
    );
    check('化神初期(rank=23) 应满足深度闭关境界要求',
        reqCheck.met === true,
        `met=${reqCheck.met}, reason=${reqCheck.reason || ''}`);

    // ===== 汇总 =====
    console.log('\n========================================');
    console.log('  B45 修复验证测试结果汇总');
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

    process.exit(failed.length === 0 ? 0 : 1);
})();
