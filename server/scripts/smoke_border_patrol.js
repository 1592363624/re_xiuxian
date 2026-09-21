/**
 * 战线·灵兽巡边（BorderBeastPatrolSubService）端到端：派出去 → 到点归来 → 军功/灵石/经验/物品四笔账
 * （需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要这条：这条链的入口是 `.巡边/.巡边归来` 指令，之前**没有任何连库探针**。它的发奖形状与已经验证过的
 * 战线支援逐字相同（_rollDrops → grantItems → 只把真发到的写进消息与 items_dropped），
 * 但"形状相同"不等于"跑过"：万一哪天有人把 drops 重新赋值的顺序挪了、或者把 grantItems 换成旧的
 * addItem 循环，这条链就会静默回到"消息说有、背包里没有"。这里把它钉成账面=库存。
 *
 * 还缺什么（别把这条当战线全覆盖）：探禁（RemnantMapSubService.combine/explore，要先集齐 4 类残片 + 500 灵石合成）
 * 与军议/募捐那两条链仍未有端到端探针；残片正好是巡边 scout 路线的掉落，下一批可以直接接在这条腿后面。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_border_patrol.js
 * 只用自建探针号 bp_a，跑完删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5215);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const Item = require('../models/item');
const SpiritBeast = require('../models/spiritBeast');
const BorderBeastPatrol = require('../models/border_beast_patrol');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const BorderBeastPatrolSubService = require('../game/services/BorderBeastPatrolSubService');

const ACCOUNT = 'bp_a';
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}
const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };
const N = v => Number(v == null ? 0 : v);

/** 把 Math.random 钉成 0：_randomInt 取下限、_rollDrops 每件都命中（0 < drop_rate 恒真）、失败判定恒不成立
 *  → 巡边这条链的每一个随机分支都变确定，账面数字才能精确断言。跑完必须还原。 */
async function withZeroRandom(fn) {
    const orig = Math.random;
    Math.random = () => 0;
    try { return await fn(); } finally { Math.random = orig; }
}

async function bagQty(playerId, key) {
    return N((await Item.findOne({ where: { player_id: playerId, item_key: key }, raw: true }))?.quantity);
}
async function pocket(playerId) {
    const p = await Player.findByPk(playerId, { attributes: ['spirit_stones', 'exp', 'border_military_merit_available'] });
    return { stones: B(p.spirit_stones), exp: B(p.exp), merit: N(p.border_military_merit_available) };
}

async function main() {
    await bootApp(app, { port: PORT });
    const cfg = (require('../config/border_military_data.json').beast_patrol) || {};
    const routes = cfg.routes || {};
    check('P0 配置里三条路线都在（否则 P 系列全是空跑）',
        ['scout', 'grain_guard', 'camp_raid'].every(r => !!routes[r]),
        `路线=${Object.keys(routes).join('/')} 灵兽门槛=等级${cfg.min_beast_level}/忠诚${cfg.min_beast_loyalty}`);
    if (!routes.scout) return;

    let p = await Player.findOne({ where: { username: ACCOUNT } });
    const seed = {
        realm: '结丹期', realm_rank: 25, exp: 100000, spirit_stones: 100000,
        hp_current: 50000, mp_current: 5000, is_dead: false, is_banned: false,
        border_beast_patrol_date: null
    };
    if (!p) {
        p = await Player.create({
            username: ACCOUNT, password: 'not-a-real-hash', nickname: '巡边探针',
            lifespan_current: 500, attributes: {}, token_version: 0,
            border_military_merit_total: 0, border_military_merit_available: 0, ...seed
        });
    } else {
        await Player.update({ ...seed, border_military_merit_total: 0, border_military_merit_available: 0 }, { where: { id: p.id } });
    }
    const pid = p.id;
    await BorderBeastPatrol.destroy({ where: { player_id: pid }, force: true });
    await SpiritBeast.destroy({ where: { player_id: pid }, force: true });
    const fragKeys = (routes.scout.item_drops || []).map(d => d.key);
    await Item.destroy({ where: { player_id: pid, item_key: { [Op.in]: fragKeys } }, force: true });
    const beast = await SpiritBeast.create({
        player_id: pid, beast_key: 'qingyun_wolf', beast_name: '青云狼', element: 'metal', rarity: 'common',
        level: N(cfg.min_beast_level) + 2, loyalty: N(cfg.min_beast_loyalty) + 20, exp: 0
    });

    // ===== P1 派出 =====
    p = await Player.findByPk(pid);
    const sent = await withZeroRandom(async () => BorderBeastPatrolSubService.patrol(p, beast.id, 'scout'));
    const row = await BorderBeastPatrol.findOne({ where: { player_id: pid }, order: [['id', 'DESC']] });
    check('P1 派出灵兽巡边：记录落库、未结算、归来时间在未来',
        sent.success === true && !!row && row.settled === false && new Date(row.end_time) > new Date()
        && row.beast_id === beast.id && row.patrol_route === 'scout',
        `回执=${sent.message || sent.success} 记录=${row && row.id} settled=${row && row.settled}`);
    if (!row) return;

    // ===== P2 未到点不许结算 =====
    const early = await BorderBeastPatrolSubService.returnFromPatrol(await Player.findByPk(pid), row.id);
    check('P2 未到归来时间就结算必须被拒（否则可以秒刷军功）',
        early.success === false && /尚未结束/.test(early.message || ''),
        `理由=${early.message}`);

    // ===== P3 到点归来：军功/经验/物品三笔账要"账面 = 库存" =====
    await BorderBeastPatrol.update({ end_time: new Date(Date.now() - 1000) }, { where: { id: row.id } });
    const before = await pocket(pid);
    const bagBefore = {}; for (const k of fragKeys) bagBefore[k] = await bagQty(pid, k);
    const beastBefore = B((await SpiritBeast.findByPk(beast.id)).exp);
    const settled = await withZeroRandom(async () => BorderBeastPatrolSubService.returnFromPatrol(await Player.findByPk(pid), row.id));
    const rowAfter = await BorderBeastPatrol.findByPk(row.id);
    const after = await pocket(pid);
    const drops = JSON.parse(rowAfter.items_dropped || '[]');
    const bagNow = {}; for (const k of fragKeys) bagNow[k] = await bagQty(pid, k);
    const bagOk = fragKeys.every(k => bagNow[k] - bagBefore[k] === N(drops.find(d => d.key === k)?.quantity || 0));
    const beastNow = B((await SpiritBeast.findByPk(beast.id)).exp);
    check('P3 归来结算：玩家经验/灵兽经验/军功的增量与记录行完全一致（回执说多少库里就多少）',
        settled.success === true && after.exp - before.exp === B(rowAfter.exp_gained)
        && after.merit - before.merit === N(rowAfter.merit_gained) && rowAfter.merit_gained > 0
        && beastNow - beastBefore === B(rowAfter.beast_exp_gained),
        `经验 +${after.exp - before.exp}(记 ${rowAfter.exp_gained}) 军功 +${after.merit - before.merit}(记 ${rowAfter.merit_gained}) 灵兽 +${beastNow - beastBefore}(记 ${rowAfter.beast_exp_gained})`);
    check('P3b 物品一笔都不能假：背包增量 = items_dropped 落库量 = 消息里列的件数',
        bagOk && drops.length > 0
        && (settled.message.match(/×\d+/g) || []).length === drops.length
        && drops.every(d => Number(d.quantity) >= 1 && d.key !== undefined && d.item_name !== undefined),
        `掉落=${JSON.stringify(drops)} 背包=${fragKeys.map(k => `${k}:${bagNow[k] - bagBefore[k]}`).join(' ')}`);
    check('P3c 结算只扣一次时间戳：行落到 settled 且记了归来时间',
        rowAfter.settled === true && !!rowAfter.settled_at && rowAfter.failed === false,
        `settled=${rowAfter.settled} settled_at=${rowAfter.settled_at && rowAfter.settled_at.toISOString()}`);

    // ===== P4 重放那一笔不能再发第二遍 =====
    const bagAfter3 = {}; for (const k of fragKeys) bagAfter3[k] = await bagQty(pid, k);
    const replay = await BorderBeastPatrolSubService.returnFromPatrol(await Player.findByPk(pid), row.id);
    const after2 = await pocket(pid);
    const bagAfterReplay = {}; for (const k of fragKeys) bagAfterReplay[k] = await bagQty(pid, k);
    check('P4 同一笔巡边重放被拒且分文不发（双领这一类的形状）',
        replay.success === false && /已结算/.test(replay.message || '')
        && after2.exp === after.exp && after2.merit === after.merit
        && fragKeys.every(k => bagAfterReplay[k] === bagAfter3[k]),
        `理由=${replay.message} 经验 ${after.exp}→${after2.exp} 军功 ${after.merit}→${after2.merit} 背包 ${fragKeys.map(k => `${k}:${bagAfter3[k]}→${bagAfterReplay[k]}`).join(' ')}`);

    // ===== P5 每日一次：今天再派要被挡住 =====
    const again = await withZeroRandom(async () => BorderBeastPatrolSubService.patrol(await Player.findByPk(pid), beast.id, 'grain_guard'));
    check('P5 今日已派出过就不许再派（每日上限要真生效）',
        again.success === false && /今日已派出/.test(again.message || ''),
        `理由=${again.message}`);

    // ===== P6 灵石路线：换一天再派 grain_guard，归来时灵石增量要等于记录行 =====
    await Player.update({ border_beast_patrol_date: null }, { where: { id: pid } });
    const sent6 = await withZeroRandom(async () => BorderBeastPatrolSubService.patrol(await Player.findByPk(pid), beast.id, 'grain_guard'));
    const row6 = await BorderBeastPatrol.findOne({ where: { player_id: pid, settled: false }, order: [['id', 'DESC']] });
    let stonesDelta = -1n, recorded = -1;
    if (sent6.success && row6) {
        await BorderBeastPatrol.update({ end_time: new Date(Date.now() - 1000) }, { where: { id: row6.id } });
        const b = await pocket(pid);
        await withZeroRandom(async () => BorderBeastPatrolSubService.returnFromPatrol(await Player.findByPk(pid), row6.id));
        const a = await pocket(pid);
        stonesDelta = a.stones - b.stones; recorded = N((await BorderBeastPatrol.findByPk(row6.id)).spirit_stones_gained);
    }
    check('P6 粮道巡边的灵石增量 = 记录行的 spirit_stones_gained（随机取下限 100，不是消息里另算一份）',
        sent6.success === true && recorded > 0 && stonesDelta === B(recorded),
        `派出=${sent6.success} 记录=${recorded} 实到=${stonesDelta}`);
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (e) {
        hard = 1;
        console.error('探针异常：', e && e.message ? e.message : e);
    } finally {
        try {
            const p = await Player.findOne({ where: { username: ACCOUNT } });
            if (p) {
                await BorderBeastPatrol.destroy({ where: { player_id: p.id }, force: true });
                await SpiritBeast.destroy({ where: { player_id: p.id }, force: true });
                await Item.destroy({ where: { player_id: p.id }, force: true });
                await Player.destroy({ where: { id: p.id }, force: true });
            }
            console.log(`清理：探针号 ${ACCOUNT} 与它的巡边记录/灵兽/背包已删（残留 ${(await Player.count({ where: { username: ACCOUNT } }))} 个账号、${await BorderBeastPatrol.count()} 条巡边）`);
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n灵兽巡边探针：${results.filter(r => r.ok).length}/${results.length} 通过，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
