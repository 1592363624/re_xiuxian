/**
 * 神识对决（1v1 博弈 + 赌注）四条写路径探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要有：challenge / accept / action / surrender 每一笔都同时写 players（赌注托管与发放）
 * 和 player_divine_duels（对局行），此前运行时零覆盖 —— 只有 jest 里那条不连库的源码扫描。
 * 本会话按 game/persistence/lockOrder.js 把取锁次序统一成 players(两人按 id 升序一次锁齐) → 对局行：
 * 改造前 challenge 是"锁发起方 → 锁应战方 → 锁对局行"（两人互相发起就是一对反向），
 * accept/action/超时回收则是"先锁对局行 → 再回头锁 players"，而后台调度器 checkTimeouts 每轮都在扫对局行。
 *
 * 这条探针同时是**经济审计**：赢家拿 2×赌注，池子也是 2×赌注，所以"有胜者"必须严格零和；
 * 平局按 reward_factor_draw 各退 50%，等于凭空销毁一注 —— 这个数要量出来写进断言里，
 * 不能靠"测试通过"糊过去（销毁是不是刻意设计，等业主拍板）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_divine_duel.js
 * 只用自建探针号 duel_a / duel_b，跑完删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5123);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerDivineSense = require('../models/playerDivineSense');
const PlayerDivineDuel = require('../models/playerDivineDuel');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const DivineDuelService = require('../game/services/DivineDuelService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const NAMES = ['duel_a', 'duel_b'];
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => Number(v == null ? 0 : v);
const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };
const isDeadlock = e => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK/i.test(`${e && e.code || ''} ${e && e.message || ''}`);
const reasonOf = r => (r && r.message) ? r.message : JSON.stringify(r).slice(0, 80);

async function row(id) {
    return Player.findByPk(id, { attributes: ['spirit_stones', 'divine_sense_balance', 'realm_rank'] });
}
async function stones(id) { return B((await row(id)).spirit_stones); }
async function sense(id) { return N((await row(id)).divine_sense_balance); }

async function seedPlayer(username, rank) {
    let p = await Player.findOne({ where: { username } });
    const data = {
        realm: '化神初期', realm_rank: rank, exp: 0, spirit_stones: 200000,
        divine_sense_balance: 5000, hp_current: 50000, mp_current: 5000
    };
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `对决探针${username}`,
            lifespan_current: 500, attributes: {}, token_version: 0, ...data
        });
    } else {
        await Player.update(data, { where: { id: p.id } });
    }
    await PlayerDivineSense.findOrCreate({
        where: { player_id: p.id },
        defaults: { player_id: p.id, divine_sense_max: 9999, divine_sense_current: 5000, regen_rate_per_hour: 10, total_quenched: 0, total_consumed: 0 }
    });
    return p;
}

/** 双方各出一注，打到分出胜负：action 的签名是 (player, duelId, 'focus'|'stabilize')。
 *  终局以**对局行**为准，不去猜返回体的形状（响应里 roundResult 的层级一层层变过，纸面判断会误判"没打完"）。 */
async function fightToFinish(playerA, playerB, duelId, pickA, pickB) {
    const log = [];
    const live = async () => String((await PlayerDivineDuel.findByPk(duelId))?.status);
    for (let i = 0; i < 30; i++) {
        if (await live() !== 'active') return { finished: true, log };
        for (const [p, pick] of [[playerA, pickA], [playerB, pickB]]) {
            const r = await DivineDuelService.action(p, duelId, pick).catch(e => ({ success: false, message: e.message }));
            if (await live() !== 'active') return { finished: true, log };
            if (!r || r.success !== true) { log.push(`${p.id}:${reasonOf(r)}`); return { finished: false, log }; }
        }
    }
    return { finished: false, log: log.concat('回合跑满 30 仍未终局') };
}

async function main() {
    await bootApp(app, { port: PORT });
    const { infrastructure } = require('../modules');
    DivineDuelService.initialize(infrastructure.ConfigLoader);
    const cfg = DivineDuelService.getConfig();
    const bet = 1000;
    check('D0 读得到神识对决配置（赌注区间/入场消耗/回合上限都从这份算）',
        !!cfg && !!cfg.bet_types?.spirit_stone,
        `赌注 ${cfg?.bet_types?.spirit_stone?.min}~${cfg?.bet_types?.spirit_stone?.max} 入场 ${cfg?.entry_divine_sense_cost} 上限 ${cfg?.max_rounds} 胜/平倍率 ${cfg?.reward_factor_winner}/${cfg?.reward_factor_draw}`);
    if (!cfg) return;

    await PlayerDivineDuel.destroy({ where: { challenger_id: (await Player.findOne({ where: { username: NAMES[0] } }))?.id || 0 }, force: true });
    const a0 = await seedPlayer(NAMES[0], 25);
    const b0 = await seedPlayer(NAMES[1], 25);
    const A = a0.id, Bb = b0.id;
    await PlayerDivineDuel.destroy({ where: { [require('sequelize').Op.or]: [{ challenger_id: A }, { defender_id: Bb }] }, force: true });

    // ===== D1 发起：托管一注 + 入场神识，对局行 pending =====
    const sA0 = await stones(A), senA0 = await sense(A);
    const poolStart = sA0 + await stones(Bb);   // 零和基线：必须在托管之前取
    const challenged = await DivineDuelService.challenge(await Player.findByPk(A), Bb, 'spirit_stone', bet);
    const duel = await PlayerDivineDuel.findOne({ where: { challenger_id: A }, order: [['id', 'DESC']] });
    check('D1 发起对决成功：对局行 pending、发起方托管恰好一注',
        challenged && challenged.success === true && duel && String(duel.status) === 'pending'
        && sA0 - await stones(A) === BigInt(bet),
        `${reasonOf(challenged)}｜duel=${duel && duel.id} 扣 ${(sA0 - await stones(A)).toString()} 状态=${duel && duel.status}`);
    const duelId = duel && duel.id;
    if (!duelId) return;

    // ===== D2 应战：应战方也托管一注，池子=2注，境界/次数判定没被挪丢 =====
    const sB0 = await stones(Bb);
    const accepted = await DivineDuelService.accept(await Player.findByPk(Bb), duelId);
    const d2 = await PlayerDivineDuel.findByPk(duelId);
    check('D2 应战成功：对局转 active、应战方同样托管恰好一注（池子=2×赌注）',
        accepted && accepted.success === true && String(d2.status) === 'active'
        && sB0 - await stones(Bb) === BigInt(bet),
        `${reasonOf(accepted)}｜状态=${d2.status} 应战方扣 ${(sB0 - await stones(Bb)).toString()}`);
    const acceptAgain = await DivineDuelService.accept(await Player.findByPk(Bb), duelId);
    check('D2b 同一份邀请接受第二次必须被告知不能接受（不能重复托管）',
        acceptAgain && acceptAgain.success !== true && /无法接受|状态/.test(acceptAgain.message || ''),
        `${reasonOf(acceptAgain)}`);

    // ===== D3 打到分出胜负：赢家拿 2×赌注，两人合计必须严格零和 =====
    const totalBefore = poolStart;
    const fight = await fightToFinish(await Player.findByPk(A), await Player.findByPk(Bb), duelId, 'focus', 'stabilize');
    const d3 = await PlayerDivineDuel.findByPk(duelId);
    if (d3 && String(d3.status) === 'active') {
        // 上一局没打完就卡着后面所有条 —— 顺手用投降收尾（surrender 也是本次要改锁序的路径之一）
        await DivineDuelService.surrender(await Player.findByPk(A), duelId).catch(() => {});
    }
    const totalAfter = await stones(A) + await stones(Bb);
    const winnerId = N(d3.winner_id);
    check('D3 一方凝神一方固元能真打到终局（对局 finished 且有胜者）',
        fight.finished && String(d3.status) === 'finished' && winnerId > 0,
        `回合=${d3.round_number} 胜者=${winnerId === A ? 'A' : 'B'} 理由=${d3.settle_reason}｜${fight.log.slice(-2).join(' ; ')}`);
    check('D3b 有胜者的结算严格零和：两人灵石合计一分不多一分不少（赢家拿 2×赌注）',
        totalAfter === totalBefore,
        `before=${totalBefore.toString()} after=${totalAfter.toString()} 差=${(totalAfter - totalBefore).toString()}`);
    const winnerGain = (winnerId === A ? await stones(A) - sA0 : await stones(Bb) - sB0);
    check('D3c 胜者净收益 = 自己那注（拿回 2 注、当初托管 1 注）',
        winnerGain === BigInt(bet), `净 ${winnerGain.toString()}（注 ${bet}）`);

    // ===== D4 平局销毁量（不是断言它"应该销毁"，而是把这个数钉出来） =====
    const poolStart2 = await stones(A) + await stones(Bb);
    const c2 = await DivineDuelService.challenge(await Player.findByPk(A), Bb, 'spirit_stone', bet);
    const duel2 = await PlayerDivineDuel.findOne({ where: { challenger_id: A, status: 'pending' }, order: [['id', 'DESC']] });
    if (!c2.success || !duel2) {
        check('D4 双方都固元 → 平局时两人各亏一半（销毁量必须被量出来）', false, `第二局没发起成：${reasonOf(c2)}`);
    } else {
        await DivineDuelService.accept(await Player.findByPk(Bb), duel2.id);
        const t0 = poolStart2;   // 基线 = 这一局发起之前：发起时 A 已托管一注，用后来的数会把那注当成"销毁"
        const dA0 = await stones(A), dB0 = await stones(Bb);
        const draw = await fightToFinish(await Player.findByPk(A), await Player.findByPk(Bb), duel2.id, 'stabilize', 'stabilize');
        const dd = await PlayerDivineDuel.findByPk(duel2.id);
        const t1 = await stones(A) + await stones(Bb);
        const destroyed = Number(t0 - t1);
        const symmetric = (await stones(A)) - dA0 === (await stones(Bb)) - dB0;
        check('D4 双方都固元 → 平局：两人亏得一样多，销毁量 == 一注×(1-2×平局倍率)（这数是不是刻意设计等业主拍板）',
            String(dd.status) === 'finished' && dd.winner_id == null && symmetric
            && destroyed === Math.round(bet * (2 - 2 * (Number(cfg.reward_factor_draw) || 0.5))),
            `终局=${dd.status} 胜者=${dd.winner_id} 销毁=${destroyed} 注=${bet} 对称=${symmetric}｜${draw.log.slice(-2).join(' ; ')}`);
    }

    // ===== D5 超时回收：退还托管的赌注与入场神识，且只退一次 =====
    const before5 = await stones(A);
    const s5 = await sense(A);
    const c3 = await DivineDuelService.challenge(await Player.findByPk(A), Bb, 'spirit_stone', bet);
    const duel3 = await PlayerDivineDuel.findOne({ where: { challenger_id: A, status: 'pending' }, order: [['id', 'DESC']] });
    if (c3.success && duel3) {
        await PlayerDivineDuel.update({ action_deadline: new Date(Date.now() - 9999 * 1000) }, { where: { id: duel3.id } });
        await DivineDuelService.checkTimeouts();
        const after5 = await stones(A);
        check('D5 没人应战的局被超时回收：赌注退回发起方（灵石净额回到发起前）',
            String((await PlayerDivineDuel.findByPk(duel3.id)).status) === 'cancelled' && after5 === before5,
            `退回后净额 ${(after5 - before5).toString()}｜发起前神识 ${s5} 现在 ${await sense(A)}`);
        await DivineDuelService.checkTimeouts();
        check('D5b 再跑一轮超时扫描不重复退款', await stones(A) === after5,
            `再扫后 ${(await stones(A) - after5).toString()}`);
    } else {
        check('D5 没人应战的局被超时回收：赌注退回发起方（灵石净额回到发起前）', false, `第三局没发起成：${reasonOf(c3)}`);
        check('D5b 再跑一轮超时扫描不重复退款', false, '上一条没起来');
    }

    // ===== D6 并发：两人互相发起（改造前正是"各锁自己再去要对方"的形状） =====
    let deadlocks = 0;
    const outs = [];
    const rounds = Math.max(2, Number(cfg.challenge_daily_limit) || 3);   // 每人每日发起次数有限，轮数贴着上限走
    for (let i = 0; i < rounds; i++) {
        await PlayerDivineDuel.destroy({ where: { [require('sequelize').Op.or]: [{ challenger_id: A }, { defender_id: Bb }] }, force: true });
        const pair = await Promise.all([
            DivineDuelService.challenge(await Player.findByPk(A), Bb, 'spirit_stone', bet).then(r => `A→B:${r && r.success ? 'ok' : '拒'}`)
                .catch(e => `[${e.message}]`),
            DivineDuelService.challenge(await Player.findByPk(Bb), A, 'spirit_stone', bet).then(r => `B→A:${r && r.success ? 'ok' : '拒'}`)
                .catch(e => `[${e.message}]`)
        ]);
        outs.push(pair.join('+'));
        if (pair.some(x => isDeadlock({ message: x }))) deadlocks++;
    }
    check('D6 两人同时互相发起 6 轮，不许以死锁收场（次序的确定性证明在 smoke_lock_order_matrix）',
        deadlocks === 0, `死锁轮数=${deadlocks}｜${outs.slice(-2).join(' ')}`);
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
            const ids = [];
            for (const name of NAMES) {
                const p = await Player.findOne({ where: { username: name } });
                if (p) ids.push(p.id);
            }
            if (ids.length) {
                // player_divine_duels 用的是 challenger_id / defender_id（引用档，一对两个），不在级联的
                // "归属"口径里，所以这一条仍然要探针自己清；player_divine_sense（player_id）那些交给级联。
                await PlayerDivineDuel.destroy({ where: { [require('sequelize').Op.or]: [{ challenger_id: ids }, { defender_id: ids }] }, force: true });
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
