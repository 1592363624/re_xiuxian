/**
 * 给只读探针准备一个"身上真的有内容"的玩家。
 *
 * 为什么探针需要它：只读 GET 探针以前固定用玩家 1，而那是个空号——没有功法行、没有装备、
 * 背包是空的。于是所有 `list.map(row => row.config.xxx)` 这类"只有真的有数据才会执行到"的行
 * 从来没被执行过：TechniqueService.getPlayerTechniques 调用了一个根本不存在的 getMpCost，
 * 任何有功法的玩家开面板都是 500，而 248 条 GET 全绿了不知多少个版本。
 *
 * 这里优先复用库里已有的玩家；实在没有才造一个专用探针号（写库动作只发生在这一步，
 * 且只写它自己那几行，跑完保留，方便下一次直接用）。
 */
'use strict';

const Player = require('../../models/player');
const Item = require('../../models/item');
const PlayerEquipment = require('../../models/playerEquipment');
const PlayerTechnique = require('../../models/playerTechnique');
const configLoader = require('../../modules').infrastructure.ConfigLoader;

const PROBE_USERNAME = 'uiprobe01';

function firstOf(collection, pick) {
    const data = configLoader.getConfig(pick.dataset) || {};
    const list = collection === 'techniques'
        ? Object.entries(data.techniques || {}).filter(([id]) => !id.startsWith('_')).map(([, v]) => v)
        : (data.items || []);
    const item = list.find(x => x && x.id) || list[0];
    return item ? item.id : null;
}

async function findExisting(excludeId) {
    const owners = (await PlayerTechnique.findAll({ attributes: ['player_id'], group: 'player_id' }))
        .map(r => Number(r.player_id)).filter(id => id && id !== Number(excludeId));
    let best = null;
    for (const id of owners) {
        const [items, equips, techs] = await Promise.all([
            Item.count({ where: { player_id: id } }),
            PlayerEquipment.count({ where: { player_id: id } }),
            PlayerTechnique.count({ where: { player_id: id } })
        ]);
        if (!items || !equips) continue;
        const player = await Player.findByPk(id);
        if (!player || player.is_dead) continue;
        if (!best || items > best.richCounts.items) {
            player.richCounts = { items, equips, techs };
            best = player;
        }
    }
    return best;
}

/** 造/修一个专用探针号：功法 + 装备 + 物品各至少一行，且必须是活人 */
async function ensureProbePlayer() {
    const skills = (configLoader.getConfig('technique_data') || {}).skills || {};
    const skillId = Object.keys(skills).find(k => !k.startsWith('_')) || null;
    const techniqueId = firstOf('techniques', { dataset: 'technique_data' });
    const itemId = firstOf('items', { dataset: 'item_data' });
    const equipId = (configLoader.getConfig('item_data')?.items || [])
        .find(i => i.type === 'equipment')?.id || itemId;
    if (!techniqueId || !itemId) return null;

    let player = await Player.findOne({ where: { username: PROBE_USERNAME } });
    if (!player) {
        player = await Player.create({
            username: PROBE_USERNAME,
            password: 'not-a-real-hash',
            nickname: '只读探针',
            realm: '筑基初期',
            realm_rank: 11,
            exp: 1000,
            spirit_stones: 50000,
            hp_current: 5000,
            mp_current: 5000,
            lifespan_current: 1,
            attributes: {},
            token_version: 0
        });
    }
    player.is_dead = false;
    player.hp_current = 5000;
    player.mp_current = 5000;
    player.lifespan_current = 1;      // 寿元耗尽会触发死亡遮罩与一堆状态门禁，测不到正常路径
    await player.save();

    await PlayerEquipment.destroy({ where: { player_id: player.id } });
    await PlayerTechnique.destroy({ where: { player_id: player.id } });
    if (!(await Item.count({ where: { player_id: player.id } }))) {
        await Item.create({ player_id: player.id, item_key: itemId, item_name: itemId, quantity: 3 });
    }
    await PlayerEquipment.create({
        player_id: player.id, slot: 'weapon', item_key: equipId,
        equipped_at: new Date(), durability: 100, max_durability: 100,
        refine_level: 0, is_benming: false, spirit_power: 0, sort_order: 0
    });
    await PlayerTechnique.create({
        player_id: player.id, technique_id: techniqueId, layer: 3, proficiency: 100,
        equip_slot: 'main', comprehended_skills: skillId ? [skillId] : []
    });

    player.richCounts = {
        items: await Item.count({ where: { player_id: player.id } }),
        equips: await PlayerEquipment.count({ where: { player_id: player.id } }),
        techs: await PlayerTechnique.count({ where: { player_id: player.id } })
    };
    return player;
}

/** @param {number} excludeId 主探针玩家（空号那一遍已经跑过了，不必重复） */
async function ensureRichPlayer(excludeId) {
    return (await findExisting(excludeId)) || (await ensureProbePlayer());
}

module.exports = { ensureRichPlayer, findExisting, ensureProbePlayer, PROBE_USERNAME };
