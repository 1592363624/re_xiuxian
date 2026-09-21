/**
 * "物品名字随载荷出发"的接口探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：掉落/奖励/切石产出在库里只是引用（item_key / item_id），
 * 现在改成"出参那一刻按 item_data 补 item_name"（server/game/items/itemNaming.js）。
 * 这件事有两种失败方式，jest 都看不见：
 *   ① 补名字的那一行没跑到（服务没初始化、字段名写错、只补了 HTTP 漏了 WS）→ 界面照旧印裸键；
 *   ② 补得太早（把名字写进了库）→ 资料片改一次 item_data，历史记录里全是过期名字。
 * 所以本探针两头都断言：响应里必须有中文名，落库那份必须没有。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_item_names.js
 * 会写库（专用探针号 itemprobe01 的历练行、背包、赌石记录），不碰别的玩家。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5087);
process.env.PORT = String(PORT);

const { app } = require('../index');
const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerAdventure = require('../models/playerAdventure');
const PlayerAscension = require('../models/playerAscension');
const GamblingStoneService = require('../game/services/GamblingStoneService');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;
const { bootApp, request, mintToken } = require('./lib/smoke_http');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 物品引用列表是否每条都带上中文名（空数组算通过，由调用方另外断言"真的出现过物品"） */
function allNamed(list) {
    return Array.isArray(list) && list.every(i => typeof i.item_name === 'string' && i.item_name.length > 0);
}

async function probePlayer() {
    let player = await Player.findOne({ where: { username: 'itemprobe01' } });
    if (!player) {
        player = await Player.create({
            username: 'itemprobe01',
            password: 'not-a-real-hash',
            nickname: '物品名探针',
            realm: '化神10层',
            realm_rank: 32
        });
    }
    // 赌石要花钱，给足
    await Player.update({ spirit_stones: '99999999' }, { where: { id: player.id } });
    // 神识切要大衍诀 1 层（它是"必出稀有"的切法，让下面的探针不必赌运气）
    const asc = await PlayerAscension.findOne({ where: { player_id: player.id } })
        || await PlayerAscension.create({ player_id: player.id });
    if (Number(asc.dayan_level || 0) < 3) {
        asc.dayan_level = 3;
        await asc.save();
    }
    return Player.findByPk(player.id);
}

/** 播一条"已到期"的历练：end_time 在过去 → 不打折，奖励原样结算 */
async function seedAdventure(playerId, itemKeys) {
    await PlayerAdventure.destroy({ where: { player_id: playerId, status: 'in_progress' } });
    const now = Date.now();
    return PlayerAdventure.create({
        player_id: playerId,
        map_id: 1,
        map_name: '物品名探针图',
        event_id: 'smoke_item_names',
        event_type: 'treasure',
        event_data: JSON.stringify({
            rewards: { exp: 100, spirit_stones: 100, items: itemKeys },
            duration_type: 'short',
            reward_multiplier: 1.0
        }),
        start_time: new Date(now - 2 * 60 * 1000),
        end_time: new Date(now - 60 * 1000),
        status: 'in_progress'
    });
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await probePlayer();
    const token = mintToken(player);

    // ── 1. 历练完成：出参带名字，落库只带引用 ──────────────────────────────
    // 用的两个 key 都来自 spirit_nursery 资料片：解析得动，才证明名字接在合并视图上。
    const adventure = await seedAdventure(player.id, ['zi_yun_shen', 'ju_yuan_dan']);
    const done = await request({ port: PORT, method: 'POST', path: '/api/map/explore/complete', token });
    const rewards = done.body?.data?.rewards;
    const gained = rewards?.items || [];
    check('历练完成：奖励物品每条都有 item_name',
        done.status === 200 && gained.length === 2 && allNamed(gained),
        `status=${done.status} 奖励=${JSON.stringify(gained).slice(0, 200)}`);
    check('历练完成：资料片物品的中文名真的到了线上',
        gained.some(i => i.item_name === '紫云参') && gained.some(i => i.item_name === '聚元丹'),
        `拿到=${gained.map(i => `${i.item_key}→${i.item_name}`).join(', ')}`);

    const stored = await PlayerAdventure.findByPk(adventure.id);
    const storedRewards = stored?.rewards || '';
    check('落库那份仍只是引用（名字没被冻进历史）',
        storedRewards.includes('zi_yun_shen') && !storedRewards.includes('item_name'),
        `rewards=${String(storedRewards).slice(0, 200)}`);
    await stored.destroy();

    // ── 2. 赌石：切石响应 + 历史记录两条读路都要有名字 ─────────────────────
    const methods = GamblingStoneService.cutMethodKeys();
    const pool = configLoader.getConfig('gambling_stone_data')?.cut_methods || {};
    // 优先挑"必出稀有"的切法：让"至少切出过一次物品"这件事不靠运气
    const method = methods.find(k => pool[k]?.guarantee_rare) || methods[0];
    let sawItem = false, payloadOk = true, firstDetail = '';
    for (let round = 0; round < 10 && !sawItem; round++) {
        await request({ port: PORT, method: 'POST', path: '/api/gambling-stone/generate', token });
        const stones = await request({ port: PORT, method: 'GET', path: '/api/gambling-stone/stones', token });
        const list = stones.body?.data?.stones || stones.body?.data || [];
        const uncut = (Array.isArray(list) ? list : []).find(s => !s.is_cut && s.id);
        if (!uncut) continue;
        const cut = await request({ port: PORT, method: 'POST', path: '/api/gambling-stone/cut', token,
            body: { stone_id: uncut.id, cut_method: method } });
        const items = cut.body?.data?.yield?.items || [];
        if (items.length) {
            sawItem = true;
            payloadOk = allNamed(items);
            firstDetail = JSON.stringify(items).slice(0, 200) + ` 消息=${String(cut.body?.message).slice(0, 120)}`;
        } else if (cut.status !== 200) {
            firstDetail = `status=${cut.status} ${JSON.stringify(cut.body).slice(0, 200)}`;
            break;
        }
    }
    check('切石：确实切出过物品（不然下面这条是空断言）', sawItem, `切法=${method} 详情=${firstDetail}`);
    check('切石：产出物品带 item_name', sawItem && payloadOk, firstDetail);
    check('切石：结果消息里是名字不是键名（这条文本会进玩家日志和 WS）',
        sawItem && !/[A-Za-z_]+×/.test(firstDetail.split('消息=')[1] || ''), firstDetail.split('消息=')[1] || '');

    const records = await request({ port: PORT, method: 'GET',
        path: '/api/gambling-stone/records?page=1&page_size=20', token });
    const rows = records.body?.data?.records || [];
    const withItems = rows.map(r => r.yield?.items || []).filter(list => list.length);
    check('历史：从库里读回来的产出也补上了名字（另一条读路）',
        records.status === 200 && withItems.length > 0 && withItems.every(allNamed),
        `status=${records.status} 有物品记录=${withItems.length} 首条=${JSON.stringify(withItems[0] || {}).slice(0, 160)}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n== 物品名出参探针：${results.length - failed.length}/${results.length} 通过 ==`);
    for (const f of failed) console.log(`未通过：${f.name}`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(err => {
    console.error('探针异常：', err);
    process.exit(1);
});
