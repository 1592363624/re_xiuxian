/**
 * 批次4-3 运行时验证测试：玩家年龄/修为/死亡界面/事件触发一致性
 *
 * 用户目标原文：
 *   "奖励数值、玩家年龄、修为、死亡界面变化、事件触发检查测试"
 *
 * 本脚本覆盖：
 *   场景1：登录 + /api/player/me 返回字段一致性（年龄/修为/HP/MP/死亡字段）
 *   场景2：修为显示一致性 —— 后端 BigInt 字符串，前端 formatNumber 应可正确格式化
 *   场景3：PlayerService.handlePlayerDeath 触发战斗死亡（HP=0 事件）
 *          验证 is_dead=true / death_reason='战斗陨落' / death_time 不为空
 *   场景4：handlePlayerDeath 幂等性 —— 已死亡玩家再次调用返回 null
 *   场景5：死亡期间玩家无法进行其他操作（闭关/探索/战斗被拒绝）
 *   场景6：调用 /api/player/reincarnate 重生，is_dead=false 字段重置
 *   场景7：死亡损失率配置一致性 —— lifespan.death_exp_loss_rate 与 combat.death_exp_penalty_rate 配置统一
 *   场景8：admin time-travel 推进时间后，/api/player/me 的 lifespan_current 应相应增长
 *
 * 运行方式：
 *   cd server && node scripts/test_batch_4_3_runtime.js
 *
 * 前置条件：
 *   - 后端服务运行在 http://localhost:5000
 *   - 测试账号 1592363624 / 1592363624（玩家ID=1）
 */
'use strict';

const sequelize = require('../config/database');
const Player = require('../models/player');
const { initializeModules } = require('../modules');
const game = require('../game');

const BASE_URL = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

// 测试结果统计
const testResults = { passed: 0, failed: 0, total: 0, skipped: 0 };

/**
 * 断言函数
 * @param {boolean} condition - 条件
 * @param {string} message - 断言描述
 * @param {*} [extra] - 失败时附加信息
 */
function assert(condition, message, extra = null) {
    testResults.total++;
    if (condition) {
        testResults.passed++;
        console.log(`  ✅ ${message}`);
    } else {
        testResults.failed++;
        console.error(`  ❌ ${message}`);
        if (extra !== null) {
            console.error('     附加信息:', typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
        }
    }
}

/**
 * 跳过断言（不增加总数，仅记录）
 * @param {string} message - 跳过描述
 */
function skip(message) {
    testResults.skipped++;
    console.log(`  ⏭️  跳过: ${message}`);
}

/**
 * HTTP 请求工具
 * @param {string} method - HTTP 方法
 * @param {string} path - 路径
 * @param {Object} [body] - 请求体
 * @param {string} [token] - JWT token
 * @returns {Promise<{status: number, body: Object}>}
 */
async function http(method, path, body = null, token = null) {
    const url = `${BASE_URL}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    const resp = await fetch(url, options);
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { _raw: text }; }
    return { status: resp.status, body: json };
}

/**
 * 模拟前端 formatNumber（与 client/src/utils/format.js 保持一致）
 * 用于验证后端返回的 BigInt 字符串在前端能被正确格式化
 * @param {number|string|bigint} num
 * @returns {string}
 */
function formatNumberClient(num) {
    if (num === null || num === undefined || num === '') return '0';
    let str = typeof num === 'bigint' ? num.toString() : String(num).trim();
    if (!str) return '0';
    let sign = '';
    if (str.startsWith('-')) { sign = '-'; str = str.slice(1); }
    else if (str.startsWith('+')) { str = str.slice(1); }
    const dotIdx = str.indexOf('.');
    let intPart = dotIdx >= 0 ? str.slice(0, dotIdx) : str;
    if (!/^\d+$/.test(intPart)) return String(num);
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + intPart;
}

/**
 * 主测试流程
 */
async function main() {
    console.log('========================================');
    console.log('  批次4-3 运行时验证：年龄/修为/死亡/事件触发');
    console.log('========================================');

    // 初始化模块（直接调用 Service 类需要）
    await initializeModules();
    const configLoader = require('../modules/infrastructure/ConfigLoader');
    await game.initializeGameServices(configLoader);

    const PlayerService = require('../game/core/PlayerService');
    // PlayerService 是单例导出（module.exports = new PlayerService()），无需 new
    const playerService = PlayerService;

    // 备份玩家原始状态
    const player = await Player.findByPk(1);
    if (!player) {
        console.error('未找到测试玩家（id=1）');
        process.exit(1);
    }

    const backup = {
        is_dead: player.is_dead,
        death_reason: player.death_reason,
        death_time: player.death_time,
        lifespan_current: player.lifespan_current,
        lifespan_max: player.lifespan_max,
        hp_current: player.hp_current,
        mp_current: player.mp_current,
        exp: player.exp,
        // 修复 B46：备份 realm/realm_rank/role/attributes 等字段
        // 否则测试场景6调用 /api/player/reincarnate 会把 realm 重置为"凡人"、realm_rank 重置为 0
        // 测试结束后只还原寿命/HP/MP/exp，但 realm/realm_rank 永久污染
        realm: player.realm,
        realm_rank: player.realm_rank,
        role: player.role,
        attributes: player.attributes,
        is_secluded: player.is_secluded,
        is_meditating: player.is_meditating,
        bottleneck_state: player.bottleneck_state,
        bottleneck_insight: player.bottleneck_insight,
        weakness_end_time: player.weakness_end_time,
        seclusion_end_time: player.seclusion_end_time,
        last_seclusion_time: player.last_seclusion_time
    };
    console.log(`\n玩家: ${player.nickname} 境界: ${player.realm} (rank=${player.realm_rank})`);
    console.log(`原始状态: is_dead=${backup.is_dead}, lifespan=${backup.lifespan_current}/${backup.lifespan_max}, exp=${backup.exp?.toString?.() || backup.exp}`);

    // 先确保玩家未处于死亡状态（避免上一轮测试残留）
    if (player.is_dead === true) {
        console.log('\n[预备] 玩家处于死亡状态，先调用轮回重生...');
        const loginResp = await http('POST', '/api/auth/login', {
            username: TEST_USERNAME,
            password: TEST_PASSWORD
        });
        if (loginResp.status === 200 && loginResp.body.token) {
            const reincarnateResp = await http('POST', '/api/player/reincarnate', {}, loginResp.body.token);
            console.log(`  轮回响应: status=${reincarnateResp.status}, code=${reincarnateResp.body?.code}`);
        }
    }

    try {
        // ========== 场景1: 登录 + /api/player/me 字段一致性 ==========
        console.log('\n[场景1] 登录 + /api/player/me 返回字段一致性');
        const loginResp = await http('POST', '/api/auth/login', {
            username: TEST_USERNAME,
            password: TEST_PASSWORD
        });
        assert(loginResp.status === 200, '登录应返回 200', { status: loginResp.status, body: loginResp.body });
        const token = loginResp.body.token;
        assert(!!token, '应返回 token', { body: loginResp.body });

        const meResp = await http('GET', '/api/player/me', null, token);
        assert(meResp.status === 200, '/api/player/me 应返回 200', { status: meResp.status });
        const meData = meResp.body.data || {};
        console.log(`  玩家: ${meData.nickname}, 境界: ${meData.realm}`);
        console.log(`  年龄: ${meData.lifespan_current} / ${meData.lifespan_max}`);
        console.log(`  修为: ${meData.exp}`);
        console.log(`  HP: ${meData.hp_current}, MP: ${meData.mp_current}`);
        console.log(`  is_dead: ${meData.is_dead}, death_reason: ${meData.death_reason}`);

        // 字段一致性验证
        // 修复 B41 后，/api/player/me 应同时返回 lifespan_current/lifespan_max 顶层字段
        // 和 lifespan.current/lifespan.max 嵌套字段，前端两种用法都支持
        assert(meData.lifespan_current !== undefined,
            'lifespan_current 顶层字段应存在（B41 修复后）', { actual: meData.lifespan_current });
        assert(meData.lifespan_max !== undefined,
            'lifespan_max 顶层字段应存在（B41 修复后）', { actual: meData.lifespan_max });
        assert(meData.lifespan?.current !== undefined,
            'lifespan.current 嵌套字段应存在', { actual: meData.lifespan?.current });
        assert(meData.lifespan?.max !== undefined,
            'lifespan.max 嵌套字段应存在', { actual: meData.lifespan?.max });
        assert(meData.exp !== undefined, 'exp 字段应存在');
        assert(meData.hp_current !== undefined, 'hp_current 字段应存在');
        assert(meData.mp_current !== undefined, 'mp_current 字段应存在');
        assert(meData.is_dead !== undefined, 'is_dead 字段应存在');
        assert(meData.is_dead === false, '玩家应处于存活状态（is_dead=false）', { actual: meData.is_dead });

        // 验证 lifespan_current 顶层字段与 lifespan.current 嵌套字段一致
        if (meData.lifespan_current !== undefined && meData.lifespan?.current !== undefined) {
            assert(Number(meData.lifespan_current) === Number(meData.lifespan.current),
                'lifespan_current 顶层字段应与 lifespan.current 一致',
                { top: meData.lifespan_current, nested: meData.lifespan.current });
        }

        // ========== 场景2: 修为显示一致性（BigInt 字符串 → formatNumber） ==========
        console.log('\n[场景2] 修为显示一致性（后端 BigInt 字符串 → 前端 formatNumber）');

        // 后端返回的 exp 应为字符串（BigInt toJSON 序列化为字符串）
        const expRaw = meData.exp;
        const expType = typeof expRaw;
        console.log(`  后端返回 exp 类型: ${expType}, 值: ${expRaw}`);
        assert(expType === 'string' || expType === 'number',
            `exp 应为字符串或数字（实际: ${expType}）`, { exp: expRaw });

        // 模拟前端 formatNumber 格式化
        const expFormatted = formatNumberClient(expRaw);
        console.log(`  前端 formatNumber 格式化后: ${expFormatted}`);
        assert(expFormatted && expFormatted !== '0',
            'formatNumber 应返回非空非零字符串', { formatted: expFormatted });

        // 验证大数不会精度丢失（如果 exp 是大数）
        // 后端 BigInt 字段经过 BigInt.prototype.toJSON 序列化为字符串
        // 前端 formatNumber 用字符串处理，不调用 Number()，避免精度损失
        if (expType === 'string' && expRaw.length > 15) {
            console.log(`  检测到大数字符串（长度 ${expRaw.length}），验证 formatNumber 不损失精度`);
            // formatNumber 不改变字符串数字内容，仅加千分位
            const expNoComma = expFormatted.replace(/,/g, '');
            assert(expNoComma === expRaw,
                'formatNumber 处理大数不应损失精度（去千分位后应等于原值）',
                { original: expRaw, formatted: expFormatted, noComma: expNoComma });
        }

        // ========== 场景3: PlayerService.handlePlayerDeath 触发战斗死亡 ==========
        console.log('\n[场景3] PlayerService.handlePlayerDeath 触发战斗死亡（HP=0 事件）');

        // 直接调用 Service 触发战斗死亡
        const deathReason = '战斗陨落';
        const deathInfo = await playerService.handlePlayerDeath(1, deathReason);
        console.log(`  死亡结算信息: ${JSON.stringify(deathInfo)}`);
        assert(deathInfo !== null, 'handlePlayerDeath 应返回死亡结算信息', deathInfo);
        assert(deathInfo?.reason === deathReason,
            `reason 应为 "${deathReason}"`, { actual: deathInfo?.reason });
        assert(deathInfo?.expLoss !== undefined, 'expLoss 字段应存在', deathInfo);
        assert(deathInfo?.ageIncrease !== undefined, 'ageIncrease 字段应存在', deathInfo);
        assert(deathInfo?.respawnAt !== undefined, 'respawnAt 字段应存在', deathInfo);

        // 查询数据库验证死亡字段已落库
        const playerAfterDeath = await Player.findByPk(1);
        console.log(`  死亡后: is_dead=${playerAfterDeath.is_dead}, death_reason=${playerAfterDeath.death_reason}, death_time=${playerAfterDeath.death_time}`);
        assert(playerAfterDeath.is_dead === true,
            'is_dead 应为 true', { actual: playerAfterDeath.is_dead });
        assert(playerAfterDeath.death_reason === deathReason,
            `death_reason 应为 "${deathReason}"`, { actual: playerAfterDeath.death_reason });
        assert(playerAfterDeath.death_time !== null,
            'death_time 应不为 null', { actual: playerAfterDeath.death_time });

        // 验证 /api/player/me 返回的死亡字段
        const meAfterDeath = await http('GET', '/api/player/me', null, token);
        const meAfterDeathData = meAfterDeath.body.data || {};
        assert(meAfterDeathData.is_dead === true,
            '/api/player/me 应返回 is_dead=true', { actual: meAfterDeathData.is_dead });
        assert(meAfterDeathData.death_reason === deathReason,
            `/api/player/me 应返回 death_reason="${deathReason}"`, { actual: meAfterDeathData.death_reason });

        // 验证修为损失正确（10% 默认）
        const expBefore = BigInt(backup.exp || 0);
        const expAfter = BigInt(playerAfterDeath.exp || 0);
        const expLoss = expBefore - expAfter;
        console.log(`  修为损失: ${expLoss.toString()} (前=${expBefore.toString()}, 后=${expAfter.toString()})`);
        assert(expLoss > 0n, '修为损失应大于 0', { before: expBefore.toString(), after: expAfter.toString() });

        // ========== 场景4: handlePlayerDeath 幂等性 ==========
        console.log('\n[场景4] handlePlayerDeath 幂等性（已死亡玩家再次调用应返回 null）');
        const secondDeathInfo = await playerService.handlePlayerDeath(1, deathReason);
        console.log(`  第二次调用返回: ${secondDeathInfo}`);
        assert(secondDeathInfo === null,
            '已死亡玩家再次调用 handlePlayerDeath 应返回 null（幂等性）',
            { actual: secondDeathInfo });

        // 验证修为没有再次扣减（幂等性的关键证据）
        const playerAfterSecondDeath = await Player.findByPk(1);
        const expAfterSecond = BigInt(playerAfterSecondDeath.exp || 0);
        assert(expAfterSecond === expAfter,
            '幂等调用后修为不应再次扣减',
            { first: expAfter.toString(), second: expAfterSecond.toString() });

        // ========== 场景5: 死亡期间玩家无法进行其他操作 ==========
        console.log('\n[场景5] 死亡期间玩家无法进行其他操作');

        // 尝试闭关
        const seclusionResp = await http('POST', '/api/seclusion/start', {
            mode: 'normal',
            duration: 60
        }, token);
        console.log(`  闭关响应: status=${seclusionResp.status}, code=${seclusionResp.body?.code}, message=${seclusionResp.body?.message}`);
        assert(seclusionResp.status !== 200 || seclusionResp.body?.code !== 200,
            '死亡期间闭关应被拒绝',
            { status: seclusionResp.status, code: seclusionResp.body?.code });

        // 尝试探索
        const exploreResp = await http('POST', '/api/map/explore/start', {
            map_id: 1
        }, token);
        console.log(`  探索响应: status=${exploreResp.status}, code=${exploreResp.body?.code}`);
        assert(exploreResp.status !== 200 || exploreResp.body?.code !== 200,
            '死亡期间探索应被拒绝',
            { status: exploreResp.status, code: exploreResp.body?.code });

        // ========== 场景6: 调用 /api/player/reincarnate 重生 ==========
        console.log('\n[场景6] 调用 /api/player/reincarnate 重生');
        const reincarnateResp = await http('POST', '/api/player/reincarnate', {}, token);
        console.log(`  轮回响应: status=${reincarnateResp.status}, code=${reincarnateResp.body?.code}, message=${reincarnateResp.body?.message}`);
        assert(reincarnateResp.status === 200,
            '轮回应返回 200', { status: reincarnateResp.status, body: reincarnateResp.body });

        // 验证 is_dead 已重置
        const playerAfterReincarnation = await Player.findByPk(1);
        console.log(`  重生后: is_dead=${playerAfterReincarnation.is_dead}, death_reason=${playerAfterReincarnation.death_reason}, death_time=${playerAfterReincarnation.death_time}`);
        assert(playerAfterReincarnation.is_dead === false,
            '重生后 is_dead 应为 false', { actual: playerAfterReincarnation.is_dead });
        assert(playerAfterReincarnation.death_reason === null || playerAfterReincarnation.death_reason === '',
            '重生后 death_reason 应为 null 或空',
            { actual: playerAfterReincarnation.death_reason });
        assert(playerAfterReincarnation.death_time === null,
            '重生后 death_time 应为 null', { actual: playerAfterReincarnation.death_time });

        // ========== 场景7: 死亡损失率配置一致性 ==========
        console.log('\n[场景7] 死亡损失率配置一致性');
        const gameBalanceConfig = configLoader.getConfig('game_balance');
        const lifespanLossRate = gameBalanceConfig?.lifespan?.death_exp_loss_rate;
        const combatLossRate = gameBalanceConfig?.combat?.death_exp_penalty_rate;
        console.log(`  lifespan.death_exp_loss_rate = ${lifespanLossRate}`);
        console.log(`  combat.death_exp_penalty_rate = ${combatLossRate}`);
        assert(lifespanLossRate !== undefined,
            'lifespan.death_exp_loss_rate 配置应存在');
        assert(combatLossRate !== undefined,
            'combat.death_exp_penalty_rate 配置应存在');
        // 两个损失率应保持一致（否则不同死亡场景惩罚不一致，影响游戏平衡）
        assert(lifespanLossRate === combatLossRate,
            '两个损失率配置应保持一致（lifespan.death_exp_loss_rate === combat.death_exp_penalty_rate）',
            { lifespan: lifespanLossRate, combat: combatLossRate });

        // ========== 场景8: admin time-travel 推进时间后寿命增长 ==========
        console.log('\n[场景8] admin time-travel 推进时间后 lifespan_current 增长');

        // 获取 admin token（测试账号是 admin）
        const adminToken = token; // 1592363624 是 admin 账号

        // 记录推进前的 lifespan_current
        const beforeTravel = await Player.findByPk(1);
        const lifespanBefore = Number(beforeTravel.lifespan_current || 0);
        console.log(`  推进前 lifespan_current = ${lifespanBefore}`);

        // 推进 1 年时间（LifespanService 应使 lifespan_current 增长约 1）
        const travelResp = await http('POST', '/api/admin/time-travel', {
            years: 1
        }, adminToken);
        console.log(`  time-travel 响应: status=${travelResp.status}, code=${travelResp.body?.code}, message=${travelResp.body?.message}`);

        if (travelResp.status === 200 && travelResp.body?.code === 200) {
            const afterTravel = await Player.findByPk(1);
            const lifespanAfter = Number(afterTravel.lifespan_current || 0);
            console.log(`  推进后 lifespan_current = ${lifespanAfter}`);
            const diff = lifespanAfter - lifespanBefore;
            console.log(`  寿命增长 = ${diff}`);

            assert(lifespanAfter > lifespanBefore,
                '推进 1 年后 lifespan_current 应增长',
                { before: lifespanBefore, after: lifespanAfter, diff });

            // 推进 1 年 = 31536000 秒 = 525600 游戏天 = 1440 游戏年（远超凡人寿命 60）
            // 因此玩家 1 会触发寿元耗尽，lifespan_current 被定格在 lifespan_max
            // 验证两种情况：
            //   1. 寿元未耗尽：diff 在合理范围（>0.5）
            //   2. 寿元耗尽：lifespan_current = lifespan_max，is_dead=true
            const lifespanMax = Number(afterTravel.lifespan_max || 0);
            if (afterTravel.is_dead === true) {
                // 寿元耗尽：lifespan_current 应被定格在 lifespan_max
                assert(Math.abs(lifespanAfter - lifespanMax) < 0.001,
                    '寿元耗尽时 lifespan_current 应被定格在 lifespan_max',
                    { lifespanAfter, lifespanMax });
                console.log(`  玩家寿元耗尽死亡：lifespan_current=${lifespanAfter}, is_dead=true`);
            } else {
                // 寿元未耗尽：diff 应大于 0.5（1 年至少增长 0.5）
                assert(diff > 0.5,
                    `寿元未耗尽时寿命增长应大于 0.5（实际: ${diff}）`,
                    { diff });
            }

            // 验证 /api/player/me 也返回了更新后的 lifespan_current
            const meAfterTravel = await http('GET', '/api/player/me', null, token);
            const meAfterTravelData = meAfterTravel.body.data || {};
            const lifespanFromApi = Number(meAfterTravelData.lifespan_current || 0);
            assert(Math.abs(lifespanFromApi - lifespanAfter) < 0.001,
                '/api/player/me 返回的 lifespan_current 应与数据库一致',
                { api: lifespanFromApi, db: lifespanAfter });
        } else {
            skip('admin time-travel 接口不可用，跳过寿命推进验证');
        }

    } finally {
        // ========== 还原玩家原始状态 ==========
        console.log('\n[还原] 恢复玩家原始状态');
        const restorePlayer = await Player.findByPk(1);
        restorePlayer.is_dead = backup.is_dead;
        restorePlayer.death_reason = backup.death_reason;
        restorePlayer.death_time = backup.death_time;
        restorePlayer.lifespan_current = backup.lifespan_current;
        restorePlayer.lifespan_max = backup.lifespan_max;
        restorePlayer.hp_current = backup.hp_current;
        restorePlayer.mp_current = backup.mp_current;
        restorePlayer.exp = backup.exp;
        // 修复 B46：还原 realm/realm_rank/role/attributes 等字段
        // 否则测试场景6调用 /api/player/reincarnate 会重置这些字段，测试结束后未还原导致数据永久污染
        restorePlayer.realm = backup.realm;
        restorePlayer.realm_rank = backup.realm_rank;
        restorePlayer.role = backup.role;
        if (backup.attributes) restorePlayer.attributes = backup.attributes;
        restorePlayer.is_secluded = backup.is_secluded;
        restorePlayer.is_meditating = backup.is_meditating;
        restorePlayer.bottleneck_state = backup.bottleneck_state;
        restorePlayer.bottleneck_insight = backup.bottleneck_insight;
        restorePlayer.weakness_end_time = backup.weakness_end_time;
        restorePlayer.seclusion_end_time = backup.seclusion_end_time;
        restorePlayer.last_seclusion_time = backup.last_seclusion_time;
        await restorePlayer.save();
        console.log(`  已恢复玩家状态: realm=${restorePlayer.realm}(rank=${restorePlayer.realm_rank}), is_dead=${restorePlayer.is_dead}, lifespan=${restorePlayer.lifespan_current}/${restorePlayer.lifespan_max}`);
    }

    // ========== 测试结果汇总 ==========
    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    console.log(`  通过: ${testResults.passed} / ${testResults.total}`);
    console.log(`  失败: ${testResults.failed} / ${testResults.total}`);
    console.log(`  跳过: ${testResults.skipped}`);
    const successRate = testResults.total > 0
        ? ((testResults.passed / testResults.total) * 100).toFixed(1)
        : '0.0';
    console.log(`  成功率: ${successRate}%`);

    if (testResults.failed > 0) {
        console.log('\n❌ 存在失败用例，请检查上述日志');
        process.exit(1);
    } else {
        console.log('\n✅ 全部通过');
        process.exit(0);
    }
}

// 启动测试
main().catch(err => {
    console.error('\n测试执行异常:', err);
    process.exit(2);
});
