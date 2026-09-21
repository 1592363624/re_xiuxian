/**
 * 更新日志面板探针（不需要 MySQL，但需要能起进程）
 *
 * 验的是"第三方不可达时不许把玩家可见面板打成 500"这一条：
 *   - 面板本身自带一份编辑好的版本说明（client/src/data/changelog.ts），GitHub 提交列表只是补充；
 *   - 改造前：内存缓存是唯一兜底，进程重启后第一次请求若 GitHub 不可达就 `next(AppError 500)`，
 *     而客户端响应拦截器对 500 一定弹一条"服务器错误，请稍后重试"的红字。
 *   - 顺带修掉两个契约错：内存命中时返回的是**裸数组**（其余分支是 {code,data}），
 *     以及客户端把信封 `res.data` 当数组用 —— 那份提交列表从来没显示出来过。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_changelog.js
 *       探针把 axios.get 换成"必然失败"，所以不依赖外网，结果可复现。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5091);
process.env.PORT = String(PORT);

const { app } = require('../index');
const axios = require('axios');
const sequelize = require('../config/database');
const { bootApp, request } = require('./lib/smoke_http');

const CACHE_FILE = path.join(os.tmpdir(), 're_xiuxian_changelog_cache.json');
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

const originalGet = axios.get;
function breakNetwork(message = 'simulated unreachable') {
    axios.get = async () => { throw new Error(message); };
}

async function get(endpoint = '/api/system/changelog') {
    return request({ port: PORT, method: 'GET', path: endpoint });
}

(async () => {
    await bootApp(app, { port: PORT });
    fs.rmSync(CACHE_FILE, { force: true });

    // 1) 什么缓存都没有 → 仍然 200，交空列表，绝不 500（客户端会自己显示本地版本说明）
    //    顺序有讲究：这次必须在读磁盘缓存之前跑 —— 上一次降级会把结果记进内存缓存，反过来就测不到空态了
    fs.rmSync(CACHE_FILE, { force: true });
    breakNetwork();
    const empty = await get();
    check('C1 完全没缓存时返回空列表而不是 500（不再弹"服务器错误"）',
        empty.status === 200 && empty.body?.code === 200 && empty.body?.source === 'unavailable'
            && Array.isArray(empty.body?.data) && empty.body.data.length === 0,
        `status=${empty.status} body=${JSON.stringify(empty.body || empty.raw).slice(0, 120)}`);

    // 2) 三方不可达 + 有磁盘缓存 → 用磁盘缓存，200，形状仍是信封
    fs.writeFileSync(CACHE_FILE, JSON.stringify([
        { sha: 'dead001', message: 'cache hit', date: '2026-01-01T00:00:00Z', author: 'Shell', url: 'https://example.invalid/1' }
    ]));
    const cached = await get();
    check('C2 三方不可达时用磁盘缓存兜底（source=disk_cache）',
        cached.status === 200 && cached.body?.code === 200 && cached.body?.source === 'disk_cache'
            && cached.body?.data?.[0]?.sha === 'dead001',
        `status=${cached.status} source=${cached.body?.source} 条数=${Array.isArray(cached.body?.data) ? cached.body.data.length : '-'}`);

    // 3) 两次降级都必须走同一个信封形状（改造前内存命中会直接吐裸数组，客户端读法不一致）
    check('C3 所有分支都回 { code, data } 信封',
        [cached, empty].every(r => r.body && !Array.isArray(r.body) && r.body.code === 200 && Array.isArray(r.body.data)),
        `${cached.status}/${empty.status}`);

    // 4) 网络正常时这一路也要通（真打 GitHub；不可达时只记录来源，不判失败——不可达的情况 C1/C2 已经钉住）
    axios.get = originalGet;
    const live = await get();
    check('C4 线上拉取不改变响应契约（200 + 信封 + 数组）',
        live.status === 200 && live.body?.code === 200 && Array.isArray(live.body?.data),
        `status=${live.status} source=${live.body?.source} 条数=${live.body?.data?.length ?? '-'}`);

    fs.rmSync(CACHE_FILE, { force: true });
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    axios.get = originalGet;
    console.error('探针自身失败:', error);
    process.exit(2);
});
