/**
 * 成就系统服务
 *
 * 提供成就的查询、进度同步与奖励领取逻辑：
 *   1. getAchievements：返回全部成就定义并附带玩家的进度 / 是否达成 / 是否已领奖
 *   2. syncProgress：依据玩家当前属性与统计字段同步各成就进度（登录或事件触发）
 *   3. claimReward：对已达成的成就发放奖励（灵石 / 修为），使用事务 + 行级锁保证安全
 *
 * 设计原则：
 *   - 成就定义（条件 metric、目标值 target、奖励 reward）全部集中在 achievement_data.json，
 *     禁止在本文件硬编码阈值。
 *   - metric 到玩家数据的映射集中在 METRIC_SOURCES，新增统计维度只需在此登记。
 *   - 奖励发放走事务，灵石 / 修为变更与成就状态变更原子提交，避免领奖后扣款失败导致重复领。
 */
'use strict';

const Player = require('../../models/player');
const PlayerAchievement = require('../../models/playerAchievement');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

// metric -> 取数函数。集中登记，避免把字段映射散落在多处。
// 返回数字；取不到时返回 0，保证进度计算不报错。
const METRIC_SOURCES = {
    // 闭关次数（player.meditation_count 近似记录闭关修炼次数）
    seclusion_count: (p) => Number(p.meditation_count) || 0,
    // 击杀数
    kill_count: (p) => Number(p.kill_count) || 0,
    // 探索次数（player.exploration_count）
    explore_count: (p) => Number(p.exploration_count) || 0,
    // 当前修为（exp）
    exp: (p) => Number(p.exp) || 0,
    // 当前灵石（近似累计获得，作为 wealth 类成就度量）
    total_spirit_stones: (p) => Number(p.spirit_stones) || 0,
    // 好友 / 道侣数（player 暂无独立字段，预留为 0，等待社交系统接入后扩展）
    friend_count: () => 0,
    // 境界序号（凡人=0，按 RealmService 的 rank 计算）
    realm_index: (p) => {
        if (!p.realm) return 0;
        const cfg = RealmService.getRealmByName(p.realm);
        return cfg && cfg.rank ? Number(cfg.rank) : 0;
    }
};

class AchievementService {
    /**
     * 初始化服务，注入配置加载器
     * @param {Object} configLoader - 全局配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 读取成就配置（缺失时兜底空对象，防止配置未加载导致链路崩溃）
     * @returns {Object}
     */
    getConfig() {
        try {
            return this.configLoader?.getConfig('achievement_data') || {};
        } catch (e) {
            return {};
        }
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
        const items = list.map(a => {
            const getter = METRIC_SOURCES[a.metric];
            const progress = getter ? getter(player) : 0;
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
                category_color: cat.color || 'stone',
                category_icon: cat.icon || '✦',
                name: a.name,
                description: a.description,
                metric: a.metric,
                target,
                progress: shownProgress,
                percent: target > 0 ? Math.min(100, Math.floor(shownProgress / target * 100)) : 100,
                completed,
                claimed: !!rec?.claimed,
                reward: a.reward || {}
            };
        });

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
            const getter = METRIC_SOURCES[a.metric];
            const progress = getter ? getter(player) : 0;
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

            // 未记录则先同步一次，确保达成状态准确
            if (!rec) {
                await this.syncProgress(playerId);
            }
            const target = Number(def.target) || 0;
            const getter = METRIC_SOURCES[def.metric];
            const progress = getter ? getter(player) : 0;
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

            // 推送资源变更，保持前端资源条同步
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'resource', {
                    spirit_stones: player.spirit_stones,
                    exp: player.exp
                });
            } catch (e) { /* 通知失败不影响发奖 */ }

            return {
                success: true,
                message: `领取成就《${def.name}》奖励：${ss ? ss + ' 灵石' : ''}${exp ? '、' + exp + ' 修为' : ''}`.replace(/：$/, '：无'),
                reward: { spirit_stones: ss, exp }
            };
        });
    }
}

const sequelize = require('../../config/database');
module.exports = new AchievementService();
