/**
 * 读路径冒烟探针（需要 MySQL，走 .env 指向的库；默认只读，不落写）
 *
 * 为什么要有这个脚本：jest 套件刻意不连库，于是 "ReferenceError: ownedRows is not defined"
 * 这类只在真实数据下才走到的分支，360 个用例全绿也照样把 500 留给玩家。
 * 这里把各面板的只读入口挨个调一遍，任何一处抛异常就退出码非 0。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_read_paths.js [playerId]
 */
'use strict';

const playerId = Number(process.argv[2] || 1);

const { initializeModules } = require('../modules');
const Player = require('../models/player');
const game = require('../game');

const results = [];

async function probe(name, fn) {
    try {
        const value = await fn();
        results.push({ name, ok: true, note: summarize(value) });
    } catch (error) {
        results.push({ name, ok: false, note: `${error.name || 'Error'}: ${error.message}` });
    }
}

function summarize(value) {
    if (Array.isArray(value)) return `${value.length} 项`;
    if (value && typeof value === 'object') return Object.keys(value).slice(0, 5).join(',');
    return String(value);
}

(async () => {
    await initializeModules();
    // 光 initializeModules() 不接属性链：AttributeService / CombatResolver / InventoryService
    // 都要 game/index 的那一次 initialize，否则本探针测到的是"全体按 default 兜底的假面板"。
    const { initializeGameServices } = require('../game');
    await initializeGameServices(require('../modules').infrastructure.ConfigLoader);
    const player = await Player.findByPk(playerId);
    if (!player) {
        console.error(`找不到玩家 ${playerId}`);
        process.exit(2);
    }

    await probe('attribute/panel', async () => game.AttributeService.getPanelSchema());
    await probe('attribute/full(static)', async () => game.AttributeService.calculateFullAttributes(player));
    await probe('attribute/full(async)', async () => game.AttributeService.calculateFullAttributesAsync(player));
    await probe('attribute-max/values', async () => game.AttributeMaxService.calculateAttributeMaxValues(
        player, game.RealmService.getRealmByName(player.realm)
    ));
    await probe('technique/list', async () => game.TechniqueService.getPlayerTechniques(player.id));
    await probe('inventory/list', async () => game.InventoryService.getInventory(player.id));
    await probe('equipment/list', async () => game.EquipmentService.getEquipped(player.id));
    await probe('equipment/bonus', async () => game.EquipmentService.getEquipmentBonus(player.id));
    await probe('pvp/power', async () => require('../game/services/PvpService').getCombatPower(player.id));
    await probe('realm/can-breakthrough', async () => game.RealmService.canBreakthrough(player));
    // 按生产调用方式传两个参数：只给 player 会让它抛"境界配置不存在"，那是探针写错而不是游戏坏了
    await probe('realm/breakthrough-probability', async () => {
        const current = game.RealmService.getRealmByName(player.realm);
        return game.RealmService.calculateBreakthroughProbability(player, game.RealmService.getNextRealm(current));
    });
    await probe('combat/stats', async () => require('../game/combat/CombatResolver').resolveCombatStats(player));
    // 境界基础值必须真的进属性。这一条同时钉住"解析链路有没有接上 ConfigLoader"：
    // 接不上时 AttributeService 会静默把所有人算成定义里的 default（真仙也只算 atk 10），
    // 面板照样打得开、日志一声不响 —— 那是探针必须响的"静默失效"。
    await probe('realm base 进属性（解析链路确实读到境界配置）', async () => {
        const realm = game.RealmService.getRealmByName(player.realm);
        if (!realm) throw new Error(`玩家境界「${player.realm}」在 realm_breakthrough 里查不到`);
        const { breakdown } = await game.AttributeService.calculateFullAttributesAsync(player);
        const baseAtk = Number(breakdown?.base?.atk);
        if (baseAtk !== Number(realm.base_atk)) {
            throw new Error(
                `breakdown.base.atk=${baseAtk} 与境界配置 base_atk=${realm.base_atk} 不符`
                + '（多半是 AttributeService 没拿到 ConfigLoader，全体按 default 兜底）'
            );
        }
        return { realm: realm.name, base_atk: baseAtk };
    });
    // 赶路时间现在会解析属性（异步），这一条同时盯"改成 async 之后调用形状没写错"
    await probe('map/travel-cost', async () => {
        const MapService = require('../game/services/MapService');
        const maps = require('../game/services/MapConfigLoader');
        const current = maps.getMap(player.current_map_id) || maps.getDefaultMap();
        const linked = maps.getConnectedMaps(current?.id)[0];
        if (!linked) return { skipped: '当前地图没有相连地图' };
        const cost = await MapService.calculateTravelCost(linked, player, current);
        if (!(cost.time > 0) || !(cost.cost >= 0)) throw new Error(`结果不合理: ${JSON.stringify(cost)}`);
        return cost;
    });

    // 宗门加成的中文名/换算方式必须由内容下发（客户端已删掉自己抄的那份字典）。
    // 只读接口不返回 bonus_meta 的话，前端会退回显示原始键名 —— 面板能打开、也不报错，
    // 所以这一条要在探针里响：逐个 sect 的 bonus 键都必须能在 bonus_meta 里找到 label+format。
    await probe('sect/list 的 bonus_meta 覆盖每个加成键', () => {
        const SectService = require('../game/services/SectService');
        const meta = SectService.getBonusMeta();
        const sects = SectService.getSectList();
        const gaps = [];
        for (const sect of sects) {
            for (const key of Object.keys(sect.bonus || {})) {
                const entry = meta[key];
                if (!entry?.label) gaps.push(`${sect.id}.${key} 没有 label`);
                else if (!['multiplier', 'ratio'].includes(entry.format)) gaps.push(`${sect.id}.${key} format=${entry.format}`);
            }
        }
        if (gaps.length) throw new Error(`bonus_meta 缺口：${gaps.slice(0, 4).join('; ')}`);
        return { sects: sects.length, meta_keys: Object.keys(meta).length };
    });

    const failed = results.filter(r => !r.ok);
    for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}  ${r.note}`);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
