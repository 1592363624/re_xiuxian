/**
 * 拍卖系统端到端测试脚本
 *
 * 测试场景：
 *   1. 登录获取 token（使用测试账号 1592363624）
 *   2. 获取拍卖配置
 *   3. 查询玩家储物袋，找一个可拍卖的物品
 *   4. 创建拍卖
 *   5. 查询拍卖列表（应包含刚创建的拍卖）
 *   6. 查询拍卖详情（应含竞价历史为空）
 *   7. 出价（自己出价测试 - 应失败：不能竞拍自己的拍卖）
 *   8. 查询我的拍卖
 *   9. 撤销拍卖
 *  10. GM 手动触发结算
 *  11. GM 查看调度器状态
 *
 * 用法：node scripts/_test_auction.js
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const BASE = 'http://localhost:5000/api';

/**
 * 发起 HTTP 请求的辅助函数（避免依赖 axios）
 * @param {string} method - HTTP 方法
 * @param {string} path - 路径
 * @param {Object} [data] - 请求体（POST/PUT）
 * @param {string} [token] - JWT token
 * @returns {Promise<Object>} 响应 JSON
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

/**
 * 日志输出辅助
 */
function log(title, obj) {
    console.log(`\n===== ${title} =====`);
    console.log(JSON.stringify(obj, null, 2).slice(0, 800));
}

/**
 * 断言辅助
 */
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ 断言失败: ${message}`);
        process.exitCode = 1;
    } else {
        console.log(`✅ ${message}`);
    }
}

async function main() {
    console.log('========== 拍卖系统端到端测试开始 ==========');

    // ===== 1. 登录 =====
    const loginRes = await request('POST', '/auth/login', {
        username: '1592363624',
        password: '1592363624'
    });
    log('1. 登录', { status: loginRes.status, code: loginRes.body.code });
    assert(loginRes.status === 200 && loginRes.body.code === 200, '登录成功');
    const token = loginRes.body.token;
    assert(!!token, '获取到 token');
    const playerId = loginRes.body.player?.id;
    console.log(`玩家ID: ${playerId}, 道号: ${loginRes.body.player?.nickname}, 境界: ${loginRes.body.player?.realm}`);

    // ===== 2. 获取拍卖配置 =====
    const cfgRes = await request('GET', '/auction/config');
    log('2. 获取配置', { status: cfgRes.status, enabled: cfgRes.body.data?.enabled });
    assert(cfgRes.body.data?.enabled === true, '拍卖系统已启用');
    const cfg = cfgRes.body.data;

    // ===== 3. 查询储物袋，找可拍卖物品 =====
    const invRes = await request('GET', '/inventory', null, token);
    log('3. 储物袋', { status: invRes.status, count: invRes.body.data?.items?.length });
    const items = invRes.body.data?.items || [];
    // 找一个非装备、非配方的普通物品来拍卖（优先消耗品/材料）
    const candidate = items.find(i => i.quantity >= 1 && i.item_key);
    if (!candidate) {
        console.log('⚠️ 储物袋无可用物品，跳过创建拍卖测试');
        return;
    }
    console.log(`选定拍卖物品: ${candidate.name} x${candidate.quantity} (key=${candidate.item_key})`);

    // ===== 4. 创建拍卖 =====
    const startPrice = 200;
    const durationHours = 1; // 1小时后到期
    const createRes = await request('POST', '/auction/create', {
        item_key: candidate.item_key,
        quantity: 1,
        starting_price: startPrice,
        duration_hours: durationHours
    }, token);
    log('4. 创建拍卖', createRes.body);
    assert(createRes.body.code === 200, '创建拍卖成功');
    const auctionId = createRes.body.data?.auction?.id;
    assert(!!auctionId, `获取到拍卖ID: ${auctionId}`);

    // ===== 5. 查询拍卖列表 =====
    const listRes = await request('GET', '/auction/list?status=open');
    log('5. 拍卖列表', { total: listRes.body.data?.total, first: listRes.body.data?.auctions?.[0] });
    assert(listRes.body.data?.total >= 1, '列表包含至少 1 个拍卖');
    const found = listRes.body.data.auctions.find(a => a.id === auctionId);
    assert(!!found, '列表中找到刚创建的拍卖');
    assert(found.seller_nickname !== null, '卖家昵称已填充');

    // ===== 6. 查询拍卖详情 =====
    const detailRes = await request('GET', `/auction/${auctionId}`);
    log('6. 拍卖详情', detailRes.body.data);
    assert(detailRes.body.code === 200, '查询详情成功');
    assert(detailRes.body.data?.bids?.length === 0, '竞价历史为空');
    assert(!!detailRes.body.data?.min_next_bid, '返回最小加价提示');

    // ===== 7. 自己出价（应失败：不能竞拍自己的拍卖）=====
    const selfBidRes = await request('POST', `/auction/${auctionId}/bid`, {
        bid_price: detailRes.body.data.min_next_bid
    }, token);
    log('7. 自己出价（应失败）', selfBidRes.body);
    assert(selfBidRes.body.code !== 200, '不能竞拍自己的拍卖');

    // ===== 8. 查询我的拍卖 =====
    const myRes = await request('GET', '/auction/my?status=open', null, token);
    log('8. 我的拍卖', { count: myRes.body.data?.auctions?.length });
    assert(myRes.body.data?.auctions?.length >= 1, '我的拍卖列表包含至少 1 个');

    // ===== 9. 查询我的竞价（应为空）=====
    const myBidsRes = await request('GET', '/auction/my-bids', null, token);
    log('9. 我的竞价', { count: myBidsRes.body.data?.bids?.length });
    assert(myBidsRes.body.code === 200, '查询我的竞价成功');

    // ===== 10. 撤销拍卖 =====
    const cancelRes = await request('POST', `/auction/${auctionId}/cancel`, {
        reason: '测试撤销'
    }, token);
    log('10. 撤销拍卖', cancelRes.body);
    assert(cancelRes.body.code === 200, '撤销拍卖成功');
    assert(cancelRes.body.data?.success === true, '撤销返回 success=true');
    assert(cancelRes.body.data?.compensation_fee === 0, '无人竞价时撤销无补偿费');

    // 验证拍卖状态已变为 cancelled（通过详情接口确认）
    const cancelledDetail = await request('GET', `/auction/${auctionId}`);
    assert(cancelledDetail.body.data?.status === 'cancelled', '详情确认拍卖状态为 cancelled');

    // ===== 11. GM 手动触发结算 =====
    const gmSettleRes = await request('POST', '/auction/gm/settle', {}, token);
    log('11. GM 手动结算', gmSettleRes.body);
    assert(gmSettleRes.body.code === 200, 'GM 手动结算接口可用');

    // ===== 12. GM 查看调度器状态 =====
    const gmSchedRes = await request('GET', '/auction/gm/scheduler', null, token);
    log('12. GM 调度器状态', gmSchedRes.body);
    assert(gmSchedRes.body.code === 200, 'GM 调度器状态接口可用');
    assert(gmSchedRes.body.data?.running === true, '调度器正在运行');

    // ===== 13. 查询不存在的拍卖（应 404）=====
    const notFoundRes = await request('GET', '/auction/99999999');
    log('13. 查询不存在拍卖（应404）', notFoundRes.body);
    assert(notFoundRes.body.code === 404, '不存在拍卖返回 404');

    // ===== 14. 未登录创建拍卖（应 401）=====
    const noAuthRes = await request('POST', '/auction/create', {
        item_key: 'test', quantity: 1, starting_price: 100, duration_hours: 1
    });
    log('14. 未登录创建拍卖（应401）', noAuthRes.body);
    assert(noAuthRes.status === 401, '未登录创建拍卖被拒绝');

    console.log('\n========== 拍卖系统端到端测试完成 ==========');
}

main().catch(err => {
    console.error('测试异常:', err.message);
    console.error(err.stack);
    process.exit(1);
});
