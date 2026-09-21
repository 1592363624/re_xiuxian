/**
 * 内容下架 / 资料片关闭后的玩家资产探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要单独一个：DLC 模式意味着"某个物品有一天可能不在了"（关掉 pack、或 remove 掉它）。
 * 玩家身上的行不会跟着消失，于是所有"把东西还给玩家"的路径都必须继续能还：
 *   InventoryService.addItem 以前对找不到的配置一律抛错，
 *   而卸下装备内部就是调 addItem —— 也就是说装备一旦被下架，玩家就**永远卸不下来**，
 *   槽位里的东西既不给属性也不回背包（拍卖退还、典当赎回、遗府归还原主、以物换物同理）。
 * 这里造一件配置里不存在的装备，把这几条路走一遍。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_removed_content.js
 * 探针自建/复用玩家 removetest01，只动它自己的行，并在结束时的清理里删掉自己造的数据。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5092);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const Item = require('../models/item');
const PlayerEquipment = require('../models/playerEquipment');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const InventoryService = require('../game/services/InventoryService');
const EquipmentService = require('../game/services/EquipmentService');
const CombatResolver = require('../game/combat/CombatResolver');

const GHOST = 'removed_content_probe_sword';
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function ensurePlayer() {
    let player = await Player.findOne({ where: { username: 'removetest01' } });
    if (!player) {
        player = await Player.create({
            username: 'removetest01',
            password: 'not-a-real-hash',
            nickname: '下架探针',
            realm: '筑基初期',
            realm_rank: 11,
            exp: 0,
            spirit_stones: 10000,
            hp_current: 5000,
            mp_current: 5000,
            lifespan_current: 120,
            attributes: {},
            token_version: 0
        });
    }
    // 每次都从干净状态开始：清掉上一轮可能留下的装备行与背包行
    await PlayerEquipment.destroy({ where: { player_id: player.id } });
    await Item.destroy({ where: { player_id: player.id, item_key: GHOST } });
    player.is_dead = false;
    await player.save();
    return player;
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await ensurePlayer();

    // ===== 前提：这件"装备"在当前内容里真的不存在，否则整场探针什么都没测到 =====
    check('R0 探针用的 item_key 确实不在当前内容里（否则后面的断言都是空的）',
        InventoryService.getItemConfig(GHOST) === null && EquipmentService.getItemConfig(GHOST) === null,
        `getItemConfig(${GHOST})=${JSON.stringify(InventoryService.getItemConfig(GHOST))}`);

    // 直接造一行装备记录：正常装备流程 require 配置存在，走不通，正好模拟"以前能装、现在配置没了"
    await PlayerEquipment.create({
        player_id: player.id, slot: 'weapon', item_key: GHOST,
        equipped_at: new Date(), durability: 100, max_durability: 100,
        refine_level: 0, is_benming: false, spirit_power: 0, sort_order: 0
    });

    // ===== R1 属性计算不能被一件不存在的装备炸掉，也不能凭空给它加成 =====
    let bonus = null;
    let bonusErr = '无';
    try {
        bonus = await EquipmentService.getEquipmentBonus(player.id);
    } catch (error) {
        bonusErr = error.message;
    }
    check('R1 下架装备仍穿在身上时，装备加成计算不抛错（表现是没属性，不是整条属性链炸）',
        bonus !== null, `bonus=${JSON.stringify(bonus || null)} err=${bonusErr}`);

    // ===== R2 卸下：把玩家自己的东西还回背包，绝不能因为配置没了就失败 =====
    let unequipOk = false;
    let unequipDetail = '';
    try {
        const res = await EquipmentService.unequip(player.id, 'weapon');
        const back = await Item.findOne({ where: { player_id: player.id, item_key: GHOST } });
        const stillWorn = await PlayerEquipment.count({ where: { player_id: player.id, slot: 'weapon' } });
        unequipOk = !!res && !!back && Number(back.quantity) === 1 && stillWorn === 0;
        unequipDetail = `背包行=${back ? `qty ${back.quantity}` : '无'}, 槽位残留=${stillWorn}`;
    } catch (error) {
        unequipDetail = `抛错: ${error.message}`;
    }
    check('R2 配置已消失的装备照样能卸回背包（改造前这里抛"物品配置不存在"，装备永久卡死）',
        unequipOk, unequipDetail);

    // ===== R3 背包列表把它如实显示成未知物品，而不是悄悄把行抹掉 =====
    const inventory = await InventoryService.getInventory(player.id);
    const listed = (inventory?.items || []).find(i => i.item_key === GHOST);
    check('R3 背包列表保留这一行并标记为未知物品（数据没丢，玩家看得见）',
        !!listed && listed.name === '未知物品' && Number(listed.quantity) === 1,
        `listed=${JSON.stringify(listed ? { name: listed.name, qty: listed.quantity, usable: listed.usable } : null)}`);

    // ===== R4 严格的那一半：凭空发一件不存在的物品仍然必须失败 =====
    let freshErr = '没抛错';
    try {
        await InventoryService.addItem(player.id, 'definitely_not_an_item_xyz', 1);
    } catch (error) {
        freshErr = error.message;
    }
    check('R4 凭空发放未知物品仍然报错（掉落/产出/奖励的引用错误不能被这层改动掩盖）',
        /物品配置不存在/.test(freshErr), `结果: ${freshErr}`);

    // ===== T 组：功法/神通这一层（配置消失后玩家属性会不会整体掉一截）=====
    // TechniqueService.getTechniqueBonus 外面裹了一层"异常就返回全零"的兜底，
    // 于是循环里任何一处没兜住的空引用，表现都不是报错，而是这个玩家**所有**功法加成清零。
    // 所以要验的不是"会不会崩"，而是"一条幽灵记录会不会把同一次计算里其他功法一起带走"。
    const TechniqueService = require('../game/services/TechniqueService');
    const PlayerTechnique = require('../models/playerTechnique');
    const techCfg = TechniqueService.getConfig();
    const realTechId = Object.keys(techCfg.techniques || {}).find(k => !k.startsWith('_'));
    const realSkillId = Object.keys(techCfg.skills || {}).find(k => !k.startsWith('_'));
    const GHOST_TECH = 'removed_content_probe_technique';
    const GHOST_SKILL = 'removed_content_probe_skill';

    await PlayerTechnique.destroy({ where: { player_id: player.id } });
    const learn = (techniqueId, slot, layer, skills) => PlayerTechnique.create({
        player_id: player.id, technique_id: techniqueId, layer, proficiency: 0,
        equip_slot: slot, comprehended_skills: skills
    });

    // 参照组：只有一条正常在身的功法
    const realRow = await learn(realTechId, 'main', 5, [realSkillId].filter(Boolean));
    const cleanBonus = await TechniqueService.getTechniqueBonus(player.id);

    // 实验组：同一行再多一个"已消失的神通"，并加一条幽灵功法，结果必须与参照组逐字段相同
    // （player_techniques 上 uk_player_technique 是 player_id+technique_id，同一功法不能开两行）
    await PlayerTechnique.update(
        { comprehended_skills: [realSkillId, GHOST_SKILL].filter(Boolean) },
        { where: { player_id: player.id, technique_id: realTechId } }
    );
    await learn(GHOST_TECH, 'auxiliary', 3, [GHOST_SKILL]);
    const withGhost = await TechniqueService.getTechniqueBonus(player.id);

    check('T1 功法里混进配置已消失的记录/神通时，其他功法的加成分毫不掉（改造前风险是全零）',
        !!realTechId && Number(cleanBonus.atk || 0) > 0
            && JSON.stringify(cleanBonus) === JSON.stringify(withGhost)
            && (withGhost.skills || []).length === 1
            && !withGhost.skills.some(s => s.id === GHOST_SKILL),
        `真实功法=${realTechId} → 无幽灵 atk +${cleanBonus.atk}，有幽灵 atk +${withGhost.atk}，`
        + `神通 ${(withGhost.skills || []).map(s => s.id).join(',')}（行 ${realRow.id}）`);

    const overview = await TechniqueService.getPlayerTechniques(player.id);
    const owned = overview?.owned || [];
    const ownedIds = owned.map(t => t && t.technique_id);
    check('T2 功法列表能打开（getMpCost 以前根本不存在，任何有功法的玩家开面板就 500）；幽灵记录被滤掉',
        ownedIds.includes(realTechId) && !ownedIds.includes(GHOST_TECH)
            && owned.every(t => t && t.name)
            && Number(owned.find(t => t.technique_id === realTechId)?.mp_cost) > 0,
        `列表=${ownedIds.filter(Boolean).join(',')}，灵力消耗预览=`
        + `${JSON.stringify(owned.map(t => t.mp_cost))}（mp_max×practice.mp_cost_ratio）`);

    const resolved = await CombatResolver.resolveCombatStats(player);
    const combatSkills = resolved.info?.technique_skills || [];
    check('T3 战斗侧解析属性与神通时，配置消失的功法/神通只被跳过，不抛错也不带回默认档位',
        combatSkills.length > 0 && !combatSkills.some(s => s.id === GHOST_SKILL || s.id === GHOST_TECH),
        `战斗内神通=${combatSkills.map(s => `${s.id}/${s.damage_profile || '默认档'}`).join(', ') || '无'}, `
        + `atk=${resolved.stats.atk}`);

    await PlayerTechnique.destroy({ where: { player_id: player.id } });

    // ===== 收尾：删掉探针自己造的数据 =====
    await PlayerEquipment.destroy({ where: { player_id: player.id } });
    await Item.destroy({ where: { player_id: player.id, item_key: GHOST } });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
