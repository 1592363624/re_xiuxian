/**
 * 取锁次序差分矩阵（需要 MySQL，走 .env 指向的隔离库）
 *
 * 要证的事很具体：**同一批行按两种次序去锁，反序的会在数据库层面死锁，正序的不会。**
 * 不靠"发两个请求碰运气"（那样 0 次死锁什么都证明不了 —— 见 smoke_fengshen_defense F6/F7 的教训：
 * 持锁窗口只占单笔调用 10% 时，并发压不出交错是常态）。这里直接用两条连接按指定次序压同一对行，
 * 并把 innodb_lock_wait_timeout 调小，结果是确定性的。
 *
 * 每一对 (表A, 表B) 跑两轮：
 *   正序：T1 锁 A→等 B；T2 锁 B→等 A 之前先按同一次序来 —— 两边都按 A→B，永不形成环，只有排队；
 *   反序：T1 按 A→B，T2 按 B→A —— 典型 ABBA，必报 ER_LOCK_DEADLOCK（或锁等待超时）。
 * 只有"反序真的会炸、正序真的不炸"同时成立，这对次序才算定下来；否则就是探针自己空跑。
 *
 * 用法：cd server && node --env-file=.env scripts/smoke_lock_order_matrix.js
 * 只碰自建探针号（lockmatrix01）自己的行，跑完删干净。
 */
'use strict';

const PORT = Number(process.env.SMOKE_PORT || 5084);
process.env.PORT = String(PORT);

const { app } = require('../index');
const Player = require('../models/player');
const ActiveBattle = require('../models/activeBattle');
const PlayerLaw = require('../models/playerLaw');
const PlayerDivineSense = require('../models/playerDivineSense');
const StockMarginAccount = require('../models/stockMarginAccount');
const Stock = require('../models/stock');
const Item = require('../models/item');
const SpiritBeast = require('../models/spiritBeast');
const PlayerCave = require('../models/playerCave');
const DaoCompanion = require('../models/daoCompanion');
const DaoCompanions = require('../models/daoCompanions');
const BeastInvasion = require('../models/beastInvasion');
const MultiDungeonInstance = require('../models/multiDungeonInstance');
const PlayerDivineDuel = require('../models/playerDivineDuel');
const sequelize = require('../config/database');
const { bootApp } = require('./lib/smoke_http');
const { LOCK_PRECEDENCE, rankOf } = require('../game/persistence/lockOrder');

const ACCOUNT = 'lockmatrix01';
const PEER_ACCOUNT = 'lockmatrix02';
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  ${detail || ''}`);
}

const isDeadlockish = e => /Deadlock|lock wait timeout|ER_LOCK_DEADLOCK|ER_LOCK_WAIT_TIMEOUT/i.test(`${e.code || ''} ${e.message || ''}`);

/**
 * 拿一条独立连接、把锁等待调到 2 秒，跑传入的取锁序列。
 * 注意：Sequelize 的连接池给的是 mysql2 的**回调式**连接，必须 `.promise()` 包一层再 await，
 * 否则 await 会直接抛 "You have tried to call .then() ... not a promise"。
 * 事务控制一律走裸 SQL（BEGIN/COMMIT/ROLLBACK），不依赖连接的快捷方法是否存在。
 */
async function withConnection(run) {
    const raw = await sequelize.connectionManager.getConnection();
    const conn = raw.promise ? raw.promise() : raw;
    let ok = false;
    try {
        await conn.query('SET SESSION innodb_lock_wait_timeout = 2');
        await conn.query('BEGIN');
        const out = await run(conn);
        ok = true;
        return out;
    } finally {
        try { await conn.query(ok ? 'COMMIT' : 'ROLLBACK'); } catch (e) { /* 已被死锁回滚 */ }
        // releaseConnection 的返回值不保证是 Promise（v6 这里给的是 undefined），别链式 .catch
        try { await sequelize.connectionManager.releaseConnection(raw); } catch (e) { /* 连接还池里去不了就算了 */ }
    }
}

async function lockRow(conn, table, where) {
    await conn.query(`SELECT id FROM \`${table}\` WHERE ${where} FOR UPDATE`);
}

/**
 * 一对表压两轮：
 *   反序：T1 按 A→B、T2 按 B→A —— 两边各自拿到第一把锁后互相伸手，典型 ABBA；
 *   正序：两边都按 A→B —— 只会在第一把锁上排队，形不成环。
 * 两笔都等到"对方也拿到了自己的第一把锁"才开始抢第二把（拿不到就 1.5s 后放行，
 * 正序那一轮本来就会串行，超时放行是预期路径）。
 */
async function hammerPair(label, tableA, condA, tableB, condB) {
    const A = { t: tableA, c: condA }, B = { t: tableB, c: condB };
    const makeBarrier = () => {
        let release;
        const gate = new Promise(r => { release = r; });
        let arrived = 0;
        return async () => {
            arrived++;
            if (arrived >= 2) release();
            await Promise.race([gate, new Promise(r => setTimeout(r, 1500))]);
        };
    };
    const txn = (first, second, barrier) => withConnection(async conn => {
        await lockRow(conn, first.t, first.c);
        await barrier();
        try {
            await lockRow(conn, second.t, second.c);
        } catch (e) {
            return isDeadlockish(e) ? 'deadlock' : `err:${(e.message || '').slice(0, 34)}`;
        }
        return 'ok';
    });

    const b1 = makeBarrier();
    const rev = await Promise.all([txn(A, B, b1), txn(B, A, b1)]);
    const b2 = makeBarrier();
    const fwd = await Promise.all([txn(A, B, b2), txn(A, B, b2)]);
    const dead = arr => arr.filter(x => x === 'deadlock').length;

    check(`${label} 反序真的会死锁（压不出环就说明形状不对，不许当已证）`, dead(rev) >= 1,
        `两笔=${rev.join(' , ')}`);
    check(`${label} 正序（都 ${tableA}→${tableB}）只排队不死锁`, dead(fwd) === 0 && fwd.every(x => x === 'ok'),
        `两笔=${fwd.join(' , ')}`);
}

async function main() {
    await bootApp(app, { port: PORT });
    const precedenceOk = LOCK_PRECEDENCE.every((m, i) => i === 0 || rankOf(LOCK_PRECEDENCE[i - 1]) < rankOf(m));
    check('M0 口径表本身是严格递增的（打字重复会让两表同秩、次序又变成随机）', precedenceOk,
        LOCK_PRECEDENCE.map(m => `${m}=${rankOf(m)}`).join(' '));

    let player = await Player.findOne({ where: { username: ACCOUNT } });
    if (!player) {
        player = await Player.create({
            username: ACCOUNT, password: 'x', nickname: '次序矩阵探针',
            realm: '炼气3层', realm_rank: 3, exp: 0, spirit_stones: 0,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    }
    const pid = player.id;
    await ActiveBattle.destroy({ where: { player_id: pid }, force: true });
    await PlayerLaw.findOrCreate({ where: { player_id: pid }, defaults: { player_id: pid, law_points: 0, law_fragments_space: 0, law_fragments_time: 0, law_fragments_five_elements: 0, law_fragments_soul: 0, law_fragments_karma: 0 } });
    await PlayerDivineSense.findOrCreate({ where: { player_id: pid }, defaults: { player_id: pid, divine_sense_max: 100, divine_sense_current: 0, regen_rate_per_hour: 10, total_quenched: 0, total_consumed: 0 } });
    // 融资账户行：is_liquidated 置 true，让 60 秒一次的强平任务在第一眼就跳过探针（不去碰探针的持仓/股票行）
    await StockMarginAccount.findOrCreate({
        where: { player_id: pid },
        defaults: { player_id: pid, total_assets: 0, debt: 0, margin_ratio: 0, is_liquidated: true }
    });
    const battle = await ActiveBattle.create({
        player_id: pid, monster_id: 1, map_id: 1, monster_name: '次序矩阵假怪', battle_uuid: 'lock-matrix-battle',
        monster_hp: 1000, monster_hp_max: 1000, player_hp: 5000, battle_round: 1,
        is_player_turn: true, monster_data: {}
    });
    check('M1 四张表里探针自己的行都备好了', !!battle && Number(battle.player_id) === pid,
        `player=${pid} battle=${battle && battle.id} margin=${(await StockMarginAccount.findOne({ where: { player_id: pid } }))?.id}`);

    // 表名一律从模型要（`player_law` 是单数、`active_battles` 是多数 —— 猜不得）
    const T = m => m.getTableName();
    // players ↔ active_battle：口径说 players 先。反序必须炸。
    await hammerPair('players↔active_battle', T(Player), `id = ${pid}`, T(ActiveBattle), `player_id = ${pid}`);
    // players ↔ player_law
    await hammerPair('players↔player_law', T(Player), `id = ${pid}`, T(PlayerLaw), `player_id = ${pid}`);
    // player_law ↔ player_divine_sense（口径说 law 先；两边反过来就是第 15 对里那个方向）
    await hammerPair('player_law↔player_divine_sense', T(PlayerLaw), `player_id = ${pid}`, T(PlayerDivineSense), `player_id = ${pid}`);

    // players ↔ stock_margin_accounts：强平任务改造前正是"先锁融资账户、再回头锁 players"，
    // 而买卖/偿还全是 players→margin —— 每 60 秒一轮的后台任务与玩家那一笔融资买入就是环的两边。
    await hammerPair('players↔stock_margin_accounts', T(Player), `id = ${pid}`, T(StockMarginAccount), `player_id = ${pid}`);

    // players ↔ items：同一个人手里同一枚丹药有两条使用路（背包面板 InventoryService.useItem、
    // 战斗中 CombatService.useItem），改造前一条 items→players、一条 players→items，两个面板各点一次就是环。
    const [itemRow] = await Item.findOrCreate({
        where: { player_id: pid, item_key: 'lock_matrix_pill' },
        defaults: { player_id: pid, item_key: 'lock_matrix_pill', quantity: 3, metadata: {} }
    });
    await hammerPair('players↔items', T(Player), `id = ${pid}`, T(Item), `id = ${itemRow.id}`);

    // players ↔ spirit_beasts：探渊结算（含 index.js 里周期跑的 checkExpirations）改造前是
    // 灵兽行 → players，而喂灵兽/放归/巡边归来是 players → 灵兽行，同一个人两个面板就能凑成环。
    const beastRow = await SpiritBeast.create({
        player_id: pid, beast_key: 'lock_matrix_beast', beast_name: '次序矩阵假兽', element: 'metal',
        rarity: 'common', star_level: 1, level: 1, exp: 0, hp_max: 100, atk: 10, def: 10, speed: 10,
        loyalty: 10, is_active: false, is_pasturing: false, is_exploring: false, stamina: 100
    });
    // players ↔ player_caves：洞府那几个面板（升级设施/收取灵石/解锁药园/布置景观/货摊购买）此前有一批是先锁洞府行再回头锁玩家行
    const [caveRow, caveRowCreated] = await PlayerCave.findOrCreate({
        where: { player_id: pid }, defaults: { player_id: pid, is_opened: true }
    });
    await hammerPair('players↔player_caves', T(Player), `id = ${pid}`, T(PlayerCave), `id = ${caveRow.id}`);

    // players ↔ 妖兽入侵事件行：attackBeast 改造前先锁全服那行妖兽、再回头锁玩家行，而本服务的
    // donate、结算、巡边归来都是 players → 事件行。妖兽战是全服同打的事件，一次出手撞上任一条
    // 反向路径就是环，跟"同一个人开两个面板"无关。
    const invasionRow = await BeastInvasion.create({
        beast_key: 'lock_matrix_beast_invader', beast_name: '次序矩阵假妖兽',
        start_time: new Date(), status: 'ended', phase: 'idle'   // 故意留成已结束：本服务有周期调度器，
    });                                                          // 建一条 active 会真被拿去结算/广播
    await hammerPair('players↔beast_invasions', T(Player), `id = ${pid}`, T(BeastInvasion), `id = ${invasionRow.id}`);

    // players ↔ multi_dungeon_instance：队长点"抉择"时原来是先锁副本行、走到"这次要花灵石"才回头锁
    // players（不要灵石的抉择干脆不锁），而 join/leave/结算是 players → 副本行。
    const dungeonRow = await MultiDungeonInstance.create({
        instance_key: 'lock_matrix_dungeon', instance_name: '次序矩阵假副本',
        leader_player_id: pid, leader_nickname: '次序矩阵探针',
        member_max: 4, member_min: 1, expire_at: new Date(Date.now() + 3600 * 1000)
    });
    await hammerPair('players↔multi_dungeon_instance', T(Player), `id = ${pid}`, T(MultiDungeonInstance), `id = ${dungeonRow.id}`);

    await hammerPair('players↔spirit_beasts', T(Player), `id = ${pid}`, T(SpiritBeast), `id = ${beastRow.id}`);

    // players ↔ 道侣关系行（两张表 dao_companion / dao_companions 各压一次）：道侣是**两个真人**的玩法，
    // "寻找道侣/求婚"走 players → 关系行，而"接受邀请/响应求婚"改造前是关系行 → players ——
    // 一人邀请、对方正好同时在自己那头点一下，环就凑齐了，不需要一个人开两个面板。
    // 行本身只当"一把要抢的锁"用，所以两个 player_id 都填探针自己（清理时按同一条件删）。
    for (const [model, label] of [[DaoCompanion, 'dao_companion'], [DaoCompanions, 'dao_companions']]) {
        const [row] = await model.findOrCreate({
            where: { player_a_id: pid, player_b_id: pid }
        });
        await hammerPair(`players↔${label}`, T(Player), `id = ${pid}`, T(model), `id = ${row.id}`);
    }

    // 同一张表内的多行：口径要求按主键升序锁。这里拿两只真股票行，按升序/降序各压一次
    //（强平出清要按持仓遍历股票行，持仓返回次序不等于 id 次序，两个玩家同轮出清就可能互等）。
    const twoStocks = await Stock.findAll({ attributes: ['id'], order: [['id', 'ASC']], limit: 2 });
    if (twoStocks.length === 2) {
        await hammerPair('stocks 同表两行', T(Stock), `id = ${twoStocks[0].id}`, T(Stock), `id = ${twoStocks[1].id}`);
    } else {
        check('stocks 同表两行', false, `库里只有 ${twoStocks.length} 只股票，压不出"同表两行按 id 升序"这条`);
    }

    // players 同表两行 —— 上面那 22 处"同表逐个加锁"站点（闸里的 SAME_TABLE_DEBT）压的就是这个形状：
    // 两处 findByPk 的先后由调用方传参决定，两个人互相发起（PvP 挑战 / 道侣邀请 / 竞拍）时两边正好相反。
    let peer = await Player.findOne({ where: { username: PEER_ACCOUNT } });
    if (!peer) {
        peer = await Player.create({
            username: PEER_ACCOUNT, password: 'x', nickname: '次序矩阵对手',
            realm: '炼气3层', realm_rank: 3, exp: 0, spirit_stones: 0,
            hp_current: 5000, mp_current: 5000, lifespan_current: 120, attributes: {}, token_version: 0
        });
    }
    const [lowId, highId] = [pid, peer.id].sort((a, b) => a - b);
    await hammerPair('players 同表两行', T(Player), `id = ${lowId}`, T(Player), `id = ${highId}`);

    // players ↔ player_divine_duels：神识对决此前整个服务都是"先锁对局行再回头锁 players"，
    // 而发起挑战是 players → 对局行；后台 checkTimeouts 每轮扫对局行，撞上任一个玩家动作就是环。
    // （改前的实测死锁率见 scripts/smoke_divine_duel.js 的 D6：两人互发挑战 6 轮里 4~6 轮 Deadlock。）
    const duelRow = await PlayerDivineDuel.create({
        challenger_id: pid, defender_id: peer.id, bet_type: 'spirit_stone', bet_amount: 100, status: 'active'
    });
    await hammerPair('players↔player_divine_duels', T(Player), `id = ${lowId}`, T(PlayerDivineDuel), `id = ${duelRow.id}`);
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
            const p = await Player.findOne({ where: { username: ACCOUNT } });
            if (p) {
                await ActiveBattle.destroy({ where: { player_id: p.id }, force: true });
                await PlayerLaw.destroy({ where: { player_id: p.id } });
                await PlayerDivineSense.destroy({ where: { player_id: p.id } });
                await StockMarginAccount.destroy({ where: { player_id: p.id } });
                await Item.destroy({ where: { player_id: p.id, item_key: 'lock_matrix_pill' }, force: true });
                await SpiritBeast.destroy({ where: { player_id: p.id, beast_key: 'lock_matrix_beast' }, force: true });
                // 一律按"探针自己的行"删，不用跨作用域的标志位 ——
                // 之前这里读了一个只在 main() 里声明的 caveRowCreated，finally 抛 ReferenceError
                // 被 catch 吞成一行"清理失败"，后面的删号根本没跑（探针号每跑一次漏一个）。
                await PlayerCave.destroy({ where: { player_id: p.id }, force: true });
                await DaoCompanion.destroy({ where: { player_a_id: p.id, player_b_id: p.id }, force: true });
                await DaoCompanions.destroy({ where: { player_a_id: p.id, player_b_id: p.id }, force: true });
                await BeastInvasion.destroy({ where: { beast_key: 'lock_matrix_beast_invader' }, force: true });
                await MultiDungeonInstance.destroy({ where: { instance_key: 'lock_matrix_dungeon' }, force: true });
                await PlayerDivineDuel.destroy({ where: { challenger_id: p.id }, force: true });
                const peerRow = await Player.findOne({ where: { username: PEER_ACCOUNT } });
                if (peerRow) await Player.destroy({ where: { id: peerRow.id }, force: true });
                await Player.destroy({ where: { id: p.id }, force: true });
            }
        } catch (e) { console.error('清理失败:', e.message); }
        await sequelize.close().catch(() => {});
        const failed = results.filter(r => !r.ok).length + hard;
        console.log(`\n${results.length} 项断言，失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }
})();
