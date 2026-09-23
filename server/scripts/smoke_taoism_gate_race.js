/**
 * 太一门引道（TaoismGateService）的并发写探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：这一行的技能冷却、日常任务、修炼次数、道途经验都存在**整块 JSON 列**里，
 * 而改造前 `_getOrCreateGate` 是事务外的快照 —— 两个并发请求各自读一份、各自写回，
 * 后提交的把前提交的整块盖掉。表现不是"少一条日志"而是能复现的外挂：
 *   · 同一条日常任务奖励领两次（神识/法则碎片/经验重复发）；
 *   · 技能冷却被抹掉 → 当场可以再放一次；
 *   · 今日修炼次数被抹掉 → 突破每日上限。
 * 现在四条写路径都改成"事务内先锁道途行、判定照锁住的那一份重做"。本探针按"同时发两把"打，
 * 并回读数据库判定，而不是只看接口返回码（两个都回 200 才算事故）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_taoism_gate_race.js
 * 只会动它自己建的探针号（taorace01），跑完删干净。
 */
'use strict';

const { infrastructure, initializeModules } = require('../modules');
const sequelize = require('../config/database');
const Player = require('../models/player');
const PlayerTaoismGate = require('../models/playerTaoismGate');
const PlayerDivineSense = require('../models/playerDivineSense');
const PlayerLaw = require('../models/playerLaw');
const TaoismGateService = require('../game/services/TaoismGateService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const configLoader = infrastructure.ConfigLoader;
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 把两把调用同时扔出去，返回 [{ok, err|res}] —— 顺序不确定，所以判定只看计数与库里的值 */
async function race(promiseFactories) {
    const settled = await Promise.allSettled(promiseFactories.map(fn => fn()));
    return settled.map(s => (s.status === 'fulfilled' ? { ok: true, res: s.value } : { ok: false, err: s.reason }));
}

(async () => {
    await initializeModules();
    TaoismGateService.initialize(configLoader);
    const cfg = configLoader.getConfig('taoism_gate_data');
    const PATH = 'water';
    const pathConfig = cfg.dao_paths[PATH];
    if (!pathConfig) throw new Error(`内容里没有道途 ${PATH}，探针要换一个`);

    // 开头按账号名清历次残留（不是按 id）：崩过一次的那轮留下的道途/神识/法则行，新 id 永远找不回来
    await PlayerCascadePurge.deleteByUsernames(['taorace01', 'taorace02']);
    const player = await Player.create({
        username: 'taorace01', password: 'not-a-real-hash', nickname: '引道并发探针',
        realm: '化神初期', realm_rank: Math.max(30, Number(cfg.taoism_gate.min_realm_rank) + 5),
        exp: 0, spirit_stones: 1000
    });
    await PlayerDivineSense.create({
        player_id: player.id, divine_sense_max: 100000,
        divine_sense_current: (Number(pathConfig.skill_divine_sense_cost) || 10) * 20
            + (Number(cfg.taoism_gate.cultivate_divine_sense_cost) || 50) * 10,
        regen_rate_per_hour: 0, last_regen_time: new Date(),
        daily_quench_count: 0, total_quenched: 0, total_consumed: 0
    });
    await PlayerLaw.create({
        player_id: player.id, law_points: 0, total_earned: 0, total_spent: 0, daily_earned: 0,
        law_fragments_space: 0, law_fragments_time: 0, law_fragments_five_elements: 0,
        law_fragments_soul: 0, law_fragments_karma: 0
    });
    const freshGate = async () => PlayerTaoismGate.findOne({ where: { player_id: player.id } });
    const freshLaw = async () => PlayerLaw.findOne({ where: { player_id: player.id } });

    // ── T1 双开"引道"：只能成一次 ─────────────────────────────────────────
    const t1 = await race([
        () => TaoismGateService.choosePath(player, PATH),
        () => TaoismGateService.choosePath(player, PATH)
    ]);
    const gateAfterT1 = await freshGate();
    check('T1 并发 choosePath 只有一次成功，库里 dao_path 真的是那一条',
        t1.filter(r => r.ok).length === 1 && gateAfterT1?.dao_path === PATH,
        `成功=${t1.filter(r => r.ok).length} 结果=${t1.map(r => (r.ok ? 'ok' : String(r.err?.message).slice(0, 20))).join('/')} dao_path=${gateAfterT1?.dao_path}`);

    // 等级要够放技能（引道后默认 1 级，直接按内容要求抬上去，这是探针的输入条件不是玩法）
    await PlayerTaoismGate.update({ dao_level: Math.max(1, Number(pathConfig.skill_min_level) || 1) },
        { where: { player_id: player.id } });

    // ── T2 双开同一条日常任务领奖：奖励只能发一次 ─────────────────────────
    const gateForTask = await freshGate();
    const tasks = gateForTask.daily_tasks || [];
    check('T2 前置：引道后确实生成了日常任务（不然下面的断言是空的）', tasks.length > 0, `任务数=${tasks.length}`);
    tasks[0].progress = Number(tasks[0].target) || 1;
    tasks[0].completed = true;
    tasks[0].rewards_claimed = false;
    tasks[0].rewards = { divine_sense: 5, law_fragment_five_elements: 3, dao_exp: 10 };
    gateForTask.daily_tasks = tasks;
    gateForTask.changed('daily_tasks', true);
    await gateForTask.save();

    const lawBefore = Number((await freshLaw()).law_fragments_five_elements || 0);
    const t2 = await race([
        () => TaoismGateService.claimTaskReward(player, 0),
        () => TaoismGateService.claimTaskReward(player, 0)
    ]);
    const lawAfter = Number((await freshLaw()).law_fragments_five_elements || 0);
    const gateAfterT2 = await freshGate();
    check('T2 并发领同一条任务奖励：只成一次，法则碎片只 +3（不重复发）',
        t2.filter(r => r.ok).length === 1 && lawAfter - lawBefore === 3
            && gateAfterT2.daily_tasks?.[0]?.rewards_claimed === true,
        `成功=${t2.filter(r => r.ok).length} 碎片增量=${lawAfter - lawBefore} 结果=${t2.map(r => (r.ok ? 'ok' : String(r.err?.message).slice(0, 16))).join('/')} claimed=${gateAfterT2.daily_tasks?.[0]?.rewards_claimed}`);

    // ── T3 双开技能：第二次必须被冷却挡住，且计数不丢 ────────────────────
    const gateClear = await freshGate();
    gateClear.skill_cooldowns = {};
    gateClear.changed('skill_cooldowns', true);
    await gateClear.save();
    const usesBefore = Number(gateClear.total_skill_use_count || 0);

    const t3 = await race([
        () => TaoismGateService.useSkill(player, null, null),
        () => TaoismGateService.useSkill(player, null, null)
    ]);
    const gateAfterT3 = await freshGate();
    const cooldowns = gateAfterT3.skill_cooldowns || {};
    const primaryCooldown = cooldowns[pathConfig.skill_id];
    // 一次施法可以落下多个键（水镜自己还会记一条护罩冷却），所以这里判"主技能有未来冷却 + 只成一次"，
    // 不判键的个数 —— 键个数由内容/技能实现决定，探针不该替它定。
    check('T3 并发放同一个技能：一次成功一次被冷却拒，主技能冷却没被后提交的那一份抹掉',
        t3.filter(r => r.ok).length === 1 && primaryCooldown && new Date(primaryCooldown) > new Date()
            && t3.some(r => !r.ok && String(r.err?.message).includes('冷却')),
        `成功=${t3.filter(r => r.ok).length} 冷却=${JSON.stringify(cooldowns)} 结果=${t3.map(r => (r.ok ? 'ok' : String(r.err?.message).slice(0, 16))).join('/')}`);
    check('T3b 技能使用次数按锁住的那一份累加（不是被盖回 0）',
        Number(gateAfterT3.total_skill_use_count) === usesBefore + 1,
        `前=${usesBefore} 后=${gateAfterT3.total_skill_use_count}`);

    // ── T4 并发修炼：次数不能互相覆盖（每日上限要靠得住）────────────────
    const gateBeforeT4 = await freshGate();
    const countBefore = Number(gateBeforeT4.daily_cultivate_count || 0);
    const t4 = await race([
        () => TaoismGateService.cultivate(player),
        () => TaoismGateService.cultivate(player)
    ]);
    const gateAfterT4 = await freshGate();
    check('T4 并发修炼两次：两次都记上（daily_cultivate_count 恰好 +2，没被盖掉）',
        t4.every(r => r.ok) && Number(gateAfterT4.daily_cultivate_count) === countBefore + 2,
        `成功=${t4.filter(r => r.ok).length}/2 前=${countBefore} 后=${gateAfterT4.daily_cultivate_count} 上限=${cfg.taoism_gate.daily_cultivate_limit}`);

    // ── T5 互放火眼：写对方那一行必须按 player_id 升序取锁 ────────────────
    // 双方各自"消耗对方水镜盾 + 给自己记一条冷却"。若读对方行不加锁，
    // A 写回的整块是基于自己那次无锁读 → 会把 B 刚写进去的 fire_eye 冷却整块抹掉：
    // 表现是 B 的技能冷却凭空消失，当场可以再放一次（互相丢球可以无限放）。
    const other = await Player.create({
        username: 'taorace02', password: 'not-a-real-hash', nickname: '引道并发探针乙',
        realm: '化神初期', realm_rank: Math.max(30, Number(cfg.taoism_gate.min_realm_rank) + 5),
        exp: 0, spirit_stones: 1000
    });
    await PlayerDivineSense.create({
        player_id: other.id, divine_sense_max: 100000,
        divine_sense_current: (Number(cfg.dao_paths.fire.skill_divine_sense_cost) || 10) * 60,
        regen_rate_per_hour: 0, last_regen_time: new Date(),
        daily_quench_count: 0, total_quenched: 0, total_consumed: 0
    });
    await PlayerLaw.create({
        player_id: other.id, law_points: 0, total_earned: 0, total_spent: 0, daily_earned: 0,
        law_fragments_space: 0, law_fragments_time: 0, law_fragments_five_elements: 0,
        law_fragments_soul: 0, law_fragments_karma: 0
    });
    await TaoismGateService.choosePath(other, 'fire');
    const otherPlayer = other;
    // player 是水道（T1 选的），这里让它也能放火眼：直接把道途改成火，双方对称
    await PlayerTaoismGate.update({ dao_path: 'fire', dao_level: Math.max(1, Number(cfg.dao_paths.fire.skill_min_level) || 1) },
        { where: { player_id: player.id } });
    await PlayerTaoismGate.update({ dao_level: Math.max(1, Number(cfg.dao_paths.fire.skill_min_level) || 1) },
        { where: { player_id: other.id } });

    // 每 1ms 往目标的冷却块里补一个新键（模拟"目标自己同时在写这一行"），
    // 火眼那条链就必须在锁内读、锁内写回 —— 否则它写回的是自己那次读之前的整块，刚补的键会凭空消失。
    // （互放火眼本身压不出这个窗口：两边的写都是"删同一个键"，幂等。所以这里改成锤击，
    //   与 smoke_blob_races 的 F2 同一个打法；压不出来就别声称覆盖。）
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function hammer(playerId, stopFlag, counter) {
        while (!stopFlag.stop) {
            const t = await sequelize.transaction();
            const row = await PlayerTaoismGate.findOne({
                where: { player_id: playerId }, transaction: t, lock: t.LOCK.UPDATE
            });
            if (row) {
                const added = { ...(row.skill_cooldowns || {}) };
                added[`hammer_${counter.n}`] = new Date(Date.now() + 3600 * 1000).toISOString();
                row.skill_cooldowns = added;
                row.changed('skill_cooldowns', true);
                await row.save({ transaction: t });
                counter.n += 1;
                counter.keys.push(`hammer_${counter.n - 1}`);
            }
            await t.commit();
            await sleep(1);
        }
    }

    const shieldEnd = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let deadlocks = 0;
    let lostHammer = 0;
    let hammerRounds = 0;
    let writtenKeys = 0;
    let reflectedRounds = 0;
    const ROUNDS = Number(process.env.TAOISM_RACE_ROUNDS || 6);
    for (let round = 0; round < ROUNDS; round++) {
        for (const one of [player, otherPlayer]) {
            await PlayerTaoismGate.update({
                skill_cooldowns: { water_mirror_shield: shieldEnd(), probe_sentinel: shieldEnd() }
            }, { where: { player_id: one.id } });
        }
        const stop = { stop: false };
        const a = { n: 0, keys: [] };
        const b = { n: 0, keys: [] };
        // 甲打乙、乙打甲，同时两边的行各被锤击写入
        const hammers = [hammer(player.id, stop, a), hammer(otherPlayer.id, stop, b)];
        const casts = await Promise.allSettled([
            TaoismGateService.useSkill(player, other.id, null),
            TaoismGateService.useSkill(otherPlayer, player.id, null)
        ]);
        await sleep(40);
        stop.stop = true;
        await Promise.all(hammers);
        hammerRounds += 1;
        writtenKeys += a.keys.length + b.keys.length;
        for (const s of casts) {
            if (s.status === 'rejected' && /Deadlock|LOCK_DEADLOCK|死锁/i.test(String(s.reason?.message || s.reason))) deadlocks += 1;
        }
        const mine = await PlayerTaoismGate.findOne({ where: { player_id: player.id } });
        const theirs = await PlayerTaoismGate.findOne({ where: { player_id: otherPlayer.id } });
        // 锤击写进去的键必须一个都不见（各自还要有 fire_eye 与哨兵键）
        const missingA = a.keys.filter(k => !(k in (mine.skill_cooldowns || {})));
        const missingB = b.keys.filter(k => !(k in (theirs.skill_cooldowns || {})));
        if (missingA.length || missingB.length) lostHammer += 1;
        // 反弹分支必须真的跑到：它才是"写目标那一行"的那条路，没跑到就等于上面两条在空转
        const payloads = casts.map(s => (s.status === 'fulfilled' ? JSON.stringify(s.value) : String(s.reason?.message)));
        if (payloads.every(p => p.includes('反弹'))) reflectedRounds += 1;
        if (round === 0) {
            console.log(`  [T5 首轮实况] 锤击写入 ${a.keys.length + b.keys.length} 个键，甲丢 ${missingA.length} 个、乙丢 ${missingB.length} 个`);
        }
    }
    check('T5 互放火眼 + 同时锤击两边行：没有死锁', deadlocks === 0, `轮数=${hammerRounds} 死锁=${deadlocks}`);
    check('T5b 锤击写进冷却块的键一个都没被火眼写回抹掉（行为回归；亚毫秒窗口压不出来，硬闸在 BlobWriteRaceGates 静态那条）',
        writtenKeys > 0 && lostHammer === 0,
        `轮数=${hammerRounds} 累计写入=${writtenKeys} 出现丢键的轮=${lostHammer}`);
    check('T5c 火眼反弹分支真的跑到（HEAD 里 `const反弹Cost` 少了个空格，一进这个分支就抛）',
        reflectedRounds === hammerRounds, `轮数=${hammerRounds} 双方都报反弹的轮=${reflectedRounds}`);

    // 收尾只叫一次"删号"：player_taoism_gate / player_divine_sense / player_law 这些按 player_id
    // 归属的行由级联带走（以前这里手写六条 destroy，漏一张就是一种孤儿）
    const purged = await PlayerCascadePurge.deletePlayers([player.id, other.id]);
    const left = await Promise.all([
        PlayerTaoismGate.count({ where: { player_id: [player.id, other.id] } }),
        Player.count({ where: { username: ['taorace01', 'taorace02'] } })
    ]);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
    console.log(`残留复查：道途行 ${left[0]} 个、探针号 ${left[1]} 个（都应为 0）`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n== 引道并发写探针：${results.length - failed.length}/${results.length} 通过 ==`);
    for (const f of failed) console.log(`未通过：${f.name}`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针异常：', error);
    process.exit(1);
});
