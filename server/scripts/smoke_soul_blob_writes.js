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
    await Player.destroy({ where: { username: 'soulblob01' } });
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

    /* S6 第二元神：写的是 player_second_soul.attributes，这张表不在 players 那道守卫射程内 */
    await PlayerSecondSoul.destroy({ where: { player_id: player.id } });
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

    await PlayerSecondSoul.destroy({ where: { player_id: player.id } });
    await Player.destroy({ where: { id: player.id } });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try { await Player.destroy({ where: { username: 'soulblob01' } }); } catch {}
    process.exit(2);
});
