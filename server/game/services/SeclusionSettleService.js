/**
 * 闭关结算服务（常规闭关多轮判定）
 *
 * 设计依据：
 *   一次常规闭关按 round_interval 切成多轮，每轮独立判定
 *   成功 / 失败 / 走火入魔 三种结果；结束时汇总次数并写入提示。
 *
 *   - 成功：全额轮次收益
 *   - 失败：fail_exp_ratio（默认 30%）收益
 *   - 走火入魔：0 收益，按 deviation_exp_penalty_ratio 倒扣本轮收益，
 *              并按 deviation_hp_loss_ratio 扣气血；护法（侍妾/傀儡）可减免伤害
 *
 * 另有：
 *   - 每轮有几率触发奇遇（encounter）
 *   - 结束后进入随机冷却（cooldown_min ~ cooldown_max，默认 10~15 分钟）
 *
 * 深度闭关仍走时长线性收益，不走本服务的多轮判定。
 */
'use strict';

const { infrastructure } = require('../../modules');
const RealmService = require('../core/RealmService');
const CaveService = require('./CaveService');

const configLoader = infrastructure.ConfigLoader;

const DEFAULT_NORMAL = {
    max_duration: 1800,
    daily_limit: 3,
    cooldown: 600,
    cooldown_min: 600,
    cooldown_max: 900,
    exp_rate: 1,
    round_interval: 60,
    outcomes: {
        success_rate: 0.65,
        fail_rate: 0.25,
        deviation_rate: 0.10,
        fail_exp_ratio: 0.3,
        deviation_exp_penalty_ratio: 0.1,
        deviation_hp_loss_ratio: 0.15,
        guard_damage_reduction: 0.3
    },
    encounter: {
        enabled: true,
        trigger_chance: 0.05,
        session_limit: 2,
        pool: [
            {
                id: 'insight',
                name: '灵光乍现',
                weight: 30,
                type: 'exp_bonus',
                exp_bonus_ratio: 0.5,
                description: '冥冥中捕捉到一丝道韵，本轮修为大进'
            },
            {
                id: 'herb',
                name: '偶得灵草',
                weight: 25,
                type: 'item',
                item_id: 'low_healing_pill',
                item_count: 1,
                description: '石缝中发现一株灵草，炼成丹药收入囊中'
            },
            {
                id: 'stone',
                name: '拾得灵石',
                weight: 25,
                type: 'spirit_stone',
                amount: 80,
                description: '洞中偶得些许灵石'
            },
            {
                id: 'heart_demon',
                name: '心魔微扰',
                weight: 20,
                type: 'exp_penalty',
                exp_penalty_ratio: 0.05,
                description: '心神微荡，少许修为溃散'
            }
        ]
    }
};

function getNormalConfig() {
    try {
        const config = configLoader.getConfig('seclusion');
        const settings = config?.settings?.normal_seclusion?.value;
        if (settings) {
            return {
                ...DEFAULT_NORMAL,
                ...settings,
                outcomes: { ...DEFAULT_NORMAL.outcomes, ...(settings.outcomes || {}) },
                encounter: {
                    ...DEFAULT_NORMAL.encounter,
                    ...(settings.encounter || {}),
                    pool: settings.encounter?.pool?.length
                        ? settings.encounter.pool
                        : DEFAULT_NORMAL.encounter.pool
                }
            };
        }
    } catch (e) {
        console.warn('[SeclusionSettle] 读取常规闭关配置失败:', e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_NORMAL));
}

function getBaseExpRate() {
    try {
        const config = configLoader.getConfig('seclusion');
        return parseFloat(config?.settings?.seclusion_exp_rate?.value) || 1;
    } catch (e) {
        return 1;
    }
}

function getRealmMultiplier(realmName) {
    try {
        const realm = RealmService.getRealmByName(realmName);
        if (realm && realm.rank) {
            return 1.0 + (realm.rank - 1) * 0.1;
        }
    } catch (err) {
        console.error('[SeclusionSettle] 获取境界加成失败:', err.message);
    }
    return 1.0;
}

function randInt(min, max) {
    const lo = Math.floor(min);
    const hi = Math.floor(max);
    if (hi <= lo) return lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pickWeighted(pool) {
    const total = pool.reduce((s, e) => s + (Number(e.weight) || 1), 0);
    if (total <= 0) return pool[0];
    let roll = Math.random() * total;
    for (const e of pool) {
        roll -= (Number(e.weight) || 1);
        if (roll <= 0) return e;
    }
    return pool[pool.length - 1];
}

/**
 * 是否有护法生效（侍妾护法日志 / 护法傀儡）
 * 任一命中即按护法减免走火入魔伤害
 */
async function hasActiveGuard(playerId) {
    try {
        const PuppetService = require('./PuppetService');
        const puppet = await PuppetService.getGuardPuppetCounter(playerId);
        if (puppet) return true;
    } catch (e) { /* 傀儡未启用时静默 */ }

    try {
        const ConcubineLog = require('../../models/concubineLog');
        const { Op } = require('sequelize');
        const protectCfg = (() => {
            try {
                return configLoader.getConfig('companion_data')?.protect || { duration_hours: 8 };
            } catch (e) {
                return { duration_hours: 8 };
            }
        })();
        const since = new Date(Date.now() - (Number(protectCfg.duration_hours) || 8) * 3600 * 1000);
        const logs = await ConcubineLog.findAll({
            where: {
                player_id: playerId,
                action_type: 'gift',
                created_at: { [Op.gte]: since }
            },
            order: [['created_at', 'DESC']],
            limit: 30
        });
        for (const log of logs) {
            let detail = log.action_detail;
            if (typeof detail === 'string') {
                try { detail = JSON.parse(detail); } catch (e) { detail = null; }
            }
            if (detail && detail.action === 'protect') return true;
        }
    } catch (e) { /* 侍妾未启用时静默 */ }

    return false;
}

/**
 * 从 time_system_data 读/写随机冷却截止时间（避免新增列）
 */
function getCooldownUntil(player) {
    try {
        const data = player.time_system_data || {};
        const raw = data.seclusion_cooldown_until;
        if (!raw) return null;
        const ts = new Date(raw).getTime();
        return Number.isFinite(ts) ? ts : null;
    } catch (e) {
        return null;
    }
}

function setCooldownUntil(player, untilDate) {
    const data = { ...(player.time_system_data || {}) };
    data.seclusion_cooldown_until = untilDate.toISOString();
    player.time_system_data = data;
}

/**
 * 计算常规闭关剩余冷却秒数
 * 优先读本次结算写入的随机冷却截止点；无则回退固定 cooldown 与 last_seclusion_time
 */
function getNormalCooldownRemaining(player, config = null) {
    const cfg = config || getNormalConfig();
    const now = Date.now();
    const until = getCooldownUntil(player);
    if (until) {
        return Math.max(0, Math.ceil((until - now) / 1000));
    }
    // 兼容旧数据：固定 cooldown
    const cooldownSec = cfg.cooldown || cfg.cooldown_max || 600;
    if (!player.last_seclusion_time) return 0;
    const lastTs = new Date(player.last_seclusion_time).getTime();
    if (!Number.isFinite(lastTs)) return 0;
    return Math.max(0, cooldownSec - Math.floor((now - lastTs) / 1000));
}

/**
 * 掷随机冷却秒数（默认 600~900）
 */
function rollCooldownSeconds(config = null) {
    const cfg = config || getNormalConfig();
    const min = Number(cfg.cooldown_min ?? cfg.cooldown ?? 600);
    const max = Number(cfg.cooldown_max ?? Math.max(min, 900));
    return randInt(min, Math.max(min, max));
}

/**
 * 常规闭关多轮结算（纯计算 + 奇遇副作用）
 *
 * @param {Object} player  玩家实例（会改 exp / hp_current / time_system_data）
 * @param {number} actualDuration  实际闭关秒数
 * @param {Object} [options]
 * @param {Object} [options.transaction]  Sequelize 事务
 * @param {boolean} [options.applyEncounterSideEffects=true]  是否发放奇遇物品/灵石
 * @returns {Promise<Object>} 结算结果
 */
async function settleNormalSeclusion(player, actualDuration, options = {}) {
    const config = getNormalConfig();
    const outcomes = config.outcomes;
    const interval = Math.max(1, Number(config.round_interval) || 60);
    const baseExpRate = getBaseExpRate();
    const realmMultiplier = getRealmMultiplier(player.realm);
    const modeRate = Number(config.exp_rate) || 1;

    let caveBonus = 0;
    try {
        caveBonus = await CaveService.getCaveSeclusionBonus(player.id);
    } catch (e) {
        caveBonus = 0;
    }
    const bonusMul = 1 + caveBonus;

    const rounds = Math.max(0, Math.floor(actualDuration / interval));
    const remainder = Math.max(0, actualDuration % interval);
    const roundBase = interval * baseExpRate * realmMultiplier * modeRate * bonusMul;

    const successRate = Number(outcomes.success_rate) || 0.65;
    const failRate = Number(outcomes.fail_rate) || 0.25;
    // deviation 用补集，保证三者和为 1
    const failExpRatio = Number(outcomes.fail_exp_ratio) || 0.3;
    const devPenaltyRatio = Number(outcomes.deviation_exp_penalty_ratio) || 0.1;
    const devHpRatio = Number(outcomes.deviation_hp_loss_ratio) || 0.15;
    const guardReduction = Number(outcomes.guard_damage_reduction) || 0.3;

    const guarded = await hasActiveGuard(player.id);
    const dmgMul = guarded ? Math.max(0, 1 - guardReduction) : 1;

    // 最大气血（用于走火入魔扣血）
    let maxHp = 100;
    try {
        const AttributeMaxService = require('../core/AttributeMaxService');
        const realmConfig = RealmService.getRealmByName(player.realm);
        const maxValues = AttributeMaxService.calculateAttributeMaxValues(player, realmConfig);
        maxHp = Number(maxValues.hp_max || 100);
    } catch (e) {
        maxHp = Number(player.hp_current) || 100;
    }

    let successCount = 0;
    let failCount = 0;
    let deviationCount = 0;
    let expFromRounds = 0;
    let totalHpLoss = 0;
    const encounters = [];

    const encounterCfg = config.encounter || { enabled: false };
    const encounterPool = encounterCfg.pool || [];
    const sessionLimit = Math.max(0, Number(encounterCfg.session_limit) || 0);
    const encounterChance = Math.max(0, Math.min(1, Number(encounterCfg.trigger_chance) || 0));

    for (let i = 0; i < rounds; i++) {
        const roll = Math.random();
        if (roll < successRate) {
            successCount += 1;
            expFromRounds += roundBase;
        } else if (roll < successRate + failRate) {
            failCount += 1;
            expFromRounds += roundBase * failExpRatio;
        } else {
            deviationCount += 1;
            expFromRounds -= roundBase * devPenaltyRatio;
            totalHpLoss += Math.floor(maxHp * devHpRatio * dmgMul);
        }

        // 奇遇判定
        if (
            encounterCfg.enabled !== false &&
            encounterPool.length > 0 &&
            encounters.length < sessionLimit &&
            Math.random() < encounterChance
        ) {
            const picked = pickWeighted(encounterPool);
            const enc = {
                id: picked.id,
                name: picked.name,
                description: picked.description || '',
                type: picked.type
            };
            if (picked.type === 'exp_bonus') {
                const bonus = Math.floor(roundBase * (Number(picked.exp_bonus_ratio) || 0));
                enc.exp_bonus = bonus;
                expFromRounds += bonus;
            } else if (picked.type === 'exp_penalty') {
                const penalty = Math.floor(roundBase * (Number(picked.exp_penalty_ratio) || 0));
                enc.exp_penalty = penalty;
                expFromRounds -= penalty;
            } else if (picked.type === 'spirit_stone') {
                const amount = Number(picked.amount) || 0;
                enc.spirit_stones = amount;
                if (options.applyEncounterSideEffects !== false && amount > 0) {
                    player.spirit_stones = (BigInt(player.spirit_stones || 0) + BigInt(amount)).toString();
                }
            } else if (picked.type === 'item') {
                enc.item_id = picked.item_id;
                enc.item_count = Number(picked.item_count) || 1;
                if (options.applyEncounterSideEffects !== false && picked.item_id) {
                    try {
                        const InventoryService = require('./InventoryService');
                        await InventoryService.addItem(
                            player.id,
                            picked.item_id,
                            enc.item_count,
                            options.transaction || null
                        );
                    } catch (e) {
                        console.warn('[SeclusionSettle] 奇遇发物品失败:', e.message);
                        enc.item_granted = false;
                    }
                }
            }
            encounters.push(enc);
        }
    }

    // 不足一轮的余数：按比例给基础收益（不计入三结果次数）
    const remainderExp = Math.floor(remainder * baseExpRate * realmMultiplier * modeRate * bonusMul);
    let expGain = Math.floor(expFromRounds) + remainderExp;
    if (expGain < 0) expGain = 0;

    // 随机冷却 10~15 分钟
    const cooldownSeconds = rollCooldownSeconds(config);
    const cooldownUntil = new Date(Date.now() + cooldownSeconds * 1000);
    setCooldownUntil(player, cooldownUntil);

    return {
        mode: 'normal',
        rounds,
        remainder_seconds: remainder,
        success_count: successCount,
        fail_count: failCount,
        deviation_count: deviationCount,
        exp_gain: expGain,
        hp_loss: Math.min(totalHpLoss, maxHp),
        guarded,
        encounters,
        cooldown_seconds: cooldownSeconds,
        cooldown_until: cooldownUntil,
        round_interval: interval,
        round_base: Math.floor(roundBase),
        realm_multiplier: realmMultiplier,
        cave_bonus: caveBonus
    };
}

/**
 * 深度闭关仍走时长线性收益（保持既有语义）
 */
async function settleDeepSeclusion(player, actualDuration, config, forcedEnd, penaltyRate) {
    const baseExpRate = getBaseExpRate();
    const realmMultiplier = getRealmMultiplier(player.realm);
    let caveBonus = 0;
    try {
        caveBonus = await CaveService.getCaveSeclusionBonus(player.id);
    } catch (e) {
        caveBonus = 0;
    }
    const modeRate = Number(config.exp_rate) || 2;
    const expGain = Math.floor(
        actualDuration * baseExpRate * realmMultiplier * modeRate * penaltyRate * (1 + caveBonus)
    );
    return {
        mode: 'deep',
        rounds: 0,
        success_count: 0,
        fail_count: 0,
        deviation_count: 0,
        exp_gain: expGain,
        hp_loss: 0,
        guarded: false,
        encounters: [],
        cooldown_seconds: Number(config.cooldown) || 3600,
        forced_end: !!forcedEnd,
        penalty_rate: penaltyRate,
        realm_multiplier: realmMultiplier,
        cave_bonus: caveBonus
    };
}

module.exports = {
    getNormalConfig,
    getBaseExpRate,
    getRealmMultiplier,
    getNormalCooldownRemaining,
    getCooldownUntil,
    setCooldownUntil,
    rollCooldownSeconds,
    settleNormalSeclusion,
    settleDeepSeclusion,
    hasActiveGuard,
    DEFAULT_NORMAL
};
