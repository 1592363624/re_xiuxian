/**
 * 坐化遗府服务
 *
 * 实现玩法文档第16节"坐化遗府"的全部业务逻辑：
 *   管理员接口：
 *     1. previewLegacy：预览遗府（查询可分配物品 + 合格玩家估算）
 *     2. openLegacy：开启遗府活动（preview -> open，写入可分配物品）
 *     3. closeLegacy：手动关闭遗府（open -> closed，结算未分配物品）
 *     4. getAdminStatus：查看后台状态（所有遗府列表）
 *
 *   玩家接口：
 *     5. getActiveLegacy：查看当前开启的遗府
 *     6. spinLegacy：转动分宝（每期每人只能转动一次）
 *     7. getHistory：查看分宝记录（玩家本人参与的遗府历史）
 *
 *   内部方法：
 *     - _filterInventoryItems：从坐化玩家储物袋筛选可分配物品（应用 item_filter 规则）
 *     - _checkEligibility：检查玩家参与资格（活跃度/在线时长/指令数/修为/首次记录）
 *     - _calculateWeight：计算分宝权重（log10(exp) + log10(online_min)）
 *     - _checkSoulUniqueness：检查同主魂唯一领取（IP 相同 + 已分宝）
 *     - _executeSpin：执行一次分宝事务（扣减 remaining_quantity + 写日志 + 物品入袋）
 *     - _settleLegacy：结算遗府（处理未分配物品：销毁或退回原主）
 *     - checkExpiredLegacies：调度器调用，检查过期遗府并自动关闭
 *
 * 核心设计：
 *   - 异步多人 PvP/协作：管理员开启后所有合格玩家可参与，每人只能转动一次
 *   - 防小号机制：同主魂（IP）唯一领取、活跃度阈值、首次记录时间、总指令数、总修为
 *   - 物品筛选：只分配储物袋里的普通材料和普通物品；跳过剧情物/徽章/绑定物/带器灵/已装备/祭炼/本命法宝
 *   - 加权随机分配：权重 = log10(exp+10)*coeff_exp + log10(online_min+1)*coeff_online，乘以幸运因子
 *   - 事务保证：分宝/开启/关闭均使用事务 + 行级锁
 *   - WebSocket 推送在事务提交后，避免数据回滚不一致
 *
 * 配置来源：server/config/cave_legacy_data.json -> cave_legacy 段
 *
 * 数据模型：
 *   - CaveLegacy（cave_legacies）：遗府活动主表
 *   - CaveLegacyItem（cave_legacy_items）：遗府可分配物品表
 *   - CaveLegacyParticipant（cave_legacy_participants）：参与分宝的玩家表
 *   - CaveLegacyDistributionLog（cave_legacy_distribution_logs）：分配日志表
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const sequelize = require('../../config/database');
const { Op } = require('sequelize');

// 数据模型
const Player = require('../../models/player');
const Item = require('../../models/item');
const PlayerEquipment = require('../../models/playerEquipment');
const CaveLegacy = require('../../models/caveLegacy');
const CaveLegacyItem = require('../../models/caveLegacyItem');
const CaveLegacyParticipant = require('../../models/caveLegacyParticipant');
const CaveLegacyDistributionLog = require('../../models/caveLegacyDistributionLog');

// 工具
const WebSocketNotificationService = require('./WebSocketNotificationService');
const InventoryService = require('./InventoryService');
const { ErrorCodes } = require('../../middleware/errorHandler');

// 单例状态
let _initialized = false;
let _config = null;

/**
 * 工具函数：安全转换 BigInt 为 Number（用于修为/灵石等）
 * @param {string|number|bigint|null|undefined} value
 * @returns {number}
 */
function safeNumber(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return value;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

class CaveLegacyService {
    /**
     * 初始化服务：加载配置
     * 防御性配置加载：包裹 try/catch，配置缺失时仅警告不阻塞
     * @param {Object} configLoaderInstance - 配置加载器实例
     */
    initialize(configLoaderInstance) {
        if (_initialized) return;
        try {
            const loader = configLoaderInstance || configLoader;
            _config = loader.getConfig('cave_legacy_data')?.cave_legacy;
        } catch (e) {
            console.warn('[CaveLegacyService] 配置 cave_legacy_data.cave_legacy 未加载，服务不可用:', e.message);
            return;
        }
        if (!_config) {
            console.warn('[CaveLegacyService] 配置 cave_legacy 为空，服务不可用');
            return;
        }
        _initialized = true;
        console.log('[CaveLegacyService] 坐化遗府服务初始化完成');
    }

    /**
     * 获取配置
     * 防御性加载：未初始化时尝试重新加载，失败返回 null
     * @returns {Object|null}
     */
    getConfig() {
        if (!_initialized || !_config) {
            try {
                _config = configLoader.getConfig('cave_legacy_data')?.cave_legacy;
                _initialized = !!_config;
            } catch (e) {
                return null;
            }
        }
        return _config;
    }

    // ==================== 管理员接口 ====================

    /**
     * 预览遗府：查询坐化玩家的可分配资产和合格玩家估算
     *
     * 业务流程：
     *   1. 校验目标玩家存在
     *   2. 调用 _filterInventoryItems 筛选可分配物品（不实际扣减，仅预览）
     *   3. 估算合格玩家数量（异步统计，按 eligibility 阈值过滤）
     *   4. 返回预览数据
     *
     * @param {Object} admin - 管理员玩家对象
     * @param {number} ownerPlayerId - 坐化玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async previewLegacy(admin, ownerPlayerId) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '坐化遗府配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        const ownerIdNum = Number(ownerPlayerId);
        if (!Number.isFinite(ownerIdNum) || ownerIdNum <= 0) {
            return { success: false, message: '坐化玩家ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        // 查询坐化玩家
        const owner = await Player.findByPk(ownerIdNum);
        if (!owner) {
            return { success: false, message: '坐化玩家不存在', error_code: ErrorCodes.NOT_FOUND };
        }

        // 筛选可分配物品（仅预览，不写入数据库）
        const itemsResult = await this._filterInventoryItems(ownerIdNum);
        if (!itemsResult.success) {
            return { success: false, message: itemsResult.message };
        }

        // 估算合格玩家数量（异步统计，限制扫描行数避免性能问题）
        const eligibilityEstimate = await this._estimateEligiblePlayers(owner);

        // 检查是否已有该玩家的进行中遗府
        const existingLegacy = await CaveLegacy.findOne({
            where: {
                owner_player_id: ownerIdNum,
                status: { [Op.in]: ['preview', 'open'] }
            }
        });

        return {
            success: true,
            message: '遗府预览成功',
            data: {
                owner: {
                    id: owner.id,
                    nickname: owner.nickname,
                    realm: owner.realm,
                    is_dead: owner.is_dead,
                    last_online: owner.last_online,
                    ip_address: owner.ip_address
                },
                items: itemsResult.items,
                items_count: itemsResult.items.length,
                items_total_quantity: itemsResult.items.reduce((sum, i) => sum + i.quantity, 0),
                eligible_players_estimate: eligibilityEstimate.count,
                eligibility_criteria: eligibilityEstimate.criteria,
                existing_legacy: existingLegacy ? {
                    id: existingLegacy.id,
                    status: existingLegacy.status,
                    started_at: existingLegacy.started_at,
                    ends_at: existingLegacy.ends_at
                } : null,
                config: {
                    default_duration_hours: config.default_duration_hours,
                    min_duration_hours: config.min_duration_hours,
                    max_duration_hours: config.max_duration_hours
                }
            }
        };
    }

    /**
     * 开启遗府活动
     *
     * 业务流程：
     *   1. 校验目标玩家存在 + 不存在进行中的遗府
     *   2. 校验同时进行的遗府数量上限
     *   3. 校验时长参数
     *   4. 筛选可分配物品（校验数量 >= min_items_to_open）
     *   5. 事务：创建 CaveLegacy（status=open）+ 写入 CaveLegacyItem + 从坐化玩家储物袋扣除物品
     *   6. WebSocket 广播遗府开启通知
     *
     * @param {Object} admin - 管理员玩家对象
     * @param {number} ownerPlayerId - 坐化玩家ID
     * @param {number} durationHours - 活动时长（小时）
     * @returns {Promise<Object>} { success, message, data }
     */
    async openLegacy(admin, ownerPlayerId, durationHours) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '坐化遗府配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        const ownerIdNum = Number(ownerPlayerId);
        if (!Number.isFinite(ownerIdNum) || ownerIdNum <= 0) {
            return { success: false, message: '坐化玩家ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        // 时长参数校验
        const duration = Number(durationHours) || config.default_duration_hours;
        const minDur = Number(config.min_duration_hours) || 1;
        const maxDur = Number(config.max_duration_hours) || 168;
        if (duration < minDur || duration > maxDur) {
            return { success: false, message: `活动时长需在 ${minDur} ~ ${maxDur} 小时之间`, error_code: ErrorCodes.VALIDATION_ERROR };
        }

        // 同时进行的遗府数量上限校验
        const activeCount = await CaveLegacy.count({
            where: { status: 'open' }
        });
        const maxActive = Number(config.max_active_legacies) || 3;
        if (activeCount >= maxActive) {
            return { success: false, message: `同时进行的遗府数量已达上限（${maxActive} 个）`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        // 查询坐化玩家
        const owner = await Player.findByPk(ownerIdNum);
        if (!owner) {
            return { success: false, message: '坐化玩家不存在', error_code: ErrorCodes.NOT_FOUND };
        }

        // 检查是否已有该玩家的进行中遗府
        const existingLegacy = await CaveLegacy.findOne({
            where: {
                owner_player_id: ownerIdNum,
                status: { [Op.in]: ['preview', 'open'] }
            }
        });
        if (existingLegacy) {
            return { success: false, message: `该玩家已有进行中的遗府（ID: ${existingLegacy.id}, 状态: ${existingLegacy.status}）`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        // 筛选可分配物品
        const itemsResult = await this._filterInventoryItems(ownerIdNum);
        if (!itemsResult.success) {
            return { success: false, message: itemsResult.message };
        }
        const minItems = Number(config.min_items_to_open) || 1;
        if (itemsResult.items.length < minItems) {
            return { success: false, message: `可分配物品数量不足（最少 ${minItems} 种，当前 ${itemsResult.items.length} 种）`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const now = new Date();
            const endsAt = new Date(now.getTime() + duration * 3600 * 1000);

            // 1. 创建遗府活动记录（status=open）
            const legacy = await CaveLegacy.create({
                owner_player_id: ownerIdNum,
                owner_nickname_snapshot: owner.nickname,
                owner_ip_snapshot: owner.ip_address || null,
                status: 'open',
                duration_hours: duration,
                started_at: now,
                ends_at: endsAt,
                opened_by_admin: admin.id,
                items_count: itemsResult.items.length,
                items_total_quantity: itemsResult.items.reduce((sum, i) => sum + i.quantity, 0),
                participants_count: 0,
                settled: false
            }, { transaction: t });

            // 2. 写入可分配物品快照
            const itemRows = itemsResult.items.map(item => ({
                legacy_id: legacy.id,
                item_key: item.item_key,
                item_name_snapshot: item.name,
                item_type_snapshot: item.type,
                item_subtype_snapshot: item.subtype || null,
                item_quality_snapshot: item.quality || 'common',
                original_quantity: item.quantity,
                remaining_quantity: item.quantity,
                source: 'inventory'
            }));
            await CaveLegacyItem.bulkCreate(itemRows, { transaction: t });

            // 3. 从坐化玩家储物袋扣除对应物品（事务内行级锁）
            for (const item of itemsResult.items) {
                const removed = await InventoryService.removeItem(ownerIdNum, item.item_key, item.quantity, t);
                if (!removed) {
                    // 极小概率：并发修改导致扣减失败，回滚事务
                    await t.rollback();
                    return { success: false, message: `扣除坐化玩家物品失败：${item.name}（可能被并发修改）`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
                }
            }

            await t.commit();

            // 事务提交后推送 WebSocket 通知（避免回滚不一致）
            try {
                WebSocketNotificationService.broadcastNotification({
                    type: 'cave_legacy_opened',
                    title: '遗府开启',
                    content: `${owner.nickname} 坐化遗府已开启，持续 ${duration} 小时。合格修士可参与分宝。`,
                    level: 'info',
                    legacy_id: legacy.id,
                    owner_nickname: owner.nickname,
                    ends_at: endsAt.toISOString()
                });
            } catch (e) {
                console.warn('[CaveLegacyService] 推送遗府开启通知失败:', e.message);
            }

            return {
                success: true,
                message: `遗府已开启（ID: ${legacy.id}），持续 ${duration} 小时，可分配物品 ${itemsResult.items.length} 种`,
                data: {
                    legacy_id: legacy.id,
                    status: 'open',
                    started_at: now,
                    ends_at: endsAt,
                    items_count: itemsResult.items.length,
                    items_total_quantity: itemsResult.items.reduce((sum, i) => sum + i.quantity, 0)
                }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            console.error('[CaveLegacyService] 开启遗府失败:', error);
            return { success: false, message: `开启遗府失败: ${error.message}`, error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 管理员手动关闭遗府
     *
     * 业务流程：
     *   1. 校验遗府存在且状态为 open
     *   2. 调用 _settleLegacy 结算（处理未分配物品）
     *   3. 标记 close_reason=admin_close
     *
     * @param {Object} admin - 管理员玩家对象
     * @param {number} legacyId - 遗府ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async closeLegacy(admin, legacyId) {
        const legacyIdNum = Number(legacyId);
        if (!Number.isFinite(legacyIdNum) || legacyIdNum <= 0) {
            return { success: false, message: '遗府ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const legacy = await CaveLegacy.findByPk(legacyIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!legacy) {
                await t.rollback();
                return { success: false, message: '遗府不存在', error_code: ErrorCodes.NOT_FOUND };
            }
            if (legacy.status !== 'open') {
                await t.rollback();
                return { success: false, message: `遗府当前状态为 ${legacy.status}，无法关闭`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 结算：处理未分配物品
            const settleResult = await this._settleLegacy(legacy, 'admin_close', admin.id, t);

            legacy.status = 'closed';
            legacy.closed_at = new Date();
            legacy.closed_by_admin = admin.id;
            legacy.close_reason = 'admin_close';
            legacy.settled = true;
            legacy.summary_json = settleResult.summary;
            await legacy.save({ transaction: t });

            await t.commit();

            // 推送关闭通知
            try {
                WebSocketNotificationService.broadcastNotification({
                    type: 'cave_legacy_closed',
                    title: '遗府关闭',
                    content: `${legacy.owner_nickname_snapshot} 的遗府已关闭。`,
                    level: 'info',
                    legacy_id: legacy.id
                });
            } catch (e) {
                console.warn('[CaveLegacyService] 推送遗府关闭通知失败:', e.message);
            }

            return {
                success: true,
                message: `遗府 ${legacy.id} 已关闭，结算完成`,
                data: {
                    legacy_id: legacy.id,
                    status: 'closed',
                    closed_at: legacy.closed_at,
                    summary: settleResult.summary
                }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            console.error('[CaveLegacyService] 关闭遗府失败:', error);
            return { success: false, message: `关闭遗府失败: ${error.message}`, error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 管理员查看后台状态：所有遗府列表（含已关闭）
     *
     * @param {Object} admin - 管理员玩家对象
     * @param {string} statusFilter - 状态过滤（open/closed/all，默认 all）
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {Promise<Object>} { success, message, data }
     */
    async getAdminStatus(admin, statusFilter = 'all', page = 1, pageSize = 20) {
        const where = {};
        if (statusFilter !== 'all') {
            where.status = statusFilter;
        }
        const offset = (Number(page) - 1) * Number(pageSize);
        const limit = Number(pageSize);

        const { rows, count } = await CaveLegacy.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            offset,
            limit
        });

        return {
            success: true,
            message: '查询成功',
            data: {
                legacies: rows.map(l => ({
                    id: l.id,
                    owner_player_id: l.owner_player_id,
                    owner_nickname: l.owner_nickname_snapshot,
                    status: l.status,
                    duration_hours: l.duration_hours,
                    started_at: l.started_at,
                    ends_at: l.ends_at,
                    closed_at: l.closed_at,
                    items_count: l.items_count,
                    items_total_quantity: l.items_total_quantity,
                    participants_count: l.participants_count,
                    settled: l.settled,
                    close_reason: l.close_reason,
                    summary: l.summary_json
                })),
                total: count,
                page: Number(page),
                page_size: Number(pageSize)
            }
        };
    }

    // ==================== 玩家接口 ====================

    /**
     * 查看当前开启的遗府
     *
     * 业务流程：
     *   1. 查询所有 status=open 的遗府
     *   2. 对每个遗府查询当前玩家的参与状态（是否合格/是否已转动）
     *   3. 返回遗府列表 + 玩家状态
     *
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} { success, message, data }
     */
    async getActiveLegacy(player) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '坐化遗府配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        // 查询所有开启中的遗府
        const legacies = await CaveLegacy.findAll({
            where: { status: 'open' },
            order: [['ends_at', 'ASC']]
        });

        const result = [];
        for (const legacy of legacies) {
            // 查询当前玩家在该遗府的参与状态
            let participant = await CaveLegacyParticipant.findOne({
                where: { legacy_id: legacy.id, player_id: player.id }
            });

            // 若未参与过，则即时计算资格（不写库，仅展示）
            let eligibilityStatus = 'unknown';
            let ineligibilityReason = null;
            if (participant) {
                eligibilityStatus = participant.eligible ? 'eligible' : 'ineligible';
                ineligibilityReason = participant.ineligibility_reason;
            } else {
                // 实时校验资格（不写库）
                const checkResult = await this._checkEligibility(player);
                eligibilityStatus = checkResult.eligible ? 'eligible' : 'ineligible';
                ineligibilityReason = checkResult.reason;

                // 同主魂检查：若有同 IP 玩家已分宝，则不可再分宝
                if (checkResult.eligible && player.ip_address) {
                    const soulCheck = await this._checkSoulUniqueness(player, legacy.id);
                    if (!soulCheck.unique) {
                        eligibilityStatus = 'soul_already_claimed';
                        ineligibilityReason = `同主魂玩家 ${soulCheck.existingNickname} 已分宝，不可重复领取`;
                    }
                }
            }

            // 查询剩余物品摘要（按品质分组）
            const items = await CaveLegacyItem.findAll({
                where: { legacy_id: legacy.id, remaining_quantity: { [Op.gt]: 0 } },
                order: [['item_quality_snapshot', 'ASC'], ['item_name_snapshot', 'ASC']]
            });

            // 按品质聚合
            const qualitySummary = {};
            for (const item of items) {
                const q = item.item_quality_snapshot;
                if (!qualitySummary[q]) {
                    qualitySummary[q] = { quality: q, item_types: 0, total_quantity: 0 };
                }
                qualitySummary[q].item_types += 1;
                qualitySummary[q].total_quantity += item.remaining_quantity;
            }

            result.push({
                legacy_id: legacy.id,
                owner_nickname: legacy.owner_nickname_snapshot,
                started_at: legacy.started_at,
                ends_at: legacy.ends_at,
                remaining_time_ms: legacy.ends_at ? Math.max(0, new Date(legacy.ends_at) - new Date()) : 0,
                items_count: legacy.items_count,
                items_total_quantity: legacy.items_total_quantity,
                participants_count: legacy.participants_count,
                player_status: {
                    has_participated: !!participant,
                    eligible: participant ? participant.eligible : (eligibilityStatus === 'eligible'),
                    eligibility_status: eligibilityStatus,
                    ineligibility_reason: ineligibilityReason,
                    has_spun: participant ? participant.has_spun : false,
                    spun_at: participant ? participant.spun_at : null,
                    total_item_types: participant ? participant.total_item_types : 0,
                    total_quantity: participant ? participant.total_quantity : 0
                },
                quality_summary: Object.values(qualitySummary)
            });
        }

        return {
            success: true,
            message: '查询成功',
            data: {
                active_legacies: result,
                count: result.length
            }
        };
    }

    /**
     * 转动分宝（每期每人一次）
     *
     * 业务流程：
     *   1. 校验玩家未死亡/未封禁
     *   2. 校验遗府存在且状态为 open
     *   3. 校验活动未过期
     *   4. 行级锁查询或创建 participant 记录
     *   5. 校验资格（首次参与时写入 eligible/weight/lucky_factor）
     *   6. 校验同主魂唯一领取
     *   7. 校验 has_spun=false
     *   8. 调用 _executeSpin 执行分宝事务
     *   9. 推送 WebSocket 通知
     *
     * @param {Object} player - 玩家对象
     * @param {number} legacyId - 遗府ID
     * @returns {Promise<Object>} { success, message, data }
     */
    async spinLegacy(player, legacyId) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '坐化遗府配置未加载', error_code: ErrorCodes.CONFIG_ERROR };
        }

        const legacyIdNum = Number(legacyId);
        if (!Number.isFinite(legacyIdNum) || legacyIdNum <= 0) {
            return { success: false, message: '遗府ID无效', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        // 玩家状态校验
        if (player.is_dead) {
            return { success: false, message: '已身死道消，无法参与分宝', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }
        if (player.is_banned) {
            return { success: false, message: '账号已封禁，无法参与分宝', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }
        // 玩家不可对自己的遗府分宝
        // 注意：owner 已经坐化（通常 is_dead=true 或长期不在线），但为防御性，仍校验

        const t = await sequelize.transaction();
        try {
            // 行级锁查询遗府
            const legacy = await CaveLegacy.findByPk(legacyIdNum, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!legacy) {
                await t.rollback();
                return { success: false, message: '遗府不存在', error_code: ErrorCodes.NOT_FOUND };
            }
            if (legacy.status !== 'open') {
                await t.rollback();
                return { success: false, message: `遗府当前状态为 ${legacy.status}，无法分宝`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            // 活动过期校验
            if (legacy.ends_at && new Date() > new Date(legacy.ends_at)) {
                await t.rollback();
                return { success: false, message: '遗府活动已过期', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            // 不可分宝自己的遗府
            if (Number(legacy.owner_player_id) === Number(player.id)) {
                await t.rollback();
                return { success: false, message: '不可分宝自己的遗府', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 行级锁查询或创建参与者记录
            let participant = await CaveLegacyParticipant.findOne({
                where: { legacy_id: legacyIdNum, player_id: player.id },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            if (!participant) {
                // 首次参与：创建记录，计算资格与权重
                const checkResult = await this._checkEligibility(player);
                const weight = checkResult.eligible ? this._calculateWeight(player) : 0;
                // 幸运因子：[lucky_min, lucky_max] 之间的随机值
                const luckyMin = Number(config.distribution?.lucky_factor_min) || 0.8;
                const luckyMax = Number(config.distribution?.lucky_factor_max) || 1.2;
                const luckyFactor = Math.round((luckyMin + Math.random() * (luckyMax - luckyMin)) * 100) / 100;

                participant = await CaveLegacyParticipant.create({
                    legacy_id: legacyIdNum,
                    player_id: player.id,
                    player_nickname_snapshot: player.nickname,
                    player_ip_snapshot: player.ip_address || null,
                    eligible: checkResult.eligible,
                    ineligibility_reason: checkResult.reason || null,
                    weight: weight,
                    lucky_factor: luckyFactor,
                    has_spun: false,
                    total_item_types: 0,
                    total_quantity: 0
                }, { transaction: t });

                // 更新遗府参与者计数
                legacy.participants_count += 1;
            }

            // 资格校验
            if (!participant.eligible) {
                await t.rollback();
                return { success: false, message: `资格不足：${participant.ineligibility_reason || '未达到参与标准'}`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 同主魂唯一领取校验
            const soulCheck = await this._checkSoulUniqueness(player, legacyIdNum, t);
            if (!soulCheck.unique) {
                await t.rollback();
                return { success: false, message: `同主魂玩家 ${soulCheck.existingNickname} 已分宝，不可重复领取`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 已转动校验
            if (participant.has_spun) {
                await t.rollback();
                return { success: false, message: '本期已转动分宝，每期每人只能转动一次', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 执行分宝
            const spinResult = await this._executeSpin(player, legacy, participant, t);
            if (!spinResult.success) {
                await t.rollback();
                return spinResult;
            }

            // 保存参与者状态
            participant.has_spun = true;
            participant.spun_at = new Date();
            participant.total_item_types = spinResult.distributed_items.length;
            participant.total_quantity = spinResult.distributed_items.reduce((sum, i) => sum + i.quantity, 0);
            participant.claimed_at = new Date();
            await participant.save({ transaction: t });

            // 保存遗府（更新了 participants_count）
            await legacy.save({ transaction: t });

            await t.commit();

            // 推送 WebSocket 通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'cave_legacy_spun', {
                    legacy_id: legacy.id,
                    owner_nickname: legacy.owner_nickname_snapshot,
                    distributed_items: spinResult.distributed_items,
                    total_quantity: participant.total_quantity
                });
            } catch (e) {
                console.warn('[CaveLegacyService] 推送分宝结果通知失败:', e.message);
            }

            return {
                success: true,
                message: `分宝成功，共获得 ${participant.total_item_types} 种 ${participant.total_quantity} 件物品`,
                data: {
                    legacy_id: legacy.id,
                    owner_nickname: legacy.owner_nickname_snapshot,
                    distributed_items: spinResult.distributed_items,
                    total_item_types: participant.total_item_types,
                    total_quantity: participant.total_quantity,
                    spun_at: participant.spun_at
                }
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            console.error('[CaveLegacyService] 转动分宝失败:', error);
            return { success: false, message: `转动分宝失败: ${error.message}`, error_code: ErrorCodes.INTERNAL_ERROR };
        }
    }

    /**
     * 查询分宝记录（玩家本人参与过的遗府历史）
     *
     * @param {Object} player - 玩家对象
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {Promise<Object>} { success, message, data }
     */
    async getHistory(player, page = 1, pageSize = 10) {
        const offset = (Number(page) - 1) * Number(pageSize);
        const limit = Number(pageSize);

        // 查询玩家参与的遗府
        const { rows, count } = await CaveLegacyParticipant.findAndCountAll({
            where: { player_id: player.id },
            order: [['created_at', 'DESC']],
            offset,
            limit
        });

        // 关联查询遗府详情和分配日志
        const result = [];
        for (const p of rows) {
            const legacy = await CaveLegacy.findByPk(p.legacy_id);
            if (!legacy) continue;

            // 查询该玩家在此遗府的分配日志
            const logs = await CaveLegacyDistributionLog.findAll({
                where: { legacy_id: p.legacy_id, player_id: player.id },
                order: [['distributed_at', 'DESC']]
            });

            result.push({
                legacy_id: legacy.id,
                owner_nickname: legacy.owner_nickname_snapshot,
                status: legacy.status,
                started_at: legacy.started_at,
                ends_at: legacy.ends_at,
                closed_at: legacy.closed_at,
                participant: {
                    eligible: p.eligible,
                    has_spun: p.has_spun,
                    spun_at: p.spun_at,
                    total_item_types: p.total_item_types,
                    total_quantity: p.total_quantity
                },
                distributed_items: logs.map(log => ({
                    item_key: log.item_key,
                    item_name: log.item_name_snapshot,
                    quantity: log.quantity,
                    distributed_at: log.distributed_at
                }))
            });
        }

        return {
            success: true,
            message: '查询成功',
            data: {
                history: result,
                total: count,
                page: Number(page),
                page_size: Number(pageSize)
            }
        };
    }

    // ==================== 内部方法 ====================

    /**
     * 从坐化玩家储物袋筛选可分配物品
     *
     * 筛选规则（cave_legacy_data.json -> item_filter）：
     *   1. type 必须在 include_types 中（默认 material/consumable）
     *   2. subtype 不在 exclude_subtypes 中（默认排除 quest/badge）
     *   3. quality 在 include_qualities 中（默认 common/uncommon/rare/epic）
     *   4. item_key 不在 exclude_item_keys 中
     *   5. 若 skip_equipped=true，排除已装备的物品（从 player_equipment 表查询 item_key）
     *
     * @param {number} ownerPlayerId - 坐化玩家ID
     * @returns {Promise<Object>} { success, items: [{ item_key, name, type, subtype, quality, quantity }] }
     */
    async _filterInventoryItems(ownerPlayerId) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '坐化遗府配置未加载' };
        }
        const filter = config.item_filter || {};

        // 查询坐化玩家所有储物袋物品
        const playerItems = await Item.findAll({
            where: { player_id: ownerPlayerId }
        });

        // 查询坐化玩家已装备的物品 key（用于排除）
        let equippedKeys = new Set();
        if (filter.skip_equipped !== false) {
            const equipped = await PlayerEquipment.findAll({
                where: { player_id: ownerPlayerId },
                attributes: ['item_key']
            });
            equippedKeys = new Set(equipped.map(e => e.item_key));
        }

        // 加载物品静态配置
        const itemsConfig = configLoader.getConfig('item_data')?.items || [];
        const itemsMap = new Map(itemsConfig.map(i => [i.id, i]));

        // 筛选
        const includeTypes = filter.include_types || ['material', 'consumable'];
        const includeSubtypes = filter.include_subtypes || [];
        const excludeSubtypes = filter.exclude_subtypes || ['quest', 'badge'];
        const includeQualities = filter.include_qualities || ['common', 'uncommon', 'rare', 'epic'];
        const excludeKeys = new Set(filter.exclude_item_keys || []);

        const result = [];
        for (const record of playerItems) {
            // 跳过数量为 0 的记录
            if (!record.quantity || record.quantity <= 0) continue;

            // 排除已装备
            if (equippedKeys.has(record.item_key)) continue;

            // 排除黑名单
            if (excludeKeys.has(record.item_key)) continue;

            // 查物品配置
            const itemCfg = itemsMap.get(record.item_key);
            if (!itemCfg) continue;

            // type 必须在白名单
            if (!includeTypes.includes(itemCfg.type)) continue;

            // subtype 排除
            if (itemCfg.subtype && excludeSubtypes.includes(itemCfg.subtype)) continue;

            // subtype 白名单（若配置了非空 include_subtypes）
            if (includeSubtypes.length > 0 && !includeSubtypes.includes(itemCfg.subtype)) continue;

            // quality 必须在白名单
            if (!includeQualities.includes(itemCfg.quality || 'common')) continue;

            result.push({
                item_key: record.item_key,
                name: itemCfg.name,
                type: itemCfg.type,
                subtype: itemCfg.subtype || null,
                quality: itemCfg.quality || 'common',
                quantity: record.quantity
            });
        }

        return { success: true, items: result };
    }

    /**
     * 检查玩家参与资格（不写库，纯查询）
     *
     * 资格阈值（cave_legacy_data.json -> eligibility）：
     *   - recent_active_days：最近 N 天内有在线记录
     *   - min_online_time_ms：累计在线时长阈值
     *   - min_command_count：总指令数下限（stats JSON）
     *   - min_exp：总修为下限
     *   - min_first_record_days：首次记录时间距今至少 N 天（用 created_at 近似）
     *   - require_channel_bind：是否要求频道身份绑定（暂未实现，预留扩展）
     *
     * @param {Object} player - 玩家对象
     * @returns {Promise<{ eligible: boolean, reason?: string }>}
     */
    async _checkEligibility(player) {
        const config = this.getConfig();
        if (!config) {
            return { eligible: false, reason: '配置未加载' };
        }
        const elig = config.eligibility || {};

        // 1. 近期活跃
        const recentDays = Number(elig.recent_active_days) || 7;
        if (player.last_online) {
            const recentMs = recentDays * 24 * 3600 * 1000;
            if (new Date() - new Date(player.last_online) > recentMs) {
                return { eligible: false, reason: `近 ${recentDays} 天内未在线` };
            }
        } else {
            return { eligible: false, reason: '从未在线记录' };
        }

        // 2. 累计在线时长
        const minOnlineMs = Number(elig.min_online_time_ms) || 1800000;
        const totalOnline = Number(player.total_online_time || 0);
        if (totalOnline < minOnlineMs) {
            return { eligible: false, reason: `累计在线时长不足（需 ${Math.floor(minOnlineMs / 60000)} 分钟，当前 ${Math.floor(totalOnline / 60000)} 分钟）` };
        }

        // 3. 总指令数（stats JSON 的 meditation_count + breakthrough_count + exploration_count 等）
        const minCmd = Number(elig.min_command_count) || 50;
        const stats = player.stats || {};
        const cmdCount = Number(stats.meditation_count || 0)
            + Number(stats.breakthrough_count || 0)
            + Number(stats.kill_count || 0)
            + Number(stats.exploration_count || 0)
            + Number(stats.alchemy_count || 0)
            + Number(stats.refining_count || 0)
            + Number(stats.items_collected || 0)
            + Number(stats.achievements_completed || 0);
        if (cmdCount < minCmd) {
            return { eligible: false, reason: `总指令数不足（需 ${minCmd}，当前 ${cmdCount}）` };
        }

        // 4. 总修为下限
        const minExp = Number(elig.min_exp) || 100;
        const exp = safeNumber(player.exp);
        if (exp < minExp) {
            return { eligible: false, reason: `修为不足（需 ${minExp}，当前 ${exp}）` };
        }

        // 5. 首次记录时间（用 createdAt 近似，Player 模型默认使用 Sequelize 的 createdAt 字段名）
        const minFirstDays = Number(elig.min_first_record_days) || 3;
        if (player.createdAt) {
            const firstMs = minFirstDays * 24 * 3600 * 1000;
            if (new Date() - new Date(player.createdAt) < firstMs) {
                return { eligible: false, reason: `账号注册时间不足 ${minFirstDays} 天` };
            }
        }

        // 6. 频道身份绑定（预留扩展，默认不要求）
        if (elig.require_channel_bind) {
            // TODO: 实现频道身份绑定校验
            // return { eligible: false, reason: '未绑定频道身份' };
        }

        return { eligible: true };
    }

    /**
     * 计算分宝权重
     * weight = log10(exp + 10) * coeff_exp + log10(online_min + 1) * coeff_online
     *
     * @param {Object} player - 玩家对象
     * @returns {number} 权重值（保留 2 位小数）
     */
    _calculateWeight(player) {
        const config = this.getConfig();
        if (!config) return 1.0;
        const dist = config.distribution || {};
        const expCoeff = Number(dist.weight_exp_coeff) || 1.0;
        const onlineCoeff = Number(dist.weight_online_coeff) || 1.5;

        const exp = safeNumber(player.exp);
        const onlineMin = Math.floor(safeNumber(player.total_online_time) / 60000);

        const weightExp = Math.log10(exp + 10) * expCoeff;
        const weightOnline = Math.log10(onlineMin + 1) * onlineCoeff;

        return Math.round((weightExp + weightOnline) * 100) / 100;
    }

    /**
     * 检查同主魂唯一领取
     *
     * 规则：在同一 legacy_id 下，若有其他玩家 player_ip_snapshot 相同且 has_spun=true，则视为同主魂已领取
     *
     * @param {Object} player - 当前玩家
     * @param {number} legacyId - 遗府ID
     * @param {Object} [transaction] - 事务实例
     * @returns {Promise<{ unique: boolean, existingNickname?: string }>}
     */
    async _checkSoulUniqueness(player, legacyId, transaction) {
        if (!player.ip_address) {
            // 无 IP 记录，无法识别同主魂，放行（兼容旧数据）
            return { unique: true };
        }

        const options = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};
        // 查询同 legacy_id 下 IP 相同且 has_spun=true 的其他玩家
        const existing = await CaveLegacyParticipant.findOne({
            where: {
                legacy_id: legacyId,
                player_id: { [Op.ne]: player.id },
                player_ip_snapshot: player.ip_address,
                has_spun: true
            },
            ...options
        });

        if (existing) {
            return { unique: false, existingNickname: existing.player_nickname_snapshot };
        }
        return { unique: true };
    }

    /**
     * 执行一次分宝（内部方法，需在事务中调用）
     *
     * 分配算法（weighted_random）：
     *   1. 查询所有 remaining_quantity > 0 的物品
     *   2. 按 quality 优先级排序（rare > uncommon > common）
     *   3. 每个物品分配数量 = ceil(item.remaining_quantity * weight / sum(weights) * lucky_factor)
     *      但不超过 distribution.max_item_types_per_player 和 distribution.quantity_cap_per_player
     *   4. 扣减 CaveLegacyItem.remaining_quantity
     *   5. 写入 CaveLegacyDistributionLog
     *   6. 通过 InventoryService.addItem 将物品加入玩家储物袋
     *
     * @param {Object} player - 玩家对象（已锁）
     * @param {Object} legacy - 遗府对象（已锁）
     * @param {Object} participant - 参与者对象（已锁）
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} { success, distributed_items: [{ item_key, item_name, quantity }] }
     */
    async _executeSpin(player, legacy, participant, t) {
        const config = this.getConfig();
        if (!config) {
            return { success: false, message: '配置未加载' };
        }
        const dist = config.distribution || {};

        // 查询所有剩余物品（按 quality 优先级排序）
        const qualityOrder = { rare: 0, epic: 1, uncommon: 2, common: 3 };
        const items = await CaveLegacyItem.findAll({
            where: { legacy_id: legacy.id, remaining_quantity: { [Op.gt]: 0 } },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (items.length === 0) {
            return { success: false, message: '遗府物品已全部分配完毕' };
        }

        // 按 quality 排序：rare 优先分配
        items.sort((a, b) => {
            const qa = qualityOrder[a.item_quality_snapshot] ?? 99;
            const qb = qualityOrder[b.item_quality_snapshot] ?? 99;
            return qa - qb;
        });

        // 计算每个物品的分配数量
        const maxItemTypes = Number(dist.max_item_types_per_player) || 5;
        const quantityCap = Number(dist.quantity_cap_per_player) || 50;
        const weight = Number(participant.weight) || 1.0;
        const luckyFactor = Number(participant.lucky_factor) || 1.0;

        // 估算总权重（简化：假设其他参与者权重之和为 legacy.participants_count * avgWeight）
        // 实际使用：每个物品分配数量 = max(1, ceil(item.remaining * weight / totalEstimatedWeight * luckyFactor))
        // 但为保证玩家至少分到东西，使用简化版：每个物品分配 = max(1, ceil(item.remaining * ratio * luckyFactor))
        //   其中 ratio = min(0.3, maxItemTypes / items.length)
        const ratio = Math.min(0.3, maxItemTypes / Math.max(1, items.length));

        const distributed = [];
        let totalDistributed = 0;
        let typeCount = 0;

        for (const item of items) {
            // 达到上限停止
            if (typeCount >= maxItemTypes) break;
            if (totalDistributed >= quantityCap) break;

            // 计算本次分配数量
            const rawQty = Math.ceil(item.remaining_quantity * ratio * luckyFactor);
            // 至少 1，最多不超过 remaining_quantity 和 quantityCap - totalDistributed
            const qty = Math.max(1, Math.min(
                rawQty,
                item.remaining_quantity,
                quantityCap - totalDistributed
            ));

            if (qty <= 0) continue;

            // 扣减物品剩余数量
            item.remaining_quantity -= qty;
            await item.save({ transaction: t });

            // 写入分配日志
            await CaveLegacyDistributionLog.create({
                legacy_id: legacy.id,
                player_id: player.id,
                item_key: item.item_key,
                item_name_snapshot: item.item_name_snapshot,
                quantity: qty,
                source: 'spin'
            }, { transaction: t });

            // 将物品加入玩家储物袋（事务内）
            try {
                await InventoryService.addItem(player.id, item.item_key, qty, t);
            } catch (addItemErr) {
                // 容量不足等错误：回滚此物品分配（不分配此物品）
                console.warn(`[CaveLegacyService] 玩家 ${player.id} 储物袋已满，跳过 ${item.item_name_snapshot}:`, addItemErr.message);
                // 恢复物品剩余数量
                item.remaining_quantity += qty;
                await item.save({ transaction: t });
                continue;
            }

            distributed.push({
                item_key: item.item_key,
                item_name: item.item_name_snapshot,
                quantity: qty
            });
            totalDistributed += qty;
            typeCount += 1;
        }

        if (distributed.length === 0) {
            return { success: false, message: '储物袋容量不足，无法分宝' };
        }

        return { success: true, distributed_items: distributed };
    }

    /**
     * 结算遗府（处理未分配物品）
     *
     * 处理规则（cave_legacy_data.json -> settlement.unclaimed_items）：
     *   - destroy：销毁未分配物品（默认）
     *   - return_to_owner：退回原主（若原主仍存活）
     *
     * @param {Object} legacy - 遗府对象（已锁）
     * @param {string} closeReason - 关闭原因（admin_close/expired/auto_close）
     * @param {number} closedByAdmin - 关闭操作的管理员ID（null=自动关闭）
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} { summary: { unclaimed_items_count, unclaimed_total_quantity, action, returned_to_owner? } }
     */
    async _settleLegacy(legacy, closeReason, closedByAdmin, t) {
        const config = this.getConfig();
        const settleCfg = config?.settlement || {};
        const action = settleCfg.unclaimed_items || 'destroy';

        // 查询所有未分配物品
        const unclaimedItems = await CaveLegacyItem.findAll({
            where: { legacy_id: legacy.id, remaining_quantity: { [Op.gt]: 0 } },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        const summary = {
            unclaimed_items_count: unclaimedItems.length,
            unclaimed_total_quantity: unclaimedItems.reduce((sum, i) => sum + i.remaining_quantity, 0),
            action,
            returned_to_owner: 0,
            destroyed: 0
        };

        if (unclaimedItems.length === 0) {
            return { summary };
        }

        if (action === 'return_to_owner') {
            // 退回原主（若原主仍存活）
            const owner = await Player.findByPk(legacy.owner_player_id, { transaction: t });
            if (owner && !owner.is_dead) {
                for (const item of unclaimedItems) {
                    try {
                        await InventoryService.addItem(owner.id, item.item_key, item.remaining_quantity, t);
                        summary.returned_to_owner += item.remaining_quantity;
                    } catch (e) {
                        // 原主储物袋满等错误：销毁
                        summary.destroyed += item.remaining_quantity;
                    }
                    item.remaining_quantity = 0;
                    await item.save({ transaction: t });
                }
            } else {
                // 原主已死或不存在：销毁
                for (const item of unclaimedItems) {
                    summary.destroyed += item.remaining_quantity;
                    item.remaining_quantity = 0;
                    await item.save({ transaction: t });
                }
            }
        } else {
            // destroy：销毁
            for (const item of unclaimedItems) {
                summary.destroyed += item.remaining_quantity;
                item.remaining_quantity = 0;
                await item.save({ transaction: t });
            }
        }

        return { summary };
    }

    /**
     * 估算合格玩家数量（异步统计，限制扫描行数）
     *
     * @param {Object} owner - 坐化玩家对象（用于排除自己）
     * @returns {Promise<Object>} { count, criteria }
     */
    async _estimateEligiblePlayers(owner) {
        const config = this.getConfig();
        if (!config) {
            return { count: 0, criteria: {} };
        }
        const elig = config.eligibility || {};
        const recentDays = Number(elig.recent_active_days) || 7;
        const recentMs = recentDays * 24 * 3600 * 1000;
        const recentDate = new Date(Date.now() - recentMs);
        const minOnlineMs = Number(elig.min_online_time_ms) || 1800000;
        const minExp = Number(elig.min_exp) || 100;
        const minFirstDays = Number(elig.min_first_record_days) || 3;
        const firstMs = minFirstDays * 24 * 3600 * 1000;
        const firstDate = new Date(Date.now() - firstMs);

        // 查询满足基本条件的玩家（排除自己 + 排除死亡 + 排除封禁）
        // 注意：Player 模型未启用 underscored，时间戳字段为 Sequelize 默认的 createdAt/updatedAt
        const candidates = await Player.count({
            where: {
                id: { [Op.ne]: owner.id },
                is_dead: false,
                is_banned: false,
                last_online: { [Op.gte]: recentDate },
                total_online_time: { [Op.gte]: minOnlineMs },
                createdAt: { [Op.lte]: firstDate },
                exp: { [Op.gte]: minExp }
            }
        });

        return {
            count: candidates,
            criteria: {
                recent_active_days: recentDays,
                min_online_time_ms: minOnlineMs,
                min_exp: minExp,
                min_first_record_days: minFirstDays
            }
        };
    }

    /**
     * 调度器调用：检查过期遗府并自动关闭
     *
     * 业务流程：
     *   1. 查询所有 status=open 且 ends_at < now 的遗府
     *   2. 对每个过期遗府执行 _settleLegacy + 标记 close_reason=expired
     *   3. 推送 WebSocket 通知
     *
     * @returns {Promise<Object>} { processed, expired_count }
     */
    async checkExpiredLegacies() {
        const config = this.getConfig();
        if (!config) {
            return { processed: 0, expired_count: 0 };
        }

        const now = new Date();
        const expiredLegacies = await CaveLegacy.findAll({
            where: {
                status: 'open',
                ends_at: { [Op.lt]: now }
            }
        });

        let expiredCount = 0;
        for (const legacy of expiredLegacies) {
            const t = await sequelize.transaction();
            try {
                // 行级锁重新查询
                const locked = await CaveLegacy.findByPk(legacy.id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!locked || locked.status !== 'open') {
                    await t.rollback();
                    continue;
                }

                const settleResult = await this._settleLegacy(locked, 'expired', null, t);

                locked.status = 'closed';
                locked.closed_at = new Date();
                locked.closed_by_admin = null;
                locked.close_reason = 'expired';
                locked.settled = true;
                locked.summary_json = settleResult.summary;
                await locked.save({ transaction: t });

                await t.commit();
                expiredCount += 1;

                // 推送通知
                try {
                    WebSocketNotificationService.broadcastNotification({
                        type: 'cave_legacy_expired',
                        title: '遗府过期',
                        content: `${locked.owner_nickname_snapshot} 的遗府已过期自动关闭。`,
                        level: 'info',
                        legacy_id: locked.id
                    });
                } catch (e) {
                    console.warn('[CaveLegacyService] 推送遗府过期通知失败:', e.message);
                }
            } catch (err) {
                if (t && !t.finished) await t.rollback();
                console.error(`[CaveLegacyService] 关闭过期遗府 ${legacy.id} 失败:`, err.message);
            }
        }

        return { processed: expiredLegacies.length, expired_count: expiredCount };
    }
}

// 单例导出，便于调度器调用 checkExpiredLegacies
module.exports = new CaveLegacyService();
