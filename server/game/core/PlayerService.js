/**
 * 玩家服务
 * 核心逻辑层 - 处理玩家相关的核心玩法逻辑
 */
// 修复：统一通过 modules/index.js 导出引用 ConfigLoader
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');

class PlayerService {
    /**
     * 获取玩家完整数据
     */
    async getPlayerData(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        const playerData = player.toJSON();
        playerData.attributes = typeof playerData.attributes === 'string' 
            ? JSON.parse(playerData.attributes) 
            : (playerData.attributes || {});
        playerData.spirit_roots = typeof playerData.spirit_roots === 'string' 
            ? JSON.parse(playerData.spirit_roots) 
            : (playerData.spirit_roots || {});

        return playerData;
    }

    /**
     * 获取玩家属性面板
     */
    async getPlayerAttributes(playerId) {
        const player = await this.getPlayerData(playerId);
        if (!player) return null;

        return {
            hp_max: player.attributes?.hp_max || 100,
            mp_max: player.attributes?.mp_max || 0,
            atk: player.attributes?.atk || 10,
            def: player.attributes?.def || 5,
            speed: player.attributes?.speed || 10,
            sense: player.attributes?.sense || 10,
            luck: player.attributes?.luck || 10,
            wisdom: player.attributes?.wisdom || 10
        };
    }

    /**
     * 初始化玩家数据（实例方法）
     * 统一的玩家创建逻辑，供 auth 路由调用，避免业务逻辑散落到路由层
     * 说明：本模块导出的是 PlayerService 实例（module.exports = new PlayerService()），
     *       故此处必须为实例方法（非 static），否则 auth 路由调用时会报
     *       "PlayerService.initializePlayer is not a function"。
     * @param {string} username - 账号
     * @param {string} hashedPassword - 已加密的密码（bcrypt 哈希）
     * @param {string} nickname - 道号
     * @param {Object} [extra] - 可选附加字段（IP、设备信息等）
     * @returns {Promise<Object>} 创建的玩家对象
     */
    async initializePlayer(username, hashedPassword, nickname, extra = {}) {
        const roleInitConfig = configLoader.getConfig('role_init');
        const gameBalanceConfig = configLoader.getConfig('game_balance');

        const initialAttributes = roleInitConfig?.initialAttributes || {
            hp_max: 100,
            mp_max: 0,
            atk: 10,
            def: 5,
            speed: 10,
            sense: 10,
            luck: 10,
            wisdom: 10
        };

        const probabilities = roleInitConfig?.spiritRootProbabilities || {
            '金': 0.2, '木': 0.2, '水': 0.2, '火': 0.2, '土': 0.2
        };

        let random = Math.random();
        let selectedRoot = '木';
        let cumulative = 0;
        for (const [root, prob] of Object.entries(probabilities)) {
            cumulative += prob;
            if (random <= cumulative) {
                selectedRoot = root;
                break;
            }
        }

        // 灵根数据结构统一为 { `${root}灵根`: { level, affinity } }
        const spiritRoots = {};
        spiritRoots[`${selectedRoot}灵根`] = {
            level: '基础',
            affinity: Math.floor(Math.random() * 20) + 80
        };

        const player = await Player.create({
            username,
            password: hashedPassword,
            nickname,
            realm: '凡人',
            exp: 0,
            cultivation: 0,
            spirit_stones: 0,
            hp_current: initialAttributes.hp_max,
            mp_current: 0,
            toxicity: 0,
            lifespan_current: roleInitConfig?.initialAge || 16,
            lifespan_max: roleInitConfig?.initialLifespan || 60,
            attributes: initialAttributes,
            spirit_roots: spiritRoots,
            role: 'user',
            ip_address: extra.ip || null,
            device_info: extra.userAgent || null
        });

        return player;
    }

    /**
     * 更新玩家属性
     */
    async updateAttributes(playerId, newAttributes) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        const currentAttrs = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});

        const updatedAttrs = { ...currentAttrs, ...newAttributes };
        player.attributes = updatedAttrs;
        await player.save();

        return updatedAttrs;
    }

    /**
     * 增加玩家修为
     */
    async addExp(playerId, amount) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.exp = (BigInt(player.exp) + BigInt(amount)).toString();
        await player.save();

        return {
            currentExp: player.exp.toString(),
            canBreakthrough: false
        };
    }

    /**
     * 更新玩家气血
     * @param {number} playerId - 玩家ID
     * @param {number|bigint} currentHp - 当前气血值
     * @param {number|bigint} [maxHp] - 可选，最大气血值（用于同步更新 hp_max）
     * @param {string} [deathReason='战斗陨落'] - 可选，死亡原因（HP<=0 时传入 handlePlayerDeath）
     */
    async updateHp(playerId, currentHp, maxHp, deathReason = '战斗陨落') {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        // 检查是否死亡
        if (currentHp <= 0) {
            await this.handlePlayerDeath(playerId, deathReason);
            // 死亡处理后，返回更新后的玩家数据（HP已重置）
            return await Player.findByPk(playerId);
        }

        player.hp_current = currentHp;
        if (maxHp !== undefined) {
            const attrs = typeof player.attributes === 'string' 
                ? JSON.parse(player.attributes) 
                : (player.attributes || {});
            attrs.hp_max = maxHp;
            player.attributes = attrs;
        }
        await player.save();

        return player;
    }

    /**
     * 更新玩家灵力
     */
    async updateMp(playerId, currentMp, maxMp) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.mp_current = currentMp;
        if (maxMp !== undefined) {
            const attrs = typeof player.attributes === 'string' 
                ? JSON.parse(player.attributes) 
                : (player.attributes || {});
            attrs.mp_max = maxMp;
            player.attributes = attrs;
        }
        await player.save();

        return player;
    }

    /**
     * 更新玩家灵石
     */
    async updateSpiritStones(playerId, amount) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.spirit_stones = BigInt(player.spirit_stones) + BigInt(amount);
        if (player.spirit_stones < 0n) player.spirit_stones = 0n;
        await player.save();

        return player.spirit_stones.toString();
    }

    /**
     * 玩家死亡处理（战斗死亡 / 副本团灭 / 其他非寿命耗尽死亡场景）
     *
     * 修复 4-3-P0-2：与 LifespanService.handleLifespanEnd 行为对齐
     *   1. 事务包裹：扣修为/改 hp/加寿元/标记 is_dead 必须原子性
     *   2. 设置 is_dead=true：战斗死亡也需要进入死亡状态，等复活流程清除
     *   3. 推送 WebSocket 通知：让前端 DeathOverlay 立即响应
     *   4. 持久化系统通知：玩家上线后可在通知中心查看
     *   5. 记录 death_reason / death_time：与 LifespanService 保持字段一致
     *
     * 注意：本方法用于战斗/副本等"非寿元耗尽"的死亡场景。
     *      寿元耗尽走 LifespanService.handleLifespanEnd，二者字段保持一致以便前端统一处理。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} [reason='战斗陨落'] - 死亡原因（用于通知文案与 death_reason 字段）
     * @returns {Promise<Object|null>} 死亡结算结果，包含 expLoss/ageIncrease/respawnAt
     */
    async handlePlayerDeath(playerId, reason = '战斗陨落') {
        // 修复 4-3-P0-2-补丁：require 路径应为 ../../config/database（server/models 无 index.js）
        const sequelize = require('../../config/database');
        const t = await sequelize.transaction();
        try {
            // 行级锁玩家，避免与其他事务并发修改
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.rollback();
                return null;
            }

            // 幂等性校验：已死亡的玩家不再重复处理（与 LifespanService 行为一致）
            if (player.is_dead === true) {
                await t.rollback();
                return null;
            }

            const gameBalanceConfig = configLoader.getConfig('game_balance');
            // 死亡惩罚参数从配置读取，避免硬编码
            // 与 LifespanService 统一使用 lifespan.death_exp_loss_rate（而非 combat.death_exp_penalty_rate）
            // 修复 4-3-P1-1：两个 service 用不同的损失率字段，导致死亡惩罚不一致
            const lifespanCfg = gameBalanceConfig?.lifespan || {};
            const expLossRate = lifespanCfg.death_exp_loss_rate
                ?? gameBalanceConfig?.combat?.death_exp_penalty_rate
                ?? 0.1;
            const ageIncrease = gameBalanceConfig?.death?.age_increase ?? 10;
            const respawnAt = gameBalanceConfig?.death?.respawn_location ?? '出生地';
            const deathHp = lifespanCfg.death_hp_current ?? 0;

            // 修为损失（BIGINT 运算，避免精度丢失）
            const currentExp = BigInt(player.exp || 0);
            const expLoss = currentExp * BigInt(Math.round(expLossRate * 100)) / 100n;
            const newExp = currentExp - expLoss;
            player.exp = newExp < 0n ? 0n : newExp;

            // HP 归零或复活点初始值（与 LifespanService 一致）
            player.hp_current = BigInt(deathHp);

            // 战斗死亡增加寿元消耗（"重伤折寿"设定，与 game_balance.death.age_increase 一致）
            const currentAge = Number(player.lifespan_current || 0);
            const maxAge = Number(player.lifespan_max || 0);
            const newAge = currentAge + ageIncrease;
            player.lifespan_current = newAge;

            // 标记死亡状态（与 LifespanService 一致）
            player.is_dead = true;
            player.death_reason = reason;
            player.death_time = new Date();

            // 寿元溢出保护：若加寿后超过 max，则寿元定格在 max 并由后续 LifespanService 触发寿元死亡
            // 但因 is_dead=true 已设置，LifespanService 会跳过该玩家（P0-1 修复）
            // 真正复活时由复活接口清除 is_dead，若届时 lifespan_current >= lifespan_max 则再次触发寿元死亡
            if (maxAge > 0 && newAge >= maxAge) {
                player.lifespan_current = maxAge;
            }

            await player.save({ transaction: t });
            await t.commit();

            // 推送通知（事务提交后再推送，避免推送失败回滚业务数据）
            try {
                const WebSocketNotificationService = require('../services/WebSocketNotificationService');
                const deathPayload = {
                    player_id: player.id,
                    reason: reason,
                    exp_loss: expLoss.toString(),
                    age_increase: ageIncrease,
                    respawn_at: respawnAt,
                    timestamp: new Date().toISOString()
                };
                // 玩家本人：触发前端 DeathOverlay 显示
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'player_death', deathPayload);
                // 全局广播：让其他在线玩家感知"某位道友陨落"
                WebSocketNotificationService.broadcastNotification({
                    type: 'player_death',
                    title: '道友陨落',
                    content: `${player.nickname || '某位道友'} ${reason}，已身死道消。`,
                    level: 'warn',
                    ...deathPayload
                });
            } catch (e) {
                console.warn(`[PlayerService] 推送玩家 ${player.id} 死亡通知失败:`, e.message);
            }

            // 持久化系统通知（玩家上线后可在通知中心查看）
            try {
                const NotificationService = require('../services/NotificationService');
                if (typeof NotificationService.sendDeathNotification === 'function') {
                    await NotificationService.sendDeathNotification(player, reason);
                }
            } catch (e) {
                console.warn(`[PlayerService] 持久化玩家 ${player.id} 死亡通知失败:`, e.message);
            }

            return {
                expLoss: expLoss.toString(),
                ageIncrease,
                respawnAt,
                reason
            };
        } catch (error) {
            if (!t.finished) await t.rollback();
            console.error('[PlayerService] 玩家死亡处理失败:', error);
            throw error;
        }
    }

    /**
     * 查找玩家
     */
    async findPlayerByUsername(username) {
        return await Player.findOne({ where: { username } });
    }

    /**
     * 查找玩家ByID
     */
    async findPlayerById(id) {
        return await Player.findByPk(id);
    }

    /**
     * 获取在线玩家列表
     * 在线阈值从配置读取，避免硬编码
     */
    async getOnlinePlayers() {
        const { Op } = require('sequelize');
        const gameBalanceConfig = configLoader.getConfig('game_balance');
        const thresholdMinutes = gameBalanceConfig?.auth?.online_threshold_minutes ?? 5;
        const thresholdAgo = new Date(Date.now() - thresholdMinutes * 60 * 1000);
        return await Player.findAll({
            where: {
                last_online: {
                    [Op.gte]: thresholdAgo
                }
            }
        });
    }
}

module.exports = new PlayerService();
