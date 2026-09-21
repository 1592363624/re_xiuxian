/**
 * 配置改了 → 不重启进程 → 限流阈值真的换掉了；以及配置管理面会不会随文件增长自动扩
 * （需要 MySQL，走 .env 指向的隔离库）
 *
 * 分两组断言：C0-C4 是"热更链"（写文件 → hotUpdateConfig → 运行中的限流器换阈值），
 * C5-C9 是"管理面"（列表/读取/热更三个接口是否还写死着 6 个配置名，以及新开的读面有没有被鉴权挡住）。
 *
 * 为什么单独一条探针：限流器在模块加载时就建好了（那时配置还没读进来），之后要靠两步才换成运营阈值 ——
 *   a) 启动时的 initializeRateLimiters()；b) 后台改配置后 configHotUpdated 订阅触发的重建。
 * 这两步以前都不可观察：
 *   - index.js 的订阅挂在 infrastructure.EventBus 上，而事件是 ConfigLoader 发在自己身上的
 *     （ConfigLoader extends EventEmitter），于是那条订阅从来没执行过 —— 改完限流配置必须重启进程；
 *   - config/game_balance.json 里的 rate_limit 数值和代码兜底值**一模一样**，所以就算整条链路是断的，
 *     玩家侧 429 行为也不会有任何差别，没人能发现。
 *
 * 探针走的是 GM 后台同一个入口（routes/admin.js 保存 game_balance 时就是"写文件 + hotUpdateConfig"），
 * 而不是偷偷改内存缓存 —— 实测那样会被内容层的热更监听按磁盘内容盖回去（文件才是事实来源）。
 * 配置文件在探针期间会被临时改成哨兵值，结束（含异常与 process.exit）后按原始字节还原，
 * 并自己断言"字节级回到原样"。
 *
 * 用法：cd server && SMOKE_PORT=5096 node --env-file=.env scripts/smoke_config_hot_reload.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5096);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const sequelize = require('../config/database');
const configLoader = require('../modules/infrastructure/ConfigLoader');
const { bootApp, request, mintToken } = require('./lib/smoke_http');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'game_balance.json');
const BORDER_FILE = path.join(__dirname, '..', 'config', 'border_military_data.json');
const STATUS_PATH = '/api/config/content/status';
const originalBytes = fs.readFileSync(CONFIG_FILE);
const fileConfig = JSON.parse(originalBytes.toString('utf-8'));
const borderOriginalBytes = fs.readFileSync(BORDER_FILE);
const borderConfig = JSON.parse(borderOriginalBytes.toString('utf-8'));

const SENTINEL = {
    api: { limit: 4321, window_seconds: 77 },
    action: { limit: 53, window_seconds: 9 },
    auth: { limit: 11, window_seconds: 700 },
    admin: { limit: 13, window_seconds: 600 }
};

const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

// 任何退出路径都把被临时改过的配置文件按原字节写回去
const CONFIG_BACKUPS = new Map([
    [CONFIG_FILE, originalBytes],
    [BORDER_FILE, borderOriginalBytes]
]);
process.on('exit', () => {
    for (const [file, bytes] of CONFIG_BACKUPS) {
        try {
            if (!fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes);
        } catch (e) {
            console.error(`配置文件还原失败，请手工检查 ${path.basename(file)}:`, e.message);
        }
    }
});

async function status(token) {
    const res = await request({ port: PORT, path: STATUS_PATH, token });
    return { res, state: res.body?.data?.rate_limit || null };
}

/** 与 GM 后台一致：改文件 → 走 ConfigLoader.hotUpdateConfig（它会重读文件、换缓存、发事件） */
async function hotEditGameBalance(rateLimitSection) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(
        { ...fileConfig, rate_limit: rateLimitSection }, null, 2
    ), 'utf-8');
    await configLoader.hotUpdateConfig('game_balance');
}

async function ensureAdmin() {
    const existing = await Player.findOne({ where: { role: 'admin' } });
    if (existing) return { player: existing, created: false };
    const created = await Player.create({
        username: 'cfgprobe_admin',
        password: 'not-a-real-hash',
        nickname: '配置探针管理员',
        role: 'admin',
        realm: '筑基初期',
        realm_rank: 11,
        exp: 0,
        spirit_stones: 1000,
        hp_current: 5000,
        mp_current: 5000,
        lifespan_current: 120,
        attributes: {},
        token_version: 0
    });
    return { player: created, created: true };
}

(async () => {
    await bootApp(app, { port: PORT });
    const { player: admin, created } = await ensureAdmin();
    const token = mintToken(admin);

    const first = await status(token);
    if (first.res.status !== 200 || !first.state) {
        check('C0 管理员能读到 /api/config/content/status 的 rate_limit 段', false,
            `status=${first.res.status} body=${String(first.res.raw).slice(0, 200)}`);
        if (created) await Player.destroy({ where: { id: admin.id } });
        console.log('\n0/1 项通过（读不到生效状态，后面没法判）');
        await sequelize.close();
        process.exit(1);
    }
    const before = first.state.generation;
    check(
        'C0 启动后限流器已按配置重建（模块加载那一次算第 1 代，配置就绪后至少还有第 2 代）',
        before >= 2
            && first.state.config.api.limit === fileConfig.rate_limit.api.limit
            && first.state.config.auth.window_seconds === fileConfig.rate_limit.auth.window_seconds,
        `generation=${before} 生效阈值=${JSON.stringify(first.state.config)}`
    );

    // ===== C5-C9：配置管理面（编号按"热更链 / 管理面"分组，不按执行顺序）=====
    const list = await request({ port: PORT, path: '/api/config/list' });
    const listed = list.body?.data || {};
    check(
        'C5 匿名 GET /api/config/list 能列出全部配置（新增配置文件不需要改这个路由）',
        list.status === 200
            && listed.config_count >= 50
            && listed.configs?.stat_definitions?.loaded === true
            && listed.configs?.combat_formulas?.loaded === true,
        `config_count=${listed.config_count} stat_definitions=${JSON.stringify(listed.configs?.stat_definitions || null)}`
    );
    const anonSecret = await request({ port: PORT, path: '/api/config/ai_config' });
    const anonPublic = await request({ port: PORT, path: '/api/config/item_data' });
    check(
        'C6 匿名只能读玩家可见的那几份；ai_config 标为非公开（后台会把 provider apiKey 写进这个文件）',
        anonSecret.status === 400 && anonPublic.status === 200 && listed.configs?.ai_config?.public === false,
        `ai_config(匿名)=${anonSecret.status} item_data(匿名)=${anonPublic.status} public标记=${listed.configs?.ai_config?.public}`
    );
    const adminFull = await request({ port: PORT, path: '/api/config/full/ai_config', token });
    check(
        'C7 管理员可以读任意配置全文（GM 排查要看得见）',
        adminFull.status === 200 && !!adminFull.body?.data?.config?.providers,
        `status=${adminFull.status} keys=${Object.keys(adminFull.body?.data?.config || {}).slice(0, 4).join(',')}`
    );
    const anonFull = await request({ port: PORT, path: '/api/config/full/ai_config' });
    check(
        'C8 同一个 full 接口匿名访问被鉴权挡住（新开的读面不能变成密钥泄露口）',
        anonFull.status === 401 || anonFull.status === 403,
        `status=${anonFull.status} body=${String(anonFull.raw).slice(0, 80)}`
    );
    const hotReal = await request({ port: PORT, method: 'POST', path: '/api/config/hot-update', token, body: { configName: 'stat_definitions' } });
    const hotTraversal = await request({ port: PORT, method: 'POST', path: '/api/config/hot-update', token, body: { configName: '../../package' } });
    check(
        'C9 热更接口：本次新增的配置文件能直接热更，路径穿越名被拒',
        hotReal.status === 200 && hotTraversal.status === 400,
        `stat_definitions→${hotReal.status}/${String(hotReal.body?.message || '').slice(0, 30)}，穿越名→${hotTraversal.status}`
    );

    // ===== C10：热更一份"服务自己会缓存配置"的玩法配置，服务必须读到新值 =====
    // 慕兰战线把 getConfig 的结果存在模块变量里、只在为空时重读 —— 热更接口返回成功也没用，
    // 服务仍然用开机那一刻的旧副本。tests/ConfigFreshness.test.js 钉的是进程内行为，
    // 这一条钉的是"真实后台接口 + 真实配置文件 + 真实服务"的端到端。
    const BorderMilitaryService = require('../game/services/BorderMilitaryService');
    const minRealmRank = () => BorderMilitaryService.getConfig()?.settings?.min_realm_rank;
    const beforeBorder = minRealmRank();
    fs.writeFileSync(BORDER_FILE, JSON.stringify(
        { ...borderConfig, settings: { ...borderConfig.settings, min_realm_rank: 991 } }, null, 2
    ), 'utf-8');
    let borderHot = null;
    try {
        const hot = await request({
            port: PORT, method: 'POST', path: '/api/config/hot-update', token,
            body: { configName: 'border_military_data' }
        });
        borderHot = { status: hot.status, seenByService: minRealmRank() };
    } finally {
        fs.writeFileSync(BORDER_FILE, borderOriginalBytes);
        await configLoader.hotUpdateConfig('border_military_data').catch(e => console.error('border 还原热更失败:', e.message));
    }
    check(
        'C10 后台热更 border_military_data 后，慕兰战线服务立刻读到新值；还原后又读回原值',
        borderHot !== null && borderHot.status === 200 && borderHot.seenByService === 991 && minRealmRank() === beforeBorder,
        `改前=${beforeBorder} 热更后=${JSON.stringify(borderHot)} 还原后=${minRealmRank()}`
    );

    try {
        // ===== C1：不重启进程，改完就该生效 =====
        await hotEditGameBalance(SENTINEL);
        const second = await status(token);
        check(
            'C1 后台改 game_balance.rate_limit 后热更新真的换掉了运行中的限流器（不重启进程）',
            !!second.state
                && second.state.config.api.limit === SENTINEL.api.limit
                && second.state.config.api.window_seconds === SENTINEL.api.window_seconds
                && second.state.config.action.limit === SENTINEL.action.limit
                && second.state.generation === before + 1,
            `generation ${before}→${second.state?.generation} 生效阈值=${JSON.stringify(second.state?.config || null)}`
        );

        // ===== C2：热更别的配置不该顺带重建限流器（那等于给刷接口的人重置窗口）=====
        await configLoader.hotUpdateConfig('item_data');
        const third = await status(token);
        check(
            'C2 只改别的配置不会重建限流器',
            third.state && third.state.generation === before + 1,
            `generation=${third.state?.generation}（期望 ${before + 1}）`
        );
    } finally {
        fs.writeFileSync(CONFIG_FILE, originalBytes);
        await configLoader.hotUpdateConfig('game_balance').catch(e => console.error('还原热更失败:', e.message));
    }

    const restored = await status(token);
    check(
        'C3 还原文件后再热更一次，阈值回到文件里的值（也证明 C1 不是只读了一次就定死）',
        !!restored.state
            && restored.state.config.api.limit === fileConfig.rate_limit.api.limit
            && restored.state.config.action.window_seconds === fileConfig.rate_limit.action.window_seconds,
        `generation=${restored.state?.generation} 生效阈值=${JSON.stringify(restored.state?.config || null)}`
    );
    const dirtyFiles = [...CONFIG_BACKUPS.keys()].filter(f => !fs.readFileSync(f).equals(CONFIG_BACKUPS.get(f)));
    check(
        `C4 探针结束时 ${CONFIG_BACKUPS.size} 份被临时改过的配置文件逐字节回到原样（没把仓库留下改动）`,
        dirtyFiles.length === 0,
        dirtyFiles.map(f => path.basename(f)).join(', ') || '全部一致'
    );

    if (created) await Player.destroy({ where: { id: admin.id } });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    // process.on('exit') 里那份兜底会还原配置文件；这里只负责把错误露出来
    console.error('探针自身失败:', error);
    await sequelize.close().catch(() => {});
    process.exit(2);
});
