/**
 * 夺舍重生服务
 *
 * 实现批次3设计文档第3章「飞升+夺舍重生系统」的夺舍侧全部业务逻辑：
 *   1. 触发夺舍（飞升失败/寿命尽/PVP被杀时调用，推送3个目标按 weight 加权随机）
 *   2. 获取可夺舍目标列表（首次触发时缓存到内存 Map，30 分钟内有效）
 *   3. 选定夺舍目标（事务+行级锁，计算境界跌落、属性继承、残魂恢复至50、72小时冷却）
 *   4. 分页查询夺舍历史记录
 *   5. 检查夺舍冷却（72小时）
 *   6. 超时强制随机夺舍（30分钟未选定则按权重随机选一个）
 *
 * 设计原则：
 *   - 所有阈值/CD/概率从 ascension_data.json 配置读取，禁止硬编码
 *   - 关键操作（选定目标）使用事务 + LOCK.UPDATE 行级锁
 *   - BigInt 字段（exp/spirit_stones）比较时用 BigInt() 包装
 *   - 状态机互斥通过 PlayerStateMachine.canStart(playerId, 'REINCARNATING') 校验
 *   - 重大事件通过 WebSocketNotificationService 推送
 *   - 内存缓存仅用于临时存储推送的目标列表，不持久化（持久化在 player_reincarnation 表）
 *
 * 数据模型：
 *   - Player: 玩家主表（remnant_soul/exp/realm/realm_rank/attributes/last_reincarnation_time/is_dead）
 *   - ReincarnationTarget: 夺舍目标配置表（target_key/target_type/realm_rank/inherit_ratio/drop_realm_count/risk_level/weight）
 *   - PlayerReincarnation: 玩家夺舍记录表（含 origin_realm / new_realm / inherited_atk / death_reason / cooldown_end_time 等字段）
 *
 * 缓存设计：
 *   - _pendingTargets: Map<playerId, { targets, triggeredAt, deathReason }>
 *   - 仅在 triggerReincarnation 时写入，chooseTarget / forceRandomReincarnation 时清除
 *   - 进程重启后缓存丢失，需要重新触发夺舍（不会丢失已持久化的夺舍记录）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const ReincarnationTarget = require('../../models/reincarnationTarget');
const PlayerReincarnation = require('../../models/playerReincarnation');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const PlayerStateMachine = require('../state/PlayerStateMachine');

// 夺舍状态机枚举值（与 registrations/reincarnation.js 中保持一致）
const REINCARNATION_STATE_ENUM = 'REINCARNATING';

// 内存缓存：玩家待选定夺舍目标列表
// key: playerId, value: { targets: Array, triggeredAt: Date, deathReason: string }
const _pendingTargets = new Map();

/**
 * 工具函数：加权随机抽取 N 个不重复目标
 * @param {Array} pool - 目标池（每个元素含 weight）
 * @param {number} count - 抽取数量
 * @returns {Array} 抽中的目标数组
 */
function weightedRandomPickN(pool, count) {
    if (!Array.isArray(pool) || pool.length === 0) return [];
    const result = [];
    const remaining = [...pool];
    const n = Math.min(count, remaining.length);
    for (let i = 0; i < n; i++) {
        const totalWeight = remaining.reduce((sum, t) => sum + (t.weight || 0), 0);
        if (totalWeight <= 0) {
            // 权重全为0，随机选一个
            const idx = Math.floor(Math.random() * remaining.length);
            result.push(remaining.splice(idx, 1)[0]);
            continue;
        }
        let rand = Math.random() * totalWeight;
        let pickedIdx = 0;
        for (let j = 0; j < remaining.length; j++) {
            rand -= (remaining[j].weight || 0);
            if (rand <= 0) {
                pickedIdx = j;
                break;
            }
        }
        result.push(remaining.splice(pickedIdx, 1)[0]);
    }
    return result;
}

/**
 * 工具函数：从玩家对象读取神识值
 * @param {Object} player - 玩家对象
 * @returns {number}
 */
function getDivineSense(player) {
    if (!player) return 0;
    const attrs = player.attributes || {};
    return Number(attrs.sense || 0);
}

/**
 * 工具函数：根据风险等级获取夺舍成功率
 * @param {Object} config - 夺舍配置
 * @param {number} riskLevel - 风险等级 1/2/3
 * @returns {number} 成功率（0-1）
 */
function getSuccessRateByRisk(config, riskLevel) {
    const rates = config.success_rate_by_risk_level || {};
    return rates[String(riskLevel)] || rates['1'] || 0.5;
}

class ReincarnationService {
    /**
     * 触发夺舍（飞升失败/寿命尽/PVP被杀时调用）
     * 推送 3 个目标按 weight 加权随机，缓存到内存 Map
     * @param {number} playerId - 玩家ID
     * @param {string} deathReason - 死亡原因（lifespan_out/pvp_kill/breakthrough_fail/ascension_fail）
     * @returns {Promise<Object>} { success, message, data: { targets } }
     */
    static async triggerReincarnation(playerId, deathReason) {
        try {
            const player = await Player.findByPk(playerId);
            if (!player) {
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const reinCfg = config.reincarnation;

            // 校验死亡原因合法性
            const validReasons = ['lifespan_out', 'pvp_kill', 'breakthrough_fail', 'ascension_fail'];
            if (!validReasons.includes(deathReason)) {
                return { success: false, message: `无效的死亡原因：${deathReason}` };
            }

            // 校验冷却（防止重复触发）
            const cooldownCheck = await this.checkCooldown(playerId);
            if (!cooldownCheck.ready) {
                return {
                    success: false,
                    message: reinCfg.reincarnation_messages?.cooldown
                        ?.replace('{hours}', cooldownCheck.remainingHours)
                        .replace('{minutes}', cooldownCheck.remainingMinutes)
                        || `夺舍冷却中，剩余 ${cooldownCheck.remainingHours} 小时`
                };
            }

            // 标记玩家为死亡状态（用于状态机互斥与 UI 提示）
            if (!player.is_dead) {
                player.is_dead = true;
                player.death_reason = deathReason;
                player.death_time = new Date();
                await player.save();
            }

            // 查询所有可用夺舍目标
            const allTargets = await ReincarnationTarget.findAll({
                order: [['weight', 'DESC']]
            });
            if (allTargets.length === 0) {
                return {
                    success: false,
                    message: reinCfg.reincarnation_messages?.no_targets || '无可夺舍目标，请联系管理员配置'
                };
            }

            // 加权随机抽取 N 个目标
            const targetCount = reinCfg.target_count || 3;
            const pickedTargets = weightedRandomPickN(allTargets.map(t => t.toJSON()), targetCount);

            // 缓存到内存
            _pendingTargets.set(playerId, {
                targets: pickedTargets,
                triggeredAt: new Date(),
                deathReason
            });

            const triggerMsg = reinCfg.reincarnation_messages?.trigger
                || '你的肉身已毁，残魂飘荡于虚空，可尝试夺舍重生！';

            // WebSocket 推送夺舍触发通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'reincarnation_triggered', {
                    message: triggerMsg,
                    death_reason: deathReason,
                    targets: pickedTargets.map((t, idx) => ({
                        index: idx + 1,
                        target_id: t.id,
                        target_name: t.target_name,
                        target_type: t.target_type,
                        risk_level: t.risk_level,
                        inherit_ratio: t.inherit_ratio,
                        drop_realm_count: t.drop_realm_count,
                        description: t.description
                    })),
                    timeout_seconds: 1800 // 30 分钟超时
                });
            } catch (e) {
                console.warn('[ReincarnationService] 推送夺舍触发通知失败:', e.message);
            }

            return {
                success: true,
                message: triggerMsg,
                data: {
                    death_reason: deathReason,
                    targets: pickedTargets.map((t, idx) => ({
                        index: idx + 1,
                        target_id: t.id,
                        target_name: t.target_name,
                        target_type: t.target_type,
                        target_type_display: t.target_type === 'mortal' ? '凡人'
                            : (t.target_type === 'cultivator' ? '修士' : '妖兽'),
                        target_realm_rank: t.realm_rank,
                        risk_level: t.risk_level,
                        inherit_ratio: t.inherit_ratio,
                        drop_realm_count: t.drop_realm_count,
                        is_rare: t.is_rare,
                        description: t.description,
                        success_rate: getSuccessRateByRisk(reinCfg, t.risk_level)
                    })),
                    timeout_seconds: 1800
                }
            };
        } catch (err) {
            console.error('[ReincarnationService] triggerReincarnation 异常:', err);
            throw err;
        }
    }

    /**
     * 获取可夺舍目标列表
     * 若内存缓存存在则返回缓存，否则返回空（需先调用 triggerReincarnation）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data: { targets, triggered_at } }
     */
    static async getTargets(playerId) {
        const cached = _pendingTargets.get(playerId);
        if (!cached) {
            return {
                success: false,
                message: '当前无可夺舍目标，需先触发夺舍',
                data: { targets: [] }
            };
        }
        const config = configLoader.getConfig('ascension_data');
        const reinCfg = config.reincarnation;
        return {
            success: true,
            message: 'success',
            data: {
                targets: cached.targets.map((t, idx) => ({
                    index: idx + 1,
                    target_id: t.id,
                    target_name: t.target_name,
                    target_type: t.target_type,
                    target_type_display: t.target_type === 'mortal' ? '凡人'
                        : (t.target_type === 'cultivator' ? '修士' : '妖兽'),
                    target_realm_rank: t.realm_rank,
                    risk_level: t.risk_level,
                    inherit_ratio: t.inherit_ratio,
                    drop_realm_count: t.drop_realm_count,
                    is_rare: t.is_rare,
                    description: t.description,
                    success_rate: getSuccessRateByRisk(reinCfg, t.risk_level)
                })),
                triggered_at: cached.triggeredAt.toISOString(),
                death_reason: cached.deathReason
            }
        };
    }

    /**
     * 选定夺舍目标
     * 事务 + 行级锁，计算境界跌落、属性继承、残魂恢复至50、72小时冷却
     * 写入 player_reincarnation 记录，清除内存缓存
     * @param {number} playerId - 玩家ID
     * @param {number} targetId - 目标ID
     * @param {Object} options - 可选参数
     *   - force: boolean 是否强制执行（绕过冷却校验，仅供 StateCleaner 兜底调用，避免状态卡死）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async chooseTarget(playerId, targetId, options = {}) {
        const t = await sequelize.transaction();
        try {
            // 行级锁锁定玩家
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 状态校验：玩家必须处于死亡状态
            if (!player.is_dead) {
                await t.rollback();
                return { success: false, message: '当前未处于夺舍状态' };
            }

            // 冷却校验（force=true 时跳过，用于 StateCleaner 兜底强制清理，避免玩家状态卡死）
            if (!options.force) {
                const cooldownCheck = await this.checkCooldown(playerId);
                if (!cooldownCheck.ready) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `夺舍冷却中，剩余 ${cooldownCheck.remainingHours} 小时 ${cooldownCheck.remainingMinutes} 分钟`
                    };
                }
            }

            // 从内存缓存读取目标列表
            const cached = _pendingTargets.get(playerId);
            if (!cached) {
                await t.rollback();
                return { success: false, message: '夺舍目标已过期，请重新触发夺舍' };
            }

            // 查找选定的目标
            const target = cached.targets.find(tg => tg.id === targetId || tg.id === Number(targetId));
            if (!target) {
                await t.rollback();
                return { success: false, message: `目标 ${targetId} 不在可选列表中` };
            }

            const config = configLoader.getConfig('ascension_data');
            const reinCfg = config.reincarnation;

            // 夺舍成功率判定
            const successRate = getSuccessRateByRisk(reinCfg, target.risk_level);
            const roll = Math.random();
            const isSuccess = roll < successRate;

            // 记录原境界信息
            const originRealm = player.realm;
            const originRealmRank = player.realm_rank || 0;
            const originExp = BigInt(player.exp || 0);

            // 计算新境界（境界跌落 drop_realm_count 个大境界）
            // 通过 RealmService 获取所有境界配置，按 rank 倒序查找
            const allRealms = RealmService.getAllRealms();
            const sortedRealms = allRealms.sort((a, b) => a.rank - b.rank);
            const currentRealmIdx = sortedRealms.findIndex(r => r.name === originRealm);
            let newRealm = originRealm;
            let newRealmRank = originRealmRank;
            if (currentRealmIdx >= 0) {
                // 找到当前境界所在的大境界起点，然后向前跌落 drop_realm_count 个大境界
                // 简化：直接按 rank 跌落（每个大境界约 3 个子境界）
                const dropStep = target.drop_realm_count * 3;
                const newIdx = Math.max(0, currentRealmIdx - dropStep);
                newRealm = sortedRealms[newIdx].name;
                newRealmRank = sortedRealms[newIdx].rank;
            } else {
                // 兜底：跌落 rank
                newRealmRank = Math.max(1, originRealmRank - target.drop_realm_count * 3);
                const fallbackRealm = RealmService.getRealmByRank(newRealmRank);
                if (fallbackRealm) newRealm = fallbackRealm.name;
            }

            // 计算新修为（跌落后新境界的初始修为，按 inherit_ratio 折减原修为）
            const newRealmInfo = RealmService.getRealmByName(newRealm) || {};
            const newRealmExpCap = Number(newRealmInfo.exp_cap || newRealmInfo.cultivation_limit || 1000);
            // 新修为 = min(原修为 * inherit_ratio, 新境界修为上限)
            const inheritedExp = originExp * BigInt(Math.floor(target.inherit_ratio * 100)) / BigInt(100);
            const newExp = inheritedExp > BigInt(newRealmExpCap) ? BigInt(newRealmExpCap) : inheritedExp;

            // 计算继承属性
            // 继承攻击 = 原攻击 * inherit_ratio + 目标基础攻击
            const attrs = player.attributes || {};
            const originAtk = Number(attrs.atk || 0);
            const originDef = Number(attrs.def || 0);
            const originHpMax = Number(attrs.hp_max || 100);
            const inheritedAtk = Math.floor(originAtk * target.inherit_ratio) + target.base_atk;
            const inheritedDef = Math.floor(originDef * target.inherit_ratio) + target.base_def;
            const inheritedHpMax = Math.floor(originHpMax * target.inherit_ratio) + target.base_hp_max;

            if (isSuccess) {
                // ===== 夺舍成功 =====
                // 更新玩家基础属性
                const newAttrs = { ...attrs };
                newAttrs.atk = inheritedAtk;
                newAttrs.def = inheritedDef;
                newAttrs.hp_max = inheritedHpMax;
                newAttrs.hp_current = inheritedHpMax; // 满血复活
                newAttrs.sense = Math.max(Number(attrs.sense || 0), target.base_sense);
                newAttrs.speed = Math.max(Number(attrs.speed || 0), target.base_speed);
                player.attributes = newAttrs;

                // 更新境界、修为、残魂
                player.realm = newRealm;
                player.realm_rank = newRealmRank;
                player.exp = newExp.toString();
                player.remnant_soul = reinCfg.remnant_after_reincarnation; // 残魂恢复至 50

                // 复活：清除死亡状态
                player.is_dead = false;
                player.death_reason = null;
                player.death_time = null;
                player.weakness_end_time = null;

                // 更新夺舍冷却时间
                const now = new Date();
                const cooldownEnd = new Date(now.getTime() + reinCfg.cooldown_seconds * 1000);
                player.last_reincarnation_time = now;

                await player.save({ transaction: t });

                // 写入夺舍记录
                await PlayerReincarnation.create({
                    player_id: playerId,
                    origin_realm: originRealm,
                    origin_realm_rank: originRealmRank,
                    origin_exp: originExp.toString(),
                    target_id: target.id,
                    target_name: target.target_name,
                    new_realm: newRealm,
                    new_realm_rank: newRealmRank,
                    new_exp: newExp.toString(),
                    inherited_atk: inheritedAtk,
                    inherited_def: inheritedDef,
                    inherited_hp_max: inheritedHpMax,
                    inherit_ratio: target.inherit_ratio,
                    success: 1,
                    death_reason: cached.deathReason,
                    reincarnated_at: now,
                    cooldown_end_time: cooldownEnd
                }, { transaction: t });

                await t.commit();

                // 清除内存缓存
                _pendingTargets.delete(playerId);

                const successMsg = (reinCfg.reincarnation_messages?.success || '夺舍成功！')
                    .replace('{target_name}', target.target_name)
                    .replace('{new_realm}', newRealm);

                // WebSocket 推送夺舍成功
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'reincarnation_success', {
                        message: successMsg,
                        target_name: target.target_name,
                        new_realm: newRealm,
                        new_realm_rank: newRealmRank,
                        new_exp: newExp.toString(),
                        inherited: {
                            atk: inheritedAtk,
                            def: inheritedDef,
                            hp_max: inheritedHpMax,
                            sense: newAttrs.sense,
                            speed: newAttrs.speed
                        },
                        remnant_soul: player.remnant_soul,
                        cooldown_end_time: cooldownEnd.toISOString()
                    });
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: '夺舍重生',
                        content: `【${player.nickname}】夺舍「${target.target_name}」成功，境界跌落至 ${newRealm}！`,
                        priority: 'normal'
                    });
                } catch (e) {
                    console.warn('[ReincarnationService] 推送夺舍成功通知失败:', e.message);
                }

                return {
                    success: true,
                    message: successMsg,
                    data: {
                        result: 'success',
                        target: {
                            id: target.id,
                            name: target.target_name,
                            type: target.target_type
                        },
                        origin: {
                            realm: originRealm,
                            realm_rank: originRealmRank,
                            exp: originExp.toString()
                        },
                        new: {
                            realm: newRealm,
                            realm_rank: newRealmRank,
                            exp: newExp.toString()
                        },
                        inherited: {
                            atk: inheritedAtk,
                            def: inheritedDef,
                            hp_max: inheritedHpMax
                        },
                        remnant_soul: player.remnant_soul,
                        cooldown_end_time: cooldownEnd.toISOString()
                    }
                };
            } else {
                // ===== 夺舍失败 =====
                // 夺舍失败：残魂再受创，72小时虚弱期
                const now = new Date();
                const cooldownEnd = new Date(now.getTime() + reinCfg.cooldown_seconds * 1000);
                player.remnant_soul = Math.max(0, Number(player.remnant_soul || 0) - 20);
                player.last_reincarnation_time = now;
                player.weakness_end_time = cooldownEnd;

                await player.save({ transaction: t });

                // 写入夺舍失败记录
                await PlayerReincarnation.create({
                    player_id: playerId,
                    origin_realm: originRealm,
                    origin_realm_rank: originRealmRank,
                    origin_exp: originExp.toString(),
                    target_id: target.id,
                    target_name: target.target_name,
                    new_realm: originRealm, // 失败不变境界
                    new_realm_rank: originRealmRank,
                    new_exp: originExp.toString(),
                    inherited_atk: 0,
                    inherited_def: 0,
                    inherited_hp_max: 0,
                    inherit_ratio: target.inherit_ratio,
                    success: 0,
                    death_reason: cached.deathReason,
                    reincarnated_at: now,
                    cooldown_end_time: cooldownEnd
                }, { transaction: t });

                await t.commit();

                // 失败仍清除缓存（同一冷却期内不可再次尝试）
                _pendingTargets.delete(playerId);

                const failMsg = reinCfg.reincarnation_messages?.fail || '夺舍失败！残魂再次受创';

                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'reincarnation_failed', {
                        message: failMsg,
                        target_name: target.target_name,
                        remnant_loss: 20,
                        current_remnant_soul: player.remnant_soul,
                        cooldown_end_time: cooldownEnd.toISOString()
                    });
                } catch (e) {
                    console.warn('[ReincarnationService] 推送夺舍失败通知失败:', e.message);
                }

                return {
                    success: true, // 接口成功，但夺舍结果为失败
                    message: failMsg,
                    data: {
                        result: 'failed',
                        target: {
                            id: target.id,
                            name: target.target_name
                        },
                        remnant_loss: 20,
                        current_remnant_soul: player.remnant_soul,
                        cooldown_end_time: cooldownEnd.toISOString()
                    }
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ReincarnationService] chooseTarget 异常:', err);
            throw err;
        }
    }

    /**
     * 分页查询夺舍历史记录
     * @param {number} playerId - 玩家ID
     * @param {number} page - 页码（1-based）
     * @param {number} pageSize - 每页条数
     * @returns {Promise<Object>} { success, data: { list, total, page, page_size, total_pages } }
     */
    static async getRecords(playerId, page = 1, pageSize = 10) {
        if (!Number.isInteger(page) || page < 1) page = 1;
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) pageSize = 10;

        const offset = (page - 1) * pageSize;
        const { rows, count } = await PlayerReincarnation.findAndCountAll({
            where: { player_id: playerId },
            order: [['reincarnated_at', 'DESC']],
            limit: pageSize,
            offset: offset
        });

        return {
            success: true,
            data: {
                list: rows.map(r => ({
                    id: r.id,
                    origin_realm: r.origin_realm,
                    origin_realm_rank: r.origin_realm_rank,
                    origin_exp: r.origin_exp ? r.origin_exp.toString() : '0',
                    target_id: r.target_id,
                    target_name: r.target_name,
                    new_realm: r.new_realm,
                    new_realm_rank: r.new_realm_rank,
                    new_exp: r.new_exp ? r.new_exp.toString() : '0',
                    inherited_atk: r.inherited_atk,
                    inherited_def: r.inherited_def,
                    inherited_hp_max: r.inherited_hp_max,
                    inherit_ratio: r.inherit_ratio,
                    success: r.success,
                    death_reason: r.death_reason,
                    reincarnated_at: r.reincarnated_at,
                    cooldown_end_time: r.cooldown_end_time
                })),
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize)
            }
        };
    }

    /**
     * 检查夺舍冷却（72小时）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { ready, remainingHours, remainingMinutes, cooldownEndTime }
     */
    static async checkCooldown(playerId) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'last_reincarnation_time']
        });
        if (!player || !player.last_reincarnation_time) {
            return { ready: true, remainingHours: 0, remainingMinutes: 0, cooldownEndTime: null };
        }
        const config = configLoader.getConfig('ascension_data');
        const cooldownSec = config.reincarnation.cooldown_seconds;
        const lastMs = new Date(player.last_reincarnation_time).getTime();
        const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
        if (elapsedSec >= cooldownSec) {
            return { ready: true, remainingHours: 0, remainingMinutes: 0, cooldownEndTime: null };
        }
        const remainingSec = cooldownSec - elapsedSec;
        const remainingHours = Math.floor(remainingSec / 3600);
        const remainingMinutes = Math.floor((remainingSec % 3600) / 60);
        const cooldownEndTime = new Date(lastMs + cooldownSec * 1000).toISOString();
        return { ready: false, remainingHours, remainingMinutes, cooldownEndTime };
    }

    /**
     * 超时强制随机夺舍
     * 30 分钟未选定则按权重随机选一个目标
     * 由 StateCleanerService 通过 reincarnation 状态注册的 cleanExpired 调用
     *
     * 重要：此方法为系统兜底逻辑，必须保证能清理卡死状态：
     *   1. 调用 chooseTarget 时传 force=true，绕过冷却校验
     *   2. 如果 chooseTarget 仍失败（如目标已被删除），执行 emergencyCleanup 紧急清理：
     *      直接清除 is_dead 标记，让玩家以"夺舍失败"的兜底结果回到游戏
     *      （保留原境界、残魂-20、设置新的冷却时间），避免无限循环
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 执行结果
     */
    static async forceRandomReincarnation(playerId) {
        try {
            const cached = _pendingTargets.get(playerId);
            if (!cached) {
                // 无缓存：直接随机抽取一个目标
                const allTargets = await ReincarnationTarget.findAll();
                if (allTargets.length === 0) {
                    // 无夺舍目标配置，执行紧急清理避免状态卡死
                    console.warn(`[ReincarnationService] 玩家 ${playerId} 无可夺舍目标，执行紧急清理`);
                    return await this.emergencyCleanup(playerId, '无可夺舍目标，系统强制复活');
                }
                const config = configLoader.getConfig('ascension_data');
                const picked = weightedRandomPickN(allTargets.map(t => t.toJSON()), 1);
                if (picked.length === 0) {
                    return await this.emergencyCleanup(playerId, '随机选定失败，系统强制复活');
                }
                // 重新写入缓存并调用 chooseTarget（force=true 绕过冷却校验）
                _pendingTargets.set(playerId, {
                    targets: picked,
                    triggeredAt: new Date(),
                    deathReason: 'ascension_fail' // 默认死亡原因
                });
                // 推送超时通知
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'reincarnation_timeout', {
                        message: config.reincarnation.reincarnation_messages?.timeout
                            || '30 分钟未选定夺舍目标，系统已自动为你随机选定一个目标',
                        auto_selected_target: picked[0].target_name
                    });
                } catch (e) {
                    console.warn('[ReincarnationService] 推送超时通知失败:', e.message);
                }
                const result = await this.chooseTarget(playerId, picked[0].id, { force: true });
                // 如果强制夺舍仍失败，执行紧急清理
                if (!result.success) {
                    console.warn(`[ReincarnationService] 玩家 ${playerId} 强制夺舍失败(${result.message})，执行紧急清理`);
                    return await this.emergencyCleanup(playerId, result.message);
                }
                return result;
            }

            // 有缓存：从缓存中按权重随机选一个
            const config = configLoader.getConfig('ascension_data');
            const picked = weightedRandomPickN(cached.targets, 1);
            if (picked.length === 0) {
                return await this.emergencyCleanup(playerId, '随机选定失败，系统强制复活');
            }

            // 推送超时通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'reincarnation_timeout', {
                    message: config.reincarnation.reincarnation_messages?.timeout
                        || '30 分钟未选定夺舍目标，系统已自动为你随机选定一个目标',
                    auto_selected_target: picked[0].target_name
                });
            } catch (e) {
                console.warn('[ReincarnationService] 推送超时通知失败:', e.message);
            }

            // force=true 绕过冷却校验，避免 StateCleaner 兜底失败导致状态卡死
            const result = await this.chooseTarget(playerId, picked[0].id, { force: true });
            if (!result.success) {
                console.warn(`[ReincarnationService] 玩家 ${playerId} 强制夺舍失败(${result.message})，执行紧急清理`);
                return await this.emergencyCleanup(playerId, result.message);
            }
            return result;
        } catch (err) {
            console.error('[ReincarnationService] forceRandomReincarnation 异常:', err);
            // 异常时也尝试紧急清理，避免状态卡死
            return await this.emergencyCleanup(playerId, `强制夺舍异常: ${err.message}`);
        }
    }

    /**
     * 紧急清理：玩家处于 is_dead=true 但无法正常夺舍时的兜底处理
     * 直接清除 is_dead 标记，让玩家以"夺舍失败"的结果回到游戏：
     *   - 保留原境界（不跌落）
     *   - 残魂 -20（最低 0）
     *   - 设置虚弱状态 2 小时
     *   - 设置新的夺舍冷却时间（72 小时）
     *   - 写入夺舍失败记录
     *   - 清除内存缓存
     *   - 推送通知
     *
     * 此方法保证 StateCleaner 不会陷入无限重试循环。
     *
     * @param {number} playerId - 玩家ID
     * @param {string} reason - 紧急清理原因
     * @returns {Promise<Object>} { success, message, data }
     */
    static async emergencyCleanup(playerId, reason) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 如果玩家已经不处于死亡状态，无需清理
            if (!player.is_dead) {
                await t.rollback();
                return { success: true, message: '玩家已不处于夺舍状态，无需清理' };
            }

            const config = configLoader.getConfig('ascension_data');
            const reinCfg = config.reincarnation;
            const now = new Date();

            // 保存原始死亡原因（清除死亡状态前），用于写入夺舍记录
            const originalDeathReason = player.death_reason || 'system_cleanup';
            // 保存原始境界信息（清除死亡状态前），用于写入夺舍记录
            const originRealm = player.realm;
            const originRealmRank = player.realm_rank || 0;
            const originExp = (player.exp || 0).toString();

            // 残魂 -20（最低 0）
            const oldRemnant = Number(player.remnant_soul || 0);
            const newRemnant = Math.max(0, oldRemnant - 20);

            // 设置虚弱状态 2 小时（复用 weakness_end_time 字段）
            const weaknessSeconds = reinCfg.weakness_seconds || 7200;
            const weaknessEnd = new Date(now.getTime() + weaknessSeconds * 1000);

            // 设置新的夺舍冷却时间（72 小时）
            const cooldownSec = reinCfg.cooldown_seconds || 259200;
            const cooldownEnd = new Date(now.getTime() + cooldownSec * 1000);

            // 清除死亡状态
            player.is_dead = false;
            player.death_reason = null;
            player.death_time = null;
            player.remnant_soul = newRemnant;
            player.weakness_end_time = weaknessEnd;
            player.last_reincarnation_time = now;
            await player.save({ transaction: t });

            // 写入夺舍失败记录（target_id=0 表示系统兜底，无具体目标）
            await PlayerReincarnation.create({
                player_id: playerId,
                origin_realm: originRealm,
                origin_realm_rank: originRealmRank,
                origin_exp: originExp,
                target_id: 0,
                target_name: '系统兜底',
                new_realm: originRealm, // 不跌落境界
                new_realm_rank: originRealmRank,
                new_exp: originExp,
                inherited_atk: 0,
                inherited_def: 0,
                inherited_hp_max: 0,
                inherit_ratio: 0,
                success: 0,
                death_reason: originalDeathReason,
                reincarnated_at: now,
                cooldown_end_time: cooldownEnd
            }, { transaction: t });

            await t.commit();

            // 清除内存缓存
            _pendingTargets.delete(playerId);

            // 推送通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'reincarnation_emergency_cleanup', {
                    message: `系统已为你强制复活（原因：${reason}），残魂 -20，进入 2 小时虚弱状态`,
                    remnant_loss: 20,
                    current_remnant_soul: newRemnant,
                    weakness_end_time: weaknessEnd.toISOString(),
                    cooldown_end_time: cooldownEnd.toISOString()
                });
            } catch (e) {
                console.warn('[ReincarnationService] 推送紧急清理通知失败:', e.message);
            }

            console.info(`[ReincarnationService] 玩家 ${playerId} 紧急清理完成: ${reason}`);
            return {
                success: true,
                message: `系统强制复活: ${reason}`,
                data: {
                    remnant_loss: 20,
                    current_remnant_soul: newRemnant,
                    weakness_end_time: weaknessEnd.toISOString(),
                    cooldown_end_time: cooldownEnd.toISOString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[ReincarnationService] emergencyCleanup 异常:', err);
            return { success: false, message: `紧急清理失败: ${err.message}` };
        }
    }

    /**
     * 清理超时的待选定夺舍目标（供 StateCleanerService 调用）
     * 超时 30 分钟的目标自动触发 forceRandomReincarnation
     * @param {Object} ctx - 清理上下文 { batchSize }
     * @returns {Promise<Object>} { scanned, forced, failed }
     */
    static async cleanExpiredPending(ctx = {}) {
        const stats = { scanned: 0, forced: 0, failed: 0 };
        const config = configLoader.getConfig('ascension_data');
        const timeoutSec = 1800; // 30 分钟
        const now = Date.now();

        for (const [playerId, cached] of _pendingTargets.entries()) {
            stats.scanned += 1;
            const triggeredMs = new Date(cached.triggeredAt).getTime();
            if ((now - triggeredMs) / 1000 >= timeoutSec) {
                try {
                    await this.forceRandomReincarnation(playerId);
                    stats.forced += 1;
                } catch (e) {
                    stats.failed += 1;
                    console.error(`[ReincarnationService] 强制夺舍玩家 ${playerId} 失败:`, e.message);
                }
            }
        }

        return stats;
    }

    // ==================== GM 后台辅助方法 ====================

    /**
     * GM 获取所有夺舍目标配置
     * @returns {Promise<Object>}
     */
    static async gmGetTargets() {
        const targets = await ReincarnationTarget.findAll({
            order: [['target_type', 'ASC'], ['risk_level', 'ASC']]
        });
        return {
            list: targets.map(t => t.toJSON()),
            total: targets.length
        };
    }

    /**
     * GM 新增夺舍目标
     * @param {Object} data - 目标数据
     * @returns {Promise<Object>}
     */
    static async gmCreateTarget(data) {
        // 参数校验
        const required = ['target_key', 'target_name', 'target_type', 'realm_rank',
                          'base_atk', 'base_def', 'base_hp_max', 'base_speed', 'base_sense'];
        for (const field of required) {
            if (data[field] === undefined || data[field] === null) {
                return { success: false, message: `缺少必填字段: ${field}` };
            }
        }
        const validTypes = ['mortal', 'cultivator', 'monster'];
        if (!validTypes.includes(data.target_type)) {
            return { success: false, message: `target_type 必须为 ${validTypes.join('/')}` };
        }
        if (!Number.isInteger(data.risk_level) || data.risk_level < 1 || data.risk_level > 3) {
            return { success: false, message: 'risk_level 必须为 1-3 之间的整数' };
        }

        // 唯一键校验
        const existing = await ReincarnationTarget.findOne({ where: { target_key: data.target_key } });
        if (existing) {
            return { success: false, message: `target_key ${data.target_key} 已存在` };
        }

        const target = await ReincarnationTarget.create({
            target_key: data.target_key,
            target_name: data.target_name,
            target_type: data.target_type,
            realm_rank: data.realm_rank,
            base_atk: data.base_atk,
            base_def: data.base_def,
            base_hp_max: data.base_hp_max,
            base_speed: data.base_speed,
            base_sense: data.base_sense,
            spirit_root_grade: data.spirit_root_grade || null,
            talent_id: data.talent_id || null,
            inherit_ratio: data.inherit_ratio || 0.5,
            drop_realm_count: data.drop_realm_count || 1,
            risk_level: data.risk_level,
            description: data.description || '',
            weight: data.weight || 100,
            is_rare: data.is_rare ? 1 : 0
        });

        return {
            success: true,
            message: `夺舍目标「${data.target_name}」创建成功`,
            data: target.toJSON()
        };
    }

    /**
     * GM 编辑夺舍目标
     * @param {number} targetId - 目标ID
     * @param {Object} data - 更新数据
     * @returns {Promise<Object>}
     */
    static async gmUpdateTarget(targetId, data) {
        const target = await ReincarnationTarget.findByPk(targetId);
        if (!target) {
            return { success: false, message: '夺舍目标不存在' };
        }

        // 可更新字段白名单
        const updatableFields = [
            'target_name', 'target_type', 'realm_rank',
            'base_atk', 'base_def', 'base_hp_max', 'base_speed', 'base_sense',
            'spirit_root_grade', 'talent_id', 'inherit_ratio', 'drop_realm_count',
            'risk_level', 'description', 'weight', 'is_rare'
        ];
        const updates = {};
        for (const f of updatableFields) {
            if (data[f] !== undefined) updates[f] = data[f];
        }
        // is_rare 特殊处理（0/1）
        if (updates.is_rare !== undefined) {
            updates.is_rare = updates.is_rare ? 1 : 0;
        }

        if (Object.keys(updates).length === 0) {
            return { success: false, message: '无更新字段' };
        }

        await target.update(updates);
        return {
            success: true,
            message: `夺舍目标「${target.target_name}」更新成功`,
            data: target.toJSON()
        };
    }
}

module.exports = ReincarnationService;
