/**
 * 道侣两条通路（CompanionService.seek/accept、DaoCompanionService.propose/respond）的功能探针
 * （需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要有：这四条都是"两个真人 + 一张关系行 + 两行 players 钱包"的写法，此前一条探针都没有。
 * 本会话把它们的取锁次序统一成 players(按 id 升序) → 关系行（口径见 game/persistence/lockOrder.js）：
 * 改造前 seek 是"锁自己 → 锁关系行 → 锁对方"，accept/respond 是"锁关系行 → 再锁两人"，
 * 方向相反 —— 一人邀请、对方正好在自己那头点一下就是 ABBA；而且两个玩家行是按"发起方/接受方"
 * 这种业务顺序锁的，A↔B 互邀本身就凑一对环。次序的确定性差分在 scripts/smoke_lock_order_matrix.js
 * （players↔dao_companion / players↔dao_companions 两对），这条探针证明的是**改完之后账还对**：
 * 造价只扣一次、重复响应不生效、双方字段互填、并发双开不多建关系也不多扣钱。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_dao_companion.js
 * 只用自建探针号 dc_a/dc_b/dc_c/dc_d，跑完删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5104);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const CompanionService = require('../game/services/CompanionService');
const DaoCompanionService = require('../game/services/DaoCompanionService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const NAMES = ['dc_a', 'dc_b', 'dc_c', 'dc_d'];
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => Number(v == null ? 0 : v);
const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };
const isDeadlock = e => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK/i.test(`${e && e.code || ''} ${e && e.message || ''}`);

async function wallet(id) {
    const p = await Player.findByPk(id, { attributes: ['spirit_stones'] });
    return B(p && p.spirit_stones);
}
async function rowOf(model, ids) {
    // 注意别给 sequelize.query 传 `model:` —— 那会让它把类型推成 SELECT，返回值直接就是行数组，
    // 再 `const [rows] =` 解构会把"第一行"当成数组（本探针第一版就这么读出了 undefined）。
    const [rows] = await sequelize.query(
        `SELECT * FROM ${model.getTableName()} WHERE player_a_id IN (:ids) OR player_b_id IN (:ids)`,
        { replacements: { ids } }
    );
    return rows;
}

async function main() {
    await bootApp(app, { port: PORT });

    const companionCfg = (require('../modules').infrastructure.ConfigLoader.getConfig('companion_data') || {}).dao_companion || {};
    const daoCfg = (require('../modules').infrastructure.ConfigLoader.getConfig('dao_companion_data') || {}).settings || {};
    const seekCost = B(companionCfg.seek_cost_spirit_stones);
    const minRank = N(daoCfg.min_realm_rank) || 15;
    check('D0 读得到两份道侣配置（造价与境界门槛，下面所有期望值从这份算）',
        seekCost > 0n && minRank > 0,
        `seek 造价=${seekCost.toString()} 门槛=${companionCfg.min_realm_name}/${minRank} 初始亲密=${daoCfg.propose_initial_intimacy}`);

    const ids = [];
    for (const name of NAMES) {
        let p = await Player.findOne({ where: { username: name } });
        if (!p) {
            p = await Player.create({
                username: name, password: 'not-a-real-hash', nickname: `道侣探针${name}`,
                realm: '结丹初期', realm_rank: minRank + 5, exp: 0, spirit_stones: 500000,
                hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
            });
        } else {
            await Player.update({ realm_rank: minRank + 5, spirit_stones: 500000, dao_companion_id: null },
                { where: { id: p.id } });
        }
        ids.push(p.id);
    }
    const [A, Bb, C, D] = ids;
    await sequelize.query('DELETE FROM dao_companion WHERE player_a_id IN (:ids) OR player_b_id IN (:ids)', { replacements: { ids } });
    await sequelize.query('DELETE FROM dao_companions WHERE player_a_id IN (:ids) OR player_b_id IN (:ids)', { replacements: { ids } });

    // ===== D1 seek：建 pending 关系，只扣配置造价 =====
    const wA0 = await wallet(A);
    const sought = await CompanionService.seek(A, Bb);
    const relRows = await rowOf(require('../models/daoCompanion'), ids);
    check('D1 seek 成功建 pending 关系，扣的灵石恰好等于配置造价',
        sought && sought.success === true && relRows.length === 1
        && String(relRows[0].relation_state) === 'pending'
        && wA0 - await wallet(A) === seekCost,
        `返回=${sought && sought.message}｜行数=${relRows.length} 状态=${relRows[0] && relRows[0].relation_state} 扣 ${(wA0 - await wallet(A)).toString()}`);
    const companionId = Number(relRows[0] && relRows[0].id);
    if (!companionId) return;

    // ===== D2 accept：接受方不花钱，双方 dao_companion_id 互填 =====
    const wB0 = await wallet(Bb);
    const accepted = await CompanionService.accept(Bb, companionId);
    const after = await rowOf(require('../models/daoCompanion'), ids);
    const pA = await Player.findByPk(A, { attributes: ['dao_companion_id'] });
    const pB = await Player.findByPk(Bb, { attributes: ['dao_companion_id'] });
    check('D2 accept 后关系转 active、双方字段互填、接受方一分不扣',
        accepted && accepted.success === true && String(after[0].relation_state) === 'active'
        && N(pA.dao_companion_id) === companionId && N(pB.dao_companion_id) === companionId
        && wB0 === await wallet(Bb),
        `状态=${after[0] && after[0].relation_state} A字段=${pA.dao_companion_id} B字段=${pB.dao_companion_id} B扣 ${(wB0 - await wallet(Bb)).toString()}`);

    // ===== D3 重复 accept / 已有道侣者再 seek（批锁之后互斥还得成立） =====
    const twice = await CompanionService.accept(Bb, companionId);
    check('D3 同一个邀请接受第二次必须被告知已处理（不能重复生效）',
        twice && twice.success === false && /已失效|已处理/.test(twice.message || ''), `返回=${twice && twice.message}`);
    const seekAgain = await CompanionService.seek(A, C);
    check('D3b 已有道侣的人再 seek 被拒，且不新建关系行',
        seekAgain && seekAgain.success === false && /已有道侣/.test(seekAgain.message || '')
        && (await rowOf(require('../models/daoCompanion'), ids)).length === 1,
        `返回=${seekAgain && seekAgain.message}`);

    // ===== D4 propose → respond（另一张表 dao_companions，改过的是这两条） =====
    const proposed = await DaoCompanionService.propose(C, D);
    const propRows = await rowOf(require('../models/daoCompanions'), ids);
    check('D4 propose 成功建 pending 求婚记录',
        proposed && proposed.success === true && propRows.length === 1 && String(propRows[0].status) === 'pending',
        `返回=${proposed && proposed.message}｜行数=${propRows.length} 状态=${propRows[0] && propRows[0].status}`);
    const proposalId = Number(propRows[0] && propRows[0].id);
    if (!proposalId) return;

    const wrongSide = await DaoCompanionService.respond(C, proposalId, 'accept');
    check('D5 发起方自己"响应"自己的求婚必须被挡住',
        wrongSide && wrongSide.success === false && /只能响应发给自己的求婚/.test(wrongSide.message || ''),
        `返回=${wrongSide && wrongSide.message}`);
    const refusedState = await rowOf(require('../models/daoCompanions'), ids);
    check('D5b 上面那次拒绝没有把状态改掉（还是 pending）',
        String(refusedState[0].status) === 'pending', `状态=${refusedState[0].status}`);

    const wC0 = await wallet(C);
    const responded = await DaoCompanionService.respond(D, proposalId, 'accept');
    const accRow = await rowOf(require('../models/daoCompanions'), ids);
    check('D6 接受方响应后求婚转 accepted、亲密度按配置初始化、没人被扣灵石',
        responded && responded.success === true && String(accRow[0].status) === 'accepted'
        && N(accRow[0].intimacy) === N(daoCfg.propose_initial_intimacy || 10)
        && wC0 === await wallet(C),
        `返回=${responded && responded.message}｜状态=${accRow[0].status} 亲密=${accRow[0].intimacy}`);
    const respTwice = await DaoCompanionService.respond(D, proposalId, 'accept');
    check('D6b 同一份求婚响应第二次必须被告知已处理',
        respTwice && respTwice.success === false && /已处理/.test(respTwice.message || ''),
        `返回=${respTwice && respTwice.message}`);

    // ===== D7 并发双开 seek：同一人连点两次，只许成一次、只扣一次 =====
    await sequelize.query('DELETE FROM dao_companion WHERE player_a_id IN (:ids) OR player_b_id IN (:ids)', { replacements: { ids } });
    await Player.update({ dao_companion_id: null }, { where: { id: [A, Bb] } });
    const wS = await wallet(A);
    const raced = await Promise.all([
        CompanionService.seek(A, Bb).then(r => r && r.success ? 'ok' : `拒[${r && r.message}]`).catch(e => `[${e.message}]`),
        CompanionService.seek(A, Bb).then(r => r && r.success ? 'ok' : `拒[${r && r.message}]`).catch(e => `[${e.message}]`)
    ]);
    const seekRows = await rowOf(require('../models/daoCompanion'), ids);
    check('D7 同一个人并发双击 seek：只成一次、只扣一次造价、不多建关系行',
        !raced.some(isDeadlock) && raced.filter(x => x === 'ok').length === 1
        && wS - await wallet(A) === seekCost && seekRows.length === 1,
        `${raced.join(' ;; ')}｜扣 ${(wS - await wallet(A)).toString()} 行数=${seekRows.length}`);

    // ===== D8 跨表并发：respond（关系行→players 的旧方向）与对向 seek 同时点 =====
    // 这一条压的是"两个真人各点自己那一头"。死锁窗口只占事务的一小段，压不出环是正常的
    // （次序的确定性证明在 smoke_lock_order_matrix.js），这里只保证**改完之后不会因锁序而崩**。
    let deadlockRounds = 0;
    for (let i = 0; i < 6; i++) {
        await sequelize.query('DELETE FROM dao_companion WHERE player_a_id IN (:ids) OR player_b_id IN (:ids)', { replacements: { ids } });
        await Player.update({ dao_companion_id: null }, { where: { id: [A, Bb] } });
        const first = await CompanionService.seek(A, Bb);
        const cid = Number((await rowOf(require('../models/daoCompanion'), ids))[0]?.id);
        if (!first || !first.success || !cid) { deadlockRounds = -999; break; }
        const out = await Promise.all([
            CompanionService.seek(Bb, A).then(r => `seek:${r && r.success ? 'ok' : '拒'}`).catch(e => `[${e.message}]`),
            CompanionService.accept(Bb, cid).then(r => `accept:${r && r.success ? 'ok' : '拒'}`).catch(e => `[${e.message}]`)
        ]).catch(() => ['异常']);
        if (!first || !first.success) deadlockRounds = -999;
        if (out.some(x => isDeadlock({ message: x }))) deadlockRounds++;
    }
    check('D8 "B 反手邀请 A" 与 "B 接受 A 的邀请" 同时点，6 轮里没有死锁',
        deadlockRounds === 0, deadlockRounds === -999 ? '前置 seek 就没成功，下面别信' : `死锁轮数=${deadlockRounds}`);

    // ===== D9 两人同时点同一类互动（双修/温养/采补/问答）：不许死锁，也不许把关系写成半截 =====
    // 这些方法原来的形状一模一样："锁自己 → 锁关系行 → 再锁对方"，两个人各点自己那一头就是 ABBA；
    // 本会话改成"先 peek 关系行拿对方 id → 两人按 id 升序一次锁齐 → 再锁关系行重看"。
    // 上面 D7 只留了 pending 关系，这里先把它坐实，否则下面的"拒"全是前置条件拒、测不到改动那段。
    const pendingRow = (await rowOf(require('../models/daoCompanion'), ids)).find(r => String(r.relation_state) === 'pending');
    const bonded = pendingRow ? await CompanionService.accept(Bb, Number(pendingRow.id)) : { success: false, message: '没有 pending 关系' };
    const alreadyActive = (await rowOf(require('../models/daoCompanion'), ids)).some(r => String(r.relation_state) === 'active');
    check('D9a A/B 之间确实有 active 关系（上面那轮已坐实也算 —— 下面几条要测的是互动，不是"还没道侣"）',
        alreadyActive || (bonded && bonded.success === true), `${bonded && bonded.message}｜已有 active=${alreadyActive}`);
    const pairChecks = [
        ['双修 dualCultivate', () => CompanionService.dualCultivate(A), () => CompanionService.dualCultivate(Bb)],
        ['温养 warmNourish', () => CompanionService.warmNourish(A), () => CompanionService.warmNourish(Bb)],
        ['采补 pluckSupplement', () => CompanionService.pluckSupplement(A), () => CompanionService.pluckSupplement(Bb)],
        ['问答 interact', () => DaoCompanionService.interact(C), () => DaoCompanionService.interact(D)],
        ['心印 condenseHeartImprint', () => DaoCompanionService.condenseHeartImprint(C), () => DaoCompanionService.condenseHeartImprint(D)],
        // DaoCompanionService 的双修：探针号没连 WebSocket，多半停在"道侣不在线"那条 ——
        // 这条要测的是**取锁头**（两人同时点不许死锁），不是双修能不能真跑完
        ['幻世双修 dualCultivate', () => DaoCompanionService.dualCultivate(C), () => DaoCompanionService.dualCultivate(D)]
    ];
    for (const [label, fa, fb] of pairChecks) {
        const outs = await Promise.all([fa().catch(e => `抛错[${e.message}]`), fb().catch(e => `抛错[${e.message}]`)]);
        const texts = outs.map(o => (typeof o === 'string') ? o : `${o && o.success ? '成' : '拒'}[${(o && o.message || '').slice(0, 28)}]`);
        const dead = outs.some(o => typeof o === 'string' && isDeadlock({ message: o }));
        check(`D9 ${label}：两人同时点不崩不死锁，被拒也要说清理由（次数/冷却/亲密/时长）`,
            !dead && texts.every(x => x.startsWith('成') || /需|不足|上限|冷却|没有|已|正在|进行|无法|不在线/.test(x)),
            texts.join(' ;; '));
    }
    // ===== D10 两人同时"协议解除"（拿 C/D 那一对测，A/B 留给 D9z 验自洽）=====
    // 解除是最典型的"两边都觉得自己是发起方"：一人点解除、另一人也点解除，
    // 只许成一笔，另一笔要被告知已经没有可解除的关系 —— 两笔都成就是把同一段关系拆两次。
    const breaks10 = await Promise.all([
        DaoCompanionService.breakCompanion(C).catch(e => `抛错[${e.message}]`),
        DaoCompanionService.breakCompanion(D).catch(e => `抛错[${e.message}]`)
    ]);
    const brTexts = breaks10.map(o => (typeof o === 'string') ? o : `${o && o.success ? '成' : '拒'}[${(o && o.message || '').slice(0, 28)}]`);
    const daoRows10 = await rowOf(require('../models/daoCompanions'), ids);
    check('D10 两人同时协议解除：不崩不死锁、只成一笔',
        !breaks10.some(o => typeof o === 'string' && isDeadlock({ message: o }))
        && brTexts.filter(x => x.startsWith('成')).length === 1, brTexts.join(' ;; '));
    check('D10b 解除后那段关系不再是 accepted（两笔都生效会把它拆两次）',
        daoRows10.every(r => String(r.status) !== 'accepted'),
        `dao_companions 状态=${daoRows10.map(r => r.status).join('/') || '无'}`);

    const relRows9 = await rowOf(require('../models/daoCompanion'), ids);
    const pa9 = await Player.findByPk(A, { attributes: ['dao_companion_id'] });
    const pb9 = await Player.findByPk(Bb, { attributes: ['dao_companion_id'] });
    check('D9z 互动跑完关系仍自洽：关系行只有一条、双方字段互指、状态没被写坏',
        relRows9.length === 1 && String(relRows9[0].relation_state) === 'active'
        && N(pa9.dao_companion_id) === Number(relRows9[0].id) && N(pb9.dao_companion_id) === Number(relRows9[0].id),
        `行数=${relRows9.length} 状态=${relRows9[0] && relRows9[0].relation_state} A=${pa9.dao_companion_id} B=${pb9.dao_companion_id}`);

    // ===== D11 两人同时点"协议解除"（A/B 这对 dao_companion，取锁头与 D9 同源）=====
    const brk11 = await Promise.all([
        CompanionService.breakCompanion(A, 'agreement').catch(e => `抛错[${e.message}]`),
        CompanionService.breakCompanion(Bb, 'agreement').catch(e => `抛错[${e.message}]`)
    ]);
    const t11 = brk11.map(o => (typeof o === 'string') ? o : `${o && o.success ? '成' : '拒'}[${(o && o.message || '').slice(0, 30)}]`);
    const rel11 = await rowOf(require('../models/daoCompanion'), ids);
    check('D11 两人同时协议解除：不崩不死锁、只成一笔、同一段关系不会被拆两次',
        !brk11.some(o => typeof o === 'string' && isDeadlock({ message: o }))
        && t11.filter(x => x.startsWith('成')).length === 1
        && rel11.every(r => String(r.relation_state) === 'broken'),
        `${t11.join(' ;; ')}｜状态=${rel11.map(r => r.relation_state).join('/') || '无'}`);

    // ===== D12 GM 强制解除：GM 那条允许 pending（只拒已解除），别被"必须 active"挡回去 =====
    const re12 = await CompanionService.seek(A, Bb);
    const pend12 = (await rowOf(require('../models/daoCompanion'), ids)).filter(r => String(r.relation_state) === 'pending');
    const gm12 = pend12.length ? await CompanionService.gmBreakDaoCompanion(A) : { success: false, message: `没重建成 pending（seek=${re12 && re12.message}）` };
    const rel12 = await rowOf(require('../models/daoCompanion'), ids);
    const fields12 = [];
    for (const who of [A, Bb]) {
        const row12 = await Player.findByPk(who, { attributes: ['dao_companion_id'] });
        fields12.push(`${who}=${row12 && row12.dao_companion_id}`);
    }
    check('D12 GM 强制解除对 pending 关系也生效：关系行不再 active、双方字段都不再指着它',
        gm12 && gm12.success === true && rel12.every(r => String(r.relation_state) === 'broken')
        && !fields12.some(x => /=\d+/.test(x)),
        `${gm12 && gm12.message}｜${fields12.join(' ')}`);
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
                // dao_companion / dao_companions 用的是 player_a_id + player_b_id（一对两个，引用档），
                // 级联按"这一行属于谁"来清、不动它们，所以这两条仍然自己清；其余派生行交给级联。
                await sequelize.query('DELETE FROM dao_companion WHERE player_a_id IN (:ids) OR player_b_id IN (:ids)', { replacements: { ids } });
                await sequelize.query('DELETE FROM dao_companions WHERE player_a_id IN (:ids) OR player_b_id IN (:ids)', { replacements: { ids } });
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
