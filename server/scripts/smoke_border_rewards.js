/**
 * 慕兰战线奖励链探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 这条链以前是"配了但拿不到"的集中营，实测出问题的有三处：
 *   1. 军功商店 5 件商品、里程碑 4 档奖励、后勤/巡边掉落里一共 9 个物品 id 在 item_data 里不存在。
 *      商店那条至少还回一句"物品发放失败"；里程碑更糟 —— 先插"已发放"记录、再发奖、异常只 console.warn，
 *      于是玩家既拿不到东西也永远领不到第二次。
 *   2. 残图匣（集 4 类苍坤残片 → 拼完整残图 → 按图探禁）用的 5 个物品 id 一个都没配，
 *      整个玩法不可达，界面上只会永远显示"残片不足"。
 *   3. 里程碑发奖是不持锁的 `Player.findByPk + save`：players 是多人共用行，
 *      与同一时刻别的灵石写入互相覆盖（丢的就是这一档的 500~10000 灵石）。
 *
 * 这里钉的是"发得出来 + 发不出就整笔回滚 + 不会互相覆盖"，不是"配置里有没有这些键"（那由
 * ContentRegistry 的启动期深扫管）。B6 另外钉支援掉落改走 grantItems() 之后的对账：
 * 日志 items_dropped 说的每一件都要真在背包里，且玩家那句回报里是中文名而不是裸键。
 *
 * 用法：cd server && SMOKE_PORT=5098 node --env-file=.env scripts/smoke_border_rewards.js
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const { app } = require('../index');
const { Op } = require('sequelize');
const Player = require('../models/player');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const game = require('../game');
const BorderMilitaryService = require('../game/services/BorderMilitaryService');
const BorderMilestoneReward = require('../models/border_milestone_reward');
const BorderSupportLog = require('../models/border_support_log');
const { itemName } = require('../game/items/itemNaming');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
const borderConfig = require('../config/border_military_data.json');
const itemData = require('../config/item_data.json');

const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensureProbePlayer() {
    // 开头按账号名清历次残留（而不是只删 players 那一行）：上一轮崩在收尾之前留下的
    // 里程碑记录 / 支援日志 / 背包行按新 id 永远找不回来，会污染本轮的对账。
    await PlayerCascadePurge.deleteByUsernames(['borderprobe']);
    return Player.create({
        username: 'borderprobe',
        password: 'not-a-real-hash',
        nickname: '战线奖励探针',
        realm: '筑基初期',
        realm_rank: 11,
        exp: 0,
        spirit_stones: 0,
        hp_current: 5000,
        mp_current: 5000,
        lifespan_current: 120,
        attributes: {},
        token_version: 0,
        border_military_merit_total: 0
    });
}

async function quantity(playerId, itemKey) {
    return Number(await game.InventoryService.getItemQuantity(playerId, itemKey)) || 0;
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await ensureProbePlayer();
    const thresholds = borderConfig.milestones.thresholds;
    const expectedStones = thresholds.reduce((sum, t) => sum + Number(t.rewards?.spirit_stones || 0), 0);
    const expectedItems = new Map();
    for (const t of thresholds) {
        for (const item of (t.rewards?.items || [])) {
            expectedItems.set(item.key, (expectedItems.get(item.key) || 0) + Number(item.quantity));
        }
    }

    // ===== B1：内容里出现的每一个物品引用都必须真发得出来 =====
    const referenced = new Set();
    (function walk(node) {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
            if ((key === 'key' || /_item_key$|_item_id$/.test(key)) && typeof value === 'string'
                && itemData.items.some(i => i.id === value)) referenced.add(value);
            if (/^(items|item_drops)$/.test(key) && Array.isArray(value)) {
                for (const row of value) if (row && typeof row.key === 'string') referenced.add(row.key);
            }
            walk(value);
        }
    })(borderConfig);

    const grantFailures = [];
    for (const itemKey of referenced) {
        try {
            await game.InventoryService.addItem(player.id, itemKey, 1);
        } catch (e) {
            grantFailures.push(`${itemKey}: ${e.message}`);
        }
    }
    const ungranted = [...referenced].filter(k => !itemData.items.some(i => i.id === k));
    check(
        `B1 战线内容里引用的 ${referenced.size} 个物品 id 全部存在且能发放`,
        ungranted.length === 0 && grantFailures.length === 0,
        `缺失=${ungranted.join(',') || '无'} 发放失败=${grantFailures.slice(0, 3).join(' | ') || '无'}`
    );

    // ===== B2：里程碑四档一次跨完，奖励真的进背包 =====
    await Player.update({ border_military_merit_total: 81 }, { where: { id: player.id } });
    await BorderMilestoneReward.destroy({ where: { player_id: player.id } });
    const before = await Player.findByPk(player.id);
    const startedAt = Date.now();
    const grant = await BorderMilitaryService._checkMilestones(before);
    const elapsedMs = Date.now() - startedAt;
    const after = await Player.findByPk(player.id);
    const stonesGained = Number(BigInt(after.spirit_stones) - BigInt(before.spirit_stones));
    const itemRows = await Promise.all([...expectedItems].map(([k, qty]) => quantity(player.id, k).then(q => [k, q, qty])));
    const itemOk = itemRows.filter(([, got, want]) => got >= want).length;
    check(
        `B2 累计军功 81 触发全部 ${thresholds.length} 档：灵石与物品都真到账（且不撞锁等待）`,
        grant.triggered === true && (grant.granted || []).length === thresholds.length
            && stonesGained === expectedStones
            && itemOk === expectedItems.size
            && elapsedMs < 5000,
        `granted=${(grant.granted || []).length} 灵石+${stonesGained}(应 ${expectedStones}) 物品到账 ${itemOk}/${expectedItems.size} 耗时 ${elapsedMs}ms 错误=${grant.error || '无'}`
    );

    // ===== B3：重复调用不再发第二遍 =====
    const beforeRepeat = await Player.findByPk(player.id);
    const repeat = await BorderMilitaryService._checkMilestones(beforeRepeat);
    const afterRepeat = await Player.findByPk(player.id);
    check(
        'B3 同一批里程碑不会发第二遍',
        repeat.triggered === false
            && BigInt(afterRepeat.spirit_stones) === BigInt(beforeRepeat.spirit_stones)
            && (await BorderMilestoneReward.count({ where: { player_id: player.id } })) === thresholds.length,
        `triggered=${repeat.triggered} 行数=${await BorderMilestoneReward.count({ where: { player_id: player.id } })}`
    );

    // ===== B4：发奖中途回滚，不留"已发放"记录、也不留下半份奖励 =====
    await BorderMilestoneReward.destroy({ where: { player_id: player.id, milestone_merit: 81 } });
    const snapshot = await Player.findByPk(player.id);
    const stonesBeforeRollback = BigInt(snapshot.spirit_stones);
    const badgeBefore = await quantity(player.id, 'tianan_border_badge');
    const hasTransactionalGrant = typeof BorderMilitaryService._grantPendingMilestones === 'function';
    let rollbackThrew = false;
    if (hasTransactionalGrant) {
        const rollbackTx = await sequelize.transaction();
        try {
            await BorderMilitaryService._grantPendingMilestones(
                { id: player.id, border_military_merit_total: 81 }, rollbackTx
            );
            await rollbackTx.rollback();
        } catch (e) {
            rollbackThrew = true;
            await rollbackTx.rollback().catch(() => {});
        }
    }
    const afterRollback = await Player.findByPk(player.id);
    check(
        'B4 回滚之后：这一档仍可重领（记录没先写死）、灵石与物品也一分没动',
        hasTransactionalGrant && !rollbackThrew
            && (await BorderMilestoneReward.count({ where: { player_id: player.id, milestone_merit: 81 } })) === 0
            && BigInt(afterRollback.spirit_stones) === stonesBeforeRollback
            && await quantity(player.id, 'tianan_border_badge') === badgeBefore,
        hasTransactionalGrant
            ? `异常=${rollbackThrew ? '有' : '无'} 记录=${await BorderMilestoneReward.count({ where: { player_id: player.id, milestone_merit: 81 } })} 灵石变动=${BigInt(afterRollback.spirit_stones) - stonesBeforeRollback}`
            : '服务里没有"事务内发放"这一步（旧写法是先插已发放记录再发奖，回滚无从谈起）'
    );

    // ===== B5：两笔并发只发一遍（players 行的写锁把同一玩家的发放串行化）=====
    await Player.update({ border_military_merit_total: 49 }, { where: { id: player.id } });
    await BorderMilestoneReward.destroy({ where: { player_id: player.id, milestone_merit: { [Op.in]: [49, 81] } } });
    const concurrent = await Promise.all([
        BorderMilitaryService._checkMilestones(await Player.findByPk(player.id)),
        BorderMilitaryService._checkMilestones(await Player.findByPk(player.id))
    ]);
    const rows49 = await BorderMilestoneReward.count({ where: { player_id: player.id, milestone_merit: 49 } });
    check(
        'B5 两笔并发发放 49 档：只落一行记录（灵石由持锁写保证不互相覆盖）',
        rows49 === 1 && concurrent.filter(c => c.triggered).length >= 1,
        `49 档行数=${rows49} triggered=${concurrent.map(c => c.triggered).join(',')}`
    );

    // ===== B6：支援掉落三方对账（日志 items_dropped / 背包 / 玩家看到的那句话）=====
    // grantItems() 之后，drops 只留真发到的那些；这里反过来钉两件事：
    //   ① 日志说掉的每一件，背包里必须真多出来（少一件=谎报）；
    //   ② 那句话必须报中文名，不许把裸键摊给玩家。
    // 掉率是随机的，所以反复支援直到真掉下东西；一次都没掉过=本项空测。
    const dropRoutes = Object.entries(borderConfig.support_routes || {})
        .filter(([, r]) => Array.isArray(r.item_drops) && r.item_drops.length > 0);
    let b6Failures = [], landedRounds = 0, riskyRounds = 0;
    if (dropRoutes.length === 0) {
        b6Failures.push('内容里没有任何带 item_drops 的支援路线（这条链整段没内容，探针测不到）');
    }
    // 支援有境界门槛（min_realm_rank 15），B2~B5 用的账号等级不够，这里抬上去再跑
    await Player.update({ realm: '结丹初期', realm_rank: 15 }, { where: { id: player.id } });
    for (const [routeName, routeCfg] of dropRoutes) {
        const routeKeys = routeCfg.item_drops.map(d => d.key);
        for (let attempt = 0; attempt < 25 && landedRounds < 6; attempt++) {
            await Player.update({ border_last_support_date: null, border_today_support_route: null }, { where: { id: player.id } });
            const beforeQty = new Map();
            for (const k of routeKeys) beforeQty.set(k, await quantity(player.id, k));
            const res = await BorderMilitaryService.supportMulanan(await Player.findByPk(player.id), routeName);
            // 险棋路线本来就带"支援失败 + 赔 50 灵石 50 HP"的分支（设计如此，不是 bug）：
            // 失败轮不计到账、继续重试，只要求最终真掉到过东西（landedRounds>0），否则这条才是空测。
            // 原来这里 `break` 并把失败当缺陷 —— 6 轮里撞上一次随机失败就整条假红（2026-09-22 实测）。
            if (!res.success) { riskyRounds++; continue; }
            const log = await BorderSupportLog.findOne({ where: { player_id: player.id }, order: [['id', 'DESC']] });
            const dropped = log && log.items_dropped ? JSON.parse(log.items_dropped) : [];
            if (dropped.length === 0) continue;
            landedRounds++;
            const gained = new Map();
            for (const d of dropped) gained.set(d.key, (gained.get(d.key) || 0) + Number(d.quantity));
            for (const [k, want] of gained) {
                const got = await quantity(player.id, k);
                if (got !== beforeQty.get(k) + want) b6Failures.push(`${routeName}/${k}: 日志说 ${want} 件，背包只多 ${got - beforeQty.get(k)} 件`);
            }
            for (const d of dropped) {
                const name = itemName(d.key);
                if (!name) b6Failures.push(`${routeName}: ${d.key} 在内容里查不到名字（消息里只能露裸键）`);
                else if (!res.message.includes(name) || res.message.includes(String(d.key))) {
                    b6Failures.push(`${routeName}: 这句话没报中文名 —— ${res.message.slice(0, 90)}`);
                }
            }
        }
    }
    check(
        'B6 支援掉落的日志、背包、玩家消息三者一致（且报的是中文名）',
        landedRounds > 0 && b6Failures.length === 0,
        `真掉过 ${landedRounds} 轮${b6Failures.length ? ' —— ' + b6Failures.slice(0, 3).join(' | ') : ''}`
    );

    // 上面 B2/B4/B5 里那几条 BorderMilestoneReward.destroy 是**跑到一半重置状态**用的
    // （断言要的是"这一档此刻确实没发过"），删掉会改掉断言前提，所以留着；
    // 收尾这一条不再手写表名 —— 里程碑记录/支援日志/背包都按 player_id 归属，交给那一份级联。
    const purged = await PlayerCascadePurge.deletePlayer(Number(player.id));
    console.log(`清理：删掉探针号 ${purged.username}（id ${purged.player_id}），级联带走 ${purged.total} 行派生数据`
        + `（残留里程碑记录 ${await BorderMilestoneReward.count({ where: { player_id: player.id } })} 行、`
        + `支援日志 ${await BorderSupportLog.count({ where: { player_id: player.id } })} 行）`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    await sequelize.close().catch(() => {});
    process.exit(2);
});
