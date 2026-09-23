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

/**
 * 丹药/使用物品这条链的落库判据（2026-09-23：`_applyItemEffect` 从"改实例 + 整块 save()"
 * 改成一次 PlayerStateStore 键级补丁之后，钉住四件事）：
 *   ① 属性丹：回执报的增量 == 库里 attributes 那两个 `*_bonus` 键的增量，且**同一次服用不会抹掉别的键**；
 *   ② 清毒丹：丹毒夹到 0（负数是不允许的，也不能"减过头又回到原值"）；
 *   ③ 延寿丹：寿元上限按回执增量涨；
 *   ④ 并发到账：8 路 useItem 与 8 路键级加灵石交错跑，库里增量 == 两边回执之和
 *      （钱写在改完规则的接口上，不写在探测器上：灵石/修为走列上原子加，才会恒等）。
 */
async function runPillChecks(player) {
    const InventoryService = require('../game/services/InventoryService');
    const PlayerStateStore = require('../game/persistence/PlayerStateStore');
    const { Op } = require('sequelize');

    async function seed(items) {
        await Item.destroy({ where: { player_id: player.id, item_key: { [Op.in]: items } } });
        for (const key of items) await InventoryService.addItem(player.id, key, 10, null);
    }
    async function snapshot() {
        const row = await Player.findByPk(player.id);
        return { attrs: row.attributes || {}, stones: BigInt(row.spirit_stones), toxicity: Number(row.toxicity || 0), lifespanMax: Number(row.lifespan_max || 0) };
    }

    // ① 属性丹
    await seed(['core_formation_pill']);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { [SENTINEL]: 'keep-me' } });
    let before = await snapshot();
    const pillResult = await InventoryService.useItem(player.id, 'core_formation_pill', 1);
    let after = await snapshot();
    const granted = pillResult?.effects?.permanent_attribute_bonus || {};
    const bonusDelta = {};
    for (const key of Object.keys(granted)) {
        bonusDelta[key] = (Number(after.attrs[key]) || 0) - (Number(before.attrs[key]) || 0);
    }
    check('P1 属性丹：回执里报的每一项增量都真的进了 attributes（且没顺手抹掉别的键）',
        pillResult?.success === true && Object.keys(granted).length > 0
        && Object.entries(bonusDelta).every(([key, delta]) => delta === granted[key])
        && after.attrs[SENTINEL] === 'keep-me',
        `回执=${JSON.stringify(granted)} 库里增量=${JSON.stringify(bonusDelta)} 哨兵=${after.attrs[SENTINEL]}`);

    // ② 丹毒夹到 0
    await seed(['huadu_dan']);
    await PlayerStateStore.patchPlayerState(player.id, { columns: { toxicity: 5 } });
    before = await snapshot();
    const detox = await InventoryService.useItem(player.id, 'huadu_dan', 1);
    after = await snapshot();
    const cleared = Number(detox?.effects?.toxicity_reduce || 0);
    check('P2 清毒丹：丹毒夹到 0（配置减 15 > 现存 5，既不能变负也不能原样不动）',
        detox?.success === true && before.toxicity === 5 && after.toxicity === 0 && cleared > 5,
        `回执减=${cleared} 库里 ${before.toxicity}→${after.toxicity}`);

    // ③ 寿元上限
    await seed(['mid_longevity_pill']);
    before = await snapshot();
    const longevity = await InventoryService.useItem(player.id, 'mid_longevity_pill', 1);
    after = await snapshot();
    check('P3 延寿丹：寿元上限的库里增量 == 回执报的 longevity_add',
        longevity?.success === true && after.lifespanMax - before.lifespanMax === Number(longevity?.effects?.longevity_add || -1),
        `回执=+${longevity?.effects?.longevity_add} 库里 ${before.lifespanMax}→${after.lifespanMax}`);

    // ④ 并发到账：使用物品与别的链同时加钱
    await seed(['small_fortune_pouch']);
    before = await snapshot();
    const legs = [];
    for (let i = 0; i < 8; i++) {
        legs.push(InventoryService.useItem(player.id, 'small_fortune_pouch', 1).then(r => Number(r?.effects?.spirit_stones || 0)));
        legs.push(PlayerStateStore.patchPlayerState(player.id, { amounts: { spirit_stones: 1000n } }).then(() => 1000));
    }
    const reported = (await Promise.all(legs)).reduce((a, b) => a + b, 0);
    after = await snapshot();
    const landed = Number(after.stones - before.stones);
    check('P4 并发到账：8 路使用物品 + 8 路键级加灵石，库里增量恒等于回执之和（列上原子加）',
        reported > 0 && landed === reported,
        `回执之和=${reported} 库里增量=${landed}`);
    await Item.destroy({ where: { player_id: player.id, item_key: { [Op.in]: ['core_formation_pill', 'huadu_dan', 'mid_longevity_pill', 'small_fortune_pouch'] } } });
}

/**
 * 属性点重置 POST /api/attribute/reset 的落库判据（2026-09-23：这条路由以前是
 * "锁内读整份 attributes → 摊平改三个键 → 赋回实例 → save 整行"，改成一次键级补丁之后钉住：）
 *   ① 回收真的按回执的数进 `attribute_points`，`hp_bonus` 恰好少那么多（不多不少）；
 *   ② 加点账本被删、冷却时点被写，而**与本次重置无关的键一个都没被重写**（哨兵键 + 同时刻另一条链写的键）；
 *   ③ 灵石那笔与另一条链的加钱并发后，库里净变化 == +发放 − 扣费（列上原子加，谁也不会把谁盖掉）；
 *   ④ 双击/重放：同时点两次重置只成一次，退点也只退一次（旧写法在这里会重复退点，
 *      因为它按手上那份快照算 refundablePoints，两次都看见同一份账本）。
 */
async function runResetChecks(player) {
    const PlayerStateStore = require('../game/persistence/PlayerStateStore');
    const AttributeService = require('../game/core/AttributeService');
    const OTHER = 'probe_other_writer';
    const token = mintToken(player);
    const cost = Number(AttributeService.getAttributeResetConfig().cost_spirit_stones || 0);
    const post = (path, body = {}) => request({ port: PORT, method: 'POST', path, token, body });
    const snap = async () => {
        const row = await Player.findByPk(player.id);
        const a = row.attributes || {};
        return {
            points: Number(row.attribute_points || 0), stones: BigInt(row.spirit_stones || 0),
            hpBonus: Number(a.hp_bonus || 0), ledger: a.attribute_point_allocations,
            resetAt: a.last_attribute_reset_time, sentinel: a[SENTINEL], other: a[OTHER]
        };
    };
    // 备好"可回收的加点"：先给点数、花掉、再把冷却清空并埋两个哨兵键
    async function prepare(refundable = 5) {
        await PlayerStateStore.patchPlayerState(player.id, {
            amounts: { spirit_stones: BigInt(cost + 5000), attribute_points: refundable },
            attributes: { [SENTINEL]: 'keep-me', [OTHER]: null, last_attribute_reset_time: null }
        });
        const allocated = await post('/api/attribute/allocate', { points: { hp: refundable } });
        return allocated.status === 200;
    }

    if (!await prepare(5)) {
        check('P5/P6 前置：加点成功（否则重置无账可回收，两条判据都是空测）', false, '加点被拒');
        return;
    }
    const before = await snap();
    const [reset, otherWriter] = await Promise.all([
        post('/api/attribute/reset'),
        PlayerStateStore.patchPlayerState(player.id, {
            attributes: { [OTHER]: 'written-by-other-flow' }, amounts: { spirit_stones: 500n }
        })
    ]);
    const after = await snap();
    // 退多少由服务端那本账说了算（前面几条流程已经往 hp_bonus 上写过几笔，这里不该猜数）；
    // 判据是"回执说的数 == 库里两个键各自的移动"，这才是要钉的东西。
    const refunded = Number(reset.body?.data?.refunded_points || 0);
    check('P5 属性点重置：退点与回收按回执落地，账本删掉，无关的键一个都没被重写',
        reset.status === 200 && refunded > 0 && after.ledger === undefined && !!after.resetAt
        && after.hpBonus === before.hpBonus - refunded && after.points === before.points + refunded
        && after.sentinel === 'keep-me' && after.other === 'written-by-other-flow',
        `status=${reset.status}${reset.body?.message ? `(${reset.body.message})` : ''}, 回执退点=${refunded}, `
        + `hp_bonus ${before.hpBonus}→${after.hpBonus}, 可分配点 ${before.points}→${after.points}, `
        + `账本=${after.ledger === undefined ? '已删' : JSON.stringify(after.ledger)}, 哨兵=${after.sentinel}, 对方键=${after.other}`);
    check('P5b 重置的扣费与另一条链的加钱并发：库里净变化 == +500 − 配置费用（列上原子加）',
        Number(after.stones - before.stones) === 500 - cost && otherWriter !== undefined,
        `配置费用=${cost}, 库里变化=${Number(after.stones - before.stones)}`);

    // ④ 两次重置同时打：只许成一次、只退一次点
    if (!await prepare(5)) {
        check('P6 前置：再次加点成功（否则"只成一次"是空测）', false, '加点被拒');
        return;
    }
    const beforeDouble = await snap();
    const pair = await Promise.all([post('/api/attribute/reset'), post('/api/attribute/reset')]);
    const winners = pair.filter(r => r.status === 200);
    const once = Number(winners[0]?.body?.data?.refunded_points || 0);
    const afterDouble = await snap();
    check('P6 同时点两次属性点重置：只成一次，退点与回收都只发生一次',
        winners.length === 1 && once > 0 && afterDouble.points === beforeDouble.points + once
        && afterDouble.hpBonus === beforeDouble.hpBonus - once,
        `成功次数=${winners.length}, 退点=${once}, 理由=${pair.map(r => `${r.status}:${r.body?.message || '-'}`).join(' | ')}, `
        + `可分配点 ${beforeDouble.points}→${afterDouble.points}, hp_bonus ${beforeDouble.hpBonus}→${afterDouble.hpBonus}`);
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await ensureProbePlayer();

    for (const flow of FLOWS) {
        const fresh = await resetFor(player, flow.items, flow.techniques);
        await runFlow(fresh, flow);
    }
    await runPillChecks(await Player.findByPk(player.id));
    await runResetChecks(await Player.findByPk(player.id));

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
