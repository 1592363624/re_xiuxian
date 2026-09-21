/**
 * 状态快照探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要有这个：17 个 registrations 的 getSnapshot / getActiveState 各自把异常 console.warn 一下
 * 就返回"空快照"。于是"SQL 里写了个不存在的列名"这类缺陷既不会变 500、也不会让 jest 变红，
 * 只会让玩家的状态永远显示成"什么都没干"——而状态机认为玩家空闲，就允许他再开一个独占状态。
 *
 * 实测（re_xiuxian_test）：adventure.js 里 `order: [['created_at','DESC']]` 每次执行都抛
 * `Unknown column 'PlayerAdventure.created_at' in 'order clause'` —— 该表只有 createdAt/updatedAt
 * （模型没开 underscored）。这一句从来没成功过，日志里每个探针都能看到那两行 warn，却没有门禁为它变红。
 *
 * 所以这里把两件事钉死：
 *   1) 17 个处理器的两条读路径跑一遍，任何被 catch 吞掉的告警都判失败；
 *   2) 先给探针号塞一条 in_progress 历练记录，断言快照真的读到了它
 *      （否则 is_adventuring=false 可能只是因为没数据 —— 空断言）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_state_snapshots.js
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5094);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerAdventure = require('../models/playerAdventure');
const sequelize = require('../config/database');
const registry = require('../game/state/StateRegistry');
const { registerAllStates } = require('../game/state');
const { PlayerState } = require('../game/state/PlayerStateMachine');
const { bootApp } = require('./lib/smoke_http');

const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 捕获被 catch 吞掉的告警：这些文案是 registrations 里 catch 分支的固定前缀 */
async function captureWarnings(fn) {
    const swallowed = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
        const line = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ');
        if (/失败/.test(line)) swallowed.push(line);
    };
    try {
        const value = await fn();
        return { value, swallowed };
    } finally {
        console.warn = originalWarn;
    }
}

async function ensureProbePlayer() {
    let player = await Player.findOne({ where: { username: 'snapprobe' } });
    if (!player) {
        player = await Player.create({
            username: 'snapprobe',
            password: 'not-a-real-hash',
            nickname: '快照探针',
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
    }
    await PlayerAdventure.destroy({ where: { player_id: player.id } });
    return player;
}

(async () => {
    await bootApp(app, { port: PORT });
    // 起服务时 index.js 已经注册过一轮；这里只兜住"没注册"的情况，别重复注册
    if (!registry.list().length) registerAllStates();
    const handlers = registry.list();
    const player = await ensureProbePlayer();

    check(
        'S0 全部状态处理器都已注册，且都实现了 getSnapshot / getActiveState',
        handlers.length >= 17 && handlers.every(h => typeof h.handler.getSnapshot === 'function'
            && typeof h.handler.getActiveState === 'function'),
        `${handlers.length} 个处理器：${handlers.map(h => h.stateType).join(', ')}`
    );

    // ===== S1：先塞一条进行中的历练，让后面的断言有东西可读 =====
    const seeded = await PlayerAdventure.create({
        player_id: player.id,
        map_id: 1,
        map_name: '探针地图',
        event_id: 'probe_event',
        event_type: 'discovery',
        event_data: '{}',
        status: 'in_progress',
        start_time: new Date(Date.now() - 60000),
        // 60 秒后才过期：既验"读得到"，又不会把 StateCleaner 的活抢过来做
        end_time: new Date(Date.now() + 60000),
        rewards_claimed: false
    });

    const { value: snap, swallowed: snapWarns } = await captureWarnings(
        () => registry.get('adventure').getSnapshot(player.id)
    );
    check(
        'S1 正在历练的玩家，快照真的读到了那条记录（不是"没数据所以 false"）',
        snapWarns.length === 0 && snap && snap.is_adventuring === true
            && Number(snap.adventure_id) === Number(seeded.id)
            && snap.map_name === '探针地图' && snap.remaining_seconds > 0,
        `快照=${JSON.stringify(snap)}${snapWarns.length ? ` | 被吞掉的告警: ${snapWarns.join(' | ')}` : ''}`
    );

    const { value: active, swallowed: activeWarns } = await captureWarnings(
        () => registry.get('adventure').getActiveState(player.id)
    );
    check(
        'S2 激活状态查询同样读到该状态',
        activeWarns.length === 0 && active === PlayerState.ADVENTURING,
        `getActiveState=${active}${activeWarns.length ? ` | 被吞掉的告警: ${activeWarns.join(' | ')}` : ''}`
    );

    // ===== S3：17 个处理器的两条读路径全跑一遍，任何被 catch 吞掉的告警都判失败 =====
    const offenders = [];
    for (const { stateType, handler } of handlers) {
        const { swallowed } = await captureWarnings(async () => {
            await handler.getSnapshot(player.id);
            await handler.getActiveState(player.id);
        });
        for (const line of swallowed) offenders.push(`${stateType}: ${line}`);
    }
    check(
        `S3 ${handlers.length} 个状态处理器的读路径没有一个被 catch 悄悄吞掉`,
        offenders.length === 0,
        offenders.slice(0, 4).join(' | ') || '全部干净'
    );

    // ===== S4：删掉记录后必须读成 false（证明 S1 不是写死的 true）=====
    await PlayerAdventure.destroy({ where: { id: seeded.id } });
    const { value: afterSnap, swallowed: afterWarns } = await captureWarnings(
        () => registry.get('adventure').getSnapshot(player.id)
    );
    check(
        'S4 记录清掉后快照读成"不在历练"（S1 不是硬编码）',
        afterWarns.length === 0 && afterSnap && afterSnap.is_adventuring === false,
        `快照=${JSON.stringify(afterSnap)}`
    );

    await PlayerAdventure.destroy({ where: { player_id: player.id } });
    await Player.destroy({ where: { id: player.id } });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    await sequelize.close().catch(() => {});
    process.exit(2);
});
