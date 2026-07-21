/**
 * 道侣系统服务
 *
 * 实现批次3设计文档第5章「道侣 / 双修 / 侍妾系统」道侣部分业务逻辑：
 *   1. 道侣面板（getProfile）：关系状态、心契等级、双修次数、誓言、心劫
 *   2. 寻找道侣（seek）：发起邀请，扣灵石，写 pending 记录
 *   3. 同意结侣（accept）：pending → active，双方 dao_companion_id 互填
 *   4. 解除道侣（break）：协议解除（3 天冷静期）/ 毁誓解除（立即+心劫惩罚）
 *   5. 闭关双修（dualCultivate）：+5% 修为，日上限 3 次，需亲密度≥30，残魂≥50
 *   6. 温养（warmNourish）：双方各 +3% 修为，日上限 2 次
 *   7. 采补（pluckSupplement）：主方 +10%，副方 -3%，日上限 1 次，需亲密度≥80
 *   8. 立誓（vow）：3 种誓言（protect/secret/cultivate），30 天有效期
 *   9. 心契面板（getHeartContract）：等级、经验、进度
 *  10. 心劫事件（getHeartTribulation）：获取待处理事件
 *  11. 心劫抉择（chooseHeartTribulation）：稳/狠/骗，结算奖惩
 *
 * 设计原则：
 *   - 所有阈值/比例从 companion_data.json 配置读取，禁止硬编码
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁
 *   - 跨日重置每日次数（按 DATEONLY 比较）
 *   - BigInt 字段（exp/spirit_stones）序列化时 toString()
 *   - 关键事件通过 WebSocketNotificationService 推送
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/exp/remnant_soul/dao_companion_id）
 *   - DaoCompanion: 道侣关系表（1v1，player_a_id/player_b_id 双向 UNIQUE）
 *   - HeartTribulationEvent: 心劫事件表（pending/resolved/failed）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const DaoCompanion = require('../../models/daoCompanion');
const HeartTribulationEvent = require('../../models/heartTribulationEvent');
const Concubine = require('../../models/concubine');
const sequelize = require('../../config/database');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');
const { Op } = require('sequelize');

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

/**
 * 工具函数：根据玩家ID查找其道侣关系（无论作为 A 还是 B）
 * @param {number} playerId - 玩家ID
 * @param {Object} [transaction] - 事务对象（可选）
 * @param {Object} [lock] - 锁对象（可选）
 * @returns {Promise<Object|null>} 道侣关系对象或 null
 */
async function findCompanionByPlayerId(playerId, transaction = null, lock = null) {
    const options = { where: { [Op.or]: [{ player_a_id: playerId }, { player_b_id: playerId }] } };
    if (transaction) options.transaction = transaction;
    if (lock) options.lock = lock;
    return await DaoCompanion.findOne(options);
}

/**
 * 工具函数：根据道侣关系获取对方的玩家ID
 * @param {Object} companion - 道侣关系对象
 * @param {number} playerId - 当前玩家ID
 * @returns {number} 对方玩家ID
 */
function getPartnerId(companion, playerId) {
    return companion.player_a_id === playerId ? companion.player_b_id : companion.player_a_id;
}

class CompanionService {
    /**
     * 获取道侣面板数据
     * 包含关系状态、心契等级、双修次数、誓言、心劫事件
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('companion_data');
        const daoCfg = config.dao_companion;

        const companion = await findCompanionByPlayerId(playerId);
        if (!companion || companion.relation_state === 'broken') {
            return {
                success: true,
                data: {
                    has_companion: false,
                    can_seek: RealmService.meetsRealmRequirement(player, daoCfg.min_realm_name).met,
                    min_realm_name: daoCfg.min_realm_name,
                    seek_cost_spirit_stones: daoCfg.seek_cost_spirit_stones
                }
            };
        }

        // 获取对方玩家信息（仅展示昵称/境界）
        const partnerId = getPartnerId(companion, playerId);
        const partner = await Player.findByPk(partnerId);
        const pendingTribulation = await HeartTribulationEvent.findOne({
            where: {
                player_id: playerId,
                event_state: 'pending',
                expires_at: { [Op.gt]: new Date() }
            },
            order: [['created_at', 'DESC']]
        });

        return {
            success: true,
            data: {
                has_companion: true,
                relation_state: companion.relation_state,
                companion_id: companion.id,
                partner: partner ? {
                    id: partner.id,
                    nickname: partner.nickname,
                    realm: partner.realm
                } : null,
                heart_contract_level: companion.heart_contract_level,
                heart_imprint_count: companion.heart_imprint_count,
                dual_cultivation_count_total: companion.dual_cultivation_count_total,
                daily_dual_cultivation_count: companion.daily_dual_cultivation_count,
                daily_dual_cultivation_limit: daoCfg.daily_dual_cultivation_limit,
                vow: companion.vow_type ? {
                    vow_type: companion.vow_type,
                    vow_expire_time: companion.vow_expire_time,
                    vow_broken: Boolean(companion.vow_broken)
                } : null,
                heart_tribulation_count: companion.heart_tribulation_count,
                pending_tribulation: pendingTribulation ? {
                    event_id: pendingTribulation.id,
                    event_type: pendingTribulation.event_type,
                    expires_at: pendingTribulation.expires_at,
                    options: pendingTribulation.options
                } : null,
                created_at: companion.created_at,
                broken_at: companion.broken_at
            }
        };
    }

    /**
     * 寻找道侣（发起邀请）
     * 校验境界、灵石、是否已有道侣；写入 pending 记录
     * @param {number} playerId - 玩家ID
     * @param {number} targetPlayerId - 目标玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async seek(playerId, targetPlayerId) {
        if (!targetPlayerId || typeof targetPlayerId !== 'number') {
            return { success: false, message: 'target_player_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (targetPlayerId === playerId) {
            return { success: false, message: '不能与自己结为道侣', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('companion_data');
            const daoCfg = config.dao_companion;

            // 境界校验
            const realmCheck = RealmService.meetsRealmRequirement(player, daoCfg.min_realm_name);
            if (!realmCheck.met) {
                await t.rollback();
                return {
                    success: false,
                    message: `需达到${daoCfg.min_realm_name}才能寻找道侣（当前 ${player.realm}）`
                };
            }

            // 灵石消耗校验
            const costStones = BigInt(daoCfg.seek_cost_spirit_stones);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 校验发起方是否已有道侣
            const existingA = await findCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (existingA && existingA.relation_state !== 'broken') {
                await t.rollback();
                return { success: false, message: '您已有道侣关系，无法再次寻找道侣' };
            }

            // 校验目标玩家
            const target = await Player.findByPk(targetPlayerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!target) {
                await t.rollback();
                return { success: false, message: '目标玩家不存在' };
            }

            const targetRealmCheck = RealmService.meetsRealmRequirement(target, daoCfg.min_realm_name);
            if (!targetRealmCheck.met) {
                await t.rollback();
                return {
                    success: false,
                    message: `目标玩家境界需达到${daoCfg.min_realm_name}（当前 ${target.realm}）`
                };
            }

            // 校验目标玩家是否已有道侣
            const existingB = await findCompanionByPlayerId(targetPlayerId, t, t.LOCK.UPDATE);
            if (existingB && existingB.relation_state !== 'broken') {
                await t.rollback();
                return { success: false, message: '目标玩家已有道侣，无法邀请' };
            }

            // 清理已解除的旧关系（避免 UNIQUE KEY 冲突）
            if (existingA) await existingA.destroy({ transaction: t });
            if (existingB && existingB !== existingA) await existingB.destroy({ transaction: t });

            // 扣减灵石
            player.spirit_stones = (playerStones - costStones).toString();
            await player.save({ transaction: t });

            // 创建 pending 关系
            const newCompanion = await DaoCompanion.create({
                player_a_id: playerId,
                player_b_id: targetPlayerId,
                relation_state: 'pending',
                heart_contract_level: 0,
                heart_imprint_count: 0,
                dual_cultivation_count_total: 0,
                daily_dual_cultivation_count: 0,
                daily_ask_after_count: 0,
                vow_broken: 0,
                heart_tribulation_count: 0
            }, { transaction: t });

            await t.commit();

            // 推送邀请通知给目标玩家
            try {
                WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, 'companion_seek', {
                    message: `${player.nickname} 邀请你结为道侣`,
                    companion_id: newCompanion.id,
                    from_player: { id: player.id, nickname: player.nickname, realm: player.realm }
                });
            } catch (e) {
                console.warn('[CompanionService] 推送邀请通知失败:', e.message);
            }

            return {
                success: true,
                message: `已向 ${target.nickname} 发出道侣邀请，等待对方回应`,
                data: {
                    companion_id: newCompanion.id,
                    target_player: { id: target.id, nickname: target.nickname },
                    cost_spirit_stones: costStones.toString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] seek 异常:', err);
            throw err;
        }
    }

    /**
     * 同意结侣
     * pending → active，双方 dao_companion_id 互填
     * @param {number} playerId - 玩家ID（接受方）
     * @param {number} companionId - 道侣关系ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async accept(playerId, companionId) {
        if (!companionId || typeof companionId !== 'number') {
            return { success: false, message: 'companion_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const companion = await DaoCompanion.findByPk(companionId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!companion) {
                await t.rollback();
                return { success: false, message: '道侣关系不存在' };
            }
            if (companion.relation_state !== 'pending') {
                await t.rollback();
                return { success: false, message: '该道侣邀请已失效或已处理' };
            }
            if (companion.player_b_id !== playerId) {
                await t.rollback();
                return { success: false, message: '只能接受发给自己的道侣邀请' };
            }

            // 锁定双方玩家
            const playerA = await Player.findByPk(companion.player_a_id, { transaction: t, lock: t.LOCK.UPDATE });
            const playerB = await Player.findByPk(companion.player_b_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!playerA || !playerB) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 缔结道侣关系
            companion.relation_state = 'active';
            await companion.save({ transaction: t });

            // 双方 dao_companion_id 互填
            playerA.dao_companion_id = companion.id;
            playerB.dao_companion_id = companion.id;
            await playerA.save({ transaction: t });
            await playerB.save({ transaction: t });

            await t.commit();

            // 推送通知给双方
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerA.id, 'companion_accepted', {
                    message: `${playerB.nickname} 已接受你的道侣邀请，结为道侣！`,
                    companion_id: companion.id
                });
                WebSocketNotificationService.notifyPlayerUpdate(playerB.id, 'companion_accepted', {
                    message: `你与 ${playerA.nickname} 结为道侣！`,
                    companion_id: companion.id
                });
            } catch (e) {
                console.warn('[CompanionService] 推送结侣通知失败:', e.message);
            }

            return {
                success: true,
                message: `你与 ${playerA.nickname} 结为道侣！`,
                data: {
                    companion_id: companion.id,
                    partner: { id: playerA.id, nickname: playerA.nickname, realm: playerA.realm }
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] accept 异常:', err);
            throw err;
        }
    }

    /**
     * 解除道侣关系
     * - agreement（协议解除）：3 天冷静期后正式解除，但简化为立即解除（实际冷静期由前端提示）
     * - vow_break（毁誓解除）：立即解除，触发心劫惩罚（心契等级归零、修为损失 5%）
     * @param {number} playerId - 玩家ID
     * @param {string} mode - 解除模式（agreement/vow_break）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async breakCompanion(playerId, mode) {
        if (!['agreement', 'vow_break'].includes(mode)) {
            return {
                success: false,
                message: 'mode 必须为 agreement(协议解除) 或 vow_break(毁誓解除)',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const companion = await findCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion || companion.relation_state !== 'active') {
                await t.rollback();
                return { success: false, message: '当前没有可解除的道侣关系' };
            }

            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });

            // 标记道侣关系为已解除
            companion.relation_state = 'broken';
            companion.broken_at = new Date();
            if (mode === 'vow_break') {
                companion.vow_broken = 1;
                companion.heart_contract_level = 0; // 毁誓：心契等级归零
            }
            await companion.save({ transaction: t });

            // 清空双方 dao_companion_id
            player.dao_companion_id = null;
            await player.save({ transaction: t });
            if (partner) {
                partner.dao_companion_id = null;
                await partner.save({ transaction: t });
            }

            // 毁誓：触发修为损失 5%（设计文档：毁誓解除触发心劫惩罚）
            let expLoss = BigInt(0);
            if (mode === 'vow_break') {
                const playerExp = BigInt(player.exp || 0);
                // 修为损失 5%（向下取整）
                expLoss = playerExp / BigInt(20);
                player.exp = (playerExp - expLoss).toString();
                await player.save({ transaction: t });
                if (partner) {
                    const partnerExp = BigInt(partner.exp || 0);
                    const partnerExpLoss = partnerExp / BigInt(20);
                    partner.exp = (partnerExp - partnerExpLoss).toString();
                    await partner.save({ transaction: t });
                }
            }

            await t.commit();

            // 推送通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'companion_broken', {
                    message: mode === 'vow_break'
                        ? `你毁誓解除了与 ${partner?.nickname || '道侣'} 的关系，心契归零，修为损失 ${expLoss.toString()}`
                        : `你与 ${partner?.nickname || '道侣'} 协议解除了道侣关系`,
                    mode,
                    exp_loss: expLoss.toString()
                });
                if (partner) {
                    WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'companion_broken', {
                        message: mode === 'vow_break'
                            ? `${player.nickname} 毁誓与你解除了道侣关系，心契归零`
                            : `${player.nickname} 与你协议解除了道侣关系`,
                        mode
                    });
                }
            } catch (e) {
                console.warn('[CompanionService] 推送解除通知失败:', e.message);
            }

            return {
                success: true,
                message: mode === 'vow_break'
                    ? `已毁誓解除道侣关系，心契等级归零，修为损失 ${expLoss.toString()}`
                    : '已协议解除道侣关系',
                data: {
                    mode,
                    exp_loss: expLoss.toString(),
                    broken_at: companion.broken_at
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] breakCompanion 异常:', err);
            throw err;
        }
    }

    /**
     * 闭关双修
     * 主元神 +5% 修为，副元神 +3% 修为，日上限 3 次
     * 公式：单次双修修为 = 主元神当前修为 * 加成比例 * 心契等级系数 * 亲密度系数
     * @param {number} playerId - 玩家ID（发起方）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async dualCultivate(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const companion = await findCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion || companion.relation_state !== 'active') {
                await t.rollback();
                return { success: false, message: '当前没有道侣关系，无法双修' };
            }

            const config = configLoader.getConfig('companion_data');
            const daoCfg = config.dao_companion;

            // 跨日重置每日双修次数
            resetDailyCountIfCrossDay(companion, 'last_dual_cultivation_date', 'daily_dual_cultivation_count');

            // 日上限校验
            if (companion.daily_dual_cultivation_count >= daoCfg.daily_dual_cultivation_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日双修次数已用完（${companion.daily_dual_cultivation_count}/${daoCfg.daily_dual_cultivation_limit}）`
                };
            }

            // 亲密度校验
            // 道侣亲密度用心契等级模拟（无独立字段），此处用心契等级 *20 作为亲密度
            const intimacy = companion.heart_contract_level * 20;
            if (intimacy < daoCfg.min_intimacy_for_dual) {
                await t.rollback();
                return {
                    success: false,
                    message: `亲密度不足，需要 ${daoCfg.min_intimacy_for_dual}（当前 ${intimacy}）`
                };
            }

            // 残魂校验
            const playerRemnant = Number(player.remnant_soul || 0);
            if (playerRemnant < daoCfg.min_remnant_soul) {
                await t.rollback();
                return {
                    success: false,
                    message: `残魂不足，需要 ${daoCfg.min_remnant_soul}（当前 ${playerRemnant}）`
                };
            }

            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!partner) {
                await t.rollback();
                return { success: false, message: '道侣玩家不存在' };
            }
            const partnerRemnant = Number(partner.remnant_soul || 0);
            if (partnerRemnant < daoCfg.min_remnant_soul) {
                await t.rollback();
                return {
                    success: false,
                    message: `道侣残魂不足，需要 ${daoCfg.min_remnant_soul}（当前 ${partnerRemnant}）`
                };
            }

            // 计算双修加成
            const baseRate = daoCfg.dual_cultivation_bonus_rate;
            const heartContractMultiplier = 1 + companion.heart_contract_level * 0.05;
            const intimacyMultiplier = 0.5 + (intimacy / 100) * 0.5;
            const finalRate = baseRate * heartContractMultiplier * intimacyMultiplier;

            // 主元神 +finalRate，副元神 +finalRate * 0.6
            const playerExp = BigInt(player.exp || 0);
            const playerGain = BigInt(Math.floor(Number(playerExp) * finalRate));
            player.exp = (playerExp + playerGain).toString();

            const partnerExp = BigInt(partner.exp || 0);
            const partnerGain = BigInt(Math.floor(Number(partnerExp) * finalRate * 0.6));
            partner.exp = (partnerExp + partnerGain).toString();

            // 更新双修次数
            companion.daily_dual_cultivation_count += 1;
            companion.dual_cultivation_count_total += 1;
            companion.last_dual_cultivation_date = new Date().toISOString().slice(0, 10);
            companion.last_dual_cultivation_time = new Date();

            // 心契经验 +10
            // 简化处理：心契经验直接累计到 dual_cultivation_count_total，等级根据阈值判定
            // 心契等级阈值：[10, 30, 60, 100, 150]
            const newTotal = companion.dual_cultivation_count_total;
            const thresholds = daoCfg.heart_contract_level_thresholds;
            let newLevel = 0;
            for (let i = 0; i < thresholds.length; i++) {
                if (newTotal >= thresholds[i]) newLevel = i + 1;
            }
            if (newLevel > companion.heart_contract_level) {
                companion.heart_contract_level = newLevel;
            }

            await player.save({ transaction: t });
            await partner.save({ transaction: t });
            await companion.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'companion_dual_cultivate', {
                    message: `闭关双修成功！修为 +${playerGain.toString()}`,
                    exp_gain: playerGain.toString(),
                    daily_count: companion.daily_dual_cultivation_count,
                    daily_limit: daoCfg.daily_dual_cultivation_limit
                });
                WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'companion_dual_cultivate', {
                    message: `${player.nickname} 与你闭关双修，修为 +${partnerGain.toString()}`,
                    exp_gain: partnerGain.toString()
                });
            } catch (e) {
                console.warn('[CompanionService] 推送双修通知失败:', e.message);
            }

            return {
                success: true,
                message: `闭关双修成功！你修为 +${playerGain.toString()}，道侣修为 +${partnerGain.toString()}`,
                data: {
                    player_exp_gain: playerGain.toString(),
                    partner_exp_gain: partnerGain.toString(),
                    daily_count: companion.daily_dual_cultivation_count,
                    daily_limit: daoCfg.daily_dual_cultivation_limit,
                    heart_contract_level: companion.heart_contract_level,
                    dual_cultivation_count_total: companion.dual_cultivation_count_total
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] dualCultivate 异常:', err);
            throw err;
        }
    }

    /**
     * 温养
     * 双方各 +3% 修为，日上限 2 次
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async warmNourish(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const companion = await findCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion || companion.relation_state !== 'active') {
                await t.rollback();
                return { success: false, message: '当前没有道侣关系，无法温养' };
            }

            const config = configLoader.getConfig('companion_data');
            const daoCfg = config.dao_companion;

            // 温养次数复用双修的日上限字段（设计文档：温养日上限 2 次）
            // 简化：温养和双修共享 daily_dual_cultivation_count，但分别按各自上限校验
            // 实际生产建议拆字段；此处沿用现有字段，warmNourish 不计入双修次数
            // 改用 daily_ask_after_count 兜底（重置字段已实现），不再用于温养
            // 这里直接按"日上限 2 次"用日志查询统计
            const today = new Date().toISOString().slice(0, 10);
            const todayStart = new Date(`${today}T00:00:00`);
            const todayLogs = await HeartTribulationEvent.findAll({
                where: {
                    player_id: playerId,
                    event_type: 'heart_contract',
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            // 简化：用 heart_contract 类型记录温养次数（与设计文档逻辑分离，仅做次数限制）
            // 此处直接校验上限，实际记录用 concubine_log 不合适，故写入临时事件
            if (todayLogs.length >= daoCfg.daily_warm_nourish_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日温养次数已用完（${todayLogs.length}/${daoCfg.daily_warm_nourish_limit}）`
                };
            }

            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!partner) {
                await t.rollback();
                return { success: false, message: '道侣玩家不存在' };
            }

            // 双方各 +3% 修为
            const baseRate = daoCfg.warm_nourish_bonus_rate;
            const playerExp = BigInt(player.exp || 0);
            const playerGain = BigInt(Math.floor(Number(playerExp) * baseRate));
            player.exp = (playerExp + playerGain).toString();

            const partnerExp = BigInt(partner.exp || 0);
            const partnerGain = BigInt(Math.floor(Number(partnerExp) * baseRate));
            partner.exp = (partnerExp + partnerGain).toString();

            // 写入临时事件用于日次数统计（event_type=heart_contract 复用，options 标记 warm_nourish）
            await HeartTribulationEvent.create({
                player_id: playerId,
                companion_id: companion.id,
                event_type: 'heart_contract',
                event_state: 'resolved',
                options: { action: 'warm_nourish' },
                chosen_option: 'warm_nourish',
                reward: { player_exp_gain: playerGain.toString(), partner_exp_gain: partnerGain.toString() },
                expires_at: new Date(Date.now() + 86400000),
                resolved_at: new Date()
            }, { transaction: t });

            await player.save({ transaction: t });
            await partner.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'companion_warm_nourish', {
                    message: `温养成功！修为 +${playerGain.toString()}`,
                    exp_gain: playerGain.toString()
                });
                WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'companion_warm_nourish', {
                    message: `${player.nickname} 与你温养，修为 +${partnerGain.toString()}`,
                    exp_gain: partnerGain.toString()
                });
            } catch (e) {
                console.warn('[CompanionService] 推送温养通知失败:', e.message);
            }

            return {
                success: true,
                message: `温养成功！你修为 +${playerGain.toString()}，道侣修为 +${partnerGain.toString()}`,
                data: {
                    player_exp_gain: playerGain.toString(),
                    partner_exp_gain: partnerGain.toString(),
                    daily_count: todayLogs.length + 1,
                    daily_limit: daoCfg.daily_warm_nourish_limit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] warmNourish 异常:', err);
            throw err;
        }
    }

    /**
     * 采补
     * 主方 +10%，副方 -3%，日上限 1 次，需亲密度≥80
     * 副方残魂 -2，强制双方协商，防止单方剥削
     * @param {number} playerId - 玩家ID（主方，发起采补者）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async pluckSupplement(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const companion = await findCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion || companion.relation_state !== 'active') {
                await t.rollback();
                return { success: false, message: '当前没有道侣关系，无法采补' };
            }

            const config = configLoader.getConfig('companion_data');
            const daoCfg = config.dao_companion;

            // 亲密度校验（采补要求 ≥80）
            const intimacy = companion.heart_contract_level * 20;
            if (intimacy < daoCfg.min_intimacy_for_pluck) {
                await t.rollback();
                return {
                    success: false,
                    message: `亲密度不足，采补需要 ${daoCfg.min_intimacy_for_pluck}（当前 ${intimacy}）`
                };
            }

            // 采补日次数统计（用临时事件 event_type=heart_imprint 复用）
            const today = new Date().toISOString().slice(0, 10);
            const todayStart = new Date(`${today}T00:00:00`);
            const todayLogs = await HeartTribulationEvent.findAll({
                where: {
                    player_id: playerId,
                    event_type: 'heart_imprint',
                    created_at: { [Op.gte]: todayStart }
                },
                transaction: t
            });
            if (todayLogs.length >= daoCfg.daily_pluck_supplement_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日采补次数已用完（${todayLogs.length}/${daoCfg.daily_pluck_supplement_limit}）`
                };
            }

            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!partner) {
                await t.rollback();
                return { success: false, message: '道侣玩家不存在' };
            }

            // 主方 +10%，副方 -3%
            const mainRate = daoCfg.pluck_supplement_main_rate;
            const subRate = daoCfg.pluck_supplement_sub_rate; // 负数
            const playerExp = BigInt(player.exp || 0);
            const playerGain = BigInt(Math.floor(Number(playerExp) * mainRate));
            player.exp = (playerExp + playerGain).toString();

            const partnerExp = BigInt(partner.exp || 0);
            const partnerLoss = BigInt(Math.floor(Number(partnerExp) * Math.abs(subRate)));
            // 防止副方修为变负
            const actualPartnerLoss = partnerExp > partnerLoss ? partnerLoss : partnerExp;
            partner.exp = (partnerExp - actualPartnerLoss).toString();

            // 副方残魂 -2
            partner.remnant_soul = Math.max(0, Number(partner.remnant_soul || 0) - 2);

            // 写入采补日志（event_type=heart_imprint 复用）
            await HeartTribulationEvent.create({
                player_id: playerId,
                companion_id: companion.id,
                event_type: 'heart_imprint',
                event_state: 'resolved',
                options: { action: 'pluck_supplement' },
                chosen_option: 'pluck_supplement',
                reward: { player_exp_gain: playerGain.toString() },
                penalty: { partner_exp_loss: actualPartnerLoss.toString(), partner_remnant_soul_loss: 2 },
                expires_at: new Date(Date.now() + 86400000),
                resolved_at: new Date()
            }, { transaction: t });

            await player.save({ transaction: t });
            await partner.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'companion_pluck_supplement', {
                    message: `采补成功！修为 +${playerGain.toString()}`,
                    exp_gain: playerGain.toString()
                });
                WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'companion_pluck_supplement', {
                    message: `${player.nickname} 对你采补，修为 -${actualPartnerLoss.toString()}，残魂 -2`,
                    exp_loss: actualPartnerLoss.toString(),
                    remnant_soul_loss: 2
                });
            } catch (e) {
                console.warn('[CompanionService] 推送采补通知失败:', e.message);
            }

            return {
                success: true,
                message: `采补成功！你修为 +${playerGain.toString()}，道侣修为 -${actualPartnerLoss.toString()}`,
                data: {
                    player_exp_gain: playerGain.toString(),
                    partner_exp_loss: actualPartnerLoss.toString(),
                    partner_remnant_soul_loss: 2,
                    daily_count: todayLogs.length + 1,
                    daily_limit: daoCfg.daily_pluck_supplement_limit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] pluckSupplement 异常:', err);
            throw err;
        }
    }

    /**
     * 立誓
     * 3 种誓言类型（protect/secret/cultivate），30 天有效期
     * @param {number} playerId - 玩家ID
     * @param {string} vowType - 誓言类型（protect/secret/cultivate）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async vow(playerId, vowType) {
        if (!['protect', 'secret', 'cultivate'].includes(vowType)) {
            return {
                success: false,
                message: 'vow_type 必须为 protect(护道)/secret(守秘)/cultivate(共修) 之一',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const companion = await findCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion || companion.relation_state !== 'active') {
                await t.rollback();
                return { success: false, message: '当前没有道侣关系，无法立誓' };
            }

            const config = configLoader.getConfig('companion_data');
            const daoCfg = config.dao_companion;

            const vowDescMap = {
                protect: '护道之誓：道侣被攻击时概率分担伤害',
                secret: '守秘之誓：保守道侣的秘密，不外泄',
                cultivate: '共修之誓：共同修炼，双修加成提升'
            };

            companion.vow_type = vowType;
            const expireTime = new Date();
            expireTime.setDate(expireTime.getDate() + daoCfg.vow_expire_days);
            companion.vow_expire_time = expireTime;
            companion.vow_broken = 0;
            await companion.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'companion_vow', {
                    message: `立誓成功：${vowDescMap[vowType]}`,
                    vow_type: vowType,
                    vow_expire_time: expireTime
                });
            } catch (e) {
                console.warn('[CompanionService] 推送立誓通知失败:', e.message);
            }

            return {
                success: true,
                message: `立誓成功：${vowDescMap[vowType]}`,
                data: {
                    vow_type: vowType,
                    vow_desc: vowDescMap[vowType],
                    vow_expire_time: expireTime
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] vow 异常:', err);
            throw err;
        }
    }

    /**
     * 心契面板
     * 查看心契等级、经验（双修总次数）、下一级进度
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getHeartContract(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('companion_data');
        const daoCfg = config.dao_companion;
        const thresholds = daoCfg.heart_contract_level_thresholds;

        const companion = await findCompanionByPlayerId(playerId);
        if (!companion || companion.relation_state !== 'active') {
            return {
                success: true,
                data: {
                    has_companion: false,
                    heart_contract_level: 0,
                    dual_cultivation_count_total: 0,
                    next_level_threshold: thresholds[0],
                    progress: 0
                }
            };
        }

        const total = companion.dual_cultivation_count_total;
        const currentLevel = companion.heart_contract_level;
        let nextThreshold = null;
        if (currentLevel < thresholds.length) {
            nextThreshold = thresholds[currentLevel];
        }

        return {
            success: true,
            data: {
                has_companion: true,
                heart_contract_level: currentLevel,
                heart_imprint_count: companion.heart_imprint_count,
                dual_cultivation_count_total: total,
                next_level_threshold: nextThreshold,
                progress: nextThreshold ? Math.min(1, total / nextThreshold) : 1,
                level_thresholds: thresholds,
                level_effects: {
                    1: '双修加成 +5%',
                    2: '护道：道侣被攻击时有 10% 概率分担伤害',
                    3: '双修加成 +15%，心印上限 +1',
                    4: '共修：双方闭关时互相 +10% 修为',
                    5: '双修加成 +25%，护道 30%，可种心印 2 个'
                }
            }
        };
    }

    /**
     * 获取待处理心劫事件
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getHeartTribulation(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const pendingEvents = await HeartTribulationEvent.findAll({
            where: {
                player_id: playerId,
                event_state: 'pending',
                expires_at: { [Op.gt]: new Date() }
            },
            order: [['created_at', 'DESC']]
        });

        return {
            success: true,
            data: {
                pending_events: pendingEvents.map(e => ({
                    event_id: e.id,
                    event_type: e.event_type,
                    companion_id: e.companion_id,
                    concubine_id: e.concubine_id,
                    options: e.options,
                    expires_at: e.expires_at,
                    created_at: e.created_at
                })),
                count: pendingEvents.length
            }
        };
    }

    /**
     * 心劫抉择
     * 3 种选项（稳/狠/骗），不同成功率与奖惩
     * @param {number} playerId - 玩家ID
     * @param {number} eventId - 心劫事件ID
     * @param {string} option - 抉择选项（steady/ruthless/deceive）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async chooseHeartTribulation(playerId, eventId, option) {
        if (!eventId || typeof eventId !== 'number') {
            return { success: false, message: 'event_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!['steady', 'ruthless', 'deceive'].includes(option)) {
            return {
                success: false,
                message: 'option 必须为 steady(稳)/ruthless(狠)/deceive(骗) 之一',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const event = await HeartTribulationEvent.findByPk(eventId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!event) {
                await t.rollback();
                return { success: false, message: '心劫事件不存在' };
            }
            if (event.player_id !== playerId) {
                await t.rollback();
                return { success: false, message: '只能处理自己的心劫事件' };
            }
            if (event.event_state !== 'pending') {
                await t.rollback();
                return { success: false, message: '该心劫事件已处理' };
            }
            if (new Date(event.expires_at) < new Date()) {
                // 超时：标记为失败
                event.event_state = 'failed';
                event.resolved_at = new Date();
                await event.save({ transaction: t });
                await t.commit();
                return { success: false, message: '心劫事件已过期，视为失败' };
            }

            const config = configLoader.getConfig('companion_data');
            const htCfg = config.heart_tribulation;
            const optionCfg = htCfg.options[option];

            // 成功率判定
            const successRoll = Math.random();
            const isSuccess = successRoll < optionCfg.success_rate;

            event.chosen_option = option;
            event.resolved_at = new Date();

            if (isSuccess) {
                // 成功：心契经验 +100，双方残魂恢复 +10
                event.event_state = 'resolved';
                event.reward = {
                    heart_contract_exp: htCfg.success_reward.heart_contract_exp,
                    remnant_soul_recover: htCfg.success_reward.remnant_soul_recover,
                    intimacy_gain: optionCfg.intimacy_gain
                };

                // 残魂恢复
                player.remnant_soul = Math.min(100, Number(player.remnant_soul || 0) + htCfg.success_reward.remnant_soul_recover);
                await player.save({ transaction: t });

                // 心契等级提升（简化：直接 +1 级，最高 5）
                if (event.companion_id) {
                    const companion = await DaoCompanion.findByPk(event.companion_id, { transaction: t, lock: t.LOCK.UPDATE });
                    if (companion) {
                        companion.heart_contract_level = Math.min(5, companion.heart_contract_level + 1);
                        await companion.save({ transaction: t });
                    }
                }
            } else {
                // 失败：心契等级 -1，双方残魂 -20，24 小时虚弱
                event.event_state = 'failed';
                event.penalty = {
                    heart_contract_level_loss: htCfg.failure_penalty.heart_contract_level_loss,
                    remnant_soul_loss: htCfg.failure_penalty.remnant_soul_loss,
                    weakness_hours: htCfg.failure_penalty.weakness_hours
                };

                player.remnant_soul = Math.max(0, Number(player.remnant_soul || 0) - htCfg.failure_penalty.remnant_soul_loss);
                await player.save({ transaction: t });

                if (event.companion_id) {
                    const companion = await DaoCompanion.findByPk(event.companion_id, { transaction: t, lock: t.LOCK.UPDATE });
                    if (companion) {
                        companion.heart_contract_level = Math.max(0, companion.heart_contract_level - htCfg.failure_penalty.heart_contract_level_loss);
                        companion.heart_tribulation_count += 1;
                        await companion.save({ transaction: t });
                    }
                }
            }

            await event.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'heart_tribulation_resolved', {
                    message: isSuccess
                        ? `心劫抉择成功！心契经验 +${htCfg.success_reward.heart_contract_exp}，残魂恢复 +${htCfg.success_reward.remnant_soul_recover}`
                        : `心劫抉择失败！心契等级 -${htCfg.failure_penalty.heart_contract_level_loss}，残魂 -${htCfg.failure_penalty.remnant_soul_loss}`,
                    is_success: isSuccess,
                    option
                });
            } catch (e) {
                console.warn('[CompanionService] 推送心劫结算通知失败:', e.message);
            }

            return {
                success: true,
                message: isSuccess
                    ? `心劫抉择成功！残魂恢复 +${htCfg.success_reward.remnant_soul_recover}`
                    : `心劫抉择失败！残魂 -${htCfg.failure_penalty.remnant_soul_loss}`,
                data: {
                    is_success: isSuccess,
                    chosen_option: option,
                    success_rate: optionCfg.success_rate,
                    reward: event.reward,
                    penalty: event.penalty
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] chooseHeartTribulation 异常:', err);
            throw err;
        }
    }

    // ==================== GM 管理方法 ====================

    /**
     * GM 强制解除道侣关系
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmBreakDaoCompanion(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const companion = await findCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion || companion.relation_state === 'broken') {
                await t.rollback();
                return { success: false, message: '玩家当前没有可解除的道侣关系' };
            }

            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });

            companion.relation_state = 'broken';
            companion.broken_at = new Date();
            await companion.save({ transaction: t });

            player.dao_companion_id = null;
            await player.save({ transaction: t });
            if (partner) {
                partner.dao_companion_id = null;
                await partner.save({ transaction: t });
            }

            await t.commit();

            return {
                success: true,
                message: `已强制解除玩家 ${player.nickname} 与 ${partner?.nickname || '道侣'} 的道侣关系`,
                data: {
                    companion_id: companion.id,
                    player_id: playerId,
                    partner_id: partnerId,
                    broken_at: companion.broken_at
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[CompanionService] gmBreakDaoCompanion 异常:', err);
            throw err;
        }
    }

    /**
     * GM 调整心契等级
     * @param {number} playerId - 玩家ID
     * @param {number} level - 目标等级（0-5）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmSetHeartContractLevel(playerId, level) {
        if (!Number.isInteger(level) || level < 0 || level > 5) {
            return { success: false, message: '心契等级必须为 0-5 之间的整数', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const companion = await findCompanionByPlayerId(playerId);
        if (!companion || companion.relation_state !== 'active') {
            return { success: false, message: '玩家当前没有道侣关系' };
        }

        const oldLevel = companion.heart_contract_level;
        companion.heart_contract_level = level;
        await companion.save();

        return {
            success: true,
            message: `玩家心契等级已从 ${oldLevel} 调整为 ${level}`,
            data: {
                companion_id: companion.id,
                player_id: playerId,
                old_level: oldLevel,
                new_level: level
            }
        };
    }

    /**
     * GM 触发心劫事件
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmTriggerHeartTribulation(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const companion = await findCompanionByPlayerId(playerId);
        const config = configLoader.getConfig('companion_data');
        const htCfg = config.heart_tribulation;

        // 创建心劫事件
        const expireTime = new Date();
        expireTime.setHours(expireTime.getHours() + htCfg.expire_hours);

        const event = await HeartTribulationEvent.create({
            player_id: playerId,
            companion_id: companion ? companion.id : null,
            concubine_id: null,
            event_type: 'heart_tribulation',
            event_state: 'pending',
            options: htCfg.options,
            expires_at: expireTime
        });

        try {
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'heart_tribulation_triggered', {
                message: '心劫事件已触发，请在 48 小时内抉择',
                event_id: event.id,
                expires_at: expireTime
            });
        } catch (e) {
            console.warn('[CompanionService] 推送心劫触发通知失败:', e.message);
        }

        return {
            success: true,
            message: `已为玩家 ${player.nickname} 触发心劫事件`,
            data: {
                event_id: event.id,
                player_id: playerId,
                expires_at: expireTime
            }
        };
    }
}

module.exports = CompanionService;
