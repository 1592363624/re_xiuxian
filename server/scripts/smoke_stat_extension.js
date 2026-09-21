/**
 * "给一把刀加一个新属性"的活体探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * 为什么要有：jest 那份 StatExtensionReachability 证明的是内容层/引擎/公式这三段，
 * 但玩家真正看到的是 HTTP 面板与战斗结算那两条链上的装配（provider 清单、schema 下发、
 * 装备槽读取）。这条探针用一个临时目录里的资料片（新属性 + 新武器 + 新战斗档位）
 * 起一次真实启动，然后给探针号穿上那把刀，检查属性真的算得出来、面板真的列得出来。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_stat_extension.js
 *       探针自建账号 statprobe01，退出前删号并清临时目录；不改仓库里的任何 pack。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const SERVER = path.join(__dirname, '..');
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 复制现网三个 pack，再放一个只存在于临时目录的探针 pack */
function makeTempPackDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-pack-'));
    const packs = path.join(root, 'packs');
    fs.mkdirSync(packs, { recursive: true });
    for (const dir of fs.readdirSync(path.join(SERVER, 'content', 'packs'))) {
        fs.cpSync(path.join(SERVER, 'content', 'packs', dir), path.join(packs, dir), { recursive: true });
    }
    const probe = path.join(packs, 'stat_probe');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'pack.json'), JSON.stringify({ id: 'stat_probe', name: '属性探针', version: '1.0.0' }));
    fs.writeFileSync(path.join(probe, 'stat_definitions__stats.json'), JSON.stringify({
        add: [{
            key: 'probe_pierce', label: '破阵', group: 'offense', unit: 'point',
            agg: 'flat_then_pct', base: { default: 0 },
            panel: { visible: true, order: 990 }, powerWeight: 0.2,
            battleRoles: ['attack_probe'], description: '探针属性：只存在于资料片里'
        }]
    }));
    fs.writeFileSync(path.join(probe, 'item_data__items.json'), JSON.stringify({
        add: [{
            id: 'probe_blade', name: '试剑刀', type: 'equipment', subtype: 'weapon', quality: 'rare',
            description: '探针武器', effect: { probe_pierce: 77, atk: 10 }, price: 100, required_realm_rank: 1
        }]
    }));
    fs.writeFileSync(path.join(probe, 'combat_formulas__profiles.json'), JSON.stringify({
        add: [{ id: 'probe_duel', label: '探针档位', attack_stat: 'probe_pierce', mitigate_stat: 'def', skill_multiplier: 1, defense_coef: 1, min_damage: 1 }]
    }));
    return { root, packs };
}

(async () => {
    const { root, packs } = makeTempPackDir();
    process.env.CONTENT_PACK_DIR = packs;

    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    const { contentRegistry } = require('../game/content');
    const content = contentRegistry();
    const loadedPackIds = (content && content.status().packs || []).map(p => p.id);
    check('P0 启动时读到了临时 pack 目录里的资料片', loadedPackIds.includes('stat_probe'),
        `已装配：${loadedPackIds.join(', ') || '(空)'}（CONTENT_PACK_DIR=${packs}）`);

    await require('../game').initializeGameServices(infrastructure.ConfigLoader);
    const { statRegistry } = require('../game/stats');

    const Player = require('../models/player');
    const InventoryService = require('../game/services/InventoryService');
    const EquipmentService = require('../game/services/EquipmentService');
    const AttributeService = require('../game/core/AttributeService');
    const combatResolver = require('../game/combat/CombatResolver');

    // 词表与面板 schema
    check('P1 新属性进了词表', statRegistry.has('probe_pierce'), `has('probe_pierce')=${statRegistry.has('probe_pierce')}`);
    const panel = await AttributeService.getPanelSchema();
    const panelKeys = JSON.stringify(panel);
    check('P2 面板 schema 里出现了新属性（客户端不用改代码就能显示）',
        panelKeys.includes('probe_pierce') && panelKeys.includes('破阵'),
        `schema 命中 probe_pierce=${panelKeys.includes('probe_pierce')} 破阵=${panelKeys.includes('破阵')}`);

    // 建号 → 发刀 → 穿上 → 算属性
    await Player.destroy({ where: { username: 'statprobe01' } });
    const player = await Player.create({
        username: 'statprobe01', password: 'not-a-real-hash', nickname: '属性探针',
        realm: '炼气初期', realm_rank: 1, exp: 0, spirit_stones: 10000,
        hp_current: 5000, mp_current: 500, lifespan_current: 1, lifespan_max: 60,
        attributes: {}, token_version: 0
    });
    await InventoryService.addItem(player.id, 'probe_blade', 1, null);
    const equipped = await EquipmentService.equip(player.id, 'probe_blade');
    check('P3 带上只存在于资料片里的武器', equipped.success !== false && !!equipped,
        JSON.stringify(equipped && (equipped.message || equipped.success || equipped)).slice(0, 120));

    const fresh = await Player.findByPk(player.id);
    const attrs = await AttributeService.calculateFullAttributesAsync(fresh);
    check('P4 装备效果里的新属性真的算进了最终属性（77）',
        Number(attrs.final.probe_pierce) === 77,
        `final.probe_pierce=${attrs.final.probe_pierce}；来源=${JSON.stringify((attrs.by_stat || attrs.breakdown || {}).probe_pierce || '').slice(0, 160)}`);

    const combat = await combatResolver.resolveCombatStats(fresh);
    check('P5 战斗属性解析也带着它（战斗侧不需要为新材料改代码）',
        Number(combat.stats.probe_pierce) === 77,
        `resolveCombatStats().stats.probe_pierce=${combat.stats.probe_pierce}`);

    const dmg = combatResolver.computeDamage('probe_duel', {
        attackerStats: combat.stats, defenderStats: { def: 100 }, random: 0.5, roll: () => 0.99
    });
    check('P6 用新属性当攻击项的战斗档位能结算', dmg.attack === 77 && dmg.damage > 0,
        `profile=${dmg.profile} attack=${dmg.attack} damage=${dmg.damage}`);

    // 单调性：属性值变大伤害必须跟着变大 —— 否则"结算得出 1"可能只是被 min_damage 兜住的空测
    const big = combatResolver.computeDamage('probe_duel', {
        attackerStats: { probe_pierce: 7777 }, defenderStats: { def: 100 }, random: 0.5, roll: () => 0.99
    });
    check('P6b 新属性真的在驱动公式（值变大 → 伤害变大，不是被 min_damage 兜底）',
        big.damage > dmg.damage, `probe_pierce 77 → ${dmg.damage}；7777 → ${big.damage}`);

    // 反证：没穿刀时这一项应当回到内容声明的 default（0），而不是 undefined 或旧值
    await EquipmentService.unequip ? await EquipmentService.unequip(player.id, 'weapon') : null;
    const bare = await AttributeService.calculateFullAttributesAsync(await Player.findByPk(player.id));
    check('P7 卸掉武器后新属性回到内容声明的默认值（不是 undefined）',
        Number(bare.final.probe_pierce) === 0,
        `final.probe_pierce=${bare.final.probe_pierce}`);

    await Player.destroy({ where: { id: player.id } });
    fs.rmSync(root, { recursive: true, force: true });
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await require('../config/database').close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try { await require('../models/player').destroy({ where: { username: 'statprobe01' } }); } catch {}
    process.exit(2);
});
