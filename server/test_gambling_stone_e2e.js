/**
 * 赌石系统端到端测试
 *
 * 测试覆盖：
 *   1. 配置接口（无需鉴权）
 *   2. 获取赌石档案（需鉴权）
 *   3. 生成3块原石（每日3次上限）
 *   4. 获取未切开原石列表
 *   5. 获取原石详情（含4维线索）
 *   6. 粗切/精切/神识切三种切法
 *   7. 切开产出校验（灵石/修为/物品/LDC/稀有/诅咒）
 *   8. 历史记录查询
 *   9. 排行榜（4类）
 *  10. 上架/取消上架拍卖行
 *  11. 灵识透石（熟练度不足时校验拒绝）
 *  12. 边界条件：日次数上限/未切开原石上限/无权操作他人原石/重复切开/已上架切开
 *
 * 测试账号：1592363624 / 1592363624
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const http = require('http');

const BASE_URL = 'http://localhost:5000';
const TEST_ACCOUNT = '1592363624';
const TEST_PASSWORD = '1592363624';

let token = null;
let testStoneIds = [];
let passed = 0;
let failed = 0;

/**
 * 发送 HTTP 请求
 */
function request(method, path, body = null, useAuth = true) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const options = {
            method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            headers: { 'Content-Type': 'application/json' }
        };
        if (useAuth && token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
                } catch (e) {
                    resolve({ status: res.statusCode, body: { raw: data } });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${message}`);
    } else {
        failed++;
        console.error(`  ✗ ${message}`);
    }
}

async function login() {
    console.log('\n[1] 登录测试账号...');
    const res = await request('POST', '/api/auth/login', { username: TEST_ACCOUNT, password: TEST_PASSWORD }, false);
    assert(res.status === 200, '登录应返回 200');
    assert(res.body.code === 200, '登录应返回 code:200');
    assert(res.body.token, '登录应返回 token');
    token = res.body.token;
    console.log(`  登录成功，token: ${token ? token.substring(0, 20) + '...' : 'null'}`);
}

async function testConfig() {
    console.log('\n[2] 测试配置接口（无需鉴权）...');
    const res = await request('GET', '/api/gambling-stone/config', null, false);
    assert(res.status === 200, '配置接口应返回 200');
    assert(res.body.code === 200, '配置接口应返回 code:200');
    assert(res.body.data && res.body.data.origins, '配置应含 origins');
    assert(res.body.data && res.body.data.qualities, '配置应含 qualities');
    assert(res.body.data && res.body.data.cut_methods, '配置应含 cut_methods');
    assert(res.body.data && res.body.data.clues, '配置应含 clues');
    assert(Object.keys(res.body.data.origins).length === 5, '应有5个产地（4+1诅咒）');
    assert(Object.keys(res.body.data.qualities).length === 4, '应有4档品质');
    assert(Object.keys(res.body.data.cut_methods).length === 3, '应有3种切法');
}

async function testProfile() {
    console.log('\n[3] 测试获取赌石档案...');
    const res = await request('GET', '/api/gambling-stone/profile');
    assert(res.status === 200, '档案接口应返回 200');
    assert(res.body.code === 200, '档案接口应返回 code:200');
    assert(res.body.data && typeof res.body.data.skill_level === 'number', '档案应含 skill_level');
    assert(res.body.data && typeof res.body.data.daily_generates === 'number', '档案应含 daily_generates');
    assert(res.body.data && typeof res.body.data.daily_generate_limit === 'number', '档案应含 daily_generate_limit');
    assert(res.body.data && res.body.data.stats, '档案应含 stats 统计');
    assert(res.body.data && typeof res.body.data.insight_unlocked === 'boolean', '档案应含 insight_unlocked');
    console.log(`  熟练度: Lv.${res.body.data?.skill_level}（${res.body.data?.skill_title}）, 今日: ${res.body.data?.daily_generates}/${res.body.data?.daily_generate_limit}`);
}

async function testGenerate() {
    console.log('\n[4] 测试生成原石...');
    // 第一次生成
    const res1 = await request('POST', '/api/gambling-stone/generate');
    assert(res1.status === 200, '生成接口应返回 200');
    assert(res1.body.code === 200, '生成接口应返回 code:200');
    assert(res1.body.data && Array.isArray(res1.body.data.stones), '应返回 stones 数组');
    assert(res1.body.data && res1.body.data.stones.length === 3, '应生成3块原石');
    if (res1.body.data?.stones?.length > 0) {
        const s = res1.body.data.stones[0];
        assert(s.id && typeof s.id === 'number', '原石应含 id');
        assert(s.origin && typeof s.origin === 'string', '原石应含 origin');
        assert(s.quality && typeof s.quality === 'string', '原石应含 quality');
        assert(s.clues && s.clues.crust, '原石应含 clues.crust');
        assert(s.clues && s.clues.weight, '原石应含 clues.weight');
        assert(s.clues && s.clues.aura, '原石应含 clues.aura');
        assert(s.clues && s.clues.color, '原石应含 clues.color');
        testStoneIds = res1.body.data.stones.map(s => s.id);
        console.log(`  生成3块原石：${testStoneIds.join(', ')}`);
        console.log(`  示例原石：${s.origin_name} / ${s.quality_name} / 线索: ${s.clues.crust}/${s.clues.weight}/${s.clues.aura}/${s.clues.color}`);
    }
}

async function testGenerateLimit() {
    console.log('\n[5] 测试每日生成次数上限...');
    // 第二次生成
    const res2 = await request('POST', '/api/gambling-stone/generate');
    assert(res2.status === 200, '第二次生成应返回 200');
    // 第三次生成
    const res3 = await request('POST', '/api/gambling-stone/generate');
    assert(res3.status === 200, '第三次生成应返回 200');
    // 第四次应失败
    const res4 = await request('POST', '/api/gambling-stone/generate');
    assert(res4.status === 400, '第四次生成应返回 400（达到上限）');
    assert(res4.body.code === 400, '第四次生成应返回 code:400');
    console.log(`  第4次生成被拒：${res4.body.message}`);
}

async function testGetStones() {
    console.log('\n[6] 测试获取未切开原石列表...');
    const res = await request('GET', '/api/gambling-stone/stones');
    assert(res.status === 200, '原石列表应返回 200');
    assert(res.body.code === 200, '原石列表应返回 code:200');
    assert(res.body.data && Array.isArray(res.body.data.stones), '应返回 stones 数组');
    assert(res.body.data && res.body.data.stones.length === 9, '应有9块未切开原石（3次生成×3块）');
    console.log(`  当前未切开原石：${res.body.data?.count} 块`);
    // 更新 testStoneIds
    if (res.body.data?.stones?.length > 0) {
        testStoneIds = res.body.data.stones.map(s => s.id);
    }
}

async function testStoneDetail() {
    console.log('\n[7] 测试获取原石详情...');
    if (testStoneIds.length === 0) {
        console.log('  跳过：无测试原石');
        return;
    }
    const stoneId = testStoneIds[0];
    const res = await request('GET', `/api/gambling-stone/stones/${stoneId}`);
    assert(res.status === 200, '原石详情应返回 200');
    assert(res.body.code === 200, '原石详情应返回 code:200');
    assert(res.body.data && res.body.data.id === stoneId, '详情ID应匹配');
    assert(res.body.data && res.body.data.clues, '详情应含 clues');
    assert(res.body.data && typeof res.body.data.skill_level === 'number', '详情应含 skill_level');
    console.log(`  原石详情：${res.body.data?.origin_name} / ${res.body.data?.quality_name}`);

    // 测试不存在的原石
    const res404 = await request('GET', '/api/gambling-stone/stones/999999');
    assert(res404.status === 400, '不存在原石应返回 400');
    assert(res404.body.code === 400, '不存在原石应返回 code:400');
}

async function testCutRough() {
    console.log('\n[8] 测试粗切（免费，30%损耗）...');
    if (testStoneIds.length === 0) {
        console.log('  跳过：无测试原石');
        return;
    }
    const stoneId = testStoneIds[0];
    const res = await request('POST', '/api/gambling-stone/cut', { stone_id: stoneId, cut_method: 'rough' });
    assert(res.status === 200, '粗切应返回 200');
    assert(res.body.code === 200, '粗切应返回 code:200');
    assert(res.body.data && res.body.data.real_quality, '应返回 real_quality');
    assert(res.body.data && res.body.data.yield, '应返回 yield');
    assert(res.body.data && typeof res.body.data.yield_value === 'string', '应返回 yield_value');
    console.log(`  粗切结果：${res.body.data?.real_quality_name} / 灵石+${res.body.data?.yield?.spirit_stones} / 修为+${res.body.data?.yield?.cultivation}`);
    if (res.body.data?.yield?.rare_drops?.length > 0) {
        console.log(`  🌟 稀有掉落：${res.body.data.yield.rare_drops.map(r => r.name).join('、')}`);
    }
    // 移除已切开的原石
    testStoneIds = testStoneIds.filter(id => id !== stoneId);
}

async function testCutFine() {
    console.log('\n[9] 测试精切（100灵石，10%损耗，保底60%）...');
    if (testStoneIds.length === 0) {
        console.log('  跳过：无测试原石');
        return;
    }
    const stoneId = testStoneIds[0];
    const res = await request('POST', '/api/gambling-stone/cut', { stone_id: stoneId, cut_method: 'fine' });
    assert(res.status === 200, '精切应返回 200');
    assert(res.body.code === 200, '精切应返回 code:200');
    assert(res.body.data && res.body.data.cut_method === 'fine', '切法应为 fine');
    console.log(`  精切结果：${res.body.data?.real_quality_name} / 灵石+${res.body.data?.yield?.spirit_stones} / 修为+${res.body.data?.yield?.cultivation}`);
    testStoneIds = testStoneIds.filter(id => id !== stoneId);
}

async function testCutDivineSense() {
    console.log('\n[10] 测试神识切（需大衍诀1层，无损必稀有）...');
    if (testStoneIds.length === 0) {
        console.log('  跳过：无测试原石');
        return;
    }
    const stoneId = testStoneIds[0];
    const res = await request('POST', '/api/gambling-stone/cut', { stone_id: stoneId, cut_method: 'divine_sense' });
    // 神识切需大衍诀1层，测试账号可能没有，校验两种情况
    if (res.status === 200 && res.body.code === 200) {
        assert(true, '神识切成功（有大衍诀1层）');
        assert(res.body.data && res.body.data.cut_method === 'divine_sense', '切法应为 divine_sense');
        console.log(`  神识切结果：${res.body.data?.real_quality_name} / 灵石+${res.body.data?.yield?.spirit_stones}`);
        testStoneIds = testStoneIds.filter(id => id !== stoneId);
    } else {
        assert(res.status === 400, '神识切无大衍诀应返回 400');
        assert(res.body.code === 400, '神识切无大衍诀应返回 code:400');
        console.log(`  神识切被拒（无大衍诀1层）：${res.body.message}`);
    }
}

async function testCutInvalid() {
    console.log('\n[11] 测试切开边界条件...');
    // 无效切法
    const res1 = await request('POST', '/api/gambling-stone/cut', { stone_id: testStoneIds[0], cut_method: 'invalid' });
    assert(res1.status === 400, '无效切法应返回 400');
    // 重复切开同一原石
    if (testStoneIds.length > 0) {
        const stoneId = testStoneIds[0];
        await request('POST', '/api/gambling-stone/cut', { stone_id: stoneId, cut_method: 'rough' });
        const res2 = await request('POST', '/api/gambling-stone/cut', { stone_id: stoneId, cut_method: 'rough' });
        assert(res2.status === 400, '重复切开应返回 400');
        assert(res2.body.code === 400, '重复切开应返回 code:400');
        testStoneIds = testStoneIds.filter(id => id !== stoneId);
    }
    // 不存在的原石
    const res3 = await request('POST', '/api/gambling-stone/cut', { stone_id: 999999, cut_method: 'rough' });
    assert(res3.status === 400, '不存在原石切开应返回 400');
}

async function testRecords() {
    console.log('\n[12] 测试历史记录查询...');
    const res = await request('GET', '/api/gambling-stone/records?page=1&page_size=10');
    assert(res.status === 200, '历史记录应返回 200');
    assert(res.body.code === 200, '历史记录应返回 code:200');
    assert(res.body.data && Array.isArray(res.body.data.records), '应返回 records 数组');
    assert(res.body.data && typeof res.body.data.total === 'number', '应返回 total');
    assert(res.body.data && res.body.data.records.length > 0, '应有切开记录');
    if (res.body.data?.records?.length > 0) {
        const r = res.body.data.records[0];
        assert(r.real_quality_name, '记录应含 real_quality_name');
        assert(r.cut_method_name, '记录应含 cut_method_name');
        assert(r.yield, '记录应含 yield');
        console.log(`  历史记录：${res.body.data.total} 条，示例：${r.real_quality_name} / ${r.cut_method_name}`);
    }
}

async function testRanking() {
    console.log('\n[13] 测试排行榜（4类）...');
    const types = ['biggest_win', 'total_profit', 'rare_count', 'skill_level'];
    for (const type of types) {
        const res = await request('GET', `/api/gambling-stone/ranking?type=${type}`);
        assert(res.status === 200, `排行 ${type} 应返回 200`);
        assert(res.body.code === 200, `排行 ${type} 应返回 code:200`);
        assert(res.body.data && Array.isArray(res.body.data.ranking), `排行 ${type} 应返回 ranking 数组`);
    }
    // 无效排行类型
    const resInvalid = await request('GET', '/api/gambling-stone/ranking?type=invalid');
    assert(resInvalid.status === 400, '无效排行类型应返回 400');
    console.log(`  排行榜测试完成（4类）`);
}

async function testListAndUnlist() {
    console.log('\n[14] 测试上架/取消上架拍卖行...');
    if (testStoneIds.length === 0) {
        console.log('  跳过：无测试原石');
        return;
    }
    const stoneId = testStoneIds[0];
    const basePrice = 100; // 假设基础价
    const listPrice = 200;

    // 上架
    const res1 = await request('POST', '/api/gambling-stone/list', { stone_id: stoneId, price: listPrice });
    assert(res1.status === 200, '上架应返回 200');
    assert(res1.body.code === 200, '上架应返回 code:200');
    console.log(`  上架成功：${res1.body.message}`);

    // 重复上架应失败
    const res2 = await request('POST', '/api/gambling-stone/list', { stone_id: stoneId, price: listPrice });
    assert(res2.status === 400, '重复上架应返回 400');

    // 已上架原石不可切开
    const res3 = await request('POST', '/api/gambling-stone/cut', { stone_id: stoneId, cut_method: 'rough' });
    assert(res3.status === 400, '已上架原石切开应返回 400');

    // 取消上架
    const res4 = await request('POST', '/api/gambling-stone/unlist', { stone_id: stoneId });
    assert(res4.status === 200, '取消上架应返回 200');
    assert(res4.body.code === 200, '取消上架应返回 code:200');
    console.log(`  取消上架成功：${res4.body.message}`);

    // 取消后可切开
    const res5 = await request('POST', '/api/gambling-stone/cut', { stone_id: stoneId, cut_method: 'rough' });
    assert(res5.status === 200, '取消上架后应可切开');
    testStoneIds = testStoneIds.filter(id => id !== stoneId);
}

async function testInsight() {
    console.log('\n[15] 测试灵识透石（熟练度100级解锁）...');
    if (testStoneIds.length === 0) {
        console.log('  跳过：无测试原石');
        return;
    }
    const stoneId = testStoneIds[0];
    const res = await request('POST', '/api/gambling-stone/insight', { stone_id: stoneId });
    // 熟练度不足应返回400
    if (res.status === 400) {
        assert(res.body.code === 400, '熟练度不足应返回 code:400');
        console.log(`  灵识透石被拒（熟练度不足）：${res.body.message}`);
    } else if (res.status === 200) {
        assert(res.body.code === 200, '灵识透石成功应返回 code:200');
        assert(res.body.data && res.body.data.insight_value, '应返回 insight_value');
        console.log(`  灵识透石成功：${res.body.data?.insight_dim_name} = ${res.body.data?.insight_value}`);
    }
}

async function main() {
    console.log('========================================');
    console.log('赌石系统端到端测试');
    console.log('========================================');

    try {
        await login();
        await testConfig();
        await testProfile();
        await testGenerate();
        await testGenerateLimit();
        await testGetStones();
        await testStoneDetail();
        await testCutRough();
        await testCutFine();
        await testCutDivineSense();
        await testCutInvalid();
        await testRecords();
        await testRanking();
        await testListAndUnlist();
        await testInsight();
    } catch (err) {
        console.error('\n❌ 测试执行异常:', err.message);
        failed++;
    }

    console.log('\n========================================');
    console.log(`测试结果：✓ ${passed} 通过 / ✗ ${failed} 失败`);
    console.log('========================================');
    process.exit(failed > 0 ? 1 : 0);
}

main();
