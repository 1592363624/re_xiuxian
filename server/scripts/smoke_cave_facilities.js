/**
 * 洞府五个写路径：升级设施 / 收取灵石 / 解锁药园 / 布置景观 / 货摊购买
 * （需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要有：这五条都同时写 players（钱包）与 player_caves（洞府行），此前有一条探针都没有。
 * 本会话把它们的取锁次序统一成 players → player_caves（口径见 game/persistence/lockOrder.js）：
 * 升级/收灵石/解锁药园原来是"先锁洞府行、再回头锁玩家行"，而"布置景观/货摊购买/开辟洞府"是另一个方向，
 * 玩家开两个面板各点一次就凑得出 ABBA。改动把玩家锁提到了事务开头、后面复用同一份实例，
 * 所以这条探针要证明**改完之后每条路的账还是对的**（扣多少、给多少、等级/地块/景观/背包都按配置落库），
 * 并且并发不再死锁。次序本身的确定性差分在 scripts/smoke_lock_order_matrix.js（players↔player_caves 那一对）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_cave_facilities.js
 * 只用自建探针号 cave_c1，跑完删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5101);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerCave = require('../models/playerCave');
const Item = require('../models/item');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { infrastructure } = require('../modules');
const CaveService = require('../game/services/CaveService');
const CaveSocialService = require('../game/services/CaveSocialService');

const ACCOUNT = 'cave_c1';
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const N = v => Number(v == null ? 0 : v);
const B = v => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };
const reasonOf = e => `${e && e.name ? e.name + ': ' : ''}${e && e.message ? e.message : String(e)}`.slice(0, 90);
const unwrap = r => (r && r.data) ? r.data : (r || {});

async function wallet(id) {
    const p = await Player.findByPk(id, { attributes: ['spirit_stones'] });
    return B(p.spirit_stones);
}
async function caveOf(id) {
    return PlayerCave.findOne({ where: { player_id: id } });
}

async function main() {
    await bootApp(app, { port: PORT });
    CaveService.initialize(infrastructure.ConfigLoader);
    if (typeof CaveSocialService.initialize === 'function') CaveSocialService.initialize(infrastructure.ConfigLoader);
    const cfg = CaveService.getCaveConfig();
    check('C0 读得到洞府配置（设施/药园/景观/货摊都在，下面所有期望值从这份算）',
        !!cfg && !!(cfg.facilities || cfg.spirit_vein) && !!cfg.garden,
        `设施=${Object.keys(cfg.facilities || {}).join('/')} 地块上限=${cfg.garden && cfg.garden.max_plots}`);
    if (!cfg) return;

    let p = await Player.findOne({ where: { username: ACCOUNT } });
    if (!p) {
        p = await Player.create({
            username: ACCOUNT, password: 'not-a-real-hash', nickname: '洞府探针',
            realm: '化神初期', realm_rank: 12, exp: 0, spirit_stones: 5000000,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    } else {
        await Player.update({ realm_rank: 12, spirit_stones: 5000000 }, { where: { id: p.id } });
    }
    await PlayerCave.destroy({ where: { player_id: p.id }, force: true });
    await Item.destroy({ where: { player_id: p.id }, force: true });

    // ===== C1 开辟洞府（players→caves 的正向那条，作为其余几条的参照） =====
    const opened = unwrap(await CaveService.openCave(p.id));
    let cave = await caveOf(p.id);
    check('C1 开府成功且洞府行落库', cave && cave.is_opened === true, `is_opened=${cave && cave.is_opened} 返回=${JSON.stringify(opened).slice(0, 60)}`);
    if (!cave) return;

    // ===== C2 升级设施：等级 +1，灵石与材料只扣配置里那一档的价 =====
    const type = CaveService.getFacilityTypes()[0];
    const facCfg = CaveService.getFacilityConfig(type);
    const levelCol = `${type}_level`;
    const beforeLevel = N(cave[levelCol]);
    const costRow = (facCfg.upgrade_costs || [])[beforeLevel] || {};
    const cost = N(costRow.spirit_stone);
    // 升级还要材料：探针背包里先备好这一档要的材料（没有材料就只能测到"材料不足"那条分支）
    if (costRow.material) {
        const InventoryService = require('../game/services/InventoryService');
        await InventoryService.addItem(p.id, costRow.material, N(costRow.material_count) + 5, null, null, { allowUnknownItem: true });
    }
    const w0 = await wallet(p.id);
    const upg = unwrap(await CaveService.upgradeFacility(p.id, type));
    cave = await caveOf(p.id);
    check('C2 升级设施：等级 +1，扣的灵石恰好等于配置该档价格',
        N(cave[levelCol]) === beforeLevel + 1 && cost > 0 && w0 - await wallet(p.id) === BigInt(cost),
        `${type} ${beforeLevel}→${cave[levelCol]} 扣 ${(w0 - await wallet(p.id)).toString()}（配置 ${cost}，材料 ${costRow.material || '无'}×${costRow.material_count || 0}）返回=${upg.success}`);

    // ===== C3 收取灵石：待领进账，第二次没有可领 =====
    await PlayerCave.update({ last_spirit_vein_collect: new Date(Date.now() - 12 * 3600 * 1000) },
        { where: { player_id: p.id } });
    const w1 = await wallet(p.id);
    const collected = unwrap(await CaveService.collectSpiritStones(p.id));
    const gained = await wallet(p.id) - w1;
    cave = await caveOf(p.id);
    check('C3 收取灵石：到账 > 0 且与报出一致，灵脉累计清零',
        gained > 0n && N(collected.collected || collected.amount || collected.spirit_stones) === Number(gained.toString()),
        `到账 ${gained.toString()} 报出 ${JSON.stringify(collected).slice(0, 90)}`);
    let again = '';
    try { await CaveService.collectSpiritStones(p.id); } catch (e) { again = reasonOf(e); }
    check('C3b 紧接着再收一次要被告知"暂无可领取"（不能反复领同一段时间）',
        /暂无可领取/.test(again), `理由=${again || '（没拒）'}`);

    // ===== C4 解锁药园地块：数量 +1，价格照配置 =====
    const garden = cfg.garden || {};
    const plots = N(cave.garden_plots);
    const plotCost = N((garden.plot_unlock_costs || []).find(x => N(x.plot_index) === plots + 1) &&
        (garden.plot_unlock_costs || []).find(x => N(x.plot_index) === plots + 1).spirit_stone);
    const w2 = await wallet(p.id);
    if (plotCost > 0) {
        await CaveService.unlockGardenPlot(p.id);
        cave = await caveOf(p.id);
        check('C4 解锁药园：地块 +1，扣的灵石等于配置该块价格',
            N(cave.garden_plots) === plots + 1 && w2 - await wallet(p.id) === BigInt(plotCost),
            `地块 ${plots}→${cave.garden_plots} 扣 ${(w2 - await wallet(p.id)).toString()}（配置 ${plotCost}）`);
    } else {
        check('C4 解锁药园：地块 +1，扣的灵石等于配置该块价格', false, `配置里查不到第 ${plots + 1} 块的价格，这条没测到`);
    }

    // ===== C5 布置景观：境界够能布、境界不够必须被挡住（这条走的是改过的 setLandscape） =====
    const PLAYER_RANK = 12;
    const landscapes = CaveSocialService.getLandscapesConfig() || [];
    check('C5a 内容里有景观配置（下面两条的期望值从这份算，不写死）', landscapes.length > 0,
        `条数=${landscapes.length} 需求境界=${landscapes.map(l => l.required_realm_rank).join('/')}`);
    const canBuy = landscapes.filter(l => N(l.required_realm_rank) <= PLAYER_RANK)
        .sort((a, b) => N(a.cost) - N(b.cost))[0];
    if (canBuy) {
        const wl = await wallet(p.id);
        const setRes = unwrap(await CaveSocialService.setLandscape(p.id, canBuy.id));
        cave = await caveOf(p.id);
        check('C5 布置景观（境界达标）：落库到洞府行，扣的灵石等于配置造价',
            String(cave.landscape_id) === String(canBuy.id)
            && wl - await wallet(p.id) === BigInt(N(canBuy.cost))
            && N(setRes.cost) === N(canBuy.cost),
            `landscape_id=${cave.landscape_id} 扣 ${(wl - await wallet(p.id)).toString()}（造价 ${canBuy.cost}）需求境界=${canBuy.required_realm_rank}`);
    } else {
        check('C5 布置景观（境界达标）：落库到洞府行，扣的灵石等于配置造价', false, `没有需求境界 ≤${PLAYER_RANK} 的景观，这条没测到`);
    }
    // 内容里最难的景观只要求 9 层，低于探针号的 12 层 —— 不临时压境界，拒判分支会静默跳过（等于没测）。
    const highest = landscapes.slice().sort((a, b) => N(b.required_realm_rank) - N(a.required_realm_rank))[0];
    if (highest && canBuy && highest.id !== canBuy.id) {
        await Player.update({ realm_rank: N(highest.required_realm_rank) - 1 }, { where: { id: p.id } });
        const wr = await wallet(p.id);
        const before = (await caveOf(p.id)).landscape_id;
        let denied = '';
        try { await CaveSocialService.setLandscape(p.id, highest.id); } catch (e) { denied = reasonOf(e); }
        await Player.update({ realm_rank: PLAYER_RANK }, { where: { id: p.id } });
        check('C5b 境界不够时布置景观被拒、点名所需境界、灵石与景观都不许动（改锁序时没把这道判定挪丢）',
            /境界/.test(denied) && wr === await wallet(p.id)
            && String((await caveOf(p.id)).landscape_id) === String(before),
            `理由=${denied || '（没拒）'} 需求=${highest.required_realm_rank}`);
    } else {
        check('C5b 境界不够时布置景观被拒、点名所需境界、灵石与景观都不许动（改锁序时没把这道判定挪丢）', false,
            '景观不足两条，压不出"境界不够"这一支');
    }

    // ===== C6 货摊购买：按报价扣灵石、物品进背包 =====
    const goodsWrap = unwrap(await CaveSocialService.getMerchantGoods(p.id));
    const goods = goodsWrap.items || [];
    check('C6 货摊能列出本批货品（否则下面那条是空跑）', goods.length > 0,
        `件数=${goods.length} 批次=${goodsWrap.refresh_batch} 限量=${goods[0] && goods[0].max_buy}`);
    // 报价与扣款共用同一个种子（玩家ID + 刷新时间）：连查两次必须一模一样，
    // 否则玩家看到的价和实际被扣的价可以不是同一件东西。
    const goodsAgain = unwrap(await CaveSocialService.getMerchantGoods(p.id)).items || [];
    check('C6a 同批次重复查看货品不变（种子确定性；报价即扣价的前提）',
        goodsAgain.map(g => `${g.item_key}@${g.price}`).join(',') === goods.map(g => `${g.item_key}@${g.price}`).join(','),
        `两次列表=${goodsAgain.map(g => g.item_key).join('/')} vs ${goods.map(g => g.item_key).join('/')}`);
    if (goods.length > 0) {
        const good = goods[0];
        const w3 = await wallet(p.id);
        const before = N((await Item.findOne({ where: { player_id: p.id, item_key: good.item_key }, raw: true }))?.quantity);
        await CaveSocialService.buyMerchantItem(p.id, 1, 1);
        const after = N((await Item.findOne({ where: { player_id: p.id, item_key: good.item_key }, raw: true }))?.quantity);
        const paid = w3 - await wallet(p.id);
        check('C6b 买一件货：扣的灵石 = 报价，背包里那件 +1（玩家锁提前后仍然对得上）',
            paid === BigInt(N(good.price)) && after - before === 1,
            `扣 ${paid.toString()}（报价 ${good.price}）背包 ${before}→${after} 物品=${good.item_key}`);
    } else {
        check('C6b 买一件货：扣的灵石 = 报价，背包里那件 +1（玩家锁提前后仍然对得上）', false, '没货品可买');
    }

    // ===== C7 并发：收灵石 + 升级设施同时点（两边都要 players 与洞府行） =====
    await PlayerCave.update({ last_spirit_vein_collect: new Date(Date.now() - 12 * 3600 * 1000) },
        { where: { player_id: p.id } });
    if (costRow.material) {
        const InventoryService = require('../game/services/InventoryService');
        const need = N((CaveService.getFacilityConfig(type).upgrade_costs || [])[N((await caveOf(p.id))[levelCol])].material_count) || N(costRow.material_count);
        await InventoryService.addItem(p.id, costRow.material, need + 5, null, null, { allowUnknownItem: true });
    }
    const w4 = await wallet(p.id);
    const levelBefore = N((await caveOf(p.id))[levelCol]);
    const raced = await Promise.all([
        CaveService.collectSpiritStones(p.id).then(r => `收:${r ? 'ok' : 'null'}`).catch(e => `收[${reasonOf(e)}]`),
        CaveService.upgradeFacility(p.id, type).then(r => `升:${r ? 'ok' : 'null'}`).catch(e => `升[${reasonOf(e)}]`)
    ]);
    const finalCave = await caveOf(p.id);
    check('C7 并发"收灵石 + 升级设施"：谁都不许以死锁收场，且各只生效一次',
        !raced.some(x => /Deadlock|lock wait timeout/i.test(x))
        && N(finalCave[levelCol]) === levelBefore + (raced[1].startsWith('升:ok') ? 1 : 0)
        && await wallet(p.id) !== w4,
        `${raced.join(' ;; ')}｜等级 ${levelBefore}→${finalCave[levelCol]}`);
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
                await PlayerCave.destroy({ where: { player_id: p.id }, force: true });
                await Item.destroy({ where: { player_id: p.id }, force: true });
                await Player.destroy({ where: { id: p.id }, force: true });
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
