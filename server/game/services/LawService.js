/**
 * 法则转换服务
 *
 * 实现批次3设计文档第4.5节「法则转换系统」的全部业务逻辑：
 *   1. 查询法则面板（法则点/5 类碎片/转换选项/每日获取上限）
 *   2. 法则点转换（神识→法则点 / 碎片→法则点）
 *   3. 法则转换（消耗法则点，兑换问道感悟/法相经验/神识上限/残魂/突破加成/飞升加成/碎片）
 *   4. GM 发放法则点 / GM 发放法则碎片
 *
 * 法则点获取公式（每日上限 50）：
 *   - 100 神识 = 1 法则点（convert_divine_sense_to_points_ratio）
 *   - 1 空间碎片 = 5 法则点（convert_space_fragment_to_points）
 *   - 1 其他碎片 = 3 法则点（convert_other_fragment_to_points）
 *
 * 法则转换效果（7 种）：
 *   1. ask_dao_insight      - 问道感悟 +10（消耗 5 法则点）
 *   2. dharma_form_exp      - 法相天地经验 +100（消耗 10 法则点）
 *   3. divine_sense_max     - 神识上限 +50（消耗 15 法则点）
 *   4. remnant_soul         - 残魂恢复 +20（消耗 8 法则点）
 *   5. breakthrough_bonus   - 突破成功率 +5%（消耗 20 法则点）
 *   6. ascension_bonus      - 飞升成功率 +3%（消耗 30 法则点）
 *   7. space_law_fragment   - 空间法则碎片 ×1（消耗 25 法则点）
 *
 * 设计原则：
 *   - 所有阈值/比例从 late_stage_data.json 配置读取，禁止硬编码
 *   - 关键操作（转换/兑换）使用事务 + LOCK.UPDATE 行级锁
 *   - 跨日重置每日获取次数（按 DATEONLY 比较）
 *   - 法则点每日获取上限 50（防止刷爆，影响飞升平衡）
 *   - 关键事件通过 WebSocketNotificationService 推送，事务外推送避免阻塞
 *
 * 数据模型：
 *   - Player: 玩家主表（law_points/ask_dao_insight/dharma_form_exp/remnant_soul/breakthrough_bonus/ascension_bonus）
 *   - PlayerLaw: 法则表（1:1，law_points + 5 类碎片存量）
 *   - PlayerLawFragment: 法则碎片流水表（N:1，碎片变动审计）
 *   - PlayerDivineSense: 神识表（神识→法则点转换时扣减）
 *   - PlayerAscension: 飞升表（问道感悟/法相经验/法则碎片同步）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerLaw = require('../../models/playerLaw');
const PlayerLawFragment = require('../../models/playerLawFragment');
const PlayerDivineSense = require('../../models/playerDivineSense');
const PlayerAscension = require('../../models/playerAscension');
const sequelize = require('../../config/database');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');

/**
 * 法则碎片字段映射：碎片类型 → PlayerLaw 表字段名
 */
const FRAGMENT_FIELD_MAP = {
    space: 'law_fragments_space',
    time: 'law_fragments_time',
    five_elements: 'law_fragments_five_elements',
    soul: 'law_fragments_soul',
    karma: 'law_fragments_karma'
};

/**
 * 工具函数：跨日重置每日次数（按 DATEONLY 比较）
 * @param {Object} model - 模型实例
 * @param {string} dateField - 日期字段名
 * @param {string} countField - 次数字段名
 * @param {number} resetValue - 重置后的次数（默认 0）
 */
function resetDailyCountIfCrossDay(model, dateField, countField, resetValue = 0) {
    const today = new Date().toISOString().slice(0, 10);
    const lastDate = model[dateField];
    if (lastDate) {
        const lastStr = lastDate instanceof Date
            ? lastDate.toISOString().slice(0, 10)
            : String(lastDate).slice(0, 10);
        if (lastStr !== today) {
            model[countField] = resetValue;
            model[dateField] = today;
        }
    } else {
        model[countField] = resetValue;
        model[dateField] = today;
    }
}

class LawService {
    /**
     * 获取玩家法则面板数据
     * 包含法则点/5 类碎片存量/转换选项/每日获取进度
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('late_stage_data');
        const lawCfg = config.law;

        // 获取或创建法则记录（懒创建）
        let law = await PlayerLaw.findOne({ where: { player_id: playerId } });
        if (!law) {
            law = await PlayerLaw.create({
                player_id: playerId,
                law_points: 0,
                total_earned: 0,
                total_spent: 0,
                daily_earned: 0,
                last_earn_date: null,
                law_fragments_space: 0,
                law_fragments_time: 0,
                law_fragments_five_elements: 0,
                law_fragments_soul: 0,
                law_fragments_karma: 0
            });
        }

        // 跨日重置每日获取进度
        resetDailyCountIfCrossDay(law, 'last_earn_date', 'daily_earned', 0);
        await law.save();

        const dailyEarned = Number(law.daily_earned || 0);
        const dailyLimit = Number(lawCfg.daily_earn_limit || 50);

        return {
            success: true,
            data: {
                law_points: {
                    current: Number(law.law_points),
                    total_earned: Number(law.total_earned),
                    total_spent: Number(law.total_spent),
                    daily_earned: dailyEarned,
                    daily_limit: dailyLimit,
                    daily_remaining: Math.max(0, dailyLimit - dailyEarned)
                },
                fragments: {
                    space: Number(law.law_fragments_space),
                    time: Number(law.law_fragments_time),
                    five_elements: Number(law.law_fragments_five_elements),
                    soul: Number(law.law_fragments_soul),
                    karma: Number(law.law_fragments_karma)
                },
                convert_rates: {
                    divine_sense_to_points: Number(lawCfg.convert_divine_sense_to_points_ratio),
                    space_fragment_to_points: Number(lawCfg.convert_space_fragment_to_points),
                    other_fragment_to_points: Number(lawCfg.convert_other_fragment_to_points)
                },
                convert_options: lawCfg.convert_options || [],
                fragment_types: lawCfg.fragment_types || {}
            }
        };
    }

    /**
     * 法则点转换（神识 → 法则点）
     * 100 神识 = 1 法则点，受每日获取上限限制
     * @param {number} playerId - 玩家ID
     * @param {number} divineSenseAmount - 消耗的神识数量
     * @returns {Promise<Object>} { success, message, data }
     */
    static async convertDivineSenseToPoints(playerId, divineSenseAmount) {
        if (!Number.isInteger(divineSenseAmount) || divineSenseAmount <= 0) {
            return { success: false, message: 'divine_sense_amount 必须为正整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('late_stage_data');
        const lawCfg = config.law;
        const ratio = Number(lawCfg.convert_divine_sense_to_points_ratio);
        const pointsToEarn = Math.floor(divineSenseAmount / ratio);
        if (pointsToEarn <= 0) {
            return {
                success: false,
                message: `神识不足：至少需要 ${ratio} 神识才能转换 1 法则点`,
                error_code: ErrorCodes.BUSINESS_LOGIC_ERROR
            };
        }
        const actualDivineSenseCost = pointsToEarn * ratio;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 获取或创建法则记录
            let law = await PlayerLaw.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!law) {
                law = await PlayerLaw.create({
                    player_id: playerId,
                    law_points: 0,
                    total_earned: 0,
                    total_spent: 0,
                    daily_earned: 0,
                    last_earn_date: null,
                    law_fragments_space: 0,
                    law_fragments_time: 0,
                    law_fragments_five_elements: 0,
                    law_fragments_soul: 0,
                    law_fragments_karma: 0
                }, { transaction: t });
            }

            // 跨日重置
            resetDailyCountIfCrossDay(law, 'last_earn_date', 'daily_earned', 0);

            // 每日获取上限校验
            const dailyEarned = Number(law.daily_earned || 0);
            const dailyLimit = Number(lawCfg.daily_earn_limit || 50);
            const remainingToday = dailyLimit - dailyEarned;
            if (remainingToday <= 0) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日法则点获取已达上限（${dailyLimit}），明日再来`
                };
            }
            // 调整可获得的法则点（不超过剩余额度）
            const actualPointsToEarn = Math.min(pointsToEarn, remainingToday);
            const actualCost = actualPointsToEarn * ratio;

            // 神识余额校验（从 PlayerDivineSense 表读取，懒创建）
            let sense = await PlayerDivineSense.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!sense) {
                // 同步创建默认神识记录（参考 DivineSenseService 的初始化逻辑）
                const ascension = await PlayerAscension.findOne({
                    where: { player_id: playerId },
                    transaction: t
                });
                const senseCfg = config.divine_sense;
                const realmRank = Number(player.realm_rank || 0);
                const dayanLevel = ascension ? Number(ascension.dayan_level || 0) : 0;
                const expectedMax = Number(senseCfg.base_max || 100)
                    + Math.max(0, realmRank - Number(senseCfg.max_formula_realm_rank_base || 14)) * Number(senseCfg.max_formula_per_rank_bonus || 50)
                    + dayanLevel * Number(senseCfg.max_formula_dayan_per_level_bonus || 100);
                sense = await PlayerDivineSense.create({
                    player_id: playerId,
                    divine_sense_max: expectedMax,
                    divine_sense_current: expectedMax,
                    regen_rate_per_hour: senseCfg.regen_rate_per_hour || 10,
                    last_regen_time: new Date(),
                    total_quenched: 0,
                    total_consumed: 0
                }, { transaction: t });
            }
            const currentSense = Number(sense.divine_sense_current || 0);
            if (currentSense < actualCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `神识不足，需要 ${actualCost}，当前 ${currentSense}`
                };
            }

            // 执行转换：扣神识、加法则点、更新统计
            const oldSense = currentSense;
            const newSense = currentSense - actualCost;
            sense.divine_sense_current = newSense;
            sense.total_consumed = Number(sense.total_consumed || 0) + actualCost;
            // 同步玩家冗余字段
            player.divine_sense_balance = newSense;

            const oldPoints = Number(law.law_points || 0);
            const newPoints = oldPoints + actualPointsToEarn;
            law.law_points = newPoints;
            law.total_earned = Number(law.total_earned || 0) + actualPointsToEarn;
            law.daily_earned = Number(law.daily_earned || 0) + actualPointsToEarn;
            law.last_earn_date = new Date().toISOString().slice(0, 10);
            // 同步玩家冗余字段
            player.law_points = newPoints;

            await player.save({ transaction: t });
            await sense.save({ transaction: t });
            await law.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'law_points_converted', {
                    source: 'divine_sense',
                    divine_sense_cost: actualCost,
                    points_earned: actualPointsToEarn,
                    old_sense: oldSense,
                    new_sense: newSense,
                    old_points: oldPoints,
                    new_points: newPoints
                });
            } catch (e) {
                console.warn('[LawService] 推送法则点转换通知失败:', e.message);
            }

            return {
                success: true,
                message: `法则点转换成功！消耗 ${actualCost} 神识，获得 ${actualPointsToEarn} 法则点`,
                data: {
                    source: 'divine_sense',
                    divine_sense_cost: actualCost,
                    points_earned: actualPointsToEarn,
                    old_sense: oldSense,
                    new_sense: newSense,
                    old_points: oldPoints,
                    new_points: newPoints,
                    daily_earned: Number(law.daily_earned),
                    daily_limit: dailyLimit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[LawService] convertDivineSenseToPoints 异常:', err);
            throw err;
        }
    }

    /**
     * 法则点转换（碎片 → 法则点）
     * 空间碎片 1=5 点，其他碎片 1=3 点，受每日获取上限限制
     * @param {number} playerId - 玩家ID
     * @param {string} fragmentType - 碎片类型：space/time/five_elements/soul/karma
     * @param {number} fragmentCount - 消耗的碎片数量
     * @returns {Promise<Object>} { success, message, data }
     */
    static async convertFragmentToPoints(playerId, fragmentType, fragmentCount) {
        // 参数校验
        if (!FRAGMENT_FIELD_MAP[fragmentType]) {
            return { success: false, message: `不支持的碎片类型：${fragmentType}`, error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!Number.isInteger(fragmentCount) || fragmentCount <= 0) {
            return { success: false, message: 'fragment_count 必须为正整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('late_stage_data');
        const lawCfg = config.law;
        const ratio = fragmentType === 'space'
            ? Number(lawCfg.convert_space_fragment_to_points)
            : Number(lawCfg.convert_other_fragment_to_points);
        const pointsToEarn = fragmentCount * ratio;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            let law = await PlayerLaw.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!law) {
                law = await PlayerLaw.create({
                    player_id: playerId,
                    law_points: 0,
                    total_earned: 0,
                    total_spent: 0,
                    daily_earned: 0,
                    last_earn_date: null,
                    law_fragments_space: 0,
                    law_fragments_time: 0,
                    law_fragments_five_elements: 0,
                    law_fragments_soul: 0,
                    law_fragments_karma: 0
                }, { transaction: t });
            }

            resetDailyCountIfCrossDay(law, 'last_earn_date', 'daily_earned', 0);

            // 每日获取上限校验
            const dailyEarned = Number(law.daily_earned || 0);
            const dailyLimit = Number(lawCfg.daily_earn_limit || 50);
            const remainingToday = dailyLimit - dailyEarned;
            if (remainingToday <= 0) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日法则点获取已达上限（${dailyLimit}），明日再来`
                };
            }
            // 调整可获得的法则点（不超过剩余额度）
            const actualPointsToEarn = Math.min(pointsToEarn, remainingToday);
            // 反推实际消耗的碎片数量
            const actualFragmentCost = Math.ceil(actualPointsToEarn / ratio);
            const actualPoints = actualFragmentCost * ratio;
            // 如果反推后超过剩余额度，则再调整
            const finalPoints = Math.min(actualPoints, remainingToday);
            const finalFragmentCost = Math.floor(finalPoints / ratio);
            if (finalFragmentCost <= 0) {
                await t.rollback();
                return { success: false, message: `今日剩余法则点获取额度不足（剩 ${remainingToday} 点）` };
            }
            const finalPointsEarned = finalFragmentCost * ratio;

            // 碎片余额校验
            const fragmentField = FRAGMENT_FIELD_MAP[fragmentType];
            const currentFragments = Number(law[fragmentField] || 0);
            if (currentFragments < finalFragmentCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `${lawCfg.fragment_types[fragmentType].name}不足，需要 ${finalFragmentCost}，当前 ${currentFragments}`
                };
            }

            // 执行转换
            const oldFragments = currentFragments;
            const newFragments = currentFragments - finalFragmentCost;
            law[fragmentField] = newFragments;

            const oldPoints = Number(law.law_points || 0);
            const newPoints = oldPoints + finalPointsEarned;
            law.law_points = newPoints;
            law.total_earned = Number(law.total_earned || 0) + finalPointsEarned;
            law.daily_earned = Number(law.daily_earned || 0) + finalPointsEarned;
            law.last_earn_date = new Date().toISOString().slice(0, 10);
            // 同步玩家冗余字段
            player.law_points = newPoints;

            // 写入碎片流水
            await PlayerLawFragment.create({
                player_id: playerId,
                fragment_type: fragmentType,
                change_amount: -finalFragmentCost,
                source: 'law_convert',
                balance_after: newFragments
            }, { transaction: t });

            await player.save({ transaction: t });
            await law.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'law_points_converted', {
                    source: 'fragment',
                    fragment_type: fragmentType,
                    fragment_cost: finalFragmentCost,
                    points_earned: finalPointsEarned,
                    old_fragments: oldFragments,
                    new_fragments: newFragments,
                    old_points: oldPoints,
                    new_points: newPoints
                });
            } catch (e) {
                console.warn('[LawService] 推送碎片转换通知失败:', e.message);
            }

            return {
                success: true,
                message: `法则点转换成功！消耗 ${finalFragmentCost} ${lawCfg.fragment_types[fragmentType].name}，获得 ${finalPointsEarned} 法则点`,
                data: {
                    source: 'fragment',
                    fragment_type: fragmentType,
                    fragment_cost: finalFragmentCost,
                    points_earned: finalPointsEarned,
                    old_fragments: oldFragments,
                    new_fragments: newFragments,
                    old_points: oldPoints,
                    new_points: newPoints,
                    daily_earned: Number(law.daily_earned),
                    daily_limit: dailyLimit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[LawService] convertFragmentToPoints 异常:', err);
            throw err;
        }
    }

    /**
     * 法则转换（消耗法则点，兑换永久/临时效果）
     * 7 种效果：问道感悟/法相经验/神识上限/残魂/突破加成/飞升加成/空间碎片
     * @param {number} playerId - 玩家ID
     * @param {string} convertId - 转换选项ID（参考 convert_options 配置）
     * @param {number} [count=1] - 转换次数（默认 1，可批量）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async convert(playerId, convertId, count = 1) {
        if (!convertId || typeof convertId !== 'string') {
            return { success: false, message: 'convert_id 必填且必须为字符串', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!Number.isInteger(count) || count <= 0 || count > 100) {
            return { success: false, message: 'count 必须为 1-100 之间的整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('late_stage_data');
        const lawCfg = config.law;
        const convertOption = lawCfg.convert_options.find(o => o.convert_id === convertId);
        if (!convertOption) {
            return { success: false, message: `未找到转换选项：${convertId}`, error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const totalCost = Number(convertOption.cost_law_points) * count;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            let law = await PlayerLaw.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!law) {
                law = await PlayerLaw.create({
                    player_id: playerId,
                    law_points: 0,
                    total_earned: 0,
                    total_spent: 0,
                    daily_earned: 0,
                    last_earn_date: null,
                    law_fragments_space: 0,
                    law_fragments_time: 0,
                    law_fragments_five_elements: 0,
                    law_fragments_soul: 0,
                    law_fragments_karma: 0
                }, { transaction: t });
            }

            // 法则点余额校验
            const currentPoints = Number(law.law_points || 0);
            if (currentPoints < totalCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `法则点不足，需要 ${totalCost}（${count} 次），当前 ${currentPoints}`
                };
            }

            // 执行法则点扣减
            const oldPoints = currentPoints;
            const newPoints = currentPoints - totalCost;
            law.law_points = newPoints;
            law.total_spent = Number(law.total_spent || 0) + totalCost;
            // 同步玩家冗余字段
            player.law_points = newPoints;

            // 根据效果类型应用转换
            const effectType = convertOption.effect_type;
            const totalEffectAmount = Number(convertOption.effect_amount) * count;
            const effectsApplied = {};

            switch (effectType) {
                case 'ask_dao_insight': {
                    // 问道感悟 +N（写入 player.ask_dao_insight）
                    const attrs = player.attributes || {};
                    const oldInsight = Number(attrs.ask_dao_insight || 0);
                    attrs.ask_dao_insight = oldInsight + totalEffectAmount;
                    player.attributes = attrs;
                    effectsApplied.ask_dao_insight_added = totalEffectAmount;
                    effectsApplied.ask_dao_insight_total = oldInsight + totalEffectAmount;
                    break;
                }
                case 'dharma_form_exp': {
                    // 法相天地经验 +N（写入 player.dharma_form_exp，由飞升系统读取）
                    const attrs = player.attributes || {};
                    const oldExp = Number(attrs.dharma_form_exp || 0);
                    attrs.dharma_form_exp = oldExp + totalEffectAmount;
                    player.attributes = attrs;
                    effectsApplied.dharma_form_exp_added = totalEffectAmount;
                    effectsApplied.dharma_form_exp_total = oldExp + totalEffectAmount;
                    break;
                }
                case 'divine_sense_max': {
                    // 神识上限 +N（永久提升 PlayerDivineSense.divine_sense_max）
                    let sense = await PlayerDivineSense.findOne({
                        where: { player_id: playerId },
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    if (sense) {
                        const oldMax = Number(sense.divine_sense_max || 0);
                        sense.divine_sense_max = oldMax + totalEffectAmount;
                        // 上限提升时同步增加当前神识
                        sense.divine_sense_current = Number(sense.divine_sense_current || 0) + totalEffectAmount;
                        await sense.save({ transaction: t });
                        effectsApplied.divine_sense_max_added = totalEffectAmount;
                        effectsApplied.divine_sense_max_total = oldMax + totalEffectAmount;
                    }
                    break;
                }
                case 'remnant_soul': {
                    // 残魂恢复 +N（写入 player.remnant_soul）
                    const attrs = player.attributes || {};
                    const oldRemnant = Number(attrs.remnant_soul || 0);
                    const newRemnant = Math.min(100, oldRemnant + totalEffectAmount); // 残魂上限 100
                    attrs.remnant_soul = newRemnant;
                    player.attributes = attrs;
                    effectsApplied.remnant_soul_added = newRemnant - oldRemnant;
                    effectsApplied.remnant_soul_total = newRemnant;
                    break;
                }
                case 'breakthrough_bonus': {
                    // 突破成功率 +N%（临时加成，写入 player.attributes.breakthrough_bonus）
                    const attrs = player.attributes || {};
                    const oldBonus = Number(attrs.breakthrough_bonus || 0);
                    attrs.breakthrough_bonus = oldBonus + totalEffectAmount;
                    player.attributes = attrs;
                    effectsApplied.breakthrough_bonus_added = totalEffectAmount;
                    effectsApplied.breakthrough_bonus_total = oldBonus + totalEffectAmount;
                    break;
                }
                case 'ascension_bonus': {
                    // 飞升成功率 +N%（临时加成，写入 player.attributes.ascension_bonus）
                    const attrs = player.attributes || {};
                    const oldBonus = Number(attrs.ascension_bonus || 0);
                    attrs.ascension_bonus = oldBonus + totalEffectAmount;
                    player.attributes = attrs;
                    effectsApplied.ascension_bonus_added = totalEffectAmount;
                    effectsApplied.ascension_bonus_total = oldBonus + totalEffectAmount;
                    break;
                }
                case 'space_law_fragment': {
                    // 空间法则碎片 +N（写入 PlayerLaw.law_fragments_space + PlayerAscension.law_fragments_count）
                    const oldSpace = Number(law.law_fragments_space || 0);
                    law.law_fragments_space = oldSpace + totalEffectAmount;

                    // 同步飞升表的 law_fragments_count（飞升前置条件）
                    let ascension = await PlayerAscension.findOne({
                        where: { player_id: playerId },
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    if (ascension) {
                        ascension.law_fragments_count = Number(ascension.law_fragments_count || 0) + totalEffectAmount;
                        await ascension.save({ transaction: t });
                    }

                    // 写入碎片流水
                    await PlayerLawFragment.create({
                        player_id: playerId,
                        fragment_type: 'space',
                        change_amount: totalEffectAmount,
                        source: 'law_convert',
                        balance_after: oldSpace + totalEffectAmount
                    }, { transaction: t });

                    effectsApplied.space_law_fragment_added = totalEffectAmount;
                    effectsApplied.space_law_fragment_total = oldSpace + totalEffectAmount;
                    break;
                }
                default: {
                    await t.rollback();
                    return { success: false, message: `未知效果类型：${effectType}`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
                }
            }

            await player.save({ transaction: t });
            await law.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'law_converted', {
                    convert_id: convertId,
                    convert_name: convertOption.name,
                    count,
                    total_cost: totalCost,
                    effect_type: effectType,
                    effects: effectsApplied,
                    old_points: oldPoints,
                    new_points: newPoints
                });
            } catch (e) {
                console.warn('[LawService] 推送法则转换通知失败:', e.message);
            }

            return {
                success: true,
                message: `法则转换成功！${convertOption.name} ×${count}，消耗 ${totalCost} 法则点`,
                data: {
                    convert_id: convertId,
                    convert_name: convertOption.name,
                    count,
                    total_cost: totalCost,
                    effect_type: effectType,
                    effects: effectsApplied,
                    old_points: oldPoints,
                    new_points: newPoints
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[LawService] convert 异常:', err);
            throw err;
        }
    }

    /**
     * GM 发放法则点
     * 直接调整玩家法则点，不受每日上限限制
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 数量（正数增加，负数扣减）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmGrantPoints(playerId, amount) {
        if (!Number.isInteger(amount) || amount === 0) {
            return { success: false, message: 'amount 必须为非零整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (amount < -10000 || amount > 10000) {
            return { success: false, message: 'amount 范围必须在 -10000 到 10000 之间', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            let law = await PlayerLaw.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!law) {
                law = await PlayerLaw.create({
                    player_id: playerId,
                    law_points: 0,
                    total_earned: 0,
                    total_spent: 0,
                    daily_earned: 0,
                    last_earn_date: null,
                    law_fragments_space: 0,
                    law_fragments_time: 0,
                    law_fragments_five_elements: 0,
                    law_fragments_soul: 0,
                    law_fragments_karma: 0
                }, { transaction: t });
            }

            const oldPoints = Number(law.law_points || 0);
            const newPoints = Math.max(0, oldPoints + amount);
            const actualChange = newPoints - oldPoints;
            if (actualChange === 0) {
                await t.rollback();
                return { success: false, message: '玩家法则点已为 0，无法扣减' };
            }

            law.law_points = newPoints;
            if (actualChange > 0) {
                law.total_earned = Number(law.total_earned || 0) + actualChange;
                // GM 发放不计入每日上限（避免被上限卡住）
            } else {
                law.total_spent = Number(law.total_spent || 0) + Math.abs(actualChange);
            }
            // 同步玩家冗余字段
            player.law_points = newPoints;

            await player.save({ transaction: t });
            await law.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `法则点 ${actualChange > 0 ? '发放' : '扣减'} ${Math.abs(actualChange)}（${oldPoints} → ${newPoints}）`,
                data: {
                    old_points: oldPoints,
                    new_points: newPoints,
                    change: actualChange
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[LawService] gmGrantPoints 异常:', err);
            throw err;
        }
    }

    /**
     * GM 发放法则碎片
     * @param {number} playerId - 玩家ID
     * @param {string} fragmentType - 碎片类型：space/time/five_elements/soul/karma
     * @param {number} amount - 数量（正数增加，负数扣减）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmGrantFragment(playerId, fragmentType, amount) {
        if (!FRAGMENT_FIELD_MAP[fragmentType]) {
            return { success: false, message: `不支持的碎片类型：${fragmentType}`, error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!Number.isInteger(amount) || amount === 0) {
            return { success: false, message: 'amount 必须为非零整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (amount < -1000 || amount > 1000) {
            return { success: false, message: 'amount 范围必须在 -1000 到 1000 之间', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('late_stage_data');
        const lawCfg = config.law;

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            let law = await PlayerLaw.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!law) {
                law = await PlayerLaw.create({
                    player_id: playerId,
                    law_points: 0,
                    total_earned: 0,
                    total_spent: 0,
                    daily_earned: 0,
                    last_earn_date: null,
                    law_fragments_space: 0,
                    law_fragments_time: 0,
                    law_fragments_five_elements: 0,
                    law_fragments_soul: 0,
                    law_fragments_karma: 0
                }, { transaction: t });
            }

            const fragmentField = FRAGMENT_FIELD_MAP[fragmentType];
            const oldFragments = Number(law[fragmentField] || 0);
            const newFragments = Math.max(0, oldFragments + amount);
            const actualChange = newFragments - oldFragments;
            if (actualChange === 0) {
                await t.rollback();
                return { success: false, message: `${lawCfg.fragment_types[fragmentType].name}已为 0，无法扣减` };
            }

            law[fragmentField] = newFragments;

            // 写入碎片流水
            await PlayerLawFragment.create({
                player_id: playerId,
                fragment_type: fragmentType,
                change_amount: actualChange,
                source: 'gm_grant',
                balance_after: newFragments
            }, { transaction: t });

            // 空间碎片同步到飞升表的 law_fragments_count
            if (fragmentType === 'space') {
                let ascension = await PlayerAscension.findOne({
                    where: { player_id: playerId },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (ascension) {
                    ascension.law_fragments_count = Math.max(0, Number(ascension.law_fragments_count || 0) + actualChange);
                    await ascension.save({ transaction: t });
                }
            }

            await law.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `${lawCfg.fragment_types[fragmentType].name} ${actualChange > 0 ? '发放' : '扣减'} ${Math.abs(actualChange)}（${oldFragments} → ${newFragments}）`,
                data: {
                    fragment_type: fragmentType,
                    fragment_name: lawCfg.fragment_types[fragmentType].name,
                    old_count: oldFragments,
                    new_count: newFragments,
                    change: actualChange
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[LawService] gmGrantFragment 异常:', err);
            throw err;
        }
    }
}

module.exports = LawService;
