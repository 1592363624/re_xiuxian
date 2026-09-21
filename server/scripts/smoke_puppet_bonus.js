/**
 * 出战傀儡的属性加成端到端探针（需要 MySQL，走 .env 指向的库）
 *
 * 为什么要单独一个：傀儡是玩家能获得的"第二个战斗单位"，它给玩家的是**属性**（按
 * battle_stat_ratio 折算），而这条链路以前有三处各自手写四个键：
 *   制造时写列 → 折算时读列 → 属性引擎再挑四个键。
 * 任何一处漏一个键，结果都是"这个属性对傀儡不生效"，不报错也没人看得见。
 * 这里造一只真傀儡，断言它对玩家最终属性的贡献恰好等于内容里那档比例，
 * 并且 breakdown 里能看出这份加成来自傀儡（面板/战力/战斗同一份数）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_puppet_bonus.js
 * 探针自建/复用单个专用玩家 puppettest01，跑完删掉自己的傀儡行。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5089);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerPuppet = require('../models/playerPuppet');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const CombatResolver = require('../game/combat/CombatResolver');
const RealmService = require('../game/core/RealmService');
const { infrastructure } = require('../modules');
const configLoader = infrastructure.ConfigLoader;

const TYPE = 'iron_armor';
const ROW = { atk: 200, def: 150, hp: 2000, speed: 70 };

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensurePlayer() {
    const realm = RealmService.getRealmByName('炼气10层') || RealmService.getRealmByName('凡人');
    let player = await Player.findOne({ where: { username: 'puppettest01' } });
    if (!player) {
        player = await Player.create({
            username: 'puppettest01',
            password: 'not-a-real-hash',
            nickname: '傀儡探针',
            realm: realm.name,
            realm_rank: realm.rank
        });
    }
    await PlayerPuppet.destroy({ where: { player_id: player.id } });
    return player;
}

async function statsOf(player) {
    return CombatResolver.resolveCombatStats(await Player.findByPk(player.id));
}

(async () => {
    await bootApp(app, { port: PORT });

    const config = configLoader.getConfig('puppet_data');
    check('P0 傀儡配置在内容层里（资料片能加类型，比例也是数据）',
        !!config && Number.isFinite(Number(config.battle_stat_ratio)) && !!config.puppet_types?.[TYPE],
        `ratio=${config && config.battle_stat_ratio} 类型=${config ? Object.keys(config.puppet_types).join('/') : '无'}`);
    if (!config) return finish();

    const ratio = Number(config.battle_stat_ratio);
    const player = await ensurePlayer();

    const baseline = await statsOf(player);
    check('P1 没有出战傀儡时，breakdown 里不该有傀儡这一组（否则下一条断言是空的）',
        !baseline.breakdown.puppet || !Object.keys(baseline.breakdown.puppet).length,
        `puppet 组=${JSON.stringify(baseline.breakdown.puppet || {})}`);

    const created = await PlayerPuppet.create({
        player_id: player.id,
        puppet_type: TYPE,
        name: config.puppet_types[TYPE].name || '铁甲傀儡',
        level: 3,
        exp: 0,
        durability: 100,
        max_durability: 100,
        status: 'battle',
        ...ROW
    });

    const withPuppet = await statsOf(player);
    const group = withPuppet.breakdown.puppet || {};
    const expected = {
        atk: Math.floor(ROW.atk * ratio),
        def: Math.floor(ROW.def * ratio),
        hp_max: Math.floor(ROW.hp * ratio),
        speed: Math.floor(ROW.speed * ratio)
    };
    check('P2 傀儡那一行按内容的比例折算进玩家属性（血量列名 hp 映射成属性名 hp_max）',
        ['atk', 'def', 'hp_max', 'speed'].every(k => Number(group[k]) === expected[k]),
        `puppet 组=${JSON.stringify(group)} 期望=${JSON.stringify(expected)} ratio=${ratio}`);

    const deltas = ['atk', 'def', 'speed']
        .map(k => [k, Number(withPuppet.stats[k]) - Number(baseline.stats[k])])
        .filter(([k]) => expected[k] > 0);
    check('P3 最终属性真的因为这只傀儡变高了（不是只写进明细里好看）',
        deltas.length > 0 && deltas.every(([k, delta]) => delta === expected[k]),
        deltas.map(([k, d]) => `${k} +${d}(应为 +${expected[k]})`).join(' ') || '无可比项');

    // 耐久为 0 的傀儡不该再提供任何加成：这条同时证明"折算前那道校验"仍然在链路上
    await PlayerPuppet.update({ durability: 0 }, { where: { id: created.id } });
    const broken = await statsOf(player);
    check('P4 耐久见底的傀儡立刻不再加成（玩家面板与战斗不会拿到一个不存在的单位）',
        !broken.breakdown.puppet || !Object.keys(broken.breakdown.puppet).length,
        `耐久 0 时 puppet 组=${JSON.stringify(broken.breakdown.puppet || {})}`);

    // 内容里的比例是数据：改它应当立刻反映在折算结果上（这里改内存里的视图，不碰库）
    await PlayerPuppet.update({ durability: 100 }, { where: { id: created.id } });
    config.battle_stat_ratio = 1;
    const doubled = await statsOf(await Player.findByPk(player.id));
    config.battle_stat_ratio = ratio;
    const restored = await statsOf(await Player.findByPk(player.id));
    check('P5 改内容里的 battle_stat_ratio 就改变贡献（比例没有被代码写死在别处）',
        Number((doubled.breakdown.puppet || {}).atk) === ROW.atk
            && Number((restored.breakdown.puppet || {}).atk) === expected.atk,
        `比例=1 时 puppet.atk=${(doubled.breakdown.puppet || {}).atk}(应为 ${ROW.atk})，改回后=${(restored.breakdown.puppet || {}).atk}`);

    await PlayerPuppet.destroy({ where: { player_id: player.id } });
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
