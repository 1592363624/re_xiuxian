/**
 * 跨流程并发探针：两个不同玩法同时写同一个玩家时，谁都不许抹掉对方的键
 *
 * 与 smoke_write_concurrency.js 的分工：那个测"同一入口被连点"，
 * 这个测"不同入口交错"——加点写 hp_bonus、吃丹写 mp_bonus、恢复写 last_recovery_time、
 * 突破写境界相关键。旧实现里每个入口都是"读整块 attributes → 改一个键 → 写回整块"，
 * 于是后写的那笔会把先写的那笔连同无关键一起抹掉。
 *
 * 判据用一个哨兵键：attributes.probe_marker 由探针预先写入，任何流程都不该碰它。
 * 它消失了，就说明这条流程在做整块覆盖。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_write_crossflow.js
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5096);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const Item = require('../models/item');
const PlayerTechnique = require('../models/playerTechnique');
const sequelize = require('../config/database');
const { bootApp, request, mintToken } = require('./lib/smoke_http');
const CombatResolver = require('../game/combat/CombatResolver');

const PROBE_USERNAME = 'smokecross';
const PROBE_NICKNAME = '交错探针';
const SENTINEL = 'probe_marker';

const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensureProbePlayer() {
    let player = await Player.findOne({ where: { username: PROBE_USERNAME } });
    if (!player) {
        player = await Player.create({
            username: PROBE_USERNAME,
            password: 'not-a-real-hash',
            nickname: PROBE_NICKNAME,
            realm: '炼气初期',
            realm_rank: 2,
            exp: 0,
            spirit_stones: 100000,
            hp_current: 1000,
            mp_current: 1000,
            lifespan_current: 20,
            attributes: {},
            token_version: 0
        });
    }
    return player;
}

/** 每个流程前重置：哨兵键 + 1 点可加属性 + 2 小时恢复窗口 + 探针所需物品/功法 */
async function resetFor(player, itemKeys, techniqueIds = []) {
    // 整块播种 attributes 必须带事务：blobWriteGuard 对 bulk 路径的要求与实例路径一致
    await sequelize.transaction(t => Player.update(
        {
            // realm 必须是 realm_breakthrough.json 里的真名字，否则突破分支直接判定"境界数据异常"，
            // 探针就变成了一次空跑。exp 给足，让 /breakthrough/try 真的走到写库分支。
            realm: '炼气3层',
            realm_rank: 4,
            attribute_points: 1,
            spirit_stones: 100000,
            exp: 1000000000,
            hp_current: 500,
            mp_current: 5000,
            attributes: { [SENTINEL]: 'keep-me', last_recovery_time: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }
        },
        { where: { id: player.id }, transaction: t }
    ));
    await Item.destroy({ where: { player_id: player.id } });
    for (const key of itemKeys) {
        await Item.create({ player_id: player.id, item_key: key, quantity: 5 });
    }
    await PlayerTechnique.destroy({ where: { player_id: player.id } });
    for (const id of techniqueIds) {
        await PlayerTechnique.create({ player_id: player.id, technique_id: id, layer: 1, proficiency: 0 });
    }
    return Player.findByPk(player.id);
}

const FLOWS = [
    {
        name: '恢复结算 /attribute/recover',
        path: '/api/attribute/recover',
        body: { recovery_type: 'natural' },
        items: []
    },
    {
        name: '吃属性丹 /attribute/use_pill',
        path: '/api/attribute/use_pill',
        body: { pill_id: 'qi_condensing_pill' },
        items: ['qi_condensing_pill']
    },
    {
        name: '使用物品 /inventory/use',
        path: '/api/inventory/use',
        body: { item_key: 'low_healing_pill', quantity: 3 },
        items: ['low_healing_pill'],
        // 这条流程顺带盯"回复类效果的上限从哪来"：blob 里没有 hp_max 时旧实现按 100 钳，
        // 3 颗回春丹（+10/颗）本该回到 110，旧实现只让回到 100
        heals: true
    },
    {
        name: '功法修炼 /technique/practice',
        path: '/api/technique/practice',
        body: { technique_id: 'huang_basic_qi' },
        items: [],
        techniques: ['huang_basic_qi']
    },
    {
        name: '尝试突破 /breakthrough/try',
        path: '/api/breakthrough/try',
        body: {},
        items: []
    }
];

async function runFlow(player, flow) {
    const token = mintToken(player);
    if (flow.heals) {
        // 把气血放到"100 之下"：旧实现按 blob 缺失的默认钳值 100 截断，
        // 3 颗回春丹（+10/颗）从 80 出发本该回到 110，旧实现只会到 100。
        await Player.update({ hp_current: 80 }, { where: { id: player.id } });
    }
    const hpBefore = Number((await Player.findByPk(player.id)).hp_current) || 0;

    const [alloc, other] = await Promise.all([
        request({ port: PORT, method: 'POST', path: '/api/attribute/allocate', token, body: { points: { hp: 1 } } }),
        request({ port: PORT, method: 'POST', path: flow.path, token, body: flow.body })
    ]);

    const attrs = (await Player.findByPk(player.id)).attributes || {};
    const survived = attrs[SENTINEL] === 'keep-me';
    const allocated = alloc.status === 200 ? Number(attrs.hp_bonus) === 1 : true;

    check(
        `${flow.name} 与加点并发：哨兵键与对方写入都在`,
        survived && allocated,
        `sentinel=${survived ? '在' : '被抹掉'}, hp_bonus=${attrs.hp_bonus}, ` +
        `allocate=${alloc.status}, flow=${other.status}${other.body?.message ? `(${other.body.message})` : ''}`
    );

    if (flow.heals) {
        const row = await Player.findByPk(player.id);
        const { stats } = await CombatResolver.resolveCombatStats(row);
        const hpAfter = Number(row.hp_current) || 0;
        const expected = Math.min(Number(stats.hp_max), hpBefore + 30);
        check(
            `${flow.name}：回复上限取解析后的属性（blob 没有 hp_max 时旧实现按 100 钳，多出的那截就没了）`,
            Number(stats.hp_max) > 100 && hpAfter === expected && expected > 100,
            `HP ${hpBefore}→${hpAfter}, 应为 ${expected}(+30 受解析上限约束), 解析后 hp_max=${stats.hp_max}, blob hp_max=${JSON.stringify(attrs.hp_max)}`
        );
    }
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await ensureProbePlayer();

    for (const flow of FLOWS) {
        const fresh = await resetFor(player, flow.items, flow.techniques);
        await runFlow(fresh, flow);
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
