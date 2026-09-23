/**
 * 「给灵兽加一档稀有度」的活体探针（需要 MySQL，走 .env 指向的隔离库）
 *
 * jest 那份 `BeastRarityVocabulary` 证的是内容层与读取口；玩家真正踩到的是**服务与库**这几条链：
 * 图鉴出参、"我的灵兽"的分档统计、升星预览/真扣费的消耗、放生返还的灵石数。
 * 这条探针用一个只存在于临时目录的资料片（新档 + 新档的升星倍率 + 一只用它的新灵兽）起一次真实装配，
 * 然后把那一档在五个消费点上都量一遍，并把"少写伴生表"那份坏 pack 现场证一次会被启动闸拦下。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_beast_rarity.js
 *       探针自建账号 rarityprobe01，退出前按账号名删号并清临时目录；不改仓库里的任何 pack。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const results = [];
const PROBE_NAMES = ['rarityprobe01'];
const NEW_TIER = 'primordial';
const NEW_BEAST = 'zz_rarity_beast';

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  ${detail}`);
}

/** 现网三个 pack 照抄一份，再放一支只有这一档新稀有度的探针片 */
function makeTempPackDir({ withMultiplier = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiuxian-rarity-'));
    const packs = path.join(root, 'packs');
    fs.mkdirSync(packs, { recursive: true });
    for (const dir of fs.readdirSync(path.join(SERVER, 'content', 'packs'))) {
        fs.cpSync(path.join(SERVER, 'content', 'packs', dir), path.join(packs, dir), { recursive: true });
    }
    const probe = path.join(packs, 'rarity_probe');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'pack.json'), JSON.stringify({ id: 'rarity_probe', name: '稀有度探针', version: '1.0.0' }));
    fs.writeFileSync(path.join(probe, 'spirit_beast_data__rarity_config.json'), JSON.stringify({
        dataset: 'spirit_beast_data', into: 'rarity_config',
        comment: '探针档：只存在于资料片里的第五档稀有度（凡人修仙传里"太初"这一类古兽的档次）。',
        add: [{ id: NEW_TIER, name: '太初', color: '#f43f5e', order: 5, release_return_ratio: 0.6 }]
    }));
    if (withMultiplier) {
        // map 集合加进来的条目必然是对象形状（{id,value}），基础配置那一侧是裸数字：
        // 读取端只认一种的话，这一档的消耗会静默变成 1.0 倍
        fs.writeFileSync(path.join(probe, 'spirit_beast_data__star_upgrade__rarity_cost_multiplier.json'), JSON.stringify({
            dataset: 'spirit_beast_data', into: 'star_upgrade.rarity_cost_multiplier',
            add: [{ id: NEW_TIER, value: 4 }]
        }));
    }
    fs.writeFileSync(path.join(probe, 'spirit_beast_data__beast_types.json'), JSON.stringify({
        dataset: 'spirit_beast_data', into: 'beast_types',
        add: [{
            beast_key: NEW_BEAST, name: '探针·太古兽', element: 'metal', rarity: NEW_TIER,
            base_hp: 1200, base_atk: 90, base_def: 60, base_speed: 100,
            min_realm_rank: 1, catch_chance: 0.5, catch_cost_mp: 10, feed_exp: 10, description: '探针灵兽'
        }]
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
    check('R0 临时 pack 装配上了', (content.status().packs || []).map(p => p.id).includes('rarity_probe'),
        `已装配=${(content.status().packs || []).map(p => p.id).join(', ')}`);

    await require('../game').initializeGameServices(infrastructure.ConfigLoader);
    const SpiritBeastService = require('../game/services/SpiritBeastService');
    const Player = require('../models/player');
    const SpiritBeast = require('../models/spiritBeast');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
    const beastConfig = infrastructure.ConfigLoader.getConfig('spirit_beast_data');
    const tierKeys = Object.keys(beastConfig.rarity_config).filter(k => !k.startsWith('_'));

    const mergedMultiplier = beastConfig.star_upgrade.rarity_cost_multiplier;
    check('R1 新档进了词表并排在最后；倍率表里它那条是资料片写进来的对象形状（{id,value}）',
        tierKeys.includes(NEW_TIER) && tierKeys.at(-1) === NEW_TIER
        && mergedMultiplier[NEW_TIER] && typeof mergedMultiplier[NEW_TIER] === 'object'
        && Number(mergedMultiplier[NEW_TIER].value) === 4
        && typeof mergedMultiplier.common === 'number',
        `词表=${tierKeys.join('/')}｜新档那条=${JSON.stringify(mergedMultiplier[NEW_TIER])}｜基础那条=${mergedMultiplier.common}`);

    // 号要先清干净，再按账号名建：崩过一次的那轮留下的灵兽行，新 id 找不回来
    await PlayerCascadePurge.deleteByUsernames(PROBE_NAMES);
    const realmNames = new Set(((infrastructure.ConfigLoader.getConfig('realm_breakthrough') || {}).realms || []).map(r => r.name));
    const PROBE_REALM = '炼气1层';
    check('R1b 探针境界名在内容里真的存在（境界名不存在时属性按 default 兜底，量到的"正常"是假的）',
        realmNames.has(PROBE_REALM), `realm='${PROBE_REALM}' 命中=${realmNames.has(PROBE_REALM)}`);
    const player = await Player.create({
        username: 'rarityprobe01', password: 'not-a-real-hash', nickname: '稀有度探针',
        realm: PROBE_REALM, realm_rank: 1, exp: 0, spirit_stones: 1000000,
        hp_current: 5000, mp_current: 500, lifespan_current: 1, lifespan_max: 60,
        attributes: {}, token_version: 0
    });

    // ① 图鉴：档名/配色/档序都要出得来，且整份词表随出参下发（客户端下拉就读它）
    const catalog = await SpiritBeastService.getBeastTypes(player.id);
    const newRow = (catalog.data.beast_types || []).find(b => b.beast_key === NEW_BEAST);
    check('R2 图鉴里新灵兽带的是内容写的档名与配色（不是裸键 primordial）',
        !!newRow && newRow.rarity === NEW_TIER && newRow.rarity_name === '太初'
        && newRow.rarity_color === '#f43f5e' && Number(newRow.rarity_order) === 5,
        JSON.stringify(newRow && { rarity: newRow.rarity, rarity_name: newRow.rarity_name, rarity_color: newRow.rarity_color, rarity_order: newRow.rarity_order }));
    check('R2b 图鉴出参把整份词表下发（含新档），后台/客户端不必再抄一份档位清单',
        (catalog.data.rarity_config || []).some(r => r.key === NEW_TIER)
        && (catalog.data.rarity_config || []).length === tierKeys.length,
        `清单=${(catalog.data.rarity_config || []).map(r => `${r.key}:${r.name}`).join(' ')}`);

    // 升星要扣妖丹：没有材料就永远停在"妖丹不足"那条判定上，量不到真正的扣费（R4c）
    const InventoryService = require('../game/services/InventoryService');
    const yaodanKey = beastConfig.star_upgrade.yaodan_item_key || 'yaodan';
    await InventoryService.addItem(player.id, yaodanKey, 20, null);

    // ② 分档统计：以前是手打四档，新档不计、total 照计
    async function createBeast(beastKey, level) {
        const bt = (beastConfig.beast_types || []).find(b => b.beast_key === beastKey);
        const row = await SpiritBeast.create({
            player_id: player.id, beast_key: beastKey, beast_name: bt.name, element: bt.element,
            rarity: bt.rarity, star_level: 1, level, exp: 0, loyalty: 50, beast_soul: 5000,
            hp_max: 1000, atk: 100, def: 50, speed: 20, is_active: false
        });
        SpiritBeastService.applyComputedStats(row, SpiritBeastService.computeStats(bt, level, 1));
        await row.save();
        return row;
    }
    const newTierBeast = await createBeast(NEW_BEAST, 6);
    const commonBeast = await createBeast('qingyun_wolf', 6);
    const list = await SpiritBeastService.getMyBeasts(player.id);
    const byRarity = list.data.stats.by_rarity || {};
    check('R3 "我的灵兽"分档统计含新档（键集合 == 词表，0 也在），旧写法会把它整档吞掉',
        Object.keys(byRarity).length === tierKeys.length && Number(byRarity[NEW_TIER]) === 1
        && Object.keys(byRarity).every(k => tierKeys.includes(k)),
        `by_rarity=${JSON.stringify(byRarity)}｜total=${list.data.stats.total}`);
    const listed = (list.data.beasts || []).find(b => b.id === newTierBeast.id);
    check('R3b 列表行也带档名与配色', listed?.rarity_name === '太初' && listed?.rarity_color === '#f43f5e',
        `rarity_name=${listed?.rarity_name}｜rarity_color=${listed?.rarity_color}`);

    // ③ 升星：预览的倍率与消耗都按新档那一格（伴生表那条 {id,value} 的条目形状）
    const previewNew = await SpiritBeastService.getUpgradePreview(player.id, newTierBeast.id);
    const previewCommon = await SpiritBeastService.getUpgradePreview(player.id, commonBeast.id);
    const baseRow = (beastConfig.star_upgrade.upgrade_table || []).find(u => u.from_star === 1) || {};
    check('R4 新档升星消耗 = 消耗表那一行 × 内容里那条 4 倍（对象形状读得到）',
        previewNew.success && Number(previewNew.data.cost.rarity_multiplier) === 4
        && Number(previewNew.data.cost.beast_soul) === Math.floor((baseRow.beast_soul_cost || 0) * 4)
        && previewNew.data.cost.spirit_stones === String(Math.floor((baseRow.spirit_stones_cost || 0) * 4)),
        `倍率=${previewNew.data?.cost?.rarity_multiplier} 兽魂=${previewNew.data?.cost?.beast_soul} 灵石=${previewNew.data?.cost?.spirit_stones}（基础行=${baseRow.beast_soul_cost}/${baseRow.spirit_stones_cost}）`);
    check('R4b 老档仍按自己的倍率（common=1），没有被新档带偏',
        Number(previewCommon.data.cost.rarity_multiplier) === 1
        && Number(previewCommon.data.cost.beast_soul) === Number(baseRow.beast_soul_cost),
        `倍率=${previewCommon.data?.cost?.rarity_multiplier} 兽魂=${previewCommon.data?.cost?.beast_soul}`);

    // ④ 真扣一次升星：库里兽魂扣掉的数 == 预览报的数（预览与结算同一份定义才算修完）
    const soulsBefore = Number(newTierBeast.beast_soul);
    const upgrade = await SpiritBeastService.upgradeStar(player.id, newTierBeast.id);
    const afterRow = await SpiritBeast.findByPk(newTierBeast.id);
    const soulsSpent = soulsBefore - Number(afterRow?.beast_soul ?? soulsBefore);
    check('R4c 真正升星扣的兽魂 == 预览报的数（同一份消耗定义，不是各算一遍）',
        upgrade.success === true
        && soulsSpent === Number(previewNew.data.cost.beast_soul)
        && Number(afterRow.star_level) === 2,
        `success=${upgrade.success} 消息=${(upgrade.message || '').slice(0, 40)}｜扣了=${soulsSpent} 预览要=${previewNew.data?.cost?.beast_soul}｜星级=${soulsBefore ? '' : ''}${afterRow?.star_level}`);

    // ⑤ 放生：返还按这一档自己的比例，而不是 0.2 那个兜底
    const bt = beastConfig.beast_types.find(b => b.beast_key === NEW_BEAST);
    const expected = BigInt(Math.floor(((Number(bt.base_hp) + 6 * 50) / 10) * 0.6));
    const wrongFallback = BigInt(Math.floor(((Number(bt.base_hp) + 6 * 50) / 10) * 0.2));
    const stonesBefore = BigInt((await Player.findByPk(player.id)).spirit_stones);
    const release = await SpiritBeastService.releaseBeast(player.id, newTierBeast.id);
    const after = await Player.findByPk(player.id);
    check('R5 放生按这一档自己的返还比例退灵石（0.6 而非 0.2 兜底），库里到手的数 == 现算',
        release.success === true && BigInt(after.spirit_stones) === stonesBefore + expected,
        `库里=${after.spirit_stones} 期望=${expected} 若按旧兜底会退=${wrongFallback} 回执=${JSON.stringify(release.data || release.message).slice(0, 80)}`);

    const afterList = await SpiritBeastService.getMyBeasts(player.id);
    check('R5b 放生后这一档计数归零（词表那一档还在，只是没有灵兽）',
        Number(afterList.data.stats.by_rarity[NEW_TIER]) === 0 && afterList.data.stats.total === 1,
        `by_rarity=${JSON.stringify(afterList.data.stats.by_rarity)}`);

    // ⑥ 控制跑：只加词表、忘了伴生倍率表 —— 启动闸必须拦下来（否则这一档按 1.0 收，越稀有越便宜）
    {
        const bad = makeTempPackDir({ withMultiplier: false });
        let message = '';
        try {
            const { ContentRegistry } = require('../game/content/ContentRegistry');
            const { statRegistry } = require('../game/stats');
            new ContentRegistry({ configPath: path.join(SERVER, 'config'), packDir: bad.packs, statRegistry }).load();
        } catch (err) { message = String(err.message || err); } finally {
            fs.rmSync(bad.root, { recursive: true, force: true });
        }
        check('R6 控制跑：只加档位不加倍率表 → 启动期就抛（不是运行期静默按 1.0）',
            message.includes('升星倍率表缺') && message.includes(NEW_TIER),
            message.slice(0, 150).replace(/\s+/g, ' '));
    }

    const purged = await PlayerCascadePurge.deleteByUsernames(PROBE_NAMES);
    const residue = await SpiritBeast.count({ where: { player_id: purged.ids } });
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行；灵兽残留行=${residue}`);
    fs.rmSync(root, { recursive: true, force: true });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await require('../config/database').close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try {
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(PROBE_NAMES);
    } catch {}
    process.exit(2);
});
