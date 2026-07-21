/**
 * 道侣/双修系统服务（玩家间 1v1 长期社交玩法）
 *
 * 实现 10 个核心方法：
 *   1. propose（求婚）：创建 pending 记录，校验境界/活跃道侣/求婚上限
 *   2. respond（响应求婚）：accept/refuse，accept 时亲密度+10 初始值
 *   3. getMyCompanion（我的道侣信息）：返回道侣详情 + 对方玩家信息 + 双修加成比例
 *   4. interact（道侣互动）：每日1次，亲密度+2，双方各获得少量修为
 *   5. dualCultivate（双修）：双方在线校验 + 状态机校验 + 收益结算
 *   6. breakCompanion（解除道侣）：单方面解除，亲密度-20，7天冷却期
 *   7. getProposals（我收到的求婚列表）：返回 pending 状态的求婚
 *   8. respondHeartTribulation（心劫抉择）：信任/怀疑/考验，影响亲密度和心契
 *   9. getHeartTribulationStatus（心劫状态）：返回当前是否有 pending 心劫
 *  10. condenseHeartImprint（凝聚心印）：亲密度>=80时凝聚，消耗双方修为
 *
 * 设计原则：
 *   - 所有阈值/比例从 dao_companion_data.json 配置读取，禁止硬编码
 *   - 关键操作使用事务 + LOCK.UPDATE 行级锁
 *   - BigInt 字段（exp/spirit_stones）序列化时 toString()
 *   - 关键事件通过 WebSocketNotificationService 推送
 *   - 调用 PlayerStateMachine.canStart 检查状态互斥
 *   - 心劫事件复用 HeartTribulationEvent 模型（event_type='dao_heart_tribulation'）
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/exp/realm/realm_rank）
 *   - DaoCompanions: 道侣关系表（player_a_id/player_b_id/status/intimacy/heart_contract_level）
 *   - HeartTribulationEvent: 心劫事件表（复用，event_type 标记来源）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const DaoCompanions = require('../../models/daoCompanions');
const DaoCompanionProtectLog = require('../../models/daoCompanionProtectLog');
const HeartTribulationEvent = require('../../models/heartTribulationEvent');
const sequelize = require('../../config/database');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const { ErrorCodes } = require('../../middleware/errorHandler');
const { Op } = require('sequelize');

/**
 * 工具函数：获取道侣护道配置（heart_contract_protect 节）
 * @returns {Object} 护道配置对象
 */
function getProtectConfig() {
    const config = configLoader.getConfig('dao_companion_data');
    return config?.heart_contract_protect || {};
}

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined 返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    return BigInt(String(value));
}

/**
 * 工具函数：获取道侣系统配置
 * @returns {Object} 道侣系统配置 settings 节
 */
function getDaoCompanionConfig() {
    const config = configLoader.getConfig('dao_companion_data');
    return config?.settings || {};
}

/**
 * 工具函数：根据玩家ID查找其活跃道侣关系（无论作为 A 还是 B）
 * 仅返回 status='accepted' 的关系
 * @param {number} playerId - 玩家ID
 * @param {Object} [transaction] - 事务对象（可选）
 * @param {Object} [lock] - 锁对象（可选）
 * @returns {Promise<Object|null>} 道侣关系对象或 null
 */
async function findActiveCompanionByPlayerId(playerId, transaction = null, lock = null) {
    const options = {
        where: {
            status: 'accepted',
            [Op.or]: [{ player_a_id: playerId }, { player_b_id: playerId }]
        }
    };
    if (transaction) options.transaction = transaction;
    if (lock) options.lock = lock;
    return await DaoCompanions.findOne(options);
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

/**
 * 工具函数：获取境界加成倍率
 * 公式：1.0 + (realm.rank - 1) * 0.1
 * @param {string} realmName - 玩家境界名称
 * @returns {number} 境界加成倍率
 */
function getRealmMultiplier(realmName) {
    try {
        const realm = RealmService.getRealmByName(realmName);
        if (realm && realm.rank) {
            return 1.0 + (realm.rank - 1) * 0.1;
        }
    } catch (err) {
        console.error('[DaoCompanionService] 获取境界加成失败:', err.message);
    }
    return 1.0;
}

/**
 * 工具函数：计算双修加成比例
 * 公式：dual_cultivation_exp_multiplier × (1 + intimacy/200) × (1 + heart_contract_level × heart_contract_level_bonus_rate)
 * @param {Object} companion - 道侣关系对象
 * @param {Object} cfg - 配置 settings 节
 * @returns {number} 双修加成比例
 */
function calcDualCultivationBonus(companion, cfg) {
    const baseMultiplier = cfg.dual_cultivation_exp_multiplier || 1.5;
    const intimacyFactor = 1 + (companion.intimacy || 0) / 200;
    const heartContractFactor = 1 + (companion.heart_contract_level || 0) * (cfg.heart_contract_level_bonus_rate || 0.05);
    return baseMultiplier * intimacyFactor * heartContractFactor;
}

class DaoCompanionService {
    /**
     * 1. 求婚
     * 创建 pending 状态的 dao_companions 记录，校验境界/活跃道侣/求婚上限
     * @param {number} playerId - 求婚方玩家ID
     * @param {number} targetPlayerId - 被求婚方玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async propose(playerId, targetPlayerId) {
        // 参数校验
        if (!targetPlayerId || typeof targetPlayerId !== 'number') {
            return { success: false, message: 'target_player_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (targetPlayerId === playerId) {
            return { success: false, message: '不能与自己结为道侣', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const cfg = getDaoCompanionConfig();
        const t = await sequelize.transaction();
        try {
            // 锁定求婚方玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 境界校验：
            //   优先读 player.realm_rank（突破时同步更新，迁移脚本 0038 已修复存量数据）
            //   兜底通过 RealmService.getRealmByName(player.realm).rank 获取
            //   双重保险，避免 realm_rank 字段未同步导致境界判断错误
            let playerRank = Number(player.realm_rank || 0);
            if (!playerRank && player.realm) {
                const realmData = RealmService.getRealmByName(player.realm);
                if (realmData?.rank) {
                    playerRank = realmData.rank;
                }
            }
            const minRank = cfg.min_realm_rank || 15;
            if (playerRank < minRank) {
                await t.rollback();
                return {
                    success: false,
                    message: `境界不足，需达到 rank ${minRank}（${cfg.min_realm_name || '结丹期'}）才能求婚，当前 rank ${playerRank}`
                };
            }

            // 校验求婚方是否已有活跃道侣
            const existingActive = await findActiveCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (existingActive) {
                await t.rollback();
                return { success: false, message: '您已有道侣，无法再次求婚' };
            }

            // 校验求婚方外发 pending 求婚数量（最多1个）
            const outgoingPending = await DaoCompanions.count({
                where: { player_a_id: playerId, status: 'pending' },
                transaction: t
            });
            const maxOutgoing = cfg.max_outgoing_pending_per_player || 1;
            if (outgoingPending >= maxOutgoing) {
                await t.rollback();
                return {
                    success: false,
                    message: `您已有 ${outgoingPending} 个外发求婚待响应，需先等待对方处理或撤销`
                };
            }

            // 校验是否在解除冷却期内
            const cooldownDays = cfg.break_re_propose_cooldown_days || 7;
            const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
            const recentBroken = await DaoCompanions.findOne({
                where: {
                    [Op.or]: [{ player_a_id: playerId }, { player_b_id: playerId }],
                    status: 'broken',
                    broken_at: { [Op.gte]: new Date(Date.now() - cooldownMs) }
                },
                transaction: t
            });
            if (recentBroken) {
                await t.rollback();
                return {
                    success: false,
                    message: `解除道侣后 ${cooldownDays} 天内不能再次求婚，请耐心等待`
                };
            }

            // 校验目标玩家
            const target = await Player.findByPk(targetPlayerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!target) {
                await t.rollback();
                return { success: false, message: '目标玩家不存在' };
            }
            // 目标玩家境界校验（同样使用双重保险）
            let targetRank = Number(target.realm_rank || 0);
            if (!targetRank && target.realm) {
                const targetRealmData = RealmService.getRealmByName(target.realm);
                if (targetRealmData?.rank) {
                    targetRank = targetRealmData.rank;
                }
            }
            if (targetRank < minRank) {
                await t.rollback();
                return {
                    success: false,
                    message: `目标玩家境界不足，需达到 rank ${minRank}（${cfg.min_realm_name || '结丹期'}），当前 rank ${targetRank}`
                };
            }

            // 校验目标玩家是否已有活跃道侣
            const targetExisting = await findActiveCompanionByPlayerId(targetPlayerId, t, t.LOCK.UPDATE);
            if (targetExisting) {
                await t.rollback();
                return { success: false, message: '目标玩家已有道侣，无法求婚' };
            }

            // 校验目标玩家收到的 pending 求婚数量（最多3个）
            const incomingPending = await DaoCompanions.count({
                where: { player_b_id: targetPlayerId, status: 'pending' },
                transaction: t
            });
            const maxIncoming = cfg.max_pending_proposals_per_receiver || 3;
            if (incomingPending >= maxIncoming) {
                await t.rollback();
                return {
                    success: false,
                    message: `目标玩家待处理求婚已满（${maxIncoming} 个），请稍后再试`
                };
            }

            // 校验是否已经向该玩家发过 pending 求婚（防重复）
            const duplicateProposal = await DaoCompanions.findOne({
                where: {
                    player_a_id: playerId,
                    player_b_id: targetPlayerId,
                    status: 'pending'
                },
                transaction: t
            });
            if (duplicateProposal) {
                await t.rollback();
                return { success: false, message: '您已向该玩家发过求婚，请等待对方处理' };
            }

            // 创建 pending 求婚记录
            const newProposal = await DaoCompanions.create({
                player_a_id: playerId,
                player_b_id: targetPlayerId,
                status: 'pending',
                intimacy: 0,
                dual_cultivation_count: 0,
                heart_contract_level: 0,
                heart_imprint_count: 0
            }, { transaction: t });

            await t.commit();

            // WebSocket 推送给目标玩家
            try {
                WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, 'dao_companion.proposal_received', {
                    message: `${player.nickname} 向你发出道侣求婚，请回应`,
                    proposal_id: newProposal.id,
                    from_player: {
                        id: player.id,
                        nickname: player.nickname,
                        realm: player.realm,
                        realm_rank: playerRank
                    }
                });
            } catch (e) {
                console.warn('[DaoCompanionService] 推送求婚通知失败:', e.message);
            }

            return {
                success: true,
                message: `已向 ${target.nickname} 发出道侣求婚，等待对方回应`,
                data: {
                    proposal_id: newProposal.id,
                    target_player: { id: target.id, nickname: target.nickname, realm: target.realm },
                    created_at: newProposal.created_at
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] propose 异常:', err);
            throw err;
        }
    }

    /**
     * 2. 响应求婚
     * accept: status → accepted，亲密度+初始值
     * refuse: status → refused
     * @param {number} playerId - 响应方玩家ID
     * @param {number} proposalId - 求婚记录ID
     * @param {string} action - 动作：accept 或 refuse
     * @returns {Promise<Object>} { success, message, data }
     */
    static async respond(playerId, proposalId, action) {
        // 参数校验
        if (!proposalId || typeof proposalId !== 'number') {
            return { success: false, message: 'proposal_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!['accept', 'refuse'].includes(action)) {
            return { success: false, message: 'action 必须为 accept 或 refuse', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const cfg = getDaoCompanionConfig();
        const t = await sequelize.transaction();
        try {
            // 锁定求婚记录
            const proposal = await DaoCompanions.findByPk(proposalId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!proposal) {
                await t.rollback();
                return { success: false, message: '求婚记录不存在' };
            }
            if (proposal.status !== 'pending') {
                await t.rollback();
                return { success: false, message: '该求婚已处理，无法重复响应' };
            }
            if (proposal.player_b_id !== playerId) {
                await t.rollback();
                return { success: false, message: '只能响应发给自己的求婚' };
            }

            // 锁定双方玩家
            const playerA = await Player.findByPk(proposal.player_a_id, { transaction: t, lock: t.LOCK.UPDATE });
            const playerB = await Player.findByPk(proposal.player_b_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!playerA || !playerB) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            if (action === 'accept') {
                // 接受求婚前再次校验双方都没有活跃道侣（防并发）
                const aActive = await findActiveCompanionByPlayerId(playerA.id, t, t.LOCK.UPDATE);
                const bActive = await findActiveCompanionByPlayerId(playerB.id, t, t.LOCK.UPDATE);
                if (aActive || bActive) {
                    await t.rollback();
                    return { success: false, message: '双方中已有人缔结道侣，无法接受' };
                }

                // 更新求婚状态为 accepted，设置初始亲密度
                proposal.status = 'accepted';
                proposal.intimacy = cfg.propose_initial_intimacy || 10;
                await proposal.save({ transaction: t });

                // 同时拒绝其他 pending 求婚（双方各自的）
                await DaoCompanions.update(
                    { status: 'refused' },
                    {
                        where: {
                            status: 'pending',
                            [Op.or]: [
                                { player_a_id: playerA.id },
                                { player_a_id: playerB.id },
                                { player_b_id: playerA.id },
                                { player_b_id: playerB.id }
                            ],
                            id: { [Op.ne]: proposal.id }
                        },
                        transaction: t
                    }
                );

                await t.commit();

                // 推送通知给双方
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerA.id, 'dao_companion.proposal_responded', {
                        message: `${playerB.nickname} 接受了你的道侣求婚，结为道侣！`,
                        action: 'accept',
                        companion_id: proposal.id,
                        partner: { id: playerB.id, nickname: playerB.nickname, realm: playerB.realm }
                    });
                    WebSocketNotificationService.notifyPlayerUpdate(playerB.id, 'dao_companion.proposal_responded', {
                        message: `你与 ${playerA.nickname} 结为道侣！`,
                        action: 'accept',
                        companion_id: proposal.id,
                        partner: { id: playerA.id, nickname: playerA.nickname, realm: playerA.realm }
                    });
                } catch (e) {
                    console.warn('[DaoCompanionService] 推送响应通知失败:', e.message);
                }

                return {
                    success: true,
                    message: `你与 ${playerA.nickname} 结为道侣！初始亲密度 ${proposal.intimacy}`,
                    data: {
                        companion_id: proposal.id,
                        partner: { id: playerA.id, nickname: playerA.nickname, realm: playerA.realm },
                        intimacy: proposal.intimacy
                    }
                };
            } else {
                // refuse：标记为 refused
                proposal.status = 'refused';
                await proposal.save({ transaction: t });

                await t.commit();

                // 推送通知给求婚方
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerA.id, 'dao_companion.proposal_responded', {
                        message: `${playerB.nickname} 婉拒了你的道侣求婚`,
                        action: 'refuse',
                        companion_id: proposal.id
                    });
                } catch (e) {
                    console.warn('[DaoCompanionService] 推送拒绝通知失败:', e.message);
                }

                return {
                    success: true,
                    message: `已拒绝 ${playerA.nickname} 的道侣求婚`,
                    data: { companion_id: proposal.id, action: 'refuse' }
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] respond 异常:', err);
            throw err;
        }
    }

    /**
     * 3. 获取我的道侣信息
     * 返回道侣关系详情 + 对方玩家基本信息 + 双修加成比例
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getMyCompanion(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const cfg = getDaoCompanionConfig();

        // 查询玩家活跃道侣关系
        const companion = await findActiveCompanionByPlayerId(playerId);
        if (!companion) {
            // 双重保险获取 rank（与 propose 方法保持一致）
            let currentRank = Number(player.realm_rank || 0);
            if (!currentRank && player.realm) {
                const realmData = RealmService.getRealmByName(player.realm);
                if (realmData?.rank) {
                    currentRank = realmData.rank;
                }
            }
            return {
                success: true,
                data: {
                    has_companion: false,
                    min_realm_rank: cfg.min_realm_rank || 15,
                    min_realm_name: cfg.min_realm_name || '结丹期',
                    can_propose: currentRank >= (cfg.min_realm_rank || 15),
                    current_realm_rank: currentRank
                }
            };
        }

        // 获取对方玩家信息
        const partnerId = getPartnerId(companion, playerId);
        const partner = await Player.findByPk(partnerId);
        const dualCultivationBonus = calcDualCultivationBonus(companion, cfg);

        // 计算互动冷却剩余
        const interactCooldownSec = cfg.daily_interact_cooldown_seconds || 86400;
        const interactRemainingSec = companion.last_interaction_time
            ? Math.max(0, interactCooldownSec - Math.floor((Date.now() - new Date(companion.last_interaction_time).getTime()) / 1000))
            : 0;

        // 计算双修冷却剩余
        const dualCooldownSec = cfg.dual_cultivation_cooldown_seconds || 86400;
        const dualRemainingSec = companion.last_dual_cultivation_time
            ? Math.max(0, dualCooldownSec - Math.floor((Date.now() - new Date(companion.last_dual_cultivation_time).getTime()) / 1000))
            : 0;

        return {
            success: true,
            data: {
                has_companion: true,
                companion_id: companion.id,
                partner: partner ? {
                    id: partner.id,
                    nickname: partner.nickname,
                    realm: partner.realm,
                    realm_rank: Number(partner.realm_rank || 0),
                    is_online: WebSocketNotificationService.isPlayerOnline(partner.id)
                } : null,
                status: companion.status,
                intimacy: companion.intimacy,
                heart_contract_level: companion.heart_contract_level,
                heart_imprint_count: companion.heart_imprint_count,
                dual_cultivation_count: companion.dual_cultivation_count,
                dual_cultivation_bonus_rate: dualCultivationBonus,
                interact_cooldown_remaining: interactRemainingSec,
                dual_cultivation_cooldown_remaining: dualRemainingSec,
                last_interaction_time: companion.last_interaction_time,
                last_dual_cultivation_time: companion.last_dual_cultivation_time,
                created_at: companion.created_at,
                // 配置参数透传（前端展示用）
                settings: {
                    min_intimacy_for_heart_tribulation: cfg.min_intimacy_for_heart_tribulation,
                    min_intimacy_for_heart_imprint: cfg.min_intimacy_for_heart_imprint,
                    heart_imprint_exp_cost: cfg.heart_imprint_exp_cost,
                    heart_imprint_count_per_level: cfg.heart_imprint_count_per_level,
                    max_heart_contract_level: cfg.max_heart_contract_level
                }
            }
        };
    }

    /**
     * 4. 道侣互动（每日问安/灵力反哺）
     * 每日1次，亲密度+2，双方各获得少量修为（base_exp_rate × 30 × realmMultiplier）
     * 24小时冷却
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async interact(playerId) {
        const cfg = getDaoCompanionConfig();
        const t = await sequelize.transaction();
        try {
            // 锁定玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 锁定道侣关系
            const companion = await findActiveCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion) {
                await t.rollback();
                return { success: false, message: '当前没有道侣，无法互动' };
            }

            // 校验互动冷却
            const cooldownSec = cfg.daily_interact_cooldown_seconds || 86400;
            if (companion.last_interaction_time) {
                const lastTime = new Date(companion.last_interaction_time).getTime();
                const elapsedSec = Math.floor((Date.now() - lastTime) / 1000);
                if (elapsedSec < cooldownSec) {
                    await t.rollback();
                    const remaining = cooldownSec - elapsedSec;
                    return {
                        success: false,
                        message: `互动冷却中，剩余 ${remaining} 秒（约 ${Math.ceil(remaining / 3600)} 小时）`
                    };
                }
            }

            // 锁定对方玩家
            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!partner) {
                await t.rollback();
                return { success: false, message: '道侣玩家不存在' };
            }

            // 计算互动修为收益：base_exp_rate × 30 × realmMultiplier
            // base_exp_rate 取自 seclusion 配置（与闭关一致）
            let baseExpRate = 1;
            try {
                const seclusionConfig = configLoader.getConfig('seclusion');
                baseExpRate = parseFloat(seclusionConfig?.settings?.seclusion_exp_rate?.value) || 1;
            } catch (e) { /* 配置缺失时使用默认值 */ }

            const interactExpSeconds = cfg.interact_exp_seconds_equivalent || 30;
            const playerRealmMult = getRealmMultiplier(player.realm);
            const partnerRealmMult = getRealmMultiplier(partner.realm);
            const playerExpGain = BigInt(Math.floor(interactExpSeconds * baseExpRate * playerRealmMult));
            const partnerExpGain = BigInt(Math.floor(interactExpSeconds * baseExpRate * partnerRealmMult));

            // 增加修为
            player.exp = (BigInt(player.exp || 0) + playerExpGain).toString();
            partner.exp = (BigInt(partner.exp || 0) + partnerExpGain).toString();

            // 增加亲密度
            const intimacyBonus = cfg.interact_intimacy_bonus || 2;
            companion.intimacy = Math.min(100, (companion.intimacy || 0) + intimacyBonus);
            companion.last_interaction_time = new Date();

            await player.save({ transaction: t });
            await partner.save({ transaction: t });
            await companion.save({ transaction: t });

            await t.commit();

            // 推送通知给双方
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'dao_companion.interact_completed', {
                    message: `道侣互动成功！亲密度 +${intimacyBonus}，修为 +${playerExpGain.toString()}`,
                    intimacy_gain: intimacyBonus,
                    exp_gain: playerExpGain.toString(),
                    new_intimacy: companion.intimacy
                });
                WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'dao_companion.interact_completed', {
                    message: `${player.nickname} 与你道侣互动，你获得修为 +${partnerExpGain.toString()}`,
                    exp_gain: partnerExpGain.toString()
                });
            } catch (e) {
                console.warn('[DaoCompanionService] 推送互动通知失败:', e.message);
            }

            // 心劫触发判定（亲密度>=50 时有10%概率触发）
            await this._maybeTriggerHeartTribulation(companion, playerId, partnerId, cfg);

            return {
                success: true,
                message: `道侣互动成功！亲密度 +${intimacyBonus}，你修为 +${playerExpGain.toString()}，道侣修为 +${partnerExpGain.toString()}`,
                data: {
                    intimacy_gain: intimacyBonus,
                    new_intimacy: companion.intimacy,
                    player_exp_gain: playerExpGain.toString(),
                    partner_exp_gain: partnerExpGain.toString(),
                    last_interaction_time: companion.last_interaction_time
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] interact 异常:', err);
            throw err;
        }
    }

    /**
     * 5. 双修（双人闭关）
     * 双方必须都在线（WebSocket 校验）
     * 双方必须都未闭关、未在战斗中
     * 收益：双方各获得 normal_seclusion.exp_rate × 1.5 × (1 + intimacy/200) × realmMultiplier × (1 + heart_contract_level × 0.05)
     * 持续时间：60-300秒（可配置）
     * 每日1次，24小时冷却
     * 完成后亲密度+5
     * @param {number} playerId - 发起方玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async dualCultivate(playerId) {
        const cfg = getDaoCompanionConfig();
        const t = await sequelize.transaction();
        try {
            // 锁定玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 锁定道侣关系
            const companion = await findActiveCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion) {
                await t.rollback();
                return { success: false, message: '当前没有道侣，无法双修' };
            }

            // 校验双修冷却
            const cooldownSec = cfg.dual_cultivation_cooldown_seconds || 86400;
            if (companion.last_dual_cultivation_time) {
                const lastTime = new Date(companion.last_dual_cultivation_time).getTime();
                const elapsedSec = Math.floor((Date.now() - lastTime) / 1000);
                if (elapsedSec < cooldownSec) {
                    await t.rollback();
                    const remaining = cooldownSec - elapsedSec;
                    return {
                        success: false,
                        message: `双修冷却中，剩余 ${remaining} 秒（约 ${Math.ceil(remaining / 3600)} 小时）`
                    };
                }
            }

            // 校验对方玩家在线状态
            const partnerId = getPartnerId(companion, playerId);
            if (!WebSocketNotificationService.isPlayerOnline(partnerId)) {
                await t.rollback();
                return { success: false, message: '道侣不在线，无法开启双修' };
            }

            // 锁定对方玩家
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!partner) {
                await t.rollback();
                return { success: false, message: '道侣玩家不存在' };
            }

            await t.commit();

            // 状态机校验：双方都必须未闭关、未战斗、未双修
            // 注意：状态机校验需在事务外进行（避免锁等待）
            const playerStateCheck = await PlayerStateMachine.canStart(
                playerId,
                PlayerStateMachine.PlayerState.IN_DUAL_CULTIVATION,
                { source: 'route', stateType: 'dual_cultivation' }
            );
            if (!playerStateCheck.allowed) {
                return { success: false, message: playerStateCheck.reason };
            }
            const partnerStateCheck = await PlayerStateMachine.canStart(
                partnerId,
                PlayerStateMachine.PlayerState.IN_DUAL_CULTIVATION,
                { source: 'route', stateType: 'dual_cultivation' }
            );
            if (!partnerStateCheck.allowed) {
                return { success: false, message: `道侣${partnerStateCheck.reason}` };
            }

            // 计算双修收益
            // 公式：duration × base_exp_rate × 1.5 × (1 + intimacy/200) × realmMultiplier × (1 + heart_contract_level × 0.05)
            // 收益在双修开始时一次性发放（简化设计，避免双修结束时玩家离线导致结算失败）
            const minDuration = cfg.dual_cultivation_min_duration_seconds || 60;
            const maxDuration = cfg.dual_cultivation_max_duration_seconds || 300;
            const duration = Math.floor(Math.random() * (maxDuration - minDuration + 1)) + minDuration;

            let baseExpRate = 1;
            try {
                const seclusionConfig = configLoader.getConfig('seclusion');
                baseExpRate = parseFloat(seclusionConfig?.settings?.seclusion_exp_rate?.value) || 1;
            } catch (e) { /* 配置缺失时使用默认值 */ }

            const dualMultiplier = cfg.dual_cultivation_exp_multiplier || 1.5;
            const intimacyFactor = 1 + (companion.intimacy || 0) / 200;
            const heartContractFactor = 1 + (companion.heart_contract_level || 0) * (cfg.heart_contract_level_bonus_rate || 0.05);
            const playerRealmMult = getRealmMultiplier(player.realm);
            const partnerRealmMult = getRealmMultiplier(partner.realm);

            const playerExpGain = BigInt(Math.floor(duration * baseExpRate * dualMultiplier * intimacyFactor * heartContractFactor * playerRealmMult));
            const partnerExpGain = BigInt(Math.floor(duration * baseExpRate * dualMultiplier * intimacyFactor * heartContractFactor * partnerRealmMult));

            // 第二个事务：发放收益、更新亲密度、设置冷却
            const t2 = await sequelize.transaction();
            try {
                // 重新锁定玩家记录
                const lockedPlayer = await Player.findByPk(playerId, { transaction: t2, lock: t2.LOCK.UPDATE });
                const lockedPartner = await Player.findByPk(partnerId, { transaction: t2, lock: t2.LOCK.UPDATE });
                const lockedCompanion = await DaoCompanions.findByPk(companion.id, { transaction: t2, lock: t2.LOCK.UPDATE });

                if (!lockedPlayer || !lockedPartner || !lockedCompanion || lockedCompanion.status !== 'accepted') {
                    await t2.rollback();
                    return { success: false, message: '道侣关系已失效，无法双修' };
                }

                // 发放修为
                lockedPlayer.exp = (BigInt(lockedPlayer.exp || 0) + playerExpGain).toString();
                lockedPartner.exp = (BigInt(lockedPartner.exp || 0) + partnerExpGain).toString();

                // 增加亲密度
                const intimacyBonus = cfg.dual_cultivation_intimacy_bonus || 5;
                lockedCompanion.intimacy = Math.min(100, (lockedCompanion.intimacy || 0) + intimacyBonus);
                lockedCompanion.dual_cultivation_count = (lockedCompanion.dual_cultivation_count || 0) + 1;
                lockedCompanion.last_dual_cultivation_time = new Date();

                await lockedPlayer.save({ transaction: t2 });
                await lockedPartner.save({ transaction: t2 });
                await lockedCompanion.save({ transaction: t2 });

                await t2.commit();

                // 记录状态进入日志（异步）
                try {
                    await PlayerStateMachine.logEnter(playerId, 'dual_cultivation', PlayerStateMachine.PlayerState.IN_DUAL_CULTIVATION, {
                        source: 'route',
                        details: { companion_id: lockedCompanion.id, partner_id: partnerId, duration }
                    });
                    await PlayerStateMachine.logEnter(partnerId, 'dual_cultivation', PlayerStateMachine.PlayerState.IN_DUAL_CULTIVATION, {
                        source: 'route',
                        details: { companion_id: lockedCompanion.id, partner_id: playerId, duration }
                    });
                } catch (e) { /* 日志失败不影响主流程 */ }

                // WebSocket 推送给双方
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'dao_companion.dual_cultivation_completed', {
                        message: `双修圆满！修为 +${playerExpGain.toString()}，亲密度 +${intimacyBonus}`,
                        exp_gain: playerExpGain.toString(),
                        intimacy_gain: intimacyBonus,
                        new_intimacy: lockedCompanion.intimacy,
                        duration: duration
                    });
                    WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'dao_companion.dual_cultivation_completed', {
                        message: `${lockedPlayer.nickname} 与你双修圆满！修为 +${partnerExpGain.toString()}，亲密度 +${intimacyBonus}`,
                        exp_gain: partnerExpGain.toString(),
                        intimacy_gain: intimacyBonus,
                        new_intimacy: lockedCompanion.intimacy,
                        duration: duration
                    });
                } catch (e) {
                    console.warn('[DaoCompanionService] 推送双修通知失败:', e.message);
                }

                // 心劫触发判定
                await this._maybeTriggerHeartTribulation(lockedCompanion, playerId, partnerId, cfg);

                return {
                    success: true,
                    message: `双修圆满！你修为 +${playerExpGain.toString()}，道侣修为 +${partnerExpGain.toString()}，亲密度 +${intimacyBonus}`,
                    data: {
                        player_exp_gain: playerExpGain.toString(),
                        partner_exp_gain: partnerExpGain.toString(),
                        intimacy_gain: intimacyBonus,
                        new_intimacy: lockedCompanion.intimacy,
                        duration: duration,
                        dual_cultivation_count: lockedCompanion.dual_cultivation_count,
                        last_dual_cultivation_time: lockedCompanion.last_dual_cultivation_time
                    }
                };
            } catch (err) {
                if (t2 && !t2.finished) await t2.rollback();
                throw err;
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] dualCultivate 异常:', err);
            throw err;
        }
    }

    /**
     * 6. 解除道侣关系
     * 单方面解除（亲密度-20惩罚）
     * 双方进入冷却期（7天不能再求婚）
     * status → broken
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async breakCompanion(playerId) {
        const cfg = getDaoCompanionConfig();
        const t = await sequelize.transaction();
        try {
            // 锁定玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 锁定道侣关系
            const companion = await findActiveCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion) {
                await t.rollback();
                return { success: false, message: '当前没有道侣关系，无需解除' };
            }

            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });

            // 标记为已解除
            companion.status = 'broken';
            companion.broken_at = new Date();
            // 亲密度惩罚（记录在 intimacy 字段，仅作历史参考）
            const penalty = cfg.break_intimacy_penalty || 20;
            companion.intimacy = Math.max(0, (companion.intimacy || 0) - penalty);
            await companion.save({ transaction: t });

            await t.commit();

            // 推送通知给双方
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'dao_companion.broken', {
                    message: `你与 ${partner?.nickname || '道侣'} 解除道侣关系，亲密度 -${penalty}，${cfg.break_re_propose_cooldown_days || 7} 天内不能再次求婚`,
                    intimacy_penalty: penalty,
                    cooldown_days: cfg.break_re_propose_cooldown_days || 7
                });
                if (partner) {
                    WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'dao_companion.broken', {
                        message: `${player.nickname} 与你解除道侣关系，${cfg.break_re_propose_cooldown_days || 7} 天内不能再次求婚`,
                        intimacy_penalty: penalty,
                        cooldown_days: cfg.break_re_propose_cooldown_days || 7
                    });
                }
            } catch (e) {
                console.warn('[DaoCompanionService] 推送解除通知失败:', e.message);
            }

            return {
                success: true,
                message: `已与 ${partner?.nickname || '道侣'} 解除道侣关系，亲密度 -${penalty}，${cfg.break_re_propose_cooldown_days || 7} 天内不能再次求婚`,
                data: {
                    companion_id: companion.id,
                    intimacy_penalty: penalty,
                    broken_at: companion.broken_at,
                    cooldown_days: cfg.break_re_propose_cooldown_days || 7
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] breakCompanion 异常:', err);
            throw err;
        }
    }

    /**
     * 7. 获取我收到的求婚列表
     * 返回 pending 状态的求婚
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getProposals(playerId) {
        const proposals = await DaoCompanions.findAll({
            where: { player_b_id: playerId, status: 'pending' },
            order: [['created_at', 'DESC']]
        });

        // 批量查询求婚方玩家信息
        const proposerIds = [...new Set(proposals.map(p => p.player_a_id))];
        const proposers = await Player.findAll({
            where: { id: proposerIds },
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        const proposerMap = new Map(proposers.map(p => [p.id, p]));

        const list = proposals.map(p => {
            const proposer = proposerMap.get(p.player_a_id);
            return {
                proposal_id: p.id,
                from_player: proposer ? {
                    id: proposer.id,
                    nickname: proposer.nickname,
                    realm: proposer.realm,
                    realm_rank: Number(proposer.realm_rank || 0)
                } : null,
                created_at: p.created_at
            };
        });

        const cfg = getDaoCompanionConfig();
        return {
            success: true,
            data: {
                proposals: list,
                count: list.length,
                max_pending: cfg.max_pending_proposals_per_receiver || 3
            }
        };
    }

    /**
     * 8. 心劫抉择
     * 当亲密度>=50时随机触发心劫事件
     * 抉择选项：信任/怀疑/考验
     * 影响亲密度和心契等级
     * @param {number} playerId - 玩家ID
     * @param {number} eventId - 心劫事件ID
     * @param {string} option - 抉择选项：trust/doubt/trial
     * @returns {Promise<Object>} { success, message, data }
     */
    static async respondHeartTribulation(playerId, eventId, option) {
        // 参数校验
        if (!eventId || typeof eventId !== 'number') {
            return { success: false, message: 'event_id 必填且必须为数字', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!['trust', 'doubt', 'trial'].includes(option)) {
            return {
                success: false,
                message: 'option 必须为 trust(信任) / doubt(怀疑) / trial(考验) 之一',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const cfg = getDaoCompanionConfig();
        const t = await sequelize.transaction();
        try {
            // 锁定玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 锁定心劫事件
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
            // 超时校验：超时视为失败（默认怀疑）
            if (new Date(event.expires_at) < new Date()) {
                event.event_state = 'failed';
                event.chosen_option = 'doubt';  // 超时默认怀疑
                event.resolved_at = new Date();
                await event.save({ transaction: t });
                await t.commit();
                return { success: false, message: '心劫事件已过期，视为怀疑，亲密度 -10' };
            }

            // 锁定道侣关系
            const companion = await DaoCompanions.findByPk(event.companion_id, { transaction: t, lock: t.LOCK.UPDATE });
            if (!companion || companion.status !== 'accepted') {
                await t.rollback();
                return { success: false, message: '道侣关系已失效，无法处理心劫' };
            }

            // 获取选项配置
            const optionCfg = (cfg.heart_tribulation_options || {})[option];
            if (!optionCfg) {
                await t.rollback();
                return { success: false, message: '心劫选项配置缺失', error_code: ErrorCodes.CONFIG_ERROR };
            }

            // 成功率判定
            const successRoll = Math.random();
            const isSuccess = successRoll < (optionCfg.success_rate || 0.5);

            event.chosen_option = option;
            event.resolved_at = new Date();

            if (isSuccess) {
                // 成功：亲密度 +intimacy_gain，心契经验 +heart_contract_exp_gain
                event.event_state = 'resolved';
                event.reward = {
                    intimacy_gain: optionCfg.intimacy_gain,
                    heart_contract_exp_gain: optionCfg.heart_contract_exp_gain
                };

                const newIntimacy = Math.min(100, (companion.intimacy || 0) + optionCfg.intimacy_gain);
                companion.intimacy = newIntimacy;
                companion.last_heart_tribulation_time = new Date();

                await companion.save({ transaction: t });
            } else {
                // 失败：亲密度 -intimacy_loss，心契等级 -heart_contract_level_loss
                event.event_state = 'failed';
                const failurePenalty = cfg.heart_tribulation_failure_penalty || { intimacy_loss: 10, heart_contract_level_loss: 1 };
                event.penalty = {
                    intimacy_loss: failurePenalty.intimacy_loss,
                    heart_contract_level_loss: failurePenalty.heart_contract_level_loss
                };

                const newIntimacy = Math.max(0, (companion.intimacy || 0) - failurePenalty.intimacy_loss);
                companion.intimacy = newIntimacy;
                companion.heart_contract_level = Math.max(0, (companion.heart_contract_level || 0) - failurePenalty.heart_contract_level_loss);
                companion.last_heart_tribulation_time = new Date();

                await companion.save({ transaction: t });
            }

            await event.save({ transaction: t });
            await t.commit();

            // 推送心劫结算通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'dao_companion.heart_tribulation_resolved', {
                    message: isSuccess
                        ? `心劫抉择成功！${optionCfg.name}：亲密度 +${optionCfg.intimacy_gain}，心契经验 +${optionCfg.heart_contract_exp_gain}`
                        : `心劫抉择失败！${optionCfg.name}：亲密度 -${cfg.heart_tribulation_failure_penalty?.intimacy_loss || 10}，心契等级 -${cfg.heart_tribulation_failure_penalty?.heart_contract_level_loss || 1}`,
                    is_success: isSuccess,
                    option: option,
                    option_name: optionCfg.name,
                    new_intimacy: companion.intimacy,
                    new_heart_contract_level: companion.heart_contract_level
                });
            } catch (e) {
                console.warn('[DaoCompanionService] 推送心劫结算通知失败:', e.message);
            }

            return {
                success: true,
                message: isSuccess
                    ? `心劫抉择成功！${optionCfg.name}：亲密度 +${optionCfg.intimacy_gain}`
                    : `心劫抉择失败！${optionCfg.name}：亲密度 -${cfg.heart_tribulation_failure_penalty?.intimacy_loss || 10}`,
                data: {
                    is_success: isSuccess,
                    chosen_option: option,
                    option_name: optionCfg.name,
                    success_rate: optionCfg.success_rate,
                    new_intimacy: companion.intimacy,
                    new_heart_contract_level: companion.heart_contract_level,
                    reward: event.reward,
                    penalty: event.penalty
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] respondHeartTribulation 异常:', err);
            throw err;
        }
    }

    /**
     * 9. 获取心劫状态
     * 返回当前是否有 pending 心劫
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getHeartTribulationStatus(playerId) {
        const pendingEvent = await HeartTribulationEvent.findOne({
            where: {
                player_id: playerId,
                event_type: 'dao_heart_tribulation',
                event_state: 'pending',
                expires_at: { [Op.gt]: new Date() }
            },
            order: [['created_at', 'DESC']]
        });

        const cfg = getDaoCompanionConfig();
        const options = cfg.heart_tribulation_options || {};

        return {
            success: true,
            data: {
                has_pending: !!pendingEvent,
                pending_event: pendingEvent ? {
                    event_id: pendingEvent.id,
                    companion_id: pendingEvent.companion_id,
                    created_at: pendingEvent.created_at,
                    expires_at: pendingEvent.expires_at,
                    options: Object.entries(options).map(([key, val]) => ({
                        option: key,
                        name: val.name,
                        success_rate: val.success_rate,
                        intimacy_gain: val.intimacy_gain,
                        description: val.description
                    }))
                } : null
            }
        };
    }

    /**
     * 10. 凝聚心印
     * 亲密度>=80时可凝聚
     * 消耗双方各1000修为
     * heart_imprint_count+1，心契等级提升（每3个心印提升1级）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async condenseHeartImprint(playerId) {
        const cfg = getDaoCompanionConfig();
        const t = await sequelize.transaction();
        try {
            // 锁定玩家记录
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 锁定道侣关系
            const companion = await findActiveCompanionByPlayerId(playerId, t, t.LOCK.UPDATE);
            if (!companion) {
                await t.rollback();
                return { success: false, message: '当前没有道侣，无法凝聚心印' };
            }

            // 亲密度校验
            const minIntimacy = cfg.min_intimacy_for_heart_imprint || 80;
            if ((companion.intimacy || 0) < minIntimacy) {
                await t.rollback();
                return {
                    success: false,
                    message: `亲密度不足，凝聚心印需要 ${minIntimacy}（当前 ${companion.intimacy}）`
                };
            }

            // 心契等级上限校验
            const maxLevel = cfg.max_heart_contract_level || 9;
            if ((companion.heart_contract_level || 0) >= maxLevel) {
                await t.rollback();
                return {
                    success: false,
                    message: `心契等级已达上限（${maxLevel} 级），无需再凝聚心印`
                };
            }

            // 锁定对方玩家
            const partnerId = getPartnerId(companion, playerId);
            const partner = await Player.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!partner) {
                await t.rollback();
                return { success: false, message: '道侣玩家不存在' };
            }

            // 修为消耗校验
            const expCost = BigInt(cfg.heart_imprint_exp_cost || 1000);
            const playerExp = BigInt(player.exp || 0);
            const partnerExp = BigInt(partner.exp || 0);
            if (playerExp < expCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `你的修为不足，需要 ${expCost.toString()}（当前 ${playerExp.toString()}）`
                };
            }
            if (partnerExp < expCost) {
                await t.rollback();
                return {
                    success: false,
                    message: `道侣修为不足，需要 ${expCost.toString()}（当前 ${partnerExp.toString()}）`
                };
            }

            // 扣减修为
            player.exp = (playerExp - expCost).toString();
            partner.exp = (partnerExp - expCost).toString();

            // 增加心印数量
            const countPerLevel = cfg.heart_imprint_count_per_level || 3;
            const oldImprintCount = companion.heart_imprint_count || 0;
            const newImprintCount = oldImprintCount + 1;
            companion.heart_imprint_count = newImprintCount;

            // 检查是否提升心契等级（每 countPerLevel 个心印提升1级）
            let levelUp = false;
            const newLevel = Math.min(maxLevel, Math.floor(newImprintCount / countPerLevel));
            if (newLevel > (companion.heart_contract_level || 0)) {
                companion.heart_contract_level = newLevel;
                levelUp = true;
            }

            await player.save({ transaction: t });
            await partner.save({ transaction: t });
            await companion.save({ transaction: t });

            await t.commit();

            // 推送通知给双方
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'dao_companion.heart_imprint_condensed', {
                    message: `凝聚心印成功！消耗修为 ${expCost.toString()}，心印 ${oldImprintCount + 1}/${countPerLevel}${levelUp ? `，心契等级提升至 ${companion.heart_contract_level}` : ''}`,
                    exp_cost: expCost.toString(),
                    new_heart_imprint_count: companion.heart_imprint_count,
                    new_heart_contract_level: companion.heart_contract_level,
                    level_up: levelUp
                });
                WebSocketNotificationService.notifyPlayerUpdate(partnerId, 'dao_companion.heart_imprint_condensed', {
                    message: `${player.nickname} 凝聚心印，消耗你修为 ${expCost.toString()}${levelUp ? `，心契等级提升至 ${companion.heart_contract_level}` : ''}`,
                    exp_cost: expCost.toString(),
                    new_heart_imprint_count: companion.heart_imprint_count,
                    new_heart_contract_level: companion.heart_contract_level,
                    level_up: levelUp
                });
            } catch (e) {
                console.warn('[DaoCompanionService] 推送心印通知失败:', e.message);
            }

            return {
                success: true,
                message: `凝聚心印成功！消耗修为 ${expCost.toString()}，心印 ${newImprintCount}/${countPerLevel}${levelUp ? `，心契等级提升至 ${companion.heart_contract_level}` : ''}`,
                data: {
                    exp_cost: expCost.toString(),
                    new_heart_imprint_count: companion.heart_imprint_count,
                    new_heart_contract_level: companion.heart_contract_level,
                    level_up: levelUp,
                    imprint_to_next_level: countPerLevel - (newImprintCount % countPerLevel)
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] condenseHeartImprint 异常:', err);
            throw err;
        }
    }

    /**
     * 11. 护道判定（PVP/宗门战伤害应用前调用）
     *
     * 触发条件（设计文档 5.6.1 心契等级 L2 解锁）：
     *   - 道侣关系状态 = accepted
     *   - 心契等级 >= heart_contract_protect.min_level (默认 2)
     *   - 亲密度 >= heart_contract_protect.min_intimacy (默认 50)
     *   - 同一对道侣的护道冷却已过（默认 3600 秒）
     *   - 概率判定：按心契等级查 level_protect_rate（L2=10% / L5=25% / L9=30%）
     *
     * 触发效果：
     *   - 被攻击方实际承受伤害 = 原始伤害 × (1 - damage_share_rate)
     *   - 护道方承受伤害 = 原始伤害 × damage_share_rate (默认 50%)
     *   - 反击概率 = counter_attack_rate (默认 30%)，反击伤害 = 护道方 ATK × counter_attack_multiplier
     *   - 双方亲密度 +intimacy_gain_on_protect (默认 +2)
     *   - 写入 dao_companion_protect_log 日志表
     *   - WebSocket 推送双方通知
     *
     * @param {number} defenderId - 被攻击方玩家ID
     * @param {bigint|number} incomingDamage - 原始伤害值
     * @param {Object} [options] - 可选参数
     * @param {string} [options.battleType='pvp'] - 战斗类型：pvp/sect_war/world_boss
     * @param {number} [options.battleId=null] - 战斗记录ID
     * @param {number} [options.battleRound=null] - 战斗回合数
     * @param {number} [options.attackerId=null] - 攻击方玩家ID（用于日志记录）
     * @param {number} [options.protectorAtk=0] - 护道方攻击力（用于反击伤害计算）
     * @param {Object} [transaction=null] - 事务对象（若调用方已有事务，复用之）
     * @returns {Promise<Object>} { triggered, shared_damage, counter_damage, protector_id, log_id, actual_damage_to_defender }
     */
    static async tryProtect(defenderId, incomingDamage, options = {}) {
        // 默认参数处理
        const battleType = options.battleType || 'pvp';
        const battleId = options.battleId || null;
        const battleRound = options.battleRound || null;
        const attackerId = options.attackerId || null;
        const protectorAtk = Number(options.protectorAtk) || 0;
        const externalTransaction = options.transaction || null;

        // 默认返回：未触发护道
        const notTriggered = {
            triggered: false,
            shared_damage: '0',
            counter_damage: '0',
            actual_damage_to_defender: safeBigInt(incomingDamage).toString(),
            protector_id: null,
            log_id: null,
            reason: 'no_trigger'
        };

        // 护道配置
        const protectCfg = getProtectConfig();
        if (protectCfg.enabled === false) {
            notTriggered.reason = 'protect_disabled';
            return notTriggered;
        }

        const minLevel = protectCfg.min_level || 2;
        const minIntimacy = protectCfg.min_intimacy || 50;
        const cooldownSeconds = protectCfg.cooldown_seconds || 3600;
        const damageShareRate = Number(protectCfg.damage_share_rate) || 0.5;
        const counterAttackRate = Number(protectCfg.counter_attack_rate) || 0.3;
        const counterAttackMultiplier = Number(protectCfg.counter_attack_multiplier) || 0.5;
        const intimacyGain = Number(protectCfg.intimacy_gain_on_protect) || 2;
        const levelRates = protectCfg.level_protect_rate || {};

        // 查找被攻击方的活跃道侣关系（无事务，只读）
        const companion = await findActiveCompanionByPlayerId(defenderId);
        if (!companion) {
            notTriggered.reason = 'no_companion';
            return notTriggered;
        }

        // 心契等级校验
        const heartLevel = Number(companion.heart_contract_level) || 0;
        if (heartLevel < minLevel) {
            notTriggered.reason = `heart_level_too_low_${heartLevel}_lt_${minLevel}`;
            return notTriggered;
        }

        // 亲密度校验
        if ((companion.intimacy || 0) < minIntimacy) {
            notTriggered.reason = `intimacy_too_low_${companion.intimacy}_lt_${minIntimacy}`;
            return notTriggered;
        }

        // 冷却校验：查询同一道侣关系最近一次护道记录
        const cooldownMs = cooldownSeconds * 1000;
        const cooldownThreshold = new Date(Date.now() - cooldownMs);
        const recentLog = await DaoCompanionProtectLog.findOne({
            where: {
                companion_id: companion.id,
                created_at: { [Op.gt]: cooldownThreshold }
            },
            order: [['created_at', 'DESC']]
        });
        if (recentLog) {
            notTriggered.reason = 'in_cooldown';
            return notTriggered;
        }

        // 概率判定：按心契等级查表
        const protectRate = Number(levelRates[String(heartLevel)] || levelRates[heartLevel] || 0);
        if (protectRate <= 0) {
            notTriggered.reason = `no_rate_for_level_${heartLevel}`;
            return notTriggered;
        }
        if (Math.random() >= protectRate) {
            notTriggered.reason = 'random_miss';
            return notTriggered;
        }

        // ===== 护道触发 =====
        const protectorId = getPartnerId(companion, defenderId);
        const originalDamage = safeBigInt(incomingDamage);

        // 分担伤害（向下取整，避免溢出）
        const sharedDamage = originalDamage * BigInt(Math.floor(damageShareRate * 100)) / 100n;
        // 被攻击方实际承受伤害
        const actualDamageToDefender = originalDamage - sharedDamage;

        // 反击伤害判定
        let counterDamage = 0n;
        let counterTriggered = false;
        if (Math.random() < counterAttackRate && protectorAtk > 0) {
            counterTriggered = true;
            // 反击伤害 = 护道方攻击力 × 反击倍率（向下取整）
            counterDamage = BigInt(Math.floor(protectorAtk * counterAttackMultiplier));
        }

        // 写入护道日志（使用事务保证一致性，同时更新亲密度）
        const t = externalTransaction || await sequelize.transaction();
        const shouldCommit = !externalTransaction;
        try {
            // 写入护道日志
            const logRecord = await DaoCompanionProtectLog.create({
                companion_id: companion.id,
                attacker_id: attackerId || 0,
                defender_id: defenderId,
                protector_id: protectorId,
                original_damage: originalDamage,
                shared_damage: sharedDamage,
                counter_damage: counterDamage,
                heart_contract_level: heartLevel,
                protect_rate: protectRate,
                damage_share_rate: damageShareRate,
                counter_attack_rate: counterAttackRate,
                battle_type: battleType,
                battle_id: battleId,
                battle_round: battleRound,
                remark: counterTriggered ? `心契L${heartLevel} 护道触发（含反击）` : `心契L${heartLevel} 护道触发`
            }, { transaction: t });

            // 亲密度 +2（上限 100）
            const newIntimacy = Math.min(100, (companion.intimacy || 0) + intimacyGain);
            await DaoCompanions.update(
                { intimacy: newIntimacy },
                {
                    where: { id: companion.id },
                    transaction: t
                }
            );

            if (shouldCommit) await t.commit();

            // WebSocket 推送通知给双方（非阻塞，失败不影响业务）
            try {
                WebSocketNotificationService.emitToPlayer(defenderId, 'dao_companion.protect_triggered', {
                    message: `道侣护道触发！为你分担了 ${sharedDamage.toString()} 点伤害${counterTriggered ? `，并对敌方反击 ${counterDamage.toString()} 点` : ''}`,
                    log_id: logRecord.id,
                    shared_damage: sharedDamage.toString(),
                    counter_damage: counterDamage.toString(),
                    protector_id: protectorId,
                    battle_type: battleType
                });
                WebSocketNotificationService.emitToPlayer(protectorId, 'dao_companion.protect_triggered', {
                    message: `你为道侣护道，承担了 ${sharedDamage.toString()} 点伤害${counterTriggered ? `，并反击敌方 ${counterDamage.toString()} 点` : ''}，亲密度 +${intimacyGain}`,
                    log_id: logRecord.id,
                    shared_damage: sharedDamage.toString(),
                    counter_damage: counterDamage.toString(),
                    defender_id: defenderId,
                    battle_type: battleType
                });
            } catch (e) {
                console.warn('[DaoCompanionService] 护道通知推送失败:', e.message);
            }

            return {
                triggered: true,
                shared_damage: sharedDamage.toString(),
                counter_damage: counterDamage.toString(),
                actual_damage_to_defender: actualDamageToDefender.toString(),
                protector_id: protectorId,
                log_id: logRecord.id,
                heart_contract_level: heartLevel,
                counter_triggered: counterTriggered,
                intimacy_gain: intimacyGain
            };
        } catch (err) {
            if (shouldCommit && t && !t.finished) await t.rollback();
            console.error('[DaoCompanionService] tryProtect 写入日志失败:', err);
            // 写入失败不影响战斗主流程，按未触发处理
            notTriggered.reason = `log_write_failed: ${err.message}`;
            return notTriggered;
        }
    }

    /**
     * 12. 查询护道日志
     * 返回玩家作为 defender 或 protector 的护道历史记录
     * @param {number} playerId - 玩家ID
     * @param {Object} [options] - 分页参数
     * @param {number} [options.page=1] - 页码（从1开始）
     * @param {number} [options.limit=10] - 每页条数
     * @param {string} [options.role='all'] - 角色：all/defender/protector
     * @returns {Promise<Object>} { success, data: { logs, total, page, limit } }
     */
    static async getProtectLogs(playerId, options = {}) {
        const page = Math.max(1, Number(options.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(options.limit) || 10));
        const role = options.role || 'all';
        const offset = (page - 1) * limit;

        // 构建查询条件
        const where = {};
        if (role === 'defender') {
            where.defender_id = playerId;
        } else if (role === 'protector') {
            where.protector_id = playerId;
        } else {
            // all: 查询 defender 或 protector
            where[Op.or] = [{ defender_id: playerId }, { protector_id: playerId }];
        }

        const { count, rows } = await DaoCompanionProtectLog.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit,
            offset
        });

        // 转换 BigInt 字段为字符串（JSON 序列化兼容）
        const logs = rows.map(r => {
            const d = r.toJSON();
            return {
                id: d.id,
                companion_id: d.companion_id,
                attacker_id: d.attacker_id,
                defender_id: d.defender_id,
                protector_id: d.protector_id,
                original_damage: safeBigInt(d.original_damage).toString(),
                shared_damage: safeBigInt(d.shared_damage).toString(),
                counter_damage: safeBigInt(d.counter_damage).toString(),
                heart_contract_level: d.heart_contract_level,
                protect_rate: Number(d.protect_rate),
                damage_share_rate: Number(d.damage_share_rate),
                counter_attack_rate: Number(d.counter_attack_rate),
                battle_type: d.battle_type,
                battle_id: d.battle_id,
                battle_round: d.battle_round,
                remark: d.remark,
                created_at: d.created_at
            };
        });

        return {
            success: true,
            data: {
                logs,
                total: count,
                page,
                limit,
                total_pages: Math.ceil(count / limit)
            }
        };
    }

    /**
     * 13. 查询护道统计
     * 返回玩家作为被护道方/护道方的综合统计
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data: { as_defender, as_protector } }
     */
    static async getProtectStats(playerId) {
        // 作为被护道方（被攻击时道侣护道）的统计
        const asDefenderStats = await DaoCompanionProtectLog.findAll({
            where: { defender_id: playerId },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_count'],
                [sequelize.fn('SUM', sequelize.col('shared_damage')), 'total_shared_damage'],
                [sequelize.fn('SUM', sequelize.col('counter_damage')), 'total_counter_damage'],
                [sequelize.fn('MAX', sequelize.col('created_at')), 'last_protect_time']
            ],
            raw: true
        });

        // 作为护道方（道侣被攻击时主动护道）的统计
        const asProtectorStats = await DaoCompanionProtectLog.findAll({
            where: { protector_id: playerId },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'total_count'],
                [sequelize.fn('SUM', sequelize.col('shared_damage')), 'total_shared_damage'],
                [sequelize.fn('SUM', sequelize.col('counter_damage')), 'total_counter_damage'],
                [sequelize.fn('MAX', sequelize.col('created_at')), 'last_protect_time']
            ],
            raw: true
        });

        const defStats = asDefenderStats[0] || {};
        const proStats = asProtectorStats[0] || {};

        return {
            success: true,
            data: {
                as_defender: {
                    total_count: Number(defStats.total_count) || 0,
                    total_shared_damage: safeBigInt(defStats.total_shared_damage).toString(),
                    total_counter_damage: safeBigInt(defStats.total_counter_damage).toString(),
                    last_protect_time: defStats.last_protect_time || null
                },
                as_protector: {
                    total_count: Number(proStats.total_count) || 0,
                    total_shared_damage: safeBigInt(proStats.total_shared_damage).toString(),
                    total_counter_damage: safeBigInt(proStats.total_counter_damage).toString(),
                    last_protect_time: proStats.last_protect_time || null
                }
            }
        };
    }

    /**
     * 内部方法：心劫触发判定
     * 当亲密度>=50 时有 10% 概率触发（每次互动/双修后判定）
     * @param {Object} companion - 道侣关系对象
     * @param {number} playerIdA - 玩家A ID
     * @param {number} playerIdB - 玩家B ID
     * @param {Object} cfg - 配置 settings 节
     * @returns {Promise<void>}
     * @private
     */
    static async _maybeTriggerHeartTribulation(companion, playerIdA, playerIdB, cfg) {
        try {
            const minIntimacy = cfg.min_intimacy_for_heart_tribulation || 50;
            const triggerRate = cfg.heart_tribulation_trigger_rate || 0.1;
            const expireHours = cfg.heart_tribulation_expire_hours || 24;

            // 亲密度不足，不触发
            if ((companion.intimacy || 0) < minIntimacy) return;

            // 概率判定
            if (Math.random() >= triggerRate) return;

            // 检查是否已有 pending 心劫（避免重复触发）
            const existingPending = await HeartTribulationEvent.findOne({
                where: {
                    player_id: playerIdA,
                    event_type: 'dao_heart_tribulation',
                    event_state: 'pending',
                    expires_at: { [Op.gt]: new Date() }
                }
            });
            if (existingPending) return;

            // 创建心劫事件
            const expireTime = new Date(Date.now() + expireHours * 60 * 60 * 1000);
            const event = await HeartTribulationEvent.create({
                player_id: playerIdA,
                companion_id: companion.id,
                concubine_id: null,
                event_type: 'dao_heart_tribulation',
                event_state: 'pending',
                options: cfg.heart_tribulation_options || {},
                expires_at: expireTime
            });

            // 推送心劫触发通知给双方
            try {
                WebSocketNotificationService.emitToPlayer(playerIdA, 'dao_companion.heart_tribulation_triggered', {
                    message: '心劫降临！请在 24 小时内做出抉择，否则视为怀疑',
                    event_id: event.id,
                    companion_id: companion.id,
                    expires_at: expireTime
                });
                WebSocketNotificationService.emitToPlayer(playerIdB, 'dao_companion.heart_tribulation_triggered', {
                    message: `你的道侣触发了心劫，请提醒对方及时抉择`,
                    event_id: event.id,
                    companion_id: companion.id,
                    expires_at: expireTime
                });
            } catch (e) {
                console.warn('[DaoCompanionService] 推送心劫触发通知失败:', e.message);
            }
        } catch (err) {
            console.warn('[DaoCompanionService] 心劫触发异常:', err.message);
        }
    }
}

module.exports = DaoCompanionService;
