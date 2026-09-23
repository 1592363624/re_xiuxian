/**
 * 成就系统服务
 *
 * 提供成就的查询、进度同步与奖励领取逻辑：
 *   1. getAchievements：返回全部成就定义并附带玩家的进度 / 是否达成 / 是否已领奖
 *   2. syncProgress：依据玩家当前属性与统计字段同步各成就进度（登录或事件触发）
 *   3. claimReward：对已达成的成就发放奖励（灵石 / 修为 / 物品 / 称号），使用事务 + 行级锁保证安全
 *      奖励里配的每一样都真的发得出：物品走 grantItems（同事务，装不下就整笔回滚，不落 claimed），
 *      称号走 addTitleToInstance（判重 + 新数组，与副本/切磋同一道门）。
 *      配了代码不认得的奖励键（比如把 items 写成 item）由启动闸 _validateAchievementRewards 直接抛，
 *      不会再留成"成就页写着有奖、领完什么都没多"的静默忽略。
 *
 * 设计原则：
 *   - 成就定义（条件 metric、目标值 target、奖励 reward）全部集中在 achievement_data.json，
 *     禁止在本文件硬编码阈值。
 *   - metric 到玩家数据的映射在内容里（config/player_metrics.json），实现只有 game/stats/PlayerMetrics 一处。
 *   - 奖励发放走事务，灵石 / 修为 / 物品 / 称号与成就状态变更原子提交；装不下就整笔回滚，不许半发。
 */
'use strict';

const Player = require('../../models/player');
const PlayerAchievement = require('../../models/playerAchievement');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { logOnce } = require('../../utils/logOnce');

// metric -> 取数：整张表搬到内容里（config/player_metrics.json，登记成 map 集合，资料片可以加一档统计量），
// 实现只有 game/stats/PlayerMetrics 一处。
//
// 这里以前是一份代码表，而且点名的键根本不是 players 的列：
//   seclusion_count: (p) => Number(p.meditation_count)   // players 没有 meditation_count 这一列（计数在 stats 那坨 JSON 里）
//   kill_count / explore_count 同理
// → 三个度量永远取到 undefined → `|| 0` → **34 条成就里 14 条进度恒为 0**，
//   接口照常返回"进度 0/5"，测试全绿，没有任何地方报错。这就是"内容配了但玩家拿不到"最典型的形状。
// 现在：读哪一格由内容声明（`stats.<key>` / `column.<列>` / `attr.<注册属性>` / `query.<名字>` / realm_index），
// 计数由事件点统一走 PlayerStateStore.bumpStat 累加，引用是否成立在启动期由
// ContentRegistry._validatePlayerMetrics 硬拦（含"成就的 metric 必须在词表里"这一条）。
const PlayerMetrics = require('../stats/PlayerMetrics');
// 玩家状态写入的唯一入口：成就完成计数走它的 bumpStat（自己整块写 stats 就是旧快照覆盖那一族）
const PlayerStateStore = require('../persistence/PlayerStateStore');
// 称号追加只走这一道门（判重 + 赋回新数组），与副本结算/切磋用的是同一个函数
const { addTitleToInstance } = PlayerStateStore;
// 发物品只走这一道门：回执 `{granted, failed[{item_key, quantity, reason}]}`，
// 名字在出参那一刻按 item_data 现算（回执里刻意不带 item_name，免得有人把引用快照冻进库里）
const { grantItems, describeGrant } = require('../items/itemGrant');
const { itemName } = require('../items/itemNaming');

/** 已经报过"取不到数"的度量，避免每次刷新成就列表都刷一遍日志 */
const WARNED_METRICS = new Set();

class AchievementService {
    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 全局配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 取一条成就度量的实时值。三处消费点（列表 / 同步进度 / 领取校验）都只走这里。
     *
     * 度量没有登记取数函数时明确报一次错：以前是 `getter ? getter(p) : 0`，
     * 于是"achievement_data 里加了一条新度量但代码没登记"表现成这条成就永远 0%，
     * 玩家以为是自己没做到，实际上是内容根本没接上。
     */
    async _metricValue(metric, player) {
        if (!PlayerMetrics.specOf(metric)) {
            if (!WARNED_METRICS.has(metric)) {
                WARNED_METRICS.add(metric);
                console.error(`[AchievementService] 成就度量 "${metric}" 不在 player_metrics 词表里，进度会一直是 0`);
            }
            return 0;
        }
        return PlayerMetrics.metricValue(metric, player, { configLoader: this.configLoader });
    }

    /**
     * 供内容体检/后台展示：当前真的能算的度量（取自合并后的内容词表，资料片加的那档也在里面）。
     * 注意不要再回去读某个代码里的清单 —— 那份清单就是上一条 bug 的来源。
     */
    static knownMetrics() {
        return PlayerMetrics.knownMetricIds();
    }

    /**
     * 读取成就配置（缺失时兜底空对象，防止配置未加载导致链路崩溃）
     * @returns {Object}
     */
    getConfig() {
        try {
            return this.configLoader?.getConfig('achievement_data') || {};
        } catch (e) {
            logOnce('AchievementService.getConfig', 'achievement_data 配置读取失败，成就链路按"未配置"兜底: ' + e.message);
            return {};
        }
    }

    /** 称号名（名字跟内容走：资料片往 titles.json 加一档，界面就跟着显示，不抄第二份表） */
    titleName(titleId) {
        const titles = this.configLoader?.getConfig('titles') || [];
        return (titles.find(t => t && t.id === titleId) || {}).name || null;
    }

    /**
     * 把一条成就的奖励声明解析成"给玩家看的那份"：物品键换名字、称号键换名字，其余原样带上。
     *
     * 为什么要这一层：内容里写的永远是引用（`items: [{item_key: 'yang_shi_sui_pian'}]`），
     * 直接把引用摊给界面就变成成就页上一屏裸键；而在服务端出参这一刻解析，
     * 资料片改一次 item_data / titles，成就页跟着变，客户端不需要再抄一份物品典。
     * @param {Object} reward - 成就配置里的 reward
     * @returns {Object} 同形状，另带 items[].item_name 与 title_name
     */
    rewardWithNames(reward) {
        const out = { ...(reward || {}) };
        if (Array.isArray(out.items)) {
            out.items = out.items.map(entry => {
                const isObject = entry && typeof entry === 'object';
                const key = isObject ? (entry.item_key ?? entry.item_id) : entry;
                const quantity = isObject
                    ? (Number(entry.quantity ?? entry.qty ?? entry.count ?? entry.num) || 1)
                    : 1;
                const name = itemName(key);
                return {
                    item_key: String(key ?? ''),
                    quantity,
                    ...(name ? { item_name: name } : {})
                };
            });
        }
        if (typeof out.title_id === 'string' && out.title_id) {
            const name = this.titleName(out.title_id);
            if (name) out.title_name = name;
        }
        return out;
    }

    /** 是否启用 */
    isEnabled() {
        return this.getConfig()?.settings?.enabled === true;
    }

    /** 断言系统已开启 */
    assertEnabled() {
        if (!this.isEnabled()) {
            throw new AppError('成就系统当前未开放', 403, ErrorCodes.FEATURE_DISABLED);
        }
    }

    /**
     * 获取成就总览（含玩家进度）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>}
     */
    async getAchievements(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getConfig();
        const list = cfg.achievements || [];
        const categories = cfg.categories || {};

        // 拉取玩家已记录的成就进度
        const records = await PlayerAchievement.findAll({ where: { player_id: playerId } });
        const recMap = {};
        records.forEach(r => { recMap[r.achievement_id] = r; });

        // 对每个成就计算当前实时进度（即使未记录过也给出实时值）
        // 度量可能是异步的（要查库的统计），所以这里是 async map + Promise.all
        const items = await Promise.all(list.map(async a => {
            const progress = await this._metricValue(a.metric, player);
            const target = Number(a.target) || 0;
            const rec = recMap[a.achievement_id];

            // 以"实时进度"与"历史记录"两者较大值作为展示进度，避免回退造成显示异常
            const shownProgress = Math.max(progress, Number(rec?.progress) || 0);
            const completed = shownProgress >= target;
            const cat = categories[a.category] || {};

            return {
                id: a.id,
                category: a.category,
                category_name: cat.name || a.category,
                // 刻意不再下发 category_color：内容里那一格本轮删掉了（全仓没有任何一处读它，
                // 而界面用的是自己那套 tone 令牌）—— 留着只会让出参里多一个恒等于 'stone' 的假字段。
                // 要真能按分组配色，正路是加一档受控色令牌并让界面认得它，不是把任意 Tailwind 色名塞进内容。
                category_icon: cat.icon || '✦',
                name: a.name,
                description: a.description,
                metric: a.metric,
                target,
                progress: shownProgress,
                percent: target > 0 ? Math.min(100, Math.floor(shownProgress / target * 100)) : 100,
                completed,
                claimed: !!rec?.claimed,
                // 名字在这一刻解析（内容里只有引用）：客户端只要读 item_name / title_name，
                // 不必自己抄一份物品典 —— 资料片改了名字，成就页跟着变
                reward: this.rewardWithNames(a.reward)
            };
        }));

        const completedCount = items.filter(i => i.completed).length;
        return {
            enabled: this.isEnabled(),
            total: items.length,
            completed_count: completedCount,
            categories,
            items
        };
    }

    /**
     * 同步玩家成就进度（登录或关键事件后调用）
     * 说明：仅更新进度与达成标记，不自动发奖（发奖需玩家主动领取，避免静默到账）。
     * @param {number} playerId - 玩家ID
     * @returns {Promise<number>} 本次新达成的成就数量
     */
    async syncProgress(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) return 0;

        const cfg = this.getConfig();
        const list = cfg.achievements || [];
        if (!list.length) return 0;

        let newlyCompleted = 0;
        const now = new Date();

        for (const a of list) {
            const progress = await this._metricValue(a.metric, player);
            const target = Number(a.target) || 0;
            const completed = progress >= target;

            const [rec, created] = await PlayerAchievement.findOrCreate({
                where: { player_id: playerId, achievement_id: a.id },
                defaults: { progress, completed, completed_at: completed ? now : null }
            });

            // 仅在进度增长或新达成时更新，避免无意义写库
            if (!created) {
                const needUpdate = progress > Number(rec.progress) || (completed && !rec.completed);
                if (needUpdate) {
                    rec.progress = Math.max(progress, Number(rec.progress) || 0);
                    if (completed && !rec.completed) {
                        rec.completed = true;
                        rec.completed_at = now;
                        if (!rec.claimed) newlyCompleted += 1;
                    }
                    await rec.save();
                }
            } else if (completed && !rec.claimed) {
                newlyCompleted += 1;
            }
        }
        return newlyCompleted;
    }

    /**
     * 领取成就奖励
     * 说明：仅已达成且未领取的成就可领；发放灵石 / 修为后标记 claimed。
     *       使用事务 + 行级锁，保证并发下奖励只发放一次。
     * @param {number} playerId - 玩家ID
     * @param {string} achievementId - 成就ID
     * @returns {Promise<Object>} { success, message, reward }
     */
    async claimReward(playerId, achievementId) {
        this.assertEnabled();

        const cfg = this.getConfig();
        const def = (cfg.achievements || []).find(a => a.id === achievementId);
        if (!def) {
            throw new AppError('成就不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 进度同步必须在**开事务之前**做，不能挪进来：syncProgress 会往 player_achievements 建/写行，
        // 而那些语句不带事务 → 走的是另一条连接；下面这道事务一开头就对 players 行取 FOR UPDATE，
        // 并对"这一条成就的行"也取了 FOR UPDATE —— 行还不存在时锁住的是索引间隙，于是那条连接的 INSERT
        // 被本事务自己的间隙锁挡住：现网每个玩家**第一次点领取**都要挂满 50 秒再抛
        // "Lock wait timeout exceeded"（2026-09-22 探针 scripts/smoke_achievement_rewards.js A1 实测）。
        // 放外面就互不干扰：同步建好行之后，事务里读到的就是那一行，锁也是锁真行。
        await this.syncProgress(playerId);

        return await sequelize.transaction(async (t) => {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            const rec = await PlayerAchievement.findOne({
                where: { player_id: playerId, achievement_id: achievementId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            const target = Number(def.target) || 0;
            const progress = await this._metricValue(def.metric, player);
            if (progress < target) {
                throw new AppError('成就尚未达成', 400, ErrorCodes.CONDITION_NOT_MET);
            }

            const finalRec = rec || await PlayerAchievement.findOne({
                where: { player_id: playerId, achievement_id: achievementId },
                transaction: t
            });
            if (finalRec?.claimed) {
                throw new AppError('奖励已领取', 400, ErrorCodes.ALREADY_EXISTS);
            }

            const reward = def.reward || {};
            const ss = Number(reward.spirit_stones) || 0;
            const exp = Number(reward.exp) || 0;
            const itemEntries = Array.isArray(reward.items) ? reward.items : [];
            const titleId = (typeof reward.title_id === 'string' && reward.title_id) ? reward.title_id : '';

            // ---- 先发货，后落 claimed：有一样到不了手就当这次没领 -------------------------------
            // 半发是这条链路最坏的失败形状：3 件只塞进 2 件、claimed 也已经置位，
            // 于是玩家既拿不到剩下的，也再也领不了这一条（副本结算那边就是这么漏的）。
            // 物品走 grantItems（同一个事务），装不下就抛 —— 事务回滚把已入包的件一起撤回，
            // 成就保持未领取，玩家清包后可以重新领一次。称号走 addTitleToInstance，也在这个事务里。
            let itemsText = '';
            if (itemEntries.length) {
                const grant = await grantItems(playerId, itemEntries, t, { label: `成就:${achievementId}` });
                if (grant.failed.length) {
                    const detail = grant.failed
                        .map(f => `${itemName(f.item_key) || f.item_key}×${f.quantity}：${f.reason}`)
                        .join('；');
                    throw new AppError(
                        `背包放不下，成就《${def.name}》的奖励未领取（${detail}）。`
                        + '清理背包后重新领取即可，本次没有扣除任何奖励',
                        400, ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
                itemsText = describeGrant(grant.granted).text;
            }

            // 已经有这个称号时 addTitleToInstance 返回 false：不重复发，但也不要在回执里谎称"获得了"
            const titleAdded = titleId ? addTitleToInstance(player, titleId) : false;
            const titleText = (titleId && titleAdded) ? (this.titleName(titleId) || titleId) : '';

            if (ss > 0) player.spirit_stones = Number(player.spirit_stones) + ss;
            if (exp > 0) player.exp = Number(player.exp) + exp;
            await player.save({ transaction: t });

            if (!finalRec) {
                await PlayerAchievement.create({
                    player_id: playerId,
                    achievement_id: achievementId,
                    progress,
                    completed: true,
                    completed_at: new Date(),
                    claimed: true,
                    claimed_at: new Date()
                }, { transaction: t });
            } else {
                finalRec.claimed = true;
                finalRec.claimed_at = new Date();
                await finalRec.save({ transaction: t });
            }

            // 领到奖才算"达成一项成就"（这一格同时进祖业的总指令数，与改造前那份手写求和口径一致）。
            await PlayerStateStore.bumpStat(playerId, 'achievements_completed', 1, { transaction: t });

            // 推送资源变更，保持前端资源条同步
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'resource', {
                    spirit_stones: player.spirit_stones,
                    exp: player.exp
                });
            } catch (e) { /* 通知失败不影响发奖 */ }

            const parts = [];
            if (ss > 0) parts.push(`${ss} 灵石`);
            if (exp > 0) parts.push(`${exp} 修为`);
            if (itemsText) parts.push(itemsText);
            if (titleText) parts.push(`称号《${titleText}》`);
            else if (titleId) parts.push(`${this.titleName(titleId) || titleId}（此前已在身，不重复获得）`);

            const delivered = this.rewardWithNames(reward);
            if (titleId && !titleAdded) delivered.title_already_had = true;

            return {
                success: true,
                message: `领取成就《${def.name}》奖励：${parts.length ? parts.join('、') : '无'}`,
                reward: delivered
            };
        });
    }
}

const sequelize = require('../../config/database');
module.exports = new AchievementService();
