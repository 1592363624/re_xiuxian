/**
 * 世界Boss + 兽潮攻击路径端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：这两个玩法各自抄了一份伤害公式，而且把暴击写成常量
 * （cfg.crit_rate 0.05 / crit_multiplier 1.5 / ±15% 浮动），玩家面板上的暴击对 BOSS 战与兽潮
 * 完全无效；现在都收进 combat_formulas.json 的 ratio_mitigation 档位。
 * 这里跑真实攻击，把"收进去之后行为仍然正确"钉住：档位被用上、真实暴击生效、
 * 血量按上报的伤害扣减、玩法倍率仍乘在结算之后。
 * 另外钉住两件只有连库才看得出来的事：BOSS 技能反击也走档位（于是玩家闪避能闪掉它），
 * 以及探针死后留下的派生状态不会把下一次运行挡在门外。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_pve_bosses.js
 * 探针自建玩家 bosstest01，并把自建/已存在的 Boss、妖兽事件推到可攻击阶段。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const WorldBossService = require('../game/services/WorldBossService');
const BeastInvasionService = require('../game/services/BeastInvasionService');
const WorldBossInstance = require('../models/worldBoss');
const BeastInvasion = require('../models/beastInvasion');
const worldBossData = require('../config/world_boss_data.json');
const beastData = require('../config/beast_invasion_data.json');
const WorldBossDamageRecord = require('../models/worldBossDamageRecord');
const BeastInvasionAttack = require('../models/beastInvasionAttack');

const SENTINEL = 'boss_probe_marker';
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensurePlayer() {
    let player = await Player.findOne({ where: { username: 'bosstest01' } });
    if (!player) {
        player = await Player.create({
            username: 'bosstest01',
            password: 'not-a-real-hash',
            nickname: 'BOSS探针',
            realm: '筑基初期',
            realm_rank: 11,
            exp: 0,
            spirit_stones: 100000,
            hp_current: 5000,
            mp_current: 5000,
            lifespan_current: 120,
            attributes: {},
            token_version: 0
        });
    }
    player.realm = '筑基初期';
    player.realm_rank = 11;
    player.is_dead = false;
    player.hp_current = 5000;
    player.mp_current = 5000;
    await player.save();
    await PlayerStateStore.patchPlayerState(player.id, {
        attributes: {
            [SENTINEL]: 'keep-me',
            hp_current: 5000,
            mp_current: 5000,
            // 夺舍重生是"肉身已毁"的互斥状态，上一次运行被打死就会留下
            reincarnation_state: 'none',
            // 高防高血：BOSS 反击按玩家真实减伤结算，不设防的话探针玩家几记反击就死了
            def_bonus: 60000,
            hp_bonus: 400000,
            // 反击率必须显式清零：B5 要"每一记反击都打出伤害"，而闪避一旦留在 blob 里
            // （B7 会临时拉满 dodge_rate_bonus，别的探针/浏览器验收也会设）就有 75% 被闪掉，
            // 于是这条断言变成偶发失败。探针的输入状态要自己关住，不能指望上一次运行收拾干净。
            dodge_rate_bonus: null
        }
    });
    return Player.findByPk(player.id);
}

/** 取一个能打的 BOSS：spawnBoss 建的是 pending，探针自己推进到 active */
/** 两个玩法都有攻击CD（BOSS 5 秒、妖兽 10 秒），探针要连打多次，先把CD抹掉 */
async function clearBossCooldown(bossId, playerId) {
    await WorldBossDamageRecord.update(
        { last_attack_time: new Date(0) }, { where: { boss_id: bossId, player_id: playerId } });
}

async function clearBeastCooldown(invasionId, playerId) {
    // 模型是 underscored: true，实例属性名是 createdAt
    await BeastInvasionAttack.update(
        { createdAt: new Date(0) }, { where: { invasion_id: invasionId, player_id: playerId } });
}

async function prepareBoss() {
    const key = worldBossData.bosses[0].boss_key;
    // spawnBoss 对"同一只 BOSS 已有活着的实例"是直接报错的，所以先捞现有实例
    let boss = await WorldBossInstance.findOne({
        where: { status: { [Op.in]: ['active', 'pending'] } },
        order: [['id', 'DESC']]
    });
    if (!boss) {
        // spawnBoss 返回的是 { boss_id, ... } 而不是模型实例
        const spawned = await WorldBossService.spawnBoss(key, 0, 500000);
        boss = await WorldBossInstance.findByPk(spawned?.boss_id ?? spawned?.id);
    }
    boss.status = 'active';
    boss.active_start_time = new Date(Date.now() - 1000);
    boss.spawn_time = new Date(Date.now() - 1000);
    boss.expire_time = new Date(Date.now() + 30 * 60000);
    boss.hp_current = 500000;
    boss.hp_max = 500000;
    await boss.save();
    return WorldBossInstance.findByPk(boss.id);
}

async function prepareBeast() {
    const key = beastData.beasts[0].beast_key;
    let beastRow = await BeastInvasion.findOne({
        where: { status: { [Op.in]: ['active', 'preparing', 'donation'] } },
        order: [['id', 'DESC']]
    });
    if (!beastRow) {
        const spawned = await BeastInvasionService.spawnInvasion(key);
        beastRow = await BeastInvasion.findByPk(spawned?.invasion_id ?? spawned?.id);
    }
    const beast = beastRow;
    const now = Date.now();
    // 入侵事件只有 start_time / donation_end_time / battle_end_time 三个时间点：
    // 把捐献期推到过去、战斗期留在未来，attackBeast 才认为现在可打
    beast.status = 'active';
    beast.phase = 'battle';
    beast.start_time = new Date(now - 3600000);
    beast.donation_end_time = new Date(now - 1000);
    beast.battle_end_time = new Date(now + 30 * 60000);
    if (Number(beast.hp_current) <= 0) beast.hp_current = 200000;
    await beast.save();
    return BeastInvasion.findByPk(beast.id);
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await ensurePlayer();

    // 两个玩法的互斥状态都是从"最近一次攻击记录"派生的（妖兽看 beast_invasion_attacks 的
    // created_at 是否在 active_window_ms 内，BOSS 看 damage_record.last_attack_time），
    // 所以上一次运行留下的记录会把这一轮挡在外面——先把探针玩家的状态清空。
    const boss = await prepareBoss();
    const beast = await prepareBeast();
    await clearBossCooldown(boss.id, player.id);
    await clearBeastCooldown(beast.id, player.id);

    // ========== 世界 BOSS ==========
    let bossOut = null;
    try {
        bossOut = await WorldBossService.attackBoss(player.id, boss.id, 'skill');
    } catch (error) {
        bossOut = { error: error.message };
    }
    const bossBreakdown = bossOut?.attack?.damage_breakdown || {};
    const bossRow = await WorldBossInstance.findByPk(boss.id);
    check(
        'B1 BOSS 战伤害由 ratio_mitigation 档位结算，且 BOSS 血量按上报伤害扣减',
        bossOut?.attack?.damage > 0
            && bossBreakdown.damage_profile === 'ratio_mitigation'
            && Number(boss.hp_current) - Number(bossRow.hp_current) === Number(bossOut.attack.damage),
        `damage=${bossOut?.attack?.damage}, profile=${bossBreakdown.damage_profile}, `
        + `BOSS HP ${bossRow ? `${boss.hp_current}→${bossRow.hp_current}` : '?'}`
        + (bossOut?.error ? `, 异常: ${bossOut.error}` : '')
    );

    // 面板上的暴击率现在真的进 BOSS 战（改造前是 cfg 里写死的 5%）
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { crit_rate_bonus: 95 } });
    let critSeen = false;
    let critDetail = '';
    for (let i = 0; i < 12 && !critSeen; i++) {
        await clearBossCooldown(boss.id, player.id);
        const res = await WorldBossService.attackBoss(player.id, boss.id, 'basic')
            .catch((error) => ({ error: error.message }));
        critSeen = res?.attack?.is_crit === true;
        critDetail = `is_crit=${res?.attack?.is_crit}, damage=${res?.attack?.damage}, err=${res?.error || '无'}`;
    }
    check('B2 真实暴击率进 BOSS 战（拉满后必暴击，写死的 5% 已失效）', critSeen, critDetail);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { crit_rate_bonus: null } });

    // ========== 兽潮 ==========
    await clearBossCooldown(boss.id, player.id);
    let beastOut = null;
    await clearBeastCooldown(beast.id, player.id);
    try {
        beastOut = await BeastInvasionService.attackBeast(player.id, beast.id, { skill_id: 'skill' });
    } catch (error) {
        beastOut = { error: error.message };
    }
    const beastBreakdown = beastOut?.attack?.damage_breakdown || {};
    check(
        'B3 兽潮伤害由 ratio_mitigation 档位结算，且明细报出档位与本记触发结果',
        beastOut?.attack?.damage > 0 && beastBreakdown.damage_profile === 'ratio_mitigation'
            && typeof beastBreakdown.crit === 'boolean' && typeof beastBreakdown.external_multiplier === 'number',
        `damage=${beastOut?.attack?.damage}, profile=${beastBreakdown.damage_profile}, `
        + `crit=${beastBreakdown.crit}, external=${beastBreakdown.external_multiplier}`
        + (beastOut?.error ? `, 异常: ${beastOut.error}` : '')
    );

    await PlayerStateStore.patchPlayerState(player.id, { attributes: { crit_rate_bonus: 95 } });
    let beastCrit = false;
    let beastDetail = '';
    for (let i = 0; i < 12 && !beastCrit; i++) {
        await clearBeastCooldown(beast.id, player.id);
        const res = await BeastInvasionService.attackBeast(player.id, beast.id, {})
            .catch((error) => ({ error: error.message }));
        beastCrit = res?.attack?.is_crit === true;
        beastDetail = `is_crit=${res?.attack?.is_crit}, damage=${res?.attack?.damage}, err=${res?.error || '无'}`;
    }
    check('B4 真实暴击率进兽潮（拉满后必暴击）', beastCrit, beastDetail);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { crit_rate_bonus: null } });

    // ========== 妖兽反击：同一个档位，攻防两侧传反 ==========
    // 兽潮反击原本是 counter_rate 概率触发（0.4），"每记都反击"不能靠抛硬币，
    // 所以只在本进程的配置视图里把这一只妖兽的反击率改成必触发
    const { infrastructure } = require('../modules');
    const bd = infrastructure.ConfigLoader.getConfig('beast_invasion_data');
    infrastructure.ConfigLoader.setMergedConfig('beast_invasion_data', {
        ...bd,
        beasts: (bd.beasts || []).map(b =>
            b.beast_key === beast.beast_key ? { ...b, counter_rate: 1 } : b)
    });

    const counters = [];
    let counterErr = '无';
    for (let i = 0; i < 6; i++) {
        await clearBeastCooldown(beast.id, player.id);
        const before = await BeastInvasion.findByPk(beast.id);
        // 反击伤害不在 attack 响应里（只在 beast_invasion_attacks 流水与事件的 total_damage_dealt 上），
        // 所以用"这一记之前/之后妖兽总共打出去的伤害"来判定，比读一个响应里根本不存在的字段可靠
        const dealtBefore = Number(before.total_damage_dealt);
        const hpBefore = Number(before.hp_current);
        const res = await BeastInvasionService.attackBeast(player.id, beast.id, {})
            .catch((error) => ({ error: error.message }));
        if (res?.error) { counterErr = res.error; continue; }
        const after = await BeastInvasion.findByPk(beast.id);
        counters.push(Number(after.total_damage_dealt) - dealtBefore);
        // 妖兽反击只扣"虚拟战斗血"（runtime 里），真实 HP 不该被顺手改掉
        if (Number(after.hp_current) > hpBefore) counters.push(-1);
    }
    check(
        'B5 妖兽反击走同一档位（攻防两侧传反）：每记都真的打出伤害，且不会顺手回写妖兽真实 HP',
        counters.length === 6 && counters.every(v => v >= 1),
        `反击伤害=${counters.join(',') || '无'}${counters.length === 6 ? '' : ', 最后异常: ' + counterErr}`
    );

    // ========== BOSS 技能反击：第 7 份私有减伤公式也收进档位了 ==========
    // WorldBossSkillManager 里原本自己写了一遍 def/(def+atk*2+1000) + ±10% 浮动，
    // 于是 BOSS 打玩家只看玩家 def：玩家堆的闪避、神通的伤害减免在 BOSS 技能下全部无效。
    // 现在反击走 ratio_mitigation_boss_skill，承受方传玩家解析后的完整属性块。
    // 上面兽潮那几记把玩家留在 IN_BEAST_INVASION（与一切状态互斥），
    // 不先抹掉攻击记录的话，这里的每一记 BOSS 攻击都会被"斩妖中"挡回来。
    await clearBeastCooldown(beast.id, player.id);
    const counterProfiles = [];
    let counterSkill = '';
    for (let i = 0; i < 8; i++) {
        await clearBossCooldown(boss.id, player.id);
        const res = await WorldBossService.attackBoss(player.id, boss.id, 'basic')
            .catch((error) => ({ error: error.message }));
        const c = res?.counter;
        // 召唤/自身 Buff 这两类技能不出伤害，也就没有档位
        if (c?.skill && !c.skill.is_summon && !c.skill.is_buff) {
            counterProfiles.push(c.damage_profile);
            counterSkill = `${c.skill.name}(${c.skill.type}) damage=${c.damage}`;
        }
    }
    check(
        'B6 BOSS 技能反击走 ratio_mitigation_boss_skill 档位（不再自己抄一份减伤曲线）',
        counterProfiles.length > 0 && counterProfiles.every(p => p === 'ratio_mitigation_boss_skill'),
        `档位=${[...new Set(counterProfiles)].join('/') || '无'}, 样本=${counterSkill}`
    );

    await PlayerStateStore.patchPlayerState(player.id, { attributes: { dodge_rate_bonus: 100 } });
    let dodged = null;
    let dodgeDetail = '';
    for (let i = 0; i < 20 && !dodged; i++) {
        await clearBossCooldown(boss.id, player.id);
        const res = await WorldBossService.attackBoss(player.id, boss.id, 'basic')
            .catch((error) => ({ error: error.message }));
        if (res?.error) { dodgeDetail = `异常: ${res.error}`; continue; }
        if (res?.counter?.missed === true) {
            // 闪避的那一记必须真的不扣血，而不是"标了 missed 但伤害照吃"
            dodged = res.player?.battle_hp_before === res.player?.battle_hp_after;
        }
        dodgeDetail = `missed=${res?.counter?.missed}, damage=${res?.counter?.damage}, `
            + `HP ${res?.player?.battle_hp_before}→${res?.player?.battle_hp_after}`;
    }
    check('B7 玩家闪避属性能闪掉 BOSS 技能（改造前 BOSS 反击无视一切减免）', !!dodged, dodgeDetail);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { dodge_rate_bonus: null } });

    // 收尾：把探针造成的派生状态清掉，免得下一次运行一上来就被"斩妖中/讨伐中"挡住
    await clearBeastCooldown(beast.id, player.id);
    await clearBossCooldown(boss.id, player.id);

    const after = await Player.findByPk(player.id);
    check(
        'B8 整场探针后 blob 哨兵键仍在（战斗与并发写没互相整块覆盖）',
        after?.attributes?.[SENTINEL] === 'keep-me',
        `哨兵=${after?.attributes?.[SENTINEL]}`
    );

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
