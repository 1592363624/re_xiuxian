/**
 * 批次4-4 多人副本机制深度测试
 *
 * 目的：
 *   1. 验证 12 个接口可用性
 *   2. 验证 MultiDungeonService 23 个核心方法静态存在性
 *   3. 验证配置文件 multi_dungeon_data.json 完整性（yanyue + duanwu）
 *   4. 验证只读接口端到端流程（help/status/cooldown/history/rewards）
 *   5. 验证参数校验逻辑（dungeon_key/instance_id/choice_key/count/target_player_id）
 *   6. 验证创建副本的业务前置（境界/物品/冷却）
 *
 * 测试账号：1592363624 / 1592363624（韩天尊，化神期，admin）
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5000';
const TEST_USERNAME = '1592363624';
const TEST_PASSWORD = '1592363624';

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

const results = [];
function check(name, condition, detail = '') {
    results.push({ name, pass: !!condition, detail });
    console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
    console.log('========================================');
    console.log('  批次4-4 多人副本机制深度测试');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 MultiDungeonService 核心方法 =====
    console.log('[场景1] 静态代码扫描 MultiDungeonService 核心方法');
    const servicePath = path.join(__dirname, '../game/services/MultiDungeonService.js');
    const serviceCode = fs.readFileSync(servicePath, 'utf-8');

    const expectedMethods = [
        // 12 个玩家方法
        'static async getHelp(',
        'static async create(',
        'static async join(',
        'static async enter(',
        'static async getStatus(',
        'static async choose(',
        'static async throwZongzi(',
        'static async dissolve(',
        'static async kick(',
        'static async getRewards(',
        'static async getHistory(',
        'static async getCooldown(',
        // 4 个 GM 方法
        'static async gmForceDissolve(',
        'static async gmAdjustVariable(',
        'static async gmGrantReward(',
        'static async gmResetCooldown(',
        // 8 个内部辅助方法
        'static async _isPlayerInCooldown(',
        'static async _checkChoicePrerequisites(',
        'static async _applyChoiceEffect(',
        'static _checkFailCondition(',
        'static async _applyEmptyBoatPenalty(',
        'static async _applyCooldownToAllMembers(',
        'static async _settleRewards(',
        'static async _notifyInstanceUpdate('
    ];
    for (const m of expectedMethods) {
        const displayName = m.replace('static async ', '').replace('static ', '').replace('(', '');
        check(`MultiDungeonService 应实现 ${displayName}`,
            serviceCode.includes(m),
            `缺失方法：${m}`);
    }

    // ===== 场景2：配置文件完整性检查 =====
    console.log('\n[场景2] 配置文件 multi_dungeon_data.json 完整性');
    const configPath = path.join(__dirname, '../config/multi_dungeon_data.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    check('dungeons 配置块应存在', config.dungeons !== undefined);
    check('yanyue(掩月抢亲) 配置应存在', config.dungeons?.yanyue !== undefined);
    check('duanwu(端午镇蛟) 配置应存在', config.dungeons?.duanwu !== undefined);

    // yanyue 副本配置完整性
    const yanyue = config.dungeons?.yanyue;
    check('yanyue.name 应存在', yanyue?.name !== undefined, `name=${yanyue?.name}`);
    check('yanyue.member_min 应为 3', yanyue?.member_min === 3, `actual=${yanyue?.member_min}`);
    check('yanyue.member_max 应为 5', yanyue?.member_max === 5, `actual=${yanyue?.member_max}`);
    check('yanyue.acts 应有 6 幕', (yanyue?.acts?.length || 0) === 6,
        `actual=${yanyue?.acts?.length}`);
    check('yanyue.leader_min_realm_rank 应存在', yanyue?.leader_min_realm_rank !== undefined,
        `leader_min_realm_rank=${yanyue?.leader_min_realm_rank}`);

    // duanwu 副本配置完整性
    const duanwu = config.dungeons?.duanwu;
    check('duanwu.name 应存在', duanwu?.name !== undefined, `name=${duanwu?.name}`);
    check('duanwu.member_min 应为 10', duanwu?.member_min === 10, `actual=${duanwu?.member_min}`);
    check('duanwu.member_max 应为 10', duanwu?.member_max === 10, `actual=${duanwu?.member_max}`);
    check('duanwu.acts 应有 4 幕', (duanwu?.acts?.length || 0) === 4,
        `actual=${duanwu?.acts?.length}`);
    check('duanwu.empty_boat_penalty 应存在（空舟惩罚）', duanwu?.empty_boat_penalty !== undefined,
        `keys=${Object.keys(duanwu?.empty_boat_penalty || {}).join(',')}`);

    // ===== 场景3：路由文件接口路径检查 =====
    console.log('\n[场景3] 路由文件 multi_dungeon.js 12 个接口路径');
    const routeCode = fs.readFileSync(path.join(__dirname, '../routes/multi_dungeon.js'), 'utf-8');
    const expectedRoutes = [
        "router.get('/help'",
        "router.post('/create'",
        "router.post('/join'",
        "router.post('/enter'",
        "router.get('/status'",
        "router.post('/choose'",
        "router.post('/throw-zongzi'",
        "router.post('/dissolve'",
        "router.post('/kick'",
        "router.get('/rewards'",
        "router.get('/history'",
        "router.get('/cooldown'"
    ];
    for (const r of expectedRoutes) {
        check(`路由 ${r} 应存在`, routeCode.includes(r), `缺失：${r}`);
    }

    // ===== 场景4：登录 =====
    console.log('\n[场景4] 登录测试账号');
    const loginRes = await api('POST', '/api/auth/login', null, {
        username: TEST_USERNAME,
        password: TEST_PASSWORD
    });
    check('登录应返回 200', loginRes.status === 200);
    const token = loginRes.json?.token;
    check('应返回 token', !!token);
    if (!token) process.exit(1);

    // ===== 场景5：只读接口端到端流程 =====
    console.log('\n[场景5] 只读接口端到端流程');

    // /help - 副本规则说明
    const helpRes = await api('GET', '/api/multi-dungeon/help', token);
    check('/help 应返回 200', helpRes.status === 200, `actual=${helpRes.status}`);
    if (helpRes.status === 200 && helpRes.json?.data?.dungeons) {
        const dungeons = helpRes.json.data.dungeons;
        check('/help 应返回 yanyue 副本说明', dungeons.yanyue !== undefined);
        check('/help 应返回 duanwu 副本说明', dungeons.duanwu !== undefined);
        console.log(`  掩月抢亲: ${dungeons.yanyue?.name}, 人数 ${dungeons.yanyue?.member_min}-${dungeons.yanyue?.member_max}, ${dungeons.yanyue?.act_count}幕`);
        console.log(`  端午镇蛟: ${dungeons.duanwu?.name}, 人数 ${dungeons.duanwu?.member_min}-${dungeons.duanwu?.member_max}, ${dungeons.duanwu?.act_count}幕`);
    }

    // /status - 当前副本进度
    const statusRes = await api('GET', '/api/multi-dungeon/status', token);
    check('/status 应返回 200', statusRes.status === 200, `actual=${statusRes.status}, msg=${statusRes.json?.message || ''}`);

    // /cooldown - 冷却状态
    const cooldownRes = await api('GET', '/api/multi-dungeon/cooldown', token);
    check('/cooldown 应返回 200', cooldownRes.status === 200, `actual=${cooldownRes.status}, msg=${cooldownRes.json?.message || ''}`);
    if (cooldownRes.status === 200 && cooldownRes.json?.data) {
        console.log(`  冷却状态: ${JSON.stringify(cooldownRes.json.data).slice(0, 200)}`);
    }

    // /history - 历史副本记录
    const historyRes = await api('GET', '/api/multi-dungeon/history?page=1&size=5', token);
    check('/history 应返回 200', historyRes.status === 200, `actual=${historyRes.status}, msg=${historyRes.json?.message || ''}`);

    // /rewards - 奖励池（带 dungeon_key 参数）
    const rewardsYanyueRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=yanyue', token);
    check('/rewards?dungeon_key=yanyue 应返回 200', rewardsYanyueRes.status === 200,
        `actual=${rewardsYanyueRes.status}, msg=${rewardsYanyueRes.json?.message || ''}`);

    const rewardsDuanwuRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=duanwu', token);
    check('/rewards?dungeon_key=duanwu 应返回 200', rewardsDuanwuRes.status === 200,
        `actual=${rewardsDuanwuRes.status}, msg=${rewardsDuanwuRes.json?.message || ''}`);

    // ===== 场景6：参数校验 - dungeon_key 非法值 =====
    console.log('\n[场景6] 参数校验 - dungeon_key 非法值');
    const createInvalidRes = await api('POST', '/api/multi-dungeon/create', token, { dungeon_key: 'invalid_key' });
    check('/create 非法 dungeon_key 应返回 400', createInvalidRes.status === 400,
        `actual=${createInvalidRes.status}, msg=${createInvalidRes.json?.message || ''}`);

    const createMissingRes = await api('POST', '/api/multi-dungeon/create', token, {});
    check('/create 缺 dungeon_key 应返回 400', createMissingRes.status === 400,
        `actual=${createMissingRes.status}, msg=${createMissingRes.json?.message || ''}`);

    // ===== 场景7：参数校验 - instance_id =====
    console.log('\n[场景7] 参数校验 - instance_id');
    const joinMissingRes = await api('POST', '/api/multi-dungeon/join', token, {});
    check('/join 缺 instance_id 应返回 400', joinMissingRes.status === 400,
        `actual=${joinMissingRes.status}, msg=${joinMissingRes.json?.message || ''}`);

    const joinInvalidTypeRes = await api('POST', '/api/multi-dungeon/join', token, { instance_id: 'not_a_number' });
    check('/join instance_id 类型错误应返回 400', joinInvalidTypeRes.status === 400,
        `actual=${joinInvalidTypeRes.status}, msg=${joinInvalidTypeRes.json?.message || ''}`);

    const joinInvalidIdRes = await api('POST', '/api/multi-dungeon/join', token, { instance_id: 999999 });
    check('/join 不存在的 instance_id 应返回 200（业务失败）或 400',
        joinInvalidIdRes.status === 200 || joinInvalidIdRes.status === 400,
        `actual=${joinInvalidIdRes.status}, msg=${joinInvalidIdRes.json?.message || ''}`);

    // ===== 场景8：参数校验 - choice_key =====
    console.log('\n[场景8] 参数校验 - choice_key');
    const chooseMissingRes = await api('POST', '/api/multi-dungeon/choose', token, {});
    check('/choose 缺 choice_key 应返回 400', chooseMissingRes.status === 400,
        `actual=${chooseMissingRes.status}, msg=${chooseMissingRes.json?.message || ''}`);

    const chooseInvalidRes = await api('POST', '/api/multi-dungeon/choose', token, { choice_key: 12345 });
    check('/choose choice_key 类型错误应返回 400', chooseInvalidRes.status === 400,
        `actual=${chooseInvalidRes.status}, msg=${chooseInvalidRes.json?.message || ''}`);

    // ===== 场景9：参数校验 - count（投粽数量）=====
    console.log('\n[场景9] 参数校验 - count（投粽数量 1-5）');
    const throwZeroRes = await api('POST', '/api/multi-dungeon/throw-zongzi', token, { count: 0 });
    check('/throw-zongzi count=0 应返回 400', throwZeroRes.status === 400,
        `actual=${throwZeroRes.status}, msg=${throwZeroRes.json?.message || ''}`);

    const throwSixRes = await api('POST', '/api/multi-dungeon/throw-zongzi', token, { count: 6 });
    check('/throw-zongzi count=6 应返回 400', throwSixRes.status === 400,
        `actual=${throwSixRes.status}, msg=${throwSixRes.json?.message || ''}`);

    const throwNonIntRes = await api('POST', '/api/multi-dungeon/throw-zongzi', token, { count: 2.5 });
    check('/throw-zongzi count=2.5 非整数应返回 400', throwNonIntRes.status === 400,
        `actual=${throwNonIntRes.status}, msg=${throwNonIntRes.json?.message || ''}`);

    const throwMissingRes = await api('POST', '/api/multi-dungeon/throw-zongzi', token, {});
    check('/throw-zongzi 缺 count 应返回 400', throwMissingRes.status === 400,
        `actual=${throwMissingRes.status}, msg=${throwMissingRes.json?.message || ''}`);

    // ===== 场景10：参数校验 - target_player_id（踢人）=====
    console.log('\n[场景10] 参数校验 - target_player_id（踢人）');
    const kickMissingRes = await api('POST', '/api/multi-dungeon/kick', token, {});
    check('/kick 缺 target_player_id 应返回 400', kickMissingRes.status === 400,
        `actual=${kickMissingRes.status}, msg=${kickMissingRes.json?.message || ''}`);

    const kickInvalidRes = await api('POST', '/api/multi-dungeon/kick', token, { target_player_id: 'abc' });
    check('/kick target_player_id 类型错误应返回 400', kickInvalidRes.status === 400,
        `actual=${kickInvalidRes.status}, msg=${kickInvalidRes.json?.message || ''}`);

    // ===== 场景11：/rewards 参数校验 =====
    console.log('\n[场景11] /rewards 参数校验');
    const rewardsMissingRes = await api('GET', '/api/multi-dungeon/rewards', token);
    check('/rewards 缺 dungeon_key 应返回 400', rewardsMissingRes.status === 400,
        `actual=${rewardsMissingRes.status}, msg=${rewardsMissingRes.json?.message || ''}`);

    const rewardsInvalidRes = await api('GET', '/api/multi-dungeon/rewards?dungeon_key=invalid', token);
    check('/rewards 非法 dungeon_key 应返回 400', rewardsInvalidRes.status === 400,
        `actual=${rewardsInvalidRes.status}, msg=${rewardsInvalidRes.json?.message || ''}`);

    // ===== 场景12：无前置条件下的业务流程（create→dissolve）=====
    console.log('\n[场景12] 副本业务流程（创建→解散，验证幂等）');
    // 尝试创建 yanyue 副本，可能因冷却/物品不足等原因失败
    const createYanyueRes = await api('POST', '/api/multi-dungeon/create', token, { dungeon_key: 'yanyue' });
    console.log(`  /create yanyue: status=${createYanyueRes.status}, msg=${createYanyueRes.json?.message || ''}`);
    check('/create yanyue 应返回 200（不论成功失败，业务层处理）',
        createYanyueRes.status === 200,
        `actual=${createYanyueRes.status}, msg=${createYanyueRes.json?.message || ''}`);

    let createdInstanceId = null;
    if (createYanyueRes.status === 200 && createYanyueRes.json?.data?.instance_id) {
        createdInstanceId = createYanyueRes.json.data.instance_id;
        console.log(`  副本已创建，instance_id=${createdInstanceId}`);
    }

    // 解散副本（幂等，即使无副本也不应崩溃）
    const dissolveRes = await api('POST', '/api/multi-dungeon/dissolve', token);
    check('/dissolve 无副本时应返回 200（业务失败）或 200（幂等成功）',
        dissolveRes.status === 200,
        `actual=${dissolveRes.status}, msg=${dissolveRes.json?.message || ''}`);

    // enter（无副本时应业务失败）
    const enterRes = await api('POST', '/api/multi-dungeon/enter', token);
    check('/enter 无副本时应返回 200（业务失败）',
        enterRes.status === 200,
        `actual=${enterRes.status}, msg=${enterRes.json?.message || ''}`);

    // ===== 汇总 =====
    console.log('\n========================================');
    console.log('  多人副本机制深度测试结果汇总');
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
