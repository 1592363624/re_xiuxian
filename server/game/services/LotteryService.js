/**
 * 抽奖（寻仙机缘）系统服务
 *
 * 提供消耗灵石抽奖的逻辑：
 *   1. draw：单次 / 十连抽奖。按奖池权重抽取 rank（SSR/SR/R/N），
 *      保底机制：距上次 SSR 的抽数达到 pity_threshold 时必出 SSR。
 *   2. 从抽中的 rank 奖池中按 weight 抽取具体奖励，发放灵石 / 修为。
 *
 * 设计原则：
 *   - 花费、保底阈值、各档权重、奖池内容全部集中在 lottery_data.json，禁止硬编码。
 *   - 抽奖消耗与奖励发放走同一事务 + 行级锁，保证灵石不足不会发奖、发奖不会扣款失败。
 *   - 抽卡结果可复现展示（返回 rank / 名称 / 奖励明细）。
 */
'use strict';

const Player = require('../../models/player');
const PlayerLottery = require('../../models/playerLottery');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const sequelize = require('../../config/database');

class LotteryService {
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    getConfig() {
        try {
            return this.configLoader?.getConfig('lottery_data') || {};
        } catch (e) {
            return {};
        }
    }

    isEnabled() {
        return this.getConfig()?.settings?.enabled === true;
    }

    assertEnabled() {
        if (!this.isEnabled()) {
            throw new AppError('抽奖功能当前未开放', 403, ErrorCodes.FEATURE_DISABLED);
        }
    }

    /** 按权重随机选取一项 */
    _weightedPick(items) {
        const total = items.reduce((s, it) => s + (Number(it.weight) || 0), 0);
        if (total <= 0) return items[0] || null;
        let r = Math.random() * total;
        for (const it of items) {
            r -= (Number(it.weight) || 0);
            if (r <= 0) return it;
        }
        return items[items.length - 1];
    }

    /** 依据保底状态决定本次抽中的 rank */
    _rollRank(cfg, sinceLastSsr) {
        const settings = cfg.settings || {};
        const pity = Number(settings.pity_threshold) || 0;
        const pityRank = settings.pity_upgrade_rank || 'SSR';
        if (pity > 0 && sinceLastSsr >= pity) {
            return pityRank; // 触发保底，必出目标档
        }
        const ranks = cfg.ranks || {};
        const rankItems = Object.keys(ranks).map(k => ({ ...ranks[k], rank: k }));
        const picked = this._weightedPick(rankItems);
        return picked ? picked.rank : 'N';
    }

    /**
     * 抽奖主流程
     * @param {number} playerId - 玩家ID
     * @param {'single'|'ten'} mode - 单次 / 十连
     * @returns {Promise<Object>} { results, cost, total_ss, total_exp }
     */
    async draw(playerId, mode = 'single') {
        this.assertEnabled();
        if (mode !== 'single' && mode !== 'ten') {
            throw new AppError('抽奖模式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const cfg = this.getConfig();
        const settings = cfg.settings || {};
        const cost = mode === 'ten'
            ? Number(settings.ten_cost_spirit_stone) || 0
            : Number(settings.single_cost_spirit_stone) || 0;
        const count = mode === 'ten' ? 10 : 1;

        return await sequelize.transaction(async (t) => {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (Number(player.spirit_stones) < cost) {
                throw new AppError('灵石不足', 400, ErrorCodes.INSUFFICIENT_RESOURCES);
            }

            let rec = await PlayerLottery.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!rec) {
                rec = await PlayerLottery.create({ player_id: playerId }, { transaction: t });
            }

            const results = [];
            let totalSS = 0;
            let totalExp = 0;
            const rankCounts = { ...(rec.rank_counts || {}) };

            for (let i = 0; i < count; i++) {
                const rank = this._rollRank(cfg, rec.since_last_ssr + 1);
                const pool = (cfg.pool || []).filter(p => p.rank === rank);
                const pick = this._weightedPick(pool) || { name: '机缘', reward: {} };
                const reward = pick.reward || {};

                const ss = Number(reward.spirit_stones) || 0;
                const exp = Number(reward.exp) || 0;
                totalSS += ss;
                totalExp += exp;

                // 更新保底计数
                if (rank === 'SSR') rec.since_last_ssr = 0;
                else rec.since_last_ssr += 1;

                rankCounts[rank] = (Number(rankCounts[rank]) || 0) + 1;
                results.push({
                    rank,
                    rank_name: (cfg.ranks?.[rank]?.name) || rank,
                    name: pick.name,
                    reward: { spirit_stones: ss, exp }
                });
            }

            // 扣费 + 发奖，原子提交
            player.spirit_stones = Number(player.spirit_stones) - cost + totalSS;
            player.exp = Number(player.exp) + totalExp;
            await player.save({ transaction: t });

            rec.total_draws = Number(rec.total_draws) + count;
            rec.rank_counts = rankCounts;
            await rec.save({ transaction: t });

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'resource', {
                    spirit_stones: player.spirit_stones,
                    exp: player.exp
                });
            } catch (e) { /* 通知失败不影响抽奖 */ }

            return {
                success: true,
                mode,
                cost,
                results,
                total_gain: { spirit_stones: totalSS, exp: totalExp },
                balance: { spirit_stones: player.spirit_stones, exp: player.exp },
                pity_remaining: Math.max(0, (Number(settings.pity_threshold) || 0) - rec.since_last_ssr)
            };
        });
    }

    /**
     * 获取抽奖面板信息（花费、保底、奖池预览、玩家保底进度）
     * @param {number} playerId
     * @returns {Promise<Object>}
     */
    async getPanel(playerId) {
        const cfg = this.getConfig();
        const settings = cfg.settings || {};

        let rec = await PlayerLottery.findOne({ where: { player_id: playerId } });
        const sinceLastSsr = rec ? Number(rec.since_last_ssr) || 0 : 0;
        const pity = Number(settings.pity_threshold) || 0;

        // 奖池预览按 rank 聚合展示
        const poolPreview = (cfg.pool || []).map(p => ({
            rank: p.rank,
            rank_name: cfg.ranks?.[p.rank]?.name || p.rank,
            name: p.name,
            reward: p.reward || {}
        }));

        return {
            enabled: this.isEnabled(),
            single_cost: Number(settings.single_cost_spirit_stone) || 0,
            ten_cost: Number(settings.ten_cost_spirit_stone) || 0,
            pity_threshold: pity,
            pity_remaining: Math.max(0, pity - sinceLastSsr),
            total_draws: rec ? Number(rec.total_draws) || 0 : 0,
            rank_counts: rec ? (rec.rank_counts || {}) : {},
            pool: poolPreview
        };
    }
}

module.exports = new LotteryService();
