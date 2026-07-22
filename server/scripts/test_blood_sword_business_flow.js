/**
 * 法宝深线血魔剑线完整业务流程测试脚本
 *
 * 测试场景（在测试账号下完整走一遍业务流程）：
 *   1. 登录测试账号（1592363624）
 *   2. 通过 GM 接口发放血魔剑 + 各阶段材料 + 镇契材料 + 天雷竹 + 金雷竹
 *   3. 穿戴血魔剑
 *   4. 查询状态：验证 has_blood_sword=true、字段完整
 *   5. 祭血推进 1 阶血契：验证 stage 0→1、corruption 增加
 *   6. 镇契：验证 corruption 下降、suppression 上升
 *   7. 铭印（blood）：验证 imprint_type=blood
 *   8. 祭血冷却测试：再次祭血应被拒绝（18h 冷却）
 *   9. 雷洗冷却测试：先雷洗一次成功，再雷洗应被拒绝（24h 冷却）
 *  10. 铭印冷却测试：切换铭印应被拒绝（7d 冷却）
 *  11. 封鞘：验证 sheath_until 设置、is_sheathed=true
 *  12. 封鞘期间操作被拒绝：祭血/镇契/雷洗/铭印均不可用
 *  13. 清理：卸下血魔剑（避免影响其他测试）
 *
 * 注意：本测试会真实修改玩家数据，仅在测试环境运行
 *
 * 使用方式：
 *   node server/scripts/test_blood_sword_business_flow.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const http = require('http');

const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';
const BASE_URL = 'http://127.0.0.1:5000';
const PLAYER_ID = 1;  // 测试账号的 player_id

// 测试结果统计
let passCount = 0;
let failCount = 0;
const failedCases = [];

/**
 * 发起 HTTP 请求
 */
function request(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const payload = body ? JSON.stringify(body) : null;
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        const req = http.request(
            `${BASE_URL}${path}`,
            { method, headers },
            (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = { raw: data }; }
                    resolve({ status: res.statusCode, body: parsed });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function assertEqual(caseName, actual, expected) {
    const ok = actual === expected;
    if (ok) {
        passCount += 1;
        console.log(`  ✓ ${caseName}`);
    } else {
        failCount += 1;
        failedCases.push({ case: caseName, actual, expected });
        console.log(`  ✗ ${caseName}  期望=${JSON.stringify(expected)}  实际=${JSON.stringify(actual)}`);
    }
}

function assertTrue(caseName, condition, detail = '') {
    if (condition) {
        passCount += 1;
        console.log(`  ✓ ${caseName}`);
    } else {
        failCount += 1;
        failedCases.push({ case: caseName, detail });
        console.log(`  ✗ ${caseName}  ${detail}`);
    }
}

/**
 * 通过 GM 接口发放物品（测试账号本身就是 admin）
 */
async function giveItem(token, itemId, quantity = 1) {
    return await request('POST', '/api/admin/give-item',
        { playerId: PLAYER_ID, itemId, quantity }, token);
}

/**
 * 主流程
 */
async function main() {
    console.log('='.repeat(60));
    console.log('法宝深线血魔剑线完整业务流程测试');
    console.log('='.repeat(60));

    // 步骤 1：登录
    console.log('\n[步骤 1] 登录');
    const loginRes = await request('POST', '/api/auth/login', {
        username: TEST_ACCOUNT, password: TEST_PASSWORD
    });
    assertEqual('登录返回 200', loginRes.status, 200);
    const token = loginRes.body?.body?.token || loginRes.body?.token;
    if (!token) {
        console.log('❌ 无法获取 token，终止测试');
        process.exit(1);
    }

    // 步骤 2：先合并重复物品记录（修复历史 give-item 创建的重复记录），再清空储物袋空间
    console.log('\n[步骤 2-pre] 合并重复物品记录（修复历史数据）');
    const mergeRes = await request('POST', '/api/admin/merge-duplicate-items',
        { playerId: PLAYER_ID }, token);
    assertTrue('合并重复物品记录成功', mergeRes.status === 200,
        `mergeRes=${JSON.stringify(mergeRes.body).slice(0, 200)}`);
    if (mergeRes.status === 200) {
        console.log(`  ℹ ${mergeRes.body?.message}`);
        console.log(`  ℹ 合并后总数量：${mergeRes.body?.data?.total_quantity_after}`);
    }

    // 步骤 2a：丢弃大量材料腾出空间
    console.log('\n[步骤 2a] 查询当前储物袋，激进丢弃材料腾出空间');
    const invRes = await request('GET', '/api/inventory', null, token);
    const invData = invRes.body?.data || invRes.body;
    const invItems = invData?.items || [];
    console.log(`  ℹ 当前储物袋 ${invItems.length} 种物品`);

    // 激进丢弃：所有 type='material' 的物品，每种只保留 1 个，其余全部丢弃
    // 同时丢弃所有 type='consumable' 的物品（保留 1 个）
    // 这样可以腾出大量空间用于发放血魔剑+材料
    let totalDiscarded = 0;
    for (const it of invItems) {
        if ((it.type === 'material' || it.type === 'consumable') && it.quantity > 1) {
            const discardQty = it.quantity - 1;  // 保留 1 个
            if (discardQty > 0) {
                const dr = await request('POST', '/api/inventory/discard',
                    { item_key: it.item_key, quantity: discardQty }, token);
                if (dr.status === 200) totalDiscarded += discardQty;
            }
        }
    }
    console.log(`  ℹ 已丢弃总数：${totalDiscarded}`);

    // 步骤 2b：GM 发放血魔剑 + 测试所需材料（每种只需少量）
    console.log('\n[步骤 2b] GM 发放血魔剑 + 测试所需材料');
    const giveResults = await Promise.all([
        giveItem(token, 'blood_magic_sword', 1),     // 血魔剑本体
        giveItem(token, 'xuejian_tiesui', 3),         // 血剑铁髓（1 阶祭血需 2 个，留点余量）
        giveItem(token, 'duanhong_ling', 5),          // 断红翎（1 阶祭血需 3 个）
        giveItem(token, 'tianlei_zhu', 3),            // 天雷竹（1 阶祭血需 1 个 + 1 次雷洗）
        giveItem(token, 'sunv_jinwen', 2),            // 素女禁纹（镇契 1 次）
        giveItem(token, 'yanyue_jingsha', 2),         // 掩月镜砂（镇契 1 次）
        giveItem(token, 'jinlei_zhu', 1)              // 金雷竹（备用，不一定会用到）
    ]);
    let giveSuccessCount = 0;
    for (let i = 0; i < giveResults.length; i++) {
        if (giveResults[i].status === 200) giveSuccessCount += 1;
    }
    assertTrue(`GM 发放物品成功 ${giveSuccessCount}/${giveResults.length} 批`,
        giveSuccessCount === giveResults.length,
        `失败详情: ${JSON.stringify(giveResults.filter(r => r.status !== 200).map(r => r.body)).slice(0, 300)}`);

    // 步骤 3：穿戴血魔剑
    console.log('\n[步骤 3] 穿戴血魔剑');
    const equipRes = await request('POST', '/api/equipment/equip',
        { item_key: 'blood_magic_sword' }, token);
    assertTrue('穿戴血魔剑成功', equipRes.status === 200 || equipRes.body?.code === 200,
        `equipRes=${JSON.stringify(equipRes.body).slice(0, 200)}`);
    // 如果血魔剑已经在 weapon 槽，需要先卸下其他武器
    if (equipRes.status !== 200 && equipRes.body?.message?.includes('已装备')) {
        console.log('  ℹ weapon 槽已有装备，先卸下旧装备');
        await request('POST', '/api/equipment/unequip', { slot: 'weapon' }, token);
        const retryEquip = await request('POST', '/api/equipment/equip',
            { item_key: 'blood_magic_sword' }, token);
        assertTrue('重试穿戴血魔剑成功', retryEquip.status === 200,
            `retryEquip=${JSON.stringify(retryEquip.body).slice(0, 200)}`);
    }

    // 步骤 4：查询状态
    console.log('\n[步骤 4] 查询血魔剑状态（应已持有）');
    const statusRes = await request('GET', '/api/artifact-deep-line/blood-sword/status', null, token);
    assertEqual('状态查询返回 200', statusRes.status, 200);
    assertEqual('has_blood_sword=true', statusRes.body?.data?.has_blood_sword, true);
    const st = statusRes.body?.data;
    if (st) {
        assertTrue('初始 blood_pact_stage=0', st.blood_pact_stage === 0, `stage=${st.blood_pact_stage}`);
        assertTrue('初始 corruption=0', st.corruption === 0, `corruption=${st.corruption}`);
        assertTrue('初始 suppression=0', st.suppression === 0, `suppression=${st.suppression}`);
        assertTrue('初始 imprint_type=none', st.imprint_type === 'none', `imprint=${st.imprint_type}`);
        assertTrue('初始 is_sheathed=false', st.is_sheathed === false, `is_sheathed=${st.is_sheathed}`);
    }

    // 步骤 5：祭血推进 1 阶
    console.log('\n[步骤 5] 祭血推进 1 阶血契');
    const sacRes = await request('POST', '/api/artifact-deep-line/blood-sword/sacrifice', {}, token);
    assertEqual('祭血返回 200', sacRes.status, 200);
    assertTrue('祭血成功 success=true', sacRes.body?.success === true, `body=${JSON.stringify(sacRes.body).slice(0, 200)}`);
    assertTrue('祭血后 blood_pact_stage=1', sacRes.body?.blood_pact_stage === 1, `stage=${sacRes.body?.blood_pact_stage}`);
    assertTrue('祭血后 corruption > 0', (sacRes.body?.corruption || 0) > 0, `corruption=${sacRes.body?.corruption}`);

    // 步骤 6：镇契
    console.log('\n[步骤 6] 镇契降低魔染');
    const supRes = await request('POST', '/api/artifact-deep-line/blood-sword/suppress', {}, token);
    assertEqual('镇契返回 200', supRes.status, 200);
    assertTrue('镇契成功 success=true', supRes.body?.success === true, `body=${JSON.stringify(supRes.body).slice(0, 200)}`);
    assertTrue('镇契后 corruption 下降', (supRes.body?.corruption || 0) < (sacRes.body?.corruption || 0),
        `祭血后=${sacRes.body?.corruption}, 镇契后=${supRes.body?.corruption}`);
    assertTrue('镇契后 suppression 上升', (supRes.body?.suppression || 0) > 0,
        `suppression=${supRes.body?.suppression}`);

    // 步骤 7：铭印（血契路线）
    console.log('\n[步骤 7] 铭印·血契路线');
    const impRes = await request('POST', '/api/artifact-deep-line/blood-sword/imprint',
        { imprint_type: 'blood' }, token);
    assertEqual('铭印返回 200', impRes.status, 200);
    assertTrue('铭印成功 imprint_type=blood', impRes.body?.imprint_type === 'blood',
        `imprint_type=${impRes.body?.imprint_type}`);

    // 步骤 8：祭血冷却测试
    console.log('\n[步骤 8] 祭血冷却测试（应被拒绝）');
    const sacAgainRes = await request('POST', '/api/artifact-deep-line/blood-sword/sacrifice', {}, token);
    assertEqual('冷却中祭血返回 400', sacAgainRes.status, 400);
    assertTrue('冷却拒绝包含冷却提示',
        (sacAgainRes.body?.message || '').includes('冷却') || (sacAgainRes.body?.message || '').includes('cool'),
        `message=${sacAgainRes.body?.message}`);

    // 步骤 9：雷洗 + 雷洗冷却测试
    console.log('\n[步骤 9] 雷洗（天雷竹）');
    const twRes = await request('POST', '/api/artifact-deep-line/blood-sword/thunder-wash',
        { material_type: 'tianlei' }, token);
    assertEqual('雷洗返回 200', twRes.status, 200);
    assertTrue('雷洗成功 success=true', twRes.body?.success === true, `body=${JSON.stringify(twRes.body).slice(0, 200)}`);

    console.log('\n[步骤 9a] 雷洗冷却测试（应被拒绝）');
    const twAgainRes = await request('POST', '/api/artifact-deep-line/blood-sword/thunder-wash',
        { material_type: 'tianlei' }, token);
    assertEqual('冷却中雷洗返回 400', twAgainRes.status, 400);

    // 步骤 10：铭印冷却测试
    console.log('\n[步骤 10] 铭印冷却测试（应被拒绝）');
    const impAgainRes = await request('POST', '/api/artifact-deep-line/blood-sword/imprint',
        { imprint_type: 'suppress' }, token);
    assertEqual('冷却中铭印返回 400', impAgainRes.status, 400);

    // 步骤 11：封鞘
    console.log('\n[步骤 11] 封鞘 24 小时');
    const shRes = await request('POST', '/api/artifact-deep-line/blood-sword/sheath', {}, token);
    assertEqual('封鞘返回 200', shRes.status, 200);
    assertTrue('封鞘成功 sheath_until 已设置', !!shRes.body?.sheath_until,
        `sheath_until=${shRes.body?.sheath_until}`);

    // 步骤 12：封鞘期间操作被拒绝
    console.log('\n[步骤 12] 封鞘期间各操作应被拒绝');
    const shSacRes = await request('POST', '/api/artifact-deep-line/blood-sword/sacrifice', {}, token);
    assertEqual('封鞘期间祭血被拒绝（400）', shSacRes.status, 400);

    const shSupRes = await request('POST', '/api/artifact-deep-line/blood-sword/suppress', {}, token);
    assertEqual('封鞘期间镇契被拒绝（400）', shSupRes.status, 400);

    const shTwRes = await request('POST', '/api/artifact-deep-line/blood-sword/thunder-wash',
        { material_type: 'tianlei' }, token);
    assertEqual('封鞘期间雷洗被拒绝（400）', shTwRes.status, 400);

    const shImpRes = await request('POST', '/api/artifact-deep-line/blood-sword/imprint',
        { imprint_type: 'suppress' }, token);
    assertEqual('封鞘期间铭印被拒绝（400）', shImpRes.status, 400);

    const shShRes = await request('POST', '/api/artifact-deep-line/blood-sword/sheath', {}, token);
    assertEqual('封鞘期间重复封鞘被拒绝（400）', shShRes.status, 400);

    // 步骤 13：验证封鞘期间战力加成为 false
    console.log('\n[步骤 13] 验证封鞘期间战力加成失效');
    const finalStatusRes = await request('GET', '/api/artifact-deep-line/blood-sword/status', null, token);
    const finalSt = finalStatusRes.body?.data;
    assertTrue('封鞘期间 is_sheathed=true', finalSt?.is_sheathed === true, `is_sheathed=${finalSt?.is_sheathed}`);
    assertTrue('封鞘期间 combat_bonus.is_active=false',
        finalSt?.combat_bonus?.is_active === false,
        `is_active=${finalSt?.combat_bonus?.is_active}, reason=${finalSt?.combat_bonus?.reason}`);

    // 步骤 14：状态总结输出
    console.log('\n[状态总结]');
    console.log(`  ℹ 血契阶数：${finalSt?.blood_pact_stage} (${finalSt?.blood_pact_stage_name})`);
    console.log(`  ℹ 魔染：${finalSt?.corruption} / ${finalSt?.corruption_max}（${finalSt?.corruption_level}）`);
    console.log(`  ℹ 镇契：${finalSt?.suppression} / ${finalSt?.suppression_max}`);
    console.log(`  ℹ 铭印：${finalSt?.imprint_name}`);
    console.log(`  ℹ 封鞘中：${finalSt?.is_sheathed}（剩余 ${finalSt?.sheath_remaining_seconds} 秒）`);

    // 步骤 15：清理（卸下血魔剑，避免影响后续测试）
    console.log('\n[步骤 15] 清理：卸下血魔剑');
    const unequipRes = await request('POST', '/api/equipment/unequip',
        { slot: 'weapon' }, token);
    assertTrue('卸下血魔剑成功', unequipRes.status === 200 || unequipRes.body?.code === 200,
        `unequipRes=${JSON.stringify(unequipRes.body).slice(0, 200)}`);

    // 验证卸下后状态
    const cleanupStatusRes = await request('GET', '/api/artifact-deep-line/blood-sword/status', null, token);
    assertEqual('卸下后 has_blood_sword=false', cleanupStatusRes.body?.data?.has_blood_sword, false);

    // 输出测试结果
    console.log('\n' + '='.repeat(60));
    console.log(`测试结果：✓ 通过 ${passCount}  ✗ 失败 ${failCount}`);
    console.log('='.repeat(60));
    if (failedCases.length > 0) {
        console.log('\n失败用例详情：');
        for (const c of failedCases) {
            console.log(`  - ${c.case}: ${c.detail || `actual=${JSON.stringify(c.actual)} expected=${JSON.stringify(c.expected)}`}`);
        }
    }
    process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('测试执行异常:', err);
    process.exit(2);
});
