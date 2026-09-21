/**
 * 历练结算 completeAdventure：奖励只发一遍、物品真到账、受伤按比率（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要单独一个：这条路径之前没有任何连库探针（只有一个不连库的源码扫描测试），
 * 而它同时管着三件事 —— 双领防护（同一行只能结算一次）、奖励发放（exp/灵石/物品）、受伤扣血。
 * 本会话把 `grantRewards` 改成收"调用方已锁住的那个玩家实例"（原来在同一笔事务里又读一次同一行，
 * 留下两份实例、后写的覆盖先写的，并且让取锁次序看着像 adventure→players 的反向），
 * 物品发放那段正是这次改动碰到的地方，所以必须有真库证据。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_adventure_complete.js
 * 只用自建探针号 adv_c1，跑完删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5099);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const PlayerAdventure = require('../models/playerAdventure');
const Item = require('../models/item');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const AdventureEventService = require('../game/services/AdventureEventService');

const ACCOUNT = 'adv_c1';
const ITEM_KEY = 'ancient_token';        // treasure_2 的奖励，内容里真存在的一件
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => Number(v == null ? 0 : v);
const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };

/** 造一条"已经结束"的历练行：等价于服务自己抽到 treasure_2 之后落库的那一份 */
async function seedRow(playerId, { minutesAgo = 60, duration = 'medium', event = null } = {}) {
    const now = Date.now();
    return PlayerAdventure.create({
        player_id: playerId,
        map_id: 1,
        map_name: '探针地图',
        event_id: event?.id || 'treasure_2',
        event_type: event?.type || 'treasure',
        event_data: JSON.stringify(event || {
            id: 'treasure_2', type: 'treasure', duration: 60, duration_type: duration,
            rewards: { exp: 30, spirit_stones: 40, items: [ITEM_KEY] }
        }),
        start_time: new Date(now - minutesAgo * 60000),
        end_time: new Date(now - minutesAgo * 60000 + (duration === 'long' ? 300 : 60) * 1000),
        status: 'in_progress'
    });
}

const bagOf = async pid => N((await Item.findOne({ where: { player_id: pid, item_key: ITEM_KEY }, raw: true }))?.quantity);
const snapshot = async pid => {
    const p = await Player.findByPk(pid, { attributes: ['id', 'exp', 'spirit_stones', 'hp_current'] });
    return { exp: B(p.exp), stones: B(p.spirit_stones), hp: B(p.hp_current) };
};

async function main() {
    await bootApp(app, { port: PORT });
    // 这个服务是"静态 initialize 返回实例"的形状（不是单例导出），必须用 initialize 拿到的那一份
    const svc = await AdventureEventService.initialize(infrastructure.ConfigLoader);

    let p = await Player.findOne({ where: { username: ACCOUNT } });
    if (!p) {
        p = await Player.create({
            username: ACCOUNT, password: 'not-a-real-hash', nickname: '历练结算探针',
            realm: '炼气5层', realm_rank: 5, exp: 0, spirit_stones: 1000,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    } else {
        await Player.update({ exp: 0, spirit_stones: 1000, hp_current: 5000, is_dead: false }, { where: { id: p.id } });
    }
    await PlayerAdventure.destroy({ where: { player_id: p.id }, force: true });
    await Item.destroy({ where: { player_id: p.id, item_key: ITEM_KEY }, force: true });

    // ===== D1/D2 正常到点结算 =====
    const before = await snapshot(p.id);
    const bagBefore = await bagOf(p.id);
    await seedRow(p.id);
    const done = await svc.completeAdventure(p.id);
    const after = await snapshot(p.id);
    const bagAfter = await bagOf(p.id);
    const granted = done.rewards || {};
    check('D1 到点结算成功，且经验/灵石确实到账（增量与接口报出的数一致）',
        done.success === true && after.exp - before.exp === B(granted.exp) && after.exp > before.exp
        && after.stones - before.stones === B(granted.spirit_stones),
        `exp +${after.exp - before.exp}(报 ${granted.exp}) 灵石 +${after.stones - before.stones}(报 ${granted.spirit_stones})`);
    check('D2 奖励物品真进背包一件（grantRewards 改用调用方锁住的实例之后，这条是唯一证据）',
        bagAfter - bagBefore === 1 && (granted.items || []).length === 1,
        `背包 ${bagBefore}→${bagAfter} 报出 ${JSON.stringify(granted.items)}`);
    const rowAfter = await PlayerAdventure.findOne({ where: { player_id: p.id }, order: [['id', 'DESC']] });
    check('D2b 历练行落到 completed 且标了已领取（状态不写就等于可以再来一遍）',
        rowAfter?.status === 'completed' && rowAfter?.rewards_claimed === true,
        `status=${rowAfter?.status} claimed=${rowAfter?.rewards_claimed}`);

    // ===== D3 重放：没有进行中的历练，一分钱/一件货都不该再发 =====
    const replay = await svc.completeAdventure(p.id);
    const afterReplay = await snapshot(p.id);
    check('D3 结算重放被拒且完全不记账（双领这一类的形状）',
        replay.success === false && replay.code === 'NO_ADVENTURE'
        && afterReplay.exp === after.exp && afterReplay.stones === after.stones
        && await bagOf(p.id) === bagAfter,
        `code=${replay.code} exp ${after.exp}→${afterReplay.exp}`);

    // ===== D4 并发双领：两个标签页同时点同一行 =====
    const beforeConc = await snapshot(p.id);
    const concBagBefore = await bagOf(p.id);
    await seedRow(p.id);
    const pair = await Promise.all([
        svc.completeAdventure(p.id),
        svc.completeAdventure(p.id)
    ]);
    const afterConc = await snapshot(p.id);
    const concBagAfter = await bagOf(p.id);
    const okCount = pair.filter(r => r?.success === true).length;
    check('D4 同一行并发两笔最多成一笔（两份奖励=双发）',
        okCount <= 1, `成 ${okCount} 笔：${pair.map(r => `${r?.success}/${r?.code || ''}`).join(' , ')}`);
    check('D4b 并发之后 exp 与物品只多出一份',
        afterConc.exp - beforeConc.exp === B((pair.find(r => r?.success) || {}).rewards?.exp || 0)
        && concBagAfter - concBagBefore === (okCount === 1 ? 1 : 0),
        `exp +${afterConc.exp - beforeConc.exp} 物品 +${concBagAfter - concBagBefore}（成一笔=${okCount}）`);

    // ===== D5 提前结束：按比例打折且不许为负，也不许留个"进行中"的行 =====
    const beforeEarly = await snapshot(p.id);
    await PlayerAdventure.destroy({ where: { player_id: p.id }, force: true });
    await seedRow(p.id, { minutesAgo: 0, event: {
        id: 'treasure_2', type: 'treasure', duration: 3600, duration_type: 'medium',
        rewards: { exp: 100000, spirit_stones: 100000, items: [ITEM_KEY] }
    } });
    const early = await svc.completeAdventure(p.id);
    const afterEarly = await snapshot(p.id);
    check('D5 刚开始就结束：按已时长比例扣（不设保底）且不许扣成负数',
        early.success === true && N(early.rewards?.exp) < 100000 && afterEarly.exp >= beforeEarly.exp
        && afterEarly.hp >= 0n,
        `报出 exp=${early.rewards?.exp}（全额 100000）early=${early.rewards?.early_finish}`);

    // ===== D6 受伤分支：命中时 HP 减量必须正好是"当时血量 × 比率"，且不许为负 =====
    const durCfg = (infrastructure.ConfigLoader.getConfig('game_balance')?.adventure?.duration_types || {}).long || {};
    const rate = Number(durCfg.injury_rate || durCfg.injury_hp_loss_rate || 0.12);
    let injuries = 0, badInjury = '';
    for (let round = 0; round < 40 && injuries === 0; round++) {
        await PlayerAdventure.destroy({ where: { player_id: p.id }, force: true });
        await Player.update({ hp_current: 5000 }, { where: { id: p.id } });
        await seedRow(p.id, { minutesAgo: 6, duration: 'long', event: {
            id: 'treasure_1', type: 'treasure', duration: 300, duration_type: 'long',
            rewards: { exp: 10, items: [] }
        } });
        const b = await snapshot(p.id);
        const out = await svc.completeAdventure(p.id);
        const a = await snapshot(p.id);
        if (out?.injury || out?.rewards?.injury) {
            injuries++;
            const expect = Math.floor(Number(b.hp) * rate);
            if (b.hp - a.hp !== BigInt(expect) || a.hp < 0n) {
                badInjury = `第 ${round + 1} 轮：hp ${b.hp}→${a.hp}，按 ${(rate * 100).toFixed(0)}% 应减 ${expect}`;
            }
        }
    }
    check('D6 长时历练的受伤分支能命中，且扣血量正好是"当时血量 × 比率"、不为负',
        injuries > 0 && !badInjury, badInjury || `40 轮里命中 ${injuries} 次（比率 ${(rate * 100).toFixed(0)}%）`);

    check('D7 探针名下的历练行都收尾了（留 in_progress 会污染别人的面板）',
        (await PlayerAdventure.count({ where: { player_id: p.id, status: 'in_progress' } })) === 0,
        `残留=${await PlayerAdventure.count({ where: { player_id: p.id, status: 'in_progress' } })}`);
    check('D7b 结算次数与 exp 增量对得上（每一次 success 都真的只发一份）',
        B((await snapshot(p.id)).exp) > 0n, `最终 exp=${(await snapshot(p.id)).exp}`);
    // ===== D8/D9/D10：发货门换到 grantItems（#50）之后新增的三条能力/行为 =====
    const BAD_KEY = 'definitely_not_an_item_probe_xyz';
    // D8：内容里终于能写数量了（改前那段硬编码每条只发 1 件，想配"给 3 枚"必须回来改代码）
    const bag8 = await bagOf(p.id);
    await seedRow(p.id, { event: { id: 'probe_qty3', type: 'treasure', duration: 1, duration_type: 'medium',
        rewards: { exp: 10, items: [{ item_key: ITEM_KEY, quantity: 3 }] } } });
    const g8 = (await svc.completeAdventure(p.id)).rewards || {};
    check('D8 内容写 [{item_key, quantity:3}] → 背包真 +3 且回执报 3（旧代码表达不出数量）',
        await bagOf(p.id) - bag8 === 3 && (g8.items || []).length === 1 && Number(g8.items[0].quantity) === 3,
        `背包 ${bag8}→${await bagOf(p.id)} 回执 ${JSON.stringify(g8.items)}`);

    // D9：错键不许静默变成背包里的垃圾行
    await seedRow(p.id, { event: { id: 'probe_badkey', type: 'treasure', duration: 1, duration_type: 'medium',
        rewards: { exp: 10, items: [BAD_KEY] } } });
    const r9 = (await svc.completeAdventure(p.id)).rewards || {};
    check('D9 物品键不存在：不写垃圾行、不发"已发放"，而是点名没发到',
        (await Item.count({ where: { player_id: p.id, item_key: BAD_KEY } })) === 0
        && (r9.items || []).length === 0 && (r9.items_failed || []).length === 1
        && r9.items_failed[0].item_key === BAD_KEY,
        `垃圾行=${await Item.count({ where: { player_id: p.id, item_key: BAD_KEY } })} 发到=${JSON.stringify(r9.items)} 没发到=${JSON.stringify(r9.items_failed || []).slice(0, 110)}`);

    // D10：容量闸 + 回执与库存必须一致（改前不管发没发到都报 quantity:1）
    const bag10 = await bagOf(p.id);
    await seedRow(p.id, { event: { id: 'probe_overcap', type: 'treasure', duration: 1, duration_type: 'medium',
        rewards: { exp: 10, items: [{ item_key: ITEM_KEY, quantity: 999999 }] } } });
    const r10 = (await svc.completeAdventure(p.id)).rewards || {};
    const grew10 = await bagOf(p.id) - bag10;
    check('D10 一次发 999999 件：要么照发、要么明确报没发到 —— 回执说几件库里就得是几件',
        (grew10 === 999999 && (r10.items || []).length === 1 && (r10.items_failed || []).length === 0)
        || (grew10 === 0 && (r10.items || []).length === 0 && (r10.items_failed || []).length === 1
            && /容量/.test(r10.items_failed[0].reason || '') && Number(r10.exp) > 0),
        `背包 +${grew10} 发到=${JSON.stringify(r10.items)} 没发到=${JSON.stringify(r10.items_failed || []).slice(0, 110)} exp=${r10.exp}`);
    void Op;
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
            const p = await Player.findOne({ where: { username: ACCOUNT } });
            if (p) {
                await PlayerAdventure.destroy({ where: { player_id: p.id }, force: true });
                await Item.destroy({ where: { player_id: p.id, item_key: { [Op.in]: [ITEM_KEY, 'definitely_not_an_item_probe_xyz'] } }, force: true });
                await Player.destroy({ where: { id: p.id }, force: true });
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
