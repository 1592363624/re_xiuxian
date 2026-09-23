/**
 * 单人 PVE 战斗端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：CombatService 的 encounter/attack/monsterTurn/useSkill 此前
 * 既没有 jest 覆盖（jest 不连库），也没有探针覆盖（其余探针只走 GET 与 PvP/切磋/突破写入），
 * 于是"怪物那一记还在用第五份手写伤害公式、玩家的闪避/格挡/神通减免对 PVE 完全无效"
 * 这种事没有任何自动化信号。这里跑一场真战斗，把关键性质逐个钉住。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_pve_battle.js
 * 探针自建/复用单个专用玩家 pvetest01，只动它自己的行。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5096);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const ActiveBattle = require('../models/activeBattle');
const PlayerTechnique = require('../models/playerTechnique');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const CombatService = require('../game/services/CombatService');
const mapData = require('../config/map_data.json');

const SENTINEL = 'pve_probe_marker';
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

function mapWithMonsters() {
    const maps = mapData.maps || mapData;
    const list = Array.isArray(maps) ? maps : Object.values(maps);
    const withMobs = list.filter(m => Array.isArray(m.monsters) && m.monsters.length > 0);
    // 挑全场血最厚的那只：战斗必须持续几回合，才看得到怪物回击、也才来得及断言"技能那一记走了哪条档位"
    // （致命一击会把 ActiveBattle 行删掉，之后再读日志就读不到了）
    let best = null;
    for (const map of withMobs) {
        for (const monster of map.monsters) {
            if (!best || Number(monster.hp) > Number(best.monster.hp)) best = { map, monster };
        }
    }
    return best;
}


async function ensurePlayer() {
    const pick = mapWithMonsters();
    if (!pick) throw new Error('map_data.json 里找不到带怪物的地图，探针无法继续');
    const map = pick.map;
    let player = await Player.findOne({ where: { username: 'pvetest01' } });
    if (!player) {
        player = await Player.create({
            username: 'pvetest01',
            password: 'not-a-real-hash',
            nickname: 'PVE探针',
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
    player.current_map_id = map.id;
    await player.save();
    return { player, monster: pick.monster };
}

async function logOf(playerId) {
    const battle = await ActiveBattle.findOne({ where: { player_id: playerId } });
    const log = battle?.battle_log;
    return typeof log === 'string' ? JSON.parse(log || '[]') : (log || []);
}

(async () => {
    await bootApp(app, { port: PORT });
    const { player, monster } = await ensurePlayer();
    const playerId = player.id;

    // 清掉残留战斗与功法，保证这一场是干净开局
    await ActiveBattle.destroy({ where: { player_id: playerId } });
    await PlayerStateStore.patchPlayerState(playerId, { attributes: { [SENTINEL]: 'keep-me' } });
    // 一门带特效与档位的神通：剑气斩（extra_damage_rate + player_sword_intent 档位）
    await PlayerTechnique.destroy({ where: { player_id: playerId } });
    await PlayerTechnique.create({
        player_id: playerId,
        technique_id: 'huang_basic_qi',
        layer: 1,
        proficiency: 0,
        // 只有"已装备"的功法才提供属性与神通
        equip_slot: 'main',
        comprehended_skills: ['sword_qi_slash']
    });
    // 不堆剑意：让剑修档位按 atk 兜底结算，这样一记技能不会秒杀怪物，
    // 战斗记录也就不会因为结束而被删掉（结束后 ActiveBattle 行即删除，日志读不到了）

    const encounter = await CombatService.encounter(playerId, monster.id);
    const opening = await ActiveBattle.findOne({ where: { player_id: playerId } });
    check(
        'V1 遭遇建立了一场进行中的战斗，怪物与玩家 HP 都已落库',
        !!opening && Number(opening.monster_hp) > 0 && Number(opening.player_hp) > 0
            && !!encounter?.monster?.name,
        `monster=${encounter?.monster?.name}, 怪物HP=${opening?.monster_hp}, 玩家HP=${opening?.player_hp}`
    );

    // 打若干回合：玩家出手 → 怪物回击，直到战斗结束
    const playerStrikes = [];
    const monsterStrikes = [];
    let finished = null;
    for (let round = 0; round < 40; round++) {
        // 现网低级怪只有几十血，探针玩家的伤害会一记秒杀；结束的战斗行会被删掉，
        // 日志也就读不到了。把怪血抬高，纯粹是为了让战斗持续几回合，好看清技能那一记走了哪条档位。
        if (round === 0) {
            await ActiveBattle.update({ monster_hp: 5000, monster_max_hp: 5000 },
                { where: { player_id: playerId } });
        }

        const before = await ActiveBattle.findOne({ where: { player_id: playerId } });
        if (!before) break;
        const monsterHpBefore = Number(before.monster_hp);
        const playerHpBefore = Number(before.player_hp);

        // 第一记用普攻，之后用技能：技能分支才是"按神通声明选档位"的那条路
        const action = round === 0 ? 'attack' : 'skill';
        const attackResult = await CombatService.attack(playerId, action);
        // 先取日志再看是否结束：致命一击那一记的档位也必须被断言到
        const afterStrike = (await logOf(playerId)).slice(-1)[0] || {};
        if (afterStrike.damage !== undefined) {
            playerStrikes.push({ ...afterStrike, action, monsterHpBefore, playerHpBefore });
        }
        if (attackResult?.result) { finished = attackResult; break; }

        const mid = await ActiveBattle.findOne({ where: { player_id: playerId } });
        if (!mid) { finished = await CombatService.getBattleStatus(playerId).catch(() => null); break; }
        const monsterTurnResult = await CombatService.monsterTurn(playerId);
        const monsterEntry = (await logOf(playerId)).slice(-1)[0] || {};
        if (monsterEntry.attacker === 'monster') monsterStrikes.push(monsterEntry);
        if (monsterTurnResult?.result) { finished = monsterTurnResult; break; }
        if (!(await ActiveBattle.findOne({ where: { player_id: playerId } }))) break;
    }

    const survived = playerStrikes.length > 0;
    check(
        'V2 玩家出手确实打了若干回合，且每回合怪物 HP 都在下降',
        survived && playerStrikes.every((s, i) => Number(s.target_hp) < s.monsterHpBefore),
        `出手${playerStrikes.length}次, 首记怪物HP ${playerStrikes[0]?.monsterHpBefore}→${playerStrikes[0]?.target_hp}`
    );

    // 声明了 damage_profile 的神通，在 PVE 里也必须走那条档位（与 PvP 同一选择逻辑）
    const profileUsed = playerStrikes.map(s => s.damage_profile);
    check(
        'V3 PVE 出手走神通声明的档位（资料片新增档位不再只在 PvP 生效）',
        profileUsed.includes('player_sword_intent'),
        `档位序列=${[...new Set(profileUsed)].join(',')}`
    );

    // 战斗触发属性进 PVE：日志里必须带 crit/missed 判定位（值可以为 false，字段必须存在）
    const procsLogged = playerStrikes.every(s => 'crit' in s && 'missed' in s);
    check(
        'V4 PVE 战斗日志带触发属性判定位（暴击/闪避真的在这条路径上算过）',
        procsLogged,
        `样本=${JSON.stringify(playerStrikes[0] ? { crit: playerStrikes[0].crit, missed: playerStrikes[0].missed, profile: playerStrikes[0].damage_profile } : null)}`
    );

    // 怪物的回击也走同一套解析与触发结算：日志里必须有"打在玩家身上"的记录，
    // 而玩家 HP 的上涨只能由日志记明的吸血解释（不会出现无来源回血）。
    // 注意要在战斗记录还在的时候逐条收集——结束后 ActiveBattle 行会被删掉，日志读不到了。
    const healExplained = playerStrikes.every(e =>
        Number(e.round_hp_after) <= Number(e.player_hp) + (Number(e.lifesteal) || 0));
    check(
        'V5 怪物回击落到玩家身上，且玩家 HP 上涨只能由记明的吸血解释',
        monsterStrikes.length > 0 && healExplained,
        `怪物出手${monsterStrikes.length}次(首记伤害=${monsterStrikes[0]?.damage}), `
        + `玩家出手${playerStrikes.length}次, 回复=${playerStrikes.map(e => e.lifesteal || 0).join(',')}`
    );

    const leftover = await ActiveBattle.findOne({ where: { player_id: playerId } });
    if (leftover) await CombatService.flee(playerId).catch(() => {});
    const stillThere = await ActiveBattle.findOne({ where: { player_id: playerId } });
    check(
        'V6 战斗结束后不残留进行中的战斗记录（或探针主动撤退后清理干净）',
        !stillThere,
        `主动结束=${finished?.result || '未分胜负'}, 残留=${!!stillThere}`
    );

    const after = await Player.findByPk(playerId);
    check(
        'V7 整场战斗后 blob 哨兵键仍在（战斗写 HP 没有整块覆盖 attributes）',
        after?.attributes?.[SENTINEL] === 'keep-me',
        `哨兵=${after?.attributes?.[SENTINEL]}`
    );

    // ===== V10：胜利经验到账（2026-09-23 起走列上原子加，不再是"读这份快照 + 算绝对值 + 整行 save()"）=====
    {
        await CombatService.retreat?.(playerId).catch(() => {});
        const expBefore = BigInt((await Player.findByPk(playerId)).exp || 0);
        await CombatService.encounter(playerId, monster.id);
        // 一击必杀：保证这一记真的走到"胜利结算"那几行，而不是停在半场上
        await ActiveBattle.update({ monster_hp: 1 }, { where: { player_id: playerId } });
        const win = await CombatService.attack(playerId, 'attack');
        const expAfter = BigInt((await Player.findByPk(playerId)).exp || 0);
        const reported = BigInt(win?.rewards?.exp ?? win?.exp ?? -1);
        check(
            'V10 打赢一记后：回执报的经验数 == 库里 exp 的增量（到账写的是这一份，不是别处的旧快照）',
            win?.result === 'win' && reported >= 0n && expAfter - expBefore === reported && reported > 0n,
            `result=${win?.result} 回执 exp=${reported} 库里 ${expBefore}→${expAfter}`
            + `；若增量为 0 说明这条路径没执行到（旧写法把整行 save() 交回调用方，改坏了也不会响）`
        );
        const afterWin = await Player.findByPk(playerId);
        check('V10b 胜利到账之后 blob 哨兵键仍在（到账不整块覆盖 attributes）',
            afterWin.attributes?.[SENTINEL] === 'keep-me',
            `哨兵=${afterWin.attributes?.[SENTINEL]}`);
    }

    // ===== V8/V9：怪物属性是"内容声明 → 结算读得到"，不再只有 game_balance 里那三个常数 =====
    const allMaps = Array.isArray(mapData.maps) ? mapData.maps : Object.values(mapData.maps);
    const oceanMap = allMaps.find(m => (m.monsters || []).some(x => x.id === 'shark' && x.stats));
    const sharkConfig = oceanMap?.monsters?.find(x => x.id === 'shark');
    const declared = sharkConfig?.stats || {};
    check(
        'V8 内容里确实给鲨鱼精声明了属性（否则下面这条断言是空的）',
        Number(declared.crit_rate) > 0 && Number(declared.crit_damage) > 0,
        `shark.stats=${JSON.stringify(declared)}`
    );

    if (oceanMap) {
        const savedMap = player.current_map_id;
        await ActiveBattle.destroy({ where: { player_id: player.id } });
        await Player.update({ current_map_id: oceanMap.id, in_battle: false }, { where: { id: player.id } });
        await CombatService.encounter(player.id, 'shark');
        const battle = await ActiveBattle.findOne({ where: { player_id: player.id } });
        const md = battle?.monster_data || {};
        check(
            'V9 怪物声明的属性进了战斗行，同时全局曲线那四项不受影响（现网其余怪物零变化）',
            md.id === 'shark' && Number(md.crit_rate) === Number(declared.crit_rate)
                && Number(md.crit_damage) === Number(declared.crit_damage)
                && Number(md.max_hp) > 0 && Number(md.atk) > 0 && Number(md.def) > 0
                && Number(md.hp) === Number(md.max_hp),
            `monster_data=${JSON.stringify({ id: md.id, atk: md.atk, def: md.def, max_hp: md.max_hp, crit_rate: md.crit_rate, crit_damage: md.crit_damage })}`
        );
        await ActiveBattle.destroy({ where: { player_id: player.id } });
        await Player.update({ current_map_id: savedMap, in_battle: false }, { where: { id: player.id } });
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
