/**
 * 寿命服务
 *
 * 核心逻辑层 - 处理玩家年龄增长与寿命管理、寿元耗尽死亡处理
 *
 * 主要功能：
 * 1. updateLifespan：定时任务调用，批量增长未闭关玩家年龄，处理寿元耗尽
 * 2. handleLifespanEnd：寿元耗尽时设置 is_dead、扣除修为、推送死亡通知
 * 3. useLongevityPill：使用延寿丹增加 lifespan_max
 * 4. getLifespanStatus：返回寿命状态快照
 *
 * 关键修复（2026-07-19）：
 *   B2: handleLifespanEnd 缺 player.save() → 已补存
 *   B3: handleLifespanEnd 未设置 is_dead=true → 已补设
 *   B4: 死亡未推送通知 → 已接入 WebSocket + Notification 通知
 *   B5: LifespanService.SECONDS_PER_YEAR 未定义 → 已补静态常量
 *   B6: updateLifespan 返回值缺 deadCount/deadPlayers → 已补返回
 *   B19: 0.2 损失率硬编码 → 改读 game_balance.json lifespan.death_exp_loss_rate
 *   B20: /60 /365 硬编码 → 改读 game_balance.json lifespan.seconds_per_day / days_per_year
 */
const Player = require('../../models/player');
// 修复：统一通过 modules/index.js 导出引用 ConfigLoader
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;

class LifespanService {
    /**
     * 一年对应的秒数（用于 GM 时间加速参数换算）
     * 默认 365 * 24 * 3600 = 31536000，可被 game_balance.json lifespan.seconds_per_year 覆盖
     */
    static get SECONDS_PER_YEAR() {
        const cfg = this._getLifespanConfig();
        return cfg.seconds_per_year || 31536000;
    }

    /**
     * 读取寿命相关配置
     * @returns {Object} 寿命配置对象
     */
    static _getLifespanConfig() {
        try {
            const config = configLoader.getConfig('game_balance');
            return config?.lifespan || {};
        } catch (e) {
            console.warn('读取 lifespan 配置失败:', e.message);
            return {};
        }
    }

    /**
     * 更新所有未闭关玩家的寿命
     *
     * 定时任务调用：server/index.js 中按 lifespan_update_interval_ms 间隔触发。
     * 闭关中的玩家不衰老（与"闭关时间停止"修仙设定一致）。
     *
     * 修复 4-3-P0-3：性能优化
     *   1. 查询条件增加 is_dead=false，跳过已死亡玩家（避免在循环中再次触发 handleLifespanEnd）
     *   2. 批量保存：使用 Player.update 单条 UPDATE 而非逐个 save()，减少 N 次写为 1 次（非死亡玩家）
     *   3. 死亡玩家仍走 handleLifespanEnd（需触发通知/审计）
     *   4. 受 batch_size 配置约束（lifespan.update_batch_size，默认 200）
     *
     * @param {number} secondsPassed - 经过的秒数
     * @returns {Promise<{processed: number, deadCount: number, deadPlayers: Array}>}
     *   deadCount：本次更新中寿元耗尽的玩家数
     *   deadPlayers：寿元耗尽的玩家简要信息数组，供 GM 时间加速接口判断当前玩家是否死亡
     */
    async updateLifespan(secondsPassed) {
        const cfg = LifespanService._getLifespanConfig();
        const deadPlayers = [];
        let processed = 0;

        try {
            if (!Number.isFinite(secondsPassed) || secondsPassed <= 0) {
                // 参数无效：直接返回，避免 NaN 污染 lifespan_current 字段
                return { processed: 0, deadCount: 0, deadPlayers: [] };
            }

            // 闭关中的玩家不参与衰老；已死亡玩家跳过（P0-3 修复：避免重复触发死亡流程）
            const batchSize = cfg.update_batch_size || 200;
            const players = await Player.findAll({
                where: {
                    is_secluded: false,
                    is_dead: false
                },
                limit: batchSize
            });

            const roleInitConfig = configLoader.getConfig('role_init');
            const agingRate = this.calculateAgingRate(roleInitConfig);
            const daysPerYear = cfg.days_per_year || 365;
            const secondsPerDay = cfg.seconds_per_day || 60;

            // P0-3 性能优化：收集非死亡玩家的更新数据，批量 UPDATE
            // 死亡玩家仍走 handleLifespanEnd（需要推送通知 + 审计）
            const aliveUpdates = []; // [{ id, lifespan_current }]

            for (const player of players) {
                const daysPassed = secondsPassed / secondsPerDay;
                const ageIncrease = daysPassed / daysPerYear;

                const newAge = parseFloat((player.lifespan_current || 0) + ageIncrease * agingRate);

                if (newAge >= (player.lifespan_max || 0)) {
                    // 寿元耗尽：先更新内存中的 lifespan_current 到 max，再走 handleLifespanEnd
                    player.lifespan_current = player.lifespan_max;
                    const deathInfo = await this.handleLifespanEnd(player);
                    if (deathInfo) {
                        deadPlayers.push(deathInfo);
                    }
                } else {
                    // 非死亡玩家：收集到批量更新列表
                    player.lifespan_current = newAge;
                    aliveUpdates.push({ id: player.id, lifespan_current: newAge });
                }

                processed++;
            }

            // 批量更新非死亡玩家（单条 UPDATE 语句，避免 N 次 save()）
            // MySQL 5.6 支持 UPDATE ... SET ... WHERE id IN (...)，但不同行不同值需用 CASE WHEN
            if (aliveUpdates.length > 0) {
                // 修复 4-3-P0-3-补丁：require 路径应为 ../../config/database（server/models 无 index.js）
                const sequelize = require('../../config/database');
                const ids = aliveUpdates.map(u => u.id);
                // 使用 CASE WHEN 一次更新多行不同值（比 N 次 save 快 N 倍）
                const caseClause = aliveUpdates
                    .map(u => `WHEN ${u.id} THEN ${Number(u.lifespan_current).toFixed(6)}`)
                    .join(' ');
                await sequelize.query(
                    `UPDATE players SET lifespan_current = CASE id ${caseClause} END WHERE id IN (${ids.join(',')})`,
                    { type: sequelize.QueryTypes.UPDATE }
                );
            }

            return { processed, deadCount: deadPlayers.length, deadPlayers };
        } catch (error) {
            console.error('寿命更新失败:', error);
            throw error;
        }
    }

    /**
     * 计算衰老速率
     */
    calculateAgingRate(config) {
        if (!config) return 1;
        return config.agingRate || 1;
    }

    /**
     * 计算经过的天数
     *
     * 修复 B20：从配置读取 seconds_per_day（默认 60 秒=1 天），不再硬编码 /60
     */
    calculateDaysPassed(secondsPassed, isSecluded) {
        if (isSecluded) return 0;
        const cfg = LifespanService._getLifespanConfig();
        const secondsPerDay = cfg.seconds_per_day || 60;
        if (secondsPerDay <= 0) return 0;
        return secondsPassed / secondsPerDay;
    }

    /**
     * 处理寿命耗尽（玩家死亡）
     *
     * 修复 B2/B3/B4：补 player.save()、设置 is_dead=true、推送 WebSocket 与通知
     * 修复 B19：损失率从硬编码 0.2 改为读 game_balance.json lifespan.death_exp_loss_rate（默认 0.1）
     * 修复 4-3-P0-1：入口校验 is_dead，避免定时任务重复触发死亡（已死亡玩家直接返回 null）
     * 修复 4-3-P0-3：updateLifespan 中改用 is_dead=false 条件过滤，避免循环中对已死亡玩家再次处理
     *
     * @param {Object} player - 玩家实例（调用方需保证已加锁或在事务中）
     * @returns {Promise<{playerId: number, nickname: string, expLoss: string, message: string}|null>}
     *   已死亡或参数无效返回 null
     */
    async handleLifespanEnd(player) {
        if (!player) return null;

        // P0-1 修复：已死亡的玩家不再重复触发死亡流程（避免重复扣修为/重复推送通知）
        if (player.is_dead === true) {
            return null;
        }

        const cfg = LifespanService._getLifespanConfig();
        const lossRate = cfg.death_exp_loss_rate ?? 0.1;  // 默认 0.1（与 combat.death_exp_penalty_rate 一致）

        const currentExp = BigInt(player.exp || 0);
        const expLoss = currentExp * BigInt(Math.round(lossRate * 100)) / 100n;
        const newExp = currentExp - expLoss;
        player.exp = newExp < 0n ? 0n : newExp;

        player.hp_current = BigInt(cfg.death_hp_current ?? 0);
        player.is_dead = true;                          // B3 修复：标记死亡状态
        player.lifespan_current = player.lifespan_max;  // 寿元定格在 max
        player.death_reason = '寿元耗尽';                // 记录死亡原因
        player.death_time = new Date();                 // 记录死亡时间

        // 落库：B2 修复
        try {
            await player.save();
        } catch (e) {
            console.error(`[LifespanService] 保存死亡玩家 ${player.id} 失败:`, e);
            // 即使 save 失败也要继续推送通知，确保玩家感知
        }

        // 推送通知：B4 修复
        // 1. WebSocket 通知玩家本人与全局
        try {
            const WebSocketNotificationService = require('../services/WebSocketNotificationService');
            const deathPayload = {
                player_id: player.id,
                reason: '寿元耗尽',
                exp_loss: expLoss.toString(),
                timestamp: new Date().toISOString()
            };
            // 玩家本人：触发前端 DeathOverlay 显示
            WebSocketNotificationService.notifyPlayerUpdate(player.id, 'player_death', deathPayload);
            // 全局广播：让其他在线玩家感知"某位道友陨落"
            WebSocketNotificationService.broadcastNotification({
                type: 'player_death',
                title: '道友陨落',
                content: `${player.nickname || '某位道友'} 寿元耗尽，已身死道消。`,
                level: 'warn',
                ...deathPayload
            });
        } catch (e) {
            console.warn(`[LifespanService] 推送玩家 ${player.id} 死亡通知失败:`, e.message);
        }

        // 2. 持久化系统通知（玩家上线后可在通知中心查看）
        try {
            const NotificationService = require('../services/NotificationService');
            if (typeof NotificationService.sendDeathNotification === 'function') {
                await NotificationService.sendDeathNotification(player, '寿元耗尽');
            }
        } catch (e) {
            console.warn(`[LifespanService] 持久化玩家 ${player.id} 死亡通知失败:`, e.message);
        }

        return {
            playerId: player.id,
            nickname: player.nickname,
            expLoss: expLoss.toString(),
            message: `寿元耗尽，修为损失 ${Math.round(lossRate * 100)}%`
        };
    }

    /**
     * 使用延寿丹
     */
    async useLongevityPill(playerId, years) {
        const player = await Player.findByPk(playerId);
        if (!player) return null;

        player.lifespan_max += years;
        await player.save();

        return {
            currentLifespan: player.lifespan_current,
            maxLifespan: player.lifespan_max,
            addedYears: years
        };
    }

    /**
     * 获取寿命状态
     */
    getLifespanStatus(player) {
        const remaining = (player.lifespan_max || 0) - (player.lifespan_current || 0);
        const percentage = player.lifespan_max > 0
            ? ((player.lifespan_max - player.lifespan_current) / player.lifespan_max * 100).toFixed(1)
            : 0;

        return {
            current: player.lifespan_current,
            max: player.lifespan_max,
            remaining,
            percentage: parseFloat(percentage),
            status: remaining <= 0 ? 'danger' : (remaining < player.lifespan_max * 0.2 ? 'warning' : 'normal')
        };
    }
}

module.exports = new LifespanService();
