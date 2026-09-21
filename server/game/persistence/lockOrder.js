'use strict';
/**
 * 取锁次序（跨玩法的唯一一份口径）
 *
 * 为什么要单独一层：InnoDB 是**逐行**加锁。两个事务各自持有一行、再伸手要对方那行，就是
 * ABBA 死锁 —— 而"同一个玩家的两个面板同时点"天然满足这个形状（比如 法则转换 与 引道领奖）。
 * 全仓 160 个方法会锁两张以上的表，实测有 1 对表在不同方法里次序相反（见
 * tests/LockOrderCensus.test.js 的存量清单）。这类问题改一处没用，要有口径 + 有闸门。
 *
 * 规则（自上而下，先出现的先锁）：
 *   1. `players`            —— 身份/钱包行，几乎所有奖励路径都要写它，放最前让持锁时间最短；
 *   2. **会话/实例行**       —— activeBattle、multiDungeonInstance、playerTaoismGate 这类
 *                              "一个玩法一行、会被同玩家的其它面板回头碰 players" 的行；
 *   3. **全服共享行**        —— stock（报价）、排行榜这类会被很多玩家同时抢的行；
 *   4. **每玩家的子系统行**  —— playerLaw / playerDivineSense / spiritBeast / playerCave / item（背包）…；
 *   5. **聚合/排行写回行**    —— fengshenRanking、spiritBeastPvpRanking、sect 统计行：
 *                              它们常要一次锁很多行，必须放在最后，否则"持着宽范围等一行"。
 *   同一张表内的多行：**按主键升序**锁（`WHERE id IN (…) ORDER BY id ASC FOR UPDATE`）。
 *
 * 现状（2026-09-21）：**跨表这一类的存量已经清零。**
 * 普查（tests/LockOrderCensus.test.js）认出 160 个"一次锁两张以上表"的方法，起初 15 对表次序互相矛盾，
 * 逐对判可达性 + 压确定性差分（scripts/smoke_lock_order_matrix.js，现 30 项）后全部统一到本口径，
 * 债务清单 LOCK_ORDER_DEBT 现在是空表。
 * 但"改对"不等于"看得见"：普查原来只认 `Model.findByPk/findOne/findAll(...LOCK.UPDATE)` 和
 * `this._lockXxx()`，**看不见本文件这个助手** —— 一旦某条路径改成走助手，它就整条从普查里消失，
 * 存量清单会因为"看不见"而变短（假清零）。现在分析器认得 `lockRowsByIdsAsc(t, Model, …)` 了。
 * 验收用的是控制跑：往已经改对的 accept 里塞回一处"锁完对局行再回头单行锁 players"，
 * 闸必须红并点名 `player|playerDivineDuel`（实测红在 DivineDuelService.js:524 accept），还原字节一致后回绿。
 * ⇒ 空清单现在是真的增量护栏，但**只在助手写法被认得的前提下**：以后再加新的取锁助手，
 * 要同步加进 tests/LockOrderCensus.test.js 的 BATCH_LOCK_CALL，否则那道闸又会变瞎。
 * 同一条闸里还冻着**第二份清单**（SAME_TABLE_DEBT，**2026-09-21 已清零**）：一个方法里对 players 连做两次
 *   清完之后它仍然是增量护栏，而且有实证：把 `_settleDefeat` 临时换回"逐行按伤害名次 FOR UPDATE"之后，
 *   同一道闸**两处同时红**（自检："已经走 lockRowsByIdsAsc 了，判定却还把它算成逐个加锁"；存量："新增站点 1 处"），
 *   同时 `scripts/smoke_beast_settle.js` 的并发腿从"6 轮两边都成交 6 轮"掉到"0 轮"（改前那 6 轮报的是
 *   `rollback has been called on this transaction` —— 死锁被 MySQL 杀掉败者后 Sequelize 的包装话术，
 *   只匹配 "Deadlock" 会数出假零零）。还原 sha1 字节一致后两处都回绿。
 * FOR UPDATE 单行读，次序就由业务参数决定（"先锁自己再锁对方"），两个真人各点自己那一头就是环。
 * 跨表普查按"模型对"聚合，players|players 凑不成对 —— 这一类它看不见，所以单列一道闸。
 * 这类站点统一改走 `lockRowsByIdsAsc`：PvpService 三处是"两个人"的模板，
 * `MultiDungeonService._settleRewards` 是"全组一次几十个成员"的模板（批锁回来的实例存 Map，
 * 发奖分支一律查 Map）。**要先把对方 id 才拿得到**的那一类（道侣互动），模板是文件内的
 * `lockCompanionPair` / `lockDaoPair`：无锁 peek 关系行 → 两人升序一次锁齐 → 再锁关系行重看，
 * 拒绝话术仍按 reason 分回各方法自己那句（别糊成一条）。闸对已经批锁过的方法门槛更严：再留一处单行补读就报 ——
 * "批锁 + 后面又逐笔补读"正是最容易偷偷回潮的形状，控制跑压的就是这条。
 * 已按口径改过的：
 *   SpiritBeastPvpService 的 challenge 与赛季结算（players / 排名行都按 id 升序一次锁齐）；
 *   CombatService 的 attack / monsterTurn / useSkill（原先锁 active_battles 再回头锁 players，
 *     与同文件的 encounter 反向，"双击遭遇 + 一次出手"就凑得出环；现在四处统一 players→active_battles）；
 *   StockMarketService 整条钱的通路统一为 players → stocks → stock_holdings → stock_margin_accounts
 *     （sell 原来先锁持仓；强平任务原来先锁融资账户；出清时"遍历持仓逐笔现锁股票行"改成一次按 id 升序锁齐，
 *      GM 强平与后台强平共用 _lockHoldingsForSettlement / _settleLiquidationRepayment 两把门）；
 *   背包与货摊这条统一为 players → items（`InventoryService.useItem` 原先先锁背包行再锁 players，与战斗中
 *     使用同一枚丹药的 `CombatService.useItem` 反向 —— 两个面板各点一次就是环；`MarketService.buyListing`
 *     原先一路锁到对面玩家的背包行才回头锁 players，现在是**双方 players 先按 id 升序锁齐**再锁挂单行与背包行，
 *     这条跨玩家环与"同一人双击"无关，两个活跃玩家同时交易就会撞）；
 *   封神台三条写路径统一为 players(升序) → fengshen_rankings(升序) → 写，并且**批量锁回来就直接用**：
 *     challengeRank / settleSeason 原来在升序批锁之后又逐行补 FOR UPDATE，补读本身不改正确性
 *     （行早已握在手里），但在次序上看着像反向、静态闸也判成两种次序 —— 现在助手把整行读回来，
 *     调用方不再补锁读。settleSeason 还多了一道守卫：锁回来的排名表里若有玩家不在已锁名单内
 *     （结算与新设防守并发），本轮放弃、下一轮重试，而不是持着整张排名表去要一行 players；
 *   AdventureEventService.completeAdventure 同属"锁回来又补读一次"那一类：受伤扣血原来再读一次 players
 *     （注释写着"grantRewards 已更新玩家数据"），于是一笔事务里同一行留着两份实例，
 *     谁后 save 谁覆盖对方。现在 grantRewards 直接收调用方那份已锁实例，受伤也用它 —— 一份实例、一条次序；
 *   BeastAbyssService._settleExplore 统一为 players 先于 spirit_beasts（它原来是 explore → 灵兽 → …… → players，
 *     而喂灵兽/放归/巡边归来是 players → 灵兽；本服务还有个周期跑的 checkExpirations，与股市那条同形）；
 *   洞府五条写路径（升级设施 / 收取灵石 / 解锁药园 / 布置景观 / 货摊购买）统一为 players → player_caves，
 *     前三条原来先锁洞府行、后锁玩家行，而开辟洞府是反的 —— 玩家两个面板各点一次就是 ABBA；
 *     玩家锁提到事务开头后，后面的补读全部改成复用那份实例（一笔事务里同一行只留一份实例）；
 *   道侣两条通路四个方法（seek / accept / propose / respond）统一为 players(两人按 id 升序一次锁齐) → 关系行。
 *     原来 accept/respond 是"先锁关系行再逐个锁两人"，seek/propose 是"锁自己 → 夹一次关系行 FOR UPDATE → 再锁对方"：
 *     一人邀请、对方同时在自己那头点一下就是环，而且**两个真人各点自己那一头**就能凑，不需要开两个面板；
 *     两人锁现在按 id 升序（原来按"发起方/接受方"的业务顺序锁，A 邀 B 与 B 邀 A 同时点又是一对反向）；
 *     accept/respond 改成"无锁 peek 拿到牵涉的两人 → 升序锁齐 → 再锁关系行并重看状态"（同 MarketService.buyListing）。
 *   妖兽战 attackBeast 与组队副本队长抉择 choose 统一为 players → 事件行 / 副本行：
 *     两条原来都是"先锁全服那行事件、走到要花钱时才回头锁 players"（不花钱的抉择干脆不锁 players），
 *     而捐献/结算/巡边归来、join/leave/结算是 players → 事件行 —— 全服同打的事件，撞上任一条反向路径就是环。
 *     注意别"提前锁一次、下面再补读一次"：闸看的是方法内第一次出现的位置，但补读会在同一笔事务里
 *     留下两份 players 实例，谁后 save 谁覆盖对方。正确写法是只锁一次、后面复用那份实例；
 *   神识对决整个服务（challenge / accept / action / surrender / _settleDuel + 后台两条超时回收）
 *     统一为 players(双方按 id 升序一次锁齐) → player_divine_duels。改前 challenge 是"锁发起方 → 校验一串
 *     → 再锁应战方"，两人互发挑战实测 6 轮里 4~6 轮直接 Deadlock（scripts/smoke_divine_duel.js 的 D6）；
 *     accept/action/surrender 与后台 checkTimeouts 则是"先锁对局行 → 再回头锁 players"，而后台每轮都在扫
 *     全服对局行 —— 玩家任何一次点选都在跟它反向。三条入口都改成"无锁 peek 拿双方 → 升序锁齐 →
 *     锁对局行重看状态与当事人"，已锁实例沿 _settleRound → _settleDuel 传下去（结算自己不再 FOR UPDATE）。
 *   拍卖四条写路径（create / placeBid / cancelAuction / _settleOneAuction）里"竞价者 + 前一个竞价者"、
 *     "卖家 + 当前竞价者"都改成一次按 id 升序锁齐（实测改前：两场拍卖互相顶价 12 轮出 1 次 Deadlock、
 *     两个卖家同时撤销对方领先的拍卖 6 轮出 1 次，证据 scripts/smoke_auction.js A14/A15）。
 *     **这里拍卖行仍然在 players 之前锁，是本口径唯一一处刻意的例外**：auctions 全仓只有 AuctionService 自己锁
 *     （routes 不直接摸模型），且永远是它事务里的第一把锁 —— 没有任何路径会"持着 players 再去要 auctions"，
 *     所以这一条边进不了环；反过来若把它挪到 players 之后，就得"peek 拍卖行 → 锁人 → 重看领先者变了就整体重试"，
 *     换来的只是形式统一，代价是竞价高峰出现"请重新出价"。**新增别的服务不要先锁别的再去锁 auctions**，
 *     否则这条例外的前提就没了，要回到口径上。players → items 的相对次序照旧（背包增删都在锁人之后）。
 *   万宝阁展品鉴赏 appreciateExhibit 统一为"展品行 → players(鉴赏者与主人按 id 升序一次锁齐)"：
 *     两人互相鉴赏对方法宝实测 4 轮里 4 次 Deadlock（scripts/smoke_cave_social.js S6，这四轮**每轮都是真并发**，
 *     不像切磋那样第 2 轮起被冷却挡在锁之外）；主人行读不到原本会静默跳过、那笔声望凭空少发，现在中止。
 *     两条"今日次数"校验也一并挪到**锁住鉴赏者那行之后** —— 上限是按人数的，不先锁住这个人，
 *     同时点出去的两笔各自都数到 0（S5 实测 daily_limit=1 时放行 2 笔）。
 *     这条比锁次序更容易漏：**按人计数的配额校验必须排在锁住该玩家之后**，它不报错，只是安安静静多批发奖。
 *   洞天寻宝 treasureHunt 同一批改完：寻宝者 + 洞府主人按 id 升序一次锁齐，而且**每日上限与 24h 冷却
 *     从"事务之外"整体挪进事务、锁住寻宝者那行之后**（改前两笔同时点出去的寻宝各自数到 0：
 *     daily_limit=1 放行 2 笔，且两笔都往同一位主人的灵石上行 `读-改-写` → 最终只扣到一笔多一点的钱，
 *     配额和余额一起错，证据 scripts/smoke_cave_social.js T2）。主人那把锁原来只在随机寻得宝物的分支里拿，
 *     所以并发腿要把 Math.random 钉成 0 才保证每轮两边都真去拿第二行锁（T3），别把"没撞出死锁"当成"没有环"。
 *   悬赏发布 publishBounty：发布者 + 目标按 id 升序一次锁齐。改前是"发布者 → 目标"两把业务角色锁，
 *     两人互相把对方设为目标时 5 轮里 5 轮全 Deadlock（scripts/smoke_bounty.js B4 —— 这一条没有冷却或随机分支
 *     挡路，两边每轮都真的在取两行锁，是同表这一类最纯的形状）。目标行只读不写，锁回来也只是校验用，
 *     但**读也要读在已锁的那一份上**：同事务里再 findByPk 一次就留下两份实例，谁后 save 谁覆盖对方。
 * 其余每改一对，就把清单里那行删掉，并补一条能压出死锁的差分证据
 * （方法见 scripts/smoke_lock_order_matrix.js：同一对表按两种次序各压一次，
 *   反序必须 deadlock、正序必须只排队不死锁 —— 而不是指望并发正好撞上）。
 *
 * 注意普查报的是"两两次序不一致"，不等于两个请求真能同时拿到那两行（有些方法的第二把锁
 * 要等业务里那一行已存在才拿得到）—— 它是**待读清单不是判决书**，划掉一行必须自己压出死锁。
 *
 * 新增写路径时：先想清楚要锁哪几张表，按上面的次序取锁（跨表用 `lockRowsInOrder`，
 * 同表多行用 `lockRowsByIdsAsc` —— 能用助手就别手写），
 * 然后把闸门里对应的存量豁免删掉 —— 删不掉就是没真的统一。
 */

// 表名 → 优先级（数字小的先锁）。未列出的表不参与次序判定（闸门会按"已知对"单独管）。
const LOCK_PRECEDENCE = [
    'player',
    'activeBattle', 'multiDungeonInstance', 'playerTaoismGate',
    'stock', 'stockHolding', 'stockMarginAccount',
    'playerLaw', 'playerDivineSense', 'playerDivineTemple',
    'spiritBeast', 'playerCave', 'item', 'daoCompanion', 'daoCompanions',
    'fengshenRanking', 'spiritBeastPvpRanking'
];

const RANK = new Map(LOCK_PRECEDENCE.map((model, i) => [model, i]));

/** 未知表返回 Infinity：不假装知道它的次序，交给闸门里的清单去逼人类决定 */
function rankOf(model) {
    return RANK.has(model) ? RANK.get(model) : Number.POSITIVE_INFINITY;
}

/**
 * 按口径依次取锁。specs: [{ model, lock(t) }] —— 每个 spec 自己负责"锁哪几行"
 * （通常是一句 `WHERE … ORDER BY 主键 ASC FOR UPDATE`），本函数只保证**先后**。
 * 必须一句一句 await：并发的话锁的落地次序就由调度决定了，整个函数就白写了。
 * 返回与 specs 同序的加锁结果，调用方拿到后照常重判业务条件。
 */
async function lockRowsInOrder(t, specs) {
    const unknown = specs.filter(s => !Number.isFinite(rankOf(s.model)));
    if (unknown.length) {
        throw new Error(`取锁次序未登记这些表：${unknown.map(s => s.model).join(', ')} —— 加进 LOCK_PRECEDENCE 再写，别靠运气`);
    }
    const byRank = [...specs].sort((a, b) => rankOf(a.model) - rankOf(b.model));
    const results = [];
    for (const spec of byRank) results.push(await spec.lock(t));
    return results;
}

/** 两个表名谁先谁后（用于闸门与断言；未知一律返回 0 = 不表态） */
function compareModels(a, b) {
    const ra = rankOf(a), rb = rankOf(b);
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) return 0;
    return ra - rb;
}

/**
 * 同一张表的多行：按主键升序一次锁齐（口径最后那条），返回按 id 升序的实例数组。
 *
 * 为什么要一个函数而不是让调用方写两句 findByPk + FOR UPDATE：两句单行加锁的先后次序
 * 由**调用方传参**决定（"先锁自己、再锁对方"），而对面那个人跑的正好也是"先锁自己、再锁对方"
 * —— 两个真人各点自己那一头就是一对 ABBA。这跟跨表反向是同一类问题，但跨表普查按"模型对"
 * 聚合（players|players 凑不成对），结构上看不见它，所以更要靠调用点统一走这里。
 *
 * 另一个作用：锁一次、把整批实例交给调用方，就没有"后面再补读一次"的理由 ——
 * 同一笔事务里同一行留两份实例，谁后 save 谁把对方覆盖掉。
 */
async function lockRowsByIdsAsc(t, model, ids) {
    const uniq = [...new Set((ids || []).map(Number).filter(Number.isFinite))]
        .filter(id => id > 0)
        .sort((a, b) => a - b);
    if (!uniq.length) return [];
    return model.findAll({
        where: { id: uniq },
        order: [['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE
    });
}

module.exports = { LOCK_PRECEDENCE, rankOf, compareModels, lockRowsInOrder, lockRowsByIdsAsc };
