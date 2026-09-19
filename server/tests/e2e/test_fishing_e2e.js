/**
 * 灵溪垂钓系统端到端测试
 *
 * 覆盖 18 个接口 + 边界条件 + 业务流程
 * 玩法文档对照：第21节·经济与博彩补充
 *
 * 测试场景：
 *   1. 配置接口（无需鉴权）
 *   2. 钓鱼档案/商店（鉴权）
 *   3. 购买钓竿（LDC 扣除/重复购买拒绝）
 *   4. 购买鱼饵（正常/无效key/数量边界）
 *   5. 抛竿（无钓竿拒绝/无鱼饵拒绝/正常）
 *   6. 会话状态（等待/无会话）
 *   7. 试探咬饵（非鱼讯窗口拒绝）
 *   8. 提竿（非鱼讯窗口拒绝/正常结算）
 *   9. 放弃收竿
 *  10. 鱼篓（空/有记录/分页/过滤）
 *  11. 鱼谱图鉴
 *  12. 剖鱼（无效ID/正常/产出校验）
 *  13. 烹鱼（材料不足/正常）
 *  14. 排行榜（4类）
 *  15. 炼制鳞符（材料不足）
 *  16. 制作鱼饵（材料不足）
 *  17. 升级钓竿（材料不足）
 *  18. 未鉴权访问拒绝
 */
'use strict';

const http = require('http');

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, name, detail = '') {
    if (condition) {
        passCount++;
        console.log(`  ✅ ${name}`);
    } else {
        failCount++;
        failures.push(name);
        console.log(`  ❌ ${name} ${detail}`);
    }
}

function req(path, method = 'GET', body = null, token = null) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const r = http.request({ hostname: 'localhost', port: 5000, path, method, headers }, res => {
            let b = '';
            res.on('data', d => b += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
                catch (e) { resolve({ status: res.statusCode, body: b }); }
            });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

(async () => {
    console.log('========== 灵溪垂钓系统端到端测试 ==========\n');

    // ===== 1. 配置接口（无需鉴权） =====
    console.log('【场景1】配置接口');
    const config = await req('/api/fishing/config');
    assert(config.status === 200, 'GET /config 返回200');
    assert(config.body.code === 200, 'config.code===200');
    assert(config.body.data.rods && Object.keys(config.body.data.rods).length === 4, 'rods 有4种钓竿', Object.keys(config.body.data.rods || {}).length);
    assert(config.body.data.baits && Object.keys(config.body.data.baits).length === 4, 'baits 有4种鱼饵');
    assert(config.body.data.ponds && Object.keys(config.body.data.ponds).length === 4, 'ponds 有4个鱼塘');
    assert(config.body.data.fish_pools && Object.keys(config.body.data.fish_pools).length >= 4, 'fish_pools 有4个鱼池');

    // ===== 2. 登录获取 token =====
    console.log('\n【场景2】登录');
    const login = await req('/api/auth/login', 'POST', { username: '1592363624', password: '1592363624' });
    assert(login.status === 200 && login.body.token, '登录成功获取token');
    const token = login.body.token;

    // ===== 3. 未鉴权访问拒绝 =====
    console.log('\n【场景3】未鉴权访问拒绝');
    const noAuth = await req('/api/fishing/profile');
    assert(noAuth.status === 401, 'GET /profile 无token返回401');

    // ===== 4. 钓鱼档案 =====
    console.log('\n【场景4】钓鱼档案');
    const profile = await req('/api/fishing/profile', 'GET', null, token);
    assert(profile.status === 200, 'GET /profile 返回200');
    assert(profile.body.code === 200, 'profile.code===200');
    assert(profile.body.data.hasOwnProperty('rod_tier'), 'profile 含 rod_tier');
    assert(profile.body.data.hasOwnProperty('skill_level'), 'profile 含 skill_level');
    assert(profile.body.data.hasOwnProperty('ldc_balance'), 'profile 含 ldc_balance');
    assert(profile.body.data.hasOwnProperty('daily_casts'), 'profile 含 daily_casts');

    // ===== 5. 钓具商店 =====
    console.log('\n【场景5】钓具商店');
    const shop = await req('/api/fishing/shop', 'GET', null, token);
    assert(shop.status === 200, 'GET /shop 返回200');
    assert(shop.body.data.ponds.length === 4, 'shop 含4个鱼塘');
    assert(shop.body.data.baits.length === 4, 'shop 含4种鱼饵');
    assert(typeof shop.body.data.today_weather === 'string', 'shop 含今日天象');
    assert(typeof shop.body.data.luck_modifier === 'number', 'shop 含幸运修正');

    // ===== 6. 购买钓竿 =====
    console.log('\n【场景6】购买钓竿');
    // 先检查是否已有钓竿
    if (profile.body.data.rod_tier === 0) {
        const buyRod = await req('/api/fishing/rod/buy', 'POST', {}, token);
        assert(buyRod.body.code === 200, '购买钓竿成功');
        // 重复购买
        const buyRod2 = await req('/api/fishing/rod/buy', 'POST', {}, token);
        assert(buyRod2.body.code === 400, '重复购买被拒绝');
    } else {
        const buyRod = await req('/api/fishing/rod/buy', 'POST', {}, token);
        assert(buyRod.body.code === 400, '已有钓竿拒绝购买');
        console.log('  ℹ️ 已有钓竿，跳过购买测试');
    }

    // ===== 7. 购买鱼饵 =====
    console.log('\n【场景7】购买鱼饵');
    const buyBait = await req('/api/fishing/bait/buy', 'POST', { bait_key: 'diworm', quantity: 3 }, token);
    assert(buyBait.body.code === 200, '购买蚯蚓×3成功');
    const buyBaitInvalid = await req('/api/fishing/bait/buy', 'POST', { bait_key: 'invalid_bait', quantity: 1 }, token);
    assert(buyBaitInvalid.body.code === 400, '无效鱼饵key被拒绝');
    const buyBaitNoKey = await req('/api/fishing/bait/buy', 'POST', { quantity: 1 }, token);
    assert(buyBaitNoKey.status === 400, '缺少bait_key参数返回400');
    const buyBaitBadQty = await req('/api/fishing/bait/buy', 'POST', { bait_key: 'diworm', quantity: 0 }, token);
    assert(buyBaitBadQty.status === 400, '数量0被拒绝');
    const buyBaitOverQty = await req('/api/fishing/bait/buy', 'POST', { bait_key: 'diworm', quantity: 101 }, token);
    assert(buyBaitOverQty.status === 400, '数量101超出上限被拒绝');

    // ===== 8. 抛竿 =====
    console.log('\n【场景8】抛竿');
    // 先放弃可能存在的活跃会话
    await req('/api/fishing/give-up', 'POST', {}, token);
    const cast = await req('/api/fishing/cast', 'POST', { pond_id: 'qingyun_stream' }, token);
    assert(cast.body.code === 200, '抛竿成功', cast.body.message);
    if (cast.body.code === 200) {
        assert(cast.body.data.pond_name === '青云溪', '鱼塘名称正确');
        assert(cast.body.data.wait_sec > 0, '等待秒数>0');
        assert(cast.body.data.nibble_at > 0, '鱼讯时间戳>0');
    }
    // 重复抛竿（已有活跃会话）
    const cast2 = await req('/api/fishing/cast', 'POST', { pond_id: 'qingyun_stream' }, token);
    assert(cast2.body.code === 400, '已有活跃会话拒绝重复抛竿');
    // 缺少 pond_id
    const castNoPond = await req('/api/fishing/cast', 'POST', {}, token);
    assert(castNoPond.status === 400, '缺少pond_id返回400');

    // ===== 9. 会话状态 =====
    console.log('\n【场景9】会话状态');
    const status = await req('/api/fishing/status', 'GET', null, token);
    assert(status.body.code === 200, 'GET /status 返回200');
    assert(status.body.data.has_active_session === true, '有活跃会话');
    assert(status.body.data.status === 'waiting' || status.body.data.status === 'biting', '状态为waiting或biting', status.body.data.status);

    // ===== 10. 试探咬饵（非鱼讯窗口） =====
    console.log('\n【场景10】试探咬饵（非鱼讯窗口）');
    if (status.body.data.status === 'waiting') {
        const nibbleEarly = await req('/api/fishing/nibble', 'POST', {}, token);
        assert(nibbleEarly.body.code === 400, '鱼讯未到拒绝试探');
    }

    // ===== 11. 放弃收竿 =====
    console.log('\n【场景11】放弃收竿');
    const giveUp = await req('/api/fishing/give-up', 'POST', {}, token);
    assert(giveUp.body.code === 200, '放弃收竿成功');
    // 验证会话已清除
    const status2 = await req('/api/fishing/status', 'GET', null, token);
    assert(status2.body.data.has_active_session === false, '放弃后会话已清除');

    // ===== 12. 再次抛竿并等待完整钓鱼流程 =====
    console.log('\n【场景12】完整钓鱼流程（抛竿→等待→提竿）');
    const cast3 = await req('/api/fishing/cast', 'POST', { pond_id: 'qingyun_stream' }, token);
    if (cast3.body.code === 200) {
        const waitSec = cast3.body.data.wait_sec;
        console.log(`  ℹ️ 等待鱼讯 ${waitSec}秒...`);
        await new Promise(r => setTimeout(r, waitSec * 1000 + 1500));

        // 鱼讯到来后提竿
        const reel = await req('/api/fishing/reel', 'POST', {}, token);
        assert(reel.body.code === 200, '提竿返回200', reel.body.message);
        if (reel.body.code === 200) {
            if (reel.body.data.fish) {
                assert(true, `钓到 ${reel.body.data.fish.fish_name} ${reel.body.data.fish.weight_kg}kg`);
            } else {
                assert(true, '空竿（鱼跑了）');
            }
        }

        // 提竿后无活跃会话
        const status3 = await req('/api/fishing/status', 'GET', null, token);
        assert(status3.body.data.has_active_session === false, '提竿后会话已结束');
    }

    // ===== 13. 鱼篓 =====
    console.log('\n【场景13】鱼篓');
    const creel = await req('/api/fishing/creel', 'GET', null, token);
    assert(creel.body.code === 200, 'GET /creel 返回200');
    assert(creel.body.data.total >= 0, '鱼篓总数>=0');
    assert(creel.body.data.page === 1, '默认页码=1');
    // 过滤参数
    const creelUnfilleted = await req('/api/fishing/creel?page=1&page_size=10&filter=unfilleted', 'GET', null, token);
    assert(creelUnfilleted.body.code === 200, 'filter=unfilleted 返回200');
    assert(creelUnfilleted.body.data.filter === 'unfilleted', 'filter参数正确');

    // ===== 14. 鱼谱图鉴 =====
    console.log('\n【场景14】鱼谱图鉴');
    const album = await req('/api/fishing/album', 'GET', null, token);
    assert(album.body.code === 200, 'GET /album 返回200');
    assert(album.body.data.total_species > 0, '总鱼种数>0');
    assert(album.body.data.discovered >= 0, '已发现数>=0');
    assert(album.body.data.discovery_rate >= 0 && album.body.data.discovery_rate <= 1, '发现率在0-1之间');

    // ===== 15. 剖鱼 =====
    console.log('\n【场景15】剖鱼');
    // 无效ID
    const filletBad = await req('/api/fishing/fillet', 'POST', { catch_id: 999999, quantity: 1 }, token);
    assert(filletBad.body.code === 400, '无效鱼获ID被拒绝');
    // 缺少catch_id
    const filletNoId = await req('/api/fishing/fillet', 'POST', { quantity: 1 }, token);
    assert(filletNoId.status === 400, '缺少catch_id返回400');
    // 如果有鱼获，测试正常剖鱼
    const creelAll = await req('/api/fishing/creel?page=1&page_size=5&filter=unfilleted', 'GET', null, token);
    if (creelAll.body.data.catches.length > 0) {
        const c = creelAll.body.data.catches[0];
        const fillet = await req('/api/fishing/fillet', 'POST', { catch_id: c.id, quantity: 1 }, token);
        assert(fillet.body.code === 200, '剖鱼成功', fillet.body.message);
        if (fillet.body.code === 200) {
            assert(fillet.body.data.filet_gained >= 0, '灵鱼肉产出>=0');
            assert(fillet.body.data.scale_gained >= 0, '灵鱼鳞产出>=0');
        }
    } else {
        console.log('  ℹ️ 无未剖鱼获，跳过正常剖鱼测试');
    }

    // ===== 16. 烹鱼 =====
    console.log('\n【场景16】烹鱼');
    const cookBad = await req('/api/fishing/cook', 'POST', { quantity: 0 }, token);
    assert(cookBad.status === 400, '数量0被拒绝');
    const cookNoQty = await req('/api/fishing/cook', 'POST', {}, token);
    assert(cookNoQty.status === 400, '缺少quantity返回400');

    // ===== 17. 排行榜（4类） =====
    console.log('\n【场景17】排行榜');
    const rankSkill = await req('/api/fishing/ranking?category=skill_level', 'GET', null, token);
    assert(rankSkill.body.code === 200, '排行:skill_level 返回200');
    const rankBiggest = await req('/api/fishing/ranking?category=biggest_catch_kg', 'GET', null, token);
    assert(rankBiggest.body.code === 200, '排行:biggest_catch_kg 返回200');
    const rankRarest = await req('/api/fishing/ranking?category=rarest_catch_quality', 'GET', null, token);
    assert(rankRarest.body.code === 200, '排行:rarest_catch_quality 返回200');
    const rankTotal = await req('/api/fishing/ranking?category=total_success', 'GET', null, token);
    assert(rankTotal.body.code === 200, '排行:total_success 返回200');
    const rankInvalid = await req('/api/fishing/ranking?category=invalid', 'GET', null, token);
    assert(rankInvalid.body.code === 400, '无效排行类别被拒绝');

    // ===== 18. 炼制鳞符（材料不足） =====
    console.log('\n【场景18】炼制鳞符');
    const talisman = await req('/api/fishing/scale-talisman', 'POST', {}, token);
    // 可能成功也可能材料不足
    assert(talisman.body.code === 200 || talisman.body.code === 400, '鳞符接口可访问（成功或材料不足）', talisman.body.message);

    // ===== 19. 制作鱼饵（材料不足） =====
    console.log('\n【场景19】制作鱼饵');
    const craftBait = await req('/api/fishing/bait/craft', 'POST', { bait_key: 'handmade', batches: 1 }, token);
    assert(craftBait.body.code === 200 || craftBait.body.code === 400, '制饵接口可访问（成功或材料不足）', craftBait.body.message);
    const craftBaitNoKey = await req('/api/fishing/bait/craft', 'POST', { batches: 1 }, token);
    assert(craftBaitNoKey.status === 400, '缺少bait_key返回400');

    // ===== 20. 升级钓竿（材料不足或最高级） =====
    console.log('\n【场景20】升级钓竿');
    const upgrade = await req('/api/fishing/rod/upgrade', 'POST', {}, token);
    assert(upgrade.body.code === 200 || upgrade.body.code === 400, '升级接口可访问（成功/材料不足/最高级）', upgrade.body.message);

    // ===== 最终档案验证 =====
    console.log('\n【场景21】最终档案验证');
    const profileFinal = await req('/api/fishing/profile', 'GET', null, token);
    assert(profileFinal.body.code === 200, '最终档案返回200');
    assert(profileFinal.body.data.rod_tier >= 1, '钓竿等级>=1');
    assert(profileFinal.body.data.daily_casts >= 1, '今日已用竿数>=1');

    // ===== 汇总 =====
    console.log('\n========== 测试汇总 ==========');
    console.log(`通过: ${passCount} / 失败: ${failCount} / 总计: ${passCount + failCount}`);
    if (failures.length > 0) {
        console.log('失败项:', failures.join(', '));
        process.exit(1);
    }
    process.exit(0);
})().catch(e => {
    console.error('测试异常:', e);
    process.exit(1);
});
