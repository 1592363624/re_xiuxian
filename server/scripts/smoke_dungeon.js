/**
 * 副本战斗端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：副本（DungeonService）此前既没有 jest 覆盖也没有探针覆盖，
 * 于是它一直是全场唯一"自己抄了一套伤害公式 + 玩家属性只取静态快照"的战斗入口 ——
 * 静态快照不含装备/功法/灵兽/法宝/傀儡，等于玩家进副本就把身上所有东西卸了：
 * 面板 128 攻，副本里按 40 攻打，而且不报错。
 *
 * 这里跑一个真实战斗节点，钉住三件事：
 *   D1 副本 HP 池来自**完整解析**的属性
 *   D2 玩家那一记的伤害按"含装备的攻"结算（不是静态快照的攻）
 *   D3 每一记都走声明式档位，并留下暴击/闪避判定位
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_dungeon.js
 * 探针自建/复用玩家 dungetest01，只动它自己的行，结束时清掉自己造的进度与装备。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5094);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { infrastructure } = require('../modules');
const Player = require('../models/player');
const PlayerEquipment = require('../models/playerEquipment');
const DungeonProgress = require('../models/dungeonProgress');
const DungeonRecord = require('../models/dungeonRecord');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const AttributeService = require('../game/core/AttributeService');
const CombatResolver = require('../game/combat/CombatResolver');
const DungeonService = require('../game/services/DungeonService');
const dungeonData = require('../config/dungeon_data.json');
const realms = require('../config/realm_breakthrough.json').realms;

const CHAPTER = dungeonData.chapters[0];
const BATTLE_NODE = CHAPTER.nodes.find(n => n.type === 'battle');
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/**
 * 挑一件"刚好能把两条伤害带分开、又不至于一下秒掉怪"的武器。
 *
 * 太弱（默认那把木剑 +5）→ 完整带与静态带重叠，D2 就变成赌随机浮动；
 * 太强（现网最强的 +18000）→ 一记秒怪，怪物那一侧的结算根本走不到。
 * 所以按静态攻击算一个下限，取满足下限里最弱的那件。
 */
function pickWeapon(staticAtk) {
    const config = infrastructure.ConfigLoader.getConfig('item_data');
    const need = Math.max(20, Math.ceil(Number(staticAtk) * 1.2));
    const list = (config?.items || []).filter(i => i.type === 'equipment' && i.subtype === 'weapon' && Number(i.effect?.atk) > 0);
    const sorted = list.slice().sort((a, b) => Number(a.effect.atk) - Number(b.effect.atk));
    return sorted.find(i => Number(i.effect.atk) >= need)
        || sorted.slice().sort((a, b) => Number(b.effect.atk) - Number(a.effect.atk))[0]
        || null;
}

async function ensurePlayer() {
    let player = await Player.findOne({ where: { username: 'dungetest01' } });
    if (!player) {
        player = await Player.create({
            username: 'dungetest01',
            password: 'not-a-real-hash',
            nickname: '副本探针',
            realm: '凡人',
            realm_rank: 0,
            exp: 0,
            spirit_stones: 100000,
            hp_current: 5000,
            mp_current: 5000,
            lifespan_current: 120,
            attributes: {},
            token_version: 0
        });
    }
    // 境界取章节要求的最低那一档：既过门槛，又不至于把攻防数值撑到两条路分不出来
    const target = realms.slice().sort((a, b) => a.rank - b.rank)[Math.max(0, Number(CHAPTER.min_realm_rank) || 0)];
    await sequelize.transaction(t => Player.update(
        {
            realm: target.name,
            realm_rank: target.rank,
            in_dungeon: false, in_battle: false, is_secluded: false, is_dead: false,
            death_reason: null, weakness_end_time: null,
            // 每日次数/冷却/时间戳都要清，否则同一天里第三次跑探针就会以"今日挑战次数已用完"失败
            last_dungeon_time: null, last_dungeon_date: null, daily_dungeon_count: 0,
            hp_current: 5000, mp_current: 5000, spirit_stones: 100000
        },
        { where: { id: player.id }, transaction: t }
    ));
    await DungeonProgress.destroy({ where: { player_id: player.id } });
    await DungeonRecord.destroy({ where: { player_id: player.id } });
    await PlayerEquipment.destroy({ where: { player_id: player.id } });
    return Player.findByPk(player.id);
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await ensurePlayer();
    /** 清掉探针自己造的行，再出报告（中途失败也要走到这里，不给库里留残留） */
    const finish = async () => {
        await DungeonService.interruptDungeon(await Player.findByPk(player.id)).catch(() => {});
        await DungeonProgress.destroy({ where: { player_id: player.id } });
        await DungeonRecord.destroy({ where: { player_id: player.id } });
        await PlayerEquipment.destroy({ where: { player_id: player.id } });
        await sequelize.transaction(t => Player.update({ in_dungeon: false, in_battle: false }, { where: { id: player.id }, transaction: t }));
        const failed = results.filter(r => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
        await sequelize.close();
        process.exit(failed.length ? 1 : 0);
    };
    // 先量一次"静态快照"（改造前副本用的那份），再按它挑一件刚好能分开的武器
    const staticAttrs = AttributeService.calculateFullAttributes(player).final;
    const weapon = pickWeapon(staticAttrs.atk);

    check('D0 内容里有加攻击的武器可用（否则 D2 是空跑）', Boolean(weapon),
        weapon ? `${weapon.id} effect=${JSON.stringify(weapon.effect)} 静态 atk=${staticAttrs.atk}` : '找不到 weapon 类装备');

    await PlayerEquipment.create({
        player_id: player.id, slot: 'weapon', item_key: weapon.id,
        equipped_at: new Date(), durability: 100, max_durability: 100
    });
    const fresh = await Player.findByPk(player.id);
    const { stats: full } = await CombatResolver.resolveCombatStats(fresh);
    check(
        'D0 这个号的"完整解析"与"静态快照"确实不同（装备真的进了解析，两条路可分辨）',
        Number(full.atk) > Number(staticAttrs.atk),
        `静态 atk=${staticAttrs.atk}, 完整 atk=${full.atk}, hp_max 完整=${full.hp_max}`
    );

    const started = await DungeonService.startDungeon(fresh, CHAPTER.id, 'normal');
    check('D1a 进入副本成功', started.success === true, `${started.message || ''} ${JSON.stringify(started.error_code || '')}`);

    const progress = await DungeonProgress.findOne({ where: { player_id: player.id } });
    check(
        'D1 副本 HP 池来自完整解析的属性（改造前取静态快照，等于进副本卸掉全身装备）',
        progress && Number(progress.hp_remaining) === Number(full.hp_max) && Number(progress.mp_remaining) === Number(full.mp_max),
        `hp_remaining=${progress?.hp_remaining}(应为 ${full.hp_max}), mp_remaining=${progress?.mp_remaining}(应为 ${full.mp_max})`
    );
    if (!progress) {
        // 进不去副本就没有任何可断言的数据：只报这一条失败，别用空对象凑出三个假绿
        console.log('进副本失败，D2-D4 无数据可断言');
        return finish();
    }

    // 直接站到战斗节点上（章节第一节点是剧情节点，探针不需要走完它）
    await DungeonProgress.update({ current_node_id: BATTLE_NODE.id, current_node_type: 'battle' }, { where: { id: progress.id } });

    const fought = await DungeonService.battleNode(await Player.findByPk(player.id));
    const log = fought?.data?.battle_log || [];
    const playerStrikes = log.filter(e => e.side === 'player' && !e.missed);
    const monsterDef = Number(BATTLE_NODE.monster.defense) || 0;
    // 暴击会把伤害再乘一次，所以每一记按它自己那条判定算带（不能拿非暴击的带上限去卡暴击那一记）
    const critFactor = 1 + Math.max(0, Number(full.crit_damage) || 0) / 100;
    const bandFor = (crit) => {
        const mult = crit ? critFactor : 1;
        const raw = (Number(full.atk) - monsterDef) * mult;
        return [Math.floor(raw * 0.8) - 1, Math.ceil(raw * 1.2) + 1];
    };
    const staticCeiling = Math.ceil((Number(staticAttrs.atk) - monsterDef) * 1.2 * critFactor) + 1;
    const [lo0, hi0] = bandFor(false);

    check(
        'D2 玩家每一记都只可能来自"含装备的攻击"（两条伤害带刻意不重叠）',
        fought?.success === true && playerStrikes.length >= 2 && staticCeiling < lo0
            && playerStrikes.every(e => {
                const [lo, hi] = bandFor(e.crit);
                return Number(e.damage) >= lo && Number(e.damage) <= hi && Number(e.damage) > staticCeiling;
            }),
        `出手${playerStrikes.length}记 非暴击带=[${lo0},${hi0}] 含暴击乘数=${critFactor} 静态带上限=${staticCeiling} `
        + `样本=${playerStrikes.slice(0, 3).map(e => `${e.damage}${e.crit ? '(暴)' : ''}`).join(',')}`
    );

    check(
        'D3 每一记都走声明式档位并留下暴击/闪避判定位（副本不再是服务里的私有公式）',
        log.length > 0 && log.every(e => typeof e.crit === 'boolean' && typeof e.missed === 'boolean' && e.damage_profile === 'dungeon_battle'),
        `首个=${JSON.stringify(log[0] && { p: log[0].damage_profile, c: log[0].crit, m: log[0].missed })} 回合数=${log.filter(e => e.side === 'player').length}`
    );

    const monsterStrikes = log.filter(e => e.side === 'monster');
    const hpValues = monsterStrikes.map(e => BigInt(e.player_hp));
    check(
        'D4 战斗记账自洽：至少走过一回合怪物回击、玩家 HP 不为负、结果与胜负判定一致',
        monsterStrikes.length >= 1 && hpValues.every(v => v >= 0n)
            && ['victory', 'defeat', 'draw'].includes(fought?.data?.battle_result),
        `结果=${fought?.data?.battle_result}, 玩家出手${playerStrikes.length}记/怪物回击${monsterStrikes.length}记, 最低HP=${hpValues.length ? String(hpValues.reduce((a, b) => (a < b ? a : b))) : '无'}`
    );

    return finish();
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    await sequelize.close().catch(() => {});
    process.exit(2);
});
