/**
 * 掌天瓶线 端到端测试
 *
 * 测试范围：
 *   1. 登录鉴权
 *   2. 参数校验（炼丹模式/丹药白名单）
 *   3. 状态查询（未持有/已持有）
 *   4. 配置完整性校验
 *   5. 凝液流程（绿液获得/冷却/上限）
 *   6. 炼丹流程（稳/变模式/白名单校验/丹药发放）
 *   7. 药园施术（宗门限制/冷却）
 *   8. 星台施术（宗门限制/冷却）
 *   9. 养竹流程（成长度递增/上限）
 *  10. 化竹流程（前置条件/产出/成长度重置）
 *  11. 养木流程（成长度递增/满 100 自动产出）
 *  12. 养树流程（成长度递增/满 100 自动产出）
 *
 * 测试账号：1592363624 / 1592363624
 * 运行方式：node server/scripts/test_sky_bottle.js
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
const PORT = process.env.PORT || 5000;
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerEquipment = require('../models/playerEquipment');
const PlayerSect = require('../models/playerSect');
const Item = require('../models/item');
const { infrastructure } = require('../modules');
const InventoryService = require('../game/services/InventoryService');
const ArtifactDeepLineService = require('../game/services/ArtifactDeepLineService');

const configLoader = infrastructure.ConfigLoader;

let passCount = 0;
let failCount = 0;
const failures = [];

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
 * 直接操作 Item 模型查询数量
 */
async function getItemQty(playerId, itemKey) {
    const record = await Item.findOne({ where: { player_id: playerId, item_key: itemKey } });
    return record ? record.quantity : 0;
}

/**
 * 重置掌天瓶状态（整体赋值确保 Sequelize 检测变更）
 * @param {number} playerId - 玩家ID
 * @param {Object} skyBottleState - 新的 sky_bottle 状态对象
 */
async function resetSkyBottleState(playerId, skyBottleState) {
    const equipment = await PlayerEquipment.findOne({
        where: { player_id: playerId, item_key: 'zhangtian_bottle' }
    });
    if (!equipment) throw new Error('掌天瓶装备记录不存在，无法重置状态');

    const currentState = equipment.deep_line_state || {};
    // 整体赋值顶层对象，确保 Sequelize JSON 字段变更被检测
    equipment.deep_line_state = {
        ...currentState,
        sky_bottle: skyBottleState
    };
    equipment.changed('deep_line_state', true);
    await equipment.save();

    // 验证重置生效
    const verify = await PlayerEquipment.findOne({
        where: { player_id: playerId, item_key: 'zhangtian_bottle' }
    });
    return verify.deep_line_state?.sky_bottle;
}

/**
 * 获取当前掌天瓶状态对象
 */
async function getSkyBottleState(playerId) {
    const equipment = await PlayerEquipment.findOne({
        where: { player_id: playerId, item_key: 'zhangtian_bottle' }
    });
    return equipment?.deep_line_state?.sky_bottle || null;
}

/**
 * 清理背包中非测试必需的物品，腾出容量
 * 注意：InventoryService 容量检查基于 Item.sum('quantity')（总数量，非种类数），上限 100
 */
async function clearInventory(playerId, keepKeys = []) {
    const keepSet = new Set([
        'zhangtian_bottle', 'green_liquid', 'tianlei_bamboo',
        'soul_nurturing_wood', 'spirit_eye_tree',
        'low_healing_pill', 'mid_healing_pill', 'foundation_pill',
        'low_longevity_pill', 'mid_longevity_pill',
        ...keepKeys
    ]);
    const allItems = await Item.findAll({ where: { player_id: playerId } });
    let deleted = 0;
    for (const item of allItems) {
        if (!keepSet.has(item.item_key)) {
            await item.destroy();
            deleted++;
        }
    }
    return deleted;
}

async function main() {
    console.log('\n=========================================');
    console.log('  掌天瓶线 端到端测试');
    console.log('=========================================\n');

    // 初始化 ConfigLoader
    if (!configLoader.isInitialized) {
        await configLoader.initialize();
        InventoryService.initialize(configLoader);
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
        const r1 = await request('GET', '/api/artifact-deep-line/sky-bottle/status');
        assertEqual('未登录 GET status 应返回 401', r1.status, 401);
        const r2 = await request('POST', '/api/artifact-deep-line/sky-bottle/condense', {});
        assertEqual('未登录 POST condense 应返回 401', r2.status, 401);
        const r3 = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { mode: 'stable', pill_key: 'low_healing_pill' });
        assertEqual('未登录 POST alchemy 应返回 401', r3.status, 401);
    }

    // 阶段 3：参数校验
    console.log('\n【阶段 3】参数校验');
    {
        // alchemy 缺少 mode
        const r1 = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { pill_key: 'low_healing_pill' }, token);
        assertEqual('alchemy 缺少 mode 应返回 400', r1.status, 400);
        // alchemy mode 无效
        const r2 = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { mode: 'invalid', pill_key: 'low_healing_pill' }, token);
        assertEqual('alchemy mode 无效应返回 400', r2.status, 400);
        // alchemy 缺少 pill_key
        const r3 = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { mode: 'stable' }, token);
        assertEqual('alchemy 缺少 pill_key 应返回 400', r3.status, 400);
    }

    // 阶段 4：配置完整性校验
    console.log('\n【阶段 4】配置完整性校验');
    {
        const cfg = ArtifactDeepLineService.getSkyBottleConfig();
        assertTrue('掌天瓶配置应存在', cfg);
        assertTrue('enabled 应为 true', cfg.enabled === true);
        assertEqual('item_key 应为 zhangtian_bottle', cfg.item_key, 'zhangtian_bottle');
        assertEqual('item_name 应为 掌天瓶', cfg.item_name, '掌天瓶');
        assertEqual('min_realm_rank 应为 19', cfg.min_realm_rank, 19);
        // 绿液配置
        assertTrue('green_liquid 配置应存在', !!cfg.green_liquid);
        assertEqual('绿液上限应为 1000', cfg.green_liquid?.max, 1000);
        assertEqual('凝液冷却应为 21600 秒(6h)', cfg.green_liquid?.condense?.cooldown_seconds, 21600);
        assertEqual('凝液基础量应为 10', cfg.green_liquid?.condense?.base_amount, 10);
        assertEqual('境界加成应为 2/级', cfg.green_liquid?.condense?.realm_bonus_per_rank, 2);
        // 炼丹配置
        assertTrue('alchemy 配置应存在', !!cfg.alchemy);
        assertEqual('炼丹冷却应为 7200 秒(2h)', cfg.alchemy?.cooldown_seconds, 7200);
        assertEqual('稳定模式绿液消耗 50', cfg.alchemy?.stable?.green_liquid_cost, 50);
        assertEqual('稳定模式成功率 1.0', cfg.alchemy?.stable?.success_rate, 1.0);
        assertEqual('变丹模式绿液消耗 30', cfg.alchemy?.variable?.green_liquid_cost, 30);
        assertEqual('变丹模式成功率 0.6', cfg.alchemy?.variable?.success_rate, 0.6);
        assertEqual('变丹品质加成 0.2', cfg.alchemy?.variable?.quality_bonus_rate, 0.2);
        assertTrue('supported_pills 应包含 5 种丹药', (cfg.alchemy?.supported_pills || []).length >= 5);
        // 药园配置
        assertTrue('garden 配置应存在', !!cfg.garden);
        assertEqual('药园需 huangfeng 宗门', cfg.garden?.required_sect, 'huangfeng');
        assertEqual('药园冷却 43200 秒(12h)', cfg.garden?.cooldown_seconds, 43200);
        // 星台配置
        assertTrue('star_platform 配置应存在', !!cfg.star_platform);
        assertEqual('星台需 xinggong 宗门', cfg.star_platform?.required_sect, 'xinggong');
        assertEqual('星台冷却 43200 秒(12h)', cfg.star_platform?.cooldown_seconds, 43200);
        // 养竹/化竹配置
        assertTrue('bamboo 配置应存在', !!cfg.bamboo);
        assertEqual('养竹冷却 14400 秒(4h)', cfg.bamboo?.nurture?.cooldown_seconds, 14400);
        assertEqual('养竹成长 +10/次', cfg.bamboo?.nurture?.growth_per_action, 10);
        assertEqual('养竹上限 100', cfg.bamboo?.nurture?.max_growth, 100);
        assertEqual('化竹需成长度 100', cfg.bamboo?.transform?.min_growth_required, 100);
        assertEqual('化竹产出 tianlei_bamboo', cfg.bamboo?.transform?.output_key, 'tianlei_bamboo');
        // 养木配置
        assertTrue('soul_wood 配置应存在', !!cfg.soul_wood);
        assertEqual('养木冷却 86400 秒(24h)', cfg.soul_wood?.cooldown_seconds, 86400);
        assertEqual('养木成长 +5/次', cfg.soul_wood?.growth_per_action, 5);
        assertEqual('养木产出 soul_nurturing_wood', cfg.soul_wood?.output_key, 'soul_nurturing_wood');
        // 养树配置
        assertTrue('spirit_tree 配置应存在', !!cfg.spirit_tree);
        assertEqual('养树冷却 172800 秒(48h)', cfg.spirit_tree?.cooldown_seconds, 172800);
        assertEqual('养树成长 +3/次', cfg.spirit_tree?.growth_per_action, 3);
        assertEqual('养树产出 spirit_eye_tree', cfg.spirit_tree?.output_key, 'spirit_eye_tree');
    }

    // 阶段 5：状态查询（未持有掌天瓶时）
    console.log('\n【阶段 5】状态查询（未持有）');
    const playerId = 1;
    {
        // 先删除可能存在的旧装备记录，确保测试从"未持有"状态开始
        const oldEquip = await PlayerEquipment.findOne({ where: { player_id: playerId, item_key: 'zhangtian_bottle' } });
        if (oldEquip) {
            await oldEquip.destroy();
            console.log('  ℹ 清理旧掌天瓶装备记录');
        }

        const r = await request('GET', '/api/artifact-deep-line/sky-bottle/status', null, token);
        assertEqual('status 应返回 200', r.status, 200);
        assertTrue('应返回 data 对象', !!r.body?.data);
        assertFalse('has_sky_bottle 应为 false', r.body?.data?.has_sky_bottle);
        assertTrue('应返回配置摘要', !!r.body?.data?.config);
    }

    // 阶段 6：装备掌天瓶
    console.log('\n【阶段 6】装备掌天瓶');
    {
        // 删除可能存在的旧掌天瓶装备记录
        const oldEquip = await PlayerEquipment.findOne({ where: { player_id: playerId, item_key: 'zhangtian_bottle' } });
        if (oldEquip) {
            await oldEquip.destroy();
            console.log('  ℹ 清理旧掌天瓶装备记录');
        }

        // dharma 槽位可能已被其他法器（如虚天鼎）占用，需先处理
        const existingDharma = await PlayerEquipment.findOne({ where: { player_id: playerId, slot: 'dharma' } });
        if (existingDharma) {
            // 将原 dharma 槽位物品替换为掌天瓶（保留 deep_line_state 为空，不继承旧物品状态）
            console.log(`  ℹ dharma 槽位已占用（${existingDharma.item_key}），替换为掌天瓶`);
            existingDharma.item_key = 'zhangtian_bottle';
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
                item_key: 'zhangtian_bottle',
                durability: 100,
                max_durability: 100,
                refine_level: 0,
                is_benming: false,
                is_summoned: false,
                deep_line_state: {}
            });
        }
        pass('掌天瓶装备记录已就绪');

        // 确保玩家未死亡
        const player = await Player.findByPk(playerId);
        if (player.is_dead) {
            await player.update({ is_dead: false, hp_current: 10000 });
            console.log('  ℹ 玩家已复活');
        }
        pass('玩家状态正常');
    }

    // 阶段 7：状态查询（已持有掌天瓶）
    console.log('\n【阶段 7】状态查询（已持有）');
    {
        const r = await request('GET', '/api/artifact-deep-line/sky-bottle/status', null, token);
        assertEqual('status 应返回 200', r.status, 200);
        assertTrue('has_sky_bottle 应为 true', r.body?.data?.has_sky_bottle);
        assertEqual('green_liquid 初始应为 0', r.body?.data?.green_liquid, 0);
        assertEqual('green_liquid_max 应为 1000', r.body?.data?.green_liquid_max, 1000);
        assertTrue('应返回 condense_cooldown_remaining', r.body?.data?.condense_cooldown_remaining !== undefined);
        assertTrue('应返回 bamboo_growth', r.body?.data?.bamboo_growth !== undefined);
        assertTrue('应返回 soul_wood_growth', r.body?.data?.soul_wood_growth !== undefined);
        assertTrue('应返回 spirit_tree_growth', r.body?.data?.spirit_tree_growth !== undefined);
    }

    // 阶段 8：凝液流程
    console.log('\n【阶段 8】凝液流程');
    {
        // 重置状态：green_liquid=0，无冷却
        await resetSkyBottleState(playerId, {
            green_liquid: 0,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/condense', {}, token);
        assertEqual('凝液应返回 200', r.status, 200);
        assertTrue('凝液应成功', r.body?.success === true);
        if (r.body?.success) {
            // 基础10 + 境界加成（化神 rank 19，加成 = 2 * (19-18) = 2，合计 12）
            assertTrue('绿液应增加', r.body.data?.gain > 0);
            console.log(`     凝液获得: ${r.body.data?.gain} (基础${r.body.data?.base_amount}+境界${r.body.data?.realm_bonus}), 当前: ${r.body.data?.green_liquid}/${r.body.data?.green_liquid_max}`);
        }

        // 冷却校验
        const r2 = await request('POST', '/api/artifact-deep-line/sky-bottle/condense', {}, token);
        assertEqual('冷却中凝液应返回 200', r2.status, 200);
        assertFalse('冷却中凝液应失败', r2.body?.success);
        if (!r2.body?.success) {
            assertTrue('应提示冷却中', (r2.body?.message || '').includes('冷却'));
            console.log(`     冷却提示: ${r2.body?.message}`);
        }
    }

    // 阶段 9：炼丹流程（稳定模式）
    console.log('\n【阶段 9】炼丹流程（稳定模式）');
    {
        // 重置状态：green_liquid=100，无冷却
        await resetSkyBottleState(playerId, {
            green_liquid: 100,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        // 清理背包
        await clearInventory(playerId);

        const beforeQty = await getItemQty(playerId, 'low_healing_pill');
        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { mode: 'stable', pill_key: 'low_healing_pill' }, token);
        assertEqual('稳定炼丹应返回 200', r.status, 200);
        assertTrue('稳定炼丹应成功（100%成功率）', r.body?.success === true);
        if (r.body?.success) {
            assertEqual('消耗绿液应为 50', r.body.data?.consumed?.green_liquid, 50);
            assertEqual('绿液剩余应为 50', r.body.data?.green_liquid_remaining, 50);
            const afterQty = await getItemQty(playerId, 'low_healing_pill');
            assertEqual('背包回春丹应 +1', afterQty - beforeQty, 1);
            console.log(`     稳定炼丹成功，产出回春丹×1，绿液剩余: ${r.body.data?.green_liquid_remaining}`);
        }

        // 冷却校验
        const r2 = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { mode: 'stable', pill_key: 'low_healing_pill' }, token);
        assertFalse('冷却中炼丹应失败', r2.body?.success);
        assertTrue('应提示冷却中', (r2.body?.message || '').includes('冷却'));
    }

    // 阶段 10：炼丹流程（变丹模式 + 白名单校验）
    console.log('\n【阶段 10】炼丹流程（变丹模式 + 白名单）');
    {
        // 重置冷却，保留绿液
        await resetSkyBottleState(playerId, {
            green_liquid: 200,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        // 白名单校验：不支持炼制的丹药
        const r0 = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { mode: 'stable', pill_key: 'invalid_pill' }, token);
        assertEqual('白名单外丹药应返回 200', r0.status, 200);
        assertFalse('白名单外丹药应失败', r0.body?.success);
        assertTrue('应提示不支持炼制', (r0.body?.message || '').includes('不支持'));

        // 变丹模式：60% 成功率，多次尝试直到成功
        let successCount = 0;
        let bonusCount = 0;
        let attemptCount = 0;
        const maxAttempts = 20;
        while (attemptCount < maxAttempts) {
            // 每次重置冷却 + 补充绿液
            const state = await getSkyBottleState(playerId);
            if (state.green_liquid < 30) {
                await resetSkyBottleState(playerId, {
                    ...state,
                    green_liquid: 200,
                    last_alchemy_at: null
                });
            } else {
                await resetSkyBottleState(playerId, {
                    ...state,
                    last_alchemy_at: null
                });
            }

            const r = await request('POST', '/api/artifact-deep-line/sky-bottle/alchemy', { mode: 'variable', pill_key: 'mid_healing_pill' }, token);
            if (r.body?.success) {
                successCount++;
                if (r.body.data?.is_bonus) {
                    bonusCount++;
                    console.log(`     变丹成功（机缘加成！产出×${r.body.data?.pill_qty}）`);
                }
            }
            attemptCount++;
            // 至少尝试 10 次，收集足够样本
            if (attemptCount >= 10 && successCount >= 1) break;
        }
        assertTrue(`变丹模式应至少成功 1 次（共尝试 ${attemptCount} 次）`, successCount >= 1);
        console.log(`     变丹统计: 成功 ${successCount}/${attemptCount}, 机缘 ${bonusCount} 次`);
    }

    // 阶段 11：药园施术（需黄枫谷宗门）
    console.log('\n【阶段 11】药园施术（宗门限制）');
    {
        // 重置状态
        await resetSkyBottleState(playerId, {
            green_liquid: 500,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        // 先测试非黄枫谷宗门的情况
        let playerSect = await PlayerSect.findOne({ where: { player_id: playerId } });
        const originalSectId = playerSect?.sect_id || null;
        if (playerSect && playerSect.sect_id !== 'huangfeng') {
            const r = await request('POST', '/api/artifact-deep-line/sky-bottle/garden', {}, token);
            // 非黄枫谷应失败（抛 AppError）
            assertFalse('非黄枫谷药园施术应失败', r.body?.success);
            assertTrue('应提示需加入黄枫谷', (r.body?.message || '').includes('黄枫谷'));
        } else if (!playerSect) {
            // 未加入宗门也应失败
            const r = await request('POST', '/api/artifact-deep-line/sky-bottle/garden', {}, token);
            assertFalse('未加入宗门药园施术应失败', r.body?.success);
            assertTrue('应提示需加入黄枫谷', (r.body?.message || '').includes('黄枫谷'));
        }

        // 临时设置玩家宗门为黄枫谷
        if (playerSect) {
            await playerSect.update({ sect_id: 'huangfeng' });
        } else {
            await PlayerSect.create({
                player_id: playerId,
                sect_id: 'huangfeng',
                contribution: 0,
                role: 'disciple',
                joined_at: new Date()
            });
        }

        const r2 = await request('POST', '/api/artifact-deep-line/sky-bottle/garden', {}, token);
        assertEqual('黄枫谷药园施术应返回 200', r2.status, 200);
        assertTrue('黄枫谷药园施术应成功', r2.body?.success === true);
        if (r2.body?.success) {
            assertEqual('消耗绿液应为 80', r2.body.data?.consumed?.green_liquid, 80);
            console.log(`     药园施术成功: ${r2.body.message}`);
        }

        // 恢复原始宗门
        if (originalSectId) {
            await PlayerSect.update({ sect_id: originalSectId }, { where: { player_id: playerId } });
        }
    }

    // 阶段 12：星台施术（需星宫宗门）
    console.log('\n【阶段 12】星台施术（宗门限制）');
    {
        // 重置状态
        await resetSkyBottleState(playerId, {
            green_liquid: 500,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        // 临时设置玩家宗门为星宫
        const playerSect = await PlayerSect.findOne({ where: { player_id: playerId } });
        const originalSectId = playerSect?.sect_id || null;
        if (playerSect) {
            await playerSect.update({ sect_id: 'xinggong' });
        }

        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/star-platform', {}, token);
        assertEqual('星宫星台施术应返回 200', r.status, 200);
        assertTrue('星宫星台施术应成功', r.body?.success === true);
        if (r.body?.success) {
            assertEqual('消耗绿液应为 100', r.body.data?.consumed?.green_liquid, 100);
            console.log(`     星台施术成功: ${r.body.message}`);
        }

        // 恢复原始宗门
        if (originalSectId) {
            await PlayerSect.update({ sect_id: originalSectId }, { where: { player_id: playerId } });
        }
    }

    // 阶段 13：养竹流程
    console.log('\n【阶段 13】养竹流程');
    {
        // 重置状态：green_liquid=500，bamboo_growth=0
        await resetSkyBottleState(playerId, {
            green_liquid: 500,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/nurture-bamboo', {}, token);
        assertEqual('养竹应返回 200', r.status, 200);
        assertTrue('养竹应成功', r.body?.success === true);
        if (r.body?.success) {
            assertEqual('成长度应 0→10', r.body.data?.bamboo_growth, 10);
            assertEqual('消耗绿液应为 40', r.body.data?.consumed?.green_liquid, 40);
            console.log(`     养竹成功: ${r.body.message}`);
        }

        // 冷却校验
        const r2 = await request('POST', '/api/artifact-deep-line/sky-bottle/nurture-bamboo', {}, token);
        assertFalse('冷却中养竹应失败', r2.body?.success);
        assertTrue('应提示冷却中', (r2.body?.message || '').includes('冷却'));
    }

    // 阶段 14：化竹流程
    console.log('\n【阶段 14】化竹流程');
    {
        // 设置 bamboo_growth=90，养竹一次到 100，然后化竹
        await resetSkyBottleState(playerId, {
            green_liquid: 500,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 90,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        // 养竹一次到 100
        const r1 = await request('POST', '/api/artifact-deep-line/sky-bottle/nurture-bamboo', {}, token);
        assertTrue('养竹 90→100 应成功', r1.body?.success === true);
        assertEqual('成长度应为 100', r1.body?.data?.bamboo_growth, 100);

        // 化竹
        await clearInventory(playerId, ['tianlei_bamboo']);
        const beforeQty = await getItemQty(playerId, 'tianlei_bamboo');
        const r2 = await request('POST', '/api/artifact-deep-line/sky-bottle/transform-bamboo', {}, token);
        assertEqual('化竹应返回 200', r2.status, 200);
        assertTrue('化竹应成功', r2.body?.success === true);
        if (r2.body?.success) {
            assertEqual('消耗绿液应为 60', r2.body.data?.consumed?.green_liquid, 60);
            const afterQty = await getItemQty(playerId, 'tianlei_bamboo');
            assertEqual('背包天雷竹应 +1', afterQty - beforeQty, 1);
            console.log(`     化竹成功: ${r2.body.message}`);
        }

        // 成长度不足时化竹应失败
        await resetSkyBottleState(playerId, {
            green_liquid: 500,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 50,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });
        const r3 = await request('POST', '/api/artifact-deep-line/sky-bottle/transform-bamboo', {}, token);
        assertFalse('成长度不足化竹应失败', r3.body?.success);
        assertTrue('应提示成长度不足', (r3.body?.message || '').includes('成长度不足'));
    }

    // 阶段 15：养木流程（满 100 自动产出）
    console.log('\n【阶段 15】养木流程（自动产出）');
    {
        // 设置 soul_wood_growth=95，养木一次到 100 自动产出
        await resetSkyBottleState(playerId, {
            green_liquid: 500,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 95,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        await clearInventory(playerId, ['soul_nurturing_wood']);
        const beforeQty = await getItemQty(playerId, 'soul_nurturing_wood');
        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/nurture-wood', {}, token);
        assertEqual('养木应返回 200', r.status, 200);
        assertTrue('养木应成功', r.body?.success === true);
        if (r.body?.success) {
            assertEqual('消耗绿液应为 200', r.body.data?.consumed?.green_liquid, 200);
            // 成长 95→100，自动产出，成长度归零
            assertTrue('应自动产出万年养魂木', r.body.data?.output_qty >= 1);
            assertEqual('成长度应归零', r.body.data?.soul_wood_growth, 0);
            const afterQty = await getItemQty(playerId, 'soul_nurturing_wood');
            assertEqual('背包万年养魂木应 +1', afterQty - beforeQty, 1);
            console.log(`     养木成功: ${r.body.message}`);
        }
    }

    // 阶段 16：养树流程（满 100 自动产出）
    console.log('\n【阶段 16】养树流程（自动产出）');
    {
        // 设置 spirit_tree_growth=97，养树一次到 100 自动产出
        await resetSkyBottleState(playerId, {
            green_liquid: 1000,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 97,
            last_nurture_tree_at: null
        });

        await clearInventory(playerId, ['spirit_eye_tree']);
        const beforeQty = await getItemQty(playerId, 'spirit_eye_tree');
        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/nurture-tree', {}, token);
        assertEqual('养树应返回 200', r.status, 200);
        assertTrue('养树应成功', r.body?.success === true);
        if (r.body?.success) {
            assertEqual('消耗绿液应为 500', r.body.data?.consumed?.green_liquid, 500);
            assertTrue('应自动产出灵眼之树', r.body.data?.output_qty >= 1);
            assertEqual('成长度应归零', r.body.data?.spirit_tree_growth, 0);
            const afterQty = await getItemQty(playerId, 'spirit_eye_tree');
            assertEqual('背包灵眼之树应 +1', afterQty - beforeQty, 1);
            console.log(`     养树成功: ${r.body.message}`);
        }
    }

    // 阶段 17：绿液不足校验
    console.log('\n【阶段 17】绿液不足校验');
    {
        // 设置 green_liquid=10（不足以养树消耗 500）
        await resetSkyBottleState(playerId, {
            green_liquid: 10,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/nurture-tree', {}, token);
        assertFalse('绿液不足养树应失败', r.body?.success);
        assertTrue('应提示绿液不足', (r.body?.message || '').includes('绿液不足'));
        console.log(`     绿液不足提示: ${r.body?.message}`);
    }

    // 阶段 18：死亡状态校验
    console.log('\n【阶段 18】死亡状态校验');
    {
        // 临时设置玩家为死亡状态
        const player = await Player.findByPk(playerId);
        const originalIsDead = player.is_dead;
        await player.update({ is_dead: true });

        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/condense', {}, token);
        // 死亡时应抛出 AppError（400）
        assertTrue('死亡状态操作应返回错误', r.status >= 400 || r.body?.success === false);

        // 恢复
        await player.update({ is_dead: originalIsDead });
        pass('死亡状态校验完成');
    }

    // 阶段 19：凝液上限校验
    console.log('\n【阶段 19】凝液上限校验');
    {
        // 设置 green_liquid=999（接近上限 1000）
        await resetSkyBottleState(playerId, {
            green_liquid: 999,
            last_condense_at: null,
            last_alchemy_at: null,
            last_garden_at: null,
            last_star_platform_at: null,
            bamboo_growth: 0,
            last_nurture_bamboo_at: null,
            last_transform_bamboo_at: null,
            soul_wood_growth: 0,
            last_nurture_wood_at: null,
            spirit_tree_growth: 0,
            last_nurture_tree_at: null
        });

        const r = await request('POST', '/api/artifact-deep-line/sky-bottle/condense', {}, token);
        assertTrue('凝液应成功', r.body?.success === true);
        if (r.body?.success) {
            // 999 + 12 = 1011，但上限 1000，所以实际获得 1
            assertTrue('绿液不应超过上限 1000', r.body.data?.green_liquid <= 1000);
            console.log(`     凝液上限校验: 999 + ${r.body.data?.gain} → ${r.body.data?.green_liquid}/1000`);
        }
    }

    // ========== 测试总结 ==========
    console.log('\n=========================================');
    console.log(`  测试完成: ✅ ${passCount} 通过, ❌ ${failCount} 失败`);
    console.log('=========================================\n');
    if (failures.length > 0) {
        console.log('失败用例详情:');
        failures.forEach((f, i) => {
            console.log(`  ${i + 1}. ${f.name}`);
            if (f.expected !== undefined) console.log(`     期望: ${JSON.stringify(f.expected)}`);
            if (f.actual !== undefined) console.log(`     实际: ${JSON.stringify(f.actual)}`);
        });
    }

    // 清理：恢复玩家宗门（如果测试中修改了）
    const playerSect = await PlayerSect.findOne({ where: { player_id: playerId } });
    if (playerSect) {
        console.log(`\n  ℹ 玩家当前宗门: ${playerSect.sect_id}（测试中可能被修改，请按需恢复）`);
    }

    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('\n❌ 测试脚本异常:', err);
    console.error(err.stack);
    process.exit(1);
});
