/**
 * 成就奖励（物品 / 称号）活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 为什么单独一条：`tests/AchievementRewardShape.test.js` 钉的是**形状与闸**，而这三件事只有连库断得出来：
 *   ① `reward.items` 真的进了背包、`reward.title_id` 真的进了 players.titles（改造前这两个键根本没人读，
 *      写了也只会静默忽略）；
 *   ② 背包装不下时**整笔回滚** —— 成就保持未领取、灵石修为一分没多、已入包的那几件也一起撤回，
 *      玩家清包之后还能再领一次（半发是这条链最坏的失败形状：claimed 置位了而东西没到手，永久损失）；
 *   ③ 同一个号连点两下只会有一次发货（行锁 + claimed 判定）。
 * 另外钉住"库里只存引用、名字在出参那一刻现算"：背包行存的是 item_key，成就列表出参带 item_name。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_achievement_rewards.js
 *       自建账号 achreward01 / achreward02，退出前走级联清理；不改仓库里的任何内容。
 *
 * 控制跑（证明这些断言不是空转）：
 *   · A1 兼作一条回归哨兵：把 `await this.syncProgress(playerId)` 挪回事务**里面**（放回它原来的位置），
 *     A1 立刻从"成就尚未达成"变成"Lock wait timeout exceeded"（挂 50 秒）——
 *     那是本轮在这条链上抓到的真 bug：第一次领取必然自建 player_achievements 行，
 *     而那次写入不带事务、走另一条连接，被本事务对同一行/同一间隙取的 FOR UPDATE 挡住。
 *   · 把 AchievementService.claimReward 里 `if (grant.failed.length) throw ...` 那一段注释掉 →
 *     A8（背包满整笔回滚）与 A9（清包后还能领）两条必须一起变红；
 *   · 把 title 那一行改成直接 `player.titles = [titleId]`（不走 addTitleToInstance）→
 *     A7（已有称号不重复发、也不谎称获得）必须变红；
 *   · 把 `reward.items` 那整块删掉（回到只有灵石/修为的旧实现）→ A2/A3/A5 三条全红。
 * 未知 reward 键不在活体射程内：那是启动期闸（_validateAchievementRewards）的活，运行期只会照旧忽略，
 * 所以这条探针不假装覆盖了它 —— 覆盖它的反证在 jest 那份夹具里。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5102);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}
const num = v => Number(v) || 0;

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const Item = require('../models/item');
    const PlayerAchievement = require('../models/playerAchievement');
    const RealmService = require('../game/core/RealmService');
    const PlayerStateStore = require('../game/persistence/PlayerStateStore');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
    const AchievementService = require('../game/services/AchievementService');
    const InventoryService = require('../game/services/InventoryService');

    const USERNAMES = ['achreward01', 'achreward02'];
    await PlayerCascadePurge.deleteByUsernames(USERNAMES);

    async function makeAccount(username, nickname) {
        return await Player.create({
            username, password: 'not-a-real-hash', nickname,
            realm: '化神初期', realm_rank: RealmService.getRealmByName('化神初期').rank,
            exp: 0, spirit_stones: 0, hp_current: 1000, mp_current: 100,
            lifespan_current: 100, lifespan_max: 500,
            attributes: {}, spirit_roots: {}, titles: [], token_version: 0
        });
    }

    const player = await makeAccount(USERNAMES[0], '奖励探针甲');
    const peer = await makeAccount(USERNAMES[1], '奖励探针乙');

    /** 库里那一格计数的真值（绕开实例内存） */
    async function rawStat(id, key) {
        const [rows] = await sequelize.query('SELECT stats FROM players WHERE id = ?', { replacements: [id] });
        const raw = rows && rows[0] ? rows[0].stats : null;
        const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
        return num(parsed[key]);
    }
    async function rawColumns(id) {
        const [rows] = await sequelize.query('SELECT exp, spirit_stones, titles FROM players WHERE id = ?', { replacements: [id] });
        const row = rows[0] || {};
        let titles = [];
        try { titles = JSON.parse(row.titles || '[]'); } catch { titles = []; }
        return { exp: num(row.exp), spirit_stones: num(row.spirit_stones), titles };
    }
    async function bagCount(id, itemKey) {
        const row = await Item.findOne({ where: { player_id: id, item_key: itemKey } });
        return num(row && row.quantity);
    }
    async function bagTotal(id) {
        return num(await Item.sum('quantity', { where: { player_id: id } }));
    }
    async function claimedFlag(id, achievementId) {
        const rec = await PlayerAchievement.findOne({ where: { player_id: id, achievement_id: achievementId } });
        return rec ? rec.claimed : null;
    }
    async function claim(id, achievementId) {
        try {
            return { ok: true, result: await AchievementService.claimReward(id, achievementId) };
        } catch (e) {
            // AppError 上的字段叫 errorCode（不是 code）—— 取错了就会把"被正确地拒了"读成"没有错误码"
            return { ok: false, code: e.errorCode || e.code || '', message: String(e.message || e) };
        }
    }

    const cfg = infrastructure.ConfigLoader.getConfig('achievement_data') || {};
    const defOf = id => (cfg.achievements || []).find(a => a.id === id);
    const TRIAL = defOf('hf_first_trial');
    const DAN = defOf('hf_dan_heart');
    const ART = defOf('hf_artifact_name');

    // ===== A0 前置：资料片没装配上就别往后跑（否则每条断言都会以"没配"的形式假绿/假红） =====
    check('A0a 第 6 套资料片的成就装配上了（reward 里真有 items / title_id 这两种键）',
        !!(TRIAL && DAN && ART)
        && Array.isArray(TRIAL.reward?.items) && Array.isArray(ART.reward?.items)
        && !!DAN.reward?.title_id && !!ART.reward?.title_id,
        TRIAL ? `hf_first_trial.reward=${JSON.stringify(TRIAL.reward)}` : 'achievement_data 里没有 hf_first_trial');
    check('A0b 成就系统开着（assertEnabled 会先看这个开关）',
        AchievementService.isEnabled() === true, `enabled=${AchievementService.isEnabled()}`);
    if (!TRIAL || !DAN || !ART || !AchievementService.isEnabled()) return finish();

    // ===== A1 没达成就领 → 必须被条件闸挡下，不能"成功但什么都没发" =====
    const early = await claim(player.id, TRIAL.id);
    check('A1 未达成时领取被拒（CONDITION_NOT_MET），不是返回 success',
        !early.ok && early.code === 'CONDITION_NOT_MET', early.ok ? '竟然领成功了' : `${early.code} ${early.message}`);

    // ===== A2 列表出参把引用解析成名字（内容里只有 item_key / title_id） =====
    const list = await AchievementService.getAchievements(player.id);
    const listItem = list.items.find(a => a.id === TRIAL.id);
    check('A2 成就列表的 reward.items 带 item_name，且不是把键名原样印出去',
        !!(listItem?.reward?.items?.[0]?.item_name)
        && listItem.reward.items[0].item_name !== listItem.reward.items[0].item_key,
        JSON.stringify(listItem?.reward?.items || null));
    const danItem = list.items.find(a => a.id === DAN.id);
    check('A2b 称号奖励带 title_name（同一套解析，客户端不必再抄一份称号典）',
        !!(danItem?.reward?.title_name) && danItem.reward.title_name !== danItem.reward.title_id,
        `${danItem?.reward?.title_id} → ${danItem?.reward?.title_name}`);

    // ===== A3 达成后领取：物品进包、灵石修为到账、claimed 置位、成就计数 +1 =====
    await PlayerStateStore.bumpStat(player.id, 'kill_count', num(TRIAL.target));
    const beforeTrial = await rawColumns(player.id);
    const trialClaim = await claim(player.id, TRIAL.id);
    const tokenKey = TRIAL.reward.items[0].item_key;
    check('A3 领成功且物品真的进了背包（库里那一行的数量与配置一致）',
        trialClaim.ok && await bagCount(player.id, tokenKey) === num(TRIAL.reward.items[0].quantity),
        trialClaim.ok ? `${tokenKey}=${await bagCount(player.id, tokenKey)} 件` : `被拒：${trialClaim.message}`);
    const afterTrial = await rawColumns(player.id);
    check('A3b 灵石/修为按配置到账，且回执文案点得出物品名字',
        afterTrial.spirit_stones - beforeTrial.spirit_stones === num(TRIAL.reward.spirit_stones)
        && afterTrial.exp - beforeTrial.exp === num(TRIAL.reward.exp)
        && String(trialClaim.result?.message || '').includes(listItem.reward.items[0].item_name),
        `灵石 +${afterTrial.spirit_stones - beforeTrial.spirit_stones}，修为 +${afterTrial.exp - beforeTrial.exp}，文案=${trialClaim.result?.message}`);
    check('A3c claimed=1 且 stats.achievements_completed 从 0 变 1（领奖那一次才进账）',
        (await claimedFlag(player.id, TRIAL.id)) === true && (await rawStat(player.id, 'achievements_completed')) === 1,
        `claimed=${await claimedFlag(player.id, TRIAL.id)} 计数=${await rawStat(player.id, 'achievements_completed')}`);
    check('A3d 背包那一行存的是引用（item_key），没有把名字冻进库里',
        !!(await Item.findOne({ where: { player_id: player.id, item_key: tokenKey } })),
        `item_key=${tokenKey}`);

    // ===== A4 再点一次：拒绝，且一件都不多发 =====
    const again = await claim(player.id, TRIAL.id);
    check('A4 重复领取被拒（ALREADY_EXISTS），物品数量不翻倍、计数不再涨',
        !again.ok && again.code === 'ALREADY_EXISTS'
        && await bagCount(player.id, tokenKey) === num(TRIAL.reward.items[0].quantity)
        && (await rawStat(player.id, 'achievements_completed')) === 1,
        `${again.code} ${again.message}，包内 ${await bagCount(player.id, tokenKey)} 件`);

    // ===== A5 称号发放：走 players.titles 那一列，库里存的就是引用 =====
    await PlayerStateStore.bumpStat(player.id, 'alchemy_count', num(DAN.target));
    const danClaim = await claim(player.id, DAN.id);
    const afterDan = await rawColumns(player.id);
    check('A5 称号进了 players.titles（走 addTitleToInstance，与副本/切磋同一道门）',
        danClaim.ok && afterDan.titles.includes(DAN.reward.title_id),
        `titles=${JSON.stringify(afterDan.titles)}`);
    check('A5b 裸 id 形的 items 也发得出去（按一件算），回执写的是中文名',
        await bagCount(player.id, DAN.reward.items[0]) === 1
        && String(danClaim.result?.message || '').includes('称号《'),
        `${DAN.reward.items[0]}=${await bagCount(player.id, DAN.reward.items[0])} 件，文案=${danClaim.result?.message}`);

    // ===== A6 已经有这个称号：不重复发、也不谎称获得（claimed 照常置位） =====
    // 预先塞称号必须走 patchPlayerState 那道门：`player.titles = [...]` + 事务外 save() 会被
    // blobWriteGuard 直接拦下来（没有行锁的整块回写会盖掉并发写入）—— 第一版探针就在这上面翻过一次车。
    const seeded = (await rawColumns(peer.id)).titles;
    await PlayerStateStore.patchPlayerState(peer.id, { titles: [...seeded, DAN.reward.title_id] });
    await PlayerStateStore.bumpStat(peer.id, 'alchemy_count', num(DAN.target));
    const peerClaim = await claim(peer.id, DAN.id);
    const peerTitles = (await rawColumns(peer.id)).titles;
    check('A6 已有称号时领得到奖励，但文案说清"此前已在身"，称号列不出现第二份',
        peerClaim.ok && peerTitles.length === 1
        && String(peerClaim.result?.message || '').includes('此前已在身'),
        `titles=${JSON.stringify(peerTitles)}，文案=${peerClaim.result?.message}`);

    // ===== A6b 成就分组词表：资料片自带的那一档能一路走到接口出参 =====
    const list2 = await AchievementService.getAchievements(player.id);
    const catKeys = Object.keys(list2.categories || {}).filter(k => !k.startsWith('_'));
    const trial = (list2.categories || {}).trial || {};
    const hfItem = list2.items.find(i => i.id === 'hf_first_trial');
    check('A6b 分组表在合并视图里有 6 档，其中「试艺」是资料片自带的那一档（有中文名、来源可查）',
        catKeys.length >= 6 && catKeys.includes('trial') && trial.name === '试艺' && !!trial.__content_origin,
        `${catKeys.join('/')}；trial=${JSON.stringify(trial)}`);
    check('A6b2 成就出参带着分组名（category_name=试艺），且没有任何一项顶着裸键',
        hfItem && hfItem.category === 'trial' && hfItem.category_name === '试艺'
        && list2.items.every(i => Object.keys(list2.categories).includes(i.category)),
        hfItem ? `${hfItem.id} → ${hfItem.category}/${hfItem.category_name}` : '列表里没有 hf_first_trial');
    check('A6b3 出参不再有 category_color（内容里那一格已删，没人读的东西不该占着契约）',
        list2.items.every(i => !('category_color' in i)),
        `样本 item 键=${hfItem ? Object.keys(hfItem).join(',') : '无'}`);

    // ===== A7 背包装不下：整笔回滚（这是本轮最要紧的一条） =====
    const capacity = (InventoryService.getInventoryConfig().capacity || 100);
    const ART_TOKEN = (ART.reward.items.find(i => i.item_key === 'huangfeng_guest_seal') || {}).item_key;
    await PlayerStateStore.bumpStat(player.id, 'refining_count', num(ART.target));
    const beforeArt = await rawColumns(player.id);
    const beforeArtCount = await rawStat(player.id, 'achievements_completed');
    const filler = capacity - await bagTotal(player.id);
    await InventoryService.addItem(player.id, 'wild_herb', filler);
    check('A7a 先把包填到上限（后面的拒绝必须是"装不下"，不是别的理由）',
        await bagTotal(player.id) === capacity, `容量 ${capacity}，当前 ${await bagTotal(player.id)} 件`);
    const stuffed = await claim(player.id, ART.id);
    check('A7 背包满时领取被拒，理由点得出是哪几件装不下',
        !stuffed.ok && /背包放不下/.test(stuffed.message) && /容量不足/.test(stuffed.message),
        stuffed.ok ? '竟然领成功了' : `${stuffed.code} ${stuffed.message}`);
    const afterArt = await rawColumns(player.id);
    check('A7b 整笔回滚：信物没进包、claimed 没置位、灵石修为一分没多、成就计数也没 +1',
        await bagCount(player.id, ART_TOKEN) === 0
        && (await claimedFlag(player.id, ART.id)) !== true
        && afterArt.spirit_stones === beforeArt.spirit_stones
        && afterArt.exp === beforeArt.exp
        && (await rawStat(player.id, 'achievements_completed')) === beforeArtCount,
        `信物=${await bagCount(player.id, ART_TOKEN)} 件，claimed=${await claimedFlag(player.id, ART.id)}，`
        + `灵石 ${beforeArt.spirit_stones}→${afterArt.spirit_stones}，计数 ${beforeArtCount}→${await rawStat(player.id, 'achievements_completed')}`);
    // ART 那一笔里包含 2 件定魂香；包满时被拒，库里应当还是 A5 领的那 1 件（一件都没多）
    check('A7c 事务回滚把"已经塞进去的那几件"也一起撤回（不是只回滚了失败那一件）',
        await bagCount(player.id, 'ding_hun_xiang') === 1,
        `定魂香 ${await bagCount(player.id, 'ding_hun_xiang')} 件（A5 领的 1 件；本笔要发的 2 件应一件都没进去）`);

    // ===== A8 清包之后还能领（拒绝不是把这次机会烧掉） =====
    await Item.destroy({ where: { player_id: player.id, item_key: 'wild_herb' } });
    const afterFree = await claim(player.id, ART.id);
    check('A8 腾出空间后重领成功：信物与称号都到手，计数补上这一次',
        afterFree.ok && await bagCount(player.id, ART_TOKEN) === 1
        && (await rawColumns(player.id)).titles.includes(ART.reward.title_id)
        && (await rawStat(player.id, 'achievements_completed')) === beforeArtCount + 1,
        afterFree.ok ? `${ART_TOKEN}=${await bagCount(player.id, ART_TOKEN)} 件，计数=${await rawStat(player.id, 'achievements_completed')}` : `仍被拒：${afterFree.message}`);

    // ===== A9 同一个号连点两下（真并发）：只能有一次发货 =====
    await PlayerStateStore.bumpStat(peer.id, 'kill_count', num(TRIAL.target));
    const [leg1, leg2] = await Promise.all([claim(peer.id, TRIAL.id), claim(peer.id, TRIAL.id)]);
    const okCount = [leg1, leg2].filter(l => l.ok).length;
    const rejected = [leg1, leg2].find(l => !l.ok);
    check('A9 两条并发领取只成一次，另一条被拒（打印被拒理由，别把它当成"必然成功"）',
        okCount === 1 && !!rejected,
        `成 ${okCount} 败 ${2 - okCount}，被拒理由=${rejected ? `${rejected.code} ${rejected.message}` : '无'}`);
    check('A9b 并发不重复发货：物品 1 件、成就计数只 +1',
        await bagCount(peer.id, tokenKey) === 1 && (await rawStat(peer.id, 'achievements_completed')) === 2,
        `${tokenKey}=${await bagCount(peer.id, tokenKey)} 件，计数=${await rawStat(peer.id, 'achievements_completed')}（A6 已领过一次）`);

    // ===== A10 清场：删号后不留派生行 =====
    await PlayerCascadePurge.deleteByUsernames(USERNAMES);
    const leftItems = await Item.count({ where: { player_id: [player.id, peer.id] } });
    const leftAch = await PlayerAchievement.count({ where: { player_id: [player.id, peer.id] } });
    check('A10 探针号清干净，背包行与成就记录都不留孤儿',
        (await Player.count({ where: { username: USERNAMES } })) === 0 && leftItems === 0 && leftAch === 0,
        `残留：物品 ${leftItems} 行、成就 ${leftAch} 行`);

    finish();

    function finish() {
        const failed = results.filter(r => !r.ok);
        console.log(`\n合计 ${results.length - failed.length}/${results.length} 项通过`);
        process.exit(failed.length ? 1 : 0);
    }
})().catch(async err => {
    console.error('探针异常:', err && (err.stack || err.message));
    try {
        await require('../game/persistence/PlayerCascadePurge')
            .deleteByUsernames(['achreward01', 'achreward02']);
    } catch (e) { console.warn('异常退出后的清场也失败了:', e.message); }
    process.exit(2);
});
