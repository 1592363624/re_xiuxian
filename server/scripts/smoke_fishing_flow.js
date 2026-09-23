/**
 * 灵溪垂钓真流程活体探针（需要 MySQL，走 .env 指向的隔离库 re_xiuxian_test）
 *
 * 为什么要这一条（2026-09-22，任务 #42）：`_rollFish` 里有一处 ReferenceError 存活了一整轮 ——
 * 250 条 GET 全绿、1276 项 jest 全绿，因为抽鱼只发生在 POST cast/nibble/reel 这条链上。
 * 更糟的是 `reel()` / `fillet()` 的 catch 把异常吞成 `{success:false, message:'…服务器内部错误'}`：
 * **异常在 HTTP 上长的是一个 400 业务失败的脸**，所以"0 条 5xx"这种判据结构上就抓不到它。
 * 这条探针因此不只看状态码：任何一步只要回执里出现"内部错误"就当场判红（那代表吞了异常），
 * 并且每一步都拿库里的行反查（回执说钓到什么 = 库里那一行是什么）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_fishing_flow.js
 *       自建账号 ff_probe；退出前删净三张钓鱼表并走级联清理。不改仓库里的任何配置。
 *
 * 控制跑（证明这些断言不是空跑；改完当场还原并 md5 核对）：
 *   ① 把 `_rollFish` 里 `isRareFish` 那处换回一个不存在的变量名（就是本轮修掉的形状）
 *      → F2/F5/F9 当场红，并且红的是"吞异常"那条而不是状态码；
 *   ② 注释掉 `reel()` 成功分支里的 `PlayerFishCatch.create` → F5 红（回执说有、库里没有）；
 *   ③ 注释掉 `reel()` 里 `now < session.nibble_at` 那条拒绝 → F3 红（提前提竿本该被拒）。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5096);
process.env.PORT = String(PORT);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}
/** 吞掉的异常在 HTTP 上是一个 400 —— 这条判据比状态码重要 */
const swallowed = body => /内部错误|internal/i.test(JSON.stringify(body || {}));

(async () => {
    const { initializeModules, infrastructure } = require('../modules');
    await initializeModules();
    await require('../game').initializeGameServices(infrastructure.ConfigLoader);

    const { app } = require('../index');
    const { bootApp, request, mintToken } = require('./lib/smoke_http');
    const sequelize = require('../config/database');
    const Player = require('../models/player');
    const PlayerFishing = require('../models/playerFishing');
    const PlayerFishCatch = require('../models/playerFishCatch');
    const PlayerFishAlbum = require('../models/playerFishAlbum');
    const InventoryService = require('../game/services/InventoryService');
    const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

    const USERNAME = 'ff_probe';
    const FishingService = require('../game/services/FishingService');
    const cfg = infrastructure.ConfigLoader.getConfig('fishing_data');
    const poolIds = key => ((cfg.fish_pools[key] || {}).fishes || []).map(f => f.id);
    const post = (path, token, body) => request({ port: PORT, method: 'POST', path: `/api/fishing/${path}`, token, body: body || {} });
    const get = (path, token) => request({ port: PORT, path: `/api/fishing/${path}`, token });
    const qty = itemKey => InventoryService.getItemQuantity(player.id, itemKey);

    await bootApp(app, { port: PORT });

    await PlayerCascadePurge.deleteByUsernames([USERNAME]).catch(() => {});
    const player = await Player.create({
        username: USERNAME, password: 'not-a-real-hash', nickname: '钓鱼流程探针',
        realm: '大乘中期', realm_rank: 60, exp: 0, spirit_stones: 500000,
        hp_current: 50000, mp_current: 10000, lifespan_current: 1000, lifespan_max: 5000,
        attack_power: 5000, defense_power: 3000, hp_max: 50000, mp_max: 10000, speed: 2000,
        luck: 50, sense: 5000, dao_heart: 50, invincible_until: '1970-01-01 00:00:00',
        titles: [], attributes: {}, amount: 0, inventory_capacity: 200, pvp_mode: 'peaceful',
        location_id: 1, current_floor: 1, highest_floor: 1
    });
    // 熟练度拉满：`empty_reduction_per_level × 100` 大于任何一口池的空竿率 → 钓获分支必然执行（探针不靠运气）
    await FishingService._getOrCreateFishing(player.id);
    await PlayerFishing.update(
        { rod_tier: 4, skill_level: cfg.skill.max_level, skill_exp: 999999, daily_casts: 0, active_session: null },
        { where: { player_id: player.id } }
    );
    const pondIds = Object.keys(cfg.ponds).filter(k => !k.startsWith('_'));
    const baits = [...new Set(pondIds.map(p => cfg.ponds[p].required_bait).filter(Boolean))];
    for (const baitKey of baits) await InventoryService.addItem(player.id, baitKey, 12);
    const baitStock = {};
    for (const baitKey of baits) baitStock[baitKey] = await qty(baitKey);
    check('F0 前置：四档钓竿 / 熟练度 / 四塘鱼饵都到位（账面=库存）',
        Object.values(baitStock).every(q => q >= 12),
        baits.map(b => `${b}=${baitStock[b]}`).join(' '));

    const token = mintToken(player);
    let casts = 0;

    /**
     * 一竿的完整链：cast → 快进会话时间戳 →（可选 nibble）→ reel。
     * 快进是必需的：现网最短等鱼讯 15 秒；这里只把会话里那两个时间戳挪动，
     * 判定仍走服务自己的分支（`now < nibble_at` / `now >= reel_deadline`）。
     */
    async function oneCast(pondId, { nibble = false, reelEarly = false } = {}) {
        const c = await post('cast', token, { pond_id: pondId });
        if (c.status !== 200 || swallowed(c.body)) return { cast: c, skipped: true };
        casts += 1;
        const row = await PlayerFishing.findOne({ where: { player_id: player.id } });
        const session = row.active_session;
        const preSelectedId = session && session.pre_selected_fish && session.pre_selected_fish.id;
        let nibbleRes = null;
        if (!reelEarly) {
            row.active_session = { ...session, nibble_at: Date.now() - 1000, reel_deadline: Date.now() + 60000 };
            await row.save();
            if (nibble) nibbleRes = await post('nibble', token);
        }
        const r = await post('reel', token);
        return { cast: c, preSelectedId, nibbleRes, reel: r };
    }

    // ---- F1 不存在的鱼塘：必须是业务拒绝，不是异常 ----
    const bad = await post('cast', token, { pond_id: 'zz_no_such_pond' });
    check('F1 cast 指向不存在的鱼塘 → 400 且理由是"鱼塘不存在"（不是吞掉的异常）',
        bad.status === 400 && /鱼塘不存在/.test(bad.body?.message || '') && !swallowed(bad.body),
        `${bad.status} ${bad.body?.message}`);

    // ---- F2/F4/F5 一竿走到底（`before` 必须在这条链**之前**数，否则数到的就是这条链自己写的那一行）----
    const pondA = pondIds[0];
    const poolA = cfg.ponds[pondA].fish_pool;
    const before = await PlayerFishCatch.count({ where: { player_id: player.id } });
    const first = await oneCast(pondA, { nibble: true });
    check('F2 cast 走通且预选鱼来自该塘自己的 fish_pools（_rollFish 经真 HTTP + 真钓竿执行）',
        !first.skipped && poolIds(poolA).includes(first.preSelectedId),
        `pool=${poolA} 预选=${first.preSelectedId}`);
    check('F4 nibble 成功（_rollFish 的第二个调用点也跑到，且试探次数入账）',
        first.nibbleRes?.status === 200 && !swallowed(first.nibbleRes?.body),
        `${first.nibbleRes?.status} ${first.nibbleRes?.body?.message}`);

    const reel = first.reel;
    const data = reel?.body?.data || {};
    const after = await PlayerFishCatch.count({ where: { player_id: player.id } });
    check('F5 reel 这一步真跑到了、且没有吞异常（出现"内部错误"就等于把 ReferenceError 藏回业务失败里）',
        !!reel && reel.status === 200 && !swallowed(reel.body),
        reel ? `${reel.status} ${reel.body?.message}` : '根本没走到 reel（上一步 cast 就被挡了）');
    check('F5 钓获回执与库里那一行一致（fish_id / 重量 / 只多一行）',
        data.result === 'success' && after === before + 1
        && Number(data.weight_kg) > 0 && poolIds(poolA).includes(data.fish_id),
        `回执 ${data.fish_id}/${data.weight_kg}，库里 ${before}→${after}`);
    const caughtRow = data.catch_id ? await PlayerFishCatch.findByPk(data.catch_id) : null;
    check('F5b 回执里的 catch_id 真能查到、属于这个号、且没被直接标成已剖',
        !!caughtRow && caughtRow.player_id === player.id && caughtRow.fish_id === data.fish_id
        && Number(caughtRow.is_filleted) === 0,
        caughtRow ? `#${caughtRow.id} ${caughtRow.fish_id}` : '无');

    // ---- F3 提竿太早：时间闸门方向（被拒之后会话还在，必须 give-up 收尾才谈得清下一竿）----
    const early = await oneCast(pondA, { reelEarly: true });
    check('F3 鱼讯未到就提竿 → 被拒且理由是"鱼讯还未到来"（不提前结算）',
        !early.skipped && early.reel.status === 400 && /鱼讯还未到来/.test(early.reel.body?.message || ''),
        `${early.reel?.status} ${early.reel?.body?.message}`);
    const giveUp = await post('give-up', token);
    const cleared = await PlayerFishing.findOne({ where: { player_id: player.id } });
    check('F3b give-up 清掉卡住的会话（否则玩家再也抛不了竿）',
        giveUp.status === 200 && !cleared.active_session, JSON.stringify(cleared.active_session));

    // ---- F9 四口塘挨个走一遍：每口都得能钓到本塘池里的鱼 ----
    const perPond = [];
    for (const pondId of pondIds) {
        const one = await oneCast(pondId);
        const ids = poolIds(cfg.ponds[pondId].fish_pool);
        perPond.push({
            pondId,
            ok: !one.skipped && !swallowed(one.reel?.body) && one.reel?.body?.data?.result === 'success'
                && ids.includes(one.reel.body.data.fish_id),
            detail: one.skipped ? `cast ${one.cast.status}/${one.cast.body?.message}`
                : (one.reel?.body?.data?.fish_id || one.reel?.body?.message)
        });
    }
    check(`F9 现网 ${pondIds.length} 口鱼塘各走一竿：都能钓到本塘池里的鱼、没有一口吞异常`,
        perPond.every(p => p.ok), perPond.map(p => `${p.pondId}=${p.detail}`).join(' '));

    // ---- F6 鱼篓与鱼谱：钓到的东西在界面上真看得到（不是只在回执里）----
    const creel = await get('creel?filter=unfilleted&page_size=50', token);
    const creelRows = (creel.body?.data?.catches || []).length;
    const unfilleted = await PlayerFishCatch.count({ where: { player_id: player.id, is_filleted: 0 } });
    check('F6 鱼篓接口条数 = 库里未剖行数（面板不少报）',
        creel.status === 200 && creelRows === unfilleted && unfilleted > 0, `接口 ${creelRows}，库里 ${unfilleted}`);
    const album = await get('album', token);
    const albumRows = await PlayerFishAlbum.count({ where: { player_id: player.id } });
    const allFishIds = new Set(Object.keys(cfg.fish_pools).filter(k => !k.startsWith('_'))
        .flatMap(k => poolIds(k)));
    check('F6b 鱼谱：已发现数 = 库里 album 行数；物种总数 = 各池鱼种并集（这条走的是 Object.values(fish_pools)）',
        album.status === 200 && album.body?.data?.discovered === albumRows
        && album.body?.data?.total_species === allFishIds.size && albumRows > 0,
        `下发 ${album.body?.data?.discovered}/${album.body?.data?.total_species}，库里 ${albumRows}，并集 ${allFishIds.size}`);

    // ---- F7 排行榜：那条用品质词表拼 FIELD(...) 的 SQL 必须逐类真跑 ----
    const rankingDetail = [];
    let rankingOk = true;
    for (const category of ['skill_level', 'biggest_catch_kg', 'rarest_catch_quality', 'total_success']) {
        const rk = await get(`ranking?category=${category}`, token);
        const hit = swallowed(rk.body);
        rankingOk = rankingOk && rk.status === 200 && !hit;
        rankingDetail.push(`${category}=${rk.status}${hit ? '(吞异常)' : ''}`);
    }
    check('F7 四个榜单类别都过（品质词表拼进 FIELD(...) 的那条 SQL 逐类执行）', rankingOk, rankingDetail.join(' '));

    // ---- F8 剖鱼：产出进包 = 配置算出来的数；同一条剖第二次必须被拒 ----
    const target = await PlayerFishCatch.findOne({ where: { player_id: player.id, is_filleted: 0 } });
    const fishConfig = Object.keys(cfg.fish_pools).filter(k => !k.startsWith('_'))
        .flatMap(k => cfg.fish_pools[k].fishes || []).find(f => f.id === target.fish_id);
    const filetBefore = await qty('ling_yu_rou');
    const fil = await post('fillet', token, { catch_id: target.id, quantity: 1 });
    const filetAfter = await qty('ling_yu_rou');
    check('F8 剖鱼：灵鱼肉入包 = 配置 filet_yield（账面=库存），回执数量也一致',
        fil.status === 200 && !swallowed(fil.body)
        && filetAfter - filetBefore === (fishConfig ? fishConfig.filet_yield : 0)
        && fil.body?.data?.filet_gained === filetAfter - filetBefore,
        `入包 ${filetBefore}→${filetAfter}，配置 ${fishConfig && fishConfig.filet_yield}，回执 ${fil.body?.data?.filet_gained}`);
    const again = await post('fillet', token, { catch_id: target.id, quantity: 1 });
    check('F8b 同一条鱼获剖第二次必须被拒（不重复产出）',
        again.status === 400 && /不存在或已剖/.test(again.body?.message || '') && !swallowed(again.body),
        `${again.status} ${again.body?.message}`);
    const cooked = await post('cook', token, { quantity: 1 });
    check('F8c 烹鱼一步不吞异常（消耗灵鱼肉换修为）',
        !swallowed(cooked.body) && [200, 400].includes(cooked.status),
        `${cooked.status} ${cooked.body?.message}`);

    // ---- F10 计数：竿数 = 真抛出去的次数；总成功数 >= 钓获行数 ----
    const finalRow = await PlayerFishing.findOne({ where: { player_id: player.id } });
    const totalCatches = await PlayerFishCatch.count({ where: { player_id: player.id } });
    check('F10 日竿数计数 = 探针真抛竿次数（不漏记也不虚增）',
        Number(finalRow.daily_casts) === casts, `库里 ${finalRow.daily_casts}，探针抛了 ${casts} 竿`);
    check('F10b total_success 与钓获行数一致（成功计数没和真实鱼获脱钩）',
        Number(finalRow.total_success) === totalCatches, `total_success=${finalRow.total_success}，鱼获 ${totalCatches} 行`);
    // ---- F11 熟练度：到顶归零是设计（`_addSkillExp` 在 max_level 那一支写 0），未满级必须真的累加 ----
    check('F11a 熟练度已满：level 停在 max、exp 归零（不是报错，也不是继续累加后凭空升一档）',
        Number(finalRow.skill_level) === cfg.skill.max_level && Number(finalRow.skill_exp) === 0,
        `skill_level=${finalRow.skill_level} skill_exp=${finalRow.skill_exp}`);
    await PlayerFishing.update({ skill_level: 5, skill_exp: 0 }, { where: { player_id: player.id } });
    const mid = await oneCast(pondA);                       // 满级之下再打一竿：这一竿不论中不中都该给经验
    const midRow = await PlayerFishing.findOne({ where: { player_id: player.id } });
    const expPer = mid.reel?.body?.data?.result === 'success'
        ? cfg.skill.exp_per_success : cfg.skill.exp_per_fail;
    check('F11b 未满级时熟练度经验真的入账（成功/失败两支都有数，且与配置一致）',
        !swallowed(mid.reel?.body) && Number(midRow.skill_exp) === expPer,
        `skill_exp=${midRow.skill_exp}，这一竿 ${mid.reel?.body?.data?.result || mid.reel?.body?.message}（配置 ${expPer}）`);

    // ===== Z 清场 =====
    await PlayerFishCatch.destroy({ where: { player_id: player.id }, force: true });
    await PlayerFishAlbum.destroy({ where: { player_id: player.id }, force: true });
    await PlayerFishing.destroy({ where: { player_id: player.id }, force: true });
    await PlayerCascadePurge.deleteByUsernames([USERNAME]);
    check('Z1 探针号与三张钓鱼表都清干净（0 残留）',
        (await Player.count({ where: { username: [USERNAME] } })) === 0
        && (await PlayerFishCatch.count({ where: { player_id: player.id } })) === 0
        && (await PlayerFishAlbum.count({ where: { player_id: player.id } })) === 0
        && (await PlayerFishing.count({ where: { player_id: player.id } })) === 0);

    const failed = results.filter(r => !r.ok);
    console.log(`\n合计 ${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close().catch(() => {});
    process.exit(failed.length ? 1 : 0);
})().catch(async err => {
    console.error('探针异常:', err && (err.stack || err.message));
    try {
        const Player = require('../models/player');
        const PlayerFishing = require('../models/playerFishing');
        const PlayerFishCatch = require('../models/playerFishCatch');
        const PlayerFishAlbum = require('../models/playerFishAlbum');
        const p = await Player.findOne({ where: { username: 'ff_probe' } });
        if (p) {
            await PlayerFishCatch.destroy({ where: { player_id: p.id }, force: true });
            await PlayerFishAlbum.destroy({ where: { player_id: p.id }, force: true });
            await PlayerFishing.destroy({ where: { player_id: p.id }, force: true });
        }
        await require('../game/persistence/PlayerCascadePurge').deleteByUsernames(['ff_probe']);
    } catch (e) { console.warn('异常退出后的清场也失败了:', e.message); }
    process.exit(2);
});
