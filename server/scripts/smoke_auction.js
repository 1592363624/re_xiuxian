/**
 * 拍卖（AuctionService）：灵石冻结/退还/成交三笔账必须对得上（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要这条：AuctionService 此前运行时零覆盖，而它一个 placeBid 里就按"竞价者 → 前一个竞价者"
 * 这个业务次序**串行**锁两行 players，cancelAuction 按"当前竞价者 → 卖家"同样锁两行。
 * 拍卖行本身是先锁的，但两个人分别在**两场不同的拍卖**里互相顶价时两笔事务锁的不是同一条拍卖行 ——
 * 没有任何东西挡住 A→B 与 B→A 同时发生，这就是同表这一类（跨表普查看不见，见 SAME_TABLE_DEBT）。
 * A12/A13 两条并发腿量的就是这个：改前实测多少次 Deadlock 就写多少次，改后必须为 0。
 * 形状本身的确定性证据在 scripts/smoke_lock_order_matrix.js（players 同表两行），这里管的是**真能走到**。
 *
 * 顺带查出并修掉的两笔账（都是这条探针实测出来的，不是读代码读出来的）：
 *   - A15c：卖家余额不够付撤销补偿费时，改前照样把整笔费用记给竞价者 —— 差额是凭空印出来的灵石；
 *   - A17：bidder.max_concurrent_bids 只写在 routes/auction.js 的接口文档里，服务从来没读它（死配置键）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_auction.js
 * 只用自建探针号 auc_s/auc_a/auc_b 与一件现成丹药，跑完删干净。
 */
'use strict';

// 必须在 require('../index') 之前定端口：index.js 加载时就 server.listen(PORT)，晚一步会去抢 :5000。
const PORT = Number(process.env.SMOKE_PORT || 5168);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const Item = require('../models/item');
const Auction = require('../models/auction');
const AuctionBid = require('../models/auctionBid');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const InventoryService = require('../game/services/InventoryService');
const AuctionService = require('../game/services/AuctionService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const NAMES = ['auc_s', 'auc_a', 'auc_b'];
const GOODS = 'mid_healing_pill';     // 小还丹：type=consumable，不在禁售清单里
const START = 200000;                  // 三人初始灵石
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; }; };
const isDeadlock = s => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK/i.test(s);
const reasonOf = e => `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`.slice(0, 120);

async function stones(id) { return N((await Player.findByPk(id, { attributes: ['spirit_stones'] })).spirit_stones); }
async function qty(id, key) {
    const row = await Item.findOne({ where: { player_id: id, item_key: key }, raw: true });
    return Number(row && row.quantity || 0);
}
/** 三只储物袋 + 还在拍/托管中的量：物品只能在这个盒子里挪 */
async function itemWorld(ids) {
    const inBags = (await Item.sum('quantity', { where: { item_key: GOODS, player_id: { [Op.in]: ids } } })) || 0;
    const escrow = (await Auction.sum('quantity', {
        where: { item_key: GOODS, status: 'open', seller_id: { [Op.in]: ids } }
    })) || 0;
    return Number(inBags) + Number(escrow);
}
async function pool(ids) {
    const rows = await Player.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['spirit_stones'] });
    return rows.reduce((s, p) => s + N(p.spirit_stones), 0n);
}
/** 冻结在拍卖里的钱：只有"当前最高竞价者"名下那一份是没退回来的 */
async function escrow(ids) {
    const rows = await Auction.findAll({
        where: { status: 'open', current_bidder_id: { [Op.in]: ids } },
        attributes: ['current_price']
    });
    return rows.reduce((s, r) => s + N(r.current_price), 0n);
}
/** 口袋里 + 冻结中：并发顶价最容易丢的就是这一格里的一笔钱 */
async function box(ids) { return await pool(ids) + await escrow(ids); }

async function seed(username) {
    let p = await Player.findOne({ where: { username } });
    const data = {
        realm: '筑基初期', realm_rank: 6, exp: 0, spirit_stones: START,
        hp_current: 80000, mp_current: 5000
    };
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `拍卖探针${username.slice(-1)}`,
            lifespan_current: 300, attributes: {}, token_version: 0, ...data
        });
    } else {
        await Player.update(data, { where: { id: p.id } });
    }
    return p;
}

/** 到期结算：把 end_at 推到过去，再手动调一次结算函数（30 秒一轮的调度器也可能抢先，结果应当完全一样） */
async function expireNow(auctionId) {
    await Auction.update({ end_at: new Date(Date.now() - 5000) }, { where: { id: auctionId } });
}

async function safe(fn) {
    try { const r = await fn(); return { ok: true, r }; } catch (e) { return { ok: false, why: reasonOf(e) }; }
}

async function main() {
    await bootApp(app, { port: PORT });
    InventoryService.initialize(infrastructure.ConfigLoader);
    AuctionService.initialize(infrastructure.ConfigLoader);

    const ids = [];
    for (const n of NAMES) ids.push((await seed(n)).id);
    const [S, A, Bb] = ids;
    // 这里的三条清的是**还活着**的号上一轮的残留（seed 是"有就复用"，不删 players 行），
    // 级联那扇门的语义是"连 players 行一起删"，用不上 —— 留着，且前两条按的是引用列。
    await AuctionBid.destroy({ where: { bidder_id: { [Op.in]: ids } }, force: true });
    await Auction.destroy({
        where: { [Op.or]: [{ seller_id: { [Op.in]: ids } }, { current_bidder_id: { [Op.in]: ids } }, { winner_id: { [Op.in]: ids } }] },
        force: true
    });
    await Item.destroy({ where: { player_id: { [Op.in]: ids }, item_key: GOODS }, force: true });
    await InventoryService.addItem(S, GOODS, 6, null, null, { allowUnknownItem: true });

    const itemBefore = await itemWorld(ids);
    check('A0 探针能发得出内容里真实存在的丹药（否则后面全是空跑）',
        await qty(S, GOODS) === 6 && itemBefore === 6,
        `S 储物袋=${await qty(S, GOODS)} 盒子里总量=${itemBefore}`);
    if (itemBefore !== 6) return;

    // ===== 上架：物品真实进托管 =====
    const c1 = await AuctionService.createAuction(S, GOODS, 2, 1000, 1);
    const p1 = c1.auction.id;
    const p1row = await Auction.findByPk(p1);
    check('A1 上架后物品从卖家储物袋进托管（盒子总量不变、当前价=起拍价、没有竞价者）',
        c1.success === true && await qty(S, GOODS) === 4 && await itemWorld(ids) === 6
        && Number(p1row.current_price) === 1000 && p1row.current_bidder_id === null && p1row.status === 'open',
        `S 储物袋=${await qty(S, GOODS)} 拍卖=${p1} 当前价=${p1row.current_price} 竞价者=${p1row.current_bidder_id}`);

    // ===== 竞价：冻结 → 被超越时原额退还 =====
    // 冻结的钱会离开"口袋"，所以账要用 口袋 + 冻结 这一格来对，不能只对口袋。
    const boxStart = N(START * 3);
    const b1 = await AuctionService.placeBid(A, p1, 1100);
    check('A2 首次竞价：只冻结出价人的灵石，别人一分不动',
        b1.success === true && await stones(A) === N(START - 1100) && await stones(Bb) === N(START)
        && await box(ids) === boxStart,
        `A=${await stones(A)} B=${await stones(Bb)} 格=${await box(ids)}`);

    const b2 = await AuctionService.placeBid(Bb, p1, 1200);
    check('A3 顶价：新出价的冻结额 + 前一个竞价者的**原额**退还，格子里总额不动',
        b2.success === true && await stones(Bb) === N(START - 1200) && await stones(A) === N(START)
        && await box(ids) === boxStart,
        `B=${await stones(Bb)} A=${await stones(A)}（A 应回到 ${START}）格=${await box(ids)}`);

    // ===== 校验链：三种非法出价都不能动钱 =====
    const before4 = { A: await stones(A), B: await stones(Bb), S: await stones(S) };
    const lowBid = await safe(() => AuctionService.placeBid(A, p1, 1210));   // 1200+max(60,10)=1260
    const poorBid = await safe(() => AuctionService.placeBid(A, p1, 5000000));
    const selfBid = await safe(() => AuctionService.placeBid(S, p1, 1300));
    check('A4 低于最小加价 / 灵石不足 / 竞拍自己的拍卖：三条都要被拒且说得清原因',
        !lowBid.ok && /至少/.test(lowBid.why) && !poorBid.ok && /不足/.test(poorBid.why)
        && !selfBid.ok && /自己/.test(selfBid.why),
        `低价=${lowBid.why} 没钱=${poorBid.why} 自买=${selfBid.why}`);
    check('A5 被拒的三次出价一分灵石都没动（拒绝不能顺手冻结）',
        await stones(A) === before4.A && await stones(Bb) === before4.B && await stones(S) === before4.S,
        `A=${await stones(A)} B=${await stones(Bb)} S=${await stones(S)}`);

    // ===== 防秒杀 =====
    await Auction.update({ end_at: new Date(Date.now() + 30000), extension_count: 0 }, { where: { id: p1 } });
    const b3 = await AuctionService.placeBid(A, p1, 1300);
    const p1r = await Auction.findByPk(p1);
    check('A6 结束前 30 秒内出价触发防秒杀：延长 60 秒、次数 +1（延长次数是钱之外的第二条账）',
        b3.success === true && Number(p1r.extension_count) === 1
        && new Date(p1r.end_at).getTime() > Date.now() + 55000,
        `次数=${p1r.extension_count} 剩余=${Math.round((new Date(p1r.end_at).getTime() - Date.now()) / 1000)} 秒`);

    // ===== 撤销：退还 + 补偿，只能发生一次 =====
    await Auction.update({ end_at: new Date(Date.now() + 3600000), extension_count: 0 }, { where: { id: p1 } });
    const leadRow = await Auction.findByPk(p1);
    const leaderId = Number(leadRow.current_bidder_id);      // A6 之后领先的是 A，不能再假设是 B
    const leadPrice = Number(leadRow.current_price);
    const otherId = leaderId === Number(A) ? Bb : A;
    const stBefore = { lead: await stones(leaderId), other: await stones(otherId), S: await stones(S) };
    const boxCancel = await box(ids);
    const cx = await AuctionService.cancelAuction(S, p1, '探针撤销');
    const fee = Math.floor(leadPrice * 0.02);       // cancel_fee_when_bidded = 0.02
    check('A7 有人竞价时撤销：冻结额原路退还 + 补偿费从卖家转给竞价者（格子里只搬不印）',
        cx.success === true && await stones(leaderId) === stBefore.lead + N(leadPrice + fee)
        && await stones(S) === stBefore.S - N(fee) && await stones(otherId) === stBefore.other
        && await box(ids) === boxCancel,
        `领先者 ${leaderId} 应 +${leadPrice + fee} 实得 ${await stones(leaderId) - stBefore.lead}  S 应 -${fee} 实得 ${await stones(S) - stBefore.S} 格 ${boxCancel}→${await box(ids)}`);
    check('A8 撤销后物品回到卖家（盒子总量依旧 6）且状态落 cancelled',
        await qty(S, GOODS) === 6 && await itemWorld(ids) === 6,
        `S 储物袋=${await qty(S, GOODS)} 总量=${await itemWorld(ids)}`);
    const cx2 = await safe(() => AuctionService.cancelAuction(S, p1, '再撤一次'));
    check('A9 重复撤销必须被拒，且不能再退一次钱（双退是这类账最常见的洞）',
        !cx2.ok && /已结束|无法撤销/.test(cx2.why)
        && await stones(leaderId) === stBefore.lead + N(leadPrice + fee) && await stones(S) === stBefore.S - N(fee)
        && await box(ids) === boxCancel,
        `原因=${cx2.why || '（没拒）'} 领先者=${await stones(leaderId)} S=${await stones(S)}`);

    // ===== 无人竞价时撤销：免费 =====
    const c2 = await AuctionService.createAuction(S, GOODS, 1, 500, 1);
    const stFree = { S: await stones(S), A: await stones(A) };
    const cx3 = await AuctionService.cancelAuction(S, c2.auction.id);
    check('A10 无人竞价的撤销免费且不产生任何补偿（补偿费只能来自真实竞价）',
        cx3.success === true && Number(cx3.compensation_fee) === 0
        && await stones(S) === stFree.S && await stones(A) === stFree.A,
        `补偿=${cx3.compensation_fee} S 变动=${await stones(S) - stFree.S}`);

    // ===== 到期成交：物品给得标者、钱给卖家、手续费是唯一出盒子的量 =====
    const c3 = await AuctionService.createAuction(S, GOODS, 2, 1000, 1);
    const p3 = c3.auction.id;
    const boxSold = await box(ids);          // 出价之前取基线：冻结的那 1100 本来就在这一格里
    await AuctionService.placeBid(A, p3, 1100);
    const stSold = { S: await stones(S), A: await stones(A), B: await stones(Bb) };
    await expireNow(p3);
    const settled = await AuctionService._settleOneAuction(p3);
    const sellFee = Math.floor(1100 * 0.05);
    check('A11 成交：得标者拿货、卖家收到扣费后的灵石、手续费是唯一离开格子的量',
        settled.outcome === 'sold' && Number(settled.winner_id) === Number(A)
        && await qty(A, GOODS) === 2 && await stones(A) === stSold.A
        && await stones(S) === stSold.S + N(1100 - sellFee) && await box(ids) === boxSold - N(sellFee),
        `结果=${settled.outcome} 手续费=${settled.fee} 卖家收到=${settled.seller_proceeds} 格 ${boxSold}→${await box(ids)}（应少 ${sellFee}）`);
    const again = await AuctionService._settleOneAuction(p3);
    check('A12 重放结算必须跳过：同一场拍卖不能付两次',
        again.skipped === true && await stones(S) === stSold.S + N(1100 - sellFee) && await qty(A, GOODS) === 2,
        `重放=${JSON.stringify(again)} S=${await stones(S)}`);

    // ===== 流拍：物品原路退回，钱不动 =====
    const c4 = await AuctionService.createAuction(S, GOODS, 1, 300, 1);
    const poolUnsold = await box(ids);
    await expireNow(c4.auction.id);
    const unsold = await AuctionService._settleOneAuction(c4.auction.id);
    check('A13 流拍：物品退回卖家、格子里灵石分文不动',
        unsold.outcome === 'unsold' && await box(ids) === poolUnsold && await itemWorld(ids) === 6,
        `结果=${unsold.outcome} 格 ${poolUnsold}→${await box(ids)} 物品总量=${await itemWorld(ids)}`);

    // ===== A14 并发腿①：两场拍卖里 A、B 互相顶价（placeBid：竞价者 → 前一个竞价者） =====
    const c5 = await AuctionService.createAuction(S, GOODS, 1, 1000, 1);
    const c6 = await AuctionService.createAuction(S, GOODS, 1, 1000, 1);
    const X = c5.auction.id, Y = c6.auction.id;
    await AuctionService.placeBid(A, X, 1100);      // X 的当前竞价者 = A
    await AuctionService.placeBid(Bb, Y, 1100);     // Y 的当前竞价者 = B
    // 之后每轮：B 顶 X（锁 B→A）、A 顶 Y（锁 A→B）——两笔事务锁的是**不同拍卖行**，
    // 拍卖行那条锁彼此挡不住，于是 players 两行正好以相反次序相撞。
    const boxBefore = await box(ids);
    let priceX = 1100, priceY = 1100, deadX = 0, deadY = 0, rounds = 0;
    for (let i = 0; i < 12; i++) {
        const bidX = () => AuctionService.placeBid(Bb, X, Math.ceil(priceX * 1.07) + 10);
        const bidY = () => AuctionService.placeBid(A, Y, Math.ceil(priceY * 1.07) + 10);
        const [r1, r2] = await Promise.all([safe(bidX), safe(bidY)]);
        rounds++;
        if (!r1.ok && isDeadlock(r1.why)) deadX++;
        if (!r2.ok && isDeadlock(r2.why)) deadY++;
        // 下一轮按数据库里的实际当前价加价：死锁/被拒的那一笔不该把价格推进
        priceX = Number((await Auction.findByPk(X)).current_price);
        priceY = Number((await Auction.findByPk(Y)).current_price);
    }
    check('A14 两场拍卖互相顶价 12 轮：一次死锁都不该有（改前这里是"A 先锁还是 B 先锁"相撞）',
        deadX + deadY === 0,
        `实况=${rounds} 轮里 X 腿 ${deadX} 次、Y 腿 ${deadY} 次死锁；不是探针坏，是没改锁次序`);
    check('A14b 并发跑完之后钱还是自洽：口袋里 + 冻结中 的总量与循环前一致（谁都不许多退或漏退一笔）',
        await box(ids) === boxBefore,
        `盒 ${boxBefore}→${await box(ids)}（X=${priceX} 由 ${(await Auction.findByPk(X)).current_bidder_id} 领先，Y=${priceY} 由 ${(await Auction.findByPk(Y)).current_bidder_id} 领先）`);

    // ===== A15 并发腿②：两个卖家同时撤销"对方正领先"的拍卖（cancelAuction：竞价者 → 卖家） =====
    await InventoryService.addItem(A, GOODS, 2, null, null, { allowUnknownItem: true });
    await InventoryService.addItem(Bb, GOODS, 2, null, null, { allowUnknownItem: true });
    const c7 = await AuctionService.createAuction(A, GOODS, 1, 500, 1);
    const c8 = await AuctionService.createAuction(Bb, GOODS, 1, 500, 1);
    const Z = c7.auction.id, W = c8.auction.id;
    await AuctionService.placeBid(Bb, Z, 600);      // A 的拍卖由 B 领先
    await AuctionService.placeBid(A, W, 600);       // B 的拍卖由 A 领先
    const boxBefore2 = await box(ids);
    let deadZ = 0, deadW = 0, zRounds = 0, bothDone = false;
    for (let i = 0; i < 6 && !bothDone; i++) {
        const [r1, r2] = await Promise.all([
            safe(() => AuctionService.cancelAuction(A, Z, '探针')),
            safe(() => AuctionService.cancelAuction(Bb, W, '探针'))
        ]);
        zRounds++;
        if (!r1.ok && isDeadlock(r1.why)) deadZ++;
        if (!r2.ok && isDeadlock(r2.why)) deadW++;
        bothDone = r1.ok && r2.ok;                  // 两边都撤掉了；再来只会拿到"已结束"，不是并发
    }
    check('A15 两个卖家同时撤销对方那场拍卖（≤6 轮）：也不该有死锁',
        deadZ + deadW === 0,
        `实况=${zRounds} 轮里 Z 腿 ${deadZ} 次、W 腿 ${deadW} 次死锁`);
    check('A15b 撤销并发跑完同样不漏钱：两边各退各的冻结额 + 各付一次补偿，盒子里总量守恒',
        await box(ids) === boxBefore2,
        `盒 ${boxBefore2}→${await box(ids)} Z=${(await Auction.findByPk(Z)).status} W=${(await Auction.findByPk(W)).status}`);

    // ===== A15c 卖家掏不出补偿费时，不能凭空印钱给竞价者 =====
    await Player.update({ spirit_stones: 0 }, { where: { id: S } });
    const c9 = await AuctionService.createAuction(S, GOODS, 1, 1000, 1);
    await AuctionService.placeBid(A, c9.auction.id, 1050);
    const boxPoor = await box(ids);
    const poorCancel = await safe(() => AuctionService.cancelAuction(S, c9.auction.id, '探针·赤贫卖家'));
    check('A15c 卖家灵石不够付补偿费：只能扣到他实际付得出的那部分，多出来的那一份不该凭空长出来',
        poorCancel.ok && await box(ids) === boxPoor,
        `盒 ${boxPoor}→${await box(ids)}（卖家余额 ${await stones(S)}，补偿费回执 ${poorCancel.ok ? poorCancel.r.compensation_fee : poorCancel.why}）`);

    // ===== A17 死键激活：bidder.max_concurrent_bids 现在真的被服务读 =====
    const capA = await AuctionService.createAuction(S, GOODS, 1, 1000, 1);
    const capB = await AuctionService.createAuction(S, GOODS, 1, 1000, 1);
    await AuctionService.placeBid(A, capA.auction.id, 1050);
    // 不去改仓库里的配置，只在内存里把上限压到 1：这条腿要证的是"这个键有代码在读"，不是"值等于 20"
    const origCfg = AuctionService.getAuctionConfig.bind(AuctionService);
    AuctionService.getAuctionConfig = () => {
        const c = origCfg();
        return { ...c, bidder: { ...(c.bidder || {}), max_concurrent_bids: 1 } };
    };
    let capped = null;
    try {
        capped = await safe(() => AuctionService.placeBid(A, capB.auction.id, 1050));
    } finally {
        AuctionService.getAuctionConfig = origCfg;
    }
    const uncapped = await safe(() => AuctionService.placeBid(A, capB.auction.id, 1050));
    check('A17 bidder.max_concurrent_bids 是真生效的配置键（改前它只写在路由文档里，服务从不读它）',
        !!capped && !capped.ok && /上限/.test(capped.why) && !!uncapped.ok,
        `压到 1 时=${capped && capped.why}｜还原后=${uncapped.ok ? '出价成功' : uncapped.why}`);

    // ===== 收尾：状态字段不许自相矛盾 =====
    const rows = await Auction.findAll({ where: { seller_id: { [Op.in]: ids } } });
    const bad = rows.filter(r => {
        if (r.status === 'closed') return r.winner_id === null ? r.current_bidder_id !== null : false;
        if (r.status === 'cancelled') return r.winner_id !== null;
        return !['open'].includes(r.status);
    });
    check('A16 跑完之后拍卖行的状态字段自洽（closed 才有中标者、cancelled 不许有中标者）',
        bad.length === 0,
        `异常 ${bad.length} 行：${bad.slice(0, 3).map(r => `${r.id}/${r.status}/w=${r.winner_id}`).join(' ')}`);
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (e) {
        console.error('探针异常：', e && e.stack ? e.stack : e);
        hard++;
    } finally {
        const fails = results.filter(r => !r.ok).length + hard;
        try {
            const ps = await Player.findAll({ where: { username: { [Op.in]: NAMES } } });
            const ids = ps.map(p => p.id);
            let purged = { ids: [], total: 0 };
            if (ids.length) {
                // 拍卖这两张用的列是 seller_id / current_bidder_id / winner_id / bidder_id —— 都是"引用"档
                // （一行是**别人**的历史，只是点了这个人的名字），级联故意不碰，所以这两条留着。
                await AuctionBid.destroy({ where: { bidder_id: { [Op.in]: ids } }, force: true });
                await Auction.destroy({
                    where: { [Op.or]: [{ seller_id: { [Op.in]: ids } }, { current_bidder_id: { [Op.in]: ids } }, { winner_id: { [Op.in]: ids } }] },
                    force: true
                });
                // 背包行与其余按 player_id / owner_player_id 归属的派生行，一次交给那扇门
                purged = await PlayerCascadePurge.deletePlayers(ids);
            }
            console.log(`清理：删掉 ${purged.ids.length} 个探针号（${NAMES.join('/')}），级联带走 ${purged.total} 行派生数据`
                + `；拍卖/竞价行按引用列另删（残留 ${(await Player.count({ where: { username: { [Op.in]: NAMES } } }))} 个账号）`);
        } catch (ce) {
            console.warn('清理失败：', ce.message);
        }
        const pass = results.filter(r => r.ok).length;
        console.log(`\n拍卖探针：${pass}/${results.length} 通过${hard ? '，另有 1 处探针异常' : ''}`);
        await sequelize.close();
        process.exit(fails ? 1 : 0);
    }
})();
