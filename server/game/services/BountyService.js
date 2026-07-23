/**
 * PVP 悬赏服务
 *
 * 提供玩家间悬赏追杀玩法的核心业务逻辑：
 * 1. publishBounty：发布悬赏（扣灵石含手续费、设过期时间、WS 通知目标）
 * 2. acceptBounty：接取悬赏（冷却校验、自动发起 bounty 类型 PVP 战斗）
 * 3. getBountyList：悬赏榜单分页查询（支持状态过滤）
 * 4. getMyBounties：我的悬赏（发布 + 接取）
 * 5. cancelBounty：取消悬赏（仅 active 可取消，退灵石扣手续费）
 * 6. cleanExpiredBounties：清理过期悬赏（退全额灵石给发布者）
 * 7. settleBountyByBattle：战斗结束后结算悬赏（胜者拿赏金，败则悬赏回流）
 * 8. settlePendingBountyBattles：扫描已接取悬赏对应的已结束战斗并结算
 *
 * 设计原则：
 * - 所有可变参数从 game_balance.json pvp_extended.bounty 段读取，禁止硬编码
 * - 多表/多字段变更使用事务 + 行级锁（player + player_bounties）
 * - BigInt 安全：spirit_stones 和 bounty_amount 使用 BigInt 运算
 * - WebSocket 推送通过 WebSocketNotificationService.notifyPlayerUpdate
 * - 不直接操作 HTTP 响应，由路由层处理
 * - 接取悬赏后调用 PvpService.challenge(battle_type='bounty') 发起战斗
 * - 战斗结算通过扫描机制（settlePendingBountyBattles）异步完成，避免修改 PvpService
 */
'use strict';

const Player = require('../../models/player');
const PlayerBounty = require('../../models/playerBounty');
const PvpBattleRecord = require('../../models/pvpBattleRecord');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * 直接 BigInt(null) 会抛 TypeError，导致接口 500
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined 返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    // 统一转字符串再转 BigInt，避免 number 精度丢失
    return BigInt(String(value));
}

/**
 * 悬赏状态常量
 * 与 playerBounty 模型中 status 字段保持一致
 */
const BountyStatus = {
    ACTIVE: 'active',         // 悬赏中，等待接单
    ACCEPTED: 'accepted',     // 已接单，战斗进行中
    COMPLETED: 'completed',   // 已完成（接单者击杀目标）
    EXPIRED: 'expired',       // 已过期（超时无人接单）
    CANCELLED: 'cancelled'    // 已取消（发布者主动取消）
};

class BountyService {
    constructor() {
        // 配置加载器，通过 initialize 注入；未注入时回退到全局 infrastructure.ConfigLoader
        this.configLoader = null;
    }

    /**
     * 初始化悬赏服务，注入配置加载器
     * 由外部启动流程调用，确保配置读取一致性
     * @param {Object} configLoader - 配置加载器实例（infrastructure.ConfigLoader）
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 获取配置加载器实例
     * 优先使用注入的实例，未注入时回退到全局 infrastructure.ConfigLoader
     * @returns {Object} 配置加载器实例
     * @private
     */
    _getConfigLoader() {
        if (this.configLoader) {
            return this.configLoader;
        }
        // 回退到全局配置加载器，与 PvpService 保持一致
        const { infrastructure } = require('../../modules');
        this.configLoader = infrastructure.ConfigLoader;
        return this.configLoader;
    }

    /**
     * 读取悬赏配置
     * 从 game_balance.json -> pvp_extended.bounty 段读取
     * @returns {Object} 悬赏配置对象
     * @private
     */
    _getBountyConfig() {
        const loader = this._getConfigLoader();
        const config = loader.getConfig('game_balance');
        return config?.pvp_extended?.bounty || {};
    }

    /**
     * 发布悬赏
     *
     * 校验规则：
     * - 悬赏系统全局开启（enabled=true）
     * - 不能悬赏自己
     * - 悬赏金额在 min_bounty_amount ~ max_bounty_amount 范围内
     * - 发布者境界排名 >= min_realm_rank_to_publish
     * - 发布者活跃悬赏数 < max_active_bounties_per_player
     * - 目标玩家存在且 pvp_mode='active'（入世状态才能被悬赏）
     * - 发布者灵石 >= 悬赏金额 + 平台手续费
     *
     * 扣费逻辑：
     * - 总扣除 = 悬赏金额 + 手续费（fee = amount * platform_fee_rate）
     * - bounty_amount 字段存储纯悬赏金额（不含手续费）
     *
     * @param {number} playerId - 发布者玩家ID
     * @param {number} targetId - 目标玩家ID
     * @param {number} amount - 悬赏金额（灵石）
     * @param {string} [reason] - 悬赏理由（可选）
     * @returns {Promise<Object>} 悬赏详情
     */
    async publishBounty(playerId, targetId, amount, reason) {
        const cfg = this._getBountyConfig();

        // 全局开关校验
        if (cfg.enabled === false) {
            throw new AppError('悬赏系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验：不能悬赏自己
        if (Number(playerId) === Number(targetId)) {
            throw new AppError('不可悬赏自己', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验：悬赏金额范围
        const minAmount = cfg.min_bounty_amount ?? 100;
        const maxAmount = cfg.max_bounty_amount ?? 100000;
        const amountNum = Number(amount);
        if (!Number.isFinite(amountNum) || amountNum < minAmount || amountNum > maxAmount) {
            throw new AppError(
                `悬赏金额必须在 ${minAmount} ~ ${maxAmount} 灵石之间`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 理由长度校验（防止超长文本）
        if (reason && reason.length > 200) {
            throw new AppError('悬赏理由不能超过 200 字', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁发布者
            const publisher = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!publisher) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (publisher.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法发布悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (publisher.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁，无法发布悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 发布者境界校验
            const publisherRealmRank = Number(publisher.realm_rank) || 0;
            const minRealmRank = cfg.min_realm_rank_to_publish ?? 3;
            if (publisherRealmRank < minRealmRank) {
                await t.commit();
                throw new AppError(
                    `境界不足，需达到境界排名 ${minRealmRank} 以上方可发布悬赏`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 发布者活跃悬赏数量校验（active + accepted 均计入活跃）
            const activeCount = await PlayerBounty.count({
                where: {
                    publisher_id: playerId,
                    status: { [Op.in]: [BountyStatus.ACTIVE, BountyStatus.ACCEPTED] }
                },
                transaction: t
            });
            const maxActive = cfg.max_active_bounties_per_player ?? 5;
            if (activeCount >= maxActive) {
                await t.commit();
                throw new AppError(
                    `活跃悬赏数已达上限（${maxActive} 个），请先完成或取消现有悬赏`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 行级锁目标玩家
            const target = await Player.findByPk(targetId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!target) {
                await t.commit();
                throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (target.is_dead) {
                await t.commit();
                throw new AppError('目标已身死道消，无法悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 目标 PVP 模式校验：必须为入世状态才能被悬赏
            if (target.pvp_mode !== 'active') {
                await t.commit();
                throw new AppError('目标处于避世状态，无法被悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 保护期校验：目标玩家最近完成悬赏后的一段保护期内不可被再次悬赏
            // 防止恶意连续悬赏同一玩家，增加社交公平性
            const protectionMinutes = cfg.protection_period_minutes ?? 30;
            if (protectionMinutes > 0) {
                const protectionDeadline = new Date(Date.now() - protectionMinutes * 60 * 1000);
                const recentCompleted = await PlayerBounty.findOne({
                    where: {
                        target_id: targetId,
                        status: BountyStatus.COMPLETED,
                        completed_at: { [Op.gt]: protectionDeadline }
                    },
                    transaction: t
                });
                if (recentCompleted) {
                    await t.commit();
                    const remainMin = Math.ceil(
                        (new Date(recentCompleted.completed_at).getTime() + protectionMinutes * 60 * 1000 - Date.now()) / 60000
                    );
                    throw new AppError(
                        `目标处于悬赏保护期内，剩余 ${remainMin} 分钟，暂不可被悬赏`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 计算总扣除：悬赏金额 + 平台手续费
            const feeRate = cfg.platform_fee_rate ?? 0.05;
            const feeNum = Math.floor(amountNum * feeRate);
            const totalCostNum = amountNum + feeNum;
            const totalCost = BigInt(totalCostNum);

            // 灵石余额校验
            const publisherStones = safeBigInt(publisher.spirit_stones);
            if (publisherStones < totalCost) {
                await t.commit();
                throw new AppError(
                    `灵石不足，本次悬赏需消耗 ${totalCostNum} 灵石（含手续费 ${feeNum}）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 扣除灵石
            publisher.spirit_stones = publisherStones - totalCost;
            await publisher.save({ transaction: t });

            // 计算过期时间
            const expireHours = cfg.bounty_expire_hours ?? 72;
            const now = new Date();
            const expireAt = new Date(now.getTime() + expireHours * 60 * 60 * 1000);

            // 创建悬赏记录
            const bounty = await PlayerBounty.create({
                publisher_id: playerId,
                target_id: targetId,
                bounty_amount: amountNum,
                status: BountyStatus.ACTIVE,
                acceptor_id: null,
                accepted_at: null,
                completed_at: null,
                expire_at: expireAt,
                battle_record_id: null,
                reason: reason || null
            }, { transaction: t });

            await t.commit();

            // 异步推送：通知目标玩家被悬赏
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(targetId, 'bounty_published', {
                    bounty_id: bounty.id,
                    publisher_id: playerId,
                    publisher_nickname: publisher.nickname,
                    bounty_amount: amountNum,
                    reason: reason || null,
                    expire_at: expireAt.toISOString()
                });
            } catch (e) {
                /* 推送失败不阻塞主流程 */
            }

            return {
                bounty_id: bounty.id,
                publisher: {
                    id: publisher.id,
                    nickname: publisher.nickname
                },
                target: {
                    id: target.id,
                    nickname: target.nickname,
                    realm: target.realm,
                    realm_rank: target.realm_rank
                },
                bounty_amount: amountNum,
                platform_fee: feeNum,
                total_cost: totalCostNum,
                status: BountyStatus.ACTIVE,
                reason: reason || null,
                expire_at: expireAt.toISOString(),
                created_at: bounty.created_at
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 接取悬赏
     *
     * 校验规则：
     * - 悬赏系统全局开启
     * - 接单者境界排名 >= min_realm_rank_to_accept
     * - 悬赏状态为 active 且未过期
     * - 接单者不是发布者和目标
     * - 接单冷却时间（accept_cooldown_seconds）内不可重复接单
     *
     * 流程：
     * 1. 事务内锁定悬赏记录，校验并更新为 accepted
     * 2. 调用 PvpService.challenge() 发起 bounty 类型 PVP 战斗
     * 3. 战斗发起成功后回写 battle_record_id
     * 4. 若战斗发起失败，回滚悬赏状态为 active
     *
     * @param {number} playerId - 接单者玩家ID
     * @param {number} bountyId - 悬赏ID
     * @returns {Promise<Object>} 战斗信息
     */
    async acceptBounty(playerId, bountyId) {
        const cfg = this._getBountyConfig();

        // 全局开关校验
        if (cfg.enabled === false) {
            throw new AppError('悬赏系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 预校验：接单者境界（无需事务，只读查询）
        const acceptor = await Player.findByPk(playerId);
        if (!acceptor) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (acceptor.is_dead) {
            throw new AppError('已身死道消，无法接取悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (acceptor.is_banned) {
            throw new AppError('账号已封禁，无法接取悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        const acceptorRealmRank = Number(acceptor.realm_rank) || 0;
        const minRealmRank = cfg.min_realm_rank_to_accept ?? 3;
        if (acceptorRealmRank < minRealmRank) {
            throw new AppError(
                `境界不足，需达到境界排名 ${minRealmRank} 以上方可接取悬赏`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 接单冷却校验：查询该玩家最近一次接单时间
        const cooldownSeconds = cfg.accept_cooldown_seconds ?? 300;
        const lastAccept = await this._getLastAcceptTime(playerId);
        if (lastAccept) {
            const elapsed = (Date.now() - lastAccept.getTime()) / 1000;
            if (elapsed < cooldownSeconds) {
                const remain = Math.ceil(cooldownSeconds - elapsed);
                throw new AppError(
                    `接单冷却中，请 ${remain} 秒后再试`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
        }

        // 事务：锁定悬赏记录，校验并更新为 accepted
        const t = await sequelize.transaction();
        let bounty;
        let targetId;
        try {
            // 行级锁悬赏记录，防止并发接单
            bounty = await PlayerBounty.findByPk(bountyId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!bounty) {
                await t.commit();
                throw new AppError('悬赏不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 状态校验：仅 active 可接取
            if (bounty.status !== BountyStatus.ACTIVE) {
                await t.commit();
                throw new AppError(
                    `悬赏状态为 ${bounty.status}，无法接取`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 过期校验：expire_at 已过则不可接取
            const now = new Date();
            if (bounty.expire_at && new Date(bounty.expire_at) < now) {
                await t.commit();
                throw new AppError('悬赏已过期，无法接取', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 接单者不可为发布者
            if (Number(bounty.publisher_id) === Number(playerId)) {
                await t.commit();
                throw new AppError('不可接取自己发布的悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 接单者不可为目标
            if (Number(bounty.target_id) === Number(playerId)) {
                await t.commit();
                throw new AppError('不可接取针对自己的悬赏', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 更新悬赏状态为 accepted，记录接单者和接单时间
            targetId = bounty.target_id;
            bounty.status = BountyStatus.ACCEPTED;
            bounty.acceptor_id = playerId;
            bounty.accepted_at = now;
            await bounty.save({ transaction: t });

            await t.commit();
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }

        // 调用 PvpService.challenge() 发起 bounty 类型战斗
        // 延迟 require 避免循环依赖
        const PvpService = require('./PvpService');
        try {
            const battleResult = await PvpService.challenge(playerId, targetId, 'bounty');

            // 战斗发起成功，回写 battle_record_id
            await PlayerBounty.update(
                { battle_record_id: battleResult.battle_id },
                { where: { id: bountyId, status: BountyStatus.ACCEPTED } }
            );

            // 异步推送：通知发布者有人接单
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(bounty.publisher_id, 'bounty_accepted', {
                    bounty_id: bountyId,
                    acceptor_id: playerId,
                    acceptor_nickname: acceptor.nickname,
                    battle_id: battleResult.battle_id
                });
            } catch (e) {
                /* 推送失败不阻塞 */
            }

            return {
                bounty_id: bountyId,
                battle_id: battleResult.battle_id,
                battle_type: battleResult.battle_type,
                opponent_info: battleResult.opponent_info,
                attacker_power: battleResult.attacker_power,
                defender_power: battleResult.defender_power,
                first_attacker: battleResult.first_attacker,
                spirit_stone_cost: battleResult.spirit_stone_cost,
                started_at: battleResult.started_at
            };
        } catch (err) {
            // 战斗发起失败，回滚悬赏状态为 active，允许其他人接取
            try {
                await PlayerBounty.update(
                    {
                        status: BountyStatus.ACTIVE,
                        acceptor_id: null,
                        accepted_at: null
                    },
                    {
                        where: {
                            id: bountyId,
                            status: BountyStatus.ACCEPTED
                        }
                    }
                );
            } catch (revertErr) {
                // 回滚失败记录日志，不影响错误抛出
                console.warn(`[BountyService] 悬赏 ${bountyId} 状态回滚失败:`, revertErr.message);
            }
            throw err;
        }
    }

    /**
     * 获取悬赏榜单
     * 支持按状态过滤，分页查询，包含发布者与目标基础信息
     * @param {number} page - 页码（从 1 开始）
     * @param {number} pageSize - 每页数量
     * @param {string} [status] - 状态过滤（active/accepted/completed/expired/cancelled）
     * @returns {Promise<Object>} 分页结果 { list, total, page, page_size }
     */
    async getBountyList(page = 1, pageSize = 20, status) {
        const safePage = Math.max(1, parseInt(page) || 1);
        const safePageSize = Math.min(Math.max(1, parseInt(pageSize) || 20), 100);
        const offset = (safePage - 1) * safePageSize;

        // 构建查询条件
        const where = {};
        const validStatuses = [
            BountyStatus.ACTIVE, BountyStatus.ACCEPTED, BountyStatus.COMPLETED,
            BountyStatus.EXPIRED, BountyStatus.CANCELLED
        ];
        if (status && validStatuses.includes(status)) {
            where.status = status;
        }

        // 分页查询
        const { count, rows } = await PlayerBounty.findAndCountAll({
            where,
            order: [['created_at', 'DESC']],
            limit: safePageSize,
            offset
        });

        if (rows.length === 0) {
            return {
                list: [],
                total: count,
                page: safePage,
                page_size: safePageSize
            };
        }

        // 批量查询发布者和目标玩家信息（避免 N+1）
        const playerIds = new Set();
        for (const r of rows) {
            playerIds.add(r.publisher_id);
            playerIds.add(r.target_id);
            if (r.acceptor_id) playerIds.add(r.acceptor_id);
        }
        const players = await Player.findAll({
            where: { id: Array.from(playerIds) },
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        const playerMap = new Map(players.map(p => [p.id, p]));

        // 拼装结果
        const list = rows.map(r => this._formatBountyDetail(r, playerMap));

        return {
            list,
            total: count,
            page: safePage,
            page_size: safePageSize
        };
    }

    /**
     * 获取我的悬赏（发布的 + 接取的 + 针对我的）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { published: [], accepted: [], targeting_me: [] }
     */
    async getMyBounties(playerId) {
        // 查询我发布的悬赏
        const published = await PlayerBounty.findAll({
            where: { publisher_id: playerId },
            order: [['created_at', 'DESC']]
        });

        // 查询我接取的悬赏
        const accepted = await PlayerBounty.findAll({
            where: { acceptor_id: playerId },
            order: [['accepted_at', 'DESC']]
        });

        // 查询针对我的悬赏（我是 target，且状态为 active 或 accepted）
        // 用于反悬赏功能：被悬赏者可在"针对我的"列表中对悬赏者发起反悬赏
        const targetingMe = await PlayerBounty.findAll({
            where: {
                target_id: playerId,
                status: { [Op.in]: [BountyStatus.ACTIVE, BountyStatus.ACCEPTED] }
            },
            order: [['created_at', 'DESC']]
        });

        // 批量查询关联玩家信息
        const playerIds = new Set();
        for (const r of [...published, ...accepted, ...targetingMe]) {
            playerIds.add(r.publisher_id);
            playerIds.add(r.target_id);
            if (r.acceptor_id) playerIds.add(r.acceptor_id);
        }
        const players = await Player.findAll({
            where: { id: Array.from(playerIds) },
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        const playerMap = new Map(players.map(p => [p.id, p]));

        return {
            published: published.map(r => this._formatBountyDetail(r, playerMap)),
            accepted: accepted.map(r => this._formatBountyDetail(r, playerMap)),
            targeting_me: targetingMe.map(r => this._formatBountyDetail(r, playerMap))
        };
    }

    /**
     * 取消悬赏
     * 仅发布者可取消，仅 active 状态可取消
     * 退还悬赏金（扣除手续费 platform_fee_rate）
     * @param {number} playerId - 玩家ID（须为发布者）
     * @param {number} bountyId - 悬赏ID
     * @returns {Promise<Object>} 取消结果
     */
    async cancelBounty(playerId, bountyId) {
        const cfg = this._getBountyConfig();
        const feeRate = cfg.platform_fee_rate ?? 0.05;

        const t = await sequelize.transaction();
        try {
            // 行级锁悬赏记录
            const bounty = await PlayerBounty.findByPk(bountyId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!bounty) {
                await t.commit();
                throw new AppError('悬赏不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 权限校验：仅发布者可取消
            if (Number(bounty.publisher_id) !== Number(playerId)) {
                await t.commit();
                throw new AppError('仅发布者可取消悬赏', 403, ErrorCodes.UNAUTHORIZED);
            }

            // 状态校验：仅 active 可取消
            if (bounty.status !== BountyStatus.ACTIVE) {
                await t.commit();
                throw new AppError(
                    `悬赏状态为 ${bounty.status}，仅悬赏中（active）状态可取消`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 计算退还金额：bounty_amount * (1 - platform_fee_rate)
            const amountNum = Number(safeBigInt(bounty.bounty_amount));
            const refundNum = Math.floor(amountNum * (1 - feeRate));
            const refund = BigInt(refundNum);

            // 行级锁发布者，退还灵石
            const publisher = await Player.findByPk(bounty.publisher_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (publisher) {
                publisher.spirit_stones = safeBigInt(publisher.spirit_stones) + refund;
                await publisher.save({ transaction: t });
            }

            // 更新悬赏状态为 cancelled
            bounty.status = BountyStatus.CANCELLED;
            await bounty.save({ transaction: t });

            await t.commit();

            // 异步推送：通知目标玩家悬赏已取消
            try {
                const WebSocketNotificationService = require('./WebSocketNotificationService');
                WebSocketNotificationService.notifyPlayerUpdate(bounty.target_id, 'bounty_cancelled', {
                    bounty_id: bountyId,
                    publisher_id: bounty.publisher_id
                });
            } catch (e) {
                /* 推送失败不阻塞 */
            }

            return {
                bounty_id: bountyId,
                status: BountyStatus.CANCELLED,
                refund_amount: refundNum,
                fee_deducted: amountNum - refundNum
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 反悬赏：被悬赏者对悬赏者发起反向悬赏
     *
     * 设计目的：增加 PVP 社交博弈深度。被悬赏的玩家不只能被动防守，
     * 还可以花费灵石主动反击，对悬赏自己的人发起反向悬赏。
     *
     * 校验规则：
     * - 反悬赏功能全局开启（counter_bounty.enabled=true）
     * - 原悬赏存在且状态为 active 或 accepted
     * - 调用者为原悬赏的 target_id（只有被悬赏者才能反悬赏）
     * - 反悬赏链深度未超上限（max_counter_chain，通过 reason 前缀计数）
     * - 反悬赏金额 = 原悬赏金额 * amount_multiplier
     *
     * 流程：
     * 1. 查询原悬赏，校验调用者身份与状态
     * 2. 计算反悬赏链深度（reason 中 [反悬赏] 前缀出现次数）
     * 3. 计算反悬赏金额
     * 4. 调用 publishBounty 创建反向悬赏（复用所有校验逻辑）
     *
     * @param {number} playerId - 调用者玩家ID（须为原悬赏的 target）
     * @param {number} bountyId - 原悬赏ID
     * @param {string} [reason] - 反悬赏理由（可选）
     * @returns {Promise<Object>} 反悬赏详情
     */
    async counterBounty(playerId, bountyId, reason) {
        const cfg = this._getBountyConfig();
        const counterCfg = cfg.counter_bounty || {};

        // 反悬赏功能开关校验
        if (counterCfg.enabled === false) {
            throw new AppError('反悬赏功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 查询原悬赏记录（只读，无需事务）
        const originalBounty = await PlayerBounty.findByPk(bountyId);
        if (!originalBounty) {
            throw new AppError('原悬赏不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 状态校验：仅 active 或 accepted 状态的原悬赏可被反悬赏
        if (originalBounty.status !== BountyStatus.ACTIVE &&
            originalBounty.status !== BountyStatus.ACCEPTED) {
            throw new AppError(
                `原悬赏状态为 ${originalBounty.status}，仅悬赏中或已接单状态可反悬赏`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 身份校验：仅原悬赏的目标玩家可发起反悬赏
        if (Number(originalBounty.target_id) !== Number(playerId)) {
            throw new AppError('仅悬赏目标本人可发起反悬赏', 403, ErrorCodes.UNAUTHORIZED);
        }

        // 反悬赏链深度校验：通过原悬赏 reason 中的 [反悬赏] 前缀计数
        // 每次反悬赏在 reason 前添加 prefix，链深度 = prefix 出现次数
        const prefix = counterCfg.reason_prefix || '[反悬赏]';
        const maxChain = counterCfg.max_counter_chain ?? 3;
        const originalReason = originalBounty.reason || '';
        const chainDepth = originalReason.split(prefix).length - 1;
        if (chainDepth >= maxChain) {
            throw new AppError(
                `反悬赏链已达上限（${maxChain} 次），不可继续反悬赏`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 计算反悬赏金额：原悬赏金额 * 倍率
        const multiplier = counterCfg.amount_multiplier ?? 1.2;
        const originalAmount = Number(safeBigInt(originalBounty.bounty_amount));
        const counterAmount = Math.floor(originalAmount * multiplier);

        // 金额范围校验（防止超出配置上下限）
        const minAmount = cfg.min_bounty_amount ?? 100;
        const maxAmount = cfg.max_bounty_amount ?? 100000;
        if (counterAmount < minAmount || counterAmount > maxAmount) {
            throw new AppError(
                `反悬赏金额 ${counterAmount} 超出范围（${minAmount} ~ ${maxAmount}）`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 构建反悬赏理由：前缀 + 原理由（链深度通过前缀计数）
        const counterReason = reason
            ? `${prefix}${reason}`
            : `${prefix}反击悬赏`;

        // 调用 publishBounty 创建反向悬赏（复用所有校验逻辑：灵石扣除、保护期、PVP模式等）
        // 反悬赏方向：原 target → 原 publisher（身份互换）
        const result = await this.publishBounty(
            playerId,                              // 反悬赏发起者 = 原悬赏目标
            originalBounty.publisher_id,           // 反悬赏目标 = 原悬赏发布者
            counterAmount,
            counterReason
        );

        // 附加反悬赏元信息
        return {
            ...result,
            is_counter_bounty: true,
            original_bounty_id: bountyId,
            counter_chain_depth: chainDepth + 1,
            original_amount: originalAmount,
            counter_multiplier: multiplier
        };
    }

    /**
     * 清理过期悬赏
     * 将超时未接取的悬赏（status=active 且 expire_at < now）标记为 expired
     * 全额退还悬赏金给发布者（系统过期无惩罚）
     * @returns {Promise<Object>} 清理统计 { scanned, cleaned, failed }
     */
    async cleanExpiredBounties() {
        const stats = { scanned: 0, cleaned: 0, failed: 0 };
        const now = new Date();

        // 查询所有过期的 active 悬赏
        const expiredBounties = await PlayerBounty.findAll({
            where: {
                status: BountyStatus.ACTIVE,
                expire_at: { [Op.lt]: now }
            },
            order: [['expire_at', 'ASC']]
        });

        stats.scanned = expiredBounties.length;

        for (const bounty of expiredBounties) {
            const t = await sequelize.transaction();
            try {
                // 行级锁悬赏记录，防止与接单并发
                const locked = await PlayerBounty.findByPk(bounty.id, {
                    lock: t.LOCK.UPDATE,
                    transaction: t
                });
                if (!locked || locked.status !== BountyStatus.ACTIVE) {
                    // 状态已变更（可能刚好被接取），跳过
                    await t.commit();
                    continue;
                }

                // 全额退还悬赏金（系统过期无手续费惩罚）
                const refundNum = Number(safeBigInt(locked.bounty_amount));
                const refund = BigInt(refundNum);

                // 行级锁发布者，退还灵石
                const publisher = await Player.findByPk(locked.publisher_id, {
                    lock: t.LOCK.UPDATE,
                    transaction: t
                });
                if (publisher) {
                    publisher.spirit_stones = safeBigInt(publisher.spirit_stones) + refund;
                    await publisher.save({ transaction: t });
                }

                // 更新悬赏状态为 expired
                locked.status = BountyStatus.EXPIRED;
                await locked.save({ transaction: t });

                await t.commit();
                stats.cleaned += 1;

                // 异步推送：通知发布者悬赏已过期退款
                try {
                    const WebSocketNotificationService = require('./WebSocketNotificationService');
                    WebSocketNotificationService.notifyPlayerUpdate(locked.publisher_id, 'bounty_expired', {
                        bounty_id: locked.id,
                        refund_amount: refundNum
                    });
                } catch (e) {
                    /* 推送失败不影响清理 */
                }
            } catch (err) {
                if (!t.finished) await t.rollback();
                stats.failed += 1;
                console.warn(`[BountyService] 清理过期悬赏 ${bounty.id} 失败:`, err.message);
            }
        }

        return stats;
    }

    /**
     * 根据战斗记录结算悬赏
     * 战斗结束后调用此方法，根据胜者身份结算悬赏：
     * - 接单者胜：标记 completed，发放赏金（bounty_amount * bounty_kill_reward_ratio）
     * - 接单者败/平局：悬赏回流为 active，允许其他人接取
     *
     * 此方法为公开接口，可被 PvpService._settleBattle 调用（需扩展 PvpService 时集成）
     * 也可通过 settlePendingBountyBattles() 定期扫描触发
     *
     * @param {number} battleRecordId - PVP 战斗记录ID
     * @param {number|null} winnerId - 胜者ID（null 表示平局/超时取消）
     * @returns {Promise<Object|null>} 结算结果，无关联悬赏返回 null
     */
    async settleBountyByBattle(battleRecordId, winnerId) {
        // 查询关联的悬赏记录
        const bounty = await PlayerBounty.findOne({
            where: {
                battle_record_id: battleRecordId,
                status: BountyStatus.ACCEPTED
            }
        });
        if (!bounty) {
            return null;
        }

        const t = await sequelize.transaction();
        try {
            const result = await this._settleBountyInternal(bounty, winnerId, t);
            await t.commit();
            return result;
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 扫描并结算已接取悬赏对应的已结束战斗
     * 定期扫描 status=accepted 且 battle_record_id 非空的悬赏，
     * 查询对应战斗记录，若战斗已结束则结算悬赏
     *
     * 设计说明：由于不修改 PvpService._settleBattle，无法在战斗结束时直接回调，
     * 因此通过此扫描方法异步结算，可由 StateCleanerService 定期调用
     *
     * @returns {Promise<Object>} 扫描统计 { scanned, settled, failed }
     */
    async settlePendingBountyBattles() {
        const stats = { scanned: 0, settled: 0, failed: 0 };

        // 查询所有已接取且有战斗记录的悬赏
        const pendingBounties = await PlayerBounty.findAll({
            where: {
                status: BountyStatus.ACCEPTED,
                battle_record_id: { [Op.ne]: null }
            }
        });

        stats.scanned = pendingBounties.length;

        for (const bounty of pendingBounties) {
            try {
                // 查询战斗记录
                const battle = await PvpBattleRecord.findByPk(bounty.battle_record_id);
                if (!battle) {
                    // 战斗记录不存在，悬赏回流
                    const t = await sequelize.transaction();
                    try {
                        await this._revertBountyToActive(bounty.id, t);
                        await t.commit();
                        stats.settled += 1;
                    } catch (err) {
                        if (!t.finished) await t.rollback();
                        stats.failed += 1;
                    }
                    continue;
                }

                // 仅处理已结束的战斗（finished 或 cancelled）
                if (battle.status !== 'finished' && battle.status !== 'cancelled') {
                    continue;
                }

                // 结算悬赏
                const t = await sequelize.transaction();
                try {
                    const result = await this._settleBountyInternal(bounty, battle.winner_id, t);
                    await t.commit();
                    if (result) {
                        stats.settled += 1;
                    }
                } catch (err) {
                    if (!t.finished) await t.rollback();
                    stats.failed += 1;
                    console.warn(`[BountyService] 结算悬赏 ${bounty.id} 失败:`, err.message);
                }
            } catch (err) {
                stats.failed += 1;
                console.warn(`[BountyService] 扫描悬赏 ${bounty.id} 异常:`, err.message);
            }
        }

        return stats;
    }

    /**
     * 内部方法：结算悬赏核心逻辑
     * 调用方必须已传入事务，此方法内不对 bounty 加锁（由调用方负责）
     *
     * 结算规则：
     * - 接单者胜（winnerId === acceptor_id）：
     *   status -> completed，发放赏金 bounty_amount * bounty_kill_reward_ratio 给接单者
     * - 接单者败或平局（winnerId !== acceptor_id 或 null）：
     *   status -> active（回流），清空 acceptor_id/accepted_at/battle_record_id
     *
     * @param {Object} bounty - 悬赏记录实例（未加锁，内部重新加锁）
     * @param {number|null} winnerId - 胜者ID
     * @param {Object} t - 事务实例
     * @returns {Promise<Object|null>} 结算结果，已结算或不存在返回 null
     * @private
     */
    async _settleBountyInternal(bounty, winnerId, t) {
        const cfg = this._getBountyConfig();
        const now = new Date();

        // 行级锁悬赏记录，防止并发结算
        const locked = await PlayerBounty.findByPk(bounty.id, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!locked || locked.status !== BountyStatus.ACCEPTED) {
            // 状态已变更（可能已被其他流程处理），跳过
            return null;
        }

        const acceptorId = Number(locked.acceptor_id);
        const isAcceptorWin = winnerId !== null && Number(winnerId) === acceptorId;

        if (isAcceptorWin) {
            // 接单者胜：标记 completed，发放赏金
            locked.status = BountyStatus.COMPLETED;
            locked.completed_at = now;

            // 计算赏金：bounty_amount * bounty_kill_reward_ratio
            const amountNum = Number(safeBigInt(locked.bounty_amount));
            const rewardRatio = cfg.bounty_kill_reward_ratio ?? 0.9;
            const rewardNum = Math.floor(amountNum * rewardRatio);

            // 行级锁接单者，发放赏金
            const acceptor = await Player.findByPk(acceptorId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (acceptor) {
                acceptor.spirit_stones = safeBigInt(acceptor.spirit_stones) + BigInt(rewardNum);
                await acceptor.save({ transaction: t });
            }

            await locked.save({ transaction: t });

            // 异步推送：通知双方悬赏已结算
            this._notifyBountySettlement(locked, 'completed', rewardNum);

            return {
                bounty_id: locked.id,
                result: 'completed',
                winner_id: winnerId,
                reward: rewardNum
            };
        } else {
            // 接单者败或平局：悬赏回流为 active
            locked.status = BountyStatus.ACTIVE;
            locked.acceptor_id = null;
            locked.accepted_at = null;
            locked.battle_record_id = null;
            await locked.save({ transaction: t });

            // 异步推送：通知接单者悬赏失败，通知发布者悬赏回流
            this._notifyBountySettlement(locked, 'failed', 0);

            return {
                bounty_id: locked.id,
                result: 'reverted',
                winner_id: winnerId,
                reward: 0
            };
        }
    }

    /**
     * 内部方法：将悬赏回流为 active 状态
     * 用于战斗记录不存在等异常场景
     * @param {number} bountyId - 悬赏ID
     * @param {Object} t - 事务实例
     * @private
     */
    async _revertBountyToActive(bountyId, t) {
        const locked = await PlayerBounty.findByPk(bountyId, {
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!locked || locked.status !== BountyStatus.ACCEPTED) {
            return;
        }
        locked.status = BountyStatus.ACTIVE;
        locked.acceptor_id = null;
        locked.accepted_at = null;
        locked.battle_record_id = null;
        await locked.save({ transaction: t });
    }

    /**
     * 内部方法：查询玩家最近一次接单时间
     * 用于接单冷却校验，通过查询 acceptor_id 匹配的最新 accepted_at 实现
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Date|null>} 最近接单时间，无记录返回 null
     * @private
     */
    async _getLastAcceptTime(playerId) {
        const latest = await PlayerBounty.findOne({
            where: {
                acceptor_id: playerId,
                accepted_at: { [Op.ne]: null }
            },
            order: [['accepted_at', 'DESC']]
        });
        return latest && latest.accepted_at ? new Date(latest.accepted_at) : null;
    }

    /**
     * 内部方法：推送悬赏结算通知
     * 通知接单者和发布者悬赏结算结果
     * @param {Object} bounty - 悬赏记录实例
     * @param {string} result - 结算结果（completed/failed）
     * @param {number} reward - 赏金金额
     * @private
     */
    _notifyBountySettlement(bounty, result, reward) {
        try {
            const WebSocketNotificationService = require('./WebSocketNotificationService');
            // 通知接单者（回流时 acceptor_id 已被清空，需在清空前调用或使用原值）
            const acceptorId = bounty.acceptor_id;
            if (acceptorId) {
                WebSocketNotificationService.notifyPlayerUpdate(acceptorId, 'bounty_settled', {
                    bounty_id: bounty.id,
                    result: result,
                    reward: reward
                });
            }
            // 通知发布者
            WebSocketNotificationService.notifyPlayerUpdate(bounty.publisher_id, 'bounty_settled', {
                bounty_id: bounty.id,
                result: result,
                reward: reward
            });
        } catch (e) {
            /* 推送失败不阻塞主流程 */
        }
    }

    /**
     * 内部方法：格式化悬赏详情
     * 将 PlayerBounty 实例转换为前端展示用的详情对象
     * @param {Object} bounty - PlayerBounty 实例
     * @param {Map} playerMap - 玩家信息映射 { id -> player }
     * @returns {Object} 格式化后的悬赏详情
     * @private
     */
    _formatBountyDetail(bounty, playerMap) {
        const publisher = playerMap.get(bounty.publisher_id);
        const target = playerMap.get(bounty.target_id);
        const acceptor = bounty.acceptor_id ? playerMap.get(bounty.acceptor_id) : null;

        return {
            bounty_id: bounty.id,
            publisher: publisher ? {
                id: publisher.id,
                nickname: publisher.nickname,
                realm: publisher.realm,
                realm_rank: publisher.realm_rank
            } : null,
            target: target ? {
                id: target.id,
                nickname: target.nickname,
                realm: target.realm,
                realm_rank: target.realm_rank
            } : null,
            acceptor: acceptor ? {
                id: acceptor.id,
                nickname: acceptor.nickname,
                realm: acceptor.realm,
                realm_rank: acceptor.realm_rank
            } : null,
            bounty_amount: Number(safeBigInt(bounty.bounty_amount)),
            status: bounty.status,
            reason: bounty.reason,
            accepted_at: bounty.accepted_at,
            completed_at: bounty.completed_at,
            expire_at: bounty.expire_at,
            battle_record_id: bounty.battle_record_id,
            created_at: bounty.created_at
        };
    }
}

module.exports = new BountyService();
