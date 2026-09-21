/**
 * 写入面并发探针（需要 MySQL，走 .env 指向的库）—— "旧快照覆盖新快照"的回归门禁
 *
 * 目标里明确写着：现有代码不能出现"旧的快照覆盖新的快照，导致玩家数据丢失"。
 * 这类缺陷的特点是：单请求永远正确，只有两个请求交错才丢数据，所以纯逻辑测试测不出来。
 * 这里用真实 HTTP + 真实事务把几个写入入口同时打，然后核对落库结果：
 *   要么两笔都在（键级合并 / 行锁内重算），要么明确失败——绝不允许静默丢一笔。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_write_concurrency.js
 *       探针会自建/复用一个专用玩家 smokeprobe，只动它自己的行。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5098);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const PlayerTechnique = require('../models/playerTechnique');
const sequelize = require('../config/database');
const { bootApp, request, mintToken } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const DualTimeService = require('../game/core/DualTimeService');

const PROBE_USERNAME = 'smokeprobe';
const PROBE_NICKNAME = '并发探针';

const results = [];

function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail}`);
}

async function resetProbePlayer() {
    let player = await Player.findOne({ where: { username: PROBE_USERNAME } });
    if (!player) {
        player = await Player.create({
            username: PROBE_USERNAME,
            password: 'not-a-real-hash',
            nickname: PROBE_NICKNAME,
            // realm 必须是 realm_breakthrough.json 里的真名字：写一个不存在的名号，
            // 探针玩家自己就查不到境界配置，突破/概率那条读路径会当成故障报出来。
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
        console.log(`已创建探针玩家 ${PROBE_USERNAME} (id=${player.id})`);
    }
    // 整块播种 attributes 必须带事务：blobWriteGuard 对 Player.update 这条 bulk 路径
    // 的要求与实例路径一致（探针要的是精确的初始 blob，键级合并做不到）
    await sequelize.transaction(t => Player.update(
        {
            // 老版本探针把这个号建成 realm='炼气初期'（配置里没有的名号），
            // 已存在的行要在这里 heal 回来，否则读路径探针会一直报"境界配置不存在"
            realm: '炼气3层',
            realm_rank: 4,
            attribute_points: 0,
            spirit_stones: 0,
            hp_current: 1000,
            mp_current: 1000,
            // 恢复量由服务端时钟推导（上次结算时点 → 现在）。基准取 attributes.last_recovery_time，
            // 取不到才回落到 last_online —— 而 last_online 每个带鉴权的请求都会被 auth 中间件刷新，
            // 所以想留出结算窗口必须写前者，写后者会被并发请求当场抹平。
            attributes: { last_recovery_time: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }
        },
        { where: { id: player.id }, transaction: t }
    ));
    return Player.findByPk(player.id);
}

/** 造出 N 个尚未 await 的请求：调用方用 Promise.all 并发跑，才是本探针要的"请求交错" */
function postMany(port, token, path, body, times) {
    return Array.from({ length: times }, () => request({ port, method: 'POST', path, token, body }));
}

async function reload(id) {
    return Player.findByPk(id);
}

// ============================================================
// S1：同一属性被连点 N 次 —— 点数只能花掉一次一份，加成不能只留最后一份
// ============================================================
async function scenarioConcurrentAllocate(port, player) {
    await Player.update({ attribute_points: 6 }, { where: { id: player.id } });
    const token = mintToken(await reload(player.id));

    const responses = await Promise.all(postMany(port, token, '/api/attribute/allocate', { points: { hp: 1 } }, 6));
    const okCount = responses.filter(r => r.status === 200).length;

    const fresh = await reload(player.id);
    const attrs = fresh.attributes || {};
    check(
        'S1 连点 6 次加点：6 笔全部入账',
        okCount === 6 && Number(attrs.hp_bonus) === 6,
        `200×${okCount}, hp_bonus=${attrs.hp_bonus}`
    );
    check(
        'S1 属性点账实相符',
        Number(fresh.attribute_points) === 0,
        `剩余点数=${fresh.attribute_points}`
    );
    const ledger = (attrs.attribute_point_allocations || {}).hp_bonus;
    check(
        'S1 加点账本与加成同步（重置时按账本退点，不能被刷点）',
        Number(ledger) === 6,
        `账本=${ledger}`
    );
}

// ============================================================
// S2：不同键的并发写互不覆盖（加点写 hp_bonus，恢复写 last_recovery_time）
// ============================================================
async function scenarioDistinctKeys(port, player) {
    await Player.update({ attribute_points: 3 }, { where: { id: player.id } });
    const token = mintToken(await reload(player.id));

    const responses = await Promise.all([
        ...postMany(port, token, '/api/attribute/allocate', { points: { atk: 1 } }, 3),
        ...postMany(port, token, '/api/attribute/recover', { recovery_type: 'natural' }, 3)
    ]);

    const attrs = (await reload(player.id)).attributes || {};
    const recoveries = responses.slice(3);
    check(
        'S2 加点与恢复并发：两边的键都在（旧实现会整块互相覆盖）',
        Number(attrs.atk_bonus) === 3 && Boolean(attrs.last_recovery_time),
        `atk_bonus=${attrs.atk_bonus}, last_recovery_time=${attrs.last_recovery_time ? '有' : '无'}, ` +
        `recover=${recoveries.map(r => `${r.status}${r.body?.message ? `(${r.body.message})` : ''}`).join(' ')}`
    );
}

// ============================================================
// S3：登录离线恢复 vs 并发写入 —— 本次改造里暴露面最大的那处丢数据
// ============================================================
async function scenarioLoginRecovery(port, player) {
    await Player.update(
        { attribute_points: 1, last_online: new Date(Date.now() - 3 * 3600 * 1000) },
        { where: { id: player.id } }
    );
    const token = mintToken(await reload(player.id));

    // 直接调恢复本体而不是走 /auth/login：登录会自增 token_version 把并发请求踢成 401，
    // 那是会话互踢的既定行为，会盖掉这里真正要测的"键级写回"。
    const stale = await reload(player.id);
    const [, alloc] = await Promise.all([
        DualTimeService.processOfflineTime(stale, 3 * 3600),
        request({ port, method: 'POST', path: '/api/attribute/allocate', token, body: { points: { sense: 1 } } })
    ]);

    const attrs = (await reload(player.id)).attributes || {};
    check(
        'S3 离线恢复与加点并发：加点结果没有被恢复写回抹掉',
        alloc.status === 200 && Number(attrs.sense_bonus) === 1,
        `allocate=${alloc.status}, sense_bonus=${attrs.sense_bonus}`
    );
}

// ============================================================
// S4：余额扣减不能超发
// ============================================================
async function scenarioAtomicSpend(player) {
    await Player.update({ spirit_stones: 500 }, { where: { id: player.id } });

    const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => PlayerStateStore.spendAmount(player.id, 'spirit_stones', 100))
    );
    const succeeded = outcomes.filter(Boolean).length;
    const balance = Number((await reload(player.id)).spirit_stones);

    check(
        'S4 余额 500 / 单价 100 / 并发 8 笔：成功数与余额严格自洽',
        succeeded === 5 && balance === 0,
        `成功=${succeeded}, 余额=${balance}`
    );
}

/** 修炼结果里的灵石消耗（路由把服务返回值包在 data 里） */
function practiceCostOf(response) {
    const cost = Number(response.body?.data?.spirit_stone_cost);
    return Number.isFinite(cost) ? cost : NaN;
}

/**
 * 并发修炼若干本功法。
 * 每本功法有自己的每日次数上限，所以要多本才能真的让扣款路径并发起来
 * （只用一本的话 5 笔会被日限挡掉，测不到交错）。
 */
const PRACTICE_TECHNIQUES = ['huang_basic_qi', 'huang_iron_body', 'huang_swift_wind'];

async function seedPractices(player) {
    await PlayerTechnique.destroy({ where: { player_id: player.id } });
    for (const id of PRACTICE_TECHNIQUES) {
        await PlayerTechnique.create({ player_id: player.id, technique_id: id, layer: 1, proficiency: 0 });
    }
}

// ============================================================
// S5：并发修炼的灵石扣减必须精确 —— 少扣=白嫖，多扣=吞灵石
// ============================================================
async function scenarioConcurrentPractice(port, player) {
    const start = 50000;
    await Player.update({ spirit_stones: start, attribute_points: 0 }, { where: { id: player.id } });
    await seedPractices(player);
    const token = mintToken(await reload(player.id));

    const responses = await Promise.all(PRACTICE_TECHNIQUES.flatMap(id =>
        postMany(port, token, '/api/technique/practice', { technique_id: id }, 2)
    ));
    const successes = responses.filter(r => r.status === 200);
    const costs = successes.map(practiceCostOf);
    const balance = Number((await reload(player.id)).spirit_stones);
    const expected = costs.every(Number.isFinite) ? start - costs.reduce((a, b) => a + b, 0) : NaN;

    check(
        'S5 并发 6 笔修炼（3 本功法）：每笔扣款都入账，灵石不多不少',
        successes.length >= 2 && costs.every(Number.isFinite) && balance === expected,
        `成功=${successes.length}, 单笔消耗=${costs.join('/')}, 余额=${balance}, 应为=${expected}`
    );
}

// ============================================================
// S6：闭关结算（整行 save）与并发消耗交错时，标量列不能被旧值写回
// ============================================================
async function scenarioSeclusionVsSpend(port, player) {
    const start = 40000;
    await Player.update({ spirit_stones: start, attribute_points: 0 }, { where: { id: player.id } });
    await seedPractices(player);
    const token = mintToken(await reload(player.id));

    await request({ port, method: 'POST', path: '/api/seclusion/start', token, body: { mode: 'normal' } });

    // 结算走的是整行 save，修炼走的是扣款；两者交错时谁都不该把对方的结果抹平
    const [, ...practices] = await Promise.all([
        request({ port, method: 'POST', path: '/api/seclusion/end', token, body: {} }),
        ...PRACTICE_TECHNIQUES.map(id => request({
            port, method: 'POST', path: '/api/technique/practice', token, body: { technique_id: id }
        }))
    ]);

    const after = await reload(player.id);
    const successes = practices.filter(r => r.status === 200);
    const costs = successes.map(practiceCostOf);
    const expected = start - costs.reduce((a, b) => a + b, 0);

    check(
        'S6 闭关结算与并发修炼交错：灵石扣减仍然精确，闭关状态也确实清零',
        after.is_secluded === false && costs.every(Number.isFinite) && Number(after.spirit_stones) === expected,
        `is_secluded=${after.is_secluded}, 修炼成功=${successes.length}, 消耗=${costs.join('/')}, ` +
        `余额=${after.spirit_stones}, 应为=${expected}`
    );
}

// ============================================================
// S7：模型守卫在真实 save 之路上确实会拦（单元测试只证明函数，不证明 Sequelize 会调它）
// ============================================================
async function scenarioGuardFires(player) {
    const stale = await reload(player.id);
    stale.attributes = { ...(stale.attributes || {}), probe_key: 'should-never-land' };

    let rejected = null;
    try {
        await stale.save();                       // 故意不带事务：等价于改造前的登录离线恢复
    } catch (error) {
        rejected = error.message || String(error);
    }

    const landed = (await reload(player.id)).attributes || {};
    check(
        'S7 事务外整块写回 attributes 被模型拒绝，且真的没落库',
        Boolean(rejected) && /不能在事务外写回/.test(rejected) && landed.probe_key === undefined,
        rejected ? `已拦下：${rejected.slice(0, 40)}…` : '没有抛错 —— 守卫失效，旧快照可以整块覆盖'
    );

    // 同一份写回放进事务里必须放行，否则守卫就是扩大化拦截
    const inTx = await reload(player.id);
    inTx.attributes = { ...(inTx.attributes || {}), probe_tx_key: 'ok' };
    let txError = null;
    try {
        await sequelize.transaction(async (t) => { await inTx.save({ transaction: t }); });
    } catch (error) {
        txError = error.message || String(error);
    }
    const txLanded = (await reload(player.id)).attributes || {};
    check(
        'S7 事务内、且快照就是库里最新那份：整块写回照常放行',
        txError === null && txLanded.probe_tx_key === 'ok',
        txError ? `被误拦：${txError.slice(0, 60)}` : '放行成功'
    );

    // 有事务也不够：只要读点早于别人的提交，整块写回照样覆盖。这一类以前放行，
    // 现在按 state_version 拦 —— 探针在这里造一个真实的交错：读到快照 → 竞争者提交 → 再写回。
    const staleInTx = await reload(player.id);
    staleInTx.attributes = { ...(staleInTx.attributes || {}), probe_key: 'should-never-land' };
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { competitor_key: 'landed' } });
    let staleError = null;
    try {
        await sequelize.transaction(async (t) => { await staleInTx.save({ transaction: t }); });
    } catch (error) {
        staleError = error.message || String(error);
    }
    const afterStale = (await reload(player.id)).attributes || {};
    check(
        'S7 事务内但快照已过期：按 state_version 拦下，竞争者写进去的键仍在',
        staleError !== null && /快照已过期/.test(staleError)
            && afterStale.probe_key === undefined && afterStale.competitor_key === 'landed',
        staleError ? `已拦下：${staleError.slice(0, 40)}…` : '没有抛错 —— 有事务的旧快照仍能覆盖新快照'
    );

    // bulk 路径（Player.update）不触发 beforeSave，所以那道规则得单独验：
    // 事务外整块覆盖要拒；事务内允许，但 state_version 必须跟着涨，
    // 否则这条路径写过多少次版本号都不知道，beforeSave 的新鲜度判定就失真了。
    const versionBeforeBulk = Number((await reload(player.id)).getDataValue('state_version'));
    let bulkError = null;
    try {
        await Player.update({ attributes: { probe_bulk_key: 'nope' } }, { where: { id: player.id } });
    } catch (error) {
        bulkError = error.message || String(error);
    }
    check(
        'S7 事务外经 Player.update 整块覆盖 attributes 被拒（bulk 路径不触发 beforeSave）',
        bulkError !== null && /Player\.update/.test(bulkError)
            && (await reload(player.id)).attributes?.probe_bulk_key === undefined,
        bulkError ? `已拦下：${bulkError.slice(0, 40)}…` : '没有抛错 —— bulk 路径仍在裸奔'
    );

    await sequelize.transaction(t => Player.update(
        { attributes: { probe_bulk_key: 'ok' } }, { where: { id: player.id }, transaction: t }
    ));
    const afterBulk = await reload(player.id);
    check(
        'S7 事务内 Player.update 整块覆盖放行，且 state_version 由守卫自动 +1',
        afterBulk.attributes?.probe_bulk_key === 'ok'
            && Number(afterBulk.getDataValue('state_version')) === versionBeforeBulk + 1,
        `probe_bulk_key=${afterBulk.attributes?.probe_bulk_key}, state_version ${versionBeforeBulk}→${afterBulk.getDataValue('state_version')}`
    );

    // 清掉探针键，避免影响后续用例
    await PlayerStateStore.patchPlayerState(player.id, {
        attributes: { probe_key: null, probe_tx_key: null, competitor_key: null, probe_bulk_key: null }
    });
}

// ============================================================
// S8：神识这类"多条流程并发增减"的键，走 $add 增量后必须既精确又不伤邻居
// ============================================================
async function scenarioConcurrentBlobDelta(player) {
    await sequelize.transaction(t => Player.update(
        { attributes: { sense: 100, sibling_key: 'keep-me' } },
        { where: { id: player.id }, transaction: t }
    ));

    await Promise.all([
        // 8 笔 -10：等价于飞升/战线/残魂并发扣神识
        ...Array.from({ length: 8 }, () => PlayerStateStore.patchPlayerState(
            player.id, { attributes: { sense: { $add: -10, $min: 0 } } }
        )),
        // 同期另一条流程写一个无关键
        PlayerStateStore.patchPlayerState(player.id, { attributes: { unrelated_key: 'added' } })
    ]);

    const attrs = (await reload(player.id)).attributes || {};
    check(
        'S8 并发 8 笔 $add 扣神识：结果精确、无关键不被抹掉',
        Number(attrs.sense) === 20 && attrs.sibling_key === 'keep-me' && attrs.unrelated_key === 'added',
        `sense=${attrs.sense}(应为20), sibling=${attrs.sibling_key}, unrelated=${attrs.unrelated_key}`
    );

    // 下界钳制：扣过头也不能变负数
    await sequelize.transaction(t => Player.update(
        { attributes: { sense: 5 } }, { where: { id: player.id }, transaction: t }
    ));
    await Promise.all([0, 1, 2].map(() => PlayerStateStore.patchPlayerState(
        player.id, { attributes: { sense: { $add: -10, $min: 0 } } }
    )));
    const clamped = Number((await reload(player.id)).attributes?.sense);
    check('S8 $min 在行锁内生效：连续扣减不会扣成负数', clamped === 0, `sense=${clamped}(应为0)`);

    // 转换后的调用形状是"patchPlayerState 写一次 + 调用方在同一个事务里再 save 一次"。
    // 后者用的还是调用方手上那份实例，必须确认它只把自己改过的列写回去（state_version 不被倒着写），
    // 否则 blobWriteGuard 的版本判定就废了 —— 下一请求会以为那份旧快照还是新的。
    const beforeVersion = Number((await reload(player.id)).getDataValue('state_version'));
    const staleInstance = await reload(player.id);
    await PlayerStateStore.patchPlayerState(player.id, { attributes: { sense: { $add: 5, $min: 0 } } });
    staleInstance.lifespan_current = Number(staleInstance.lifespan_current || 0) + 1;
    await staleInstance.save();
    const after = await reload(player.id);
    check(
        'S8 补丁之后再保存旧实例：state_version 只增不减，且补丁结果仍在',
        Number(after.getDataValue('state_version')) > beforeVersion && Number(after.attributes?.sense) === 5,
        `state_version ${beforeVersion}→${after.getDataValue('state_version')}, sense=${after.attributes?.sense}`
    );
}

// ============================================================
// S9：法则转换（已改为键级补丁）端到端：真跑一次 convert，并确认不伤邻居
// ============================================================
async function scenarioLawConvert(player) {
    const LawService = require('../game/services/LawService');
    const PlayerLaw = require('../models/playerLaw');

    let law = await PlayerLaw.findOne({ where: { player_id: player.id } });
    if (!law) law = await PlayerLaw.create({ player_id: player.id });

    async function seedLaw(attributes, points) {
        await sequelize.transaction(t => Player.update(
            { attributes, law_points: points }, { where: { id: player.id }, transaction: t }
        ));
        law = await PlayerLaw.findByPk(law.id);
        law.law_points = points;
        await law.save();
    }

    await seedLaw({ ask_dao_insight: 0, sibling_key: 'keep-me' }, 100);

    const [result] = await Promise.all([
        LawService.convert(player.id, 'ask_dao_insight', 2),
        // 同期另一条流程往同一个 blob 里写一个无关键
        PlayerStateStore.patchPlayerState(player.id, { attributes: { unrelated_key: 'added' } })
    ]);

    const attrs = (await reload(player.id)).attributes || {};
    check(
        'S9 法则转换与并发写入交错：目标键精确入账，邻居键不被抹掉',
        result.success === true && Number(attrs.ask_dao_insight) === 20
            && attrs.sibling_key === 'keep-me' && attrs.unrelated_key === 'added',
        `success=${result.success}${result.message ? '/' + result.message : ''}, ` +
        `ask_dao_insight=${attrs.ask_dao_insight}, sibling=${attrs.sibling_key}, unrelated=${attrs.unrelated_key}`
    );

    // $max：残魂上限 100，95 + 20 只能到 100
    await seedLaw({ remnant_soul: 95 }, 100);
    const capped = await LawService.convert(player.id, 'remnant_soul_recover', 1);
    const remnant = Number((await reload(player.id)).attributes?.remnant_soul);
    check(
        'S9 残魂转换由 $max 在行锁内钳住上限：95+20 只到 100',
        capped.success === true && remnant === 100,
        `success=${capped.success}${capped.message ? '/' + capped.message : ''}, remnant_soul=${remnant}`
    );
}

(async () => {
    await bootApp(app, { port: PORT });
    const player = await resetProbePlayer();

    await scenarioConcurrentAllocate(PORT, player);
    await resetProbePlayer();
    await scenarioDistinctKeys(PORT, player);
    await resetProbePlayer();
    await scenarioLoginRecovery(PORT, player);
    await resetProbePlayer();
    await scenarioAtomicSpend(player);
    await resetProbePlayer();
    await scenarioConcurrentPractice(PORT, player);
    await resetProbePlayer();
    await scenarioSeclusionVsSpend(PORT, player);
    await resetProbePlayer();
    await scenarioGuardFires(player);
    await resetProbePlayer();
    await scenarioConcurrentBlobDelta(player);
    await resetProbePlayer();
    await scenarioLawConvert(player);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch((error) => {
    console.error('探针自身失败:', error);
    process.exit(2);
});
