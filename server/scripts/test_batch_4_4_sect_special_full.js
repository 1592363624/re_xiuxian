/**
 * 批次4-4 宗门特色玩法深度测试
 *
 * 目的：
 *   1. 验证 6 大宗门 19 个接口可用性
 *   2. 验证 SectSpecialService 22 个核心方法的静态存在性
 *   3. 验证配置文件 sect_special_data.json 的完整性
 *   4. 验证当前玩家所属宗门的端到端业务流程
 *   5. 验证跨宗门调用的拒绝逻辑（玩家只能使用本宗门玩法）
 *
 * 测试账号：1592363624 / 1592363624
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
    console.log('  批次4-4 宗门特色玩法深度测试');
    console.log('========================================\n');

    // ===== 场景1：静态代码扫描 SectSpecialService 核心方法 =====
    console.log('[场景1] 静态代码扫描 SectSpecialService 核心方法');
    const servicePath = path.join(__dirname, '../game/services/SectSpecialService.js');
    const serviceCode = fs.readFileSync(servicePath, 'utf-8');

    const expectedMethods = [
        'initialize(',
        'getSpecialConfig(',
        'getSubConfig(',
        'getOrCreateRecord(',
        'getSpecialInfo(',
        'getTreeInfo(',
        'waterTree(',
        'harvestTree(',
        'getStarInfo(',
        'observeStar(',
        'getFateInfo(',
        'divineFate(',
        'getStairsInfo(',
        'climbStairs(',
        'getDarkArtsInfo(',
        'practiceDarkArts(',
        'purifyCorruption(',
        'getFurnaceInfo(',
        'greetConcubine(',
        'feedbackSpirit(',
        'startVoyage(',
        'settleVoyage(',
        'protectConcubine('
    ];
    for (const m of expectedMethods) {
        check(`SectSpecialService 应实现 ${m}`,
            serviceCode.includes(m),
            `缺失方法：${m}`);
    }

    // ===== 场景2：配置文件完整性检查 =====
    console.log('\n[场景2] 配置文件 sect_special_data.json 完整性');
    const configPath = path.join(__dirname, '../config/sect_special_data.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // 6 大宗门配置块
    const sectKeys = [
        ['spirit_eye_tree', '灵眼之树', 'luoyun'],
        ['star_platform', '观星台', 'xinggong'],
        ['fate_disk', '命盘推演', 'tianxing'],
        ['heaven_stairs', '天阶', 'lingxiao'],
        ['dark_arts', '魔道功法', 'yinluo'],
        ['furnace', '炉鼎侍妾', 'hehuan']
    ];
    for (const [key, name, sectId] of sectKeys) {
        check(`${name}(${sectId}) 配置块应存在`, config[key] !== undefined, `key=${key}`);
        if (config[key]) {
            check(`${name}.sect_id 应为 ${sectId}`, config[key].sect_id === sectId, `actual=${config[key].sect_id}`);
            check(`${name}.name 应存在`, config[key].name !== undefined, `name=${config[key].name}`);
        }
    }

    // 各宗门关键子配置
    check('灵眼之树.growth_stages 应有 4 个阶段', (config.spirit_eye_tree?.growth_stages?.length || 0) === 4,
        `actual=${config.spirit_eye_tree?.growth_stages?.length}`);
    check('灵眼之树.watering.daily_limit 应存在', config.spirit_eye_tree?.watering?.daily_limit !== undefined,
        `daily_limit=${config.spirit_eye_tree?.watering?.daily_limit}`);
    check('观星台.star_forms 应有 5 种星象', (config.star_platform?.star_forms?.length || 0) === 5,
        `actual=${config.star_platform?.star_forms?.length}`);
    check('命盘.fates 应有 5 种命途', (config.fate_disk?.fates?.length || 0) === 5,
        `actual=${config.fate_disk?.fates?.length}`);
    check('天阶.floors 应有 7 层', (config.heaven_stairs?.floors?.length || 0) === 7,
        `actual=${config.heaven_stairs?.floors?.length}`);
    check('魔道.corruption_thresholds.backlash 应为 100', config.dark_arts?.corruption_thresholds?.backlash === 100,
        `actual=${config.dark_arts?.corruption_thresholds?.backlash}`);
    check('炉鼎.voyage.routes 应有 4 条远航路线', (config.furnace?.voyage?.routes?.length || 0) === 4,
        `actual=${config.furnace?.voyage?.routes?.length}`);

    // ===== 场景3：路由文件接口路径检查 =====
    console.log('\n[场景3] 路由文件 sect_special.js 19 个接口路径');
    const routeCode = fs.readFileSync(path.join(__dirname, '../routes/sect_special.js'), 'utf-8');
    const expectedRoutes = [
        "router.get('/info'",
        "router.get('/tree'",
        "router.post('/tree/water'",
        "router.post('/tree/harvest'",
        "router.get('/star'",
        "router.post('/star/observe'",
        "router.get('/fate'",
        "router.post('/fate/divine'",
        "router.get('/stairs'",
        "router.post('/stairs/climb'",
        "router.get('/dark-arts'",
        "router.post('/dark-arts/practice'",
        "router.post('/dark-arts/purify'",
        "router.get('/furnace'",
        "router.post('/furnace/greet'",
        "router.post('/furnace/feedback'",
        "router.post('/furnace/voyage'",
        "router.post('/furnace/voyage/settle'",
        "router.post('/furnace/protect'"
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

    // ===== 场景5：获取玩家所属宗门 =====
    console.log('\n[场景5] 获取玩家所属宗门');
    const sectInfoRes = await api('GET', '/api/sect/my', token);
    let playerSectId = null;
    if (sectInfoRes.status === 200 && sectInfoRes.json?.data) {
        const sectData = sectInfoRes.json.data;
        playerSectId = sectData.sect_id || sectData.id;
        console.log(`  当前宗门: ${sectData.sect_id || sectData.id} (${sectData.sect_name || sectData.name})`);
        check('应返回宗门ID', !!playerSectId);
    } else {
        // 备用方式：通过 info 接口推断
        console.log(`  /api/sect/my 返回 ${sectInfoRes.status}，尝试通过 /api/sect-special/info 推断`);
    }

    // ===== 场景6：调用 /api/sect-special/info =====
    console.log('\n[场景6] /api/sect-special/info 接口');
    const infoRes = await api('GET', '/api/sect-special/info', token);
    check('info 应返回 200', infoRes.status === 200, `actual=${infoRes.status}, msg=${infoRes.json?.message || ''}`);
    if (infoRes.status === 200 && infoRes.json?.data) {
        const info = infoRes.json.data;
        console.log(`  info 返回字段: ${Object.keys(info).join(',')}`);
        console.log(`  info 内容预览: ${JSON.stringify(info).slice(0, 300)}`);
        check('info 应包含 sect_id 字段', info.sect_id !== undefined);
        if (info.sect_id) {
            playerSectId = info.sect_id;
            console.log(`  推断宗门: ${info.sect_id}`);
        }
    }

    // ===== 场景7：本宗门状态查询接口测试 =====
    console.log('\n[场景7] 本宗门状态查询接口测试');
    const sectRouteMap = {
        'luoyun': '/tree',
        'xinggong': '/star',
        'tianxing': '/fate',
        'lingxiao': '/stairs',
        'yinluo': '/dark-arts',
        'hehuan': '/furnace'
    };
    if (playerSectId && sectRouteMap[playerSectId]) {
        const ownRoute = sectRouteMap[playerSectId];
        const ownRes = await api('GET', `/api/sect-special${ownRoute}`, token);
        check(`本宗门 GET ${ownRoute} 应返回 200`, ownRes.status === 200,
            `actual=${ownRes.status}, msg=${ownRes.json?.message || ''}`);
        if (ownRes.status === 200 && ownRes.json?.data) {
            console.log(`  本宗门状态字段: ${Object.keys(ownRes.json.data).join(',')}`);
        }
    } else {
        check('玩家所属宗门ID应可识别', false, `playerSectId=${playerSectId}`);
    }

    // ===== 场景8：跨宗门接口拒绝逻辑测试 =====
    console.log('\n[场景8] 跨宗门接口拒绝逻辑（非本宗门玩法应被拒绝）');
    // 玩家只能使用本宗门的玩法，调用其他宗门的接口应返回 400/403
    for (const [sectId, route] of Object.entries(sectRouteMap)) {
        if (sectId === playerSectId) continue;
        const otherRes = await api('GET', `/api/sect-special${route}`, token);
        // 期望返回 400 或 403（业务错误）
        check(`非${sectId}弟子调用 GET ${route} 应被拒绝`,
            otherRes.status === 400 || otherRes.status === 403,
            `actual=${otherRes.status}, msg=${otherRes.json?.message || ''}`);
    }

    // ===== 场景9：本宗门动作接口测试（不实际触发破坏性操作）=====
    console.log('\n[场景9] 本宗门动作接口测试');
    const sectActionMap = {
        'luoyun': [['POST', '/tree/water'], ['POST', '/tree/harvest']],
        'xinggong': [['POST', '/star/observe']],
        'tianxing': [['POST', '/fate/divine']],
        'lingxiao': [['POST', '/stairs/climb']],
        'yinluo': [['POST', '/dark-arts/practice'], ['POST', '/dark-arts/purify']],
        'hehuan': [['POST', '/furnace/greet'], ['POST', '/furnace/feedback'], ['POST', '/furnace/protect']]
    };
    if (playerSectId && sectActionMap[playerSectId]) {
        for (const [method, route] of sectActionMap[playerSectId]) {
            const actRes = await api(method, `/api/sect-special${route}`, token);
            // 期望 200 成功，或者 400 业务错误（如次数耗尽、灵石不足、冷却中）
            check(`本宗门 ${method} ${route} 应返回 200 或 400（业务错误）`,
                actRes.status === 200 || actRes.status === 400,
                `actual=${actRes.status}, msg=${actRes.json?.message || ''}`);
            if (actRes.status === 200) {
                console.log(`  ${route} 成功: ${JSON.stringify(actRes.json?.data || {}).slice(0, 200)}`);
            }
        }
    }

    // ===== 场景10：跨宗门动作接口拒绝 =====
    console.log('\n[场景10] 跨宗门动作接口拒绝逻辑');
    for (const [sectId, actions] of Object.entries(sectActionMap)) {
        if (sectId === playerSectId) continue;
        for (const [method, route] of actions) {
            const otherRes = await api(method, `/api/sect-special${route}`, token);
            check(`非${sectId}弟子调用 ${method} ${route} 应被拒绝`,
                otherRes.status === 400 || otherRes.status === 403,
                `actual=${otherRes.status}, msg=${otherRes.json?.message || ''}`);
        }
    }

    // ===== 场景11：炉鼎远航参数校验（合欢宗专属）=====
    console.log('\n[场景11] 炉鼎远航参数校验');
    const voyageNoParamRes = await api('POST', '/api/sect-special/furnace/voyage', token);
    check('furnace/voyage 无 route_id 应返回 400',
        voyageNoParamRes.status === 400,
        `actual=${voyageNoParamRes.status}, msg=${voyageNoParamRes.json?.message || ''}`);

    // 调用远航结算（无需参数）
    const voyageSettleRes = await api('POST', '/api/sect-special/furnace/voyage/settle', token);
    check('furnace/voyage/settle 应返回 200 或 400（无进行中的远航）',
        voyageSettleRes.status === 200 || voyageSettleRes.status === 400,
        `actual=${voyageSettleRes.status}, msg=${voyageSettleRes.json?.message || ''}`);

    // ===== 汇总 =====
    console.log('\n========================================');
    console.log('  宗门特色玩法深度测试结果汇总');
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
