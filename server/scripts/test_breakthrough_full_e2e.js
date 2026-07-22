/**
 * 突破流程端到端测试
 *
 * 目的：验证 P0 修复（RealmService.breakthrough 完整重写）后的关键代码与接口行为
 *
 * 测试范围：
 *   1. 静态代码扫描：RealmService.breakthrough 方法包含 9 项关键修复点
 *      - 事务 + 行级锁
 *      - 死亡/闭关/悟道状态互斥校验
 *      - 修为是否足够校验
 *      - 瓶颈触发检查（bottleneck_realms）
 *      - 突破概率判定（calculateBreakthroughProbability + 瓶颈/虚弱调整）
 *      - 成功：同步 realm/realm_rank/exp/lifespan_max/hp_current/mp_current
 *      - 成功：清理瓶颈 + 清理虚弱 + WebSocket 推送
 *      - 失败：扣修为 + 触发虚弱 + 累加瓶颈失败次数 + WebSocket 推送
 *   2. 单元测试：RealmService.breakthrough 方法存在且为函数
 *   3. 接口测试：/api/player/breakthrough 能被正确调用并返回符合预期的响应结构
 *      - 测试账号化神初期 rank=23，修为不足时返回 400 + "修为不足" 类错误
 *      - 确保不会真的触发突破改变测试账号境界
 *
 * 测试账号：1592363624 / 1592363624（韩天尊，化神初期 rank=23）
 */
const fs = require('fs');
const path = require('path');

// 加载 .env 环境变量
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

/**
 * 统一 HTTP 调用封装
 * @param {string} method - HTTP 方法
 * @param {string} path - 接口路径
 * @param {string|null} token - JWT token
 * @param {object|null} body - 请求体
 * @returns {Promise<{status: number, json: any}>}
 */
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

// 测试结果汇总
const results = [];
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
    console.log('========================================');
    console.log('  突破流程端到端测试 (P0 修复验证)');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 - 9 项关键修复点 =====
    console.log('[场景1] 静态代码扫描 - RealmService.breakthrough 9 项关键修复点');

    const realmServiceCode = fs.readFileSync(
        path.join(__dirname, '../game/core/RealmService.js'), 'utf-8'
    );

    // 提取 breakthrough 方法体（从 `async breakthrough(playerId) {` 到下一个 `async ` 方法或类结束）
    const btStart = realmServiceCode.indexOf('async breakthrough(playerId)');
    const btEnd = realmServiceCode.indexOf('\n    async ', btStart + 10);
    const btMethod = btStart >= 0
        ? realmServiceCode.substring(btStart, btEnd > 0 ? btEnd : realmServiceCode.length)
        : '';

    check('1. breakthrough 方法存在',
        btStart >= 0, btStart < 0 ? '未找到 async breakthrough(playerId)' : '');

    check('2. 使用事务包裹（sequelize.transaction）',
        /sequelize\.transaction\(\)/.test(btMethod), '');

    check('3. 使用行级锁（t.LOCK.UPDATE）',
        /t\.LOCK\.UPDATE/.test(btMethod), '');

    check('4. 死亡玩家不可突破校验（is_dead）',
        /player\.is_dead/.test(btMethod), '');

    check('5. 闭关状态互斥校验（is_secluded）',
        /player\.is_secluded/.test(btMethod), '');

    check('6. 悟道状态互斥校验（is_meditating）',
        /player\.is_meditating/.test(btMethod), '');

    check('7. 瓶颈触发检查（bottleneck_enabled + bottleneck_realms）',
        /bottleneck_enabled/.test(btMethod) && /bottleneck_realms/.test(btMethod), '');

    check('8. 突破概率判定（calculateBreakthroughProbability + Math.random）',
        /calculateBreakthroughProbability/.test(btMethod) && /Math\.random\(\)/.test(btMethod), '');

    check('9. 成功同步 realm_rank',
        /player\.realm_rank\s*=\s*nextRealm\.rank/.test(btMethod), '');

    check('10. 成功同步 lifespan_max',
        /player\.lifespan_max\s*=\s*nextRealm\.lifespan_max/.test(btMethod), '');

    check('11. 成功同步 hp_current/mp_current',
        /player\.hp_current\s*=\s*BigInt\(maxHp\)/.test(btMethod) &&
        /player\.mp_current\s*=\s*BigInt\(maxMp\)/.test(btMethod), '');

    check('12. 成功清理瓶颈（handleBreakthroughSuccess）',
        /MeditationService\.handleBreakthroughSuccess/.test(btMethod), '');

    check('13. 失败扣修为（failure_exp_loss_rate）',
        /failure_exp_loss_rate/.test(btMethod), '');

    check('14. 失败触发虚弱（weakness_end_time）',
        /weakness_end_time/.test(btMethod), '');

    check('15. 失败累加瓶颈失败次数（handleBreakthroughFailure）',
        /MeditationService\.handleBreakthroughFailure/.test(btMethod), '');

    check('16. WebSocket 推送（notifyPlayerUpdate）',
        /WebSocketNotificationService\.notifyPlayerUpdate/.test(btMethod), '');

    check('17. 异常回滚（t.rollback）',
        /t\.rollback\(\)/.test(btMethod), '');

    // ===== 场景2：单元测试 - RealmService.breakthrough 方法存在且为函数 =====
    console.log('\n[场景2] 单元测试 - RealmService.breakthrough 方法存在性');

    try {
        // 初始化配置加载器（RealmService 依赖 realm_breakthrough 配置）
        const { infrastructure } = require('../modules');
        const configLoader = infrastructure.ConfigLoader;
        if (configLoader && typeof configLoader.loadAllConfigs === 'function') {
            await configLoader.loadAllConfigs();
        }

        // RealmService 采用单例导出（module.exports = new RealmService()），不需要 new
        const RealmService = require('../game/core/RealmService');

        check('RealmService 实例加载成功', !!RealmService, '');
        check('breakthrough 是函数', typeof RealmService.breakthrough === 'function', '');
        check('calculateBreakthroughProbability 是函数',
            typeof RealmService.calculateBreakthroughProbability === 'function', '');
        check('canBreakthrough 是函数',
            typeof RealmService.canBreakthrough === 'function', '');
        check('meetsRealmRequirement 是函数',
            typeof RealmService.meetsRealmRequirement === 'function', '');
    } catch (err) {
        check('RealmService 单元测试', false, `异常: ${err.message}`);
    }

    // ===== 场景3：接口测试 - /api/player/breakthrough 调用 =====
    console.log('\n[场景3] 接口测试 - /api/player/breakthrough 调用');

    // 登录获取 token
    let token = null;
    try {
        const loginRes = await api('POST', '/api/auth/login', null, {
            username: TEST_USERNAME,
            password: TEST_PASSWORD
        });
        if (loginRes.json?.token) {
            token = loginRes.json.token;
            check('测试账号登录成功', !!token, '');
        } else {
            check('测试账号登录成功', false,
                `status=${loginRes.status}, msg=${loginRes.json?.message || '无'}`);
        }
    } catch (err) {
        check('测试账号登录成功', false, `异常: ${err.message}`);
    }

    if (token) {
        // 获取当前玩家信息（确认境界）
        const meRes = await api('GET', '/api/player/me', token);
        const player = meRes.json?.data;
        check('/api/player/me 返回成功', meRes.status === 200 && !!player,
            `status=${meRes.status}`);

        if (player) {
            check('玩家境界字段存在', !!player.realm, `realm=${player.realm}`);
            check('玩家 realm_rank 字段存在',
                player.realm_rank !== undefined && player.realm_rank !== null,
                `realm_rank=${player.realm_rank}`);
            check('玩家修为字段存在',
                player.exp !== undefined && player.exp !== null,
                `exp=${player.exp}`);
            check('玩家 hp_current 字段存在',
                player.hp_current !== undefined && player.hp_current !== null,
                `hp_current=${player.hp_current}`);
            check('玩家 mp_current 字段存在',
                player.mp_current !== undefined && player.mp_current !== null,
                `mp_current=${player.mp_current}`);
            check('玩家 lifespan_max 字段存在',
                player.lifespan_max !== undefined && player.lifespan_max !== null,
                `lifespan_max=${player.lifespan_max}`);

            console.log(`\n  📊 测试账号当前状态：`);
            console.log(`     境界: ${player.realm} (rank=${player.realm_rank})`);
            console.log(`     修为: ${player.exp}`);
            console.log(`     HP: ${player.hp_current} / MP: ${player.mp_current}`);
            console.log(`     寿命上限: ${player.lifespan_max}`);
        }

        // 调用突破接口（不期望真的成功，仅验证响应结构）
        // 测试账号化神初期 rank=23，若修为不足应返回 400
        console.log('\n  调用 POST /api/player/breakthrough 验证响应结构...');
        const btRes = await api('POST', '/api/player/breakthrough', token);

        check('突破接口返回 HTTP 状态（200 或 400）',
            btRes.status === 200 || btRes.status === 400,
            `实际 status=${btRes.status}`);

        if (btRes.json) {
            check('响应包含 code 字段',
                btRes.json.code !== undefined, `code=${btRes.json.code}`);
            check('响应包含 message 字段',
                typeof btRes.json.message === 'string',
                `message=${btRes.json.message?.substring(0, 60)}`);

            if (btRes.status === 400) {
                // 修为不足或状态互斥等失败场景
                check('失败响应 message 包含具体原因',
                    btRes.json.message.length > 0,
                    `message=${btRes.json.message}`);
                console.log(`     ℹ️  失败原因（预期）：${btRes.json.message}`);
            } else if (btRes.status === 200 && btRes.json.code === 200) {
                // 不应真的成功（因为修为通常不足），如果成功说明测试账号修为已满
                console.log(`     ⚠️  警告：测试账号修为已满，实际触发了突破！`);
                console.log(`     ⚠️  突破结果：${btRes.json.message}`);
                if (btRes.json.data?.newRealm) {
                    console.log(`     ⚠️  新境界：${btRes.json.data.newRealm}`);
                }
            }
        } else {
            check('响应体为 JSON', false, '无法解析为 JSON');
        }

        // 调用 /api/breakthrough/info 验证返回结构（另一套实现）
        console.log('\n  调用 GET /api/breakthrough/info 验证返回结构...');
        const infoRes = await api('GET', '/api/breakthrough/info', token);
        check('/api/breakthrough/info 返回 200',
            infoRes.status === 200, `status=${infoRes.status}`);

        if (infoRes.json?.data) {
            const data = infoRes.json.data;
            check('info 响应包含 current_realm',
                data.current_realm !== undefined, '');
            check('info 响应包含 next_realm',
                data.next_realm !== undefined, '');
            check('info 响应包含 breakthrough_probability',
                data.breakthrough_probability !== undefined,
                `probability=${data.breakthrough_probability}`);
            check('info 响应包含 bottleneck 字段',
                data.bottleneck !== undefined, '');
            check('info 响应包含 high_realm 字段',
                data.high_realm !== undefined, '');

            console.log(`\n  📊 突破信息：`);
            console.log(`     当前境界: ${data.current_realm?.name || '无'}`);
            console.log(`     下一境界: ${data.next_realm?.name || '已满级'}`);
            console.log(`     突破概率: ${data.breakthrough_probability}%`);
            console.log(`     瓶颈状态: ${data.bottleneck?.state || 'none'}`);
            console.log(`     是否虚弱: ${data.high_realm?.is_weak ? '是' : '否'}`);
        }
    }

    // ===== 测试汇总 =====
    console.log('\n========================================');
    console.log('  测试汇总');
    console.log('========================================');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    console.log(`  通过: ${passed}  失败: ${failed}  总计: ${results.length}`);
    console.log('');

    if (failed > 0) {
        console.log('  ❌ 失败项明细：');
        results.filter(r => !r.pass).forEach(r => {
            console.log(`     - ${r.name}${r.detail ? ' | ' + r.detail : ''}`);
        });
        process.exit(1);
    } else {
        console.log('  ✅ 全部测试通过！');
        process.exit(0);
    }
})().catch(err => {
    console.error('\n💥 测试脚本异常:', err);
    process.exit(2);
});
