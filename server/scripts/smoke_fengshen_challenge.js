/**
 * 封神台：挑战结算与赛季发奖（需要 MySQL，走 .env 指向的隔离库）
 *
 * 盯的两件事：
 * ① challengeRank 现在不再逐行补 FOR UPDATE，双方玩家行与两条排名行都取自开头那批
 *    "按主键升序一次锁齐"的锁读（口径见 game/persistence/lockOrder.js）。
 *    行来源换了，所以必须证明**结算本身一分不差**：报出来的积分变化 = 配置应然值 = 真正落库的值，
 *    名次只在获胜时交换，被拒的那一笔不许动任何账；"目标名次已变动/不存在"这种
 *    只在锁回来的那批里找不到行的分支要给得出明确理由。
 * ② settleSeason 的发奖循环原来在已持整张排名表时再逐个 FOR UPDATE 玩家行
 *    （那是 players↔rankings 的逆序，也正是取锁次序闸门点它的原因）。现在改成用开头锁齐的那批行，
 *    并用守恒来兜：**全服实际多出来的灵石/荣誉必须恰好等于结算自己报出的奖励总额**。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_fengshen_challenge.js
 * 只用自建探针号 fs_c1..c4，跑完连排名行一起删。冷却表是进程内的 Map，每次调用前清空。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const FengshenRanking = require('../models/fengshenRanking');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const FengshenService = require('../game/services/FengshenService');

const ACCOUNTS = ['fs_c1', 'fs_c2', 'fs_c3', 'fs_c4'];
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => Number(v == null ? 0 : v);
const reasonOf = e => `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`.slice(0, 90);
const noCool = () => FengshenService.lastChallengeTime && FengshenService.lastChallengeTime.clear();

async function ensurePlayer(username, realmRank) {
    let p = await Player.findOne({ where: { username } });
    if (!p) {
        p = await Player.create({
            username, password: 'not-a-real-hash', nickname: `封神探针${username.slice(-1)}`,
            realm: `炼气${realmRank}层`, realm_rank: realmRank, exp: 0, spirit_stones: 0,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    }
    await FengshenRanking.destroy({ where: { player_id: p.id }, force: true });
    await Player.update({ pvp_mode: 'active', is_dead: false, is_banned: false }, { where: { id: p.id } });
    return Player.findByPk(p.id);
}

const rowOf = async pid => FengshenRanking.findOne({ where: { player_id: pid } });
const rankOfPid = async pid => N((await rowOf(pid))?.rank);

async function main() {
    await bootApp(app, { port: PORT });
    const cfg = FengshenService.getFengshenConfig();
    check('C0 读得到封神台配置（下面所有期望值都从这份算，不抄第二份）',
        N(cfg.base_score) > 0 && N(cfg.daily_challenge_limit) > 0,
        `base_score=${cfg.base_score} daily=${cfg.daily_challenge_limit} range=${cfg.challenge_rank_range}`);
    if (!N(cfg.base_score)) return;

    const range = cfg.challenge_rank_range || 5;
    // 战力按境界拉开，保证结算时名次稳定（同分才按 created_at）
    const ps = [];
    for (let i = 0; i < ACCOUNTS.length; i++) ps.push(await ensurePlayer(ACCOUNTS[i], 3 + i));
    for (const p of ps) await FengshenService.setDefense(p.id, { probe: true });

    const rows = [];
    for (const p of ps) rows.push(await rowOf(p.id));
    const ranks = rows.map(r => N(r.rank)).sort((a, b) => a - b);
    check('C1 四名探针都拿到了排名行且名次互不重复',
        rows.every(Boolean) && new Set(ranks).size === ranks.length,
        `名次=${ranks.join(',')}`);
    if (ranks.some(r => !(r > 0))) return;

    // 挑一对"目标确实比自己高且在可挑战范围内"的（范围=1..challenge_rank_range 名之上）
    let att = null, def = null, targetRank = 0;
    for (const a of rows) {
        for (const b of rows) {
            if (a === b) continue;
            const diff = N(a.rank) - N(b.rank);
            if (diff >= 1 && diff <= (cfg.challenge_rank_range || 5)) { att = a; def = b; targetRank = N(b.rank); break; }
        }
        if (att) break;
    }
    check('C1b 找得到一对合法对手（找不到就是名次分布的问题，下面全是空跑）',
        !!att && !!def, `挑战者 player=${att?.player_id} 名次=${att?.rank} → 目标名次=${targetRank}`);
    if (!att) return;

    // ===== C2 挑战结算：报出来的变化 = 配置应然值 = 落库值 =====
    const before = { att: N(att.fengshen_score), def: N((await rowOf(def.player_id)).fengshen_score) };
    noCool();
    const res = await FengshenService.challengeRank(att.player_id, targetRank);
    const br = res.battle_result || {};
    const afterAtt = N((await rowOf(att.player_id)).fengshen_score);
    const afterDef = N((await rowOf(def.player_id)).fengshen_score);
    const won = br.attacker_wins === true;
    const expectAtt = won ? (cfg.score_win_attacker || 30) : -(cfg.score_lose_attacker || 20);
    const expectDef = won ? -(cfg.score_lose_defender || 30) : (cfg.score_win_defender || 10);
    check('C2 双方积分变化 = 配置应然值，且接口报出的与真正落库的一致',
        afterAtt - before.att === expectAtt && afterDef - before.def === expectDef
        && N(br.attacker_score_change) === expectAtt && N(br.defender_score_change) === expectDef,
        `胜=${won} 挑战方 ${before.att}→${afterAtt}(应 +${expectAtt}) 守方 ${before.def}→${afterDef}(应 ${expectDef}) 报出 ${br.attacker_score_change}/${br.defender_score_change}`);
    const rankAtt = N((await rowOf(att.player_id)).rank);
    const rankDef = N((await rowOf(def.player_id)).rank);
    check('C3 名次只在获胜时交换（胜方拿对方名次、败方接手挑战方原来的名次；败时两边都不动）',
        won ? (rankAtt === targetRank && rankDef === N(att.rank))
            : (rankAtt === N(att.rank) && rankDef === N(def.rank)),
        `胜=${won} 挑战方名次 ${att.rank}→${rankAtt} 守方 ${def.rank}→${rankDef}`);
    check('C4 每日挑战次数 +1，剩余次数与配置对得上',
        N((await rowOf(att.player_id)).daily_challenge_count) === N(att.daily_challenge_count) + 1,
        `次数=${(await rowOf(att.player_id)).daily_challenge_count} 返回剩余=${res.daily_challenge_remaining}`);

    // ===== C4b 把胜、负两条分支都真压到一次 =====
    // C2 那一笔的结果由战力与随机数决定，实测连着三次都是"胜"——失败分支一条没测到就是空跑。
    // 这里把守方快照刷强、攻方境界压到最低逼出"负"。每一对都从**当时**的榜单现挑现读
    // （setDefense 会触发名次重算，用陈旧的 rank 去挑战就会打到第三个人身上 —— 第一版就是这么错的），
    // 核对时以接口报出的 defender_id 为准，不靠猜。
    const seen = { win: won ? 1 : 0, lose: won ? 0 : 1 };
    let mismatch = '';
    for (let round = 0; round < 8 && (seen.lose === 0 || round === 0); round++) {
        const list = [];
        for (const p of ps) {
            const r = await rowOf(p.id);
            if (r && N(r.rank) > 0) list.push({ player_id: N(r.player_id), rank: N(r.rank) });
        }
        list.sort((a, b) => a.rank - b.rank);
        let pair = null;
        for (const d of list) {
            const a = list.find(x => x.player_id !== d.player_id && x.rank - d.rank >= 1 && x.rank - d.rank <= range);
            if (a) { pair = { d, a }; break; }
        }
        if (!pair) break;
        const wantWin = round % 2 === 1;      // 交替逼出两种结果
        await Player.update({ realm: '炼气9层', realm_rank: 9, hp_current: 99999, mp_current: 99999 },
            { where: { id: wantWin ? pair.a.player_id : pair.d.player_id } });
        await Player.update({ realm: '炼气1层', realm_rank: 1, hp_current: 10, mp_current: 10 },
            { where: { id: wantWin ? pair.d.player_id : pair.a.player_id } });
        const strongId = wantWin ? pair.a.player_id : pair.d.player_id;
        await FengshenService.setDefense(strongId, { probe: wantWin ? '强攻方' : '强快照' });
        await FengshenRanking.update({ daily_challenge_count: 0 }, { where: { player_id: pair.a.player_id } });

        const aBefore = await rowOf(pair.a.player_id);
        const dBefore = await rowOf(pair.d.player_id);
        if (!aBefore || !dBefore || !(N(aBefore.rank) > N(dBefore.rank))
            || N(aBefore.rank) - N(dBefore.rank) > range) continue;      // 刷完快照名次错位了，下一轮重挑
        noCool();
        const r4 = await FengshenService.challengeRank(pair.a.player_id, N(dBefore.rank));
        const br4 = r4.battle_result || {};
        const won4 = br4.attacker_wins === true;
        seen[won4 ? 'win' : 'lose']++;
        const eAtt4 = won4 ? (cfg.score_win_attacker || 30) : -(cfg.score_lose_attacker || 20);
        const eDef4 = won4 ? -(cfg.score_lose_defender || 30) : (cfg.score_win_defender || 10);
        const aNow = await rowOf(pair.a.player_id);
        const dNow = await rowOf(N(r4.defender_id));
        const swapOk4 = won4 ? (N(aNow.rank) === N(dBefore.rank) && N(dNow.rank) === N(aBefore.rank))
            : (N(aNow.rank) === N(aBefore.rank) && N(dNow.rank) === N(dBefore.rank));
        if (N(dNow.player_id) !== N(r4.defender_id)
            || N(aNow.fengshen_score) - N(aBefore.fengshen_score) !== eAtt4
            || N(dNow.fengshen_score) - N(dBefore.fengshen_score) !== eDef4
            || N(br4.attacker_score_change) !== eAtt4 || N(br4.defender_score_change) !== eDef4 || !swapOk4) {
            mismatch = `第 ${round + 1} 轮 胜=${won4} 守方 id=${r4.defender_id}：`
                + `攻方 ${aBefore.fengshen_score}→${aNow.fengshen_score}(应 ${eAtt4}) `
                + `守方 ${dBefore.fengshen_score}→${dNow.fengshen_score}(应 ${eDef4}) 名次交换对=${swapOk4}`;
        }
    }
    check('C4b 胜/负两条分支各至少压到一次，且每一笔的积分与名次都按配置落账',
        seen.win > 0 && seen.lose > 0 && !mismatch, `${mismatch || `胜 ${seen.win} 次 / 负 ${seen.lose} 次`}`);

    // ===== C5 目标名次不存在：正是"锁回来的那批里找不到行"那条新分支 =====
    const maxRank = Math.max(...(await FengshenRanking.findAll({ attributes: ['rank'] })).map(r => N(r.rank)));
    const ghostRank = maxRank + 7;
    let ghostReason = '';
    const scoresBefore = (await FengshenRanking.findAll({ attributes: ['fengshen_score'] })).reduce((s, r) => s + N(r.fengshen_score), 0);
    try { noCool(); await FengshenService.challengeRank(att.player_id, ghostRank); } catch (e) { ghostReason = reasonOf(e); }
    const scoresAfter = (await FengshenRanking.findAll({ attributes: ['fengshen_score'] })).reduce((s, r) => s + N(r.fengshen_score), 0);
    check('C5 挑战一个不存在的名次要说得出原因，且全榜积分一分不动',
        /目标排名不存在|只能挑战排名比自己高|榜首/.test(ghostReason) && scoresBefore === scoresAfter,
        `理由=${ghostReason || '（没拒）'} 积分 ${scoresBefore}→${scoresAfter}`);

    // ===== C6 目标避世：拒绝且双方都不记账 =====
    const fresh = [];
    for (const p of ps) {
        const r = await rowOf(p.id);
        if (r) fresh.push({ player_id: N(r.player_id), rank: N(r.rank) });
    }
    // 在探针自己人里找一对"名次相差 1..range"的（C2 那笔交换过名次，所以不能沿用开头那对）
    let c6att = null, c6def = null;
    for (const a of fresh) {
        const b = fresh.find(x => x.player_id !== a.player_id && x.rank > 0 && a.rank - x.rank >= 1 && a.rank - x.rank <= range);
        if (b) { c6att = a; c6def = b; break; }
    }
    if (c6att && c6def) {
        await Player.update({ pvp_mode: 'seclude' }, { where: { id: c6def.player_id } });
        const myScore = N((await rowOf(c6att.player_id)).fengshen_score);
        const myCount = N((await rowOf(c6att.player_id)).daily_challenge_count);
        let secludeReason = '';
        try { noCool(); await FengshenService.challengeRank(c6att.player_id, c6def.rank); } catch (e) { secludeReason = reasonOf(e); }
        const afterRow = await rowOf(c6att.player_id);
        check('C6 目标避世时挑战被拒并给出原因，挑战方积分与次数都不记账（拒单不能白扣）',
            /避世|无法被挑战|尚未设置防守/.test(secludeReason)
            && N(afterRow.fengshen_score) === myScore && N(afterRow.daily_challenge_count) === myCount,
            `理由=${secludeReason || '（没拒）'} 挑战方 ${c6att.rank} → 目标名次 ${c6def.rank}`);
        await Player.update({ pvp_mode: 'active' }, { where: { id: c6def.player_id } });
    } else {
        check('C6 目标避世时挑战被拒并给出原因，挑战方积分与次数都不记账（拒单不能白扣）', false,
            `探针之间找不到"名次相差 1..${range}"的一对（榜单=${fresh.map(f => f.rank).join(',')}），这条没测到`);
    }

    // ===== C7 并发挑战：多方同时打，谁都不许以死锁收场 =====
    const settled = await Promise.all(rows.slice(0, 3).map(async r => {
        noCool();
        const myRank = N((await rowOf(r.player_id)).rank);
        const target = (await FengshenRanking.findAll({ attributes: ['id', 'rank'], order: [['id', 'ASC']] }))
            .find(x => N(x.rank) > 0 && N(x.rank) < myRank && myRank - N(x.rank) <= (cfg.challenge_rank_range || 5));
        try {
            const out = await FengshenService.challengeRank(r.player_id, N(target?.rank || 0));
            return `ok:${out.battle_result?.attacker_wins ? '胜' : '负'}`;
        } catch (e) { return `拒[${reasonOf(e)}]`; }
    }));
    check('C7 三笔并发挑战：不许出现死锁/锁等待（被规则拒掉是允许的，但要给得出原因）',
        !settled.some(s => /Deadlock|lock wait timeout/i.test(s)), settled.join(' ;; '));

    // ===== C8 赛季结算：报出的奖励总额必须等于全服真多出来的那些 =====
    const stonesBefore = (await Player.findAll({ attributes: ['spirit_stones'], raw: true })).reduce((s, p) => s + BigInt(p.spirit_stones || 0), 0n);
    const honorBefore = (await Player.findAll({ attributes: ['honor'], raw: true })).reduce((s, p) => s + BigInt(p.honor || 0), 0n);
    const settle = await FengshenService.settleSeason();
    check('C8 赛季结算是走通了的（没被"名单与排名表不一致"那道守卫挡下）',
        settle.settled === true, `settled=${settle.settled} ${settle.reason || `奖励 ${settle.rewards?.length || 0} 份`}`);
    const paid = (settle.rewards || []).reduce((a, r) => a + BigInt(r.spirit_stones_gain || 0), 0n);
    const paidHonor = (settle.rewards || []).reduce((a, r) => a + BigInt(r.honor_gain || 0), 0n);
    const stonesAfter = (await Player.findAll({ attributes: ['spirit_stones'], raw: true })).reduce((s, p) => s + BigInt(p.spirit_stones || 0), 0n);
    const honorAfter = (await Player.findAll({ attributes: ['honor'], raw: true })).reduce((s, p) => s + BigInt(p.honor || 0), 0n);
    check('C8b 结算发奖守恒：全服多出来的灵石/荣誉恰好等于结算自己报出的数额',
        stonesAfter - stonesBefore === paid && honorAfter - honorBefore === paidHonor,
        `灵石 +${(stonesAfter - stonesBefore).toString()}（报出 ${paid.toString()}）荣誉 +${(honorAfter - honorBefore).toString()}（报出 ${paidHonor.toString()}）`);
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
                await FengshenRanking.destroy({ where: { player_id: p.id }, force: true });
                await Player.destroy({ where: { id: p.id }, force: true });
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
