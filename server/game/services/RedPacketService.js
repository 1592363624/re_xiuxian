/**
 * 聊天红包服务
 *
 * 提供聊天频道红包玩法的核心业务逻辑：
 * 1. sendRedPacket：发送红包（扣灵石、创建红包记录、发聊天消息）
 * 2. claimRedPacket：领取红包（金额分配、防重复领取、手气最佳标记）
 * 3. getRedPacketDetail：查询红包详情（含领取记录列表）
 * 4. getActiveRedPackets：获取频道内可领取的红包列表
 * 5. cleanExpiredRedPackets：清理过期红包（剩余金额退还发送者）
 *
 * 红包类型：
 *   - lucky（拼手气）：使用二倍均值法随机分配，手气最佳者获最多
 *   - equal（普通均分）：每个领取者获得相同金额（整除，余数给前几个）
 *
 * 设计原则：
 * - 所有可变参数从 game_balance.json chat.red_packet 段读取，禁止硬编码
 * - 多表/多字段变更使用事务 + 行级锁（player + red_packet + claim）
 * - BigInt 安全：灵石金额使用 BigInt 运算，避免精度丢失
 * - WebSocket 推送通过 WebSocketNotificationService.notifyPlayerUpdate
 * - 防重复领取：唯一索引 (red_packet_id, receiver_id) + 业务校验双重保险
 * - 过期退款：StateCleanerService 定期调用 cleanExpiredRedPackets
 */
'use strict';

const Player = require('../../models/player');
const ChatRedPacket = require('../../models/chatRedPacket');
const ChatRedPacketClaim = require('../../models/chatRedPacketClaim');
const Chat = require('../../models/chat');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

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
 * 红包状态常量
 */
const RedPacketStatus = {
    ACTIVE: 'active',         // 可领取
    EXHAUSTED: 'exhausted',   // 已被领完
    EXPIRED: 'expired',       // 已过期（未领完）
    REFUNDED: 'refunded'      // 已过期且已退款
};

/**
 * 红包类型常量
 */
const RedPacketType = {
    LUCKY: 'lucky',   // 拼手气
    EQUAL: 'equal'    // 普通均分
};

class RedPacketService {
    constructor() {
        this.configLoader = null;
    }

    /**
     * 初始化红包服务，注入配置加载器
     * @param {Object} configLoader - 配置加载器实例
     */
    initialize(configLoader) {
        this.configLoader = configLoader;
    }

    /**
     * 获取配置加载器实例
     * @returns {Object} 配置加载器实例
     * @private
     */
    _getConfigLoader() {
        if (this.configLoader) return this.configLoader;
        const { infrastructure } = require('../../modules');
        this.configLoader = infrastructure.ConfigLoader;
        return this.configLoader;
    }

    /**
     * 读取红包配置
     * 从 game_balance.json -> chat.red_packet 段读取
     * @returns {Object} 红包配置对象
     * @private
     */
    _getConfig() {
        const loader = this._getConfigLoader();
        const config = loader.getConfig('game_balance');
        return config?.chat?.red_packet || {};
    }

    /**
     * 发送红包
     *
     * 校验规则：
     * - 红包功能全局开启（enabled=true）
     * - 金额在 min_amount ~ max_amount 范围内
     * - 个数在 min_count ~ max_count 范围内
     * - 每个红包最小金额 >= min_per_packet（lucky 类型均分保障）
     * - 发送者灵石 >= 红包总金额
     *
     * 扣费逻辑：
     * - 直接扣除 total_amount 灵石（无手续费，红包是社交玩法不收税）
     * - 过期未领取的剩余金额通过 cleanExpiredRedPackets 退还
     *
     * @param {number} playerId - 发送者玩家ID
     * @param {number} totalAmount - 红包总金额（灵石）
     * @param {number} totalCount - 红包个数
     * @param {string} [packetType='lucky'] - 红包类型（lucky/equal）
     * @param {string} [message] - 红包附言（可选）
     * @returns {Promise<Object>} 红包详情
     */
    async sendRedPacket(playerId, totalAmount, totalCount, packetType = 'lucky', message) {
        const cfg = this._getConfig();

        // 全局开关校验
        if (cfg.enabled === false) {
            throw new AppError('红包功能未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验：红包类型
        if (![RedPacketType.LUCKY, RedPacketType.EQUAL].includes(packetType)) {
            throw new AppError('红包类型无效，仅支持 lucky(拼手气) 或 equal(普通均分)', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 参数校验：金额范围
        const minAmount = cfg.min_amount ?? 10;
        const maxAmount = cfg.max_amount ?? 1000000;
        const amountNum = Number(totalAmount);
        if (!Number.isFinite(amountNum) || amountNum < minAmount || amountNum > maxAmount) {
            throw new AppError(
                `红包总金额须在 ${minAmount} ~ ${maxAmount} 灵石之间`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 参数校验：个数范围
        const minCount = cfg.min_count ?? 1;
        const maxCount = cfg.max_count ?? 100;
        const countNum = parseInt(totalCount);
        if (!Number.isFinite(countNum) || countNum < minCount || countNum > maxCount) {
            throw new AppError(
                `红包个数须在 ${minCount} ~ ${maxCount} 之间`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 参数校验：每个红包最小金额（lucky 类型需保证每人至少分到 min_per_packet）
        const minPerPacket = cfg.min_per_packet ?? 1;
        if (amountNum < countNum * minPerPacket) {
            throw new AppError(
                `红包金额不足，每人至少需 ${minPerPacket} 灵石（共需 ${countNum * minPerPacket} 灵石）`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 附言长度校验
        if (message !== undefined && message !== null && typeof message !== 'string') {
            throw new AppError('红包附言必须为字符串', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (message && message.length > 100) {
            throw new AppError('红包附言不能超过 100 字', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 每日发送限额校验
        const dailyLimit = cfg.daily_send_limit ?? 0;
        if (dailyLimit > 0) {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayCount = await ChatRedPacket.count({
                where: {
                    sender_id: playerId,
                    created_at: { [Op.gte]: todayStart }
                }
            });
            if (todayCount >= dailyLimit) {
                throw new AppError(
                    `今日已发送 ${dailyLimit} 个红包，达到每日上限`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁读取发送者
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                await t.rollback();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 灵石余额校验
            const playerStones = safeBigInt(player.spirit_stones);
            const costStones = BigInt(amountNum);
            if (playerStones < costStones) {
                await t.rollback();
                throw new AppError(
                    `灵石不足，发送红包需要 ${amountNum} 灵石，当前持有 ${playerStones.toString()}`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 扣除灵石
            player.spirit_stones = (playerStones - costStones).toString();
            await player.save({ transaction: t });

            // 计算过期时间
            const expireHours = cfg.expire_hours ?? 24;
            const expireAt = new Date(Date.now() + expireHours * 3600 * 1000);

            // 创建红包记录
            const redPacket = await ChatRedPacket.create({
                sender_id: playerId,
                sender_nickname: player.nickname || player.username,
                channel: 'world',
                total_amount: amountNum,
                total_count: countNum,
                remain_amount: amountNum,
                remain_count: countNum,
                packet_type: packetType,
                status: RedPacketStatus.ACTIVE,
                message: message || null,
                expire_at: expireAt
            }, { transaction: t });

            // 在聊天频道发送红包消息（type='red_packet'，content 存储红包元信息 JSON）
            const chatMessage = await Chat.create({
                sender: player.nickname || player.username,
                content: JSON.stringify({
                    red_packet_id: redPacket.id,
                    total_amount: amountNum,
                    total_count: countNum,
                    packet_type: packetType,
                    message: message || ''
                }),
                type: 'red_packet'
            }, { transaction: t });

            await t.commit();

            return {
                red_packet_id: redPacket.id,
                sender: {
                    id: playerId,
                    nickname: player.nickname || player.username
                },
                total_amount: amountNum,
                total_count: countNum,
                packet_type: packetType,
                message: message || null,
                status: RedPacketStatus.ACTIVE,
                expire_at: expireAt.toISOString(),
                created_at: redPacket.created_at.toISOString(),
                chat_message_id: chatMessage.id
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 领取红包
     *
     * 校验规则：
     * - 红包存在且状态为 active
     * - 红包未过期
     * - 不能领取自己发的红包（可选，由配置 self_claim_allowed 控制）
     * - 同一玩家不能重复领取（唯一索引 + 业务校验）
     * - 红包还有剩余
     *
     * 金额分配算法：
     * - lucky（拼手气）：二倍均值法，每人金额 = random(1, remain/count*2-1)
     * - equal（普通均分）：base = floor(remain/count)，前 remainder 人多拿 1
     *
     * 手气最佳标记：
     * - 仅 lucky 类型，最后一个领取者触发时回溯标记金额最大者
     * - 如果是最后一个领取者直接拿到全部剩余，则该领取者即手气最佳
     *
     * @param {number} playerId - 领取者玩家ID
     * @param {number} redPacketId - 红包ID
     * @returns {Promise<Object>} 领取结果
     */
    async claimRedPacket(playerId, redPacketId) {
        const cfg = this._getConfig();

        const t = await sequelize.transaction();
        try {
            // 行级锁读取红包
            const redPacket = await ChatRedPacket.findByPk(redPacketId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!redPacket) {
                await t.rollback();
                throw new AppError('红包不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 状态校验
            if (redPacket.status !== RedPacketStatus.ACTIVE) {
                const statusText = {
                    [RedPacketStatus.EXHAUSTED]: '红包已被领完',
                    [RedPacketStatus.EXPIRED]: '红包已过期',
                    [RedPacketStatus.REFUNDED]: '红包已过期并退款'
                }[redPacket.status] || '红包不可领取';
                await t.rollback();
                throw new AppError(statusText, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 过期校验（双保险：StateCleaner 可能尚未清理）
            if (new Date(redPacket.expire_at) < new Date()) {
                redPacket.status = RedPacketStatus.EXPIRED;
                await redPacket.save({ transaction: t });
                await t.commit();
                throw new AppError('红包已过期', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 不能领取自己的红包（由配置控制）
            const selfClaimAllowed = cfg.self_claim_allowed ?? false;
            if (!selfClaimAllowed && Number(redPacket.sender_id) === Number(playerId)) {
                await t.rollback();
                throw new AppError('不能领取自己发的红包', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 防重复领取：查询是否已领取过
            const existingClaim = await ChatRedPacketClaim.findOne({
                where: {
                    red_packet_id: redPacketId,
                    receiver_id: playerId
                },
                transaction: t
            });
            if (existingClaim) {
                await t.rollback();
                throw new AppError('你已经领取过这个红包了', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 剩余个数校验
            if (redPacket.remain_count <= 0) {
                redPacket.status = RedPacketStatus.EXHAUSTED;
                await redPacket.save({ transaction: t });
                await t.commit();
                throw new AppError('红包已被领完', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁读取领取者
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) {
                await t.rollback();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 计算本次领取金额
            const remainAmount = safeBigInt(redPacket.remain_amount);
            const remainCount = redPacket.remain_count;
            let claimAmount;

            if (redPacket.packet_type === RedPacketType.LUCKY) {
                // 拼手气：二倍均值法
                // 最后一个领取者拿全部剩余，否则随机 [1, remainAmount/remainCount*2 - 1]
                if (remainCount === 1) {
                    claimAmount = remainAmount;
                } else {
                    const avg = remainAmount / BigInt(remainCount);
                    // 二倍均值上限 = avg * 2 - 1
                    const maxAmount = avg * 2n - 1n;
                    // 随机区间 [1, maxAmount]
                    const randomVal = BigInt(Math.floor(Math.random() * Number(maxAmount)) + 1);
                    claimAmount = randomVal > remainAmount ? remainAmount : randomVal;
                    // 保底至少 1
                    if (claimAmount < 1n) claimAmount = 1n;
                }
            } else {
                // 普通均分：base = floor(remain/count)，前 remainder 人多拿 1
                const base = remainAmount / BigInt(remainCount);
                const remainder = remainAmount % BigInt(remainCount);
                // 当前是第几个领取者（已领取人数 = total_count - remain_count）
                const claimIndex = redPacket.total_count - remainCount;
                claimAmount = base + (claimIndex < Number(remainder) ? 1n : 0n);
            }

            // 更新红包剩余
            redPacket.remain_amount = (remainAmount - claimAmount).toString();
            redPacket.remain_count = remainCount - 1;

            // 判断是否领完
            let isLastClaim = false;
            let isLuckyKing = false;
            if (redPacket.remain_count <= 0) {
                redPacket.status = RedPacketStatus.EXHAUSTED;
                isLastClaim = true;

                // lucky 类型：回溯标记手气最佳
                if (redPacket.packet_type === RedPacketType.LUCKY) {
                    // 查询所有领取记录找最大金额
                    const allClaims = await ChatRedPacketClaim.findAll({
                        where: { red_packet_id: redPacketId },
                        transaction: t
                    });
                    let maxAmount = claimAmount;
                    let maxClaimId = null;
                    for (const c of allClaims) {
                        const cAmount = safeBigInt(c.amount);
                        if (cAmount > maxAmount) {
                            maxAmount = cAmount;
                            maxClaimId = c.id;
                        }
                    }
                    // 比较当前领取者是否为最大
                    if (maxClaimId === null) {
                        // 当前领取者就是最大
                        isLuckyKing = true;
                    } else {
                        // 更新历史最大者为手气最佳
                        await ChatRedPacketClaim.update(
                            { is_lucky_king: 1 },
                            { where: { id: maxClaimId }, transaction: t }
                        );
                    }
                }
            }

            // 创建领取记录
            const claim = await ChatRedPacketClaim.create({
                red_packet_id: redPacketId,
                receiver_id: playerId,
                receiver_nickname: player.nickname || player.username,
                amount: claimAmount.toString(),
                is_lucky_king: isLuckyKing ? 1 : 0
            }, { transaction: t });

            // 玩家加灵石
            player.spirit_stones = (safeBigInt(player.spirit_stones) + claimAmount).toString();
            await player.save({ transaction: t });

            await redPacket.save({ transaction: t });
            await t.commit();

            return {
                red_packet_id: redPacketId,
                claim_id: claim.id,
                amount: Number(claimAmount.toString()),
                is_lucky_king: isLuckyKing,
                is_last_claim: isLastClaim,
                sender_nickname: redPacket.sender_nickname,
                remain_count: redPacket.remain_count,
                remain_amount: Number(safeBigInt(redPacket.remain_amount).toString()),
                message: '领取成功'
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 查询红包详情（含领取记录列表）
     * @param {number} redPacketId - 红包ID
     * @param {number} [currentPlayerId] - 当前查询玩家ID（用于判断是否已领取）
     * @returns {Promise<Object>} 红包详情
     */
    async getRedPacketDetail(redPacketId, currentPlayerId) {
        const redPacket = await ChatRedPacket.findByPk(redPacketId);
        if (!redPacket) {
            throw new AppError('红包不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询所有领取记录
        const claims = await ChatRedPacketClaim.findAll({
            where: { red_packet_id: redPacketId },
            order: [['created_at', 'ASC']]
        });

        // 判断当前玩家是否已领取
        let myClaim = null;
        if (currentPlayerId) {
            const mine = claims.find(c => Number(c.receiver_id) === Number(currentPlayerId));
            if (mine) {
                myClaim = {
                    amount: Number(safeBigInt(mine.amount).toString()),
                    is_lucky_king: mine.is_lucky_king === 1,
                    claimed_at: mine.created_at.toISOString()
                };
            }
        }

        return {
            red_packet_id: redPacket.id,
            sender: {
                id: Number(redPacket.sender_id),
                nickname: redPacket.sender_nickname
            },
            total_amount: Number(safeBigInt(redPacket.total_amount).toString()),
            total_count: redPacket.total_count,
            remain_amount: Number(safeBigInt(redPacket.remain_amount).toString()),
            remain_count: redPacket.remain_count,
            packet_type: redPacket.packet_type,
            status: redPacket.status,
            message: redPacket.message,
            expire_at: redPacket.expire_at.toISOString(),
            created_at: redPacket.created_at.toISOString(),
            my_claim: myClaim,
            claims: claims.map(c => ({
                receiver: {
                    id: Number(c.receiver_id),
                    nickname: c.receiver_nickname
                },
                amount: Number(safeBigInt(c.amount).toString()),
                is_lucky_king: c.is_lucky_king === 1,
                claimed_at: c.created_at.toISOString()
            }))
        };
    }

    /**
     * 获取频道内活跃红包列表
     * @param {string} [channel='world'] - 频道
     * @param {number} [limit=20] - 返回条数
     * @returns {Promise<Array>} 红包列表
     */
    async getActiveRedPackets(channel = 'world', limit = 20) {
        const redPackets = await ChatRedPacket.findAll({
            where: {
                channel: channel,
                status: RedPacketStatus.ACTIVE,
                expire_at: { [Op.gt]: new Date() }
            },
            order: [['created_at', 'DESC']],
            limit: Math.min(limit, 50)
        });

        return redPackets.map(rp => ({
            red_packet_id: rp.id,
            sender: {
                id: Number(rp.sender_id),
                nickname: rp.sender_nickname
            },
            total_amount: Number(safeBigInt(rp.total_amount).toString()),
            total_count: rp.total_count,
            remain_count: rp.remain_count,
            packet_type: rp.packet_type,
            message: rp.message,
            created_at: rp.created_at.toISOString(),
            expire_at: rp.expire_at.toISOString()
        }));
    }

    /**
     * 清理过期红包（退款未领取部分）
     * 由 StateCleanerService 定期调用
     *
     * 逻辑：
     * 1. 查询所有 status='active' 且 expire_at < now 的红包
     * 2. 将剩余金额退还发送者
     * 3. 标记红包状态为 'refunded'
     *
     * @returns {Promise<Object>} 清理结果 { refunded_count, total_refund_amount }
     */
    async cleanExpiredRedPackets() {
        const now = new Date();
        const expiredPackets = await ChatRedPacket.findAll({
            where: {
                status: RedPacketStatus.ACTIVE,
                expire_at: { [Op.lt]: now }
            },
            limit: 100
        });

        if (expiredPackets.length === 0) {
            return { refunded_count: 0, total_refund_amount: 0 };
        }

        let refundedCount = 0;
        let totalRefund = 0n;

        for (const rp of expiredPackets) {
            const t = await sequelize.transaction();
            try {
                // 行级锁重新读取确保一致性
                const locked = await ChatRedPacket.findByPk(rp.id, {
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!locked || locked.status !== RedPacketStatus.ACTIVE) {
                    await t.commit();
                    continue;
                }

                const refundAmount = safeBigInt(locked.remain_amount);
                if (refundAmount > 0n) {
                    // 退还发送者
                    const player = await Player.findByPk(locked.sender_id, {
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    if (player) {
                        player.spirit_stones = (safeBigInt(player.spirit_stones) + refundAmount).toString();
                        await player.save({ transaction: t });
                    }
                }

                // 标记为已退款
                locked.status = RedPacketStatus.REFUNDED;
                await locked.save({ transaction: t });

                await t.commit();
                refundedCount++;
                totalRefund += refundAmount;
            } catch (err) {
                if (t && !t.finished) await t.rollback();
                console.warn(`[RedPacketService] 退款红包 ${rp.id} 失败:`, err.message);
            }
        }

        if (refundedCount > 0) {
            console.log(`[RedPacketService] 清理过期红包 ${refundedCount} 个，退款 ${totalRefund.toString()} 灵石`);
        }

        return {
            refunded_count: refundedCount,
            total_refund_amount: Number(totalRefund.toString())
        };
    }
}

// 导出单例
module.exports = new RedPacketService();
