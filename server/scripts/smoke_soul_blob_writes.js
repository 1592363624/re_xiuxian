/**
 * 神魂 / 夺舍 / 第二元神这几条写整块 JSON 列的路径，以前没有任何活体覆盖
 * （smoke_write_crossflow 只测了恢复/吃丹/背包/功法/突破五条）。
 *
 * 判据两条，缺一不可：
 *   1. 哨兵键与"另一个键级写入"的键在并发之后都还在 —— 少任何一个就是有人在做整块覆盖
 *      （旧快照吃掉新快照，玩家数据永久丢失，既不报错也不自愈）；
 *   2. 被测流程本身必须真的跑通（success:true）。只判第 1 条会退化成空测：
 *      流程被"境界不足/状态不对"挡在门外时，它一个键都没写，两个键当然都还在。
 *
 * 2026-09-23 加了 S7/S8 三格，钉的是 `game/core/sensePool.js` 那份统一读扣的两个语义：
 *   S7 余额 0 不被 `|| 兜底` 复活（旧写法会把"用光了"读成"键不存在"，白送一份余额）；
 *   S9 出窍那条链上的同一条兜底（`|| 境界基数`）：余额 0 的人出一次窍，库里那一格不许被抬回 base_sense；
 *   S8a 八路各自拿着**旧快照**并发扣同一份神识，库里必须正好少"请求之和"（整块写回只会扣成一笔）；
 *   S8b 余额不够八笔抢时停在 0，且每份回执的 after 都是库里真值（$min 在行锁内判）。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_soul_blob_writes.js
 *       自建探针号 soulblob01，退出前删号。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5099);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerSecondSoul = require('../models/playerSecondSoul');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const SENTINEL = 'probe_marker';
const OTHER = 'probe_other_writer';
const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/**
 * 业务流程与另一条键级写入同时跑，事后判两件事：键都在 + 流程真跑通。
 * @param {string} label 流程名
 * @param {() => Promise<Object>} flow 被测流程
 * @param {Object} player 探针玩家
 */
async function race(label, flow, player) {
    await PlayerStateStore.patchPlayerState(player.id, {
        attributes: { [SENTINEL]: 'keep-me', [OTHER]: null }
    });
    const [outcome] = await Promise.all([
        Promise.resolve().then(flow).catch(error => ({ success: false, crashed: true, message: error.message })),
        PlayerStateStore.patchPlayerState(player.id, { attributes: { [OTHER]: 'written-by-other-flow' } })
    ]);
    const attrs = (await Player.findByPk(player.id)).attributes || {};
    const kept = attrs[SENTINEL] === 'keep-me';
    const otherOk = attrs[OTHER] === 'written-by-other-flow';
    const message = outcome && (outcome.message || String(outcome.success));
    check(
        `${label}：与键级写入并发后两个键都在，且流程本身跑通`,
        kept && otherOk && outcome && outcome.success === true,
        `哨兵=${kept ? '在' : '被抹掉'}, 对方键=${otherOk ? '在' : '被抹掉'}, 流程=${message}`
    );
    return outcome;
}

(async () => {
    await bootApp(app, { port: PORT });
    // 开头按账号名清历次残留（不是按 id）：崩过一次的那轮留下的派生行，新 id 永远找不回来
    await PlayerCascadePurge.deleteByUsernames(['soulblob01']);
    const player = await Player.create({
        username: 'soulblob01', password: 'not-a-real-hash', nickname: '神魂探针',
        realm: '炼虚初期', realm_rank: 27, exp: 5000000, spirit_stones: 100000000,
        hp_current: 5000000, mp_current: 500000, lifespan_current: 300, lifespan_max: 5000,
        attributes: {}, token_version: 0,
        soul_state: 'none', daily_soul_out_count: 0, daily_fracture_explore_count: 0,
        daily_tianji_revert_count: 0, dharma_form_level: 3, remnant_soul: 500
    });
    await PlayerStateStore.patchPlayerState(player.id, {
        attributes: {
            [SENTINEL]: 'keep-me', hp_current: 5000000, mp_current: 500000,
            sense: 500000, divine_sense: 500000, reincarnation_state: 'none'
        }
    });

    const NascentSoul = require('../game/services/NascentSoulService');
    const Reincarnation = require('../game/services/ReincarnationService');
    const SecondSoul = require('../game/services/SecondSoulService');
    const sensePool = require('../game/core/sensePool');

    /* S1 元婴出窍：事务里锁行后整块写回 attributes */
    await race('S1 元婴出窍 startSoulOut', () => NascentSoul.startSoulOut(player.id, 'explore', 60), player);
    await sequelize.query("UPDATE players SET soul_state='none', soul_out_start_time=NULL, soul_out_end_time=NULL, daily_soul_out_count=0, last_soul_out_date=NULL, last_soul_out_time=NULL WHERE id = " + player.id);

    /* S2 法相修炼（需化神后期）、S3 裂隙探渊（需炼虚初期） */
    await race('S2 法相修炼 cultivateDharmaForm', () => NascentSoul.cultivateDharmaForm(player.id), player);
    await sequelize.query("UPDATE players SET daily_fracture_explore_count=0, last_fracture_explore_time=NULL WHERE id = " + player.id);
    await race('S3 裂隙探渊 exploreFracture', () => NascentSoul.exploreFracture(player.id), player);

    /* S4 天机逆转：要处于虚弱状态（否则它自己判定"无需回溯"，一个键都不写） */
    await sequelize.query("UPDATE players SET weakness_end_time = DATE_ADD(NOW(), INTERVAL 1 HOUR), daily_tianji_revert_count=0, last_tianji_revert_date=NULL WHERE id = " + player.id);
    await race('S4 天机逆转 tianjiRevert', () => NascentSoul.tianjiRevert(player.id), player);

    /*
     * S7 余额 0 是"花光了"，不是"这个键不存在"。
     * 旧写法 `attrs.sense || 10` / `|| 境界基数` 在这里会先把 0 读成一份兜底余额，
     * 再扣一次消耗 —— 于是"把神识用光的人"白拿一份，而且库里那一格被抬到一个跟消耗无关的数。
     * 判据取两端：流程必须**因为神识不足**被拒（不是被冷却/次数挡掉，那样这条断言是空测），
     * 且事后库里仍是 0。
     */
    await sequelize.query("UPDATE players SET daily_fracture_explore_count=0, last_fracture_explore_time=NULL, soul_state='none' WHERE id = " + player.id);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { sense: 0 } });
    const zeroRun = await NascentSoul.exploreFracture(player.id).catch(err => ({ success: false, message: `抛了：${err.message}` }));
    const rowAfterZero = (await Player.findByPk(player.id)).attributes || {};
    check('S7 神识余额 0：被拒的理由是"神识不足"，且库里没被兜底抬起来',
        zeroRun.success === false && /神识不足/.test(String(zeroRun.message)) && Number(rowAfterZero.sense) === 0,
        `回执=${zeroRun.message}, 库里 sense=${rowAfterZero.sense}, 哨兵=${rowAfterZero[SENTINEL]}`);

    /*
     * S9 出窍那条链上的同一件事，但量的是"会不会凭空把余额抬回去"。
     * 消耗 = floor(境界基数 × sense_consumption_rate × 时长/3600)，最短时长下通常只有几点甚至 0 点，
     * 而旧写法在余额 0 时先把它读成 `baseSense`，于是"花光的人"一次出窍就把余额抬回接近整个境界基数，
     * 下一次的探渊/法相（消耗 50/100）就又花得起了 —— 这就是那条兜底在现网真的会漏的地方。
     */
    await sequelize.query("UPDATE players SET soul_state='none', soul_out_start_time=NULL, soul_out_end_time=NULL, daily_soul_out_count=0, last_soul_out_date=NULL, last_soul_out_time=NULL WHERE id = " + player.id);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { sense: 0 } });
    const beforeOut = Number(((await Player.findByPk(player.id)).attributes || {}).sense);
    const outRun = await NascentSoul.startSoulOut(player.id, 'explore', 300).catch(err => ({ success: false, message: `抛了：${err.message}` }));
    const rowAfterOut = (await Player.findByPk(player.id)).attributes || {};
    const outRealm = require('../game/core/RealmService').getRealmByName((await Player.findByPk(player.id)).realm);
    const outBaseSense = Number(outRealm?.base_sense || 0);
    // 旧写法在这一刻会把余额写成 `baseSense − 消耗`（消耗通常只有几点甚至 0 点），
    // 所以"库里仍是 0"这一条正是那条兜底的分水岭；出窍本身成不成都可以（消耗为 0 时 0 ≥ 0 合法）。
    const outOkOrRefused = outRun.success === true || /神识不足/.test(String(outRun.message));
    check('S9 余额 0 时出窍：库里那一格不会被兜底抬回境界基数（旧写法会凭空多出 base_sense − 消耗）',
        beforeOut === 0 && Number(rowAfterOut.sense) === 0 && outOkOrRefused && outBaseSense > 0,
        `出窍=${outRun.message}, 库里 sense ${beforeOut}→${rowAfterOut.sense}, `
        + `该境界(${outRealm?.name}) base_sense=${outBaseSense}（旧写法这里会写成 ≈${outBaseSense} −消耗）`);
    await sequelize.query("UPDATE players SET soul_state='none', soul_out_start_time=NULL, soul_out_end_time=NULL, daily_soul_out_count=0, last_soul_out_date=NULL, last_soul_out_time=NULL WHERE id = " + player.id);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { sense: 500000 } });

    /*
     * S8 八路并发扣同一份神识：每一路手上都拿着"还没扣"的那份快照（这正是一条链上读与写之间夹了
     * 几个 await 的真实形状）。旧写法八笔只会被写成一笔；键级 $add 必须让库里正好少 800。
     * 只判"库里"那一侧：回执里的 `before` 是**调用方那份快照**上的值，八条腿各拿一份 1000，
     * 把它们加起来必然对不上库（这是那份回执的语义，不是丢账 —— 要"库里现在多少"读 after）。
     */
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { sense: 1000 } });
    const eightLegs = await Promise.all(Array.from({ length: 8 }, () =>
        Player.findByPk(player.id).then(fresh => sensePool.spendSense(fresh, 100, {}))));
    const rowEight = (await Player.findByPk(player.id)).attributes || {};
    check('S8a 八路并发扣神识（各自拿着旧快照）：库里正好少 8×100，八份 after 都是库里真值',
        Number(rowEight.sense) === 200 && eightLegs.every(leg => leg.after >= 0)
        && new Set(eightLegs.map(leg => leg.after)).size === 8,
        `库里 1000→${rowEight.sense}, after=${eightLegs.map(l => l.after).sort((a, b) => b - a).join('/')}, 哨兵=${rowEight[SENTINEL]}`);

    await PlayerStateStore.patchPlayerState(player.id, { attributes: { sense: 300 } });
    const contested = await Promise.all(Array.from({ length: 8 }, () =>
        Player.findByPk(player.id).then(fresh => sensePool.spendSense(fresh, 100, {}))));
    const rowContested = (await Player.findByPk(player.id)).attributes || {};
    check('S8b 余额只够三笔时：库里停在 0（不扣成负数），八份 after 全部非负且过半为 0',
        Number(rowContested.sense) === 0 && contested.every(leg => leg.after >= 0)
        && contested.filter(leg => leg.after === 0).length >= 5,
        `库里 300→${rowContested.sense}, after=${contested.map(l => l.after).sort((a, b) => b - a).join('/')}`);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { sense: 500000 } });

    /* S5 夺舍选目标：先触发夺舍拿到目标缓存，再选 */
    await sequelize.query("UPDATE players SET is_dead=1, death_reason='pvp_kill', last_reincarnation_time=NULL WHERE id = " + player.id);
    const triggered = await Reincarnation.triggerReincarnation(player.id, 'pvp_kill');
    check('S5a 夺舍触发成功并拿到目标缓存（否则 S5 是空测）',
        triggered && triggered.success === true,
        `${triggered && (triggered.message || triggered.success)}`);
    const targetId = triggered?.data?.targets?.[0]?.target_id;
    await race('S5 夺舍选目标 chooseTarget', () => Reincarnation.chooseTarget(player.id, targetId, {}), player);
    await sequelize.query("UPDATE players SET is_dead=0, death_reason=NULL WHERE id = " + player.id);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { reincarnation_state: 'none' } });

    /* S6 第二元神：写的是 player_second_soul.attributes，这张表不在 players 那道守卫射程内
       （这一行按 player_id 归属，开头的按账号名清残留已经用级联把它带走了，不必再手写） */
    const soul = await PlayerSecondSoul.create({
        player_id: player.id, soul_index: 2, soul_name: '第二元神', soul_type: 'second',
        realm: '元婴初期', realm_rank: 19, exp: 0, is_active: true, is_cultivating: false,
        attributes: { probe_soul_marker: 'keep-me' }
    });
    const two = await Promise.all([
        SecondSoul.gmAdjustAttributes(player.id, 2, { atk: 7 }),
        SecondSoul.gmAdjustAttributes(player.id, 2, { def: 9 })
    ]);
    const merged = (await PlayerSecondSoul.findByPk(soul.id)).attributes || {};
    check('S6 第二元神两次并发调整属性互不抹掉（这张表没有 players 那道守卫）',
        two.every(r => r && r.success === true)
            && Number(merged.atk) === 7 && Number(merged.def) === 9
            && merged.probe_soul_marker === 'keep-me',
        `返回=${two.map(r => r && (r.message || r.success)).join(' | ')}；attributes=${JSON.stringify(merged)}`);

    /* S6b/S6c GM 调整副元神的允许清单现在就是属性注册表：资料片那一档要能调，注册表外的键仍要拒 */
    const packStat = 'blood_power';            // 只由「魔道血修遗篇」声明
    const s6b = await SecondSoul.gmAdjustAttributes(player.id, 2, { [packStat]: 66 });
    const afterPack = (await PlayerSecondSoul.findOne({
        where: { player_id: player.id, soul_index: 2 }
    }) || {}).attributes || {};
    check('S6b 资料片新属性（血元）能被 GM 直接调，不必先往代码里的白名单补一行',
        s6b.success === true && Number(afterPack[packStat]) === 66
            && Number(afterPack.atk) === 7 && Number(afterPack.def) === 9
            && afterPack.probe_soul_marker === 'keep-me',
        `返回=${s6b.message || s6b.success}；attributes=${JSON.stringify(afterPack)}`);

    const s6c = await SecondSoul.gmAdjustAttributes(player.id, 2, { not_a_registered_stat: 1 });
    const afterReject = (await PlayerSecondSoul.findOne({
        where: { player_id: player.id, soul_index: 2 }
    }) || {}).attributes || {};
    check('S6c 注册表外的键仍然被拒、且不落库（放开成"什么都能塞"不是这次改造的目的）',
        s6c.success === false && /至少需要提供一个有效属性/.test(String(s6c.message))
            && afterReject.not_a_registered_stat === undefined,
        `返回=${s6c.message}；attributes=${JSON.stringify(afterReject)}`);

    // 收尾只叫一次"删号"：player_second_soul 这些按 player_id 归属的行由级联带走，探针不再自己列表
    const purged = await PlayerCascadePurge.deletePlayers([player.id]);
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try { await PlayerCascadePurge.deleteByUsernames(['soulblob01']); } catch {}
    process.exit(2);
});
