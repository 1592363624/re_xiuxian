/**
 * 坐化遗府「分宝」落库对账探针（需要 MySQL，走 .env 指向的库）
 *
 * 盯的是 CaveLegacyService._executeSpin 里"记录"和"发放"的一致性。
 * 原来的顺序是：扣 remaining_quantity → 写 CaveLegacyDistributionLog → 才 addItem，
 * 而 addItem 失败（储物袋满）只 console.warn + continue。于是库里留下一条
 * **玩家从未拿到**的分配记录，而"分宝记录"面板（_listDistributionLogs）正是读这张表 ——
 * 玩家会看到"你分到了 X"，背包里却没有，遗府里那件也还留着。
 * 现在改成先 addItem 成功、再写日志，并把没落袋的件回报给玩家。
 *
 * 这件事 jest 测不到：它不连库，日志行/剩余数量/背包都是纸上的。
 * 所以本探针真跑两遍分宝，逐件对账：
 *   A 轮（正常）：摘要、日志表、背包、remaining_quantity 四方必须完全一致；
 *   B 轮（强行让第 1 件 addItem 抛错，模拟储物袋满）：
 *     - 摘要里不能有它，日志表里也**不能有它**（这条就是回归点）
 *     - remaining_quantity 必须回到原值（没扣成功就不能少）
 *     - skipped_items / message 必须告诉玩家这件没进去
 *   并且断言"B 轮确实让 addItem 抛过至少一次"，否则整轮是空测。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_cave_legacy_spin.js
 * 只用自建探针号 smoke_cave_legacy / smoke_cave_legacy_owner，跑完自己清行。
 */
'use strict';

const Player = require('../models/player');
const Item = require('../models/item');
const CaveLegacy = require('../models/caveLegacy');
const CaveLegacyItem = require('../models/caveLegacyItem');
const CaveLegacyParticipant = require('../models/caveLegacyParticipant');
const CaveLegacyDistributionLog = require('../models/caveLegacyDistributionLog');
const sequelize = require('../config/database');
const InventoryService = require('../game/services/InventoryService');
const CaveLegacyService = require('../game/services/CaveLegacyService');
const { initializeModules, infrastructure } = require('../modules');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const SPINNER = 'smoke_cave_legacy';
const OWNER = 'smoke_cave_legacy_owner';

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

/** 从内容层取 3 件可堆叠材料，保证 addItem 找的到配置 */
function pickItemKeys() {
    const items = infrastructure.ConfigLoader.getConfig('item_data').items;
    const usable = items.filter(i => i && i.id && i.name && i.type !== 'equipment' && InventoryService.getItemConfig(i.id));
    if (usable.length < 3) throw new Error(`内容里查得到配置的非装备物品不足 3 件（只有 ${usable.length}），探针没法跑`);
    return usable.slice(0, 3).map(i => ({ id: i.id, name: i.name }));
}

async function ensurePlayer(username, nickname) {
    let player = await Player.findOne({ where: { username } });
    if (!player) {
        player = await Player.create({
            username,
            password: 'not-a-real-hash',
            nickname,
            realm: '筑基5层',
            realm_rank: 15
        });
    }
    // 同主魂判定读 player.ip_address：留空即放行，避免探针号之间互相顶掉领取资格
    if (player.ip_address) {
        player.ip_address = null;
        await player.save();
    }
    return player;
}

let legacySeq = 0;
async function seedLegacy(ownerId, spinnerId, keys) {
    const now = new Date();
    const legacy = await CaveLegacy.create({
        owner_player_id: ownerId,
        owner_nickname_snapshot: '遗府探针主',
        owner_ip_snapshot: null,
        status: 'open',
        duration_hours: 24,
        started_at: now,
        ends_at: new Date(now.getTime() + 24 * 3600 * 1000),
        opened_by_admin: null,
        items_count: keys.length,
        items_total_quantity: 10 * keys.length,
        participants_count: 0,
        settled: false
    });
    for (const k of keys) {
        await CaveLegacyItem.create({
            legacy_id: legacy.id,
            item_key: k.id,
            item_name_snapshot: k.name,
            item_type_snapshot: 'consumable',
            item_subtype_snapshot: null,
            item_quality_snapshot: k.quality,
            original_quantity: 10,
            remaining_quantity: 10,
            source: 'probe'
        });
    }
    // 预先落一条合格参与者：跳过 _checkEligibility（那要凑在线时长/指令数），直供分宝本体
    await CaveLegacyParticipant.create({
        legacy_id: legacy.id,
        player_id: spinnerId,
        player_nickname_snapshot: SPINNER,
        player_ip_snapshot: '',
        eligible: true,
        ineligibility_reason: null,
        weight: 1.0,
        lucky_factor: 1.0,
        has_spun: false,
        total_item_types: 0,
        total_quantity: 0
    });
    return legacy;
}

async function inventoryOf(playerId, itemKey) {
    const row = await Item.findOne({ where: { player_id: playerId, item_key: itemKey } });
    return Number(row && row.quantity ? row.quantity : 0);
}

async function logsOf(legacyId, playerId) {
    return CaveLegacyDistributionLog.findAll({ where: { legacy_id: legacyId, player_id: playerId } });
}

async function roundA(spinner, keys) {
    const legacy = await seedLegacy(spinner.ownerId, spinner.id, keys);
    const res = await CaveLegacyService.spinLegacy(spinner.player, legacy.id);
    check('A 轮：分宝真的跑到了（不是资格/状态被挡）', res.success === true && (res.data?.distributed_items || []).length > 0,
        res.message);
    if (!res.success) return;

    const distributed = res.data.distributed_items;
    const logs = await logsOf(legacy.id, spinner.id);
    check('A 轮：日志条数 == 摘要条数', logs.length === distributed.length, `日志 ${logs.length} / 摘要 ${distributed.length}`);
    check('A 轮：日志里的件与摘要里的件一模一样',
        JSON.stringify(logs.map(l => `${l.item_key}x${l.quantity}`).sort()) === JSON.stringify(distributed.map(d => `${d.item_key}x${d.quantity}`).sort()),
        logs.map(l => l.item_key).join(','));

    // 背包逐件对账：摘要说发了，库里就得真有
    let bagMismatch = null;
    for (const d of distributed) {
        const have = await inventoryOf(spinner.id, d.item_key);
        if (have < d.quantity) { bagMismatch = `${d.item_key} 摘要 ${d.quantity}，背包 ${have}`; break; }
    }
    check('A 轮：摘要说发到的每件都在背包里', bagMismatch === null, bagMismatch || '');

    // remaining_quantity 必须只少了真发出去的那些
    let qtyMismatch = null;
    for (const d of distributed) {
        const row = await CaveLegacyItem.findOne({ where: { legacy_id: legacy.id, item_key: d.item_key } });
        if (Number(row.remaining_quantity) !== 10 - d.quantity) qtyMismatch = `${d.item_key} 期望 ${10 - d.quantity}，实际 ${row.remaining_quantity}`;
    }
    check('A 轮：遗府剩余数量只扣掉真发出去的部分', qtyMismatch === null, qtyMismatch || '');
}

async function roundB(spinner, keys) {
    const legacy = await seedLegacy(spinner.ownerId, spinner.id, keys);
    const blocked = keys[0];                      // 排序后 rare 在最前，第一件就会撞上
    const real = InventoryService.addItem;
    let threw = 0;
    InventoryService.addItem = async (playerId, itemKey, quantity, t, ...rest) => {
        if (itemKey === blocked.id) { threw++; throw new Error('背包容量不足（探针模拟）'); }
        return real.call(InventoryService, playerId, itemKey, quantity, t, ...rest);
    };
    try {
        const res = await CaveLegacyService.spinLegacy(spinner.player, legacy.id);

        check('B 轮：addItem 确实被挡过（否则整轮空测）', threw > 0, `抛错 ${threw} 次`);
        check('B 轮：没发到的一件不在摘要里', !(res.data?.distributed_items || []).some(d => d.item_key === blocked.id), res.message);

        const logs = await logsOf(legacy.id, spinner.id);
        // ↓↓ 这条就是回归点：日志表喂的是"分宝记录"面板，多一条就是玩家看得见却拿不到的幽灵收获
        check('B 轮：没发到的一件也没有留下分配日志（回归点）',
            !logs.some(l => l.item_key === blocked.id),
            logs.map(l => `${l.item_key}x${l.quantity}`).join(','));
        check('B 轮：日志条数 == 摘要条数（发几条记几条）', logs.length === (res.data?.distributed_items || []).length,
            `日志 ${logs.length} / 摘要 ${(res.data?.distributed_items || []).length}`);

        const row = await CaveLegacyItem.findOne({ where: { legacy_id: legacy.id, item_key: blocked.id } });
        check('B 轮：被挡那件的 remaining_quantity 回到原值', Number(row.remaining_quantity) === 10, `实际 ${row.remaining_quantity}`);
        check('B 轮：被挡那件确实没进背包', await inventoryOf(spinner.id, blocked.id) === 0, '');

        const skipped = res.data?.skipped_items || [];
        check('B 轮：skipped_items 报了被挡的那件', skipped.some(s => s.item_key === blocked.id), JSON.stringify(skipped));
        check('B 轮：给玩家的话术里点名了容量不足和物品名',
            typeof res.message === 'string' && res.message.includes('背包容量不足') && res.message.includes(blocked.name),
            res.message);
    } finally {
        InventoryService.addItem = real;
    }
}

async function main() {
    await initializeModules();
    // InventoryService 的配置源是启动时注入的（game/index.js 里 initialize）；
    // 本探针不起 HTTP，得自己补这一针，否则 getItemConfig 一律返回 null、每件物品都被当未知。
    InventoryService.initialize(infrastructure.ConfigLoader);
    const keys = pickItemKeys();
    keys[0].quality = 'rare'; keys[1].quality = 'epic'; keys[2].quality = 'common';

    const ownerPlayer = await ensurePlayer(OWNER, '遗府探针主');
    const spinPlayer = await ensurePlayer(SPINNER, '分宝探针');
    await Item.destroy({ where: { player_id: spinPlayer.id } });  // 本轮开局先把背包清空（不是收尾，级联管不到这里）
    const spinner = { id: spinPlayer.id, player: spinPlayer, ownerId: ownerPlayer.id };

    // 排序按 quality：rare 先分配，所以 B 轮挡第一件必然撞上
    check('探针用的物品能在内容里查到名字', keys.every(k => !!InventoryService.getItemConfig(k.id)), keys.map(k => k.id).join(','));

    await roundA(spinner, keys);
    await Item.destroy({ where: { player_id: spinPlayer.id } });       // 清背包，让 B 轮从 0 开始
    await roundB(spinner, keys);

    // 收摊：只删本轮自建的那些行
    const legacyIds = await CaveLegacyItem.findAll({
        where: { source: 'probe' }, attributes: ['legacy_id'], raw: true
    }).then(rs => [...new Set(rs.map(r => r.legacy_id))]);
    if (legacyIds.length) {
        const inIds = { [require('sequelize').Op.in]: legacyIds };
        await CaveLegacyDistributionLog.destroy({ where: { legacy_id: inIds } });
        await CaveLegacyParticipant.destroy({ where: { legacy_id: inIds } });
        await CaveLegacyItem.destroy({ where: { legacy_id: inIds } });
        await CaveLegacy.destroy({ where: { id: inIds } });
    }
    // 背包（player_items）、遗府（cave_legacies.owner_player_id）、参与者与分宝日志（player_id）
    // 这些按"归属"列挂着的行全部交给级联；上面那几条按 legacy_id 归属的才要自己点名。
    const purged = await PlayerCascadePurge.deletePlayers([spinner.ownerId, spinner.id]);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
}

(async () => {
    let failed = 0;
    try {
        await main();
    } catch (e) {
        failed = 1;
        console.error('探针异常：', e.message);
        if (/no such table|doesn't exist|ER_NO_SUCH_TABLE/i.test(e.message)) {
            console.error('提示：cave_legacy_* 表不在当前库里，先确认 --env-file 指向的是哪个库。');
        }
    } finally {
        await sequelize.close().catch(() => {});
        const bad = results.filter(r => !r.ok).length + failed;
        console.log(`\n${results.length} 项断言，失败 ${bad}`);
        process.exit(bad ? 1 : 0);
    }
})();
