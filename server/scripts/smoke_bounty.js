/**
 * 悬赏（BountyService）：发布一笔要付"本金 + 平台手续费"，钱只能从发布者口袋进悬赏行（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要这条：BountyService 此前运行时零覆盖，而 publishBounty 一个方法里按"发布者 → 目标"
 * 这个业务次序**串行**锁两行 players（见 SAME_TABLE_DEBT）。两个人互相把对方设为悬赏目标时，
 * 两笔事务正好以相反次序伸手要同两行 —— 同表这一类，跨表普查按"模型对"聚合看不见。
 * B4 量的就是这个（改前多少轮 Deadlock 就写多少轮，改后必须为 0）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_bounty.js
 * 只用自建探针号 bounty_a / bounty_b，跑完删干净。
 */
'use strict';

// 必须在 require('../index') 之前定端口：index.js 加载时就 server.listen(PORT)，晚一步会去抢 :5000。
const PORT = Number(process.env.SMOKE_PORT || 5188);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const PlayerBounty = require('../models/playerBounty');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const BountyService = require('../game/services/BountyService');

const NAMES = ['bounty_a', 'bounty_b'];
const START = 200000;
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; }; };
const isDeadlock = s => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK/i.test(s);
const reasonOf = e => `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`.slice(0, 120);
async function safe(fn) {
    try { return { ok: true, r: await fn() }; } catch (e) { return { ok: false, why: reasonOf(e) }; }
}
async function stonesOf(id) { return N((await Player.findByPk(id, { attributes: ['spirit_stones'] })).spirit_stones); }
async function myRows(ids) {
    return PlayerBounty.findAll({
        where: { [Op.or]: [{ publisher_id: { [Op.in]: ids } }, { target_id: { [Op.in]: ids } }] }
    });
}
async function wipe(ids) {
    await PlayerBounty.destroy({
        where: { [Op.or]: [{ publisher_id: { [Op.in]: ids } }, { target_id: { [Op.in]: ids } }] }, force: true
    });
}

async function seed(username) {
    let p = await Player.findOne({ where: { username } });
    const data = {
        realm: '筑基初期', realm_rank: 6, exp: 0, spirit_stones: START, pvp_mode: 'active',
        hp_current: 80000, mp_current: 5000
    };
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `悬赏探针${username.slice(-1)}`,
            lifespan_current: 300, attributes: {}, token_version: 0, ...data
        });
    } else {
        await Player.update({ ...data, is_banned: false, is_dead: false }, { where: { id: p.id } });
    }
    return p;
}

async function main() {
    await bootApp(app, { port: PORT });
    if (typeof BountyService.initialize === 'function') BountyService.initialize(infrastructure.ConfigLoader);
    // 期望值一律从**线上生效的配置**里取，不在探针里抄数字：抄的那份会随 game_balance.json 漂掉
    const cfg = (typeof BountyService._getBountyConfig === 'function' ? BountyService._getBountyConfig() : null) || {};
    check('B0 探针读到的是真的悬赏配置（读不到就是后面全空跑）',
        Object.keys(cfg).length > 3 && cfg.enabled !== false,
        `键数=${Object.keys(cfg).length} enabled=${cfg.enabled} 金额区间=${cfg.min_bounty_amount}~${cfg.max_bounty_amount} 费率=${cfg.platform_fee_rate} 每人活跃上限=${cfg.max_active_bounties_per_player}`);
    if (Object.keys(cfg).length <= 3) return;

    const ids = [];
    for (const n of NAMES) ids.push((await seed(n)).id);
    const [A, B] = ids;
    await wipe(ids);
    const minAmount = Number(cfg.min_bounty_amount) || 100;
    const feeRate = Number(cfg.platform_fee_rate ?? 0.05);
    const feeOf = amt => Math.floor(amt * feeRate);
    const totalOf = amt => BigInt(amt + feeOf(amt));

    // ===== B1 发布一笔：本金 + 手续费一起离开发布者口袋，行落 active =====
    const aBefore = await stonesOf(A);
    const p1 = await BountyService.publishBounty(A, B, minAmount, '探针 B1');
    check('B1 发布：回执的 total_cost 等于库里真扣的量、悬赏行落 active 且没中标者',
        Number(p1.total_cost) === Number(aBefore - await stonesOf(A))
        && Number(p1.bounty_amount) === minAmount && Number(p1.platform_fee) === feeOf(minAmount)
        && p1.status === 'active' && Number(p1.publisher.id) === Number(A) && Number(p1.target.id) === Number(B)
        && (await PlayerBounty.count({ where: { id: p1.bounty_id, status: 'active', acceptor_id: null } })) === 1,
        `扣 ${aBefore - await stonesOf(A)}（回执 ${p1.total_cost}＝本金 ${p1.bounty_amount}+手续费 ${p1.platform_fee}）`);

    // ===== B2 四类非法发布：都要被拒、说不清原因不行、一分不能动 =====
    const boxBefore = await stonesOf(A) + await stonesOf(B);
    const rowsBefore = await PlayerBounty.count({ where: { publisher_id: A } });
    await Player.update({ pvp_mode: 'avoid' }, { where: { id: B } });
    const rAvoid = await safe(() => BountyService.publishBounty(A, B, minAmount, '避世'));
    await Player.update({ pvp_mode: 'active' }, { where: { id: B } });
    const rSelf = await safe(() => BountyService.publishBounty(A, A, minAmount, ''));
    const rLow = await safe(() => BountyService.publishBounty(A, B, 1, ''));
    const rHigh = await safe(() => BountyService.publishBounty(A, B, (Number(cfg.max_bounty_amount) || 100000) + 1, ''));
    check('B2 避世目标 / 悬赏自己 / 金额越界（两侧）：四条都被拒且理由钉得死',
        !rAvoid.ok && /避世/.test(rAvoid.why) && !rSelf.ok && /自己/.test(rSelf.why)
        && !rLow.ok && /之间|范围|必须在/.test(rLow.why) && !rHigh.ok && /之间|范围|必须在/.test(rHigh.why),
        `避世=${rAvoid.why}｜自=${rSelf.why}｜过小=${rLow.why}｜过大=${rHigh.why}`);
    const boxAfterRejects = await stonesOf(A) + await stonesOf(B);
    check('B2b 四条被拒的发布一分灵石都没动、也没留下悬空的悬赏行',
        boxAfterRejects === boxBefore && (await PlayerBounty.count({ where: { publisher_id: A } })) === rowsBefore,
        `格子 ${boxBefore}→${boxAfterRejects} 行数 ${rowsBefore}→${await PlayerBounty.count({ where: { publisher_id: A } })}`);

    // ===== B3 每人活跃悬赏上限（配置原值）：到了上限要拒，且拒了不能收钱 =====
    const maxActive = Number(cfg.max_active_bounties_per_player) || 5;
    let filled = rowsBefore, overflow = null;
    while (filled < maxActive) {
        const ok = await safe(() => BountyService.publishBounty(A, B, minAmount, '探针 B3'));
        if (!ok.ok) { overflow = `还没到上限就拒了：${ok.why}`; break; }
        filled++;
    }
    const stBefore6 = await stonesOf(A);
    const r6 = await safe(() => BountyService.publishBounty(A, B, minAmount, '探针 B3 越界'));
    check('B3 活跃悬赏到上限后必须拒掉下一笔，且被拒那笔不再收钱',
        !r6.ok && /上限/.test(r6.why) && await stonesOf(A) === stBefore6,
        `上限=${maxActive} 现有=${filled} 第${maxActive + 1}笔=${r6.ok ? '（没挡）' : r6.why} ${overflow || ''}`);

    // ===== B4 并发腿：两人互相把对方设为目标（publishBounty：发布者 → 目标） =====
    await wipe(ids);
    await Player.update({ spirit_stones: START }, { where: { id: { [Op.in]: ids } } });
    let dead4 = 0, rounds4 = 0, both4 = 0, why4 = '';
    for (let i = 0; i < Math.min(maxActive, 5); i++) {
        const [r1, r2] = await Promise.all([
            safe(() => BountyService.publishBounty(A, B, minAmount, '探针互发')),
            safe(() => BountyService.publishBounty(B, A, minAmount, '探针互发'))
        ]);
        rounds4++;
        if (!r1.ok && isDeadlock(r1.why)) dead4++;
        if (!r2.ok && isDeadlock(r2.why)) dead4++;
        if (!r1.ok) why4 = `A→B:${r1.why}`;
        if (!r2.ok) why4 = `${why4} B→A:${r2.why}`;
        if (r1.ok && r2.ok) both4++;
    }
    check('B4 两人互相悬赏对方 5 轮：一次死锁都不该有，而且每轮两边都该真成交（否则等于没测）',
        dead4 === 0 && both4 === rounds4,
        `实况=${rounds4} 轮 ${dead4} 次 Deadlock、双方都成交 ${both4} 轮｜被拒理由：${why4 || '无'}`);

    // ===== B5 收口：口袋里的钱 = 起始 - 每笔的(本金+手续费)，两笔都付过就得少两笔 =====
    const rows = await myRows(ids);
    const escrowed = rows.reduce((s, r) => s + totalOf(Number(r.bounty_amount)), 0n);
    const boxNow = await stonesOf(A) + await stonesOf(B);
    check('B5 账本收口：口袋 + 悬赏行托管 = 起始总额（本金进了行、手续费也一起离开口袋，不会有第三笔钱多出或不见）',
        boxNow + escrowed === N(START * 2)
        && rows.every(r => r.status !== 'active' || r.acceptor_id === null),
        `口袋 ${boxNow} + 托管 ${escrowed} 应等于 ${N(START * 2)}（行 ${rows.length} 条）`);
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
            if (ids.length) {
                await wipe(ids);
                await Player.destroy({ where: { id: { [Op.in]: ids } }, force: true });
            }
            console.log(`清理：探针号 ${NAMES.join('/')} 与它们的悬赏行已删（残留 ${
                (await Player.count({ where: { username: { [Op.in]: NAMES } } }))} 个账号、${
                ids.length ? await PlayerBounty.count({ where: { publisher_id: { [Op.in]: ids } } }) : 0} 行悬赏）`);
        } catch (ce) {
            console.warn('清理失败：', ce.message);
        }
        const pass = results.filter(r => r.ok).length;
        console.log(`\n悬赏探针：${pass}/${results.length} 通过${hard ? '，另有 1 处探针异常' : ''}`);
        await sequelize.close();
        process.exit(fails ? 1 : 0);
    }
})();
