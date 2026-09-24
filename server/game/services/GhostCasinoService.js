/**
 * 鬼赌坊（赌运天机）
 *
 * 帖「伍 · 鬼赌坊新增玩法 ------ 赌运天机」：
 *   【玲珑骰】PVP 对赌
 *   【天命玉简】闯关博弈（连胜翻倍，失败归零）
 *   【六道轮回盘】彩票
 *   【赌石坊】已有独立系统，此处只做入口聚合
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('ghost_casino')?.ghost_casino
            || infrastructure.ConfigLoader.getConfig?.('ghost_casino');
        if (c && c.linglong_dice) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'ghost_casino.json'), 'utf8')).ghost_casino;
}

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch (_) { return 0n; }
}

function casState(player) {
    return (player.attributes || {}).ghost_casino || {};
}

function setCas(player, patch) {
    player.attributes = {
        ...(player.attributes || {}),
        ghost_casino: { ...casState(player), ...patch }
    };
}

class GhostCasinoService {
    static config() { return cfg(); }

    static async getStatus(playerId) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        const c = cfg();
        const s = casState(player);
        return {
            enabled: c.enabled !== false,
            linglong_dice: c.linglong_dice,
            destiny_slip: {
                ...c.destiny_slip,
                current_stage: Number(s.destiny_stage) || 0,
                pot: Number(s.destiny_pot) || 0
            },
            six_paths_wheel: c.six_paths_wheel,
            tickets: Number(s.wheel_tickets) || 0
        };
    }

    /** 【天命玉简】：下注闯关，每过一关奖池 ×1.8，失败归零 */
    static async playDestinySlip(playerId, { cashOut = false } = {}) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const c = cfg().destiny_slip;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const s = casState(player);
            let stage = Number(s.destiny_stage) || 0;
            let pot = Number(s.destiny_pot) || 0;

            if (stage === 0) {
                const fee = Number(c.entry_fee) || 500;
                const have = safeBigInt(player.spirit_stones);
                if (have < BigInt(fee)) {
                    await t.rollback();
                    throw new AppError(`灵石不足（需 ${fee}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                player.spirit_stones = have - BigInt(fee);
                pot = fee;
                stage = 1;
            } else if (cashOut) {
                player.spirit_stones = safeBigInt(player.spirit_stones) + BigInt(Math.floor(pot));
                setCas(player, { destiny_stage: 0, destiny_pot: 0, destiny_last: { cash_out: true, gain: Math.floor(pot) } });
                await player.save({ transaction: t });
                await t.commit();
                return { cash_out: true, gain: Math.floor(pot), stage };
            }

            // 过关判定：stage 越高越难
            const passChance = Math.max(0.35, 0.9 - stage * 0.08);
            const win = Math.random() < passChance;
            if (!win && c.fail_lose_all !== false) {
                setCas(player, { destiny_stage: 0, destiny_pot: 0, destiny_last: { win: false, stage } });
                await player.save({ transaction: t });
                await t.commit();
                return { win: false, stage, pot: 0, message: '天命玉简破碎，奖池归零' };
            }

            pot = Math.floor(pot * (Number(c.stage_cash_multiplier) || 1.8));
            stage += 1;
            const maxStages = Number(c.max_stages) || 7;
            let finished = false;
            if (stage > maxStages) {
                player.spirit_stones = safeBigInt(player.spirit_stones) + BigInt(pot);
                setCas(player, { destiny_stage: 0, destiny_pot: 0, destiny_last: { win: true, stage, gain: pot, jackpot: true } });
                finished = true;
                stage = 0;
                pot = 0;
            } else {
                setCas(player, { destiny_stage: stage, destiny_pot: pot, destiny_last: { win: true, stage, pot } });
            }
            await player.save({ transaction: t });
            await t.commit();
            return finished
                ? { win: true, jackpot: true, gain: pot, message: '连破七关！天命玉简大成' }
                : { win: true, stage, pot, message: `闯过第 ${stage} 关，奖池 ${pot}` };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 【六道轮回盘】：买彩票 / 开奖 */
    static async buyWheelTicket(playerId, count = 1) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const c = cfg().six_paths_wheel;
        const n = Math.max(1, Math.min(50, Math.floor(Number(count) || 1)));
        const price = (Number(c.ticket_price) || 100) * n;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            const have = safeBigInt(player.spirit_stones);
            if (have < BigInt(price)) {
                await t.rollback();
                throw new AppError(`灵石不足（需 ${price}）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            player.spirit_stones = have - BigInt(price);
            const s = casState(player);
            setCas(player, { wheel_tickets: (Number(s.wheel_tickets) || 0) + n });
            await player.save({ transaction: t });
            await t.commit();
            return { bought: n, cost: price, tickets: Number(casState(player).wheel_tickets) };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    /** 简易开奖：按奖池随机派彩给持有票的玩家（演示级；正式可接定时） */
    static async drawWheel() {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const c = cfg().six_paths_wheel;
        const players = await Player.findAll({ raw: true });
        const holders = players.filter(p => Number((p.attributes?.ghost_casino?.wheel_tickets) || 0) > 0);
        if (holders.length === 0) return { drawn: false, reason: '无人持票' };

        const t = await sequelize.transaction();
        try {
            const winners = [];
            for (const prize of c.prizes || []) {
                for (let i = 0; i < (prize.count || 1); i++) {
                    const pick = holders[Math.floor(Math.random() * holders.length)];
                    winners.push({ player_id: pick.id, rank: prize.rank, stones: prize.stones });
                }
            }
            for (const w of winners) {
                const inst = await Player.findByPk(w.player_id, { lock: t.LOCK.UPDATE, transaction: t });
                if (!inst) continue;
                inst.spirit_stones = safeBigInt(inst.spirit_stones) + BigInt(w.stones);
                setCas(inst, { wheel_tickets: 0, wheel_last_prize: w });
                await inst.save({ transaction: t });
            }
            await t.commit();
            return { drawn: true, winners };
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }
}

module.exports = GhostCasinoService;
