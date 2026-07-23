/**
 * 傀儡工坊系统端到端测试脚本
 *
 * 测试场景：
 *   1. 登录获取 token
 *   2. 获取配置（无需鉴权）
 *   3. 查看工坊（需鉴权，初始应为空）
 *   4. 参悟图谱（需鉴权，先通过 InventoryService 添加图谱物品）
 *   5. 制造傀儡（需鉴权，先添加材料）
 *   6. 设置出战（需鉴权）
 *   7. 取消出战（需鉴权）
 *   8. 设置护法（需鉴权）
 *   9. 取消护法（需鉴权）
 *  10. 淬炼升级（需鉴权）
 *  11. 维修耐久（需鉴权，先降低耐久）
 *  12. 回收预览（需鉴权）
 *  13. 确认回收（需鉴权）
 *  14. 未鉴权访问（应返回 401）
 *
 * 用法：node scripts/_test_puppet.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const BASE = 'http://localhost:5000/api';

/**
 * 发起 HTTP 请求
 */
async function request(method, path, data = null, token = null) {
    const url = new URL(BASE + path);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const options = { method, headers };
    if (data && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(data);
    }
    const res = await fetch(url, options);
    const json = await res.json();
    return { status: res.status, body: json };
}

function log(title, obj) {
    console.log(`\n===== ${title} =====`);
    console.log(JSON.stringify(obj, null, 2).slice(0, 800));
}

function assert(condition, message) {
    if (!condition) {
        console.error(`❌ 断言失败: ${message}`);
        process.exitCode = 1;
    } else {
        console.log(`✅ ${message}`);
    }
}

async function main() {
    console.log('========== 傀儡工坊系统端到端测试开始 ==========');

    // ===== 1. 登录 =====
    const loginRes = await request('POST', '/auth/login', {
        username: '1592363624',
        password: '1592363624'
    });
    assert(loginRes.status === 200 && loginRes.body.code === 200, '登录成功');
    const token = loginRes.body.token;
    assert(!!token, '获取到 token');
    const playerId = loginRes.body.player?.id;
    console.log(`玩家ID: ${playerId}, 道号: ${loginRes.body.player?.nickname}`);

    // ===== 2. 获取配置（无需鉴权） =====
    const cfgRes = await request('GET', '/puppet/config');
    log('2. 获取配置', { status: cfgRes.status, enabled: cfgRes.body.data?.enabled });
    assert(cfgRes.status === 200, '配置接口返回 200');
    assert(cfgRes.body.data?.enabled === true, '傀儡工坊已启用');
    const cfg = cfgRes.body.data;
    assert(Object.keys(cfg.puppet_types || {}).length === 5, '5种傀儡类型');
    assert(Object.keys(cfg.blueprints || {}).length === 5, '5种图谱');
    assert(cfg.puppet_types.mechanical_wood?.required_dayan_level === 3, '机关木傀需大衍诀3层');
    assert(cfg.puppet_types.dayan_spirit?.required_dayan_level === 5, '大衍灵傀需大衍诀5层');

    // ===== 3. 查看工坊（初始状态） =====
    const wsRes = await request('GET', '/puppet/workshop', null, token);
    log('3. 查看工坊', { status: wsRes.status, puppet_count: wsRes.body.data?.puppet_count });
    assert(wsRes.status === 200 && wsRes.body.code === 200, '工坊接口返回 200');
    const ws = wsRes.body.data;
    assert(typeof ws.dayan_level === 'number', '返回大衍诀层数');
    assert(Array.isArray(ws.puppets), '返回傀儡列表');
    assert(Array.isArray(ws.blueprints), '返回图谱列表');
    assert(Array.isArray(ws.manufacturable), '返回可制造列表');
    assert(ws.manufacturable.length === 5, '可制造列表5项');

    // 通过 InventoryService 添加测试物品（图谱+材料）
    console.log('\n--- 准备测试物品 ---');
    // 初始化 ConfigLoader + InventoryService（测试脚本独立运行，需手动初始化）
    const { infrastructure } = require('../modules');
    const configLoaderInstance = infrastructure.ConfigLoader;
    await configLoaderInstance.loadAllConfigs();
    const InventoryService = require('../game/services/InventoryService');
    InventoryService.initialize(configLoaderInstance);

    // 设置大衍诀层数为3（控傀），以满足制造机关木傀的前置条件
    const PlayerAscension = require('../models/playerAscension');
    let ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
    if (!ascension) {
        ascension = await PlayerAscension.create({
            player_id: playerId,
            dayan_level: 3,
            ascension_state: 'preparing'
        });
    } else {
        ascension.dayan_level = 3;
        await ascension.save();
    }
    console.log('已设置大衍诀层数为3（控傀）');

    // 清理旧测试数据（确保干净的测试环境）
    const PlayerPuppet = require('../models/playerPuppet');
    const PlayerPuppetBlueprint = require('../models/playerPuppetBlueprint');
    await PlayerPuppet.destroy({ where: { player_id: playerId } });
    await PlayerPuppetBlueprint.destroy({ where: { player_id: playerId } });
    console.log('已清理旧傀儡与图谱数据');

    // 添加机关木傀图谱
    await InventoryService.addItem(playerId, 'mechanical_wood_blueprint', 1);
    // 添加制造材料
    await InventoryService.addItem(playerId, 'mechanism_core', 20);
    await InventoryService.addItem(playerId, 'soul_nurturing_wood', 5);
    console.log('已添加测试物品：机关木傀图谱×1, 机关核心×20, 养魂木×5');

    // ===== 4. 参悟图谱 =====
    const learnRes = await request('POST', '/puppet/blueprint/learn', {
        blueprint_key: 'mechanical_wood_blueprint'
    }, token);
    log('4. 参悟图谱', { status: learnRes.status, code: learnRes.body.code, message: learnRes.body.message });
    assert(learnRes.body.code === 200, '参悟图谱成功');

    // 重复参悟应失败
    const learnRes2 = await request('POST', '/puppet/blueprint/learn', {
        blueprint_key: 'mechanical_wood_blueprint'
    }, token);
    assert(learnRes2.body.code === 400, '重复参悟应失败');

    // ===== 5. 制造傀儡 =====
    const mfgRes = await request('POST', '/puppet/manufacture', {
        puppet_type: 'mechanical_wood'
    }, token);
    log('5. 制造傀儡', { status: mfgRes.status, code: mfgRes.body.code, message: mfgRes.body.message });
    assert(mfgRes.body.code === 200, '制造傀儡成功');
    let puppetId = mfgRes.body.data?.puppet_id;
    assert(!!puppetId, '获取到傀儡ID');
    assert(mfgRes.body.data?.level === 1, '初始等级为1');
    assert(mfgRes.body.data?.atk > 0, '攻击力 > 0');
    console.log(`   制造成功：${mfgRes.body.data.name}，ATK ${mfgRes.body.data.atk}/DEF ${mfgRes.body.data.def}/HP ${mfgRes.body.data.hp}/SPD ${mfgRes.body.data.speed}`);

    // 制造不存在的类型应失败
    const mfgRes2 = await request('POST', '/puppet/manufacture', {
        puppet_type: 'nonexistent_type'
    }, token);
    assert(mfgRes2.body.code === 400, '制造不存在类型应失败');

    // ===== 6. 设置出战 =====
    const battleRes = await request('POST', `/puppet/${puppetId}/battle`, {}, token);
    log('6. 设置出战', { status: battleRes.status, code: battleRes.body.code });
    assert(battleRes.body.code === 200, '设置出战成功');

    // ===== 7. 取消出战 =====
    const unsetRes = await request('POST', `/puppet/${puppetId}/unset`, {}, token);
    log('7. 取消出战', { status: unsetRes.status, code: unsetRes.body.code });
    assert(unsetRes.body.code === 200, '取消出战成功');

    // ===== 8. 设置护法 =====
    const guardRes = await request('POST', `/puppet/${puppetId}/guard`, {}, token);
    log('8. 设置护法', { status: guardRes.status, code: guardRes.body.code });
    assert(guardRes.body.code === 200, '设置护法成功');

    // ===== 9. 取消护法 =====
    const unsetRes2 = await request('POST', `/puppet/${puppetId}/unset`, {}, token);
    assert(unsetRes2.body.code === 200, '取消护法成功');

    // ===== 10. 淬炼升级 =====
    const quenchRes = await request('POST', `/puppet/${puppetId}/quench`, {}, token);
    log('10. 淬炼升级', {
        status: quenchRes.status,
        code: quenchRes.body.code,
        success: quenchRes.body.data?.quench_success,
        level: quenchRes.body.data?.level
    });
    assert(quenchRes.body.code === 200, '淬炼接口返回成功');
    assert(typeof quenchRes.body.data?.quench_success === 'boolean', '返回淬炼结果');
    assert(typeof quenchRes.body.data?.success_rate === 'number', '返回成功率');

    // ===== 11. 维修耐久（需先降低耐久，这里直接调维修接口测试满耐久边界） =====
    const repairRes = await request('POST', `/puppet/${puppetId}/repair`, {}, token);
    log('11. 维修耐久', { status: repairRes.status, code: repairRes.body.code, message: repairRes.body.message });
    // 耐久可能已满（淬炼只降2点），如果满了应返回400
    if (repairRes.body.code === 400) {
        assert(repairRes.body.message.includes('耐久度已满'), '满耐久时维修应提示已满');
        // 手动降低耐久测试维修
        const PlayerPuppet = require('../models/playerPuppet');
        const puppet = await PlayerPuppet.findByPk(puppetId);
        if (puppet) {
            puppet.durability = 50;
            await puppet.save();
            console.log('   手动降低耐久至50');
            const repairRes2 = await request('POST', `/puppet/${puppetId}/repair`, {}, token);
            log('11b. 维修耐久（降耐久后）', { code: repairRes2.body.code, durability: repairRes2.body.data?.durability });
            assert(repairRes2.body.code === 200, '降低耐久后维修成功');
            assert(repairRes2.body.data?.durability === 100, '维修后耐久恢复至100');
        }
    } else {
        assert(repairRes.body.code === 200, '维修成功');
    }

    // ===== 12. 回收预览 =====
    const recPreviewRes = await request('GET', `/puppet/${puppetId}/recycle-preview`, null, token);
    log('12. 回收预览', {
        status: recPreviewRes.status,
        code: recPreviewRes.body.code,
        stone_return: recPreviewRes.body.data?.spirit_stone_return
    });
    assert(recPreviewRes.body.code === 200, '回收预览成功');
    assert(typeof recPreviewRes.body.data?.spirit_stone_return === 'number', '返回灵石返还');
    assert(typeof recPreviewRes.body.data?.material_returns === 'object', '返回材料返还');

    // 回收前需取消出战/护法（已在步骤9取消）
    // 确保傀儡处于闲置状态
    const wsRes2 = await request('GET', '/puppet/workshop', null, token);
    const currentPuppet = wsRes2.body.data?.puppets?.find(p => p.id === puppetId);
    if (currentPuppet && currentPuppet.status !== 'idle') {
        await request('POST', `/puppet/${puppetId}/unset`, {}, token);
    }

    // ===== 13. 确认回收 =====
    const recycleRes = await request('POST', `/puppet/${puppetId}/recycle`, {}, token);
    log('13. 确认回收', { status: recycleRes.status, code: recycleRes.body.code, message: recycleRes.body.message });
    assert(recycleRes.body.code === 200, '回收成功');
    assert(recycleRes.body.data?.spirit_stone_return > 0, '回收返还灵石 > 0');

    // 验证傀儡已被删除
    const wsRes3 = await request('GET', '/puppet/workshop', null, token);
    const puppetStillExists = wsRes3.body.data?.puppets?.some(p => p.id === puppetId);
    assert(!puppetStillExists, '回收后傀儡应不存在');

    // ===== 14. 未鉴权访问 =====
    const noAuthRes = await request('GET', '/puppet/workshop');
    log('14. 未鉴权访问', { status: noAuthRes.status });
    assert(noAuthRes.status === 401, '未鉴权访问返回 401');

    // ===== 15. 操作不存在的傀儡 =====
    const notFoundRes = await request('POST', '/puppet/99999/battle', {}, token);
    assert(notFoundRes.body.code === 400, '操作不存在的傀儡应返回400');

    console.log('\n========== 傀儡工坊系统端到端测试完成 ==========');
    if (process.exitCode === 1) {
        console.log('❌ 存在断言失败');
    } else {
        console.log('✅ 全部断言通过');
    }
}

main().catch(err => {
    console.error('测试执行异常:', err);
    process.exitCode = 1;
});
