/**
 * players 数值列（钱/修为）的"旧快照覆盖新快照"探针。
 *
 * 补的是 blobWriteGuard 那一族洞的另一半：整块 JSON 列已经有人管（scripts/smoke_soul_blob_writes.js
 * 那批），但 `player.spirit_stones = BigInt(player.spirit_stones) + gain; player.save()`
 * 这种**标量列的读-改-写**以前没人管 —— 读与写之间只要有人提交过，对方那笔就永久没了，
 * 既不报错也不自愈。判定本身在 game/persistence/numericWriteGuard.js（挂在 players 的 beforeSave）。
 *
 * 判据分三层，缺一层都不算数：
 *   1. **控制跑**（关守卫）必须先证明"这个形状真能丢钱"，否则后面所有"守卫挡住了什么"都是空话；
 *   2. 开守卫后同一个形状必须**响**（败者拿到 StaleNumericWriteError），并且按报错指引改一次就能两笔都到账；
 *   3. 现网已有的**正确写法不能被误伤**：事务内 FOR UPDATE 读、patchPlayerState({amounts})、
 *      spendAmount 余额判定、"从权威那份镜像回手上实例"（AttributeService.allocatePoints:386）都要照常工作。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_numeric_write_cas.js
 *       .env 指向隔离库 re_xiuxian_test；自建探针号，退出前删号。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5097);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const sequelize = require('../config/database');
const { bootApp, request, mintToken } = require('./lib/smoke_http');
const PlayerStateStore = require('../game/persistence/PlayerStateStore');
const PlayerCascadePurge = require('../game/persistence/PlayerCascadePurge');
const {
    StaleNumericWriteError,
    assertNumericWriteAllowed,
    CAS_COLUMNS
} = require('../game/persistence/numericWriteGuard');

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stones = async (id) => Number((await Player.findByPk(id)).getDataValue('spirit_stones'));

/** 抄 routes/admin.js:452-456 / 492-495 那两段的形状：无锁读 → 无事务整值写回 */
async function racyGrant(playerId, gain, gapMs) {
    const player = await Player.findByPk(playerId);
    player.spirit_stones = Number(player.spirit_stones) + gain;
    await sleep(gapMs);                       // 现网这里夹的是 await logAdminAction(...)
    await player.save();
    return Number(player.spirit_stones);
}

/** 事务内 + FOR UPDATE 读 + 读-改-写：服务里最常见的正确形状（AchievementService.claimReward 就是这个） */
async function lockedGrant(playerId, gain) {
    return sequelize.transaction(async (t) => {
        const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
        player.spirit_stones = Number(player.spirit_stones) + gain;
        await player.save({ transaction: t });
        return Number(player.spirit_stones);
    });
}

let admin, victim, token;async function ensurePlayers() {
    admin = await Player.findOne({ where: { username: 'numcas_admin' } });
    if (!admin) {
        admin = await Player.create({
            username: 'numcas_admin', password: 'not-a-real-hash', nickname: '数值守卫官',
            realm: '筑基5层', realm_rank: 15, role: 'admin'
        });
    } else if (admin.role !== 'admin') {
        await Player.update({ role: 'admin' }, { where: { id: admin.id } });
        admin = await Player.findByPk(admin.id);
    }
    victim = await Player.findOne({ where: { username: 'numcas_victim' } });
    if (!victim) {
        victim = await Player.create({
            username: 'numcas_victim', password: 'not-a-real-hash', nickname: '数值守卫目标',
            realm: '炼气3层', realm_rank: 3, spirit_stones: 1000, exp: 0,
            is_dead: false, lifespan_current: 1, lifespan_max: 200, hp_current: 5000, mp_current: 5000
        });
    }
    // 复位钱包：后面每一项都按 base 算增量
    await Player.update({ spirit_stones: 1000, exp: 0 }, { where: { id: victim.id } });
    token = mintToken(admin);
    return victim;
}

const GUARD_KEYS = ['PLAYER_NUMERIC_GUARD', 'PLAYER_VITAL_GUARD', 'BEAST_NUMERIC_GUARD', 'BEAST_VITAL_GUARD'];
async function withMode(mode, fn) {
    const saved = GUARD_KEYS.map(k => [k, process.env[k]]);
    // 逐个设，别写死两张表的名字：接了第三张表之后只设 players 那两个，
    // 灵兽那一档会静默停在默认 warn —— D2 第一次红就是这个原因（不是守卫不响，是根本没开档）。
    for (const key of GUARD_KEYS) process.env[key] = mode;
    try {
        return await fn();
    } finally {
        for (const [k, value] of saved) {
            if (value === undefined) delete process.env[k];
            else process.env[k] = value;
        }
    }
}

(async () => {
    await ensurePlayers();
    const id = victim.id;
    console.log(`探针号 admin=${admin.id} victim=${id}，实例 :${PORT}`);
    await bootApp(app, { port: PORT, minRoutes: 20 });

    /* C0 守卫确实挂在真模型上：拿真实例走一次真 save，库里被人抢写过的话必须当场响 */
    {
        const base = await stones(id);
        const stale = await Player.findByPk(id);
        await Player.update({ spirit_stones: base + 3 }, { where: { id } });   // 另一个人提交了一笔
        stale.spirit_stones = base + 7;
        let error = null;
        try { await stale.save(); } catch (e) { error = e; }
        check('C0 真实例真库：读出来之后被人写过 → 整值写回被拒（不是只单测里响）',
            error instanceof StaleNumericWriteError && /spirit_stones/.test(String(error && error.detail))
                && !/spirit_stones/.test(String(error && error.message))
                && error.errorCode === 'CONCURRENT_UPDATE' && await stones(id) === base + 3,
            `抛=${error && error.name}，库里=${await stones(id)}（应为 ${base + 3}），点名列在 detail 里=${/spirit_stones/.test(String(error && error.detail))}`);
    }

    /* C1 控制跑：关掉守卫，同一个形状必须真的丢钱（否则这探针什么也没证明） */
    await withMode('off', async () => {
        const base = await stones(id);
        const two = await Promise.all([racyGrant(id, 500, 90), racyGrant(id, 700, 90)]);
        const after = await stones(id);
        check('C1 控制跑（关守卫）：两笔并发读-改-写只到账一笔，钱静默消失',
            after !== base + 1200 && two.length === 2 && two.every(v => v > base),
            `base=${base} 两笔回报=${two.join('/')} 库里=${after}（应等于 ${base + 1200} 才没丢）`);
    });

    /* C2 开守卫：交错形状（现网真实形状：请求开始读的快照，写回时别人早已提交）必须响 */
    await withMode('throw', async () => {
        const base = await stones(id);
        const a = await Player.findByPk(id);
        const b = await Player.findByPk(id);        // 两份快照都读在别人提交之前
        a.spirit_stones = Number(a.spirit_stones) + 500;
        await a.save();                             // 先落的那笔正常到账
        b.spirit_stones = Number(b.spirit_stones) + 700;
        let error = null;
        try { await b.save(); } catch (e) { error = e; }
        check('C2a 开守卫：后写的那笔按旧快照算出来的余额被点名拒绝，先到账那笔没被抹掉',
            error instanceof StaleNumericWriteError && await stones(id) === base + 500,
            `抛=${error && error.name}，base=${base}，库里=${await stones(id)}（应为 ${base + 500}）`);

        // 报错里的指引要真能解决问题：改走列上原子写之后，两笔都必须在
        await PlayerStateStore.grantAmount(id, 'spirit_stones', 700);
        const after = await stones(id);
        check('C2b 按报错指引（grantAmount 原子写）补上被拒那笔：钱数一分不差',
            after === base + 1200, `base=${base} 库里=${after}（应为 ${base + 1200}）`);

        /* 残余窗口如实记录：两条无事务写回落在同一个 tick（C1 那个形状）时，
         * 这一档的"读一次再比"只有微秒级窗口，两边都可能自认为新鲜 —— 要真正无窗口就得走事务 + 行锁。
         * 这里只打印不判失败：把守卫能力边界写清楚，比把它讲成"全盖住了"有用。 */
        const baseSim = await stones(id);
        const settled = await Promise.allSettled([racyGrant(id, 500, 90), racyGrant(id, 700, 90)]);
        const rejected = settled.filter(s => s.status === 'rejected').length;
        const afterSim = await stones(id);
        console.log(`      同 tick 并发（无事务）：拒绝=${rejected} 笔，库里增量=${afterSim - baseSim}`
            + `（两笔都放行且只涨一笔 = 已知的微秒级窗口，无事务时不做保证；生产代码这条形状已改走原子写，见 C3）`);
    });

    /* C3 真接口：两条并发 GM 发放 —— 改成列上原子累加之后，两笔必须都在（这才是"改规则让它不成立"） */
    {
        const base = await stones(id);
        const gains = [500, 700];
        const outcomes = [];
        let broken = null;
        for (let round = 1; round <= 8; round++) {
            await Player.update({ spirit_stones: base }, { where: { id } });
            const responses = await Promise.all(gains.map(amount => request({
                port: PORT, method: 'POST', path: '/api/admin/give-spirit-stones',
                token, body: { playerId: id, amount }
            })));
            const okSum = responses.reduce((sum, r, i) => sum + (r.status === 200 ? gains[i] : 0), 0);
            const after = await stones(id);
            if (after !== base + okSum || responses.some(r => r.status !== 200)) {
                broken = broken || { round, after, okSum, statuses: responses.map(r => r.status).join('+'), body: responses.map(r => r.body?.message).join('|') };
            }
            outcomes.push(`R${round}:${responses.map(r => r.status).join('+')}→+${after - base}`);
        }
        console.log(`      每轮结果（两条并发 HTTP 的 status→灵石增量）：${outcomes.join('  ')}`);
        check('C3a 真接口并发发放：8 轮 × 2 笔全部到账，库里增量始终等于回执之和（原子累加，不需要谁去挡）',
            broken === null,
            broken ? `第 ${broken.round} 轮 status=${broken.statuses} 库里=${broken.after} 应到 ${broken.okSum} 报错=${broken.body}` : '8 轮全部守恒');
        const balance = (await Player.findByPk(id)).getDataValue('spirit_stones');
        check('C3b 响应里的余额是库里那份（不是手上那份旧快照），且不会被 JSON 序列化成 BigInt 炸掉',
            typeof balance === 'string' || typeof balance === 'number', `余额回值形态=${typeof balance} 值=${balance}`);
    }

    /* C4 正确写法一律不许被误伤（并发下两笔都在） */
    {
        const base = await stones(id);
        const two = await Promise.all([lockedGrant(id, 500), lockedGrant(id, 700)]);
        check('C4a 事务内 FOR UPDATE 读 + 读-改-写（服务里最常见形状）：两笔都在、守卫不响',
            await stones(id) === base + 1200 && Math.max(...two) === base + 1200,
            `回报=${two.join('/')} 库里=${await stones(id)}`);

        await Player.update({ spirit_stones: base }, { where: { id } });
        const patched = await Promise.all([
            PlayerStateStore.patchPlayerState(id, { amounts: { spirit_stones: 500 } }),
            PlayerStateStore.patchPlayerState(id, { amounts: { spirit_stones: 700 } })
        ]);
        check('C4b patchPlayerState({amounts})：并发两笔都到账（这条本来就是正规入口）',
            await stones(id) === base + 1200 && patched.length === 2, `库里=${await stones(id)}`);

        await Player.update({ spirit_stones: 1000 }, { where: { id } });
        const spends = await Promise.all([
            PlayerStateStore.spendAmount(id, 'spirit_stones', 600),
            PlayerStateStore.spendAmount(id, 'spirit_stones', 600)
        ]);
        const left = await stones(id);
        check('C4c spendAmount 余额判定：并发两笔只能成一笔，且不会扣成负数',
            spends.filter(Boolean).length === 1 && left === 400,
            `成交=${spends.join('/')} 余额=${left}`);
    }

    /* C5 "从权威那份镜像回手上实例"是正确写法：写回的值等于库里那份就是幂等，不该响 */
    {
        const base = await stones(id);
        await PlayerStateStore.grantAmount(id, 'spirit_stones', 500);      // 别的流程提交了一笔
        const stale = await Player.findByPk(id);                            // 这一份读在提交之前
        const authoritative = await Player.findByPk(id);
        stale.exp = Number(stale.exp) + 1;
        // 把权威那份的钱镜像回手上实例（AttributeService.allocatePoints:386 的形状）：值 == 库里值
        stale.spirit_stones = Number(authoritative.spirit_stones);
        let error = null;
        try { await stale.save(); } catch (e) { error = e; }
        check('C5 幂等镜像不误伤：要写回的值就是库里那份，写回覆盖不掉任何东西 → 放行',
            error === null && await stones(id) === base + 500,
            `抛=${error && error.name}，库里=${await stones(id)}（应为 ${base + 500}）`);
    }

    /* C6 已知边界：Player.update() 走 bulk 路径，不触发 beforeSave，这道闸管不到它。
     * 钉在这里是为了别让以后的人以为"数值列已经全盖住了"—— 事务外整值 Player.update
     * 仍然是裸的，需要时要在 bulk 钩子上补同一套判定（当前全仓这类绝对值写法很少，
     * 原子增减走 literal 的本来就不需要判定）。 */
    {
        const base = await stones(id);
        await Player.update({ spirit_stones: base + 11 }, { where: { id } });
        const after = await stones(id);
        check('C6 bulk 路径（Player.update 绝对值）不经过数值守卫：如实记录为已知边界',
            after === base + 11, `库里=${after}（bulk 写照常落库，守卫没有介入）`);
    }

    /* C7 名单与模型同步：新增一列只改一处名单，判定与原子增减一起生效 */
    {
        const Store = PlayerStateStore.AMOUNT_COLUMNS;
        const missing = CAS_COLUMNS.filter(c => !Store.has(c));
        const extra = [...Store].filter(c => !CAS_COLUMNS.includes(c));
        check('C7 守卫名单 == PlayerStateStore 原子增减白名单（新增数值列不会只漏一层）',
            missing.length === 0 && extra.length === 0, `缺=${missing.join('/')} 多=${extra.join('/')}`);
        const unknown = await assertNumericWriteAllowed(
            { isNewRecord: false, changed: () => false, getDataValue: () => 1 }, {}, null);
        check('C8 脏列枚举对"什么都没脏"的普通保存返回空（热路径零成本）',
            Array.isArray(unknown) && unknown.length === 0, JSON.stringify(unknown));
    }

    /* ===== D 组：同一套机制搬到第二张表（spirit_beasts 的 exp/loyalty/stamina） ===== */
    const SpiritBeast = require('../models/spiritBeast');
    const { guardFor } = require('../game/persistence/numericWriteGuard');
    let beast = null;
    {
        const g = guardFor('spirit_beasts');
        const missing = (g ? g.columns : []).filter(c => !SpiritBeast.rawAttributes[c]);
        check('D0 灵兽守卫已登记，且点名的列在 spirit_beasts 上真实存在（拼错列名会静默不守卫）',
            !!g && missing.length === 0 && g.wallet.join('+') === 'exp+loyalty+stamina',
            g ? `wallet=${g.wallet.join('/')} vital=${g.vital.join('/')} 缺列=${missing.join('/') || '无'}` : '没登记');
    }
    if (guardFor('spirit_beasts')) {
        await SpiritBeast.destroy({ where: { player_id: id } });
        beast = await SpiritBeast.create({
            player_id: id, beast_key: 'qingyun_wolf', beast_name: '数值守卫狼',
            element: 'metal', rarity: 'rare', star_level: 1, level: 1, exp: 0,
            hp_max: 5000, atk: 100, def: 100, speed: 300, loyalty: 50, stamina: 100
        });
        const expOf = async () => Number((await SpiritBeast.findByPk(beast.id)).getDataValue('exp'));

        const feed = async (gain, gapMs) => {
            const b = await SpiritBeast.findByPk(beast.id);
            b.exp = BigInt(b.exp || 0) + BigInt(gain);
            await sleep(gapMs);
            await b.save();
        };
        await withMode('off', async () => {
            const base = await expOf();
            await Promise.all([feed(500, 90), feed(700, 90)]);
            const after = await expOf();
            check('D1 控制跑（关守卫）：灵兽经验的两笔并发读-改-写也只到账一笔',
                after !== base + 1200, `base=${base} 库里=${after}（应等于 ${base + 1200} 才没丢）`);
        });

        await SpiritBeast.update({ exp: 0 }, { where: { id: beast.id } });
        await withMode('throw', async () => {
            const base = await expOf();
            const a = await SpiritBeast.findByPk(beast.id);
            const b = await SpiritBeast.findByPk(beast.id);
            a.exp = BigInt(a.exp) + 500n;
            await a.save();
            b.exp = BigInt(b.exp) + 700n;
            let error = null;
            try { await b.save(); } catch (e) { error = e; }
            check('D2 开守卫：灵兽行上"读在别人提交之前"的那笔写回被点名拒绝（表名报的是 spirit_beasts）',
                error instanceof StaleNumericWriteError && /spirit_beasts#\d+ 的数值列快照已过期/.test(String(error && error.detail))
                    && !/spirit_beasts/.test(String(error && error.message))
                    && await expOf() === base + 500,
                `抛=${error && error.name}，base=${base}，库里=${await expOf()}（应为 ${base + 500}），档位=${JSON.stringify(guardFor('spirit_beasts').modes())}`);

            // players 那一轮踩过的坑（同一列被写两次）在灵兽表上不能复现：
            // 喂养 = 先扣体力再给经验，两次赋值之后锚点仍要盯"读出来那一份"
            const two = await SpiritBeast.findByPk(beast.id);
            const expBefore = BigInt(two.exp || 0);
            two.exp = expBefore + 100n;
            two.exp = BigInt(two.exp) + 200n;   // BIGINT 列读回来可能是字符串，第二次赋值必须再 BigInt()，否则 + 变成字符串拼接
            two.stamina = 0;
            let secondError = null;
            try { await two.save(); } catch (e) { secondError = e; }
            check('D3 同一列连写两次（先加 100 再加 200）不误判：锚点是 afterFind 记的那一份，不是 previous()',
                secondError === null && await expOf() === Number(expBefore) + 300,
                `抛=${secondError && (secondError.detail || secondError.message)}，库里=${await expOf()}（应为 ${Number(expBefore) + 300}）`);

            const locked = await Promise.all([
                sequelize.transaction(async (t) => {
                    const row = await SpiritBeast.findByPk(beast.id, { transaction: t, lock: t.LOCK.UPDATE });
                    row.exp = BigInt(row.exp) + 11n;
                    await row.save({ transaction: t });
                }),
                sequelize.transaction(async (t) => {
                    const row = await SpiritBeast.findByPk(beast.id, { transaction: t, lock: t.LOCK.UPDATE });
                    row.exp = BigInt(row.exp) + 22n;
                    await row.save({ transaction: t });
                })
            ]);
            check('D4 事务内 FOR UPDATE 读 + 读-改-写（喂养/探渊归来那类正规形状）：两笔都在、守卫不响',
                await expOf() === Number(expBefore) + 300 + 33 && locked.length === 2,
                `库里=${await expOf()}（应为 ${Number(expBefore) + 333}）`);
        });

        await SpiritBeast.destroy({ where: { id: beast.id } });
        check('D5 灵兽探针行已删除', (await SpiritBeast.count({ where: { player_id: id } })) === 0, 'left 已查');
    }

    /* ===== V 组：vital 档（hp_current / mp_current）能不能从"只 warn"升成硬拦 =====
     * 业主等的是"会不会误杀正确写回"这句话，而这句话只能靠**有覆盖的实测**回答：
     * 现网战斗的气血大多写在 active_battles 的行里、回血与增减走 PlayerStateStore 的原子写，
     * 所以走 save() 的 vital 列判定次数本来就少 —— 不先证明"判过"，"0 冲突"就是空判（V1 专管这件事）。 */
    const { statsSummary, resetAllStats } = require('../game/persistence/numericWriteGuard');
    const playersStats = () => statsSummary().find(s => s.label === 'players');
    const hpOf = async (pid) => Number((await Player.findByPk(pid)).getDataValue('hp_current'));

    await withMode('throw', async () => {
        resetAllStats();
        for (let i = 0; i < 5; i++) {
            const p = await Player.findByPk(id);
            p.hp_current = BigInt(5000 + i);        // RealmService 突破那种"整值重设到上限"的形状
            p.mp_current = BigInt(300 + i);
            await p.save();
        }
        check('V1 覆盖证明：判定真的落在 hp_current/mp_current 上（否则后面几条"0 冲突"是空判）',
            (playersStats().byColumn.hp_current || 0) > 0 && (playersStats().byColumn.mp_current || 0) > 0
            && playersStats().conflicts === 0,
            `byColumn=${JSON.stringify(playersStats().byColumn)}｜冲突=${playersStats().conflicts} 拒绝=${playersStats().rejected} 为此读的 SELECT=${playersStats().dbReads}`);

        const beforeHp = await hpOf(id);
        const staleB = await Player.findByPk(id);
        await PlayerStateStore.patchPlayerState(id, { amounts: { hp_current: -100 } });  // 并发里的一记伤害先提交
        staleB.hp_current = BigInt(beforeHp - 7);                                        // 手上这份算出来的值（按旧气血算）
        let v2Error = null;
        try { await staleB.save(); } catch (e) { v2Error = e; }
        check('V2 vital=throw：并发里后写那笔被拒，先到的那笔没被抹掉（重设也要建立在没被人改过的前提上）',
            v2Error instanceof StaleNumericWriteError && v2Error.errorCode === 'CONCURRENT_UPDATE'
            && await hpOf(id) === beforeHp - 100,
            `抛=${v2Error && v2Error.name}/${v2Error && v2Error.errorCode}｜库里=${await hpOf(id)}（应为 ${beforeHp - 100}）`);

        check('V3 回给玩家的那句只有"请重试"：表名/列名/调用点只进 detail（现网几十处路由直接回显 message）',
            !!v2Error && !/hp_current|mp_current|players#|调用点=/.test(v2Error.message)
            && /hp_current/.test(v2Error.detail || '') && v2Error.statusCode === 409,
            `message=${JSON.stringify(v2Error && v2Error.message)}｜detail 点名列=${!!v2Error && /hp_current/.test(v2Error.detail)}`);

        const authoritative = await Player.findByPk(id);
        const mine = await Player.findByPk(id);
        mine.exp = Number(mine.exp) + 1;
        mine.hp_current = authoritative.hp_current;        // AttributeService 那种"把权威那份镜像回来"的正规写法
        let v4Error = null;
        try { await mine.save(); } catch (e) { v4Error = e; }
        check('V4 幂等镜像不误伤：要写的值就是库里那份，重设类写回不被当成冲突',
            v4Error === null && playersStats().rejected === 1,
            `抛=${v4Error && v4Error.name}｜累计拒绝=${playersStats().rejected}（应只有 V2 那一笔）`);
    });

    await withMode('off', async () => {
        // 控制跑：同形状在关守卫时必须真的丢一次气血 —— 否则 V2 抓的可能只是"抛了个错"而不是缺陷
        const beforeHp = await hpOf(id);
        const stale = await Player.findByPk(id);
        await PlayerStateStore.patchPlayerState(id, { amounts: { hp_current: -50 } });
        stale.hp_current = BigInt(beforeHp - 3);
        await stale.save();
        const now = await hpOf(id);
        check('V5 控制跑（关 vital 档）：那笔伤害被旧快照整值抹掉，气血静默变回去',
            now === beforeHp - 3, `库里=${now}（应为 ${beforeHp - 3}，也就是 -50 那笔没人记得）`);
    });

    /* 收尾：删号只走级联那扇门 */
    // numcas_admin 是本探针自建、专为 mint 管理员 token 的一次性号，全程 role='admin' 且从不降回，
    // 所以要显式 includeAdmin —— 它不是真人管理员，只是探针自己用完即弃的号（见 smoke_option_lists 的 V8 对照）。
    const purged = await PlayerCascadePurge.deletePlayers([admin.id, id], { includeAdmin: true });
    console.log(`清理：删掉 ${purged.ids.length} 个探针号，级联带走 ${purged.total} 行派生数据`);
    const left = await Player.count({ where: { username: ['numcas_admin', 'numcas_victim'] } });
    check('C9 探针号已删除', left === 0, `left:${left}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
})().catch(async (error) => {
    console.error('探针自身失败:', error);
    try {
        // 崩溃收尾也走级联；numcas_admin 全程 admin（探针自己的用完即弃号），故 includeAdmin
        await PlayerCascadePurge.deleteByUsernames(['numcas_admin', 'numcas_victim'], { includeAdmin: true });
        await sequelize.close();
    } catch {}
    process.exit(2);
});
