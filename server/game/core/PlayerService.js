/**
 * 玩家服务
 * 核心逻辑层 - 处理玩家相关的核心玩法逻辑
 */
// 修复：统一通过 modules/index.js 导出引用 ConfigLoader
const { infrastructure } = require('../../modules');
const { applyExpPenalty } = require('./deathPenalty');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
// 玩家状态写入的唯一入口：陨落要给 players.stats 里的 death_count 记一笔（整块写回是旧快照覆盖那一族）
const PlayerStateStore = require('../persistence/PlayerStateStore');

/**
 * 不是注册属性、但确实住在 players.attributes 里的资源池键。
 * 神识（sense）是玩家可花掉的那一格（飞升 / 第二元神 / 元婴出窍都从这里扣），
 * 与面板上那档"神识"属性各走各的口径（见 game/services/AscensionService.js 顶部注释），
 * 所以建号初值过滤时必须把它留在 blob 里。
 */
const BLOB_POOL_KEYS = ['sense'];

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
     * 新号（以及 GM 重置整号，routes/admin 用的就是这一个口径）写进 players.attributes 的那份初值。
     *
     * role_init.initialAttributes 里有两种键混在一起：
     *   · 真的住在 blob 里的 —— `base.attributeField` 那种属性（现网是 luck/wisdom），
     *     以及不是属性但确实存在 blob 里的资源池（神识 sense）；这些必须留。
     *   · 旧属性管线的**输出**键 —— atk/def/speed/hp_max/mp_max。现管线既不读它们也不以它们为基数，
     *     种进 blob 只是埋一份"看着像面板"的残骸（现网实测有人 blob 战力 6185、真实 98）。
     * 判据取自注册表本身而不是在代码里抄一份键名清单：资料片若加一档 attributeField 属性，
     * 这里自动就认；抄清单的一定会漂移。
     *
     * @param {Object} initialAttributes - role_init.initialAttributes（或它的兜底值）
     * @returns {Object} 只含"该进 blob"的那几个键
     */
    initialAttributeBlob(initialAttributes) {
        const { ensureStatRegistryLoaded } = require('../stats');
        const registry = ensureStatRegistryLoaded(configLoader);
        const out = {};
        for (const [key, value] of Object.entries(initialAttributes || {})) {
            const def = registry.get(key);
            if (!def || def.base?.attributeField || BLOB_POOL_KEYS.includes(key)) out[key] = value;
        }
        return out;
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

        // 抽灵根：池子与权重口径全部在 stats/SpiritRoot（spiritRootRollPool / rollSpiritRoot），
        // 启动闸 _validateSpiritRootRoll 问的是同一个池子定义。这里只把结果写成玩家身上的存储形状。
        const { rollSpiritRoot } = require('../stats/SpiritRoot');
        const roll = rollSpiritRoot(roleInitConfig);

        // 灵根数据结构统一为 { `${root}灵根`: { level, affinity } }
        const spiritRoots = {};
        if (roll) {
            spiritRoots[`${roll.name}灵根`] = {
                level: '基础',
                affinity: Math.floor(Math.random() * 20) + 80
            };
        } else {
            // 灵根表整个读不到（被裁过的/热更坏掉的 role_init）：宁可不发灵根，
            // 也不写一条在 spirit_roots 里查无此根的假灵根 —— 那会让面板显示"有灵根"而加成永远是 0。
            console.warn('[PlayerService] role_init 里没有可抽的灵根，本号暂时无灵根（检查 spirit_roots 声明与概率表）');
        }

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
            attributes: this.initialAttributeBlob(initialAttributes),
            spirit_roots: spiritRoots,
            role: 'user',
            ip_address: extra.ip || null,
            device_info: extra.userAgent || null
        });

        return player;
    }

    /**
     * 更新玩家属性（键级补丁）
     *
     * 走 PlayerStateStore：行锁内读出最新 attributes，只覆盖 newAttributes 里点名的键。
     * 旧实现是"无锁读整块 → 合并 → 整块写回"，会把这段时间内别处写的键抹掉。
     */
    async updateAttributes(playerId, newAttributes) {
        const PlayerStateStore = require('../persistence/PlayerStateStore');
        const player = await PlayerStateStore.patchPlayerState(playerId, { attributes: newAttributes || {} });
        return player ? player.attributes : null;
    }

    /**
     * 增加玩家修为（列上原子累加，不做读-改-写）
     */
    async addExp(playerId, amount) {
        const PlayerStateStore = require('../persistence/PlayerStateStore');
        await PlayerStateStore.grantAmount(playerId, 'exp', amount);
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        return {
            currentExp: player.exp.toString(),
            canBreakthrough: false
        };
    }

    /**
     * 更新玩家气血
     *
     * @param {number} playerId - 玩家ID
     * @param {number|bigint} currentHp - 当前气血值
     * @param {number|bigint} [maxHp] - 已废弃：气血上限是解析出来的派生值，不能再当存储字段写入
     *                                   （旧代码往 attributes.hp_max 写，而解析链路根本不读它，
     *                                    写进去只会让"面板上限"和"恢复上限"各说各话）
     * @param {string} [deathReason='战斗陨落'] - 死亡原因（HP<=0 时传入 handlePlayerDeath）
     */
    async updateHp(playerId, currentHp, maxHp, deathReason = '战斗陨落') {
        const PlayerStateStore = require('../persistence/PlayerStateStore');
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        if (currentHp <= 0) {
            await this.handlePlayerDeath(playerId, deathReason);
            return await Player.findByPk(playerId);
        }

        return PlayerStateStore.patchPlayerState(playerId, {
            columns: { hp_current: currentHp }
        });
    }

    /**
     * 更新玩家灵力（同 updateHp：mp_max 是派生值，不在此写回）
     */
    async updateMp(playerId, currentMp, maxMp) {
        const PlayerStateStore = require('../persistence/PlayerStateStore');
        return PlayerStateStore.patchPlayerState(playerId, {
            columns: { mp_current: currentMp }
        });
    }

    /**
     * 增减玩家灵石（列上原子累加，不允许被并发写丢）
     */
    async updateSpiritStones(playerId, amount) {
        const PlayerStateStore = require('../persistence/PlayerStateStore');
        return PlayerStateStore.patchPlayerState(playerId, {
            amounts: { spirit_stones: amount }
        });
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
            const ageIncrease = gameBalanceConfig?.death?.age_increase ?? 10;
            const respawnAt = gameBalanceConfig?.death?.respawn_location ?? '出生地';
            const deathHp = lifespanCfg.death_hp_current ?? 0;

            // 修为损失：全仓唯一一份实现（作用域 lifespan，与寿元耗尽同一条率），列上原子减
            const expLoss = (await applyExpPenalty({ playerId: player.id, scope: 'lifespan', transaction: t, reason: '重生陨落' })).penalty;

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
            // 陨落计数进 stats 那一格（players 上没有 death_count 列，别按列去读它）
            await PlayerStateStore.bumpStat(playerId, 'death_count', 1, { transaction: t });
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
