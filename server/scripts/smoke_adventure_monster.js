/**
 * 历练遭遇的怪物属性端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：`computeMonsterStatsByRealm` 有 jest 覆盖，但 jest 不连库、也不经过
 * 真正写 `active_battles.monster_data` 的那一行。上一轮就是被这个空档骗过一次 ——
 * 服务里算好了整块属性（含资料片声明的暴击/闪避），调用处却只挑 hp/atk/def/exp_reward
 * 四个键建战斗行，于是"一处声明、两条遭遇路径都算到"在单元测试里成立、在玩家身上不成立。
 * 这里把真实写进去的那一行读回来判。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_adventure_monster.js
 * 探针自建/复用单个专用玩家 advmon01，只动它自己的行与它自己的战斗。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5087);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const ActiveBattle = require('../models/activeBattle');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const RealmService = require('../game/core/RealmService');
const AdventureEventService = require('../game/services/AdventureEventService');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const AIService = require('../game/services/AIService');
const { monsterCombatStats } = require('../game/combat/MonsterStats');
const mapData = require('../config/map_data.json');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

function mapsWithDeclaredMonsterStats() {
    const maps = mapData.maps || mapData;
    const list = Array.isArray(maps) ? maps : Object.values(maps);
    return list.filter(m => Array.isArray(m.monsters) && m.monsters.length > 0);
}

async function ensurePlayer(mapId) {
    let player = await Player.findOne({ where: { username: 'advmon01' } });
    if (!player) {
        player = await Player.create({
            username: 'advmon01',
            password: 'not-a-real-hash',
            nickname: '历练怪物探针',
            realm: '凡人',
            realm_rank: 1,
            level: 5,
            current_map_id: mapId
        });
    } else {
        // 只写这一列，走 patch 通道：整块 save() 会被 blobWriteGuard 挡住（这正是它该做的）
        await PlayerStateStore.patchPlayerState(player.id, { columns: { current_map_id: mapId } });
        player = await Player.findByPk(player.id);
    }
    return player;
}

(async () => {
    await bootApp(app, { port: PORT });

    const withMonsters = mapsWithDeclaredMonsterStats();
    const declaredMap = withMonsters.find(m => m.monsters.some(x => x.stats && Object.keys(x.stats).length));
    check('A0 map_data 里确实有怪声明了 stats（没有就先补内容，这条断言才有意义）',
        !!declaredMap, declaredMap ? `map=${declaredMap.id}/${declaredMap.name}` : '全图都没有 stats');
    if (!declaredMap) return finish();

    const player = await ensurePlayer(declaredMap.id);
    const AdventureService = new AdventureEventService();
    const realRandom = Math.random;
    const rows = [];

    // 逐只试：遭遇是随机的，把 Math.random 钉到第 i 只身上，才能把"写进去的块"对上"内容里的条目"
    for (let i = 0; i < declaredMap.monsters.length; i += 1) {
        Math.random = () => (i + 0.5) / declaredMap.monsters.length;
        const started = await AdventureService.generateCombatEncounter(player.id);
        Math.random = realRandom;
        const row = await ActiveBattle.findOne({ where: { player_id: player.id } });
        rows.push({ source: declaredMap.monsters[i], started, data: row && row.monster_data, row });
    }

    const usable = rows.filter(r => r.data && typeof r.data === 'object');
    check('A1 每一只怪都真的建出了战斗行（探针自己没跑偏）',
        usable.length === declaredMap.monsters.length,
        `${usable.length}/${declaredMap.monsters.length} 条，started=${rows.map(r => r.started && r.started.success).join(',')}`);

    const badRealm = usable.filter(({ source, data }) => {
        const realm = RealmService.getRealmByName(source.realm);
        if (!realm) return false;                                   // 境界名查不到时按默认值兜底，A4 管那一类
        if (Number.isFinite(Number(source.power_multiplier))) return false;   // 整块缩放的档位：期望值另算，不混进这条
        const declaredAtk = source.stats && source.stats.atk !== undefined
            ? Number(source.stats.atk) : Number(realm.base_atk);
        return Number(data.atk) !== declaredAtk;
    });
    check('A2 怪物攻击来自它自己境界的基础值（不是硬编码 15，也不受玩家等级影响）',
        badRealm.length === 0 && usable.length > 0,
        badRealm.map(r => `${r.source.id}:${r.data.atk}(境界 ${r.source.realm} 应为 ${RealmService.getRealmByName(r.source.realm).base_atk})`).join(' ') || '全部一致');

    const declaredCases = usable.filter(({ source }) => source.stats && Object.keys(source.stats).length);
    const lostStats = [];
    for (const { source, data } of declaredCases) {
        for (const [key, value] of Object.entries(source.stats)) {
            if (Number(data[key]) !== Number(value)) lostStats.push(`${source.id}.${key}=${data[key]}(应为 ${value})`);
        }
    }
    check('A3 资料片/地图里声明的属性真的进了战斗行（改造前调用处只挑 4 个键，这里必挂）',
        declaredCases.length > 0 && lostStats.length === 0,
        `声明了 stats 的怪 ${declaredCases.length} 只；丢失=${lostStats.join(' ') || '无'}`);

    const hpMismatch = usable.filter(({ data }) => {
        const block = monsterCombatStats(data);
        return !(Number(block.hp_max) === Number(data.hp) && Number(block.hp_max) > 0);
    });
    check('A4 血量三种叫法一致，结算读到的那份 > 0（BigInt(undefined) 与"面板 900 结算 100"都属这一类）',
        hpMismatch.length === 0,
        hpMismatch.map(r => `${r.source && r.source.id}:${JSON.stringify({ hp: r.data.hp, max_hp: r.data.max_hp, hp_max: r.data.hp_max })}`).join(' ') || '全部一致');

    const bigIntBad = usable.filter(({ data, row }) => String(row.monster_hp) !== String(data.hp)
        || String(row.monster_max_hp) !== String(data.hp)
        || !Number.isSafeInteger(Number(data.atk)) || !Number.isSafeInteger(Number(data.def)));
    check('A5 BIGINT 列与块里是同一个数，且写库的数值全是整数（小数会让 BigInt() 当场抛错）',
        bigIntBad.length === 0,
        bigIntBad.map(r => `${r.source.id}:col=${r.row.monster_hp}/${r.row.monster_max_hp} blk=${r.data.hp}`).join(' ') || '全部一致');

    // AI 降级模板：以前自带一张只到"筑基中期"的表，高境界玩家遇到的是同一批弱怪
    const aiSvc = new AIService();
    const templateAt = (realm) => aiSvc.generateMonsterFromTemplate({ playerRealm: realm, mapEnvironment: '山地' }).monster;
    const low = templateAt('凡人');
    const high = templateAt('化神中期');
    const highBase = RealmService.getRealmByName('化神中期');
    check('A6 AI 降级模板的怪按玩家境界强度生成（旧实现在这里最高只到筑基中期）',
        !!highBase && Number(high.hp) > Number(low.hp) * 5 && Number(high.atk) > Number(low.atk) * 5,
        `凡人 hp=${low.hp}/atk=${low.atk}，化神中期 hp=${high.hp}/atk=${high.atk}，境界表 hp=${highBase && highBase.base_hp}/atk=${highBase && highBase.base_atk}`);

    await ActiveBattle.destroy({ where: { player_id: player.id } });
    return finish();
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    await finish(2);
});

async function finish(code = null) {
    await sequelize.close().catch(() => {});
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    process.exit(code !== null ? code : (failed.length ? 1 : 0));
}
