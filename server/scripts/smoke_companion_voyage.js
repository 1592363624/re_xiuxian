/**
 * 侍妾远航 / 心劫抉择 —— 连库 + 真 HTTP 探针（2026-09-23）
 *
 * 钉的是本轮把这两份词表收进内容之后的四件事，每件都是"单测绿着但线上会坏"的形状：
 *   V1–V3 远航模式清单只从内容出：界面拿得到、路由认、库里真的按内容里的时长落 expected_end_time；
 *   V4–V8 归来结算：未到期不许领；灵石**库里增量 == 回执**（走 patchPlayerState 原子加，
 *        旧写法是"读整行 + BigInt+奖励 + save 整行"，会带走同段时间别的流程写的钱）；
 *        物品走 grantItems（回执里的每一件真在背包里，且不留 items_failed）；已领取的不能再领第二遍；
 *   V9 热更：往配置文件临时加一档模式 + 同名奖励池 → hotUpdateConfig → 不重启就能选它、路由也认它，
 *        还原后白名单立刻回到原样（能扩来自登记，不是来自"这次跑之前刚好重启过"）；
 *   C1–C5 心劫：面板与列表两条出参都不再下发**没有任何结算代码读它**的 remnant_soul_cost；
 *        合法键被接受、非法键被拒且点名合法键；抉择链本身照常能走通。
 *        这里还顺带执行了一次出参投影（CompanionService.projectTribulationOptions）——
 *        本轮它少写了一个 static，有 pending 心劫的玩家一打开面板就 500，而 1276 项单测与全部 GET 都是绿的。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_companion_voyage.js
 *       自建探针号 cvoyg01 / cvoyg02，退出前按账号名级联删号；配置文件由 finally + exit 钩子双重还原。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 5106);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const Concubine = require('../models/concubine');
const ConcubineVoyage = require('../models/concubineVoyage');
const HeartTribulationEvent = require('../models/heartTribulationEvent');
const DaoCompanion = require('../models/daoCompanion');
const Item = require('../models/item');
const sequelize = require('../config/database');
const configLoader = require('../modules/infrastructure/ConfigLoader');
const { bootApp, request, mintToken } = require('./lib/smoke_http');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');

const PROBE_USERNAMES = ['cvoyg01', 'cvoyg02'];
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'companion_data.json');
const PROBE_MODE = 'zz_probe_voyage';
const results = [];
const originalBytes = fs.readFileSync(CONFIG_FILE);

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

/** 把配置文件按字节还原（崩溃时由 exit 钩子兜底；热更要单独 await，见下） */
function restoreBytes() {
    const current = fs.readFileSync(CONFIG_FILE);
    if (!current.equals(originalBytes)) fs.writeFileSync(CONFIG_FILE, originalBytes);
}
const hotUpdate = () => configLoader.hotUpdateConfig('companion_data');
process.on('exit', () => { try { restoreBytes(); } catch { /* 收尾尽力而为 */ } });

/** 内容里现读现算的期望值（不在探针里抄第二份词表，否则这条探针会跟着内容一起过期） */
const modesInContent = () => Object.entries(configLoader.peekConfig('companion_data').voyage.modes)
    .filter(([key, cfg]) => !key.startsWith('_') && cfg && typeof cfg === 'object' && !Array.isArray(cfg))
    .map(([key, cfg]) => ({ key, name: cfg.name, duration_hours: cfg.duration_hours }));
const choiceKeysInContent = () => Object.keys(configLoader.peekConfig('companion_data').heart_tribulation.options)
    .filter(key => !key.startsWith('_'));

/** 把一次远航的归来时间拧到"已经到期"（不真等 4 小时） */
async function expireVoyage(voyageId) {
    await ConcubineVoyage.update(
        { expected_end_time: new Date(Date.now() - 60 * 1000) },
        { where: { id: voyageId } }
    );
}

/** 只在一次调用里钉住 Math.random（判据是 `roll < 成功率` 与加权抽样，钉住才拿得到确定的一条支路） */
async function withRandom(value, run) {
    const real = Math.random;
    Math.random = () => value;
    try { return await run(); } finally { Math.random = real; }
}

(async () => {
    await bootApp(app, { port: PORT });
    await PlayerCascadePurge.deleteByUsernames(PROBE_USERNAMES);
    const player = await Player.create({
        username: PROBE_USERNAMES[0], password: 'not-a-real-hash', nickname: '远航探针',
        realm: '结丹中期', realm_rank: 15, exp: 1000000, spirit_stones: 1000,
        hp_current: 20000, mp_current: 5000, lifespan_current: 200, lifespan_max: 900,
        remnant_soul: 50, attributes: {}, token_version: 0
    });
    const partner = await Player.create({
        username: PROBE_USERNAMES[1], password: 'not-a-real-hash', nickname: '远航探针乙',
        realm: '结丹中期', realm_rank: 15, exp: 1, spirit_stones: 0,
        hp_current: 20000, mp_current: 5000, attributes: {}, token_version: 0
    });
    const token = mintToken(player);
    const call = (method, p, body) => request({ port: PORT, method, path: p, token, body });
    const concubine = await Concubine.create({
        player_id: player.id, concubine_key: 'zz_probe_concubine', concubine_name: '探针侍妾',
        concubine_type: 'probe', realm_rank: 1, exp: 0, charm: 100, intimacy: 100, loyalty: 100,
        attributes: '{}', is_placed: 0, is_voyaging: 0, daily_ask_after_count: 0
    });
    const companion = await DaoCompanion.create({
        player_a_id: player.id, player_b_id: partner.id, relation_state: 'sealed',
        heart_contract_level: 1, heart_tribulation_count: 0
    });

    try {
        // —— V1 词表从内容出，且界面拿得到 ——
        const listBody = await call('GET', '/api/concubine/list', {});
        const delivered = (listBody.body?.data?.voyage_modes) || [];
        const expectModes = modesInContent().sort((a, b) => a.duration_hours - b.duration_hours);
        check('V1 /concubine/list 下发的远航模式 = 内容词表（键、中文名、按时长排序，且不把 _comment 当一档）',
            listBody.status === 200 && delivered.length === expectModes.length
            && delivered.every((mode, i) => mode.key === expectModes[i].key && mode.name === expectModes[i].name),
            `下发=${JSON.stringify(delivered.map(m => `${m.key}:${m.name}:${m.duration_hours}h`))}, 内容=${JSON.stringify(expectModes.map(m => m.key))}`);

        // —— V2 未知键被拒，理由点名合法键 ——
        const badMode = await call('POST', '/api/concubine/voyage/start', { concubine_id: concubine.id, mode: 'zz_no_such' });
        check('V2 未知模式被拒且列出合法键（拒绝的理由来自内容，不是代码里那张表）',
            badMode.status === 400 && expectModes.every(m => String(badMode.body.message).includes(m.key)),
            `status=${badMode.status}, message=${badMode.body.message}`);

        // —— V3 起航：库里真按内容里的时长落 expected_end_time ——
        const start = await call('POST', '/api/concubine/voyage/start', { concubine_id: concubine.id, mode: 'safe' });
        const voyageRow = await ConcubineVoyage.findOne({ where: { player_id: player.id, voyage_mode: 'safe' }, order: [['id', 'DESC']] });
        const hoursFromContent = expectModes.find(m => m.key === 'safe').duration_hours;
        const gapHours = voyageRow
            ? (new Date(voyageRow.expected_end_time) - new Date(voyageRow.started_at)) / 3600000
            : -1;
        const marked = await Concubine.findByPk(concubine.id);
        check('V3 起航：库里出现远航记录，预计归来时长 = 内容里这一档的 duration_hours，侍妾标成在航',
            start.body.code === 200 && !!voyageRow && Math.abs(gapHours - hoursFromContent) < 1 / 60
            && marked.is_voyaging === 1 && Number(marked.voyage_id) === Number(voyageRow.id),
            `code=${start.body.code}, 消息=${start.body.message}, 库里时长=${gapHours}h（内容=${hoursFromContent}h）, is_voyaging=${marked.is_voyaging}`);

        // —— V4 未到期不许领 ——
        const tooEarly = await call('POST', '/api/concubine/voyage/return', { voyage_id: voyageRow.id });
        check('V4 未到期归来被拒（回执说明白"远航未结束"，不是一句服务器内部错误）',
            String(tooEarly.body.message || '').includes('远航未结束'),
            `status=${tooEarly.status}, code=${tooEarly.body.code}, message=${tooEarly.body.message}`);

        // —— V5/V6/V7/V8 成功归来（钉 0.79：加权抽样落在物品那条上，且 0.79 < 成功率）——
        await expireVoyage(voyageRow.id);
        const before = await Player.findByPk(player.id);
        const back = await withRandom(0.79, () => call('POST', '/api/concubine/voyage/return', { voyage_id: voyageRow.id }));
        const data = back.body.data || {};
        const rewards = data.rewards || {};
        const after = await Player.findByPk(player.id);
        const landed = Number(BigInt(after.spirit_stones) - BigInt(before.spirit_stones));
        const reportedItems = Array.isArray(rewards.items) ? rewards.items : [];
        const itemRows = reportedItems.length
            ? await Item.findAll({ where: { player_id: player.id, item_key: reportedItems.map(i => i.item_key) } })
            : [];
        const itemsOk = reportedItems.every(entry => {
            const row = itemRows.find(r => r.item_key === entry.item_key);
            return row && Number(row.quantity) >= Number(entry.count || 1);
        });
        check('V5 归来回执说成功并且真的抽到了物品（这一支路走的是 grantItems，不是自己 findOne/quantity++）',
            back.body.code === 200 && rewards.is_success === true && reportedItems.length > 0 && itemsOk,
            `is_success=${rewards.is_success}, 回执物品=${JSON.stringify(reportedItems.map(i => `${i.item_key}x${i.count}`))}, 背包=${JSON.stringify(itemRows.map(r => `${r.item_key}x${r.quantity}`))}`);
        check('V6 库里灵石增量 == 回执报的灵石（原子加，不多不少；旧写法会带走同段时间别人写的钱）',
            landed === Number(rewards.spirit_stones || 0),
            `回执=${rewards.spirit_stones}, 库里 ${before.spirit_stones}→${after.spirit_stones}（+${landed}）`);
        check('V7 发出去的每一件都算成了，没有"回执正常、其实没发"的 items_failed',
            !rewards.items_failed || rewards.items_failed.length === 0,
            `items_failed=${JSON.stringify(rewards.items_failed || [])}`);
        const afterRow = await ConcubineVoyage.findByPk(voyageRow.id);
        const afterConcubine = await Concubine.findByPk(concubine.id);
        check('V8 领过的不能再领第二遍，侍妾从"在航"里放出来（远航记录收口）',
            afterRow.is_collected === 1 && afterRow.status === 'returned'
            && afterConcubine.is_voyaging === 0 && !afterConcubine.voyage_id,
            `is_collected=${afterRow.is_collected}, status=${afterRow.status}, is_voyaging=${afterConcubine.is_voyaging}, voyage_id=${afterConcubine.voyage_id}`);
        const twice = await call('POST', '/api/concubine/voyage/return', { voyage_id: voyageRow.id });
        check('V8b 同一份远航重复领取被拒（不发第二遍奖）',
            String(twice.body.message || '').includes('已领取'),
            `status=${twice.status}, message=${twice.body.message}`);

        // —— V9 热更：新档不重启就认 ——
        const cfg = JSON.parse(originalBytes.toString('utf8'));
        cfg.voyage.modes[PROBE_MODE] = {
            name: '夹具巡礼', description: '探针临时加的一档', duration_hours: 3,
            risk_modifier: 0.4, reward_multiplier: 1, min_charm: 0
        };
        cfg.voyage.reward_pools[PROBE_MODE] = [
            { type: 'spirit_stones', min: 10, max: 20, weight: 100 },
            { type: 'item', item_keys: ['spirit_grass'], weight: 30 }
        ];
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
        await hotUpdate();
        const listHot = await call('GET', '/api/concubine/list', {});
        const hotDelivered = (listHot.body.data?.voyage_modes || []).map(m => m.key);
        const startHot = await call('POST', '/api/concubine/voyage/start', { concubine_id: concubine.id, mode: PROBE_MODE });
        check('V9 热更加一档：不重启就出现在界面清单里、路由也认它（以前要改四份抄本）',
            hotDelivered.includes(PROBE_MODE) && startHot.body.code === 200,
            `下发键=${JSON.stringify(hotDelivered)}, start code=${startHot.body.code}, message=${startHot.body.message}`);
        const hotRow = await ConcubineVoyage.findOne({ where: { player_id: player.id, voyage_mode: PROBE_MODE }, order: [['id', 'DESC']] });
        if (hotRow) await expireVoyage(hotRow.id);
        const hotBack = await withRandom(0, () => call('POST', '/api/concubine/voyage/return', { voyage_id: hotRow.id }));
        const hotLanded = Number(BigInt((await Player.findByPk(player.id)).spirit_stones))
            - Number(BigInt(after.spirit_stones));
        check('V9b 资料片那一档真能跑完整条链：奖励池读的是新档那份，灵石按回执落地',
            hotBack.body.code === 200 && hotLanded === Number((hotBack.body.data?.rewards || {}).spirit_stones || 0)
            && hotLanded > 0,
            `回执=${JSON.stringify(hotBack.body.data?.rewards)}, 库里增量=${hotLanded}`);
        restoreBytes();
        await hotUpdate();
        const listCold = await call('GET', '/api/concubine/list', {});
        const coldKeys = (listCold.body.data?.voyage_modes || []).map(m => m.key);
        const startCold = await call('POST', '/api/concubine/voyage/start', { concubine_id: concubine.id, mode: PROBE_MODE });
        check('V9c 还原配置 + 再热更：白名单回到原样（证明"认得新档"来自那份内容，而不是探针把状态留在了内存里）',
            !coldKeys.includes(PROBE_MODE) && startCold.status === 400,
            `还原后下发键=${JSON.stringify(coldKeys)}, start status=${startCold.status}, message=${startCold.body.message}`);

        // —— C1~C5 心劫：出参不再宣传那颗没人扣的键，抉择链本身照常能走 ——
        // 故意用**整份**内容 options 当快照（含 `_comment` 与 cost）：这就是游戏真触发时写进事件行的形状（见 _triggerHeartTribulation）
        const optionsSnapshot = JSON.parse(JSON.stringify(
            configLoader.peekConfig('companion_data').heart_tribulation.options
        ));
        if (!optionsSnapshot._comment || optionsSnapshot.steady.remnant_soul_cost === undefined) {
            throw new Error('夹具前提不成立：内容里那份心劫选项没带 _comment / remnant_soul_cost，下面"没泄漏"的判据会是空的');
        }
        async function newEvent() {
            return await HeartTribulationEvent.create({
                player_id: player.id, companion_id: companion.id, concubine_id: null,
                event_type: 'contract_upgrade', event_state: 'pending',
                options: optionsSnapshot, expires_at: new Date(Date.now() + 3600 * 1000)
            });
        }
        const event = await newEvent();
        const tribulation = await call('GET', '/api/companion/heart-tribulation', {});
        const listed = (tribulation.body.data?.pending_events) || [];
        const leakedInList = JSON.stringify(tribulation.body).includes('remnant_soul_cost');
        check('C1 心劫列表（面板读的那份）出参不含 remnant_soul_cost 与 _comment —— 前者没人扣、后者是写给开发看的',
            tribulation.body.code === 200 && listed.length === 1 && !leakedInList
            && !Object.keys(listed[0].options).includes('_comment')
            && listed[0].options.steady.success_rate === optionsSnapshot.steady.success_rate,
            `code=${tribulation.body.code}, message=${tribulation.body.message}, 事件数=${listed.length}, 泄漏 cost=${leakedInList}, 快照键=${JSON.stringify(Object.keys(listed[0].options))}`);
        const profile = await call('GET', '/api/companion/profile', {});
        const profilePending = profile.body.data?.pending_tribulation;
        check('C2 道侣档案这条出参同样不泄漏，且词表随档案下发（界面按这份渲染名字，不再自己抄一张表）',
            profile.body.code === 200 && !!profilePending
            && !JSON.stringify(profile.body).includes('remnant_soul_cost')
            && (profile.body.data.heart_tribulation_options || []).map(c => c.key).join(',') === choiceKeysInContent().join(','),
            `code=${profile.body.code}, message=${profile.body.message}, 词表=${JSON.stringify((profile.body.data?.heart_tribulation_options || []).map(c => `${c.key}:${c.name}`))}`);
        const badChoice = await call('POST', '/api/companion/heart-tribulation/choose', { event_id: event.id, option: 'trust' });
        check('C3 旧系统留下的键（trust）被拒，理由点名内容词表里的合法键',
            badChoice.status === 400 && choiceKeysInContent().every(k => String(badChoice.body.message).includes(k)),
            `status=${badChoice.status}, message=${badChoice.body.message}`);
        const chosen = await withRandom(0, () => call('POST', '/api/companion/heart-tribulation/choose', { event_id: event.id, option: 'steady' }));
        const resolved = await HeartTribulationEvent.findByPk(event.id);
        check('C4 合法键真走通：事件标成已处理、回执按内容里的成功率判定，且回执文本不提"残魂消耗"',
            chosen.body.code === 200 && ['resolved', 'failed'].includes(resolved.event_state)
            && chosen.body.data.chosen_option === 'steady'
            && !JSON.stringify(chosen.body).includes('remnant_soul_cost'),
            `code=${chosen.body.code}, is_success=${chosen.body.data?.is_success}, 库里状态=${resolved.event_state}, 消息=${chosen.body.message}`);
        const replay = await call('POST', '/api/companion/heart-tribulation/choose', { event_id: event.id, option: 'steady' });
        check('C4b 同一个心劫不结算第二遍（回执"已处理"）',
            String(replay.body.message || '').includes('已处理'),
            `status=${replay.status}, message=${replay.body.message}`);
        const staleList = await call('GET', '/api/companion/heart-tribulation', {});
        check('C5 处理完的事件不再出现在待处理列表里',
            (staleList.body.data?.pending_events || []).length === 0,
            `待处理=${(staleList.body.data?.pending_events || []).length}, message=${staleList.body.message}`);
        // 旧事件（快照里有词表外的键）照常展示，但按词表判不可提交 —— 界面靠 C2 那份词表灰掉按钮
        const legacy = await newEvent();
        await HeartTribulationEvent.update(
            { options: { trust: { success_rate: 0.5, name: '信任' }, steady: { success_rate: 0.7, name: '稳' } } },
            { where: { id: legacy.id } }
        );
        const legacyList = await call('GET', '/api/companion/heart-tribulation', {});
        const legacyOptions = Object.keys((legacyList.body.data?.pending_events || [])[0]?.options || {});
        check('C6 历史事件快照里的其它键照常下发（不让玩家对着一个空白抉择），可提交与否由词表判',
            legacyOptions.includes('trust') && legacyOptions.includes('steady'),
            `快照键=${JSON.stringify(legacyOptions)}`);
    } finally {
        restoreBytes();
        await hotUpdate().catch(() => { /* 收尾尽力而为 */ });
        await HeartTribulationEvent.destroy({ where: { player_id: player.id } });
        await ConcubineVoyage.destroy({ where: { player_id: player.id } });
        await Concubine.destroy({ where: { player_id: player.id } });
        await DaoCompanion.destroy({ where: { player_a_id: player.id } });
        await PlayerCascadePurge.deleteByUsernames(PROBE_USERNAMES);
        await sequelize.close();
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    if (failed.length) {
        console.log('失败项：\n' + failed.map(f => `  · ${f.name}\n    ${f.detail}`).join('\n'));
    }
    process.exit(failed.length ? 1 : 0);
})().catch(async error => {
    console.error('探针自身失败:', error);
    try {
        restoreBytes();
        await hotUpdate().catch(() => {});
        await PlayerCascadePurge.deleteByUsernames(PROBE_USERNAMES);
    } catch { /* 已经报错了 */ }
    process.exit(2);
});
