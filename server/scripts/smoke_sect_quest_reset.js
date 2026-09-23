/**
 * 宗门日常任务：面板的跨天清零会不会吃掉并发写入（需要 MySQL，走 .env 指向的隔离库）
 *
 * 症状形状（objective 里"旧快照覆盖新快照"那条的一个具体实例）：
 *   `SectService.getQuests` 是 GET 面板，读到 `quests_reset_at` 已过期的那一份之后，
 *   会**不带锁**地把 `daily_quests_completed / quests_accepted / quests_accepted_at` 整列写回 []。
 *   与它交错的 `acceptQuest` / `submitQuest` 都是加锁写。于是：
 *     T0 面板读到昨天那份（空列表、reset_at 过期）
 *     T1 acceptQuest 加锁提交：quests_accepted=[Q]、reset_at 推到明天
 *     T2 面板那次 save() 无条件把整列写回 []
 *   玩家丢了"今日已接取"标记 —— 而 submitQuest 只校验"已接取过没有"，
 *   所以同一个日常任务当天能再接一遍、再领一遍贡献度与修为。跟太一门双领同一类，只是要跨零点才撞上。
 *
 * 修法不是给面板加行锁（GET 面板持行锁不合适），而是把那次写变成**条件写**：
 * "这一行仍然到期"才写，打不中就重读一份来渲染。条件故意不写成"等于我读到的那个时间戳"，
 * 因为 DATETIME 往返一旦差一秒就永远打不中，等于悄悄退回无条件写。
 *
 * 探针不靠"祈祷两个请求正好交错"：先把 T0 那份旧快照抓在手里，让 acceptQuest 真提交（T1），
 * 再把面板那一次读**换成那份旧快照**跑 T2。判的是回读库，不是返回码。
 *
 * 用法：cd server && SMOKE_PORT=5093 node --env-file=.env scripts/smoke_sect_quest_reset.js
 * 只用自建探针号 sectreset01，跑完删号。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5093);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerSect = require('../models/playerSect');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const SectService = require('../game/services/SectService');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const ACCOUNT = 'sectreset01';
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

/** 找一个内容里真存在、且有 daily 任务的宗门（走服务自己的入口，资料片加的宗门才算数） */
function pickSectAndQuest() {
    for (const sect of SectService.getSectConfig()) {
        const quest = (sect.quests || []).find(q => q.id && q.daily);
        if (quest) return { sect, quest };
    }
    throw new Error('内容里找不到带 daily 任务的宗门，探针没法跑');
}

async function ensureProbePlayer(sectId) {
    // 开头按账号名清历次残留（只走级联那扇门）：崩过一次的那轮留下的关系行按新 id 永远找不回来
    await PlayerCascadePurge.deleteByUsernames([ACCOUNT]);
    const player = await Player.create({
        username: ACCOUNT,
        password: 'not-a-real-hash',
        nickname: '宗门任务探针',
        realm: '炼气3层',
        realm_rank: 3,
        exp: 0,
        spirit_stones: 0,
        hp_current: 5000,
        mp_current: 5000,
        lifespan_current: 120,
        attributes: {},
        token_version: 0
    });
    // player_sects 按 player_id 归属，级联已随上一步把历次残留带走；新号还没有关系行，不必再手写一遍 destroy
    const row = await PlayerSect.create({
        player_id: player.id,
        sect_id: sectId,
        role: 'disciple',
        contribution: 9999,
        daily_quests_completed: [],
        quests_accepted: ['昨日的任务-应该被清零'],
        quests_accepted_at: { '昨日的任务-应该被清零': new Date().toISOString() },
        quests_reset_at: new Date(Date.now() - 86400000)      // 昨天：已过期，面板会想清零
    });
    return { player, row };
}

async function reload(playerId) {
    return PlayerSect.findOne({ where: { player_id: playerId } });
}

/** 让"面板那次无事务的读"拿到我们指定的旧快照，其余读原样（加锁的读带 transaction，不受影响） */
function withStalePanelRead(stale, run) {
    const real = PlayerSect.findOne.bind(PlayerSect);
    let used = false;
    PlayerSect.findOne = async (options = {}) => {
        if (!used && !options.transaction) { used = true; return stale; }
        return real(options);
    };
    return run().then(r => ({ r, used })).finally(() => { PlayerSect.findOne = real; });
}

async function main() {
    await bootApp(app, { port: PORT });
    const { sect, quest } = pickSectAndQuest();
    const { player, row } = await ensureProbePlayer(sect.id);

    // ---- 前置：确认种下去的确实是"过期 + 有旧数据"，否则后面全是空测 ----
    const seeded = await reload(player.id);
    check('S0 播种确实是已过期的清零条件（探针靶心存在）',
        seeded.quests_reset_at && new Date(seeded.quests_reset_at) < new Date()
        && (seeded.quests_accepted || []).length === 1,
        `reset_at=${seeded.quests_reset_at} accepted=${JSON.stringify(seeded.quests_accepted)}`);

    // ---- T0：面板先读到这一份（旧快照） ----
    const stale = await reload(player.id);

    // ---- T1：加锁写入真的提交（接取今天的任务，它自己也会做跨天清零） ----
    const accepted = await SectService.acceptQuest(player.id, quest.id);
    check('S1 acceptQuest 真的成功（否则整个交错没发生）', accepted.success === true, accepted.message);
    const afterAccept = await reload(player.id);
    check('S2 加锁写入落库：今天这个任务已在 quests_accepted 里',
        (afterAccept.quests_accepted || []).includes(quest.id), JSON.stringify(afterAccept.quests_accepted));

    // ---- T2：面板拿 T0 那份旧快照跑清零写入 ----
    const { r: panel, used } = await withStalePanelRead(stale, () => SectService.getQuests(player.id));
    check('S3 面板确实吃到了我们塞的旧快照（不然 S4/S5 是空测）', used === true, `注入被用到=${used}`);

    const afterPanel = await reload(player.id);
    check('S4 旧快照没能抹掉并发提交的接取记录（回归点）',
        (afterPanel.quests_accepted || []).includes(quest.id),
        `面板之后库里是 ${JSON.stringify(afterPanel.quests_accepted)}`);
    check('S5 面板报给界面的状态与库里一致（不是拿旧快照显示）',
        (panel.quests || []).some(q => q.id === quest.id && q.accepted === true),
        JSON.stringify((panel.quests || []).filter(q => q.id === quest.id).map(q => q.accepted)));

    // ---- 清零本身仍然要发生（不能为了安全把它整个关掉）----
    check('S6 跨天清零仍然生效：昨天那条接取已不在列表里',
        !(afterPanel.quests_accepted || []).some(id => String(id).startsWith('昨日')),
        JSON.stringify(afterPanel.quests_accepted));
    check('S7 清零后 reset_at 被推到未来（不是每次刷新都重写一遍）',
        afterPanel.quests_reset_at && new Date(afterPanel.quests_reset_at) > new Date(),
        `reset_at=${afterPanel.quests_reset_at}`);

    // ---- 不重复写：同一行没过期时，面板一个键都不该动 ----
    const sentinel = { '钉住的键': '别写我' };
    await PlayerSect.update({ quests_accepted_at: sentinel }, { where: { player_id: player.id } });
    await SectService.getQuests(player.id);
    const untouched = await reload(player.id);
    check('S8 未过期时面板不再写这行（幂等，不刷 updated_at / 不覆盖哨兵）',
        untouched.quests_accepted_at && Object.prototype.hasOwnProperty.call(untouched.quests_accepted_at, '钉住的键'),
        JSON.stringify(untouched.quests_accepted_at));

    // ---- 双开面板：两笔同时想清零，只能有一份生效且都不丢东西 ----
    await PlayerSect.update(
        { quests_reset_at: new Date(Date.now() - 86400000), quests_accepted: [quest.id] },
        { where: { player_id: player.id } }
    );
    const both = await Promise.all([SectService.getQuests(player.id), SectService.getQuests(player.id)]);
    const afterDouble = await reload(player.id);
    check('S9 两笔面板同时清零：都成功返回，且行仍处在"未过期"的一致状态',
        both.every(b => Array.isArray(b.quests)) && new Date(afterDouble.quests_reset_at) > new Date(),
        `reset_at=${afterDouble.quests_reset_at}`);
}

(async () => {
    let hard = 0;
    try {
        await main();
    } catch (e) {
        hard = 1;
        console.error('探针异常：', e.message, e.stack);
    } finally {
        try {
            const purged = await PlayerCascadePurge.deleteByUsernames([ACCOUNT]);
            console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
