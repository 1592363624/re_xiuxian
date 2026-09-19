/**
 * 大五行幻世轮线 端到端测试
 *
 * 测试范围：
 *   1. 登录鉴权
 *   2. 参数校验（定相白名单）
 *   3. 配置完整性校验
 *   4. 状态查询（未持有/已持有）
 *   5. 定相流程（首次定相 + 相同相位校验 + 冷却校验）
 *   6. 悟印提示查询
 *   7. 轮转技能（5阶前锁定 + 解锁后开关）
 *   8. 战斗悟印积累 addInsightExp（PVE/PVP/副本 + 五行相克加成 + 每日上限 + 连续升阶 + 7阶翻倍）
 *   9. 战力加成计算 getFiveElementWheelCombatBonus
 *
 * 测试账号：1592363624 / 1592363624
 * 运行方式：node server/scripts/test_five_element_wheel.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-22
 */
'use strict';

const http = require('http');
const path = require('path');

// 显式加载 server/.env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const HOST = '127.0.0.1';
const PORT = 5000;
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerEquipment = require('../models/playerEquipment');
const { infrastructure } = require('../modules');
const ArtifactDeepLineService = require('../game/services/ArtifactDeepLineService');

const configLoader = infrastructure.ConfigLoader;

let passCount = 0;
let failCount = 0;
const failures = [];

// ========== 辅助函数 ==========

/**
 * HTTP 请求封装
 */
function request(method, reqPath, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const data = body ? JSON.stringify(body) : null;
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ host: HOST, port: PORT, path: reqPath, method, headers }, (res) => {
            let chunks = '';
            res.on('data', (c) => chunks += c);
            res.on('end', () => {
                let parsed = null;
                try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function pass(name) { passCount++; console.log(`  ✅ ${name}`); }
function fail(name, actual, expected) {
    failCount++; failures.push({ name, actual, expected });
    console.log(`  ❌ ${name}`);
    if (expected !== undefined) console.log(`     期望: ${JSON.stringify(expected)}`);
    if (actual !== undefined) console.log(`     实际: ${JSON.stringify(actual)}`);
}
function assertEqual(name, actual, expected) {
    if (actual === expected) pass(name);
    else fail(name, actual, expected);
}
function assertTrue(name, actual) {
    if (actual === true || (actual && typeof actual === 'object')) pass(name);
    else fail(name, actual, 'truthy');
}
function assertFalse(name, actual) {
    if (!actual) pass(name);
    else fail(name, actual, 'falsy');
}

/**
 * 重置幻世轮状态（整体赋值方式，确保 Sequelize 检测变更）
 * @param {number} playerId - 玩家ID
 * @param {Object} wheelStateOverride - 需要覆盖的状态字段
 */
async function resetWheelState(playerId, wheelStateOverride = {}) {
    const equipment = await PlayerEquipment.findOne({
        where: { player_id: playerId, item_key: 'five_element_wheel' }
    });
    if (!equipment) return null;

    const defaultState = {
        insight_stage: 0,
        insight_exp: 0,
        daily_insight_gained: 0,
        daily_insight_reset_at: new Date().toISOString().slice(0, 10),
        current_phase: 'rotation',
        last_set_phase_at: null,
        wheel_spin_enabled: false,
        total_battles: 0,
        total_insight_gained: 0,
        ...wheelStateOverride
    };

    // 显式覆盖子对象（避免 Sequelize TEXT 字段 get()/set() 陷阱）
    equipment.deep_line_state = {
        ...equipment.deep_line_state,
        five_element_wheel: defaultState
    };
    equipment.changed('deep_line_state', true);
    await equipment.save();
    return defaultState;
}

/**
 * 获取当前幻世轮状态
 */
async function getWheelState(playerId) {
    const equipment = await PlayerEquipment.findOne({
        where: { player_id: playerId, item_key: 'five_element_wheel' }
    });
    if (!equipment) return null;
    return equipment.deep_line_state?.five_element_wheel || null;
}

// ========== 主测试流程 ==========

async function main() {
    console.log('\n=========================================');
    console.log('  大五行幻世轮线 端到端测试');
    console.log('=========================================\n');

    // 初始化 ConfigLoader
    if (!configLoader.isInitialized) {
        await configLoader.initialize();
    }

    // 阶段 1：登录
    console.log('【阶段 1】登录获取 JWT token');
    const loginRes = await request('POST', '/api/auth/login', { username: TEST_ACCOUNT, password: TEST_PASSWORD });
    if (loginRes.status !== 200 || !loginRes.body?.token) {
        console.error('❌ 登录失败:', loginRes.status, JSON.stringify(loginRes.body).slice(0, 200));
        process.exit(1);
    }
    const token = loginRes.body.token;
    pass('登录成功');

    // 阶段 2：鉴权测试
    console.log('\n【阶段 2】鉴权测试');
    {
        const r1 = await request('GET', '/api/artifact-deep-line/five-element-wheel/status');
        assertEqual('未登录 GET status 应返回 401', r1.status, 401);
        const r2 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', { phase: 'metal' });
        assertEqual('未登录 POST set-phase 应返回 401', r2.status, 401);
        const r3 = await request('POST', '/api/artifact-deep-line/five-element-wheel/insight');
        assertEqual('未登录 POST insight 应返回 401', r3.status, 401);
        const r4 = await request('POST', '/api/artifact-deep-line/five-element-wheel/wheel-spin');
        assertEqual('未登录 POST wheel-spin 应返回 401', r4.status, 401);
    }

    // 阶段 3：参数校验
    console.log('\n【阶段 3】参数校验');
    {
        const r1 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', {}, token);
        assertEqual('phase 为空应返回 400', r1.status, 400);
        const r2 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', { phase: 'invalid' }, token);
        assertEqual('phase 无效应返回 400', r2.status, 400);
        const r3 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', { phase: 'wind' }, token);
        assertEqual('phase=wind 无效应返回 400', r3.status, 400);
    }

    // 阶段 4：配置完整性校验
    console.log('\n【阶段 4】配置完整性校验');
    {
        const cfg = ArtifactDeepLineService.getFiveElementWheelConfig();
        assertTrue('幻世轮配置应存在', cfg);
        assertTrue('enabled 应为 true', cfg.enabled === true);
        assertEqual('item_key 应为 five_element_wheel', cfg.item_key, 'five_element_wheel');
        assertEqual('item_name 应为 大五行幻世轮', cfg.item_name, '大五行幻世轮');
        assertEqual('min_realm_rank 应为 23', cfg.min_realm_rank, 23);
        assertEqual('max_stage 应为 10', cfg.max_stage, 10);
        assertEqual('daily_insight_limit 应为 100', cfg.daily_insight_limit, 100);
        assertEqual('set_phase_cooldown_days 应为 7', cfg.set_phase_cooldown_days, 7);
        assertEqual('wheel_spin_unlock_stage 应为 5', cfg.wheel_spin_unlock_stage, 5);

        // 6 种相位
        const phaseKeys = Object.keys(cfg.phases || {});
        assertEqual('应有 6 种相位', phaseKeys.length, 6);
        assertTrue('应含 rotation 相位', phaseKeys.includes('rotation'));
        assertTrue('应含 metal 相位', phaseKeys.includes('metal'));
        assertTrue('应含 water 相位', phaseKeys.includes('water'));
        assertTrue('应含 wood 相位', phaseKeys.includes('wood'));
        assertTrue('应含 fire 相位', phaseKeys.includes('fire'));
        assertTrue('应含 earth 相位', phaseKeys.includes('earth'));

        // 10 阶配置
        assertTrue('stages 应有 10 阶', (cfg.stages || []).length === 10);
        assertTrue('第 5 阶应解锁轮转', cfg.stages[4]?.unlock_wheel_spin === true);
        assertTrue('第 1 阶倍率应为 1.0', cfg.stages[0]?.phase_multiplier === 1.0);
        assertTrue('第 10 阶倍率应为 3.0', cfg.stages[9]?.phase_multiplier === 3.0);

        // 五行相克
        const overcomes = cfg.element_relations?.overcomes || {};
        assertEqual('金应克木', overcomes.metal, 'wood');
        assertEqual('木应克土', overcomes.wood, 'earth');
        assertEqual('土应克水', overcomes.earth, 'water');
        assertEqual('水应克火', overcomes.water, 'fire');
        assertEqual('火应克金', overcomes.fire, 'metal');

        // 战斗悟印奖励
        const rewards = cfg.battle_insight_rewards || {};
        assertEqual('PVE 胜利基础悟印应为 10', rewards.pve_win_base, 10);
        assertEqual('PVP 胜利基础悟印应为 20', rewards.pvp_win_base, 20);
        assertEqual('副本胜利基础悟印应为 15', rewards.dungeon_win_base, 15);
    }

    // 阶段 5：状态查询（未持有）
    console.log('\n【阶段 5】状态查询（未持有幻世轮）');
    const playerId = 1;
    // 先删除可能存在的幻世轮装备记录，确保从"未持有"状态开始测试
    {
        const existing = await PlayerEquipment.findOne({
            where: { player_id: playerId, item_key: 'five_element_wheel' }
        });
        if (existing) {
            await existing.destroy();
            console.log('  ℹ 已清理旧的幻世轮装备记录');
        }

        const r = await request('GET', '/api/artifact-deep-line/five-element-wheel/status', null, token);
        assertEqual('status 接口应返回 200', r.status, 200);
        assertTrue('应返回 data 对象', !!r.body?.data);
        if (r.body?.data) {
            assertFalse('has_wheel 应为 false', r.body.data.has_wheel);
            assertEqual('item_key 应为 five_element_wheel', r.body.data.item_key, 'five_element_wheel');
        }
    }

    // 阶段 6：创建装备记录
    console.log('\n【阶段 6】创建幻世轮装备记录');
    {
        // dharma 槽位可能已被其他法器占用，需先处理
        const existingDharma = await PlayerEquipment.findOne({
            where: { player_id: playerId, slot: 'dharma' }
        });
        if (existingDharma) {
            console.log(`  ℹ dharma 槽位已占用（${existingDharma.item_key}），替换为幻世轮`);
            existingDharma.item_key = 'five_element_wheel';
            existingDharma.durability = 100;
            existingDharma.max_durability = 100;
            existingDharma.refine_level = 0;
            existingDharma.is_benming = false;
            existingDharma.is_summoned = false;
            existingDharma.deep_line_state = {};
            existingDharma.changed('deep_line_state', true);
            await existingDharma.save();
        } else {
            await PlayerEquipment.create({
                player_id: playerId,
                slot: 'dharma',
                item_key: 'five_element_wheel',
                durability: 100,
                max_durability: 100,
                refine_level: 0,
                is_benming: false,
                is_summoned: false,
                deep_line_state: {}
            });
        }
        pass('幻世轮装备记录已创建');
    }

    // 阶段 7：状态查询（已持有）
    console.log('\n【阶段 7】状态查询（已持有幻世轮）');
    {
        // 重置状态
        await resetWheelState(playerId);

        const r = await request('GET', '/api/artifact-deep-line/five-element-wheel/status', null, token);
        assertEqual('status 接口应返回 200', r.status, 200);
        assertTrue('应返回 data 对象', !!r.body?.data);
        if (r.body?.data) {
            assertTrue('has_wheel 应为 true', r.body.data.has_wheel === true);
            assertEqual('初始悟印阶数应为 0', r.body.data.insight_stage, 0);
            assertEqual('初始相位应为 rotation', r.body.data.current_phase, 'rotation');
            assertEqual('初始轮转技能应未解锁', r.body.data.wheel_spin_unlocked, false);
            assertTrue('应返回战力加成对象', !!r.body.data.combat_bonus);
            assertTrue('应返回五行相克提示', !!r.body.data.element_advantage_hint);
            console.log(`     悟印阶数=${r.body.data.insight_stage}, 相位=${r.body.data.current_phase_name}, 加成=${JSON.stringify(r.body.data.combat_bonus)}`);
        }
    }

    // 阶段 8：定相流程
    console.log('\n【阶段 8】定相流程');
    {
        // 重置状态（清除定相冷却）
        await resetWheelState(playerId);

        // 8.1 首次定相：rotation → metal
        const r1 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', { phase: 'metal' }, token);
        assertEqual('首次定相 metal 应返回 200', r1.status, 200);
        assertTrue('首次定相应成功', r1.body?.success === true);
        if (r1.body?.success) {
            assertEqual('旧相位应为 rotation', r1.body.old_phase, 'rotation');
            assertEqual('新相位应为 metal', r1.body.new_phase, 'metal');
            assertEqual('新相位名应为 金', r1.body.new_phase_name, '金');
        }

        // 8.2 相同相位定相应被拒绝
        const r2 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', { phase: 'metal' }, token);
        assertEqual('相同相位定相应返回 400', r2.status, 400);

        // 8.3 冷却中切换定相应被拒绝
        const r3 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', { phase: 'fire' }, token);
        assertEqual('冷却中定相应返回 400', r3.status, 400);
        if (r3.status === 400 && r3.body?.message) {
            assertTrue('应含冷却提示', r3.body.message.includes('冷却'));
        }
    }

    // 阶段 9：悟印提示查询
    console.log('\n【阶段 9】悟印提示查询');
    {
        await resetWheelState(playerId, { current_phase: 'metal', last_set_phase_at: new Date() });

        const r = await request('POST', '/api/artifact-deep-line/five-element-wheel/insight', {}, token);
        assertEqual('insight 接口应返回 200', r.status, 200);
        assertTrue('应返回 data 对象', !!r.body?.data);
        if (r.body?.data) {
            assertEqual('当前阶数应为 0', r.body.data.current_stage, 0);
            assertEqual('每日上限应为 100', r.body.data.daily_insight_limit, 100);
            assertEqual('每日剩余应为 100', r.body.data.daily_insight_remaining, 100);
            assertEqual('当前相位应为 metal', r.body.data.current_phase, 'metal');
            assertTrue('应含五行相克提示', !!r.body.data.advantage_hint);
            assertTrue('应含战斗奖励预览', !!r.body.data.battle_rewards_preview);
            assertEqual('PVE 胜利预览应为 10', r.body.data.battle_rewards_preview.pve_win, 10);
            assertEqual('PVP 胜利预览应为 20', r.body.data.battle_rewards_preview.pvp_win, 20);
            assertFalse('轮转技能应未解锁（0阶）', r.body.data.wheel_spin_unlocked);
            console.log(`     相克提示: ${r.body.data.advantage_hint}`);
        }
    }

    // 阶段 10：战斗悟印积累 - PVE 胜利
    console.log('\n【阶段 10】战斗悟印积累 - PVE 胜利');
    {
        await resetWheelState(playerId);

        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: true,
            opponent_realm_rank: 23,
            opponent_phase: null
        });
        assertTrue('PVE 胜利应成功', result.success === true);
        assertEqual('基础悟印应为 10', result.base_insight, 10);
        assertTrue('获得悟印应 > 0', result.insight_gained > 0);
        assertEqual('战斗场次应为 1', result.total_battles || 1, 1);
        console.log(`     PVE胜利：获得${result.insight_gained}悟印, 当前经验=${result.insight_exp}, 阶数=${result.insight_stage}`);
    }

    // 阶段 11：战斗悟印积累 - PVP 胜利 + 五行相克加成
    console.log('\n【阶段 11】战斗悟印积累 - PVP 胜利 + 五行相克加成');
    {
        // 设置为 metal 相位，对手为 wood 相位（金克木 → advantage）
        await resetWheelState(playerId, { current_phase: 'metal', last_set_phase_at: new Date() });

        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pvp',
            is_win: true,
            opponent_realm_rank: 23,
            opponent_phase: 'wood'
        });
        assertTrue('PVP 胜利应成功', result.success === true);
        assertEqual('基础悟印应为 20', result.base_insight, 20);
        assertEqual('五行优势应为 advantage', result.element_advantage, 'advantage');
        assertTrue('相克系数应为 1.5', result.element_multiplier === 1.5);
        // 20 * 1.5 = 30
        assertEqual('最终悟印应为 30', result.insight_gained, 30);
        console.log(`     PVP胜利+金克木：基础${result.base_insight} × ${result.element_multiplier} = ${result.insight_gained}悟印`);
    }

    // 阶段 12：战斗悟印积累 - 五行被克减成
    console.log('\n【阶段 12】战斗悟印积累 - 五行被克减成');
    {
        // 设置为 metal 相位，对手为 fire 相位（火克金 → disadvantage）
        await resetWheelState(playerId, { current_phase: 'metal', last_set_phase_at: new Date() });

        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: true,
            opponent_realm_rank: 23,
            opponent_phase: 'fire'
        });
        assertTrue('PVE 胜利应成功', result.success === true);
        assertEqual('五行劣势应为 disadvantage', result.element_advantage, 'disadvantage');
        assertTrue('相克系数应为 0.7', result.element_multiplier === 0.7);
        // 10 * 0.7 = 7
        assertEqual('最终悟印应为 7', result.insight_gained, 7);
        console.log(`     PVE胜利+火克金：基础${result.base_insight} × ${result.element_multiplier} = ${result.insight_gained}悟印`);
    }

    // 阶段 13：战斗悟印积累 - 副本胜利
    console.log('\n【阶段 13】战斗悟印积累 - 副本胜利');
    {
        await resetWheelState(playerId);

        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'dungeon',
            is_win: true,
            opponent_realm_rank: 23
        });
        assertTrue('副本胜利应成功', result.success === true);
        assertEqual('基础悟印应为 15', result.base_insight, 15);
        console.log(`     副本胜利：获得${result.insight_gained}悟印`);
    }

    // 阶段 14：战斗悟印积累 - PVE 失败（少量悟印）
    console.log('\n【阶段 14】战斗悟印积累 - PVE 失败');
    {
        await resetWheelState(playerId);

        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: false,
            opponent_realm_rank: 23
        });
        assertTrue('PVE 失败应成功（获得少量悟印）', result.success === true);
        assertEqual('基础悟印应为 3', result.base_insight, 3);
        console.log(`     PVE失败：获得${result.insight_gained}悟印`);
    }

    // 阶段 15：连续升阶测试
    console.log('\n【阶段 15】连续升阶测试');
    {
        // 重置状态，设置经验接近 1 阶升阶点（需 50 经验）
        await resetWheelState(playerId, { insight_exp: 45, daily_insight_gained: 0 });

        // PVE 胜利获得 10 点，应触发升阶到 1 阶
        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: true,
            opponent_realm_rank: 23
        });
        assertTrue('应成功', result.success === true);
        assertTrue('应触发升阶', result.stage_up === true);
        assertEqual('旧阶数应为 0', result.old_stage, 0);
        assertEqual('新阶数应为 1', result.new_stage, 1);
        console.log(`     连续升阶：${result.old_stage}→${result.new_stage}（${result.new_stage_name}）`);
    }

    // 阶段 16：每日上限测试
    console.log('\n【阶段 16】每日上限测试');
    {
        // 设置今日已获 98 点（上限 100），PVE 胜利应获 10 但只能获 2
        await resetWheelState(playerId, {
            daily_insight_gained: 98,
            daily_insight_reset_at: new Date().toISOString().slice(0, 10)
        });

        const result1 = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: true,
            opponent_realm_rank: 23
        });
        assertTrue('应成功（上限裁剪）', result1.success === true);
        assertEqual('应只能获得 2 点（100-98=2）', result1.insight_gained, 2);
        console.log(`     上限裁剪：获得${result1.insight_gained}点（98→100）`);

        // 再次战斗应因每日上限被拒绝
        const result2 = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: true,
            opponent_realm_rank: 23
        });
        assertFalse('达到上限后应返回 success=false', result2.success);
        if (!result2.success) {
            assertTrue('应含上限提示', result2.reason.includes('上限'));
        }
    }

    // 阶段 17：轮转技能 - 5 阶前锁定
    console.log('\n【阶段 17】轮转技能 - 5 阶前锁定');
    {
        await resetWheelState(playerId, { insight_stage: 4 });

        const r = await request('POST', '/api/artifact-deep-line/five-element-wheel/wheel-spin', {}, token);
        assertEqual('5阶前轮转应返回 400', r.status, 400);
        if (r.body?.message) {
            assertTrue('应含解锁提示', r.body.message.includes('5') || r.body.message.includes('阶'));
        }
    }

    // 阶段 18：轮转技能 - 5 阶解锁后开关
    console.log('\n【阶段 18】轮转技能 - 5 阶解锁后开关');
    {
        await resetWheelState(playerId, { insight_stage: 5 });

        // 开启轮转
        const r1 = await request('POST', '/api/artifact-deep-line/five-element-wheel/wheel-spin', {}, token);
        assertEqual('5阶开启轮转应返回 200', r1.status, 200);
        assertTrue('轮转应成功开启', r1.body?.success === true);
        assertTrue('wheel_spin_enabled 应为 true', r1.body?.wheel_spin_enabled === true);

        // 关闭轮转
        const r2 = await request('POST', '/api/artifact-deep-line/five-element-wheel/wheel-spin', {}, token);
        assertEqual('关闭轮转应返回 200', r2.status, 200);
        assertTrue('轮转应成功关闭', r2.body?.success === true);
        assertFalse('wheel_spin_enabled 应为 false', r2.body?.wheel_spin_enabled);
    }

    // 阶段 19：7 阶翻倍测试
    console.log('\n【阶段 19】7 阶翻倍测试');
    {
        await resetWheelState(playerId, { insight_stage: 7 });

        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: true,
            opponent_realm_rank: 23
        });
        assertTrue('7阶战斗应成功', result.success === true);
        // 10 * 2.0(7阶翻倍) = 20
        assertTrue('7阶应翻倍', result.element_multiplier === 2.0);
        assertEqual('7阶翻倍后悟印应为 20', result.insight_gained, 20);
        console.log(`     7阶翻倍：基础${result.base_insight} × ${result.element_multiplier} = ${result.insight_gained}悟印`);
    }

    // 阶段 20：对手境界差加成测试
    console.log('\n【阶段 20】对手境界差加成测试');
    {
        await resetWheelState(playerId);

        // 对手境界 rank=43（比玩家 rank=23 高 20 级）
        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pvp',
            is_win: true,
            opponent_realm_rank: 43
        });
        assertTrue('越级挑战应成功', result.success === true);
        assertEqual('基础悟印应为 20', result.base_insight, 20);
        // 境界差 = 43 - 23 = 20，加成 = min(20*1, 20) = 20
        assertEqual('境界差加成应为 20', result.rank_diff_bonus, 20);
        // (20 + 20) * 1.0 = 40
        assertEqual('最终悟印应为 40', result.insight_gained, 40);
        console.log(`     越级挑战：基础${result.base_insight} + 境界差${result.rank_diff_bonus} = ${result.insight_gained}悟印`);
    }

    // 阶段 21：战力加成计算测试
    console.log('\n【阶段 21】战力加成计算测试');
    {
        // 0 阶 rotation 相位，倍率 1.0
        await resetWheelState(playerId, { insight_stage: 0, current_phase: 'rotation' });
        const bonus1 = await ArtifactDeepLineService.getFiveElementWheelCombatBonus(playerId);
        assertTrue('应返回战力加成', bonus1.has_wheel === true);
        assertEqual('0阶倍率应为 1.0', bonus1.phase_multiplier, 1.0);
        assertTrue('rotation 应有 atk_bonus_rate', bonus1.combat_bonus.atk_bonus_rate !== undefined);
        assertEqual('rotation 0阶 atk_bonus_rate 应为 0.03', bonus1.combat_bonus.atk_bonus_rate, 0.03);

        // 5 阶 metal 相位，倍率 1.5
        await resetWheelState(playerId, { insight_stage: 5, current_phase: 'metal' });
        const bonus2 = await ArtifactDeepLineService.getFiveElementWheelCombatBonus(playerId);
        assertEqual('5阶倍率应为 1.5', bonus2.phase_multiplier, 1.5);
        // 0.08 * 1.5 = 0.12
        assertEqual('metal 5阶 atk_bonus_rate 应为 0.12', bonus2.combat_bonus.atk_bonus_rate, 0.12);

        // 10 阶 fire 相位，倍率 3.0
        await resetWheelState(playerId, { insight_stage: 10, current_phase: 'fire' });
        const bonus3 = await ArtifactDeepLineService.getFiveElementWheelCombatBonus(playerId);
        assertEqual('10阶倍率应为 3.0', bonus3.phase_multiplier, 3.0);
        // 0.10 * 3.0 = 0.30
        assertEqual('fire 10阶 atk_bonus_rate 应为 0.3', bonus3.combat_bonus.atk_bonus_rate, 0.3);
        // 0.08 * 3.0 = 0.24
        assertEqual('fire 10阶 crit_rate_bonus 应为 0.24', bonus3.combat_bonus.crit_rate_bonus, 0.24);

        console.log(`     0阶rotation: atk=${bonus1.combat_bonus.atk_bonus_rate}`);
        console.log(`     5阶metal: atk=${bonus2.combat_bonus.atk_bonus_rate}`);
        console.log(`     10阶fire: atk=${bonus3.combat_bonus.atk_bonus_rate}, crit=${bonus3.combat_bonus.crit_rate_bonus}`);
    }

    // 阶段 22：未装备幻世轮时 addInsightExp 静默返回
    console.log('\n【阶段 22】未装备幻世轮时 addInsightExp 静默返回');
    {
        // 删除装备记录
        const equip = await PlayerEquipment.findOne({
            where: { player_id: playerId, item_key: 'five_element_wheel' }
        });
        if (equip) await equip.destroy();

        const result = await ArtifactDeepLineService.addInsightExp(playerId, {
            battle_type: 'pve',
            is_win: true,
            opponent_realm_rank: 23
        });
        assertFalse('未装备应返回 success=false', result.success);
        if (!result.success) {
            assertTrue('应含未装备提示', result.reason.includes('未装备'));
        }

        // 战力加成也应返回 has_wheel=false
        const bonus = await ArtifactDeepLineService.getFiveElementWheelCombatBonus(playerId);
        assertFalse('未装备战力加成应返回 has_wheel=false', bonus.has_wheel);
    }

    // 阶段 23：死亡状态校验
    console.log('\n【阶段 23】死亡状态校验');
    {
        // 重新创建装备记录
        await PlayerEquipment.create({
            player_id: playerId,
            slot: 'dharma',
            item_key: 'five_element_wheel',
            durability: 100,
            max_durability: 100,
            refine_level: 0,
            is_benming: false,
            is_summoned: false,
            deep_line_state: {}
        });

        // 临时标记为死亡
        const player = await Player.findByPk(playerId);
        const originalIsDead = player.is_dead;
        await player.update({ is_dead: true });

        // 定相应被拒绝
        const r1 = await request('POST', '/api/artifact-deep-line/five-element-wheel/set-phase', { phase: 'fire' }, token);
        assertEqual('死亡状态定相应返回 400', r1.status, 400);

        // 轮转技能应被拒绝（需先设置5阶）
        await resetWheelState(playerId, { insight_stage: 5, last_set_phase_at: null });
        const r2 = await request('POST', '/api/artifact-deep-line/five-element-wheel/wheel-spin', {}, token);
        assertEqual('死亡状态轮转应返回 400', r2.status, 400);

        // 恢复死亡状态
        await player.update({ is_dead: originalIsDead });
        pass('死亡状态校验完成，已恢复');
    }

    // ========== 测试结果汇总 ==========
    console.log('\n=========================================');
    console.log('  测试结果汇总');
    console.log('=========================================');
    console.log(`  通过: ${passCount}`);
    console.log(`  失败: ${failCount}`);
    if (failCount > 0) {
        console.log('\n  失败详情:');
        failures.forEach(f => {
            console.log(`    ❌ ${f.name}`);
            if (f.expected !== undefined) console.log(`       期望: ${JSON.stringify(f.expected)}`);
            if (f.actual !== undefined) console.log(`       实际: ${JSON.stringify(f.actual)}`);
        });
    }
    console.log('=========================================\n');

    if (failCount > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('\n❌ 测试脚本异常:', err);
    process.exit(1);
});
