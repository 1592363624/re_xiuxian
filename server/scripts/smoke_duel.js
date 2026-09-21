/**
 * 切磋斗法（DuelService）探针 —— 目前只覆盖已经核实清楚的两件事（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要这条：DuelService 此前运行时零覆盖，而它的 challenge 一个方法里就锁两行 players，
 * 次序是"发起方 → 目标"—— 两个人互相发起时两边正好相反（同表这一类跨表普查看不见，见 SAME_TABLE_DEBT）。
 * 实测：**3 轮互相发起，3 轮都 Deadlock**（E5），跟 PvpService/道侣那几条改前一模一样。
 *
 * 还缺什么（下一轮补齐，别把这条当全量覆盖）：
 *   - 回合推进：出招合法值是 skill/defend/charge，且"已出招，等待对手出招"会把同一方第二次出手挡回来；
 *     对局行的 status 从 pending → active 是在 acceptDuel 里做的，终局判定要看 battle_log 里的 round_state/rounds_history，
 *     我试到第 4 次还没把"打到终局 + 结算零和"这条写对，先不硬凑一个假绿的断言。
 *   - 拒绝/退款的冷却：`cooldown_seconds`（600 秒）不看对局行删除与否，所以连续多局要在探针里显式绕开。
 *   - E1 已核实：challenge 一步就把**双方**各托管一注（不是 accept 时才托管）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_duel.js
 * 只用自建探针号 duel_a / duel_b，跑完删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5156);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PvpBattleRecord = require('../models/pvpBattleRecord');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const DuelService = require('../game/services/DuelService');
const { Op } = require('sequelize');

const NAMES = ['duel_a', 'duel_b'];
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };
const isDeadlock = s => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK/i.test(s);

async function stones(id) { return B((await Player.findByPk(id, { attributes: ['spirit_stones'] })).spirit_stones); }
async function duelsOf(ids) {
    return PvpBattleRecord.findAll({
        where: { [Op.or]: [{ attacker_id: { [Op.in]: ids } }, { defender_id: { [Op.in]: ids } }] },
        order: [['id', 'DESC']]
    });
}
async function wipe(ids) {
    await PvpBattleRecord.destroy({
        where: { [Op.or]: [{ attacker_id: { [Op.in]: ids } }, { defender_id: { [Op.in]: ids } }] }, force: true
    });
}

async function seed(username) {
    let p = await Player.findOne({ where: { username } });
    const data = {
        realm: '筑基初期', realm_rank: 6, exp: 0, spirit_stones: 300000,
        hp_current: 80000, mp_current: 5000
    };
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `切磋探针${username}`,
            lifespan_current: 300, attributes: {}, token_version: 0, ...data
        });
    } else {
        await Player.update(data, { where: { id: p.id } });
    }
    return p;
}

async function main() {
    await bootApp(app, { port: PORT });
    const bet = 500;
    const ids = [];
    for (const n of NAMES) ids.push((await seed(n)).id);
    const [A, Bb] = ids;
    await wipe(ids);

    // ===== E1 托管口径：challenge 一步把双方各扣一注 =====
    const poolStart = await stones(A) + await stones(Bb);
    const ch = await DuelService.challenge(A, Bb, bet).catch(e => ({ __err: e.message }));
    const d1 = (await duelsOf(ids))[0];
    const escrowed = poolStart - (await stones(A) + await stones(Bb));
    check('E1 challenge 一步就把双方各托管一注（合计少 2×赌注，accept 段不再扣第二遍）',
        !ch.__err && !!ch.duel_id && !!d1 && escrowed === BigInt(bet) * 2n,
        `duel=${d1 && d1.id} 状态=${d1 && d1.status}｜共托管 ${escrowed.toString()}（注 ${bet}）`);
    if (!d1) return;

    // ===== E2 接受方以外的角色不能把同一局再托管一遍 =====
    const selfAccept = await DuelService.acceptDuel(A, d1.id).catch(e => ({ __err: e.message }));
    const afterSelf = poolStart - (await stones(A) + await stones(Bb));
    check('E2 发起方自己"接受"被挡住，且不会因此再扣一遍注',
        (selfAccept.__err || selfAccept.success !== true) && afterSelf === escrowed,
        `理由=${selfAccept.__err || selfAccept.message}｜合计仍少 ${afterSelf.toString()}`);

    // ===== E3 两人互相发起：同表逐个加锁最容易撞的形状 =====
    let dead = 0;
    const last = [];
    for (let i = 0; i < 3; i++) {
        await wipe(ids);
        const pair = await Promise.all([
            DuelService.challenge(A, Bb, bet).then(() => 'A→B:成').catch(e => `A→B[${String(e.message).slice(0, 26)}]`),
            DuelService.challenge(Bb, A, bet).then(() => 'B→A:成').catch(e => `B→A[${String(e.message).slice(0, 26)}]`)
        ]);
        last.push(pair.join(' ;; '));
        if (pair.some(isDeadlock)) dead++;
    }
    check('E3 两人互相发起 3 轮：不许以死锁收场'
        + '【覆盖说明：只有第 1 轮是真并发（之后双方都落进 600 秒决斗冷却，被前置条件挡在锁外）；'
        + '改前实测 3/3 Deadlock，次序的确定性证明在 smoke_lock_order_matrix 的 players 同表两行】',
        dead === 0, `死锁轮数=${dead}｜${last[last.length - 1]}`);
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
            for (const n of NAMES) {
                const p = await Player.findOne({ where: { username: n } });
                if (p) ids.push(p.id);
            }
            if (ids.length) {
                await wipe(ids);
                await Player.destroy({ where: { id: ids }, force: true });
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
