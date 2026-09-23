/**
 * 兽潮结算（BeastInvasionService._settleDefeat）：一笔结算要给"终结者 + 全部参战者"发奖，
 * 取锁次序与"同一个人不能被读两份实例"都必须钉住（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要这条：_settleDefeat 先锁终结者一行，再**按伤害排行的名次**逐个 FOR UPDATE 锁参战者
 * （这是 SAME_TABLE_DEBT 里最后一处，也是唯一"一次锁几十行"的那种）。两头妖兽同时被同一批人打，
 * 两场结算的伤害排行次序通常不同 —— 于是 T1 按 [A,B,C] 取锁、T2 按 [C,B,A] 取锁，就是 ABBA。
 * C3 量的正是这个。另外终结者本人也在伤害排行里，改前他在同一笔事务里被读了两份实例（终结者奖励一份、
 * 参与奖一份），"谁后 save 谁覆盖对方"就发生在这一个人身上 —— 批锁之后只留一份。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_beast_settle.js
 * 只用自建探针号 bi_a/bi_b/bi_c，跑完删干净。
 */
'use strict';

// 必须在 require('../index') 之前定端口：index.js 加载时就 server.listen(PORT)，晚一步会去抢 :5000。
const PORT = Number(process.env.SMOKE_PORT || 5193);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const BeastInvasion = require('../models/beastInvasion');
const BeastInvasionAttack = require('../models/beastInvasionAttack');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const BeastInvasionService = require('../game/services/BeastInvasionService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const NAMES = ['bi_a', 'bi_b', 'bi_c'];
const BEAST = 'xuelang_yaoshou';
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; }; };
// 反序那一版实测到的错误不止 "Deadlock found"：MySQL 杀掉败者事务后，Sequelize 还会把它包装成
// "rollback has been called on this transaction …"，只认前者的话死锁计数会假零零（改前那一轮就是这个现象：
// 6 轮里两边都成交 0 轮，但 dead 数出来是 0）。所以两个都算。
const isDeadlock = s => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK|rollback has been called on this transaction/i.test(s);
const reasonOf = e => `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`.slice(0, 140);
async function safe(fn) {
    try { return { ok: true, r: await fn() }; } catch (e) { return { ok: false, why: reasonOf(e) }; }
}
async function snap(id) {
    const p = await Player.findByPk(id, { attributes: ['exp', 'spirit_stones'] });
    return { exp: N(p.exp), stones: N(p.spirit_stones) };
}
const createdInvasions = [];
async function makeInvasion(label) {
    const row = await BeastInvasion.create({
        beast_key: BEAST, beast_name: '血狼妖兽（探针）', realm_rank_min: 8,
        hp_max: 2000000, hp_current: 0, atk: 1500, def: 500, speed: 100, phase: 1,
        donation_target: 5000, donation_current: 0, status: 'active',
        start_time: new Date(), total_damage_taken: 600, total_damage_dealt: 600,
        description: label
    });
    createdInvasions.push(row.id);   // 只清自己造的那几行（调度器也在同一库里生成兽潮，不能顺手删别人的）
    return row;
}
async function addAttacks(invasionId, rows) {
    for (const [pid, dmg] of rows) {
        await BeastInvasionAttack.create({
            invasion_id: invasionId, player_id: pid, player_nickname: `p${pid}`, damage: dmg, counter_damage: 0
        });
    }
}
/** 直接开事务调私有结算：绕开整场战斗的状态机，只压"取锁次序 + 发奖不重不漏"这一件事 */
async function settle(invasionId, killerId) {
    const t = await sequelize.transaction();
    try {
        const r = await BeastInvasionService._settleDefeat(invasionId, killerId, t);
        await t.commit();
        return r;
    } catch (e) {
        if (!t.finished) await t.rollback();
        throw e;
    }
}

async function seed(username) {
    let p = await Player.findOne({ where: { username } });
    const data = {
        realm: '元婴初期', realm_rank: 8, exp: 100000, spirit_stones: 100000,
        hp_current: 80000, mp_current: 5000
    };
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `兽潮探针${username.slice(-1)}`,
            lifespan_current: 300, attributes: {}, token_version: 0, ...data
        });
    } else {
        await Player.update(data, { where: { id: p.id } });
    }
    return p;
}

async function main() {
    await bootApp(app, { port: PORT });
    if (typeof BeastInvasionService.initialize === 'function') BeastInvasionService.initialize(infrastructure.ConfigLoader);
    const staticData = BeastInvasionService.getBeastStaticData(BEAST);
    const rewards = staticData?.rewards || {};
    check('C0 探针读得到这只妖兽的静态数据与奖励（读不到后面全是空跑）',
        !!staticData && !!rewards.killer && !!rewards.participation,
        `rewards 键=${Object.keys(rewards).join('/')} 终结者=${JSON.stringify(rewards.killer || {}).slice(0, 80)}`);
    if (!staticData || !rewards.killer) return;

    const ids = [];
    for (const n of NAMES) ids.push((await seed(n)).id);
    const [A, B, C] = ids;
    // 这一条（与 C3 之前那条同形的）留着手写：号还在，清的是**同一个号**上一轮留下的伤害记录，
    // 级联那扇门是"连 players 行一起删"，用在准备阶段会把 C1~C4 要用的那三个号删掉
    await BeastInvasionAttack.destroy({ where: { player_id: { [Op.in]: ids } }, force: true });

    // ===== C1 一次结算：终结者与每个参战者都该拿到钱，且终结者拿得比纯参与者多 =====
    const inv1 = await makeInvasion('C1');
    await addAttacks(inv1.id, [[A, 300], [B, 200], [C, 100]]);
    const before = { A: await snap(A), B: await snap(B), C: await snap(C) };
    const r1 = await settle(inv1.id, A);
    const dA = (await snap(A)).exp - before.A.exp, dB = (await snap(B)).exp - before.B.exp, dC = (await snap(C)).exp - before.C.exp;
    const sA = (await snap(A)).stones - before.A.stones, sB = (await snap(B)).stones - before.B.stones, sC = (await snap(C)).stones - before.C.stones;
    check('C1 结算给终结者与全部参战者发奖：每人修为与灵石都严格增加、没人被静默跳过',
        dA > 0n && dB > 0n && dC > 0n && sA > 0n && sB > 0n && sC > 0n,
        `修为 A+${dA} B+${dB} C+${dC}｜灵石 A+${sA} B+${sB} C+${sC}｜摘要=${String(r1.summary || '').slice(0, 90)}`);
    check('C1b 终结者那份奖励不会被参与奖覆盖：他的增量必须严格大于伤害第二名的增量',
        dA > dB && sA > sB && dC > 0n,
        `A(终结者+第一名)=${dA}/${sA} B(仅参与)=${dB}/${sB} C=${dC}/${sC}（若 A 被后写的实例覆盖，这里会掉到与 B 同量级）`);

    // ===== C2 没有"已结算"守卫：直接重放同一场就会再发一遍奖 =====
    await inv1.update({ status: 'defeated', killer_player_id: A });
    const before2 = await snap(B);
    const r2 = await settle(inv1.id, A);
    const paidAgain = (await snap(B)).exp > before2.exp;
    check('C2 重放一场已经结束的结算必须不再发第二遍奖（守卫生效，不能只靠调用方记得改 status）',
        !paidAgain && /已不在交战状态|不存在|已处理|已结算/.test(String(r2.summary || '') + JSON.stringify(r2).slice(0, 200)),
        `重放结果=${JSON.stringify(r2).slice(0, 120)}｜B 又长了 ${await snap(B) ? (await snap(B)).exp - before2.exp : '?'} 修为`);

    // ===== C3 并发腿：两头妖兽的参战排行次序相反（逐行取锁 vs 反序逐行取锁） =====
    await BeastInvasionAttack.destroy({ where: { player_id: { [Op.in]: ids } }, force: true });
    const invX = await makeInvasion('C3-X');
    const invY = await makeInvasion('C3-Y');
    await addAttacks(invX.id, [[A, 300], [B, 200], [C, 100]]);   // 排行 A,B,C
    await addAttacks(invY.id, [[C, 300], [B, 200], [A, 100]]);   // 排行 C,B,A —— 与上面正好相反
    let dead = 0, rounds = 0, bothOk = 0, why = '';
    for (let i = 0; i < 6; i++) {
        const [r1c, r2c] = await Promise.all([
            safe(() => settle(invX.id, A)),
            safe(() => settle(invY.id, C))
        ]);
        rounds++;
        if (!r1c.ok && isDeadlock(r1c.why)) dead++;
        if (!r2c.ok && isDeadlock(r2c.why)) dead++;
        if (!r1c.ok) why = `X:${r1c.why}`;
        if (!r2c.ok) why = `${why} Y:${r2c.why}`;
        if (r1c.ok && r2c.ok) bothOk++;
    }
    check('C3 两头妖兽同时结算 6 轮：一次死锁都不该有，而且每轮两边都该走完（否则等于没测）',
        dead === 0 && bothOk === rounds,
        `实况=${rounds} 轮 ${dead} 次 Deadlock、两边都成交 ${bothOk} 轮｜被拒理由：${why || '无'}`);

    // ===== C4 并发跑完的收口：没人被扣成负数、每个人的增量都还在 =====
    const after = { A: await snap(A), B: await snap(B), C: await snap(C) };
    check('C4 并发结算之后三个人的账仍然单调：修为与灵石只增不减、没有 NaN/负数',
        [after.A, after.B, after.C].every(s => s.exp > 0n && s.stones > 0n)
        && after.A.exp > dA && after.B.exp > dB && after.C.exp > dC,
        `A=${after.A.exp}/${after.A.stones} B=${after.B.exp}/${after.B.stones} C=${after.C.exp}/${after.C.stones}`);
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
                // 原来这里按 player_id 删的两条（伤害记录、背包行）都是归属档，交回给那扇门；
                // 按 invasion_id 的那条留着 —— 它捞的是"这场兽潮上**别人**留下的伤害记录"，列名不是归属档。
                if (createdInvasions.length) {
                    await BeastInvasionAttack.destroy({ where: { invasion_id: { [Op.in]: createdInvasions } }, force: true });
                    await BeastInvasion.destroy({ where: { id: { [Op.in]: createdInvasions } }, force: true });
                }
                const leftover = await BeastInvasionAttack.count({ where: { invasion_id: { [Op.in]: createdInvasions.length ? createdInvasions : [0] } } });
                purged = await PlayerCascadePurge.deletePlayers(ids);
                console.log(`（本次自建兽潮 ${createdInvasions.length} 行，残留伤害记录 ${leftover} 条）`);
            }
            console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据（含伤害记录与背包行）`
                + `；兽潮行按 id 另删（残留 ${
                (await Player.count({ where: { username: { [Op.in]: NAMES } } }))} 个账号、${
                await BeastInvasion.count({ where: { beast_key: BEAST } })} 行兽潮）`);
        } catch (ce) {
            console.warn('清理失败：', ce.message);
        }
        const pass = results.filter(r => r.ok).length;
        console.log(`\n兽潮结算探针：${pass}/${results.length} 通过${hard ? '，另有 1 处探针异常' : ''}`);
        await sequelize.close();
        process.exit(fails ? 1 : 0);
    }
})();
