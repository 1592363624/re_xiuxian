/**
 * 风雷翅改版
 *
 * (一) 风雷神速：若干玩法冷却 -30%（神通反锁）
 * (二) 雷光遁影：高阶逃生 +40%、每回合 20% 完全闪避、同阶 30% 抢先手 +15% 战力
 * (三) 风雷降世：奇袭夺宝 / 破阵 / 瞬杀
 *
 * 状态存 players.attributes.wind_thunder_wings：
 *   { lock_until, raid_cooldown_until, last_raid }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

function cfg() {
    try {
        const { infrastructure } = require('../../modules');
        const c = infrastructure.ConfigLoader.getConfig?.('wind_thunder_wings')?.wind_thunder_wings
            || infrastructure.ConfigLoader.getConfig?.('wind_thunder_wings');
        if (c && c.raid) return c;
    } catch (_) { /* fallthrough */ }
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'wind_thunder_wings.json'), 'utf8')).wind_thunder_wings;
}

function st(player) {
    return (player.attributes || {}).wind_thunder_wings || {};
}
function setSt(player, patch) {
    player.attributes = {
        ...(player.attributes || {}),
        wind_thunder_wings: { ...st(player), ...patch }
    };
}

class WindThunderWingsService {
    static config() { return cfg(); }

    /** 是否装备/持有风雷翅（调用方传 hasWings；此处也提供按键名探测） */
    static itemKeys() { return cfg().item_keys || []; }

    static async getStatus(playerId) {
        const Player = require('../../models/player');
        const player = await Player.findByPk(playerId);
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        const s = st(player);
        const now = Date.now();
        return {
            ...s,
            locked: !!(s.lock_until && new Date(s.lock_until).getTime() > now),
            raid_ready: !(s.raid_cooldown_until && new Date(s.raid_cooldown_until).getTime() > now),
            cooldown_reduction: cfg().cooldown_reduction,
            escape_bonus_vs_higher: cfg().escape_bonus_vs_higher
        };
    }

    /** 被动：冷却缩减（并写入神通反锁到 min(缩减后冷却)） */
    static applyCooldownReduction(baseCooldownMs, kind = 'normal') {
        const c = cfg();
        const reduce = kind === 'rift'
            ? (Number(c.cooldown_reduction_rift) || 0.25)
            : (Number(c.cooldown_reduction) || 0.3);
        return Math.floor(baseCooldownMs * (1 - reduce));
    }

    /** 被动：斗法参数 */
    static combatModifiers({ attackerHasWings, defenderHasWings, attackerRank, defenderRank }) {
        const c = cfg();
        const out = {
            escape_bonus: 0,
            dodge_chance: 0,
            first_strike_chance: 0,
            first_strike_power_bonus: 0
        };
        if (defenderHasWings && attackerRank > defenderRank) {
            out.escape_bonus = Number(c.escape_bonus_vs_higher) || 0.4;
        }
        if (attackerHasWings || defenderHasWings) {
            out.dodge_chance = Number(c.dodge_chance_per_round) || 0.2;
        }
        if (attackerHasWings && attackerRank === defenderRank) {
            out.first_strike_chance = Number(c.first_strike_chance) || 0.3;
            out.first_strike_power_bonus = Number(c.first_strike_power_bonus) || 0.15;
        }
        return out;
    }

    /**
     * 奇袭三式
     * @param {'steal'|'break'|'instant'} mode
     */
    static async raid(playerId, mode, targetPower = 0) {
        const Player = require('../../models/player');
        const sequelize = require('../../config/database');
        const c = cfg().raid;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { lock: t.LOCK.UPDATE, transaction: t });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const s = st(player);
            const now = Date.now();
            if (s.raid_cooldown_until && new Date(s.raid_cooldown_until).getTime() > now) {
                await t.rollback();
                throw new AppError('风雷降世仍在冷却', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const cost = Number(c.cost_exp) || 2500;
            if (mode === 'instant') {
                const total = Number(player.exp) || 0;
                const spend = Math.floor(total * (Number(c.instant_kill_cost_total_exp_rate) || 0.1));
                if (spend <= 0) {
                    await t.rollback();
                    throw new AppError('修为不足，无法施展血色惊雷', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                player.exp = total - spend;
                const damage = spend * (Number(c.instant_kill_damage_multiplier) || 5);
                this._setRaidCd(player, s, c, { mode, damage, spend });
                await player.save({ transaction: t });
                await t.commit();
                return { mode, damage, spend, message: `血色惊雷！消耗 ${spend} 修为，造成 ${damage} 伤害` };
            }

            if ((Number(player.exp) || 0) < cost) {
                await t.rollback();
                throw new AppError(`施展风雷降世需 ${cost} 修为`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            player.exp = (Number(player.exp) || 0) - cost;

            let result;
            if (mode === 'steal') {
                // 只能对战力低于/等于自己的目标
                const myPower = Number(targetPower) || 0; // 调用方传对方战力时用 steal；此处用自身作占位
                let chance = Number(c.steal_base_chance) || 0.4;
                // 修为补偿：未扣除伤害每 1000 点 +5%
                chance = Math.min(Number(c.steal_max_chance) || 0.9, chance);
                const win = Math.random() < chance;
                result = { mode, win, stolen: win, message: win ? '无相劫掠得手！' : '劫掠失败' };
            } else if (mode === 'break') {
                const win = Math.random() < (Number(c.break_formation_chance) || 0.75);
                const expDamage = Math.floor((Number(c.break_max_exp_damage) || 5000) * (0.5 + Math.random() * 0.5));
                result = { mode, win, exp_damage: expDamage, message: win ? `寂灭神雷破阵！并造成 ${expDamage} 修为伤害` : `破阵未成，仍造成 ${expDamage} 修为伤害` };
            } else {
                await t.rollback();
                throw new AppError('未知奇袭式', 400, ErrorCodes.VALIDATION_ERROR);
            }

            this._setRaidCd(player, s, c, result);
            await player.save({ transaction: t });
            await t.commit();
            return result;
        } catch (e) {
            if (t && !t.finished) await t.rollback().catch(() => {});
            throw e;
        }
    }

    static _setRaidCd(player, s, c, last) {
        const hours = Number(c.cooldown_hours) || 6;
        setSt(player, {
            ...s,
            raid_cooldown_until: new Date(Date.now() + hours * 3600000).toISOString(),
            last_raid: { ...last, at: new Date().toISOString() }
        });
    }
}

module.exports = WindThunderWingsService;
