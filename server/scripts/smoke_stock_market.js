/**
 * 股市：买卖 / 强平 / GM 强平三条钱的通路（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要单独一个：StockMarketService 是全仓唯一"钱 + 仓位 + 全服共享股票行"三层一起写的地方，
 * 改造前它一条探针都没有 —— 而取锁次序恰恰在这里最容易出事：
 *   - 强平任务每 60 秒把所有融资账户扫一遍，原先**先锁融资账户行、再回头锁 players**，
 *     而 buy/sell/repay 全是 players→margin，同一玩家撞上就是标准 ABBA（玩家那笔直接 500）；
 *   - 出清时"遍历持仓、逐笔现锁股票行"，股票之间的先后由持仓返回次序决定，
 *     两个玩家同轮出清就可能一个先锁 5 号、一个先锁 9 号 —— 后台任务自己撞自己，与 players 无关。
 * 次序差分的确定性证据在 scripts/smoke_lock_order_matrix.js；这条探针管的是**改完之后钱还对不对**：
 * 转移不印钱、T+1 不放松、出清只按卖出所得偿还、重放不双发。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_stock_market.js
 * 只用自建探针号 stockp1..p3，跑完删干净；不碰库里原有的股票与别人的账户。
 */
'use strict';

// 必须在 require('../index') 之前定端口：index.js 加载时就 server.listen(PORT)，晚一步会去抢 :5000。
const PORT = Number(process.env.SMOKE_PORT || 5096);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const Stock = require('../models/stock');
const StockHolding = require('../models/stockHolding');
const StockTransaction = require('../models/stockTransaction');
const StockMarginAccount = require('../models/stockMarginAccount');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const StockMarketService = require('../game/services/StockMarketService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const ACCOUNTS = ['stockp1', 'stockp2', 'stockp3'];
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };
const isDeadlock = e => /Deadlock|lock wait timeout/i.test(`${e && e.code || ''} ${e && e.message || ''}`);
const reasonOf = e => `${(e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))}`.slice(0, 90);

async function ensurePlayer(username, stones) {
    // 开头按账号名清历次残留（不是按 id）：上一轮崩在中途时留下的持仓/流水/融资账户行，换个新 id 永远找不回来。
    // 这三张表都按 player_id 归属，交给生产代码里那一份级联 —— 探针不再自己列"收尾要清哪几张表"。
    await PlayerCascadePurge.deleteByUsernames([username]);
    const p = await Player.create({
        username, password: 'not-a-real-hash', nickname: `股市探针${username.slice(-1)}`,
        realm: '炼气3层', realm_rank: 3, exp: 0, spirit_stones: stones,
        hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
    });
    return Player.findByPk(p.id);
}

const wallet = async id => {
    const p = await Player.findByPk(id, {
        attributes: ['id', 'spirit_stones', 'stock_account_balance', 'stock_margin_debt']
    });
    return {
        stones: B(p.spirit_stones), balance: B(p.stock_account_balance), debt: B(p.stock_margin_debt),
        net: B(p.stock_account_balance) - B(p.stock_margin_debt)
    };
};

async function sellProceeds(playerId) {
    const rows = await StockTransaction.findAll({ where: { player_id: playerId, trade_type: 'sell' } });
    return { count: rows.length, amount: rows.reduce((s, r) => s + B(r.amount), 0n) };
}

/**
 * 探针要交易的那两只股票：先记下熔断/昨收三件事，跑完原样还回去。
 * 不清的话有两层随机性：库里可能留着上一轮熔断（买直接抛），以及买卖各推 0.5% 价格
 * 相对**旧昨收价**算日内涨跌幅（可能当场把熔断再踩响）。昨收对齐现价后日内涨幅从 0 起算。
 */
const stockSnapshots = [];
async function quietStocks(list) {
    for (const s of list) {
        stockSnapshots.push({
            id: s.id, is_trading_halted: s.is_trading_halted,
            halt_until: s.halt_until, yesterday_close_price: s.yesterday_close_price
        });
        await Stock.update({ is_trading_halted: false, halt_until: null, yesterday_close_price: s.current_price },
            { where: { id: s.id } });
    }
}
async function restoreStocks() {
    for (const snap of stockSnapshots) {
        await Stock.update({
            is_trading_halted: snap.is_trading_halted, halt_until: snap.halt_until,
            yesterday_close_price: snap.yesterday_close_price
        }, { where: { id: snap.id } });
    }
}

async function main() {
    await bootApp(app, { port: PORT });
    await StockMarketService._initializeStocksIfEmpty();

    const now = new Date();
    const candidates = await Stock.findAll({ where: { is_active: true }, order: [['id', 'ASC']], limit: 8 });
    const tradable = candidates.filter(s => !s.is_trading_halted || !s.halt_until || new Date(s.halt_until) <= now);
    const stocks = tradable.slice(0, 2);
    check('K0 库里至少两只当下可交易的活跃股票（否则"同轮出清两行"那条压不到）', stocks.length === 2,
        `活跃=${candidates.length} 可交易=${tradable.length} ids=${stocks.map(s => s.id).join(',')}`);
    if (stocks.length < 2) return;
    const [sA, sB] = stocks;
    await quietStocks(stocks);

    const p1 = await ensurePlayer('stockp1', 1000000);
    const p2 = await ensurePlayer('stockp2', 0);
    const p3 = await ensurePlayer('stockp3', 1000000);

    // ===== K1 转入是转移，不是印钱 =====
    const w0 = await wallet(p1.id);
    await StockMarketService.deposit(p1.id, 200000);
    const w1 = await wallet(p1.id);
    check('K1 转入只把钱从灵石挪到股市账户（两边之和不变）',
        w1.balance - w0.balance === 200000n && w0.stones - w1.stones === 200000n,
        `灵石 ${w0.stones}→${w1.stones} 账户 ${w0.balance}→${w1.balance}`);

    // ===== K2/K3 普通买入：现金扣成本，T+1 当日不可卖 =====
    const priceA = B(sA.current_price);
    const qtyA = 20n;
    const expectAmount = priceA * qtyA;
    // 手续费/印花税一律照服务里的算式重算一遍（万分比取整、下限 5），不复用它自己的函数，免得自证
    const feeOf = gross => {
        const scaled = gross * 30n / 10000n;
        return scaled > 5n ? scaled : 5n;
    };
    const expectFee = feeOf(expectAmount);
    const buyRes = await StockMarketService.buy(p1.id, sA.id, Number(qtyA));
    const w2 = await wallet(p1.id);
    const holdA = await StockHolding.findOne({ where: { player_id: p1.id, stock_id: sA.id } });
    check('K2 买入现金扣减 = 成交额 + 手续费，持仓按声明数量增加',
        w1.balance - w2.balance === expectAmount + expectFee && B(holdA?.quantity) === qtyA,
        `扣减=${w1.balance - w2.balance} 应=${expectAmount + expectFee} 持仓=${holdA?.quantity || '无'} 返回=${buyRes?.success}`);
    check('K3 当日买入不可卖（T+1），且被拒这一笔分毫未动',
        B(holdA?.available_quantity) === 0n,
        `available=${holdA?.available_quantity}`);
    const beforeReject = await wallet(p1.id);
    let rejected = '';
    try {
        await StockMarketService.sell(p1.id, sA.id, Number(qtyA));
    } catch (e) {
        rejected = reasonOf(e);
    }
    const afterReject = await wallet(p1.id);
    check('K3b 卖出被拒时给出原因且账上没动（拒单不能留下半边成交）',
        /T\+1|可用数量不足/.test(rejected) && afterReject.balance === beforeReject.balance,
        `原因=${rejected || '（没拒）'}`);

    // ===== K4 放开 T+1 后能正常卖出：现金 += 成交额 − 手续费 − 印花税 =====
    await StockHolding.update({ available_quantity: qtyA }, { where: { id: holdA.id } });
    const priceNow = B((await Stock.findByPk(sA.id)).current_price);
    const gross = priceNow * qtyA;
    const sellFee = feeOf(gross);
    const tax = gross * 10n / 10000n;   // stamp_tax_sell 0.001
    const w3 = await wallet(p1.id);
    await StockMarketService.sell(p1.id, sA.id, Number(qtyA));
    const w4 = await wallet(p1.id);
    const holdA2 = await StockHolding.findOne({ where: { player_id: p1.id, stock_id: sA.id } });
    check('K4 卖出到账 = 成交额 − 手续费 − 印花税，持仓清零',
        w4.balance - w3.balance === gross - sellFee - tax && B(holdA2?.quantity) === 0n,
        `到账=${w4.balance - w3.balance} 应=${gross - sellFee - tax} 余仓=${holdA2?.quantity}`);

    // ===== K5..K8 强平：债大于资产时按市价出清，只按卖出所得偿还 =====
    await StockMarginAccount.create({ player_id: p2.id, total_assets: 0, debt: 0, margin_ratio: 0, is_liquidated: false });
    const qtyHold = 30n;
    for (const s of [sA, sB]) {
        await StockHolding.create({
            player_id: p2.id, stock_id: s.id, quantity: qtyHold, available_quantity: qtyHold,
            average_cost: B(s.current_price), total_cost: B(s.current_price) * qtyHold,
            market_value: B(s.current_price) * qtyHold
        });
    }
    const debtBig = 1000000n;
    await Player.update({ stock_margin_debt: debtBig, stock_account_balance: 0 }, { where: { id: p2.id } });
    await StockMarginAccount.update({ debt: debtBig, is_liquidated: false }, { where: { player_id: p2.id } });
    const netBefore = (await wallet(p2.id)).net;
    check('K5 强平前置条件成立：探针账户确实是"债远大于资产"',
        B((await StockMarginAccount.findOne({ where: { player_id: p2.id } })).debt) === debtBig
        && (await StockHolding.count({ where: { player_id: p2.id, quantity: { [Op.gt]: 0 } } })) === 2,
        `债=${(await StockMarginAccount.findOne({ where: { player_id: p2.id } })).debt} 现金=0 `
        + `持仓行数=${await StockHolding.count({ where: { player_id: p2.id } })}`);

    await StockMarketService.checkMarginAccounts();
    const after = await wallet(p2.id);
    const accAfter = await StockMarginAccount.findOne({ where: { player_id: p2.id } });
    const proceeds = await sellProceeds(p2.id);
    check('K6 强平把两只持仓都出清、账户标记爆仓',
        (await StockHolding.count({ where: { player_id: p2.id, quantity: { [Op.gt]: 0 } } })) === 0
        && accAfter.is_liquidated === true,
        `爆仓=${accAfter.is_liquidated}`);
    check('K7 出清不印钱：净值增加额恰好等于卖出流水之和',
        after.net - netBefore === proceeds.amount,
        `净值 ${netBefore}→${after.net} 差=${after.net - netBefore} 卖出所得=${proceeds.amount}(${proceeds.count} 笔)`);
    check('K8 偿还额 = min(负债, 现金 + 卖出所得)，多出来的债不会因为爆仓被抹平',
        debtBig - after.debt === proceeds.amount,
        `债 ${debtBig}→${after.debt} 减=${debtBig - after.debt}`);
    check('K8b 出清之后两张负债表说的是同一套数',
        B(accAfter.debt) === after.debt,
        `players=${after.debt} accounts=${accAfter.debt}`);

    const netReplay = after.net;
    await StockMarketService.checkMarginAccounts();
    const replay = await wallet(p2.id);
    const proceedsReplay = await sellProceeds(p2.id);
    check('K9 重放强平不再发第二笔（已爆仓的账户要在校验里就跳掉）',
        replay.net === netReplay && proceedsReplay.count === proceeds.count,
        `净值 ${netReplay}→${replay.net} 卖出笔数 ${proceeds.count}→${proceedsReplay.count}`);

    // ===== K10 玩家侧融资写路径与强平任务并发：任何一边都不许以死锁收场 =====
    // 两边都要"真的走到第二把锁"才算压到形状：融资额度不足会在锁融资账户之前就抛出，
    // 那样并发只是排队，什么也证不了 —— 所以先在健康状态下压融资买入，再造成资不抵债压偿还。
    await StockMarketService.openMarginAccount(p3.id);
    await StockMarketService.deposit(p3.id, 200000);
    const healthyRaces = [];
    for (let round = 0; round < 3; round++) {
        healthyRaces.push((await Promise.all([
            StockMarketService.checkMarginAccounts().then(r => `job:${r.liquidated_count}`).catch(e => `job[${reasonOf(e)}]`),
            StockMarketService.buy(p3.id, sA.id, 1, { useMargin: true })
                .then(() => 'buy:ok').catch(e => `buy[${reasonOf(e)}]`)
        ])).join(' | '));
    }
    const marginBuys = healthyRaces.filter(x => x.includes('buy:ok')).length;
    check('K10a 健康账户这一组里融资买入确实成交过（否则两边没走到同一批行，等于空跑）',
        marginBuys >= 1, `成交 ${marginBuys}/3：${healthyRaces[0] || ''}`);
    check('K10b 融资买入与强平任务并发：谁都不许以死锁收场',
        !healthyRaces.some(x => /Deadlock|lock wait timeout/i.test(x)), healthyRaces.join(' ;; ').slice(0, 180));

    // 造成资不抵债，再拿"偿还负债"这条 players→margin 的路与任务对压
    await StockHolding.create({
        player_id: p3.id, stock_id: sB.id, quantity: 40n, available_quantity: 40n,
        average_cost: B(sB.current_price), total_cost: B(sB.current_price) * 40n, market_value: B(sB.current_price) * 40n
    });
    await Player.update({ stock_margin_debt: 500000n }, { where: { id: p3.id } });
    await StockMarginAccount.update({ debt: 500000n, is_liquidated: false }, { where: { player_id: p3.id } });
    const distressedRaces = [];
    for (let round = 0; round < 3; round++) {
        distressedRaces.push((await Promise.all([
            StockMarketService.checkMarginAccounts().then(r => `job:${r.liquidated_count}`).catch(e => `job[${reasonOf(e)}]`),
            StockMarketService.repayMargin(p3.id, 100).then(() => 'repay:ok').catch(e => `repay[${reasonOf(e)}]`)
        ])).join(' | '));
    }
    check('K10c 偿还负债与强平任务并发：同样不许死锁',
        !distressedRaces.some(x => /Deadlock|lock wait timeout/i.test(x)), distressedRaces.join(' ;; ').slice(0, 180));

    // ===== K11 GM 强平：与后台强平共用同一条锁序与偿还算式 =====
    const accP3 = await StockMarginAccount.findOne({ where: { player_id: p3.id } });
    const wP3Before = await wallet(p3.id);
    const proceedsP3Before = (await sellProceeds(p3.id)).amount;
    if (accP3.is_liquidated === true) {
        // 上面那几轮任务已经把它平了：把状态恢复成"未平、仍有持仓与负债"再压 GM 这条路。
        // 这条 destroy 不是"删号收尾"（号还活着，玩家行一句都没动），而是同一轮里给下面那条
        // create 腾出 (player_id, stock_id) 唯一索引的位置 —— 级联管不到这里，所以留着。
        await StockHolding.destroy({ where: { player_id: p3.id }, force: true });
        await StockHolding.create({
            player_id: p3.id, stock_id: sB.id, quantity: 40n, available_quantity: 40n,
            average_cost: B(sB.current_price), total_cost: B(sB.current_price) * 40n, market_value: B(sB.current_price) * 40n
        });
        await Player.update({ stock_margin_debt: 500000n }, { where: { id: p3.id } });
        await StockMarginAccount.update({ debt: 500000n, is_liquidated: false }, { where: { player_id: p3.id } });
    }
    const netP3Before = (await wallet(p3.id)).net;
    const proceedsP3BeforeCount = (await sellProceeds(p3.id)).count;
    await StockMarketService.gmForceLiquidate(1, p3.id, '探针 GM 强平');
    const wP3 = await wallet(p3.id);
    const accP3After = await StockMarginAccount.findOne({ where: { player_id: p3.id } });
    const p3Proceeds = await sellProceeds(p3.id);
    const gmProceeds = p3Proceeds.amount - proceedsP3Before;
    check('K11 GM 强平把持仓出清、标记爆仓',
        (await StockHolding.count({ where: { player_id: p3.id, quantity: { [Op.gt]: 0 } } })) === 0
        && accP3After.is_liquidated === true
        && p3Proceeds.count > proceedsP3BeforeCount,
        `新增卖出 ${p3Proceeds.count - proceedsP3BeforeCount} 笔 爆仓=${accP3After.is_liquidated}`);
    check('K11b GM 强平同样不印钱：净值增加额 = 本次卖出所得',
        wP3.net - netP3Before === gmProceeds,
        `净值 ${netP3Before}→${wP3.net} 差=${wP3.net - netP3Before} 本次卖出所得=${gmProceeds}`);
    check('K11c 出清之后两张负债表说的是同一套数（改造前 players 清零、accounts 还留着九成）',
        B(accP3After.debt) === wP3.debt,
        `players=${wP3.debt} accounts=${accP3After.debt} 起点现金=${wP3Before.balance}`);
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
            await restoreStocks();
        } catch (e) { console.error('还原股票熔断/昨收状态失败:', e.message); }
        try {
            const ids = [];
            for (const username of ACCOUNTS) {
                const p = await Player.findOne({ where: { username } });
                if (p) ids.push(p.id);
            }
            if (ids.length) {
                // 持仓/流水/融资账户都按 player_id 归属，级联自己带走；探针只叫一次"删号"
                const purged = await PlayerCascadePurge.deletePlayers(ids);
                console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
