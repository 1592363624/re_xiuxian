/**
 * 灵兽放养与偷菜服务（玩法文档第8节）
 *
 * 核心功能：
 *   1. 灵兽放养：将灵兽放到野外场所，按时间收获资源
 *   2. 灵兽偷菜：放养中的灵兽可偷其他玩家药园的成熟作物
 *   3. 护院拦截：被偷玩家的出战灵兽可拦截偷菜行为
 *   4. 自动结算：调度器每60s检查过期放养，自动结算
 *
 * 设计要点：
 *   - 放养中灵兽不能出战/喂养/互动（通过 is_pasturing 字段控制）
 *   - 偷菜成功率受灵兽速度/忠诚度/元素匹配/星级影响
 *   - 护院拦截率受出战灵兽速度/忠诚度/星级影响
 *   - 提前召回不结算放养产物，自动结算打8折，正常召回全额
 *   - 事务+行级锁防并发；WebSocket推送在事务提交后
 *   - 灵兽快照存储JSON，避免后续升级影响历史记录
 */
'use strict';

const { Op } = require('sequelize');
const { infrastructure } = require('../../modules');
const Player = require('../../models/player');
const SpiritBeast = require('../../models/spiritBeast');
const SpiritBeastPasture = require('../../models/spiritBeastPasture');
const GardenStealLog = require('../../models/gardenStealLog');
const PlayerGarden = require('../../models/playerGarden');
const sequelize = require('../../config/database');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const InventoryService = require('./InventoryService');

/**
 * 灵兽放养与偷菜服务（单例）
 */
class BeastPastureService {
    constructor() {
        this.config = null;
        this.initialized = false;
    }

    /**
     * 初始化服务，注入配置加载器
     * @param {object} configLoader - ConfigLoader 实例
     */
    initialize(configLoader) {
        this.config = configLoader.getConfig('spirit_beast_pasture_data');
        if (!this.config) {
            console.warn('[BeastPastureService] 配置未加载，服务不可用');
            return;
        }
        this.initialized = true;
        console.log('[BeastPastureService] 灵兽放养与偷菜服务初始化完成');
    }

    // ==================== 放养管理 ====================

    /**
     * 获取可用放养场所列表
     * @param {object} player - 玩家对象（含 realm_rank）
     * @returns {object} - { code, data: { locations, max_concurrent, min_duration, max_duration } }
     */
    getLocations(player) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const pastureConfig = this.config.pasture;
        const locations = pastureConfig.locations
            .filter(loc => player.realm_rank >= loc.min_realm_rank)
            .map(loc => ({
                location_key: loc.location_key,
                name: loc.name,
                description: loc.description,
                min_realm_rank: loc.min_realm_rank,
                preferred_elements: loc.preferred_elements,
                element_bonus_multiplier: loc.element_bonus_multiplier,
                yield_items: loc.yield_items
            }));

        return {
            code: 200,
            data: {
                locations,
                max_concurrent: pastureConfig.max_concurrent_beasts,
                min_duration_hours: pastureConfig.min_duration_hours,
                max_duration_hours: pastureConfig.max_duration_hours,
                current_active_count: 0 // 由调用方填充
            }
        };
    }

    /**
     * 开始放养
     * @param {object} player - 玩家对象
     * @param {number} beastId - 灵兽ID
     * @param {string} locationKey - 放养场所key
     * @param {number} durationHours - 放养时长（小时）
     * @returns {object} - { code, success, message, data }
     */
    async startPasture(player, beastId, locationKey, durationHours) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const pastureConfig = this.config.pasture;

        // 参数校验
        if (!beastId || !locationKey || !durationHours) {
            return { code: 400, success: false, message: '参数不完整：需要 beastId/locationKey/durationHours' };
        }
        if (durationHours < pastureConfig.min_duration_hours || durationHours > pastureConfig.max_duration_hours) {
            return { code: 400, success: false, message: `放养时长需在 ${pastureConfig.min_duration_hours}-${pastureConfig.max_duration_hours} 小时之间` };
        }

        // 查找放养场所
        const location = pastureConfig.locations.find(l => l.location_key === locationKey);
        if (!location) {
            return { code: 400, success: false, message: '无效的放养场所' };
        }
        if (player.realm_rank < location.min_realm_rank) {
            return { code: 400, success: false, message: `需要境界达到 ${location.min_realm_rank} 阶才能在此放养` };
        }

        const transaction = await sequelize.transaction();
        try {
            // 检查当前放养数量
            const activeCount = await SpiritBeastPasture.count({
                where: { player_id: player.id, status: 'active' },
                transaction
            });
            if (activeCount >= pastureConfig.max_concurrent_beasts) {
                await transaction.rollback();
                return { code: 400, success: false, message: `同时最多放养 ${pastureConfig.max_concurrent_beasts} 只灵兽` };
            }

            // 查找灵兽并加锁
            const beast = await SpiritBeast.findByPk(beastId, {
                lock: transaction.LOCK.UPDATE,
                transaction
            });
            if (!beast) {
                await transaction.rollback();
                return { code: 404, success: false, message: '灵兽不存在' };
            }
            if (beast.player_id !== player.id) {
                await transaction.rollback();
                return { code: 403, success: false, message: '无权操作此灵兽' };
            }
            if (beast.is_active) {
                await transaction.rollback();
                return { code: 400, success: false, message: '出战中的灵兽不能放养，请先取消出战' };
            }
            if (beast.is_pasturing) {
                await transaction.rollback();
                return { code: 400, success: false, message: '该灵兽已在放养中' };
            }

            // 创建放养记录
            const now = new Date();
            const endTime = new Date(now.getTime() + durationHours * 3600 * 1000);
            const beastSnapshot = this._createBeastSnapshot(beast);

            const pasture = await SpiritBeastPasture.create({
                player_id: player.id,
                beast_id: beastId,
                beast_snapshot: beastSnapshot,
                location_key: locationKey,
                location_name: location.name,
                start_time: now,
                end_time: endTime,
                status: 'active',
                yield_discount: 1.0
            }, { transaction });

            // 标记灵兽为放养中
            beast.is_pasturing = true;
            await beast.save({ transaction, silent: true });

            await transaction.commit();

            return {
                code: 200,
                data: {
                    pasture_id: pasture.id,
                    beast_id: beastId,
                    beast_name: beastSnapshot.beast_name,
                    location_key: locationKey,
                    location_name: location.name,
                    start_time: now.toISOString(),
                    end_time: endTime.toISOString(),
                    duration_hours: durationHours,
                    status: 'active'
                }
            };
        } catch (err) {
            if (transaction && !transaction.finished) await transaction.rollback();
            console.error('[BeastPastureService] 开始放养失败:', err.message);
            return { code: 500, success: false, message: '服务器错误' };
        }
    }

    /**
     * 手动召回灵兽（提前召回不结算放养产物，但保留偷菜收获）
     * @param {object} player - 玩家对象
     * @param {number} beastId - 灵兽ID
     * @returns {object} - { code, success, message, data }
     */
    async recallBeast(player, beastId) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const transaction = await sequelize.transaction();
        try {
            // 查找活跃放养记录
            const pasture = await SpiritBeastPasture.findOne({
                where: { player_id: player.id, beast_id: beastId, status: 'active' },
                lock: transaction.LOCK.UPDATE,
                transaction
            });
            if (!pasture) {
                await transaction.rollback();
                return { code: 404, success: false, message: '该灵兽未在放养中' };
            }

            const now = new Date();
            const isExpired = now >= pasture.end_time;
            const graceHours = this.config.pasture.auto_recall_grace_hours;
            const isOverdue = now > new Date(pasture.end_time.getTime() + graceHours * 3600 * 1000);

            // 判断召回类型
            let recallType, yieldDiscount;
            if (isOverdue) {
                // 超过宽限期，自动结算打8折
                recallType = 'auto';
                yieldDiscount = this.config.pasture.auto_recall_yield_discount;
            } else if (isExpired) {
                // 到达结束时间但未超宽限期，正常结算
                recallType = 'manual';
                yieldDiscount = 1.0;
            } else {
                // 提前召回，不结算放养产物
                recallType = 'early';
                yieldDiscount = this.config.pasture.early_recall_yield_discount;
            }

            // 结算放养
            const result = await this._settlePasture(pasture, recallType, yieldDiscount, transaction, player);

            await transaction.commit();

            // WebSocket推送（事务提交后）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, {
                    type: 'beast_pasture_recalled',
                    data: result
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                code: 200,
                data: result
            };
        } catch (err) {
            if (transaction && !transaction.finished) await transaction.rollback();
            console.error('[BeastPastureService] 召回失败:', err.message);
            return { code: 500, success: false, message: '服务器错误' };
        }
    }

    /**
     * 获取当前放养状态
     * @param {object} player - 玩家对象
     * @returns {object} - { code, data: { active_pastures, max_concurrent } }
     */
    async getPastureStatus(player) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const pastures = await SpiritBeastPasture.findAll({
            where: { player_id: player.id, status: 'active' },
            order: [['end_time', 'ASC']]
        });

        const now = new Date();
        const activePastures = pastures.map(p => {
            const remaining = Math.max(0, Math.floor((new Date(p.end_time) - now) / 1000));
            const snapshot = p.beast_snapshot || {};
            return {
                pasture_id: p.id,
                beast_id: p.beast_id,
                beast_name: snapshot.beast_name || '未知灵兽',
                beast_element: snapshot.element,
                beast_star_level: snapshot.star_level,
                location_key: p.location_key,
                location_name: p.location_name,
                start_time: p.start_time,
                end_time: p.end_time,
                remaining_seconds: remaining,
                is_expired: now >= p.end_time,
                steal_count: p.steal_count,
                stolen_count: p.stolen_count,
                status: p.status
            };
        });

        return {
            code: 200,
            data: {
                active_pastures: activePastures,
                active_count: activePastures.length,
                max_concurrent: this.config.pasture.max_concurrent_beasts
            }
        };
    }

    /**
     * 获取放养历史
     * @param {object} player - 玩家对象
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object} - { code, data: { history, total, page, page_size } }
     */
    async getPastureHistory(player, page = 1, pageSize = 10) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const offset = (page - 1) * pageSize;
        const { rows, count } = await SpiritBeastPasture.findAndCountAll({
            where: { player_id: player.id, status: { [Op.ne]: 'active' } },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset
        });

        const history = rows.map(p => ({
            pasture_id: p.id,
            beast_name: p.beast_snapshot?.beast_name || '未知灵兽',
            location_name: p.location_name,
            start_time: p.start_time,
            end_time: p.end_time,
            actual_end_time: p.actual_end_time,
            status: p.status,
            recall_type: p.recall_type,
            yield_snapshot: p.yield_snapshot,
            steal_count: p.steal_count,
            stolen_count: p.stolen_count,
            steal_yields: p.steal_yields,
            yield_discount: p.yield_discount
        }));

        return {
            code: 200,
            data: { history, total: count, page, page_size: pageSize }
        };
    }

    // ==================== 偷菜系统 ====================

    /**
     * 偷菜：放养中的灵兽偷其他玩家药园的成熟作物
     * @param {object} player - 偷菜方玩家
     * @param {number} beastId - 偷菜灵兽ID（必须在放养中）
     * @param {number} targetPlayerId - 被偷方玩家ID
     * @param {number} targetPlotIndex - 目标地块序号（可选，不指定则随机选成熟地块）
     * @returns {object} - { code, success, message, data }
     */
    async stealCrops(player, beastId, targetPlayerId, targetPlotIndex = null) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const stealConfig = this.config.steal;

        // 不能偷自己
        if (player.id === targetPlayerId) {
            return { code: 400, success: false, message: '不能偷自己的药园' };
        }

        const transaction = await sequelize.transaction();
        try {
            // 查找灵兽并验证放养状态
            const beast = await SpiritBeast.findByPk(beastId, {
                lock: transaction.LOCK.UPDATE,
                transaction
            });
            if (!beast) {
                await transaction.rollback();
                return { code: 404, success: false, message: '灵兽不存在' };
            }
            if (beast.player_id !== player.id) {
                await transaction.rollback();
                return { code: 403, success: false, message: '无权操作此灵兽' };
            }
            if (!beast.is_pasturing) {
                await transaction.rollback();
                return { code: 400, success: false, message: '只有放养中的灵兽才能偷菜' };
            }

            // 查找灵兽的放养记录
            const pasture = await SpiritBeastPasture.findOne({
                where: { player_id: player.id, beast_id: beastId, status: 'active' },
                transaction
            });
            if (!pasture) {
                await transaction.rollback();
                return { code: 400, success: false, message: '未找到活跃放养记录' };
            }

            // 冷却校验：同灵兽1小时冷却
            const lastSteal = await GardenStealLog.findOne({
                where: {
                    attacker_player_id: player.id,
                    attacker_beast_id: beastId,
                    created_at: { [Op.gte]: new Date(Date.now() - stealConfig.cooldown_seconds_per_beast * 1000) }
                },
                order: [['created_at', 'DESC']],
                transaction
            });
            if (lastSteal) {
                const remaining = Math.ceil((new Date(lastSteal.createdAt).getTime() + stealConfig.cooldown_seconds_per_beast * 1000 - Date.now()) / 1000);
                await transaction.rollback();
                return { code: 400, success: false, message: `该灵兽偷菜冷却中，剩余 ${remaining} 秒` };
            }

            // 每日偷菜次数校验
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayStealCount = await GardenStealLog.count({
                where: {
                    attacker_player_id: player.id,
                    created_at: { [Op.gte]: todayStart }
                },
                transaction
            });
            if (todayStealCount >= stealConfig.daily_steal_limit_total) {
                await transaction.rollback();
                return { code: 400, success: false, message: `今日偷菜次数已达上限（${stealConfig.daily_steal_limit_total}次）` };
            }

            // 查找目标玩家的成熟地块
            const targetGardenService = require('./GardenService');
            await targetGardenService._refreshMatureStatus(targetPlayerId);

            const matureWhere = { player_id: targetPlayerId, status: 'mature' };
            if (targetPlotIndex !== null) {
                matureWhere.plot_index = targetPlotIndex;
            }

            // 目标地块冷却校验（同一地块24小时内只能被偷一次）
            const targetCooldownSec = stealConfig.target_cooldown_seconds;
            const recentStealOnPlot = await GardenStealLog.findOne({
                where: {
                    target_player_id: targetPlayerId,
                    target_plot_index: targetPlotIndex,
                    result: 'success',
                    created_at: { [Op.gte]: new Date(Date.now() - targetCooldownSec * 1000) }
                },
                order: [['created_at', 'DESC']],
                transaction
            });
            if (recentStealOnPlot && targetPlotIndex !== null) {
                await transaction.rollback();
                return { code: 400, success: false, message: '该地块近期已被偷过，请换一块试试' };
            }

            // 查找成熟地块
            let targetPlot = await PlayerGarden.findOne({
                where: matureWhere,
                lock: transaction.LOCK.UPDATE,
                transaction
            });

            if (!targetPlot) {
                await transaction.rollback();
                return { code: 400, success: false, message: '目标药园没有可偷的成熟作物' };
            }

            // 查找被偷方玩家信息
            const targetPlayer = await Player.findByPk(targetPlayerId, { transaction });
            if (!targetPlayer) {
                await transaction.rollback();
                return { code: 404, success: false, message: '目标玩家不存在' };
            }

            // 查找被偷方的护院灵兽（出战中的灵兽）
            const guardBeast = await SpiritBeast.findOne({
                where: { player_id: targetPlayerId, is_active: true },
                transaction
            });

            // 计算偷菜成功率
            const successRate = this._calculateStealSuccessRate(beast, targetPlot, guardBeast);
            const roll = Math.random();
            const isSuccess = roll < successRate;

            // 如果有护院灵兽，计算拦截
            let isIntercepted = false;
            let counterDamage = 0;
            if (guardBeast && isSuccess) {
                const interceptRate = this._calculateInterceptRate(guardBeast);
                isIntercepted = Math.random() < interceptRate;
                if (isIntercepted) {
                    // 反伤 = 护院灵兽攻击力 × 反伤比例
                    counterDamage = Math.floor((guardBeast.atk || 0) * stealConfig.guard.intercept_counter_damage_rate);
                }
            }

            // 确定最终结果
            let result, stolenQty = 0, expGained = 0, loyaltyChange = 0;
            const beastSnapshot = this._createBeastSnapshot(beast);
            const guardSnapshot = guardBeast ? this._createBeastSnapshot(guardBeast) : null;

            if (isIntercepted) {
                // 被拦截：偷菜失败，灵兽受伤，忠诚度下降
                result = 'intercepted';
                loyaltyChange = -stealConfig.yield.penalty_loyalty_on_intercepted;
            } else if (isSuccess) {
                // 偷菜成功
                result = 'success';
                stolenQty = this._rollStolenQty(stealConfig);
                // 确保偷的数量不超过地块实际产量（base_yield）
                stolenQty = Math.min(stolenQty, targetPlot.base_yield || 1);
                if (stolenQty < 1) stolenQty = 1;
                expGained = stealConfig.yield.bonus_exp_on_success;
                loyaltyChange = stealConfig.yield.bonus_loyalty_on_success;

                // 从被偷方地块扣除作物（将状态改回 empty，减少 base_yield）
                // 注意：偷菜不改变地块状态，只是减少可收获的数量
                // 设计选择：偷菜直接拿走部分成熟作物，地块仍保持 mature 状态但产量减少
                const newBaseYield = Math.max(0, (targetPlot.base_yield || 0) - stolenQty);
                if (newBaseYield === 0) {
                    // 全部被偷完，地块清空
                    targetPlot.status = 'empty';
                    targetPlot.seed_id = null;
                    targetPlot.produce_item_id = null;
                    targetPlot.planted_at = null;
                    targetPlot.mature_at = null;
                    targetPlot.base_yield = 0;
                } else {
                    targetPlot.base_yield = newBaseYield;
                }
                await targetPlot.save({ transaction, silent: true });

                // 将偷到的作物加入偷菜方背包（容错：物品配置缺失时不影响偷菜主流程）
                const produceItemId = targetPlot.produce_item_id || targetPlot.seed_id;
                if (produceItemId) {
                    try {
                        await InventoryService.addItem(player.id, produceItemId, stolenQty, transaction);
                    } catch (e) {
                        console.warn(`[BeastPastureService] 偷菜收获 ${produceItemId} 添加背包失败（已跳过）: ${e.message}`);
                    }
                }

                // 更新放养记录的偷菜次数
                pasture.steal_count += 1;
                // 记录偷菜收获
                const stealYields = pasture.steal_yields || [];
                stealYields.push({
                    item_id: produceItemId,
                    qty: stolenQty,
                    stolen_from: targetPlayerId,
                    time: new Date().toISOString()
                });
                pasture.steal_yields = stealYields;
                await pasture.save({ transaction, silent: true });
            } else {
                // 偷菜失败（非拦截）
                result = 'failed';
                loyaltyChange = -stealConfig.yield.penalty_loyalty_on_failed;
            }

            // 更新灵兽经验和忠诚度
            if (expGained > 0) {
                beast.exp = BigInt(beast.exp || 0) + BigInt(expGained);
            }
            beast.loyalty = Math.max(0, Math.min(100, beast.loyalty + loyaltyChange));
            await beast.save({ transaction, silent: true });

            // 创建偷菜日志
            const stealLog = await GardenStealLog.create({
                attacker_player_id: player.id,
                attacker_beast_id: beastId,
                attacker_beast_snapshot: beastSnapshot,
                target_player_id: targetPlayerId,
                target_plot_index: targetPlot.plot_index,
                target_seed_id: targetPlot.seed_id,
                target_produce_item_id: targetPlot.produce_item_id,
                stolen_qty: stolenQty,
                stolen_quality: null,
                guard_beast_id: guardBeast ? guardBeast.id : null,
                guard_beast_snapshot: guardSnapshot,
                result,
                counter_damage: counterDamage,
                exp_gained: expGained,
                loyalty_change: loyaltyChange
            }, { transaction });

            await transaction.commit();

            // WebSocket推送（事务提交后）
            if (stealConfig.notification.notify_target_on_steal && result === 'success') {
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, {
                        type: 'garden_stolen',
                        data: {
                            log_id: stealLog.id,
                            attacker_player_id: player.id,
                            stolen_qty: stolenQty,
                            plot_index: targetPlot.plot_index,
                            produce_item_id: targetPlot.produce_item_id,
                            message: `你的药园地块 ${targetPlot.plot_index} 被偷走了 ${stolenQty} 个作物！`
                        }
                    });
                } catch (e) { /* 推送失败不影响主流程 */ }
            }
            if (stealConfig.notification.notify_target_on_intercept && result === 'intercepted') {
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, {
                        type: 'garden_intercepted',
                        data: {
                            log_id: stealLog.id,
                            attacker_player_id: player.id,
                            guard_beast_name: guardSnapshot?.beast_name,
                            message: `你的护院灵兽 ${guardSnapshot?.beast_name || ''} 成功拦截了一次偷菜！`
                        }
                    });
                } catch (e) { /* 推送失败不影响主流程 */ }
            }

            return {
                code: 200,
                data: {
                    log_id: stealLog.id,
                    result,
                    stolen_qty: stolenQty,
                    produce_item_id: targetPlot.produce_item_id,
                    counter_damage: counterDamage,
                    exp_gained: expGained,
                    loyalty_change: loyaltyChange,
                    beast_loyalty: beast.loyalty,
                    has_guard: !!guardBeast,
                    guard_beast_name: guardSnapshot?.beast_name || null,
                    message: result === 'success' ? `偷菜成功！获得 ${stolenQty} 个作物` :
                             result === 'intercepted' ? `被护院灵兽拦截！灵兽受伤，忠诚度-${Math.abs(loyaltyChange)}` :
                             '偷菜失败'
                }
            };
        } catch (err) {
            if (transaction && !transaction.finished) await transaction.rollback();
            console.error('[BeastPastureService] 偷菜失败:', err.message);
            return { code: 500, success: false, message: '服务器错误: ' + err.message };
        }
    }

    /**
     * 获取偷菜历史（我偷别人）
     * @param {object} player - 玩家对象
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object}
     */
    async getStealHistory(player, page = 1, pageSize = 10) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const offset = (page - 1) * pageSize;
        const { rows, count } = await GardenStealLog.findAndCountAll({
            where: { attacker_player_id: player.id },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset
        });

        const history = rows.map(log => ({
            log_id: log.id,
            created_at: log.createdAt,
            target_player_id: log.target_player_id,
            target_plot_index: log.target_plot_index,
            produce_item_id: log.target_produce_item_id,
            stolen_qty: log.stolen_qty,
            result: log.result,
            counter_damage: log.counter_damage,
            has_guard: !!log.guard_beast_id,
            guard_beast_name: log.guard_beast_snapshot?.beast_name || null,
            exp_gained: log.exp_gained,
            loyalty_change: log.loyalty_change
        }));

        return {
            code: 200,
            data: { history, total: count, page, page_size: pageSize }
        };
    }

    /**
     * 获取被偷历史（别人偷我）
     * @param {object} player - 玩家对象
     * @param {number} page - 页码
     * @param {number} pageSize - 每页条数
     * @returns {object}
     */
    async getStolenHistory(player, page = 1, pageSize = 10) {
        if (!this.initialized) return { code: 500, success: false, message: '服务未初始化' };

        const offset = (page - 1) * pageSize;
        const { rows, count } = await GardenStealLog.findAndCountAll({
            where: { target_player_id: player.id, result: 'success' },
            order: [['created_at', 'DESC']],
            limit: pageSize,
            offset
        });

        const history = rows.map(log => ({
            log_id: log.id,
            created_at: log.createdAt,
            attacker_player_id: log.attacker_player_id,
            attacker_beast_name: log.attacker_beast_snapshot?.beast_name || '未知灵兽',
            plot_index: log.target_plot_index,
            produce_item_id: log.target_produce_item_id,
            stolen_qty: log.stolen_qty,
            has_guard: !!log.guard_beast_id
        }));

        return {
            code: 200,
            data: { history, total: count, page, page_size: pageSize }
        };
    }

    // ==================== 调度器：自动结算过期放养 ====================

    /**
     * 检查过期放养并自动结算
     * 由调度器每60秒调用
     */
    async checkExpirations() {
        if (!this.initialized) return;

        const now = new Date();
        const graceHours = this.config.pasture.auto_recall_grace_hours;
        const overdueTime = new Date(now.getTime() - graceHours * 3600 * 1000);

        // 查找超过宽限期的活跃放养记录
        const expiredPastures = await SpiritBeastPasture.findAll({
            where: {
                status: 'active',
                end_time: { [Op.lt]: overdueTime }
            },
            limit: this.config.scheduler.batch_size
        });

        for (const pasture of expiredPastures) {
            try {
                const player = await Player.findByPk(pasture.player_id);
                if (!player) continue;

                const transaction = await sequelize.transaction();
                try {
                    // 重新加锁获取
                    const lockedPasture = await SpiritBeastPasture.findByPk(pasture.id, {
                        lock: transaction.LOCK.UPDATE,
                        transaction
                    });
                    if (!lockedPasture || lockedPasture.status !== 'active') {
                        await transaction.rollback();
                        continue;
                    }

                    // 自动结算打8折
                    await this._settlePasture(lockedPasture, 'auto', this.config.pasture.auto_recall_yield_discount, transaction, player);
                    await transaction.commit();

                    console.log(`[BeastPastureService] 自动结算放养 #${lockedPasture.id}`);
                } catch (e) {
                    if (transaction && !transaction.finished) await transaction.rollback();
                    console.error(`[BeastPastureService] 自动结算放养 #${pasture.id} 失败:`, e.message);
                }
            } catch (e) {
                console.error(`[BeastPastureService] 处理放养 #${pasture.id} 失败:`, e.message);
            }
        }
    }

    // ==================== 内部方法 ====================

    /**
     * 创建灵兽快照
     * @param {object} beast - 灵兽实例
     * @returns {object} - 快照对象
     */
    _createBeastSnapshot(beast) {
        return {
            beast_id: beast.id,
            beast_key: beast.beast_key,
            beast_name: beast.beast_name || beast.beast_key,
            element: beast.element,
            rarity: beast.rarity,
            star_level: beast.star_level,
            level: beast.level,
            hp_max: beast.hp_max?.toString() || '0',
            atk: beast.atk,
            def: beast.def,
            speed: beast.speed,
            loyalty: beast.loyalty
        };
    }

    /**
     * 结算放养（内部方法）
     * @param {object} pasture - 放养记录（已加锁）
     * @param {string} recallType - 召回类型
     * @param {number} yieldDiscount - 产物折扣
     * @param {object} transaction - 事务
     * @param {object} player - 玩家对象
     * @returns {object} - 结算结果
     */
    async _settlePasture(pasture, recallType, yieldDiscount, transaction, player) {
        const now = new Date();
        const pastureConfig = this.config.pasture;
        const snapshot = pasture.beast_snapshot || {};

        // 计算放养时长（小时）
        const durationMs = now - new Date(pasture.start_time);
        const durationHours = durationMs / (3600 * 1000);

        // 计算产物
        let yieldSnapshot = [];
        let expGained = 0;
        let loyaltyChange = pastureConfig.loyalty_gain_on_return;

        if (yieldDiscount > 0) {
            // 查找放养场所配置
            const location = pastureConfig.locations.find(l => l.location_key === pasture.location_key);
            if (location) {
                yieldSnapshot = this._rollYields(location, snapshot, durationHours, yieldDiscount);
            }
            // 经验 = 每小时经验 × 时长
            expGained = Math.floor(pastureConfig.exp_gain_per_hour * durationHours * yieldDiscount);
        }

        // 忠诚度变化 = 每小时-2 × 时长 + 回归加成
        loyaltyChange = Math.floor(pastureConfig.loyalty_change_per_hour * durationHours) + pastureConfig.loyalty_gain_on_return;

        // 更新放养记录
        pasture.status = recallType === 'auto' ? 'auto_settled' : 'recalled';
        pasture.recall_type = recallType;
        pasture.actual_end_time = now;
        pasture.yield_snapshot = yieldSnapshot;
        pasture.yield_discount = yieldDiscount;
        await pasture.save({ transaction, silent: true });

        // 解除灵兽放养状态
        const beast = await SpiritBeast.findByPk(pasture.beast_id, {
            lock: transaction.LOCK.UPDATE,
            transaction
        });
        if (beast) {
            beast.is_pasturing = false;
            // 应用经验和忠诚度变化
            if (expGained > 0) {
                beast.exp = BigInt(beast.exp || 0) + BigInt(expGained);
            }
            beast.loyalty = Math.max(0, Math.min(100, beast.loyalty + loyaltyChange));
            await beast.save({ transaction, silent: true });
        }

        // 将产物加入玩家背包（容错：单个物品添加失败不影响整体结算）
        for (const item of yieldSnapshot) {
            if (item.qty > 0) {
                try {
                    await InventoryService.addItem(player.id, item.item_id, item.qty, transaction);
                } catch (e) {
                    // 物品配置缺失等异常不应阻断整个结算流程，仅记录警告
                    console.warn(`[BeastPastureService] 添加放养产物 ${item.item_id} 失败（已跳过）: ${e.message}`);
                }
            }
        }

        return {
            pasture_id: pasture.id,
            beast_id: pasture.beast_id,
            beast_name: snapshot.beast_name || '未知灵兽',
            location_name: pasture.location_name,
            recall_type: recallType,
            duration_hours: Number(durationHours.toFixed(2)),
            yields: yieldSnapshot,
            steal_count: pasture.steal_count,
            stolen_count: pasture.stolen_count,
            steal_yields: pasture.steal_yields,
            exp_gained: expGained,
            loyalty_change: loyaltyChange,
            yield_discount: yieldDiscount,
            status: pasture.status
        };
    }

    /**
     * 滚动随机产物
     * @param {object} location - 放养场所配置
     * @param {object} beastSnapshot - 灵兽快照
     * @param {number} hours - 放养时长
     * @param {number} discount - 产物折扣
     * @returns {array} - 产物列表 [{ item_id, name, qty }]
     */
    _rollYields(location, beastSnapshot, hours, discount) {
        const pastureConfig = this.config.pasture;
        const yields = [];

        // 基础产量 = 每小时产量 × 时长 × 元素加成 × 星级加成 × 等级加成
        let baseYieldPerHour = pastureConfig.base_yield_per_hour;
        const starBonus = (beastSnapshot.star_level || 1) * pastureConfig.yield_per_star_level;
        const levelBonus = (beastSnapshot.level || 1) * pastureConfig.yield_per_level;
        baseYieldPerHour += starBonus + levelBonus;

        // 元素匹配加成
        if (location.preferred_elements.includes(beastSnapshot.element)) {
            baseYieldPerHour *= location.element_bonus_multiplier;
        }

        const totalYield = Math.floor(baseYieldPerHour * hours * discount);
        if (totalYield <= 0) return yields;

        // 按权重随机分配产物
        const totalWeight = location.yield_items.reduce((sum, item) => sum + item.weight, 0);
        let remainingYield = totalYield;

        while (remainingYield > 0) {
            // 随机选择一个产物
            const roll = Math.random() * totalWeight;
            let accWeight = 0;
            let selectedItem = null;
            for (const item of location.yield_items) {
                accWeight += item.weight;
                if (roll < accWeight) {
                    selectedItem = item;
                    break;
                }
            }
            if (!selectedItem) selectedItem = location.yield_items[0];

            // 随机数量
            const qty = Math.min(remainingYield, selectedItem.min_qty + Math.floor(Math.random() * (selectedItem.max_qty - selectedItem.min_qty + 1)));
            if (qty > 0) {
                // 合并相同物品
                const existing = yields.find(y => y.item_id === selectedItem.item_id);
                if (existing) {
                    existing.qty += qty;
                } else {
                    yields.push({
                        item_id: selectedItem.item_id,
                        name: selectedItem.name,
                        qty: qty
                    });
                }
                remainingYield -= qty;
            } else {
                break;
            }
        }

        return yields;
    }

    /**
     * 计算偷菜成功率
     * @param {object} attackerBeast - 偷菜灵兽
     * @param {object} targetPlot - 目标地块
     * @param {object|null} guardBeast - 护院灵兽（无则null）
     * @returns {number} - 成功率（0-1）
     */
    _calculateStealSuccessRate(attackerBeast, targetPlot, guardBeast) {
        const cfg = this.config.steal.success_rate;
        const guardCfg = this.config.steal.guard;

        let rate = cfg.base;

        // 速度加成
        const speedBonus = Math.min(cfg.speed_bonus_max, (attackerBeast.speed || 0) * cfg.speed_bonus_per_point);
        rate += speedBonus;

        // 忠诚度加成
        const loyaltyBonus = Math.min(cfg.loyalty_bonus_max, (attackerBeast.loyalty || 0) * cfg.loyalty_bonus_per_point);
        rate += loyaltyBonus;

        // 星级加成
        const starBonus = Math.min(cfg.star_level_bonus_max, (attackerBeast.star_level || 1) * cfg.star_level_bonus_per_star);
        rate += starBonus;

        // 无护院灵兽时额外加成
        if (!guardBeast) {
            rate += guardCfg.no_guard_success_bonus;
        }

        return Math.min(0.95, Math.max(0.05, rate));
    }

    /**
     * 计算护院灵兽拦截率
     * @param {object} guardBeast - 护院灵兽
     * @returns {number} - 拦截率（0-1）
     */
    _calculateInterceptRate(guardBeast) {
        const cfg = this.config.steal.guard;

        let rate = cfg.intercept_base_rate;

        // 速度加成
        const speedBonus = Math.min(cfg.intercept_speed_bonus_max, (guardBeast.speed || 0) * cfg.intercept_speed_bonus_per_point);
        rate += speedBonus;

        // 忠诚度加成
        const loyaltyBonus = Math.min(cfg.intercept_loyalty_bonus_max, (guardBeast.loyalty || 0) * cfg.intercept_loyalty_bonus_per_point);
        rate += loyaltyBonus;

        // 星级加成
        const starBonus = Math.min(cfg.intercept_star_level_bonus_max, (guardBeast.star_level || 1) * cfg.intercept_star_level_bonus_per_star);
        rate += starBonus;

        return Math.min(0.9, Math.max(0.1, rate));
    }

    /**
     * 滚动偷菜数量
     * @param {object} stealConfig - 偷菜配置
     * @returns {number} - 偷取数量
     */
    _rollStolenQty(stealConfig) {
        const min = stealConfig.yield.min_crops;
        const max = stealConfig.yield.max_crops;
        return min + Math.floor(Math.random() * (max - min + 1));
    }
}

// 单例导出
module.exports = new BeastPastureService();
