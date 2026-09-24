/**
 * 玲珑骰对赌（PVP）
 * 帖：【玲珑骰】(PVP对赌) —— 双方下注，比点数，赢家通吃（抽水 5%）
 *
 * 流程：发起挑战（冻结赌注）→ 对手应战（冻结赌注）→ 掷骰比点 → 赢家拿走 2×注×(1-抽水)
 * 状态落库 ghost_dice_matches
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('ghost_casino')?.ghost_casino?.linglong_dice
            || infrastructure.ConfigLoader.getConfig?.('ghost_casino')?.linglong_dice;
        if (c && c.min_bet !== undefined) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'ghost_casino.json'), 'utf8'))
        .ghost_casino.linglong_dice;
}

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch (_) { return 0n; }
}

class LinglongDiceService {
    static config() { return cfg(); }

    /** 发起对赌：冻结发起方赌注 */
    static async challenge(playerId, targetId, bet) {
        const Player = require('../../models/player');
        const GhostDiceMatch = require('../../models/ghostDiceMatch');
        const sequelize = require('../../config/database');
        const c = cfg();
        const amount = Math.floor(Number(bet) || 0);
        if (amount < (Number(c.min_bet) || 100) || amount > (Number(c.max_bet) || 100000)) {
            throw new AppError(`赌注须在 ${c.min_bet}–${c.max_bet} 灵石之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (Number(targetId) === Number(playerId)) {
            throw new AppError('不能与自己对赌', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const ids = [Number(playerId), Number(targetId)].sort((a, b) => a - b);
            const players = await Player.findAll({
                where: { id: ids },
                order: [['id', 'ASC']],
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            const me = players.find(p => Number(p.id) === Number(playerId));
            const target = players.find(p => Number(p.id) === Number(targetId));
            if (!me || !target) {
                await t.rollback();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (safeBigInt(me.spirit_stones) < BigInt(amount)) {
                await t.rollback();
                throw new AppError('灵石不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            me.spirit_stones = safeBigInt(me.spirit_stones) - BigInt(amount);

            const expire = new Date(Date.now() + (Number(c.challenge_expire_minutes) || 5) * 60000);
            const match = await GhostDiceMatch.create({
                challenger_id: Number(playerId),
                defender_id: Number(targetId),
                bet_amount: amount,
                status: 'pending',
                expires_at: expire
            }, { transaction: t });
            await me.save({ transaction: t });
            await t.commit();
            return {
                match_id: match.id,
                bet_amount: amount,
                status: 'pending',
                message: `已向玩家#${targetId} 发起 ${amount} 灵石玲珑骰对赌`
            };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 应战并立即开骰 */
    static async accept(matchId, playerId) {
        const Player = require('../../models/player');
        const GhostDiceMatch = require('../../models/ghostDiceMatch');
        const sequelize = require('../../config/database');
        const c = cfg();
        const t = await sequelize.transaction();
        try {
            const match = await GhostDiceMatch.findByPk(matchId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!match || match.status !== 'pending') {
                await t.rollback();
                throw new AppError('对赌不存在或已结束', 404, ErrorCodes.NOT_FOUND);
            }
            if (Number(match.defender_id) !== Number(playerId)) {
                await t.rollback();
                throw new AppError('只有被挑战方可应战', 403, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (match.expires_at && new Date(match.expires_at).getTime() < Date.now()) {
                match.status = 'expired';
                await match.save({ transaction: t });
                await t.rollback();
                throw new AppError('对赌已过期', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const amount = Number(match.bet_amount);
            const ids = [Number(match.challenger_id), Number(match.defender_id)].sort((a, b) => a - b);
            const players = await Player.findAll({
                where: { id: ids },
                order: [['id', 'ASC']],
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            const challenger = players.find(p => Number(p.id) === Number(match.challenger_id));
            const defender = players.find(p => Number(p.id) === Number(match.defender_id));
            if (safeBigInt(defender.spirit_stones) < BigInt(amount)) {
                await t.rollback();
                throw new AppError('应战方灵石不足', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            defender.spirit_stones = safeBigInt(defender.spirit_stones) - BigInt(amount);

            // 掷骰：3 颗六面骰
            const roll = () => 1 + Math.floor(Math.random() * 6);
            const aDice = [roll(), roll(), roll()];
            const bDice = [roll(), roll(), roll()];
            const aSum = aDice.reduce((s, x) => s + x, 0);
            const bSum = bDice.reduce((s, x) => s + x, 0);

            let winnerId;
            if (aSum === bSum) {
                // 平局：退还双方
                challenger.spirit_stones = safeBigInt(challenger.spirit_stones) + BigInt(amount);
                defender.spirit_stones = safeBigInt(defender.spirit_stones) + BigInt(amount);
                winnerId = null;
            } else {
                winnerId = aSum > bSum ? challenger.id : defender.id;
                const pot = amount * 2;
                const houseCut = Math.floor(pot * (Number(c.house_edge) || 0.05));
                const payout = pot - houseCut;
                const winner = winnerId === challenger.id ? challenger : defender;
                winner.spirit_stones = safeBigInt(winner.spirit_stones) + BigInt(payout);
                match.house_cut = houseCut;
            }

            match.status = winnerId ? 'finished' : 'draw';
            match.winner_id = winnerId;
            match.challenger_dice = aDice;
            match.defender_dice = bDice;
            match.finished_at = new Date();
            await match.save({ transaction: t });
            await challenger.save({ transaction: t });
            await defender.save({ transaction: t });
            await t.commit();

            return {
                match_id: match.id,
                challenger_dice: aDice,
                defender_dice: bDice,
                challenger_sum: aSum,
                defender_sum: bSum,
                winner_id: winnerId,
                bet_amount: amount,
                house_cut: Number(match.house_cut) || 0,
                message: winnerId
                    ? `玩家#${winnerId} 以 ${Math.max(aSum, bSum)} : ${Math.min(aSum, bSum)} 获胜，拿走彩池`
                    : `平局（${aSum} : ${bSum}），退还赌注`
            };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 撤回未应战的挑战，退还赌注 */
    static async cancel(matchId, playerId) {
        const Player = require('../../models/player');
        const GhostDiceMatch = require('../../models/ghostDiceMatch');
        const sequelize = require('../../config/database');
        const t = await sequelize.transaction();
        try {
            const match = await GhostDiceMatch.findByPk(matchId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!match || match.status !== 'pending') {
                await t.rollback();
                throw new AppError('对赌不存在或已结束', 404, ErrorCodes.NOT_FOUND);
            }
            if (Number(match.challenger_id) !== Number(playerId)) {
                await t.rollback();
                throw new AppError('只有发起方可撤回', 403, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const me = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            me.spirit_stones = safeBigInt(me.spirit_stones) + BigInt(Number(match.bet_amount));
            match.status = 'cancelled';
            match.finished_at = new Date();
            await match.save({ transaction: t });
            await me.save({ transaction: t });
            await t.commit();
            return { match_id: match.id, refunded: Number(match.bet_amount), message: '已撤回并退还赌注' };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    static async listPending(limit = 10) {
        const GhostDiceMatch = require('../../models/ghostDiceMatch');
        return GhostDiceMatch.findAll({
            where: { status: 'pending' },
            order: [['id', 'DESC']],
            limit
        });
    }
}

module.exports = LinglongDiceService;
