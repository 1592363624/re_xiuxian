/**
 * 琉璃古塔服务
 *
 * 玩法文档对照：xiuxian_game_guide.md 第30节·古塔流程
 *   `.闯塔` `.继续闯塔` `.退出古塔` `.重置古塔` `.琉璃塔榜`
 *
 * 纯玩法设计：
 *   - 闯层是自动回合制模拟（与切磋木人同族），不改战斗公式
 *   - 进度一人一行；首通标记用 first_clear_mask（JSON 数组）
 *   - 榜单按 best_score 降序
 */
'use strict';

const sequelize = require('../../config/database');
const Player = require('../../models/player');
const PlayerPagoda = require('../../models/playerPagoda');
const PlayerPagodaRecord = require('../../models/playerPagodaRecord');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { addTitleToInstance } = require('../persistence/PlayerStateStore');
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

function getConfig() {
    const config = configLoader.getConfig('pagoda_data');
    if (!config) throw new Error('古塔配置 pagoda_data 未加载');
    return config;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function safeBigInt(v) {
    try { return BigInt(v ?? 0); } catch { return BigInt(0); }
}

function parseMask(mask) {
    try { return JSON.parse(mask || '[]'); } catch { return []; }
}

class PagodaService {
    static getInfo() {
        const config = getConfig();
        return {
            global: config.global,
            floors: config.floors.map(f => ({
                floor: f.floor,
                name: f.name,
                description: f.description,
                min_realm_rank: f.min_realm_rank,
                stats: f.stats,
                rewards: f.rewards,
                first_clear_bonus: f.first_clear_bonus
            }))
        };
    }

    static async getOrCreate(playerId, transaction = null, useLock = false) {
        const options = {};
        if (transaction) options.transaction = transaction;
        if (useLock && transaction) options.lock = transaction.LOCK.UPDATE;
        let row = await PlayerPagoda.findOne({ where: { player_id: playerId }, ...options });
        if (!row) {
            row = await PlayerPagoda.create({ player_id: playerId }, transaction ? { transaction } : {});
        }
        return row;
    }

    static _rollDaily(row) {
        const today = todayStr();
        if (row.attempt_date !== today) {
            row.attempt_date = today;
            row.today_attempts = 0;
            row.today_resets = 0;
        }
    }

    static async getStatus(playerId) {
        const config = getConfig();
        const row = await this.getOrCreate(playerId);
        this._rollDaily(row);
        await row.save();
        const firsts = parseMask(row.first_clear_mask);
        return {
            highest_floor: row.highest_floor,
            current_floor: row.current_floor,
            in_tower: !!row.in_tower,
            today_attempts: row.today_attempts,
            daily_limit: config.global.daily_limit,
            today_resets: row.today_resets,
            reset_daily_limit: config.global.reset_daily_limit,
            reset_cost_spirit_stones: config.global.reset_cost_spirit_stones,
            cooldown_sec: config.global.cooldown_sec,
            last_attempt_at: row.last_attempt_at,
            best_score: row.best_score,
            last_score: row.last_score,
            total_clears: row.total_clears,
            first_clears: firsts,
            next_floor: row.in_tower ? row.current_floor : (row.highest_floor + 1),
            can_climb: row.in_tower || row.highest_floor < config.floors.length
        };
    }

    /**
     * 自动回合制模拟（与 SparringService 同族伤害公式，纯玩法展示）
     */
    static _simulate(playerStats, floorStats, maxRounds) {
        let php = safeBigInt(playerStats.hp);
        const phpMax = php;
        let pmp = safeBigInt(playerStats.mp);
        let ehp = safeBigInt(floorStats.max_hp);
        const ehpMax = ehp;
        let rounds = 0;
        const log = [];
        const pAtk = safeBigInt(playerStats.atk);
        const pDef = safeBigInt(playerStats.def);
        const pSpd = Number(playerStats.speed) || 50;
        const eAtk = safeBigInt(floorStats.atk);
        const eDef = safeBigInt(floorStats.def);
        const eSpd = Number(floorStats.speed) || 50;
        const skillCost = BigInt(20);
        const playerFirst = pSpd >= eSpd;

        const hit = (atk, def) => {
            const base = atk > def ? atk - def : BigInt(1);
            const jitter = BigInt(Math.floor(Math.random() * 15) - 7);
            let dmg = base + jitter;
            if (dmg < BigInt(1)) dmg = BigInt(1);
            return dmg;
        };

        while (rounds < maxRounds && php > 0 && ehp > 0) {
            rounds += 1;
            const doPlayer = () => {
                let dmg;
                if (pmp >= skillCost) {
                    dmg = hit(pAtk, eDef) * BigInt(3) / BigInt(2);
                    pmp -= skillCost;
                    log.push(`第${rounds}回合 你施展剑诀，造成 ${dmg} 伤害`);
                } else {
                    dmg = hit(pAtk, eDef);
                    log.push(`第${rounds}回合 你挥剑，造成 ${dmg} 伤害`);
                }
                ehp -= dmg;
            };
            const doEnemy = () => {
                const dmg = hit(eAtk, pDef);
                php -= dmg;
                log.push(`第${rounds}回合 守关灵影反击，造成 ${dmg} 伤害`);
            };
            if (playerFirst) { doPlayer(); if (ehp > 0) doEnemy(); }
            else { doEnemy(); if (php > 0) doPlayer(); }
        }

        let result = 'timeout';
        if (ehp <= 0) result = 'win';
        else if (php <= 0) result = 'lose';

        const hpRatio = phpMax > 0 ? Number(php * BigInt(1000) / phpMax) / 1000 : 0;
        return {
            result,
            rounds_used: rounds,
            player_hp_remaining: php > 0 ? php.toString() : '0',
            player_hp_max: phpMax.toString(),
            hp_ratio: Math.max(0, hpRatio),
            enemy_hp_remaining: ehp > 0 ? ehp.toString() : '0',
            enemy_hp_max: ehpMax.toString(),
            log: log.slice(0, 30)
        };
    }

    static async climb(playerId) {
        const config = getConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('道躯已陨，无法闯塔', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const row = await this.getOrCreate(playerId, t, true);
            this._rollDaily(row);

            if (row.today_attempts >= config.global.daily_limit) {
                throw new AppError(`今日闯塔次数已用尽（${config.global.daily_limit} 次）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (row.last_attempt_at) {
                const elapsed = (Date.now() - new Date(row.last_attempt_at).getTime()) / 1000;
                if (elapsed < config.global.cooldown_sec) {
                    const wait = Math.ceil(config.global.cooldown_sec - elapsed);
                    throw new AppError(`闯塔冷却中，请 ${wait} 秒后再来`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            const targetFloor = row.in_tower && row.current_floor > 0
                ? row.current_floor
                : row.highest_floor + 1;
            const floorCfg = config.floors.find(f => f.floor === targetFloor);
            if (!floorCfg) {
                throw new AppError('已登顶琉璃古塔，再无更高层', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const realmRank = player.realm_rank || 0;
            if (realmRank < floorCfg.min_realm_rank) {
                throw new AppError(`境界不足，第 ${targetFloor} 层「${floorCfg.name}」需 rank≥${floorCfg.min_realm_rank}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 玩家属性：取 blob 与列的稳健口径（纯玩法，不接 AttributeService 全管线）
            const attrs = player.attributes || {};
            const playerStats = {
                hp: player.hp_current || attrs.hp_max || 100,
                mp: player.mp_current || attrs.mp_max || 50,
                atk: attrs.atk || player.atk || 50,
                def: attrs.def || player.def || 20,
                speed: attrs.speed || 50
            };

            const sim = this._simulate(playerStats, floorCfg.stats, config.global.max_rounds);
            row.today_attempts += 1;
            row.last_attempt_at = new Date();

            let expGain = 0n;
            let stoneGain = 0n;
            let isFirst = false;
            const firsts = parseMask(row.first_clear_mask);
            let titleAwarded = null;

            if (sim.result === 'win') {
                isFirst = !firsts.includes(targetFloor);
                if (isFirst) {
                    firsts.push(targetFloor);
                    row.first_clear_mask = JSON.stringify(firsts);
                }
                expGain = safeBigInt(floorCfg.rewards.exp_win) + (isFirst ? safeBigInt(floorCfg.first_clear_bonus?.exp || 0) : 0n);
                stoneGain = safeBigInt(floorCfg.rewards.spirit_stones_win) + (isFirst ? safeBigInt(floorCfg.first_clear_bonus?.spirit_stones || 0) : 0n);
                player.exp = (safeBigInt(player.exp) + expGain).toString();
                player.spirit_stones = (safeBigInt(player.spirit_stones) + stoneGain).toString();
                row.highest_floor = Math.max(row.highest_floor, targetFloor);
                row.current_floor = targetFloor + 1;
                row.in_tower = targetFloor < config.floors.length ? 1 : 0;
                row.total_clears += 1;
                if (isFirst && floorCfg.first_clear_bonus?.title_id) {
                    titleAwarded = floorCfg.first_clear_bonus.title_id;
                    await addTitleToInstance(player, titleAwarded);
                }
            } else {
                const ratio = config.global.hp_loss_on_defeat_ratio || 0.08;
                const minLoss = BigInt(config.global.hp_loss_on_defeat_min || 20);
                const maxLoss = BigInt(config.global.hp_loss_on_defeat_max || 800);
                let loss = safeBigInt(player.hp_current) * BigInt(Math.floor(ratio * 100)) / BigInt(100);
                if (loss < minLoss) loss = minLoss;
                if (loss > maxLoss) loss = maxLoss;
                const hpNow = safeBigInt(player.hp_current) - loss;
                player.hp_current = (hpNow < 0n ? 0n : hpNow).toString();
                row.in_tower = 0;
                row.current_floor = row.highest_floor;
            }

            const scoreBase = targetFloor * (config.global.score_floor_weight || 1000);
            const scoreRound = Math.max(0, (config.global.max_rounds - sim.rounds_used)) * (config.global.score_round_bonus || 80);
            const scoreHp = Math.floor(sim.hp_ratio * (config.global.score_hp_ratio_bonus || 400));
            const scoreFlawless = sim.result === 'win' && sim.hp_ratio >= 0.999 ? (config.global.score_flawless_bonus || 800) : 0;
            const score = sim.result === 'win' ? scoreBase + scoreRound + scoreHp + scoreFlawless : 0;
            row.last_score = score;
            if (score > row.best_score) row.best_score = score;

            await PlayerPagodaRecord.create({
                player_id: playerId,
                player_nickname: player.nickname || player.username || '道友',
                floor: targetFloor,
                floor_name: floorCfg.name,
                result: sim.result,
                score,
                rounds_used: sim.rounds_used,
                player_hp_remaining: sim.player_hp_remaining,
                is_first_clear: isFirst ? 1 : 0,
                exp_gained: expGain.toString(),
                spirit_stones_gained: stoneGain.toString(),
                battle_log: JSON.stringify(sim.log)
            }, { transaction: t });

            await player.save({ transaction: t });
            await row.save({ transaction: t });
            await t.commit();

            return {
                success: sim.result === 'win',
                result: sim.result,
                floor: targetFloor,
                floor_name: floorCfg.name,
                rounds_used: sim.rounds_used,
                score,
                is_first_clear: isFirst,
                exp_gained: expGain.toString(),
                spirit_stones_gained: stoneGain.toString(),
                title_awarded: titleAwarded,
                player_hp_remaining: sim.player_hp_remaining,
                battle_log: sim.log,
                in_tower: !!row.in_tower,
                highest_floor: row.highest_floor,
                next_floor: row.in_tower ? row.current_floor : null,
                message: sim.result === 'win'
                    ? `闯过第 ${targetFloor} 层「${floorCfg.name}」！${isFirst ? '首通！' : ''}`
                    : `第 ${targetFloor} 层「${floorCfg.name}」守关灵影太强，你败退而出。`
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    static async exitTower(playerId) {
        const t = await sequelize.transaction();
        try {
            const row = await this.getOrCreate(playerId, t, true);
            if (!row.in_tower) throw new AppError('当前不在塔中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            row.in_tower = 0;
            row.current_floor = row.highest_floor;
            await row.save({ transaction: t });
            await t.commit();
            return { success: true, message: '你退出琉璃古塔，重整旗鼓。', highest_floor: row.highest_floor };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    static async resetTower(playerId) {
        const config = getConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            const row = await this.getOrCreate(playerId, t, true);
            this._rollDaily(row);
            if (row.today_resets >= config.global.reset_daily_limit) {
                throw new AppError('今日重置次数已用尽', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            const cost = BigInt(config.global.reset_cost_spirit_stones || 500);
            const stones = safeBigInt(player.spirit_stones);
            if (stones < cost) throw new AppError('灵石不足，无法重置古塔', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            player.spirit_stones = (stones - cost).toString();
            row.today_resets += 1;
            row.in_tower = 0;
            row.current_floor = 0;
            row.highest_floor = 0;
            await player.save({ transaction: t });
            await row.save({ transaction: t });
            await t.commit();
            return {
                success: true,
                message: `支付 ${cost} 灵石，古塔进度已重置，可从凡尘阶重新闯起。`,
                spirit_stones_cost: cost.toString()
            };
        } catch (err) {
            await t.rollback();
            throw err;
        }
    }

    static async getRanking(limit = 20) {
        const topN = limit || getConfig().global.ranking_top_n;
        const rows = await PlayerPagoda.findAll({
            order: [['best_score', 'DESC'], ['highest_floor', 'DESC'], ['updated_at', 'ASC']],
            limit: topN
        });
        const playerIds = rows.map(r => r.player_id);
        const players = playerIds.length
            ? await Player.findAll({ where: { id: playerIds }, attributes: ['id', 'nickname', 'username', 'realm', 'realm_rank'] })
            : [];
        const byId = new Map(players.map(p => [p.id, p]));
        return rows.map((r, i) => {
            const p = byId.get(r.player_id) || {};
            return {
                rank: i + 1,
                player_id: r.player_id,
                nickname: p.nickname || p.username || '道友',
                realm: p.realm || '凡人',
                highest_floor: r.highest_floor,
                best_score: r.best_score,
                total_clears: r.total_clears
            };
        });
    }

    static async getHistory(playerId, limit = 20) {
        return PlayerPagodaRecord.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'DESC']],
            limit: Math.min(limit || 20, 50)
        });
    }
}

module.exports = PagodaService;
