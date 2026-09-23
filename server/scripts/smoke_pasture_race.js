/**
 * 放养 ↔ 偷菜 并发探针（需要 MySQL，走 .env 指向的库）
 *
 * 测的是 BeastPastureService 的锁顺序契约：SpiritBeast → SpiritBeastPasture → PlayerGarden。
 * 改之前 stealCrops 用**无锁**读拿放养记录，然后 save() 整行写回（steal_count / steal_yields），
 * 而 recallBeast 是「先锁放养行、再锁灵兽行」—— 两把锁的获取次序正好相反，于是：
 *   1) ABBA 死锁：其中一笔被 MySQL 杀掉，玩家看到 500；
 *   2) 丢失更新：召回写下的 status=recalled / actual_end_time / yield_snapshot 被偷菜那笔
 *      按旧快照整行写回去，放养记录复活成 active，产物凭空消失。
 * 这两种都只在两个请求交错时出现，单请求永远正确，所以纯逻辑测试测不到，必须真并发打。
 *
 * 每轮都重新播种，跑 ROUNDS 轮，断言的是不变量而不是某一轮的顺序：
 *   - 两笔请求都不许出现 500/超时（死锁）
 *   - 召回返回 200 时，落库必须是已结束态（不许被写回 active）
 *   - 偷菜成功且召回也成功时，两笔的写入必须同时可见
 *   - 至少要有 1 轮真的命中「偷菜成功 + 召回 200」的交叉，否则整个探针是空测
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_pasture_race.js
 *       探针自建两个专用账号（smokepasture / smokepasture_victim），只动它们的行。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5090);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const SpiritBeast = require('../models/spiritBeast');
const SpiritBeastPasture = require('../models/spiritBeastPasture');
const PlayerGarden = require('../models/playerGarden');
const Item = require('../models/item');   // 玩家背包的行都住在这张表（容量=行数）
const GardenStealLog = require('../models/gardenStealLog');
const sequelize = require('../config/database');
const { bootApp, request, mintToken } = require('./lib/smoke_http');

const ROUNDS = Number(process.env.SMOKE_ROUNDS || 10);
const THIEF = 'smokepasture';
const VICTIM = 'smokepasture_victim';
const SEED_ID = 'spirit_seed';
const PRODUCE_ITEM_ID = 'wild_herb';

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function post(token, path, body) {
    const res = await request({ port: PORT, method: 'POST', path, token, body });
    return { code: res.body?.code ?? res.status, status: res.status, body: res.body, raw: res.raw };
}

/** 偷菜成功率 = base + 速度 + 忠诚 + 星级 + 无护院加成，把灵兽喂满即可稳定 >1，让交叉可复现 */
async function ensurePlayer(username, nickname) {
    let player = await Player.findOne({ where: { username } });
    if (!player) {
        player = await Player.create({
            username,
            password: 'not-a-real-hash',
            nickname,
            realm: '炼气3层',
            realm_rank: 4,
            exp: 0,
            spirit_stones: 0,
            hp_current: 1000,
            mp_current: 1000,
            lifespan_current: 20,
            attributes: {},
            token_version: 0
        });
    }
    return player;
}

async function ensureBeast(playerId) {
    let beast = await SpiritBeast.findOne({ where: { player_id: playerId } });
    if (!beast) {
        beast = await SpiritBeast.create({
            player_id: playerId,
            beast_key: 'qingyun_wolf',
            beast_name: '探针青狼',
            element: 'metal',
            rarity: 'rare',
            star_level: 10,
            level: 10,
            exp: 0,
            hp_max: 5000,
            atk: 100,
            def: 100,
            speed: 300,
            loyalty: 100,
            is_active: false,
            is_pasturing: false,
            stamina: 100
        });
    }
    return beast;
}

async function seedRound(thief, victim, beastId, baseYield = 9) {
    // 偷菜最后一步是"把作物放进贼的背包"，只有真放进去了才记进 steal_yields（服务里的口径）。
    // 背包满了 grantItems 会静默失败 → 记录不写 → 这条探针就把它当成"并发丢写"报红了
    // （2026-09-21 实测：串行一笔也复现，reason=储物袋容量不足（上限 100），接口却回 result=success）。
    // 探针号自己的背包开局清一次，保证断言测的是并发而不是容量。
    await Item.destroy({ where: { player_id: thief.id } });
    await GardenStealLog.destroy({ where: { attacker_player_id: thief.id } });
    await SpiritBeastPasture.destroy({ where: { player_id: thief.id } });
    await SpiritBeast.update(
        { is_pasturing: false, is_active: false, speed: 300, loyalty: 100, star_level: 10 },
        { where: { id: beastId } }
    );
    // 被偷方不能带护院（出战灵兽），否则拦截会把结果随机掉，交叉就不可复现了
    await SpiritBeast.update({ is_active: false }, { where: { player_id: victim.id } });

    let plot = await PlayerGarden.findOne({ where: { player_id: victim.id, plot_index: 1 } });
    const fields = {
        seed_id: SEED_ID,
        produce_item_id: PRODUCE_ITEM_ID,
        status: 'mature',
        base_yield: baseYield,
        planted_at: new Date(Date.now() - 3 * 3600 * 1000),
        mature_at: new Date(Date.now() - 2 * 3600 * 1000)
    };
    if (plot) await plot.update(fields);
    else await PlayerGarden.create({ player_id: victim.id, plot_index: 1, ...fields });
}

async function main() {
    await bootApp(app, { port: PORT });

    const thief = await ensurePlayer(THIEF, '放养探针');
    const victim = await ensurePlayer(VICTIM, '药园探针');
    const beast = await ensureBeast(thief.id);
    const thiefToken = mintToken(thief);

    let hardFailures = [];
    let lostUpdates = [];
    let clobberedRecalls = [];
    let overlapRounds = 0;
    let stealSuccess = 0;
    let stealRejected = 0;
    let otherOutcomes = 0;
    let recallOk = 0;

    // S0：先跑一笔**完全不并发**的偷菜。这条探针以前一上来就断"两笔写入被互相抹掉"，
    // 却从没验过串行那一笔到底记没记上 —— 于是"根本没落库"和"被并发覆盖"这两种成因分不开
    // （2026-09-21 就是这样：改成"赋新数组"之后仍然 6/6 轮失败，说明成因不止一个）。
    {
        await seedRound(thief, victim, beast.id);
        const sStart = await post(thiefToken, '/api/spirit-beast/pasture/start', {
            beast_id: beast.id, location_key: 'qingyun_mountain', duration_hours: 1
        });
        let sOk = false; let sDetail = '';
        if (sStart.code !== 200) {
            sDetail = `放养启动就失败: ${JSON.stringify(sStart.body || sStart.raw).slice(0, 160)}`;
        } else {
            const sSteal = await post(thiefToken, '/api/spirit-beast/pasture/steal', {
                beast_id: beast.id, target_player_id: victim.id, target_plot_index: 1
            });
            const sRow = await SpiritBeastPasture.findByPk(sStart.body.data.pasture_id);
            const sYields = Array.isArray(sRow?.steal_yields) ? sRow.steal_yields : [];
            const sResult = sSteal.body?.data?.result;
            sOk = sResult === 'success' && Number(sRow?.steal_count) >= 1 && sYields.length >= 1;
            sDetail = `result=${sResult} count=${sRow?.steal_count} yields=${sYields.length} `
                + `响应=${JSON.stringify(sSteal.body?.data ?? sSteal.body).slice(0, 200)}`;
            await post(thiefToken, '/api/spirit-beast/pasture/recall', { beast_id: beast.id });
        }
        check('S0 串行偷菜（没有并发对手）：成功那一笔记的收获要在 steal_yields 里', sOk, sDetail);
    }

    // P6：一次把地块**偷空**（base_yield=1 → 偷完 newBaseYield=0 → 走"地块清空"那一支）。
    // 这一支以前先把 produce_item_id / seed_id 写成 null，**之后**才读它去发货 → 读到 null：
    // 地里那份作物哪也没去（贼没拿到、steal_yields 不记、接口还回 success）。S0 的产量是 9，
    // 永远走不到这一支，所以这个洞跟这条探针共存了很久没被发现。断的是账面=库存。
    {
        await seedRound(thief, victim, beast.id, 1);
        const p6Start = await post(thiefToken, '/api/spirit-beast/pasture/start', {
            beast_id: beast.id, location_key: 'qingyun_mountain', duration_hours: 1
        });
        let p6Ok = false; let p6Detail = '';
        if (p6Start.code !== 200) {
            p6Detail = `放养启动就失败: ${JSON.stringify(p6Start.body || p6Start.raw).slice(0, 160)}`;
        } else {
            const p6Steal = await post(thiefToken, '/api/spirit-beast/pasture/steal', {
                beast_id: beast.id, target_player_id: victim.id, target_plot_index: 1
            });
            const d6 = p6Steal.body?.data || {};
            const bagRows = await Item.findAll({
                where: { player_id: thief.id, item_key: PRODUCE_ITEM_ID }, attributes: ['quantity']
            });
            const inBag = bagRows.reduce((s, r) => s + Number(r.quantity), 0);
            const plot6 = await PlayerGarden.findOne({ where: { player_id: victim.id, plot_index: 1 } });
            const row6 = await SpiritBeastPasture.findByPk(p6Start.body.data.pasture_id);
            const yields6 = Array.isArray(row6?.steal_yields) ? row6.steal_yields : [];
            p6Ok = d6.result === 'success' && Number(d6.stolen_qty) === 1
                && inBag === 1 && Number(d6.stolen_landed_qty) === 1
                && plot6?.status === 'empty' && yields6.length >= 1
                && /获得 1 个作物/.test(String(d6.message || ''));
            p6Detail = `result=${d6.result} 报出偷到=${d6.stolen_qty} 真入库=${inBag} 报"收到"=${d6.stolen_landed_qty}`
                + `｜地块=${plot6?.status}｜steal_yields=${yields6.length} 条｜话术="${d6.message}"`
                + `｜载荷里的物品键=${d6.produce_item_id}`;
            await post(thiefToken, '/api/spirit-beast/pasture/recall', { beast_id: beast.id });
        }
        check('P6 把地块一次偷空：作物必须真的进贼的背包（不许"地被清、货没发、还报成功"）', p6Ok, p6Detail);
    }

    for (let round = 1; round <= ROUNDS; round++) {
        await seedRound(thief, victim, beast.id);
        const start = await post(thiefToken, '/api/spirit-beast/pasture/start', {
            beast_id: beast.id,
            location_key: 'qingyun_mountain',
            duration_hours: 1
        });
        if (start.code !== 200) {
            hardFailures.push(`第${round}轮放养启动就失败: ${JSON.stringify(start.body || start.raw)}`);
            break;
        }

        // 核心：两笔请求争同一条"灵兽 → 放养记录"的锁。
        // 一半轮次延迟 40ms 再发召回 —— 偷菜那笔前面要先查两张冷却表，天然比召回慢，
        // 同时发基本是召回先跑完（实测有整轮 0 交叉的情况，那样"两笔写入都在"就成了空断言）。
        // 让召回正好落在偷菜的"读放养记录 → 整行写回"窗口里，才是这条缺陷的靶心。
        const delayed = round % 3 !== 0;
        const stealPromise = post(thiefToken, '/api/spirit-beast/pasture/steal', {
            beast_id: beast.id,
            target_player_id: victim.id,
            target_plot_index: 1
        });
        const recallPromise = (delayed
            ? new Promise(resolve => setTimeout(resolve, 40)).then(() => null)
            : Promise.resolve()
        ).then(() => post(thiefToken, '/api/spirit-beast/pasture/recall', { beast_id: beast.id }));

        const [steal, recall] = await Promise.all([stealPromise, recallPromise]);

        const row = await SpiritBeastPasture.findByPk(start.body.data.pasture_id);
        const afterBeast = await SpiritBeast.findByPk(beast.id);
        const detail = `第${round}轮 steal=${steal.code}/${steal.body?.data?.result ?? '-'} recall=${recall.code} db=${row?.status}/${row?.recall_type}`;

        for (const [label, res] of [['steal', steal], ['recall', recall]]) {
            if (res.status >= 500 || res.body?.code === 500 || res.status === 0) {
                hardFailures.push(`${detail} ${label} 失败态: ${JSON.stringify(res.body || res.raw)}`);
            }
        }
        if (steal.body?.data?.result === 'success') stealSuccess++;
        else if (steal.code === 400) stealRejected++;
        else if (['failed', 'intercepted'].includes(steal.body?.data?.result)) otherOutcomes++;
        else hardFailures.push(`${detail} steal 返回了预期外的码: ${JSON.stringify(steal.body || steal.raw)}`);

        if (recall.code === 200) {
            recallOk++;
            if (!row || row.status === 'active' || !row.actual_end_time) {
                clobberedRecalls.push(`${detail} 召回写回放养行后被整行盖回: ${JSON.stringify(row && { s: row.status, e: row.actual_end_time })}`);
            }
            if (steal.body?.data?.result === 'success') {
                overlapRounds++;
                const yields = Array.isArray(row?.steal_yields) ? row.steal_yields : [];
                if (!row || Number(row.steal_count) < 1 || yields.length < 1) {
                    lostUpdates.push(`${detail} 偷菜的写入被召回抹掉: steal_count=${row?.steal_count} yields=${yields.length}`);
                }
            }
        }
        if (afterBeast?.is_pasturing) hardFailures.push(`${detail} 灵兽 is_pasturing 未复位`);
        console.log(`  · ${detail}`);
    }

    check('并发 steal/recall 不出现 500、超时或死锁', hardFailures.length === 0,
        hardFailures.slice(0, 3).join(' | ') || `${ROUNDS} 轮全部干净`);
    check('召回成功时放养行不会被旧快照写回 active', clobberedRecalls.length === 0,
        clobberedRecalls.slice(0, 3).join(' | ') || `召回 200 共 ${recallOk} 轮`);
    check('偷菜与召回同时成功时两笔写入都在', lostUpdates.length === 0,
        lostUpdates.slice(0, 3).join(' | ') || `交叉 ${overlapRounds} 轮`);
    check('探针不是空测：至少 1 轮真的出现「偷菜成功 + 召回 200」', overlapRounds >= 1,
        `偷菜成功 ${stealSuccess} 轮 / 召回先提交被拒 ${stealRejected} 轮 / 未命中 ${otherOutcomes} 轮 / 交叉 ${overlapRounds} 轮`);
    check('两把锁的争用真的发生过（召回与偷菜并非各跑各的）', recallOk >= 1 && stealSuccess + stealRejected >= 1,
        `recall200=${recallOk}`);
}

(async () => {
    await main();
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
