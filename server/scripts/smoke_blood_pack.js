/**
 * 资料片「魔道血修遗篇」的活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 与 jest 那份 MoDaoBloodPack 的分工：jest 证明内容层/引擎/公式三段接得上，
 * 这条探针证明**发出去的那套内容**在真实装配 + 真实数据库上端到端能用：
 * 玩家穿上化血刀 → 吃血煞丹 → 抓到血蝠 → 面板上「血元」这一格是三个来源之和，
 * 中间过的是 MySQL 的 attributes JSON 列与 spirit_beasts.stat_block JSON 列（migration_0088），
 * 最后由战斗档位 player_blood_power 结算出伤害。全程没有为血元写过一行服务代码。
 *
 * 还有一条是 jest 量不出来的：新物品必须能真的进背包（储物袋满时 grantItems 会静默失败，
 * 那是本轮另一条探针踩过的坑），所以每一笔发放都回读库存，不信任调用返回的"成功"。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_blood_pack.js
 *       探针自建账号 bloodprobe01，退出前删号（连同灵兽、背包、装备行）；不改仓库里任何 pack。
 */
'use strict';

const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5097);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    const { contentRegistry } = require('../game/content');
    const content = contentRegistry();
    const packs = (content && content.status().packs) || [];
    const blood = packs.find(p => p.id === 'mo_da_blood_sutra');
    check('B1 真实 packs 目录里装配到了这一片（不是测试夹具）',
        !!blood && blood.enabled !== false,
        `已装配：${packs.map(p => `${p.id}@${p.priority}`).join(', ')}`);

    await require('../game').initializeGameServices(infrastructure.ConfigLoader);
    const { statRegistry } = require('../game/stats');
    const Player = require('../models/player');
    const SpiritBeast = require('../models/spiritBeast');
    const InventoryService = require('../game/services/InventoryService');
    const EquipmentService = require('../game/services/EquipmentService');
    const AttributeService = require('../game/core/AttributeService');
    const SpiritBeastService = require('../game/services/SpiritBeastService');
    const TechniqueService = require('../game/services/TechniqueService');
    const combatResolver = require('../game/combat/CombatResolver');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    const STAT = 'blood_power';
    const def = statRegistry.resolveStatKey(STAT);
    check('B2 词表与面板 schema 都认得血元（客户端不用改代码就能显示这一格）',
        !!def && def.pill === true && statRegistry.panelStats().some(s => s.key === STAT),
        `label=${def?.label} unit=${def?.unit} pill=${def?.pill} powerWeight=${def?.powerWeight} bonusKey=${def?.bonusKey}`);

    // 境界必须用 realm_breakthrough 里的真名号，且要够穿上化血刀（required_realm_rank 17）
    const realmNames = new Set(((infrastructure.ConfigLoader.getConfig('realm_breakthrough') || {}).realms || [])
        .map(r => r.name));
    const blade = infrastructure.ConfigLoader.getConfig('item_data').items.find(i => i.id === 'huaxue_ci');
    const PROBE_REALM = '金丹后期';
    check('B3 探针境界是真的存在、且够穿上这件新法宝（写错境界名会静默按 default 兜底，量到的正常是假的）',
        realmNames.has(PROBE_REALM) && 17 >= (blade?.required_realm_rank || 0),
        `realm='${PROBE_REALM}' 存在=${realmNames.has(PROBE_REALM)} 化血刀要求 rank=${blade?.required_realm_rank}`);

    // 开头按账号名清历次残留（不是按 id）：上一轮崩在收尾之前留下的灵兽/配方/装备/背包行，
    // 新 id 永远找不回来，而 B6/B18 那几条对账读的正是这些行。
    await PlayerCascadePurge.deleteByUsernames(['bloodprobe01']);
    const player = await Player.create({
        username: 'bloodprobe01', password: 'not-a-real-hash', nickname: '血修探针',
        realm: PROBE_REALM, realm_rank: 17, exp: 0, spirit_stones: 200000,
        hp_current: 9000, mp_current: 2000, lifespan_current: 1, lifespan_max: 500,
        attributes: {}, token_version: 0
    });

    // —— 第一条腿：装备 ——
    await InventoryService.addItem(player.id, 'huaxue_ci', 1, null);
    check('B4 化血刀真的进了背包（新物品 id 能落库，不是拼错键）',
        await InventoryService.hasItem(player.id, 'huaxue_ci', 1), 'hasItem(huaxue_ci)');
    const equipped = await EquipmentService.equip(player.id, 'huaxue_ci');
    const afterBlade = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('B5 穿上新法宝：血元与吸血都进最终属性',
        equipped?.success !== false && Number(afterBlade.final[STAT]) === blade.effect[STAT]
        && Number(afterBlade.final.lifesteal) === blade.effect.lifesteal,
        `equip=${JSON.stringify(equipped?.message || equipped?.success || '')} 血元=${afterBlade.final[STAT]}/期望${blade.effect[STAT]} 吸血=${afterBlade.final.lifesteal}/期望${blade.effect.lifesteal}`);

    // —— 第二条腿：丹药（走属性白名单，写进 players.attributes 这个 JSON 列）——
    const pill = infrastructure.ConfigLoader.getConfig('item_data').items.find(i => i.id === 'xuesha_dan');
    await InventoryService.addItem(player.id, 'xuesha_dan', 1, null);
    const used = await InventoryService.useItem(player.id, 'xuesha_dan', 1);
    const rowAfterPill = await Player.findByPk(player.id);
    const storedBonus = Number(rowAfterPill?.attributes?.[def.bonusKey] || 0);
    const afterPill = await AttributeService.calculateFullAttributesAsync(rowAfterPill);
    check('B6 血煞丹的加成真的写进了 players.attributes（丹药白名单认这一档，且过了一遍 MySQL 的 JSON 列）',
        used?.success !== false && storedBonus === pill.effect[STAT],
        `useItem=${JSON.stringify(used?.message || used?.success || '')} attributes.${def.bonusKey}=${storedBonus} 期望=${pill.effect[STAT]}（库里整个 attributes=${JSON.stringify(rowAfterPill?.attributes)}）`);
    check('B7 吃掉丹药后面板上的血元抬起来了（不是只写在库里没进算式）',
        Number(afterPill.final[STAT]) === Number(afterBlade.final[STAT]) + pill.effect[STAT],
        `面板=${afterPill.final[STAT]}，上一步=${afterBlade.final[STAT]} + 丹药 ${pill.effect[STAT]}`);

    // —— 第三条腿：灵兽（本轮新通的"没有专属列的属性"）——
    const beastType = (infrastructure.ConfigLoader.getConfig('spirit_beast_data').beast_types || [])
        .find(b => b.beast_key === 'xue_fu');
    check('B8 内容里的血蝠声明了一档 spirit_beasts 表上没有列的属性',
        !!beastType && beastType[`base_${STAT}`] > 0 && SpiritBeast.rawAttributes[STAT] === undefined,
        `base_${STAT}=${beastType?.[`base_${STAT}`]}，表上的列=${Object.keys(SpiritBeast.rawAttributes).filter(k => k.includes('blood')).join(',') || '(无)'}`);

    await SpiritBeast.destroy({ where: { player_id: player.id } });
    const beast = await SpiritBeast.create({
        player_id: player.id, beast_key: 'xue_fu', beast_name: '探针血蝠', element: beastType.element,
        rarity: beastType.rarity, star_level: 3, level: 10, exp: 0, loyalty: 50,
        hp_max: 1000, atk: 100, def: 50, speed: 20, is_active: true
    });
    const computed = SpiritBeastService.computeStats(beastType, 10, 3);
    SpiritBeastService.applyComputedStats(beast, computed);
    await beast.save();
    const storedBeast = await SpiritBeast.findByPk(beast.id);
    const expectedBeastStat = computed.stat_block?.[STAT];
    check('B9 这一档真的落进了 spirit_beasts.stat_block（MySQL 的 JSON 列，读回来还在）',
        expectedBeastStat > 0 && Number(storedBeast?.stat_block?.[STAT]) === expectedBeastStat,
        `期望 ${expectedBeastStat}，库里 stat_block=${JSON.stringify(storedBeast?.stat_block)}，老属性=${[storedBeast?.hp_max, storedBeast?.atk, storedBeast?.def, storedBeast?.speed].join('/')}`);

    const beastBonus = await SpiritBeastService.getActiveBeastBonus(player.id);
    const bonusCfg = infrastructure.ConfigLoader.getConfig('spirit_beast_data').settings.combat_bonus;
    const rate = bonusCfg.base_rate + 3 * bonusCfg.star_rate + 10 * bonusCfg.level_rate;
    check('B10 出战灵兽把它折算给玩家（系数按服务那份配置现算，不写死）',
        Number(beastBonus?.[STAT]) === Math.floor(expectedBeastStat * Math.min(rate, bonusCfg.max_rate)),
        `折算=${beastBonus?.[STAT]}，灵兽行上=${expectedBeastStat}×${rate}（上限 ${bonusCfg.max_rate}）`);

    const panel = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    const expectedTotal = blade.effect[STAT] + pill.effect[STAT] + Number(beastBonus[STAT]);
    check('B11 面板上的血元 == 三个来源之和（法宝/丹药/灵兽，缺一处就算丢账）',
        Number(panel.final[STAT]) === expectedTotal,
        `面板=${panel.final[STAT]}，期望=${blade.effect[STAT]}(装备)+${pill.effect[STAT]}(丹药)+${beastBonus[STAT]}(灵兽)=${expectedTotal}；分项=${JSON.stringify(panel.breakdown?.equipment?.[STAT] ?? null)}/${JSON.stringify(panel.breakdown?.spirit_beast?.[STAT] ?? null)}`);

    // B11b：灵兽战力也要看得见这一档。权重住在 spirit_beast_data.settings.combat_power_weight，
    // 而 settings 是这一轮才登记成 map 集合的 —— 在此之前资料片加得了属性、加不了权重（链路最后一步不通）。
    // 口径按服务本尊来：战力 = floor(Σ 值×权重 × (1 + (星级-1)×0.1))，星级那一乘子不能漏
    // （第一版就漏了，342×0.8=274 对不上实际的 328 —— 差的那一档正是 1.2 倍星级）。
    const powerWeights = infrastructure.ConfigLoader.getConfig('spirit_beast_data').settings.combat_power_weight;
    const plainBeast = typeof beast.toJSON === 'function' ? beast.toJSON() : beast;
    const beastBlock = plainBeast[SpiritBeastService.STAT_BLOB_COLUMN] || {};
    const strippedBlock = { ...beastBlock };
    delete strippedBlock[STAT];
    const starBonus = 1 + (Number(plainBeast.star_level) - 1) * 0.1;
    const powerWithStat = SpiritBeastService.calculateCombatPower(plainBeast);
    const powerWithout = SpiritBeastService.calculateCombatPower(
        { ...plainBeast, [SpiritBeastService.STAT_BLOB_COLUMN]: strippedBlock });
    const weight = Number(powerWeights[STAT]);
    const expectedDelta = Math.floor(expectedBeastStat * weight * starBonus);
    check('B11b 灵兽战力按内容权重把这一档算进去了（权重表现在能被资料片扩展）',
        weight > 0 && Math.abs((powerWithStat - powerWithout) - expectedDelta) <= 1,
        `权重=${weight}（来自内容），血元=${expectedBeastStat}，星级倍率=${starBonus}，`
        + `战力 ${powerWithout} → ${powerWithStat}（差 ${powerWithStat - powerWithout}，按公式期望 ${expectedDelta}）`);

    const combat = await combatResolver.resolveCombatStats(await Player.findByPk(player.id));
    check('B12 战斗属性解析带同一档（面板与战斗同源，不是另一套数）',        Number(combat.stats[STAT]) === Number(panel.final[STAT]),
        `resolveCombatStats().stats.${STAT}=${combat.stats[STAT]} 面板=${panel.final[STAT]}`);

    const dmg = combatResolver.computeDamage('player_blood_power', {
        attackerStats: { [STAT]: Number(panel.final[STAT]), lifesteal: Number(panel.final.lifesteal) },
        defenderStats: { def: 0 }, random: 0.5, roll: () => 0
    });
    check('B13 新档位用玩家真面板上的血元结算出伤害，且吸血真的回血',
        dmg.attack === Number(panel.final[STAT]) && dmg.damage > 0 && dmg.lifesteal > 0,
        `attack(取的是血元)=${dmg.attack} 伤害=${dmg.damage} 吸血=${dmg.lifesteal}(${(dmg.lifesteal_rate * 100).toFixed(2)}%)`);
    const doubled = combatResolver.computeDamage('player_blood_power', {
        attackerStats: { [STAT]: Number(panel.final[STAT]) * 2 }, defenderStats: { def: 0 },
        random: 0.5, roll: () => 0.9999
    });
    check('B14 血元在驱动公式（翻倍→伤害明显变大，不是被 min_damage 兜底）',
        doubled.damage > dmg.damage * 1.5,
        `${dmg.damage} → ${doubled.damage}`);

    // —— 神通与功法：靠既有领悟机制被发现，而不是新代码 ——
    const skillCfg = infrastructure.ConfigLoader.getConfig('technique_data');
    const technique = skillCfg.techniques.xue_ying_shen_gong;
    const pool = Object.keys(skillCfg.skills || {}).filter(id => {
        if (id.startsWith('_')) return false;
        const s = skillCfg.skills[id];
        return s.element === technique.element || s.element === 'none';
    });
    check('B15 本片的两门神通落在既有领悟候选池里（TechniqueService 那条判定式，没有新分支）',
        skillCfg.comprehension?.enabled === true && pool.includes('xue_ya_shi') && pool.includes('xue_he_bao'),
        `候选池=${pool.join(',')}（本片功法 element=${technique.element}），领悟开关=${skillCfg.comprehension?.enabled}`);
    const learnBranches = ['shop', 'sect', 'secret_realm', 'default'];
    const cfgReadable = !!TechniqueService.getTechniqueConfig('xue_ying_shen_gong');
    check('B16 功法只写代码真认识的获取分支（避免"配了残卷其实学不会"那一类死内容）',
        learnBranches.includes(technique?.acquire?.source) && technique.acquire.source !== 'recipe_scroll' && cfgReadable,
        `acquire=${JSON.stringify(technique?.acquire)}，服务能读到这条功法=${cfgReadable}`);

    // —— 掉落：表挂在真会刷的怪上，且三件新物品都能真进背包 ——
    const maps = infrastructure.ConfigLoader.getConfig('map_data').maps;
    const spawnable = new Set();
    for (const map of Object.values(maps)) {
        for (const m of (map.monsters || [])) spawnable.add(typeof m === 'string' ? m : m.id);
    }
    const demonTable = infrastructure.ConfigLoader.getConfig('drop_data').drops.find(d => d.monster_id === 'demon');
    const mine = ['huaxue_ci', 'xue_sui_zhu', 'xuesha_dan_fang'];
    check('B17 掉落表挂在地图上真会刷的怪身上，且只往基础那六条后面加自己的三条',
        spawnable.has('demon') && mine.every(k => demonTable.drops.some(d => d.item_id === k))
        && demonTable.drops.length === 9,
        `妖魔会刷=${spawnable.has('demon')}，表上 ${demonTable.drops.length} 条：${demonTable.drops.map(d => d.item_id).join(',')}`);

    await InventoryService.addItem(player.id, 'xuesha_dan_fang', 1, null);
    const learned = await require('../game/services/CraftingService').learnRecipe(player.id, 'xuesha_dan_fang');
    const hasRecipe = await require('../models/playerRecipe').findOne({ where: { player_id: player.id, recipe_id: 'craft_xuesha_dan' } });
    check('B18 丹方用掉之后真的学会那张配方（scroll→learn_recipe→配方 id 这条链在活体上闭合）',
        learned?.success !== false && !!hasRecipe,
        `learnRecipe=${JSON.stringify(learned?.message || learned?.success || '')}，player_recipes 有记录=${!!hasRecipe}`);

    // 清理只删自己那一个号，不碰别人的账号：灵兽 / 配方 / 装备行 / 背包行都是按 player_id
    // 归属的派生行，一次 deletePlayer 全带走 —— 探针不再手写收尾表清单（新增一张带 player_id
    // 的表不用回来补一行，那正是隔离库攒出孤儿行的方式）。
    const purged = await PlayerCascadePurge.deletePlayer(Number(player.id));
    console.log(`清理：删掉探针号 ${purged.username}（id ${purged.player_id}），级联带走 ${purged.total} 行派生数据`
        + `，涉及 ${purged.tables.length} 张表`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项断言通过，失败 ${failed.length} 项`);
    await require('../config/database').close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try { await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['bloodprobe01']); } catch {}
    process.exit(1);
});
