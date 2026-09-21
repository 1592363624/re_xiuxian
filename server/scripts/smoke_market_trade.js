/**
 * 货摊换物（挂单 / 成交 / 下架）：物品只许转移，不许凭空多出或消失（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要单独一个：MarketService 与 InventoryService 是玩家之间搬东西的门，之前一条探针都没有，
 * 而 buyListing 改造前的取锁次序是"挂单 → 买家背包行 → 买家 players →（addItem 里）卖家背包行 → 卖家 players"，
 * 卖家同时在用同一枚丹药走的却是 players → items（背包面板 useItem）—— 两个活跃玩家同时交易就能凑出跨玩家 ABBA。
 * 现在两边都先按主键升序把**双方**的 players 行锁齐（口径见 game/persistence/lockOrder.js），
 * 次序差分的硬证据在 scripts/smoke_lock_order_matrix.js（players↔items 那一对），这条探针管的是**货还对不对**：
 * 上架把物品收进挂单、成交按声明数双向搬运、下架原样退回、重放那一笔必须被拒且说得清原因。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_market_trade.js
 * 只用自建探针号 mkt_s1/s2 与三件现成丹药，跑完删干净。
 */
'use strict';

// 必须在 require('../index') 之前定端口：index.js 加载时就 server.listen(PORT)，晚一步会去抢 :5000。
const PORT = Number(process.env.SMOKE_PORT || 5097);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const Item = require('../models/item');
const MarketListing = require('../models/marketListing');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const InventoryService = require('../game/services/InventoryService');
const MarketService = require('../game/services/MarketService');

const ACCOUNTS = ['mkt_s1', 'mkt_s2'];
const HIGH = 'high_healing_pill';   // 大还丹 参考价 200
const MID = 'mid_healing_pill';     // 小还丹 参考价 50  → 1 大还丹 换 4 小还丹，正好卡在价格锚定上
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const reasonOf = e => `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`.slice(0, 80);

async function ensurePlayer(username) {
    let p = await Player.findOne({ where: { username } });
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `货摊探针${username.slice(-1)}`,
            realm: '炼气3层', realm_rank: 3, exp: 0, spirit_stones: 1000,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    }
    await Item.destroy({ where: { player_id: p.id, item_key: { [Op.in]: [HIGH, MID] } }, force: true });
    return Player.findByPk(p.id);
}

async function qty(playerId, itemKey) {
    const row = await Item.findOne({ where: { player_id: playerId, item_key: itemKey }, raw: true });
    return Number(row?.quantity || 0);
}

/** 这两个探针号名下 + 所有挂单里的托管量：转移只能在盒子里挪，总量不该变 */
async function worldTotal(playerIds, itemKey) {
    const inBags = await Item.sum('quantity', { where: { item_key: itemKey, player_id: { [Op.in]: playerIds } } }) || 0;
    const escrow = (await MarketListing.sum('quantity', {
        where: { item_key: itemKey, status: 'active', seller_id: { [Op.in]: playerIds } }
    })) || 0;
    return Number(inBags) + Number(escrow);
}

async function give(playerId, itemKey, quantity) {
    return InventoryService.addItem(playerId, itemKey, quantity, null, null, { allowUnknownItem: true });
}

async function main() {
    await bootApp(app, { port: PORT });
    if (typeof InventoryService.initialize === 'function') InventoryService.initialize(infrastructure.ConfigLoader);
    if (typeof MarketService.initialize === 'function') MarketService.initialize(infrastructure.ConfigLoader);

    const A = await ensurePlayer('mkt_s1');
    const B = await ensurePlayer('mkt_s2');
    const ids = [A.id, B.id];

    await give(A.id, HIGH, 3); await give(A.id, MID, 4);
    await give(B.id, MID, 12); await give(B.id, HIGH, 1);
    const seedOk = await qty(A.id, HIGH) === 3 && await qty(B.id, MID) === 12;
    check('M0 探针背包发得出内容里真实存在的丹药（否则后面全是空跑）', seedOk,
        `A 大还丹=${await qty(A.id, HIGH)} B 小还丹=${await qty(B.id, MID)}`);
    if (!seedOk) return;

    // ===== 上架：物品从背包进挂单托管 =====
    const highBefore = await worldTotal(ids, HIGH);
    const create = await MarketService.createListing(A.id, HIGH, 1, MID, 4);
    const listingId = create.listing_id;
    check('M1 上架成功且物品进托管（背包少 1、挂单 active）',
        create.success === true && !!listingId && await qty(A.id, HIGH) === 2,
        `挂单=${listingId} A 大还丹=${await qty(A.id, HIGH)}`);

    // ===== 成交：双向搬运，总量不变 =====
    const midBefore = await worldTotal(ids, MID);
    const buy = await MarketService.buyListing(B.id, listingId);
    check('M2 成交按声明数双向搬运（买家 -4 小还丹 +1 大还丹，卖家 +4 小还丹）',
        buy.success === true && await qty(B.id, MID) === 8 && await qty(B.id, HIGH) === 2 && await qty(A.id, MID) === 8,
        `B 小=${await qty(B.id, MID)} B 大=${await qty(B.id, HIGH)} A 小=${await qty(A.id, MID)}`);
    check('M3 换物不印货：两件丹药的"背包 + 托管"总量与上架前完全一致',
        await worldTotal(ids, HIGH) === highBefore && await worldTotal(ids, MID) === midBefore,
        `大还丹 ${highBefore}→${await worldTotal(ids, HIGH)} 小还丹 ${midBefore}→${await worldTotal(ids, MID)}`);
    const soldRow = await MarketListing.findByPk(listingId);
    check('M4 挂单落到 sold 并记下买家（状态不写就等于物品没主人）',
        soldRow.status === 'sold' && Number(soldRow.buyer_id) === Number(B.id),
        `status=${soldRow.status} buyer=${soldRow.buyer_id}`);

    // ===== 重放那一笔必须被明确拒掉 =====
    let replayReason = '';
    try {
        await MarketService.buyListing(B.id, listingId);
    } catch (e) {
        replayReason = reasonOf(e);
    }
    check('M5 重买同一挂单被拒且说得出原因（不能既成交通知两次）',
        /已交易|已下架/.test(replayReason) && await qty(B.id, MID) === 8 && await qty(B.id, HIGH) === 2,
        `原因=${replayReason || '（没拒）'}`);

    // ===== 跨玩家并发：两边各挂一单，同时去买对方的（正是 players 双向锁的形状） =====
    await MarketService.createListing(A.id, HIGH, 1, MID, 4);
    const bListing = await MarketService.createListing(B.id, HIGH, 1, MID, 4);
    const aListing = (await MarketListing.findOne({
        where: { seller_id: A.id, status: 'active', item_key: HIGH }
    })).id;
    const beforeHigh = await worldTotal(ids, HIGH);
    const beforeMid = await worldTotal(ids, MID);
    const raced = await Promise.all([
        MarketService.buyListing(B.id, aListing).then(r => `B买A:${r.success ? 'ok' : 'fail'}`).catch(e => `B买A[${reasonOf(e)}]`),
        MarketService.buyListing(A.id, bListing.listing_id).then(r => `A买B:${r.success ? 'ok' : 'fail'}`).catch(e => `A买B[${reasonOf(e)}]`)
    ]);
    check('M6 两个玩家互买对方的挂单并发：谁都不许以死锁收场',
        !raced.some(x => /Deadlock|lock wait timeout/i.test(x)), raced.join(' ;; '));
    check('M7 并发成交后货还是那些（两笔都成或一笔被拒，都不许多出物品）',
        await worldTotal(ids, HIGH) === beforeHigh && await worldTotal(ids, MID) === beforeMid,
        `大还丹 ${beforeHigh}→${await worldTotal(ids, HIGH)} 小还丹 ${beforeMid}→${await worldTotal(ids, MID)}｜${raced.join(' ; ')}`);

    // ===== 下架：托管的物品原样退回（自己造一条挂单，不许借 M6 剩下的 —— 剩不下就成了空跑） =====
    const cancelWant = (await worldTotal(ids, HIGH)) + (await worldTotal(ids, MID));
    let listingForCancel = null;
    let cancelErr = '';
    try {
        listingForCancel = await MarketService.createListing(A.id, HIGH, 1, MID, 4);
    } catch (e) {
        cancelErr = reasonOf(e);
    }
    const aHigh = await qty(A.id, HIGH);
    if (listingForCancel && listingForCancel.success === true && listingForCancel.listing_id) {
        await MarketService.cancelListing(A.id, listingForCancel.listing_id);
        check('M8 下架把托管物品退回卖家背包，不多不少',
            await qty(A.id, HIGH) === aHigh + 1
            && await worldTotal(ids, HIGH) + await worldTotal(ids, MID) === cancelWant,
            `退 1 件：${aHigh}→${await qty(A.id, HIGH)} 总量 ${cancelWant}→${await worldTotal(ids, HIGH) + await worldTotal(ids, MID)}`);
    } else {
        check('M8 下架把托管物品退回卖家背包，不多不少', false,
            `挂单没建出来：${cancelErr || JSON.stringify(listingForCancel).slice(0, 60)}`);
    }
    check('M9 探针自己的挂单都已收尾（sold/cancelled），不污染别人的货摊',
        (await MarketListing.count({ where: { seller_id: { [Op.in]: ids }, status: 'active' } })) === 0,
        `残留 active=${await MarketListing.count({ where: { seller_id: { [Op.in]: ids }, status: 'active' } })}`);
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (e) {
        hard = 1;
        console.error('探针异常：', e.message, e.stack);
    } finally {
        try {
            for (const username of ACCOUNTS) {
                const p = await Player.findOne({ where: { username } });
                if (!p) continue;
                await MarketListing.destroy({ where: { seller_id: p.id }, force: true });
                await MarketListing.destroy({ where: { buyer_id: p.id }, force: true });
                await Item.destroy({ where: { player_id: p.id }, force: true });
                await Player.destroy({ where: { id: p.id }, force: true });
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
