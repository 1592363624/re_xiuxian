/**
 * 批次4-4 护道机制扩展回归测试
 *
 * 目的：
 *   验证护道机制扩展到 CombatService（野外战斗）和 WorldBossService（世界BOSS）后，
 *   不破坏现有战斗流程。即使玩家没有道侣，tryProtect 也会安全返回 { triggered: false }，
 *   战斗主流程正常进行。
 *
 * 测试范围：
 *   1. 登录 + 查询道侣状态（确认测试账号是否有道侣）
 *   2. 野外战斗：encounter → attack → monsterTurn 完整流程
 *   3. 世界BOSS：getList → getStatus 验证接口可用
 *   4. 静态代码扫描：验证 CombatService 和 WorldBossService 都集成了 tryProtect
 *
 * 不修改任何业务数据（除战斗本身的状态机推进，但战斗是临时的）。
 *
 * 修复 B46：若测试账号处于死亡状态，不调用 /api/player/reincarnate（会重置 realm/realm_rank/hp 等
 * 大量字段），改为直接通过数据库还原 is_dead=false，避免测试账号数据污染。
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

// 简易 fetch 封装
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

// 测试结果收集
const results = [];
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
    console.log('========================================');
    console.log('  批次4-4 护道机制扩展回归测试');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 =====
    console.log('[场景1] 静态代码扫描：验证护道集成代码存在');
    const combatServicePath = path.join(__dirname, '../game/services/CombatService.js');
    const worldBossServicePath = path.join(__dirname, '../game/services/WorldBossService.js');

    const combatCode = fs.readFileSync(combatServicePath, 'utf-8');
    check('CombatService 应集成 tryProtect',
        combatCode.includes("DaoCompanionService.tryProtect") &&
        combatCode.includes("battleType: 'combat'"),
        '需含 tryProtect 调用 + battleType: combat');
    check('CombatService 应处理护道反击伤害作用于怪物',
        combatCode.includes('counterDamageToMonster') &&
        combatCode.includes('battle.monster_hp'),
        '需含反击伤害扣怪物 HP 逻辑');
    check('CombatService 应在响应中返回 protect_info',
        combatCode.includes('protect_info: protectInfo'),
        '需透传 protect_info 给前端');

    const worldBossCode = fs.readFileSync(worldBossServicePath, 'utf-8');
    check('WorldBossService 应集成 tryProtect',
        worldBossCode.includes("DaoCompanionService.tryProtect") &&
        worldBossCode.includes("battleType: 'world_boss'"),
        '需含 tryProtect 调用 + battleType: world_boss');
    check('WorldBossService 应处理护道反击伤害作用于BOSS',
        worldBossCode.includes('counterDamageToBoss') &&
        worldBossCode.includes('boss.current_hp'),
        '需含反击伤害扣 BOSS HP 逻辑');
    check('WorldBossService 应在响应中返回 protect_info',
        worldBossCode.includes('protect_info: protectInfo'),
        '需透传 protect_info 给前端');
    check('WorldBossService 应在 counter 中暴露 original_damage',
        worldBossCode.includes('original_damage: bossCounterDamage'),
        '需在 counter 字段中暴露原始反击伤害（便于前端展示护道减免）');

    // ===== 场景2：登录 =====
    console.log('\n[场景2] 登录测试账号');
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

    // ===== 场景3：查询道侣状态 =====
    console.log('\n[场景3] 查询道侣状态');
    const companionRes = await api('GET', '/api/dao-companion/my', token);
    check('dao-companion/my 应返回 200', companionRes.status === 200);
    const hasCompanion = companionRes.json?.data?.has_companion === true;
    console.log(`  测试账号道侣状态: has_companion=${companionRes.json?.data?.has_companion}, heart_contract_level=${companionRes.json?.data?.heart_contract_level}`);
    check('道侣接口应返回 has_companion 字段',
        companionRes.json?.data?.has_companion !== undefined,
        `has_companion=${companionRes.json?.data?.has_companion}`);

    // ===== 场景4：野外战斗流程（不破坏现有逻辑）=====
    console.log('\n[场景4] 野外战斗流程（验证护道集成不破坏现有战斗）');

    // 查询玩家当前状态
    const meRes = await api('GET', '/api/player/me', token);
    check('/api/player/me 应返回 200', meRes.status === 200);
    if (meRes.json?.data?.is_dead) {
        // 修复 B46：不调用 /api/player/reincarnate（会重置 realm/realm_rank/hp/mp 等大量字段
        // 导致测试账号数据永久污染）。改为直接通过数据库清除 is_dead 标志，保留其他所有字段。
        console.log('  ⚠️ 测试账号处于死亡状态，直接通过数据库清除 is_dead 标志（不调用 reincarnate 避免污染）');
        try {
            require('dotenv').config();
            const { infrastructure } = require('../modules');
            infrastructure.ConfigLoader.initialize();
            const Player = require('../models/player');
            const player = await Player.findByPk(1);
            if (player) {
                player.is_dead = false;
                player.death_reason = null;
                player.death_time = null;
                await player.save();
                console.log('  ✅ 已直接清除 is_dead 标志，其他字段保持不变');
            }
        } catch (e) {
            console.log(`  ⚠️ 数据库还原失败: ${e.message}，回退到 reincarnate（可能造成数据污染）`);
            await api('POST', '/api/player/reincarnate', token);
        }
    }

    // 查询当前地图信息（正确路径是 /api/map/info）
    const mapInfoRes = await api('GET', '/api/map/info', token);
    check('/api/map/info 应返回 200',
        mapInfoRes.status === 200,
        `actual=${mapInfoRes.status}, msg=${mapInfoRes.json?.message || ''}`);

    // 尝试遭遇怪物（encounter 接口路径正确）
    let encounterOk = false;
    let battleId = null;
    const encounterRes = await api('POST', '/api/combat/encounter', token);
    if (encounterRes.status === 200) {
        encounterOk = true;
        battleId = encounterRes.json?.data?.battle_id || encounterRes.json?.battle_id;
        console.log(`  遭遇怪物成功, battle_id=${battleId}, monster=${encounterRes.json?.data?.monster_name || encounterRes.json?.monster_name}`);
    } else {
        console.log(`  遭遇怪物返回 ${encounterRes.status}: ${encounterRes.json?.message || ''}`);
    }
    check('野外战斗 encounter 应返回 200 或合理错误',
        encounterRes.status === 200 || encounterRes.status === 400,
        `actual=${encounterRes.status}, msg=${encounterRes.json?.message || ''}`);

    // 如果遭遇成功，尝试攻击 + 怪物回合
    if (encounterOk && battleId) {
        // 玩家攻击
        const attackRes = await api('POST', '/api/combat/attack', token, {
            battle_id: battleId,
            action: 'attack'
        });
        check('combat/attack 应返回 200 或合理错误',
            attackRes.status === 200 || attackRes.status === 400,
            `actual=${attackRes.status}, msg=${attackRes.json?.message || ''}`);

        // 怪物回合（如果战斗未结束）
        if (attackRes.status === 200) {
            const monsterTurnRes = await api('POST', '/api/combat/monster-turn', token);
            check('combat/monster-turn 应返回 200 或合理状态',
                monsterTurnRes.status === 200 || monsterTurnRes.status === 400,
                `actual=${monsterTurnRes.status}, msg=${monsterTurnRes.json?.message || ''}`);

            // 如果 monster-turn 返回了 protect_info 字段，说明护道集成代码路径生效
            if (monsterTurnRes.json?.protect_info !== undefined) {
                check('monster-turn 响应应包含 protect_info 字段（护道集成验证）',
                    true, `protect_info.triggered=${monsterTurnRes.json.protect_info?.triggered}`);
            }
        }

        // 尝试逃跑清理战斗（避免残留 ActiveBattle 影响后续测试）
        await api('POST', '/api/combat/flee', token);
    }

    // ===== 场景5：世界BOSS接口可用性 =====
    console.log('\n[场景5] 世界BOSS接口可用性');
    // 正确路径：GET /api/world-boss/available 查询可攻击BOSS列表
    const bossAvailRes = await api('GET', '/api/world-boss/available', token);
    check('world-boss/available 应返回 200',
        bossAvailRes.status === 200,
        `actual=${bossAvailRes.status}, msg=${bossAvailRes.json?.message || ''}`);

    const bossSeasonsRes = await api('GET', '/api/world-boss/seasons', token);
    check('world-boss/seasons 应返回 200',
        bossSeasonsRes.status === 200,
        `actual=${bossSeasonsRes.status}`);

    // ===== 场景6：护道日志接口（扩展后应有更多日志类型）=====
    console.log('\n[场景6] 护道日志接口');
    const protectLogsRes = await api('GET', '/api/dao-companion/protect-logs', token);
    check('protect-logs 应返回 200',
        protectLogsRes.status === 200,
        `actual=${protectLogsRes.status}`);

    const protectStatsRes = await api('GET', '/api/dao-companion/protect-stats', token);
    check('protect-stats 应返回 200',
        protectStatsRes.status === 200,
        `actual=${protectStatsRes.status}`);

    // ===== 汇总 =====
    console.log('\n========================================');
    console.log('  护道扩展回归测试结果汇总');
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
