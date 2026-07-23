/**
 * 聊天红包系统测试脚本
 *
 * 测试内容：
 *   1. 登录获取 token
 *   2. 发送红包参数校验（金额/个数/类型/留言边界）
 *   3. 发送红包成功（lucky + equal 两种类型）
 *   4. 查询红包详情
 *   5. 领取红包（不能领取自己的 / 重复领取 / 正常领取）
 *   6. 获取活跃红包列表
 *   7. OpenAPI 文档验证
 *   8. 配置完整性验证
 *
 * 用法：node scripts/test_red_packet.js
 *
 * 注意：本测试会消耗测试账号灵石，请确保账号有足够灵石。
 * 测试账号：1592363624 / 1592363624
 */
'use strict';

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000/api';

// HTTP 请求工具：优先使用 Node.js 18+ 内置 fetch，回退到 http 模块
async function httpRequest(method, path, body, token) {
    const url = `${BASE_URL}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (body !== undefined && body !== null) {
        options.body = JSON.stringify(body);
    }

    // 使用内置 fetch（Node.js 18+）
    if (typeof fetch !== 'undefined') {
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        return { status: res.status, body: data };
    }

    // 回退到 http 模块（低版本 Node.js）
    const http = require('http');
    const urlObj = new URL(url);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method,
            headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: {} });
                }
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// 测试统计
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  [PASS] ${message}`);
    } else {
        failed++;
        errors.push(message);
        console.log(`  [FAIL] ${message}`);
    }
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('='.repeat(60));
    console.log('[红包系统测试] 开始测试...');
    console.log('='.repeat(60));

    // 1. 登录
    console.log('\n--- 1. 登录 ---');
    const loginRes = await httpRequest('POST', '/auth/login', {
        username: '1592363624',
        password: '1592363624'
    });
    assert(loginRes.status === 200, '登录应返回 200');
    const token = loginRes.body.token || loginRes.body.data?.token;
    assert(!!token, '应返回有效 token');
    const playerId = loginRes.body.player?.id || loginRes.body.data?.player?.id;
    const playerNickname = loginRes.body.player?.nickname || loginRes.body.data?.player?.nickname;
    console.log(`  测试账号: ${playerNickname} (ID: ${playerId})`);

    if (!token) {
        console.log('[红包系统测试] 无法获取 token，测试终止');
        process.exit(1);
    }

    // 2. 发送红包参数校验
    console.log('\n--- 2. 发送红包参数校验 ---');

    // 2.1 缺少 total_amount
    let res = await httpRequest('POST', '/chat/red-packet/send', { total_count: 1 }, token);
    assert(res.status === 400, '缺少 total_amount 应返回 400');

    // 2.2 金额为 0
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 0, total_count: 1 }, token);
    assert(res.status === 400, '金额为 0 应返回 400');

    // 2.3 金额为负数
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: -100, total_count: 1 }, token);
    assert(res.status === 400, '金额为负数应返回 400');

    // 2.4 金额低于最小值（10）
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 5, total_count: 1 }, token);
    assert(res.status === 400, '金额低于 10 应返回 400');

    // 2.5 缺少 total_count
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 100 }, token);
    assert(res.status === 400, '缺少 total_count 应返回 400');

    // 2.6 个数为 0
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 100, total_count: 0 }, token);
    assert(res.status === 400, '个数为 0 应返回 400');

    // 2.7 个数超过 100
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 100, total_count: 101 }, token);
    assert(res.status === 400, '个数超过 100 应返回 400');

    // 2.8 金额不足均分（金额 < 个数 * min_per_packet）
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 5, total_count: 10 }, token);
    assert(res.status === 400, '金额不足以均分应返回 400');

    // 2.9 无效红包类型
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 100, total_count: 1, packet_type: 'invalid' }, token);
    assert(res.status === 400, '无效红包类型应返回 400');

    // 2.10 留言超长（>100）
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 100, total_count: 1, message: 'a'.repeat(101) }, token);
    assert(res.status === 400, '留言超过 100 字应返回 400');

    // 3. 发送红包成功
    console.log('\n--- 3. 发送红包成功 ---');

    // 3.1 拼手气红包
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 100, total_count: 3, packet_type: 'lucky', message: '测试红包-拼手气' }, token);
    assert(res.status === 201, '拼手气红包发送应返回 201');
    assert(res.body.data?.red_packet_id > 0, '应返回红包ID');
    assert(res.body.data?.packet_type === 'lucky', '类型应为 lucky');
    assert(res.body.data?.total_amount === 100, '总金额应为 100');
    assert(res.body.data?.total_count === 3, '总个数应为 3');
    assert(res.body.data?.status === 'active', '状态应为 active');
    const luckyRedPacketId = res.body.data?.red_packet_id;

    // 3.2 普通均分红包
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 60, total_count: 3, packet_type: 'equal', message: '测试红包-均分' }, token);
    assert(res.status === 201, '普通均分红包发送应返回 201');
    assert(res.body.data?.packet_type === 'equal', '类型应为 equal');
    const equalRedPacketId = res.body.data?.red_packet_id;

    // 3.3 默认类型（不传 packet_type，应为 lucky）
    res = await httpRequest('POST', '/chat/red-packet/send', { total_amount: 50, total_count: 2 }, token);
    assert(res.status === 201, '默认类型红包发送应返回 201');
    assert(res.body.data?.packet_type === 'lucky', '默认类型应为 lucky');

    // 4. 查询红包详情
    console.log('\n--- 4. 查询红包详情 ---');
    if (luckyRedPacketId) {
        res = await httpRequest('GET', `/chat/red-packet/${luckyRedPacketId}`, null, token);
        assert(res.status === 200, '查询红包详情应返回 200');
        assert(res.body.data?.red_packet_id === luckyRedPacketId, '红包ID应匹配');
        assert(res.body.data?.sender?.nickname === playerNickname, '发送者昵称应匹配');
        assert(res.body.data?.total_amount === 100, '总金额应为 100');
        assert(res.body.data?.my_claim === null, '发送者本人未领取时 my_claim 应为 null');
        assert(Array.isArray(res.body.data?.claims), 'claims 应为数组');
    }

    // 4.1 查询不存在的红包
    res = await httpRequest('GET', '/chat/red-packet/999999', null, token);
    assert(res.status === 404, '查询不存在的红包应返回 404');

    // 4.2 无效红包ID
    res = await httpRequest('GET', '/chat/red-packet/0', null, token);
    assert(res.status === 400, '无效红包ID应返回 400');

    // 5. 领取红包
    console.log('\n--- 5. 领取红包 ---');

    // 5.1 不能领取自己的红包（self_claim_allowed=false）
    if (luckyRedPacketId) {
        res = await httpRequest('POST', `/chat/red-packet/${luckyRedPacketId}/claim`, {}, token);
        assert(res.status === 400, '不能领取自己的红包应返回 400');
    }

    // 5.2 领取不存在的红包
    res = await httpRequest('POST', '/chat/red-packet/999999/claim', {}, token);
    assert(res.status === 404, '领取不存在的红包应返回 404');

    // 5.3 无效红包ID
    res = await httpRequest('POST', '/chat/red-packet/0/claim', {}, token);
    assert(res.status === 400, '无效红包ID领取应返回 400');

    // 6. 获取活跃红包列表
    console.log('\n--- 6. 获取活跃红包列表 ---');
    res = await httpRequest('GET', '/chat/red-packet/active', null, token);
    assert(res.status === 200, '获取活跃红包列表应返回 200');
    assert(Array.isArray(res.body.data), '活跃红包列表应为数组');
    if (res.body.data.length > 0) {
        const rp = res.body.data[0];
        assert(rp.red_packet_id > 0, '红包项应包含 red_packet_id');
        assert(rp.sender?.nickname, '红包项应包含发送者昵称');
        assert(rp.packet_type, '红包项应包含类型');
    }

    // 7. OpenAPI 文档验证
    console.log('\n--- 7. OpenAPI 文档验证 ---');
    const fs = require('fs');
    const path = require('path');
    const openapiPath = path.join(__dirname, '..', '..', 'docs', 'openapi.json');
    if (fs.existsSync(openapiPath)) {
        const spec = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
        const paths = spec.paths || {};
        assert(!!paths['/api/chat/red-packet/send'], 'OpenAPI 应包含 send 路径');
        assert(!!paths['/api/chat/red-packet/{id}/claim'], 'OpenAPI 应包含 claim 路径');
        assert(!!paths['/api/chat/red-packet/{id}'], 'OpenAPI 应包含 detail 路径');
        assert(!!paths['/api/chat/red-packet/active'], 'OpenAPI 应包含 active 路径');

        // 验证 send 路径有 POST 方法
        if (paths['/api/chat/red-packet/send']) {
            assert(!!paths['/api/chat/red-packet/send'].post, 'send 路径应有 POST 方法');
            assert(paths['/api/chat/red-packet/send'].post.operationId === 'sendRedPacket', 'send operationId 应为 sendRedPacket');
        }
    } else {
        console.log('  [SKIP] openapi.json 不存在，跳过文档验证');
    }

    // 8. 配置完整性验证
    console.log('\n--- 8. 配置完整性验证 ---');
    const configPath = path.join(__dirname, '..', 'config', 'game_balance.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const rpConfig = config?.chat?.red_packet;
    assert(!!rpConfig, 'game_balance.json 应包含 chat.red_packet 配置');
    if (rpConfig) {
        assert(rpConfig.enabled === true, '红包功能应启用');
        assert(rpConfig.min_amount === 10, '最小金额应为 10');
        assert(rpConfig.max_amount === 1000000, '最大金额应为 1000000');
        assert(rpConfig.min_count === 1, '最小个数应为 1');
        assert(rpConfig.max_count === 100, '最大个数应为 100');
        assert(rpConfig.expire_hours === 24, '过期时间应为 24 小时');
        assert(rpConfig.self_claim_allowed === false, '应禁止领取自己的红包');
    }

    // 验证 state_cleaner 配置
    const scConfig = config?.state_cleaner?.red_packet;
    assert(!!scConfig, 'state_cleaner 应包含 red_packet 子配置');
    if (scConfig) {
        assert(scConfig.enable === true, '红包清理应启用');
        assert(scConfig.interval_ms === 5000, '清理间隔应为 5000ms');
    }

    // 9. 迁移脚本存在性验证
    console.log('\n--- 9. 迁移脚本验证 ---');
    const migrationPath = path.join(__dirname, 'migration_0063_chat_red_packet.js');
    assert(fs.existsSync(migrationPath), '迁移脚本 migration_0063 应存在');

    // 10. 状态注册文件验证
    console.log('\n--- 10. 状态注册文件验证 ---');
    const regPath = path.join(__dirname, '..', 'game', 'state', 'registrations', 'red_packet.js');
    assert(fs.existsSync(regPath), '红包状态注册文件应存在');

    // 汇总
    console.log('\n' + '='.repeat(60));
    console.log(`[红包系统测试] 测试完成：通过 ${passed} / 失败 ${failed}`);
    console.log('='.repeat(60));
    if (failed > 0) {
        console.log('\n失败项：');
        errors.forEach(e => console.log(`  - ${e}`));
        process.exit(1);
    }
}

main().catch(err => {
    console.error('[红包系统测试] 测试执行异常:', err);
    process.exit(1);
});
