/**
 * 只读接口冒烟探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要有这个脚本：jest 套件刻意不连库、也不走 HTTP，于是
 *   ReferenceError: ownedRows is not defined（功法面板 500）
 *   ReferenceError: realmRank is not defined（战力接口 500）
 * 这类"只有真实数据走到那一行才炸"的缺陷，几百个用例全绿也照样留给玩家。
 * 这里把 app 上注册的所有 GET 接口逐个真实请求一次，500 一律判失败。
 *
 * 只打 GET：按 HTTP 语义 GET 不该改状态。若某个 GET 实际有副作用，
 * 那是接口设计问题，应该改接口而不是改这里。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_http_gets.js [playerId]
 *       单独跑某一段：node --env-file=.env scripts/smoke_http_gets.js 1 api/fishing
 *       （筛选参数**别带开头的斜杠**：Git Bash 会把 `/api/x` 改写成 `C:/Program Files/Git/api/x`，
 *        以前这样传会静默变成"0 条目标、退出码 0"的假绿 —— 现在这种输入直接红。）
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5099);
process.env.PORT = String(PORT);
// 全量跑时的底线：路由表 250 上下（实测 2026-09-22：整棵树 307 条 GET、去掉 admin 与 changelog 后 251）。
// 没有这条底线，"挂载没完成/express 换了形状"会伪装成"一条都没失败"。
const MIN_TARGETS = 200;

const { app } = require('../index');
const Player = require('../models/player');
const { bootApp, collectRoutes, request, mintToken } = require('./lib/smoke_http');
const { ensureRichPlayer } = require('./lib/richPlayer');

const playerId = Number(process.env.SMOKE_PLAYER || process.argv[2] || 1);
const filter = process.argv[3] || null;

/** 参数位填 1：够走通绝大多数"按 id 查"的分支，取不到数据返回 4xx 也算通过 */
function materialize(path) {
    return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '1');
}

(async () => {
    await bootApp(app, { port: PORT });

    const player = await Player.findByPk(playerId);
    if (!player) {
        console.error(`找不到玩家 ${playerId}`);
        process.exit(2);
    }
    const token = mintToken(player);

    const stack = (app._router || app.router)?.stack || [];
    const beforeFilter = collectRoutes(stack, '', ['get'])
        .map(r => r.path)
        .filter(p => p.startsWith('/api'))
        .filter(p => !/^\/api\/admin/.test(p))
        .filter(p => !/changelog|github/.test(p))
        .map(materialize);
    const targets = beforeFilter
        .filter(p => !filter || p.includes(filter))
        .sort();
    // 一条都没匹配到 ≠ "全绿"：以前按文档写法 `… 1 /api/technique` 传进来会被 Git Bash 改写成
    // `C:/Program Files/Git/api/technique`（MSYS 的路径转换），于是 0 条目标、0 条失败、退出码 0 ——
    // 一份"看起来跑过了"的空结果。所以：带筛选却没匹配到 = 直接红，并告诉你它到底收到了什么。
    if (filter && !targets.length) {
        console.error(`筛选条件没匹配到任何接口：收到的是 ${JSON.stringify(filter)}`);
        console.error('（Git Bash 会把 /api/xxx 改写成 C:/Program Files/Git/api/xxx —— 传参时写成 api/xxx 即可）');
        console.error(`可选：${[...new Set(beforeFilter)].slice(0, 8).join(' ')}`);
        process.exit(2);
    }
    if (!filter && targets.length < MIN_TARGETS) {
        console.error(`只收到 ${targets.length} 条 GET 接口（底线 ${MIN_TARGETS}）—— 路由没挂全或 express 挂载方式变了，别看成"都通过了"`);
        process.exit(2);
    }
    if (filter) console.log(`[筛选 ${filter}] 匹配到 ${new Set(targets).size} 条`);

    async function runPass(label, passToken, coverage = null) {
        const failures = [];
        const skipped = [];
        const locked = [];
        for (const path of [...new Set(targets)]) {
            const res = await request({ port: PORT, path, token: passToken });
            if (coverage) {
                // "200" 不等于"走到了有数据的分支"：空号跑出来的 200 可能全是空数组。
                // 每个关键接口用自己的取数方式数条目（背包是数组、装备是按槽位分的对象），
                // 状态码一起记，因为"被 4xx 挡了"和"返回了空列表"是两种不同的退化。
                for (const check of coverage.checks) {
                    if (!check.re.test(path)) continue;
                    let volume = 0;
                    try { volume = check.count(JSON.parse(res.raw.toString())) || 0; } catch (e) { /* 非 JSON */ }
                    coverage.seen.set(check.key, { status: res.status, volume });
                }
            }
            // 状态码之外还要看回执文本：服务层普遍写着 `catch (err) { return {success:false, message:'…服务器内部错误'} }`，
            // 于是被吞掉的 ReferenceError 在 HTTP 上是一个 200/400 的正常响应 —— 只看 5xx 的判据结构上抓不到它
            // （`_rollFish` 那一处就是这么躲过一整轮的，见 scripts/smoke_fishing_flow.js 的开头）。
            const swallowedError = /内部错误|服务器错误|Internal Server Error/i.test(String(res.raw || ''));
            if (res.status >= 500 || res.status === 0 || swallowedError) {
                failures.push({
                    path, status: res.status,
                    body: (swallowedError && res.status < 500 ? '[吞掉的异常：回执里写着内部错误] ' : '')
                        + String(res.raw).slice(0, 200)
                });
                console.log(`${label}FAIL  ${res.status}  ${path}`);
            } else if (res.status === 404 && /\/1$/.test(path)) {
                skipped.push(path);
            } else {
                if (res.status === 401 || res.status === 403) locked.push(path);
                console.log(`${label}ok    ${res.status}  ${path}`);
            }
        }
        return { failures, skipped, locked };
    }

    const first = await runPass('', token);
    const failures = [...first.failures];
    const skipped = first.skipped;
    let locked = first.locked;

    // ===== 第二遍：换一个"身上真的有内容"的玩家再打一遍 =====
    // 玩家 1 是空号：没有功法行、没有装备、背包是空的，于是所有
    //   list.map(row => row.config.xxx)
    // 这类"只有真的有数据才会走到"的行从来没被执行过 ——
    // TechniqueService.getPlayerTechniques 调用根本不存在的 getMpCost，就是靠这个空档
    // 让 248 条 GET 一直全绿，而任何有功法的玩家开面板都是 500。
    const rich = await ensureRichPlayer(playerId);
    if (!rich) {
        console.log('\n[有内容玩家] 连探针号都造不出来（功法/物品基础数据缺失？），这一遍没跑');
    } else {
        const c = rich.richCounts;
        console.log(`\n[有内容玩家] 用 ${rich.username}(#${rich.id}：物品 ${c.items}、功法 ${c.techs}、装备 ${c.equips}) 再打一遍`);
        // 这几个接口是"有内容才会执行到 map 里那一行"的典型；
        // 它们若返回空数组，说明这一遍其实又退化成空号了 —— 必须当场报，而不是继续全绿
        // 带筛选跑的是"只打这一段"，那三条关键接口可能压根不在这一批里 —— 这时不判覆盖，
        // 否则会报一条假的"覆盖不足"（判据不能因为调用者缩小了范围就自己变红）
        const coverage = filter ? null : {
            checks: [
                { key: '功法面板', re: /\/api\/technique\/list$/, count: d => (d?.data?.owned || []).length },
                // 路由表里根路径带尾斜杠（/api/inventory/），判据要容得下带与不带两种
                { key: '背包列表', re: /\/api\/inventory\/?$/, count: d => (d?.data?.items || []).length },
                { key: '装备槽位', re: /\/api\/equipment\/?$/, count: d => Object.keys(d?.data?.slots || {}).length }
            ],
            seen: new Map()
        };
        const second = await runPass('rich ', mintToken(rich), coverage);
        failures.push(...second.failures);
        locked = [...new Set([...locked, ...second.locked])];
        const keys = coverage.checks.map(c => c.key);
        const report = (key) => {
            const hit = coverage.seen.get(key);
            return hit ? `${key}=${hit.status}/${hit.volume}条` : `${key}=接口没匹配到`;
        };
        const emptyKeys = keys.filter(k => !(coverage.seen.get(k)?.volume > 0));
        console.log('  关键接口是否真的走到了有数据的分支：' + keys.map(report).join('、'));
        if (emptyKeys.length) {
            failures.push({
                path: `[覆盖不足] ${emptyKeys.join('、')}`,
                status: 0,
                body: '这些接口在"有内容玩家"那一遍里没有返回任何数据条目，等于没测到（要么被 4xx 挡了，要么数据分支是空的）'
            });
        }
        console.log(`\n[有内容玩家] ${new Set(targets).size} 条里 ${second.failures.length} 条 5xx`);
    }

    // 管理员视角复打一遍被 401/403 挡住的接口：普通玩家 token 走不进 handler 函数体，
    // 于是"ownedRows is not defined"那一类只在管理员页面上炸的缺陷以前完全没人碰。
    // 这一遍目前只报数、不参与退出码：现网管理接口本来就欠着一批修复，
    // 一次性改成严格判定只会让整条探针常亮红，反而看不出新增的那条是不是坏了。
    const admin = await Player.findOne({ where: { role: 'admin' } });
    let adminFailures = [];
    if (!admin) {
        console.log(`\n[管理员复打] 库里没有 role=admin 的玩家，${locked.length} 条管理员接口没被任何测试执行过`);
    } else {
        const adminToken = mintToken(admin);
        console.log(`\n[管理员复打] 用 ${admin.username} 的 token 重打 ${locked.length} 条`);
        for (const path of locked) {
            const res = await request({ port: PORT, path, token: adminToken });
            if (res.status >= 500 || res.status === 0) {
                adminFailures.push({ path, status: res.status, body: String(res.raw).slice(0, 200) });
                console.log(`admin-FAIL  ${res.status}  ${path}`);
            } else {
                console.log(`admin-ok    ${res.status}  ${path}`);
            }
        }
        console.log(`\n[管理员复打] ${locked.length} 条里 ${adminFailures.length} 条 5xx（不计入退出码，待逐个修）`);
        for (const f of adminFailures) console.log(`  ${f.path} -> ${f.status} ${f.body}`);
    }

    const total = new Set(targets).size;
    console.log(`\n${total} 条 GET × ${rich ? 2 : 1} 个玩家（空号 + 有内容号），${failures.length} 条失败，${skipped.length} 条因无数据跳过`);
    for (const f of failures) console.log(`  ${f.path} -> ${f.status} ${f.body}`);
    process.exit(failures.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
