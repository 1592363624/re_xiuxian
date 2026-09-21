/**
 * 宗门战攻击路径端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：SectWarService.attackPlayer 此前既没有 jest 覆盖（jest 不连库），
 * 也不在其余探针的射程里（GET 探针只读、PvP/PVE 探针各打各的玩法）。
 * 而它刚好是"私有公式"最典型的一处——减伤系数、暴击率、暴击倍率、随机浮动全写死在服务里，
 * 玩家面板上的暴击对宗门战完全无效。现在收进 CombatResolver 的 sect_war_* 档位，
 * 必须有人证明：真实属性进来了、旧形状没走样、整块 blob 写回没吃掉并发键。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_sect_war.js
 * 探针自建两个专用玩家 sectwarta / sectwartb，并自建一场只对它们生效的战役。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5097);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const { Op } = require('sequelize');
const SectWar = require('../models/sectWar');
const SectWarParticipant = require('../models/sectWarParticipant');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const SectWarService = require('../game/services/SectWarService');

const SENTINEL = 'sect_war_probe_marker';
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
    player.is_dead = false;
    player.hp_current = 5000;
    player.mp_current = 5000;
    await player.save();
    await PlayerStateStore.patchPlayerState(player.id, {
        attributes: {
            [SENTINEL]: 'keep-me',
            hp_current: 5000,
            mp_current: 5000,
            sect_war_death_time: null,
            sect_war_defend_until: null
        }
    });
    return Player.findByPk(player.id);
}

async function createWar(a, b) {
    await SectWarParticipant.destroy({ where: { player_id: { [Op.in]: [a.id, b.id] } } });
    await SectWar.destroy({ where: { war_name: { [Op.like]: '探针宗门战%' } } });
    const war = await SectWar.create({
        war_name: `探针宗门战-${Date.now()}`,
        season_id: 1,
        attacker_sect_id: 'probe_sect_a',
        attacker_sect_name: '探针甲宗',
        defender_sect_id: 'probe_sect_b',
        defender_sect_name: '探针乙宗',
        status: 'active',
        prepare_end_time: new Date(Date.now() - 60000),
        active_start_time: new Date(Date.now() - 60000),
        active_end_time: new Date(Date.now() + 30 * 60000),
        attacker_score: 0, defender_score: 0,
        attacker_kills: 0, defender_kills: 0,
        attacker_participants: 1, defender_participants: 1,
        war_chest: 0
    });
    const sides = [['attacker', a, 'probe_sect_a', '探针甲宗'], ['defender', b, 'probe_sect_b', '探针乙宗']];
    for (const [side, player, sectId, sectName] of sides) {
        await SectWarParticipant.create({
            war_id: war.id,
            player_id: player.id,
            player_nickname: player.nickname,
            sect_id: sectId,
            sect_name: sectName,
            side,
            kill_count: 0, death_count: 0,
            damage_dealt: 0, damage_taken: 0,
            contribution_score: 0, honor_rewarded: 0, spirit_stone_rewarded: 0,
            is_online: 1,
            join_time: new Date()
        });
    }
    return war;
}

(async () => {
    await bootApp(app, { port: PORT });
    const a = await ensurePlayer('sectwarta', '宗门战探针甲');
    const b = await ensurePlayer('sectwartb', '宗门战探针乙');
    const war = await createWar(a, b);

    // ===== 1. 普攻：伤害由 sect_war_attack 档位结算 =====
    const plain = await SectWarService.attackPlayer(a.id, war.id, b.id, 'attack');
    check(
        'W1 宗门战普攻确实结算出伤害，且走的是 sect_war_* 档位（不再是服务里的私有公式）',
        Number(plain.damage) > 0 && plain.damage_profile === 'sect_war_attack' && plain.missed === false,
        `damage=${plain.damage}, profile=${plain.damage_profile}, missed=${plain.missed}, 守方HP=${plain.defender_hp}`
    );

    // ===== 2. 面板上的暴击率现在真的进宗门战（改造前是写死的 5%） =====
    await PlayerStateStore.patchPlayerState(a.id, { attributes: { crit_rate_bonus: 95 } });
    const critResult = await SectWarService.attackPlayer(a.id, war.id, b.id, 'attack');
    check(
        'W2 真实暴击率进宗门战：crit_rate 拉满后必暴击（旧实现写死 5%，玩家堆的暴击无效）',
        critResult.is_crit === true,
        `is_crit=${critResult.is_crit}, damage=${critResult.damage}`
    );
    await PlayerStateStore.patchPlayerState(a.id, { attributes: { crit_rate_bonus: null } });

    // ===== 3. 技能档位与 MP 消耗（倍率 1.5 来自档位，不是代码里乘的系数） =====
    // 宗门战的血蓝是"虚拟战斗值"，存在 attributes 里（players.mp_current 那一列属于世界/PVE 状态）
    await PlayerStateStore.patchPlayerState(a.id, { attributes: { mp_current: 5000 } });
    const beforeSkill = await Player.findByPk(a.id);
    const skillResult = await SectWarService.attackPlayer(a.id, war.id, b.id, 'skill');
    const afterSkill = await Player.findByPk(a.id);
    const mpBefore = Number(beforeSkill.attributes.mp_current) || 0;
    const mpAfter = Number(afterSkill.attributes.mp_current) || 0;
    check(
        'W3 技能走 sect_war_skill 档位并真的扣灵力',
        skillResult.damage_profile === 'sect_war_skill' && Number(skillResult.damage) > 0 && mpAfter < mpBefore,
        `profile=${skillResult.damage_profile}, damage=${skillResult.damage}, MP ${mpBefore}→${mpAfter}`
    );

    // ===== 4. 攻击方整块写回 attributes，不能吃掉并发写入的键（旧快照覆盖新快照） =====
    // attackPlayer 是"读整块 attributes → 改 hp/mp → 写整块"的写法（行锁内），
    // 这一项要证明的是：与它并发的键级补丁不会被回退掉。
    await PlayerStateStore.patchPlayerState(a.id, { attributes: { crit_rate_bonus: null } });
    const concurrent = await Promise.all([
        SectWarService.attackPlayer(a.id, war.id, b.id, 'attack'),
        PlayerStateStore.patchPlayerState(a.id, { attributes: { mid_sect_war: 'added' } }),
        SectWarService.attackPlayer(b.id, war.id, a.id, 'attack'),
        PlayerStateStore.patchPlayerState(b.id, { attributes: { mid_sect_war_b: 'added' } })
    ]);
    const afterA = await Player.findByPk(a.id);
    const afterB = await Player.findByPk(b.id);
    check(
        'W4 与攻击并发的键级写入两键都在（哨兵键 + 中途新增键），攻击结果也落了',
        afterA.attributes[SENTINEL] === 'keep-me' && afterA.attributes.mid_sect_war === 'added'
            && afterB.attributes[SENTINEL] === 'keep-me' && afterB.attributes.mid_sect_war_b === 'added'
            && concurrent[0] && concurrent[2],
        `A哨兵=${afterA.attributes[SENTINEL]}, A中途=${afterA.attributes.mid_sect_war}, ` +
        `B哨兵=${afterB.attributes[SENTINEL]}, B中途=${afterB.attributes.mid_sect_war_b}`
    );

    // ===== 5. 打到对方阵亡：HP 不为负、死亡计入参战记录 =====
    // 先把手动 HP 压到两记就能打死，否则宗门战的复活机制会让 30 次也打不死（那是机制，不是 bug）
    await PlayerStateStore.patchPlayerState(b.id, {
        attributes: { hp_current: 40, sect_war_death_time: null }
    });
    let last = null;
    for (let i = 0; i < 6; i++) {
        last = await SectWarService.attackPlayer(a.id, war.id, b.id, 'attack')
            .catch((error) => ({ error: error.message }));
        if (last?.defender_killed || last?.error) break;
    }
    const defenderAfter = await Player.findByPk(b.id);
    const defenderRecord = await SectWarParticipant.findOne({ where: { war_id: war.id, player_id: b.id } });
    check(
        'W5 打到对方阵亡：HP 不为负且死亡计入参战记录',
        last.defender_killed === true && Number(defenderAfter.attributes.hp_current) >= 0
            && Number(defenderRecord?.death_count) >= 1,
        `killed=${last.defender_killed}, HP=${defenderAfter.attributes.hp_current}, ` +
        `death_count=${defenderRecord?.death_count}, err=${last.error || '无'}`
    );

    await SectWarParticipant.destroy({ where: { war_id: war.id } });
    await SectWar.destroy({ where: { id: war.id } });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
