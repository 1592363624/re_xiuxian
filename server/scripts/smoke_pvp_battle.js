/**
 * 多人 PVP 斗法端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：tests/PvpDuelCombat.test.js 全是纯函数级（喂假属性、不连库），
 * 而"两个真实玩家在同一场战斗里交错出手"才是 PvP 架构真正要成立的部分：
 *   回合权判定、双方行锁、战斗内 HP 存在 attributes 里不被整块覆盖、结算只发生一次。
 * 这里跑一次真实对局，把这些性质逐个钉住。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_pvp_battle.js
 * 探针自建/复用两个专用玩家 pvptest01 / pvptest02，只动它们自己的行。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5095);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PvpBattleRecord = require('../models/pvpBattleRecord');
const PvpRanking = require('../models/pvpRanking');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const PvpService = require('../game/services/PvpService');

const SENTINEL = 'pvp_probe_marker';
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensurePlayer(username, nickname) {
    let player = await Player.findOne({ where: { username } });
    if (!player) {
        player = await Player.create({
            username,
            password: 'not-a-real-hash',
            nickname,
            realm: '炼气5层',
            realm_rank: 6,
            exp: 0,
            spirit_stones: 100000,
            hp_current: 5000,
            mp_current: 5000,
            lifespan_current: 25,
            attributes: {},
            token_version: 0
        });
    }
    return player;
}

/** 每轮探针前把两个玩家恢复到"可对战、blob 里有哨兵键"的状态 */
async function resetFighters(a, b) {
    for (const player of [a, b]) {
        await PvpBattleRecord.update(
            { status: 'finished' },
            { where: { status: 'ongoing', [require('sequelize').Op.or]: [{ attacker_id: player.id }, { defender_id: player.id }] } }
        );
        // 整块播种 attributes 必须带事务：blobWriteGuard 对 Player.update 这条 bulk 路径
        // 要求与实例路径一致（探针要的是"精确的初始 blob"，键级补丁做不到）
        await sequelize.transaction(t => Player.update(
            {
                is_dead: false,
                death_reason: null,
                hp_current: 5000,
                mp_current: 5000,
                is_secluded: false,
                in_battle: false,
                // 上一场对局的结算会给败方挂"虚弱"，并记每日挑战次数/冷却；
                // 探针要可重复运行，必须把这些战斗门槛清掉（只清自己的探针玩家）
                weakness_end_time: null,
                pvp_avoid_until: null,
                attributes: { [SENTINEL]: 'keep-me', hp_current: 5000, mp_current: 5000, hp_max: 5000 }
            },
            { where: { id: player.id }, transaction: t }
        ));
        // 斗法冷却与每日次数记在 PvpRanking 上（不是 players），探针要可重复运行就得清它
        const ranking = await PvpRanking.findOne({ where: { player_id: player.id } });
        if (ranking) {
            ranking.last_battle_time = null;
            ranking.daily_challenge_count = 0;
            ranking.daily_defend_count = 0;
            await ranking.save();
        }
    }
}

(async () => {
    await bootApp(app, { port: PORT });

    const a = await ensurePlayer('pvptest01', '斗法甲');
    const b = await ensurePlayer('pvptest02', '斗法乙');
    await resetFighters(a, b);

    // ===== 1. 发起挑战 =====
    const opened = await PvpService.challenge(a.id, b.id, 'normal');
    const battleId = opened?.battle?.id || opened?.battle_id || opened?.id;
    let battle = await PvpBattleRecord.findByPk(battleId);
    check(
        'P1 挑战建立了一场进行中的斗法，双方都被登记',
        Boolean(battle) && battle.status === 'ongoing'
            && Number(battle.attacker_id) === a.id && Number(battle.defender_id) === b.id,
        `battle=${battle ? battle.id : 'null'}, status=${battle?.status}`
    );

    // ===== 2. 回合权：非行动方出手必须被拒 =====
    const startLog = JSON.parse(battle.battle_log || '[]').find(e => e.event === 'battle_start');
    const firstIsAttacker = (startLog?.first_attacker || 'attacker') === 'attacker';
    const wrongTurnId = firstIsAttacker ? b.id : a.id;
    let wrongTurnRejected = null;
    try {
        await PvpService.executeAction(wrongTurnId, 'attack');
    } catch (error) {
        wrongTurnRejected = error.message || String(error);
    }
    check(
        'P2 未轮到的一方出手被拒（回合权不是靠客户端自觉）',
        wrongTurnRejected !== null && /回合/.test(wrongTurnRejected),
        wrongTurnRejected ? `已拒：${wrongTurnRejected}` : '竟然接受了越权出手'
    );

    // ===== 3. 打完整场：交替出手，并在中途并发写 blob =====
    let outOfTurnSeen = 0;
    let interrupted = null;
    for (let round = 0; round < 60; round++) {
        battle = await PvpBattleRecord.findByPk(battleId);
        if (!battle || battle.status !== 'ongoing') break;

        const attackerTurn = firstIsAttacker ? (battle.total_rounds % 2 === 0) : (battle.total_rounds % 2 === 1);
        const actorId = attackerTurn ? a.id : b.id;
        const idleId = attackerTurn ? b.id : a.id;

        try {
            // 对手在同一时刻往同一个 blob 里写一个无关键：
            // 战斗内 HP 就存在 attributes 里，整块写回会把它连同哨兵键一起抹掉
            await Promise.all([
                PvpService.executeAction(actorId, 'attack'),
                PlayerStateStore.patchPlayerState(idleId, { attributes: { [`mid_${round}`]: round } })
            ]);
        } catch (error) {
            const message = error.message || String(error);
            if (/回合/.test(message)) { outOfTurnSeen++; continue; }
            interrupted = message;
            break;
        }
    }

    battle = await PvpBattleRecord.findByPk(battleId);
    check(
        'P3 对局在有限回合内自然结束（没有死循环、没有中途异常）',
        battle.status !== 'ongoing' && interrupted === null,
        `status=${battle.status}, rounds=${battle.total_rounds}${interrupted ? ', 异常: ' + interrupted : ''}`
    );

    // ===== 4. 胜负判定与规则一致（超时按 HP 高者胜，相等为平局）=====
    const log = JSON.parse(battle.battle_log || '[]');
    const starts = log.filter(e => e.event === 'battle_start');
    const winnerId = battle.winner_id ? Number(battle.winner_id) : null;
    const finalA = Number((await Player.findByPk(a.id)).attributes?.hp_current || 0);
    const finalB = Number((await Player.findByPk(b.id)).attributes?.hp_current || 0);
    const expectedWinner = finalA === finalB ? null : (finalA > finalB ? a.id : b.id);
    check(
        'P4 胜者与"HP 高者胜/相等判平"的规则一致，且开局事件只有一条',
        starts.length === 1 && winnerId === expectedWinner
            && Number(battle.total_rounds) <= (PvpService.getPvpConfig().max_rounds || 30),
        `winner=${winnerId}, 按HP应为=${expectedWinner}, A=${finalA}, B=${finalB}, rounds=${battle.total_rounds}, 开局事件=${starts.length}`
    );

    // ===== 5. 回放战斗日志：HP 除日志记明的回血外单调不增、不为负，回合严格交替 =====
    const hpTrail = new Map([[a.id, []], [b.id, []]]);
    const actorOrder = [];
    for (const entry of log) {
        if (!entry.actor_id) continue;
        const targetId = Number(entry.actor_id) === a.id ? b.id : a.id;
        // 出手方当回合可以因为吸血/吃丹回血，这是唯一被允许的上涨；
        // 承伤方在同一条日志里只会掉血。放宽到"有记录的回血"而不是取消这条不变量，
        // 否则 procs 上线后这里就变成假告警，而"HP 莫名上涨"是真事故。
        const actorHeal = (Number(entry.lifesteal) || 0) + (Number(entry.item?.hp_restore) || 0);
        hpTrail.get(Number(entry.actor_id)).push({ hp: Number(entry.actor_hp), healed: actorHeal });
        hpTrail.get(targetId).push({ hp: Number(entry.defender_hp), healed: 0 });
        actorOrder.push(Number(entry.actor_id));
    }
    const hpMonotonic = [...hpTrail.values()].every(trail =>
        trail.every((step, i) => step.hp >= 0 && (i === 0 || step.hp <= trail[i - 1].hp + step.healed))
    );
    check(
        'P5 回放日志：双方 HP 除记明的吸血/丹药回血外单调不增且不为负',
        hpMonotonic && actorOrder.length > 0,
        `出招${actorOrder.length}次, A轨迹首末=${hpTrail.get(a.id)[0]?.hp}→${hpTrail.get(a.id).slice(-1)[0]?.hp}, ` +
        `B=${hpTrail.get(b.id)[0]?.hp}→${hpTrail.get(b.id).slice(-1)[0]?.hp}`
    );

    const alternates = actorOrder.every((id, i) => i === 0 || id !== actorOrder[i - 1]);
    check(
        'P5 回合严格交替，没有一方连出两招（服务端回合权是真的在管）',
        alternates,
        alternates ? '严格交替' : `出现连续出手：${actorOrder.slice(0, 8).join(',')}`
    );

    const afterA = (await Player.findByPk(a.id)).attributes || {};
    const afterB = (await Player.findByPk(b.id)).attributes || {};
    const siblingsKept = [afterA, afterB].every(attrs => attrs[SENTINEL] === 'keep-me');
    check(
        'P5 整场对局后双方 blob 的哨兵键与中途并发写入的键都在（战斗写 HP 没有整块覆盖）',
        siblingsKept && Object.keys(afterA).concat(Object.keys(afterB)).some(k => k.startsWith('mid_')),
        `A哨兵=${afterA[SENTINEL]}, B哨兵=${afterB[SENTINEL]}, 并发键样本=` +
        `${Object.keys(afterB).filter(k => k.startsWith('mid_')).slice(0, 3).join(',') || '无'}`
    );

    // ===== 6. 战斗结束后不能继续出手，也不会残留 ongoing =====
    let afterEndRejected = null;
    try {
        await PvpService.executeAction(a.id, 'attack');
    } catch (error) {
        afterEndRejected = error.message || String(error);
    }
    const leftover = await PvpBattleRecord.count({
        where: {
            status: 'ongoing',
            [require('sequelize').Op.or]: [{ attacker_id: a.id }, { defender_id: a.id }, { attacker_id: b.id }, { defender_id: b.id }]
        }
    });
    check(
        'P6 结束后出手被拒，且不残留进行中的战斗记录',
        afterEndRejected !== null && leftover === 0,
        `${afterEndRejected || '竟然还能出手'}, 残留 ongoing=${leftover}`
    );

    // ===== 7. 神通声明的伤害档位真的被用上（资料片新档位可打出来）=====
    // 上一场已结束，这里重开一场，只打一记神通
    await resetFighters(a, b);
    const PlayerTechnique = require('../models/playerTechnique');
    await PlayerTechnique.destroy({ where: { player_id: a.id } });
    await PlayerTechnique.create({
        player_id: a.id,
        technique_id: 'huang_basic_qi',
        layer: 1,
        proficiency: 0,
        // 只有"已装备"的功法才提供属性与神通（equip_slot 为空 = 学了但没修），
        // 不写这一行的话神通根本进不了战斗，P7 就会变成一次空跑
        equip_slot: 'main',
        comprehended_skills: ['sword_qi_slash']
    });
    await PlayerStateStore.patchPlayerState(a.id, { attributes: { sword_intent_bonus: 200 } });

    const second = await PvpService.challenge(a.id, b.id, 'normal');
    const secondId = second?.battle?.id || second?.battle_id || second?.id;

    // 先手由速度决定，A 不一定是第一个出手的人：先把回合让到 A 手上
    for (let i = 0; i < 4; i++) {
        const cur = await PvpBattleRecord.findByPk(secondId);
        if (!cur || cur.status !== 'ongoing') break;
        const started = JSON.parse(cur.battle_log || '[]').find(e => e.event === 'battle_start');
        const attackerFirst = (started?.first_attacker || 'attacker') === 'attacker';
        const aTurn = attackerFirst ? (cur.total_rounds % 2 === 0) : (cur.total_rounds % 2 === 1);
        if (aTurn) break;
        await PvpService.executeAction(b.id, 'attack').catch(() => {});
    }

    const skillResult = await PvpService.executeAction(a.id, 'skill');
    const secondBattle = await PvpBattleRecord.findByPk(secondId);
    const lastEntry = JSON.parse(secondBattle?.battle_log || '[]').slice(-1)[0] || {};

    check(
        'P7 领悟"剑气斩"后出手走 player_sword_intent 档位（资料片新增档位能打出来）',
        lastEntry.action === 'skill' && lastEntry.damage_profile === 'player_sword_intent' && Number(lastEntry.damage) > 0,
        `action=${lastEntry.action}, profile=${lastEntry.damage_profile}, damage=${lastEntry.damage}` +
        `${skillResult?.message ? ', ' + skillResult.message : ''}`
    );

    // 没领悟任何带档位的神通时，必须退回默认档位而不是乱选
    await PlayerTechnique.destroy({ where: { player_id: a.id } });
    await PlayerTechnique.create({
        player_id: a.id, technique_id: 'huang_basic_qi', layer: 1, proficiency: 0,
        equip_slot: 'main', comprehended_skills: ['flame_burst']
    });
    if (secondBattle.status === 'ongoing') {
        await PvpService.executeAction(b.id, 'attack').catch(() => {});
        const fallbackEntry = JSON.parse((await PvpBattleRecord.findByPk(secondId)).battle_log || '[]')
            .filter(e => e.actor_id === b.id).slice(-1)[0] || {};
        check(
            'P7 未声明档位的神通仍走默认 player_basic（新机制不影响老内容）',
            fallbackEntry.damage_profile === 'player_basic',
            `profile=${fallbackEntry.damage_profile}`
        );
    }

    // ===== 8. 面板上的暴击率 / 吸血真的进战斗（procs 层不再是只写在配置里的空承诺） =====
    // 属性来自 attributes 的 *_bonus 存储键，经 StatRegistry 的 bonusKey 白名单进入解析结果，
    // 再由 CombatResolver 按 battleRole（crit_chance / lifesteal）掷骰——全程无一处硬编码属性名。
    await resetFighters(a, b);
    await PlayerStateStore.patchPlayerState(a.id, {
        attributes: { crit_rate_bonus: 95, crit_damage_bonus: 100, lifesteal_bonus: 20 }
    });

    const third = await PvpService.challenge(a.id, b.id, 'normal');
    const thirdId = third?.battle?.id || third?.battle_id || third?.id;
    const thirdLog = async () => JSON.parse((await PvpBattleRecord.findByPk(thirdId))?.battle_log || '[]');
    const isATurn = async () => {
        const cur = await PvpBattleRecord.findByPk(thirdId);
        const started = (await thirdLog()).find(e => e.event === 'battle_start');
        const attackerFirst = (started?.first_attacker || 'attacker') === 'attacker';
        return attackerFirst ? (cur.total_rounds % 2 === 0) : (cur.total_rounds % 2 === 1);
    };

    let critEntry = null;
    for (let i = 0; i < 6 && (await PvpBattleRecord.findByPk(thirdId))?.status === 'ongoing'; i++) {
        if (await isATurn()) {
            await PvpService.executeAction(a.id, 'attack');
            const entry = (await thirdLog()).slice(-1)[0] || {};
            // 开局满血时吸血必然是 0，要等 B 先打掉一点血之后那一记才算数
            if (entry.crit === true && Number(entry.lifesteal) > 0) { critEntry = entry; break; }
            if (entry.crit === true && !critEntry) critEntry = entry;
        } else {
            await PvpService.executeAction(b.id, 'attack').catch(() => {});
        }
    }
    check(
        'P8 面板上的暴击率/吸血真的进战斗（必暴击 + 打出去的伤害按比例回血）',
        !!critEntry && critEntry.crit === true && Number(critEntry.lifesteal) > 0,
        `crit=${critEntry?.crit}, damage=${critEntry?.damage}, lifesteal=${critEntry?.lifesteal}`
    );
    await PlayerStateStore.patchPlayerState(a.id, {
        attributes: { crit_rate_bonus: null, crit_damage_bonus: null, lifesteal_bonus: null }
    });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
