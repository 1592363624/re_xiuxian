/**
 * 「功法残卷」这条获取通道的活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 为什么要有：以前 TechniqueService.learnTechnique 只处理 shop / sect 两条会扣代价的分支，
 * 资料片写的 acquire.source:"recipe_scroll" 一律落到"什么都不扣"（境界够就白送），
 * 而那张残卷物品又只有 CraftingService 那条 learn_recipe 通道读得到（指到功法 id 就报"配方配置不存在"）。
 * 本轮把分支实现出来，并给现网三处死内容接上正确的键（凡人遗宝 / 乱星海市舶各一部功法，
 * 另把乱星图残卷与星辰符谱拆成两卷）。这条探针验的是**通道在活体上真能用、且不会被白嫖**：
 *   T1-T3 列表里的代价提示与"够不够"是服务端算的（前端不再猜键名）；
 *   T4 两卷只够学一次 —— 同时点两下必须只成功一次、只消耗一卷（并发腿要打印被拒理由）；
 *   T5 第二个资料片的第二部功法走同一分支，证明不是为某一片特制的；
 *   T6 已经会了的功法不许再吞一卷（被拒时残卷必须原样留在背包里）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_technique_scroll.js
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5096);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function countTechnique(playerId) {
    const PlayerTechnique = require('../models/playerTechnique');
    return PlayerTechnique.count({ where: { player_id: playerId } });
}
async function qtyOf(playerId, key) {
    const Item = require('../models/item');
    const rows = await Item.findAll({ where: { player_id: playerId, item_key: key } });
    return rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
}

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const Player = require('../models/player');
    const InventoryService = require('../game/services/InventoryService');
    const TechniqueService = require('../game/services/TechniqueService');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    const realmNames = new Set(((infrastructure.ConfigLoader.getConfig('realm_breakthrough') || {}).realms || [])
        .map(r => r.name));
    check('T0 探针要用的两个境界名在内容里真的存在（境界名写错会让"境界不足"这一半永远测不到）',
        realmNames.has('筑基中期') && realmNames.has('元婴初期'), `筑基中期=${realmNames.has('筑基中期')} 元婴初期=${realmNames.has('元婴初期')}`);

    // 开头按账号名清历次残留（不是按 id）：崩过一次的那轮留下的功法/背包行，新 id 永远找不回来
    await PlayerCascadePurge.deleteByUsernames(['scrollprobe01']);
    const player = await Player.create({
        username: 'scrollprobe01', password: 'not-a-real-hash', nickname: '残卷探针',
        realm: '筑基中期', realm_rank: 12, exp: 0, spirit_stones: 500000,
        hp_current: 6000, mp_current: 1500, lifespan_current: 1, lifespan_max: 300,
        attributes: {}, token_version: 0
    });

    const findIn = (list, id) => list.find(t => t.technique_id === id);
    const listed = async () => (await TechniqueService.getPlayerTechniques(player.id))?.available || [];

    // —— T1/T2：没卷的时候不许点，点了要给出理由，且不能白学 ——
    let view = await listed();
    const xingdun = findIn(view, 'xingdun_jue');
    check('T1 列表把"代价凑不凑得齐"算好下发（前端不再自己猜键名）',
        !!xingdun && xingdun.acquire?.source === 'recipe_scroll' && xingdun.acquire_ready === false
        && String(xingdun.acquire_hint || '').includes('乱星图残卷'),
        `acquire=${JSON.stringify(xingdun?.acquire)} ready=${xingdun?.acquire_ready} hint=${xingdun?.acquire_hint}`);

    const denied = await TechniqueService.learnTechnique(player.id, 'xingdun_jue')
        .then(r => ({ ok: true, r })).catch(e => ({ ok: false, msg: e.message }));
    check('T2 手里没卷时研习被拒，且理由说清了缺哪一卷',
        denied.ok === false && /乱星图残卷/.test(denied.msg || ''),
        `结果=${denied.ok ? `竟然成功：${JSON.stringify(denied.r)}` : denied.msg}`);
    check('T2b 被拒之后没有凭空多出一部功法', (await countTechnique(player.id)) === 0,
        `player_techniques 行数=${await countTechnique(player.id)}`);

    // —— T3：发了卷，列表要说"够" ——
    await InventoryService.addItem(player.id, 'luanxing_tu_can', 1, null);
    check('T3a 残卷真的进了背包（新物品 id 落库，不是拼错键）', (await qtyOf(player.id, 'luanxing_tu_can')) === 1,
        `数量=${await qtyOf(player.id, 'luanxing_tu_can')}`);
    view = await listed();
    check('T3b 有卷之后服务端说"代价够了"', findIn(view, 'xingdun_jue')?.acquire_ready === true,
        `ready=${findIn(view, 'xingdun_jue')?.acquire_ready}`);

    // —— T4：同一瞬间点两下，只该成功一次、只该吞一卷 ——
    const legs = await Promise.all([
        TechniqueService.learnTechnique(player.id, 'xingdun_jue').then(r => ({ ok: true, why: r?.message || 'success' }))
            .catch(e => ({ ok: false, why: e.message })),
        TechniqueService.learnTechnique(player.id, 'xingdun_jue').then(r => ({ ok: true, why: r?.message || 'success' }))
            .catch(e => ({ ok: false, why: e.message }))
    ]);
    const wins = legs.filter(l => l.ok).length;
    check('T4 只有一卷时并发研习只成一次（另一条腿被拒且理由可查，残卷没被吞两次）',
        wins === 1 && (await countTechnique(player.id)) === 1 && (await qtyOf(player.id, 'luanxing_tu_can')) === 0,
        `两条腿=${legs.map(l => `${l.ok ? '成' : '拒'}:${l.why}`).join('｜')}，功法行数=${await countTechnique(player.id)}，剩余残卷=${await qtyOf(player.id, 'luanxing_tu_can')}`);

    // —— T5：第二个资料片的第二部功法走同一分支 ——
    const Player_ = await Player.findByPk(player.id);
    await Player_.update({ realm: '元婴初期', realm_rank: 19 });
    await InventoryService.addItem(player.id, 'fanren_dao_can', 1, null);
    const fanrenLeg = await TechniqueService.learnTechnique(player.id, 'hunyun_jianyi_jue')
        .then(r => ({ ok: true, why: r?.message || 'success' })).catch(e => ({ ok: false, why: e.message }));
    check('T5 凡人遗宝那部残卷功法也用同一分支学成并消耗掉卷轴（不是为某一片特制）',
        fanrenLeg.ok && (await countTechnique(player.id)) === 2 && (await qtyOf(player.id, 'fanren_dao_can')) === 0,
        `结果=${fanrenLeg.why}，功法行数=${await countTechnique(player.id)}，剩余残卷=${await qtyOf(player.id, 'fanren_dao_can')}`);

    // —— T6：已经会了的功法不许再吞一卷 ——
    await InventoryService.addItem(player.id, 'fanren_dao_can', 1, null);
    const repeat = await TechniqueService.learnTechnique(player.id, 'hunyun_jianyi_jue')
        .then(r => ({ ok: true, why: r?.message || 'success' })).catch(e => ({ ok: false, why: e.message }));
    check('T6 重复习研被拒，且这一卷原样留在背包里（被拒不能白吞材料）',
        repeat.ok === false && (await qtyOf(player.id, 'fanren_dao_can')) === 1,
        `结果=${repeat.ok ? `竟然成功：${repeat.why}` : repeat.why}，背包里的残卷=${await qtyOf(player.id, 'fanren_dao_can')}`);

    // —— T7：sect_treasury 这类没人处理的来源，启动期就该拦（这里复核闸还在）——
    const { ContentRegistry } = require('../game/content/ContentRegistry');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-acquire-'));
    try {
        fs.cpSync(path.join(__dirname, '..', 'config'), path.join(root, 'config'), { recursive: true });
        const packs = path.join(root, 'packs', 'bad_pack');
        fs.mkdirSync(packs, { recursive: true });
        fs.writeFileSync(path.join(packs, 'pack.json'), JSON.stringify({ id: 'bad_pack', name: '夹具', version: '1.0.0' }));
        fs.writeFileSync(path.join(packs, 'technique_data.json'), JSON.stringify({
            dataset: 'technique_data', into: 'techniques',
            add: [{ id: 'probe_freebie', name: '白送功', grade: 'huang', element: 'none', required_realm: '炼气1层', acquire: { source: 'sect_treasury' } }]
        }));
        let threw = null;
        try {
            new ContentRegistry({ configPath: path.join(root, 'config'), packDir: path.join(root, 'packs') }).load();
        } catch (e) { threw = e; }
        check('T7 控制跑：有人再写没人处理的 acquire.source，启动期当场拦（闸不是空跑）',
            !!threw && /sect_treasury/.test(threw.message) && /没有任何代码处理/.test(threw.message),
            threw ? `抛了：${threw.message.split('\n').slice(0, 2).join(' / ').slice(0, 160)}` : '竟然没抛 —— 这道闸是空跑');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    // 收尾只叫一次"删号"：player_techniques / player_items 这些按 player_id 归属的行由级联带走
    const purged = await PlayerCascadePurge.deletePlayers([player.id]);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项断言通过，失败 ${failed.length} 项`);
    await require('../config/database').close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try { await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['scrollprobe01']); } catch {}
    process.exit(1);
});
