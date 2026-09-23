/**
 * 多人副本（黄龙山）端到端探针 —— 需要 MySQL，走 .env 指向的库
 *
 * 这条探针存在的理由有两层：
 *   1. 多人副本此前**没有任何活体覆盖**（jest 不连库，其它探针只打单人副本/兽潮/宗门战），
 *      所以"内容里的抉择键与服务读的列名对不上"这种缺陷在黄龙山身上哑了两个月：
 *      内容写 formation_power_change / eye_position / contribution_score_self_change，
 *      服务与抉择记录表读 huanglong_formation_power_change / huanglong_eye_position / …，
 *      接口照样返回成功、玩家看得到文案、字段一个不动。
 *   2. 它同时是"副本 = 内容"这条主张的活体证明：建号 → 结队 → 开打 → 抉择 → 落库，全程只有内容是真相。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_multi_dungeon.js
 *       探针自建 5 个专用账号（mdleader + mdmem01..04）、同宗门、只动它们自己的行。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5089);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerSect = require('../models/playerSect');
const sequelize = require('../config/database');
const MultiDungeonService = require('../game/services/MultiDungeonService');
const MultiDungeonInstance = require('../models/multiDungeonInstance');
const MultiDungeonMember = require('../models/multiDungeonMember');
const MultiDungeonChoice = require('../models/multiDungeonChoice');
const InventoryService = require('../game/services/InventoryService');
const { itemName } = require('../game/items/itemNaming');
const { bootApp } = require('./lib/smoke_http');

const DUNGEON = 'huanglong';
const SECT = 'probe_sect';
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

const ACCOUNTS = [
    { username: 'mdleader', realm: '元婴初期', realm_rank: 19 },
    { username: 'mdmem01', realm: '金丹后期', realm_rank: 17 },
    { username: 'mdmem02', realm: '金丹后期', realm_rank: 17 },
    { username: 'mdmem03', realm: '金丹后期', realm_rank: 17 },
    { username: 'mdmem04', realm: '金丹后期', realm_rank: 17 }
];

async function cleanup() {
    const ids = (await Player.findAll({ where: { username: ACCOUNTS.map(a => a.username) }, attributes: ['id'] }))
        .map(p => Number(p.id));
    if (!ids.length) return;
    // 背包在 players.attributes 那块 blob 里，删号即清；副本行要按"队长"与"成员"两个入口都找一遍
    const led = await MultiDungeonInstance.findAll({ where: { leader_player_id: ids }, attributes: ['id'] });
    const memberships = await MultiDungeonMember.findAll({ where: { player_id: ids }, attributes: ['instance_id'] });
    const instanceIds = [...new Set([
        ...led.map(i => Number(i.id)),
        ...memberships.map(m => Number(m.instance_id))
    ])];
    if (instanceIds.length) {
        await MultiDungeonChoice.destroy({ where: { instance_id: instanceIds } });
        await MultiDungeonMember.destroy({ where: { instance_id: instanceIds } });
        await MultiDungeonInstance.destroy({ where: { id: instanceIds } });
    }
    // 副本实例/成员行按 instance_id 归属，级联清不到，所以上面那两条留着；
    // 但"宗门关系 + 冷却 + 背包 + 称号"这些按 player_id 归属的全部交给生产代码里那一份级联
    // （口径只有一份；探针手写"顺手删三张表"迟早漏一张，那正是隔离库攒出 761 行孤儿的方式）。
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
    const purged = await PlayerCascadePurge.deletePlayers(ids);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
}

async function seed() {
    const players = [];
    for (const account of ACCOUNTS) {
        const player = await Player.create({
            username: account.username,
            password: 'not-a-real-hash',
            nickname: `副本探针${account.username}`,
            realm: account.realm,
            realm_rank: account.realm_rank,
            exp: 0,
            spirit_stones: 100000,
            hp_current: 50000,
            mp_current: 5000,
            lifespan_current: 500,
            attributes: {},
            token_version: 0
        });
        await PlayerSect.create({ player_id: player.id, sect_id: SECT, contribution: 0, role: 'member' });
        players.push(player);
    }
    // 队长门票：黄龙山 consume_item_key = huanglong_token ×1
    await InventoryService.addItem(players[0].id, 'huanglong_token', 1, null);
    return players;
}

(async () => {
    await bootApp(app, { port: PORT });     // 顺带把游戏服务装配好（InventoryService 需要 configLoader）
    await cleanup();
    const players = await seed();
    const leader = players[0];

    const created = await MultiDungeonService.create(leader.id, DUNGEON);
    const instanceId = created?.data?.instance_id ?? created?.data?.instance?.id;
    check('X1 队长创建黄龙山副本成功', created.success === true && !!instanceId,
        `${created.message || ''} instance_id=${instanceId}`);
    if (!instanceId) return finish();

    const joins = [];
    for (const member of players.slice(1)) {
        joins.push(await MultiDungeonService.join(member.id, instanceId));
    }
    check('X2 其余 4 人加入成功（member_min=5）', joins.every(j => j.success === true),
        joins.map(j => j.message || 'ok').join(' | '));

    const entered = await MultiDungeonService.enter(leader.id);
    check('X3 队长开场成功（副本进入 active）', entered.success === true, `${entered.message || ''}`);
    if (entered.success !== true) return finish();

    const chosen = await MultiDungeonService.choose(leader.id, 'center');
    check('X4 队长抉择"中军阵眼"返回成功', chosen.success === true, `${chosen.message || ''}`);

    // 关键断言：内容里的短名（formation_power_change=15 / eye_position / contribution_score_self_change=8）
    // 必须落到带前缀的列上。改前这三处全是 0/null。
    const instance = await MultiDungeonInstance.findByPk(instanceId);
    const leaderMember = await MultiDungeonMember.findOne({ where: { instance_id: instanceId, player_id: leader.id } });
    const record = await MultiDungeonChoice.findOne({ where: { instance_id: instanceId, chosen_option: 'center' } });

    check('X5 阵法强度真的加到了副本实例上（内容写 formation_power_change，列是 huanglong_formation_power）',
        Number(instance?.huanglong_formation_power) === 15,
        `huanglong_formation_power=${instance?.huanglong_formation_power}（应为 15）`);
    check('X6 阵眼与个人贡献落到队长成员行（内容写 eye_position / contribution_score_self_change）',
        leaderMember?.huanglong_eye_position === 'center' && Number(leaderMember?.huanglong_contribution_score) === 8,
        `eye=${leaderMember?.huanglong_eye_position} contribution=${leaderMember?.huanglong_contribution_score}`);
    check('X7 抉择流水记的是补齐后的键（审计链与生效链同源）',
        Number(record?.huanglong_formation_power_change) === 15 && record?.huanglong_eye_position === 'center',
        `record fp_change=${record?.huanglong_formation_power_change} eye=${record?.huanglong_eye_position}`);

    // 面板读的是 getStatus：变量块与"中文名/归属"必须一起给出来，客户端不再自己写死字典
    const status = await MultiDungeonService.getStatus(leader.id);
    check('X8 /status 的变量块带着黄龙山的阵法强度，且带中文标签与归属',
        Number(status?.data?.variables?.huanglong_formation_power) === 15
            && status?.data?.variable_meta?.huanglong_formation_power?.label === '阵法强度'
            && Array.isArray(status?.data?.variable_meta?.huanglong_formation_power?.dungeons)
            && status.data.variable_meta.huanglong_formation_power.dungeons.includes('huanglong')
            && status?.data?.variable_meta?.morale?.dungeons === null,
        `variables.huanglong_formation_power=${status?.data?.variables?.huanglong_formation_power} `
        + `meta=${JSON.stringify(status?.data?.variable_meta?.huanglong_formation_power)} morale归属=${JSON.stringify(status?.data?.variable_meta?.morale)}`);

    // GM 调整变量：白名单以前在路由和服务里各抄了一份（19 个 / 24 个），
    // 黄龙山的变量两边都没有 —— 界面能选到、请求一定被拒。现在清单取自内容。
    const gmAdjust = await MultiDungeonService.gmAdjustVariable(instanceId, 'huanglong_formation_power', 42, leader.id);
    const afterAdjust = await MultiDungeonInstance.findByPk(instanceId);
    check('X9 GM 能把黄龙山专属变量调进去（清单来自内容，不再是手抄白名单）',
        gmAdjust.success === true && Number(afterAdjust?.huanglong_formation_power) === 42,
        `${gmAdjust.message || ''} huanglong_formation_power=${afterAdjust?.huanglong_formation_power}（应为 42）`);

    const crossDungeon = await MultiDungeonService.gmAdjustVariable(instanceId, 'mountain_seal', 5, leader.id);
    // 提示里必须点名这个实例的副本：只判"被拒"的话，dungeon_key 拼错成 undefined 也能过（真的发生过）
    check('X10 别的副本的专属变量被拦下（写进无人读的列只会骗人）',
        crossDungeon.success === false && /不属于/.test(crossDungeon.message || '') && /huanglong/.test(crossDungeon.message || ''),
        `${crossDungeon.message || ''}`);

    // X11 拿"实例行上真实存在的变量列"（variables 来自模型）比"可调清单"（来自内容），
    // 两个来源不同才测得出东西：旧的两份手抄白名单（19 个 / 24 个）在这里会漏掉一半以上。
    const adjustable = new Set(MultiDungeonService.adjustableVariables());
    const unadjustable = Object.keys(status?.data?.variables || {}).filter(v => !adjustable.has(v));
    check('X11 实例上的每个变量列都能被 GM 调整（清单跟着内容走）',
        unadjustable.length === 0,
        `可调 ${adjustable.size} 个，调不动的：${unadjustable.join('/') || '无'}`);

    await MultiDungeonService.dissolve(leader.id);

    // ===== X12/X13 花钱的抉择（本会话把 players 锁提到了 choose 事务开头，这里验账还在不在） =====
    // 全内容只有一处抉择带灵石消耗（掩月宗第 1 幕 disguise_infiltrate = 500），所以先压"灵石不足"
    // 这条拒绝分支，再补足灵石压成功分支 —— 两条都走的就是我改过的那个 if 块。
    const yanyueCfg = (require('../modules').infrastructure.ConfigLoader.getConfig('multi_dungeon_data') || {}).dungeons?.yanyue;
    if (yanyueCfg && Number(yanyueCfg.member_min) <= players.length) {
        if (yanyueCfg.consume_item_key) {
            await InventoryService.addItem(leader.id, yanyueCfg.consume_item_key, Number(yanyueCfg.consume_item_count) || 1, null);
        }
        const yCreated = await MultiDungeonService.create(leader.id, 'yanyue');
        const yInstance = yCreated?.data?.instance_id ?? yCreated?.data?.instance?.id;
        const yJoins = [];
        for (const m of players.slice(1, Number(yanyueCfg.member_min))) {
            yJoins.push(await MultiDungeonService.join(m.id, yInstance));
        }
        const yEntered = yInstance ? await MultiDungeonService.enter(leader.id) : { success: false, message: '没建起来' };
        check('X12 掩月宗副本跑得起来（下面两条要有东西可测）',
            !!yInstance && yJoins.every(j => j.success === true) && yEntered.success === true,
            `instance=${yInstance} 人数=${yJoins.length + 1}/${yanyueCfg.member_min} ${yEntered.message || ''}`);

        const costly = (yanyueCfg.acts.find(a => Number(a.act_number) === 1)?.choices || [])
            .find(ch => Number(ch.cost_spirit_stones) > 0);
        const stonesOf = async id => BigInt((await Player.findByPk(id, { attributes: ['spirit_stones'] })).spirit_stones || 0);
        if (costly && yInstance) {
            const cost = BigInt(costly.cost_spirit_stones);
            await Player.update({ spirit_stones: cost - 1n }, { where: { id: leader.id } });
            const wPoor = await stonesOf(leader.id);
            const denied = await MultiDungeonService.choose(leader.id, costly.key);
            const stillFirstAct = await MultiDungeonInstance.findByPk(yInstance);
            check(`X13 灵石不足时抉择被拒、且分文不扣幕数不动（${costly.key} 要 ${cost.toString()}）`,
                denied.success === false && /灵石不足/.test(denied.message || '')
                && await stonesOf(leader.id) === wPoor && Number(stillFirstAct?.current_act) === 1,
                `${denied.message || '（居然成功了）'} 余额 ${wPoor.toString()}→${(await stonesOf(leader.id)).toString()} 幕=${stillFirstAct?.current_act}`);

            await Player.update({ spirit_stones: cost * 10n }, { where: { id: leader.id } });
            const wRich = await stonesOf(leader.id);
            const paid = await MultiDungeonService.choose(leader.id, costly.key);
            const afterPay = await MultiDungeonInstance.findByPk(yInstance);
            check('X13b 同一抉择灵石够时只扣配置那一档、幕数推进（锁提前后账目与流程都还对）',
                paid.success === true && wRich - await stonesOf(leader.id) === cost && Number(afterPay?.current_act) === 2,
                `${paid.message || ''} 扣 ${(wRich - await stonesOf(leader.id)).toString()}（应为 ${cost.toString()}）幕 1→${afterPay?.current_act}`);
        } else {
            check(`X13 灵石不足时抉择被拒、且分文不扣幕数不动（${costly ? costly.key : '无'}）`, false,
                '内容里第 1 幕没有带灵石消耗的抉择，这条测不到（改动过的那段就是它）');
            check('X13b 同一抉择灵石够时只扣配置那一档、幕数推进（锁提前后账目与流程都还对）', false, '同上');
        }
        await MultiDungeonService.dissolve(leader.id);
    } else {
        check('X12 掩月宗副本跑得起来（下面两条要有东西可测）', false, '内容里没有 yanyue 或人数不够');
        check(`X13 灵石不足时抉择被拒、且分文不扣幕数不动`, false, '上一条没起来');
        check('X13b 同一抉择灵石够时只扣配置那一档、幕数推进（锁提前后账目与流程都还对）', false, '上一条没起来');
    }

    // ===== X14~X16 通关结算：全组同时发钱发物品的那条路（_settleRewards）=====
    // 这条此前运行时零覆盖：它对每个在场成员读一遍 players 行、改完就 save，
    // 一次结算里对同一张 players 表做二十几次单行加锁，且次序跟着成员表返回顺序走。
    const Item = require('../models/item');
    // 上一轮 dissolve 可能落了冷却；门票也被第一针消耗掉了 —— 先把这两样备齐，否则 X14 红的是准备工作
    await InventoryService.addItem(leader.id, 'huanglong_token', 1, null);
    for (const p of players) await MultiDungeonService.gmResetCooldown(p.id, DUNGEON, leader.id);
    const h2 = await MultiDungeonService.create(leader.id, DUNGEON);
    const h2id = h2?.data?.instance_id ?? h2?.data?.instance?.id;
    const h2joins = [];
    for (const m of players.slice(1)) h2joins.push(await MultiDungeonService.join(m.id, h2id));
    const h2enter = h2id ? await MultiDungeonService.enter(leader.id) : { success: false, message: '没建起来' };
    const walk = [];
    for (const key of ['center', 'raid', 'guard_formation']) {
        const r = await MultiDungeonService.choose(leader.id, key);
        walk.push(`${key}:${r && r.success ? 'ok' : `拒[${(r && r.message || '').slice(0, 20)}]`}`);
    }
    if (h2id) await MultiDungeonService.gmAdjustVariable(h2id, 'huanglong_formation_power', 9999, leader.id);
    const present = await MultiDungeonMember.findAll({ where: { instance_id: h2id, is_present: 1 } });
    const snapOf = async () => {
        const out = new Map();
        for (const m of present) {
            const p = await Player.findByPk(m.player_id, { attributes: ['spirit_stones', 'honor', 'realm_rank'] });
            const rows = await Item.findAll({ where: { player_id: m.player_id }, attributes: ['item_key', 'quantity'] });
            out.set(Number(m.player_id), {
                stones: BigInt(p?.spirit_stones || 0), honor: Number(p?.honor || 0), realm: Number(p?.realm_rank || 0),
                items: new Map(rows.map(r2 => [r2.item_key, Number(r2.quantity)]))
            });
        }
        return out;
    };
    const before = await snapOf();
    const advanced = await MultiDungeonService.advance(leader.id);
    const h2instance = h2id ? await MultiDungeonInstance.findByPk(h2id) : null;
    const summary = advanced?.data?.rewards;
    // 报出的账分散在两个桶里：普通掉落记 {item_key:'spirit_stones', count}，
    // 首通奖励记 {type:'spirit_stones', count} 且在另一个桶（只读 normal_drops 会把首通那笔当成"没报"）。
    const bucketsFor = pid => {
        const out = [];
        const nd = (summary?.normal_drops || []).find(d => Number(d.player_id) === pid);
        if (nd) out.push(...(nd.drops || []));
        const fc = (summary?.first_clear || []).find(d => Number(d.player_id) === pid);
        if (fc) out.push(...(fc.bonuses || []));
        return out;
    };
    const reportedStones = pid => bucketsFor(pid)
        .filter(d => d.item_key === 'spirit_stones' || d.type === 'spirit_stones')
        .reduce((s, d) => s + BigInt(Number(d.count) || 0), 0n);
    const after1 = await snapOf();
    let stoneMismatch = [];
    let honorMismatch = [];
    let itemMismatch = [];
    for (const [pid, was] of before.entries()) {
        const now = after1.get(pid);
        const gotStones = now.stones - was.stones;
        if (gotStones !== reportedStones(pid)) stoneMismatch.push(`${pid}:${gotStones.toString()}≠报出${reportedStones(pid).toString()}`);
        const gotHonor = bucketsFor(pid).filter(d => d.type === 'honor').reduce((s, d) => s + (Number(d.count) || 0), 0);
        if (now.realm === was.realm && now.honor - was.honor !== gotHonor) honorMismatch.push(`${pid}:${now.honor - was.honor}≠${gotHonor}`);
        for (const d of bucketsFor(pid)) {
            if (d.item_key === 'spirit_stones' || !d.item_key) continue;
            const grew = (now.items.get(d.item_key) || 0) - (was.items.get(d.item_key) || 0);
            if (grew < (Number(d.count) || 0)) itemMismatch.push(`${pid}/${d.item_key}:${grew}<${d.count}`);
        }
    }
    check('X14 打完第四幕真的通关结算（决战 → cleared 且 summary 覆盖每个在场成员）',
        advanced?.success === true && String(h2instance?.instance_state) === 'cleared'
        && present.length === players.length && !!summary
        && (summary.normal_drops || []).length >= present.length,
        `state=${h2instance?.instance_state} ${walk.join(' ')}｜${advanced?.message || ''}｜报出覆盖 ${(summary?.normal_drops || []).length}/${present.length} 人`);
    check('X15 每个成员的灵石/声望/物品增量与报出逐一对得上（守恒，不许报了没给）',
        stoneMismatch.length === 0 && honorMismatch.length === 0 && itemMismatch.length === 0,
        `灵石差=${stoneMismatch.join(',') || '无'}｜声望差=${honorMismatch.join(',') || '无'}｜物品差=${itemMismatch.join(',') || '无'}`);

    const before2 = await snapOf();
    const again = await MultiDungeonService.advance(leader.id);
    const after2 = await snapOf();
    const moved = [...before2.keys()].filter(pid => after2.get(pid).stones !== before2.get(pid).stones);
    check('X16 结算过的副本再推一次不重复发钱（第二笔必须被拒且分文不动）',
        again?.success !== true && moved.length === 0,
        `再推=${again?.message || again?.success}｜又动账的人=${moved.join(',') || '无'}`);

    // X17：首通称号必须真的写进 players.titles。
    // 结算那 7 处"发称号"以前各自抄一份（读出来判重 → push → 赋回 → save），
    // 2026-09-21 收成 PlayerStateStore.addTitleToInstance 一份定义，这条钉住改完仍然真的发到手。
    const titleReported = [];
    const titleMissing = [];
    for (const fc of (summary?.first_clear || [])) {
        for (const b of (fc.bonuses || []).filter(x => x.type === 'title' && x.title_id)) {
            titleReported.push(`${fc.player_id}/${b.title_id}`);
            const owner = await Player.findByPk(Number(fc.player_id));
            const owned = Array.isArray(owner?.titles) ? owner.titles : [];
            if (!owned.includes(b.title_id)) titleMissing.push(`${fc.player_id}缺${b.title_id}`);
        }
    }
    check('X17 首通报出来的称号真的落进 players.titles（称号入口只有一份定义，也不能少发）',
        titleReported.length > 0 && titleMissing.length === 0,
        `报出 ${titleReported.length} 条（${titleReported.slice(0, 3).join(', ')}${titleReported.length > 3 ? '…' : ''}）｜没落库的=${titleMissing.join(',') || '无'}`);

    // ===== X18/X19 背包放不下那一件：不发第二遍、不静默、也不谎报 =====
    // 形状与战线里程碑那条同族：以前 `try { addItem } catch { console.warn }` 之后照旧通关结算，
    // 玩家读到的是"通关！"+ 一件永远不到的东西。现在走 grantItems：发到才进 drops，
    // 没发到进 failed，并由 collectGrantFailures/describeGrantFailures 汇进玩家那句 message。
    // 注入哪一件不能取自"上一次真掉到的那件"：那一局没钉随机数，整局不掉物品的概率不低
    // （2026-09-22 实测 normal_drops 里只剩 exp/灵石/神识，X18 因此假红、X19 连带没跑到）。
    // 改成两步：先跑一局把 Math.random 钉成 0（`if (random < chance)` 一律成立、加权表 roll=0 必取池子第一条、
    // 数量取 count_min → 这一局的掉落集合是确定的），从它拿到"这一局必然 attempt 的那件"，再拿这个键注进第二局。
    const dropKeysOf = (sum) => {
        const keys = new Set();
        for (const nd of (sum?.normal_drops || [])) {
            for (const d of (nd.drops || [])) if (d.item_key && d.item_key !== 'spirit_stones') keys.add(d.item_key);
        }
        return [...keys];
    };
    const cycleIds = players.map(p => p.id);
    const sumQty = async (key) => {
        const rows = await Item.findAll({ where: { player_id: cycleIds, item_key: key }, attributes: ['quantity'] });
        return rows.reduce((s, r) => s + Number(r.quantity), 0);
    };
    /** 开一局黄龙山、走完三档抉择、钉住随机数后推进到结算；rejectKey 非空则让那一件发放必失败 */
    const settleOneCycle = async (rejectKey, onBeforeAdvance = null) => {
        const realAddItem = InventoryService.addItem;
        const realRandom = Math.random;
        let advanced = null;
        let created = null;
        let instanceId = null;
        try {
            // 门票先补齐：`create` 会真消耗 `consume_item_key`（内容说了算），上一局把它吃掉之后
            // 这一局的建局会直接失败 —— 失败点在 X18 的 summary 里表现为"一件都没掉"，很容易被误读成掉落坏了。
            const dgCfg = require('../modules').infrastructure.ConfigLoader
                .getConfig('multi_dungeon_data')?.dungeons?.[DUNGEON];
            if (dgCfg?.consume_item_key) {
                await InventoryService.addItem(leader.id, dgCfg.consume_item_key,
                    Number(dgCfg.consume_item_count) || 1, null);
            }
            for (const p of players) await MultiDungeonService.gmResetCooldown(p.id, DUNGEON, leader.id);
            created = await MultiDungeonService.create(leader.id, DUNGEON);
            instanceId = created?.data?.instance_id ?? created?.data?.instance?.id;
            const hid = instanceId;
            for (const m of players.slice(1)) await MultiDungeonService.join(m.id, hid);
            await MultiDungeonService.enter(leader.id);
            for (const key of ['center', 'raid', 'guard_formation']) await MultiDungeonService.choose(leader.id, key);
            if (hid) await MultiDungeonService.gmAdjustVariable(hid, 'huanglong_formation_power', 9999, leader.id);
            if (rejectKey) {
                InventoryService.addItem = function (playerId, itemKey, quantity, t, ...rest) {
                    if (itemKey === rejectKey) return Promise.reject(new Error('背包容量不足（探针注入）'));
                    return realAddItem.call(InventoryService, playerId, itemKey, quantity, t, ...rest);
                };
            }
            // 基线在"门票已被 create 吃掉、结算还没跑"这一刻取，否则等式会被门票差 1 件
            if (onBeforeAdvance) await onBeforeAdvance();
            Math.random = () => 0;
            advanced = await MultiDungeonService.advance(leader.id);
        } finally {
            Math.random = realRandom;
            InventoryService.addItem = realAddItem;
        }
        return { advanced, summary: advanced?.data?.rewards, created, instanceId };
    };

    const probeCycle = await settleOneCycle(null);
    const injected = dropKeysOf(probeCycle.summary)[0];
    if (!injected) {
        check('X18 背包放不下那一件要在结算文本里点名', false,
            '把 Math.random 钉成 0 的这一局仍然一件物品都没掉，说明掉落这条路本身是断的：'
            + JSON.stringify((probeCycle.summary?.normal_drops || [])[0] || null)
            // 结算本身被拒时 summary 是空的，必须把被拒理由一起报出来，否则分不清"没掉"与"没结算"
            + `｜建局=${probeCycle.created?.success} ${probeCycle.created?.message || ''}`
            + `｜推进=${probeCycle.advanced?.success} ${probeCycle.advanced?.message || ''}`
            + `｜normal_drops 条数=${(probeCycle.summary?.normal_drops || []).length}`);
    } else {
        // 先让队长包里有一件这件：否则"数量一分没动"可能只是 0→0 的空转
        await InventoryService.addItem(leader.id, injected, 1, null);
        let wasInjectedQty = 0;
        const injectedCycle = await settleOneCycle(injected, async () => { wasInjectedQty = await sumQty(injected); });
        const advanced3 = injectedCycle.advanced;
        const summary3 = injectedCycle.summary;
        const nowInjectedQty = await sumQty(injected);
        const msg3 = advanced3?.message || '';
        const failedForInjected = (summary3?.normal_drops || [])
            .flatMap(d => d.failed || []).filter(f => f.item_key === injected);
        check('X18 背包放不下那一件：没进包、摘要里有 failed、结算文本点名（不谎报也不静默）',
            advanced3?.success === true && wasInjectedQty > 0 && nowInjectedQty === wasInjectedQty && failedForInjected.length > 0
            && /未获得/.test(msg3) && msg3.includes(itemName(injected) || '') && !msg3.includes(injected),
            `注入=${injected}（${itemName(injected)}）｜背包 ${wasInjectedQty}→${nowInjectedQty}｜摘要 failed=${failedForInjected.length} 条`
            + `（理由=${failedForInjected[0]?.reason}）｜文本尾巴=${msg3.slice(-70)}`);
        const othersDelivered = (summary3?.normal_drops || []).some(d => (d.drops || []).length > 0);
        check('X19 同一笔结算里其它物品照发到（注入那一件不连带拖垮整笔）',
            othersDelivered && String((await MultiDungeonInstance.findByPk(advanced3?.data?.instance_id))?.instance_state) === 'cleared',
            `其它条目=${(summary3?.normal_drops || []).map(d => `${d.player_id}:${(d.drops || []).length}`).join(' ')}｜state=${advanced3?.data?.instance_state}`);
    }

    return finish();
})().catch(error => {
    console.error('探针自身失败:', error);
    return cleanup().finally(() => process.exit(2));
});

async function finish() {
    await cleanup();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
}
