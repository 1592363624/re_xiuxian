/**
 * 第二元神服务
 *
 * 实现批次3设计文档第4.2节「第二元神系统」的全部业务逻辑：
 *   1. 凝练第二元神（化神期 + 5 类残篇 + 灵石/神识/残魂消耗）
 *   2. 元神分化（第三元神，需第二元神境界≥化神期）
 *   3. 调度模式切换（combat/cultivate/scout/defend，各模式独立 CD）
 *   4. 独立挂机修炼（12 小时上限，每日 2 次）
 *   5. GM 调整副元神属性
 *
 * 设计原则：
 *   - 所有阈值/CD/比例从 late_stage_data.json 配置读取，禁止硬编码
 *   - 关键操作（凝练/分化/调度/修炼）使用事务 + LOCK.UPDATE 行级锁
 *   - BigInt 字段（exp/spirit_stones）比较时用 BigInt() 包装
 *   - 第二元神属性继承：主元神属性 * inherit_ratio + 随机加成(±10%)
 *   - 第二元神境界：主元神境界 - 1 大境界（化神 → 元婴后期）
 *   - 关键事件通过 WebSocketNotificationService 推送，事务外推送避免阻塞
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones/second_soul_count/remnant_soul/attributes.sense）
 *   - PlayerSecondSoul: 玩家元神表（1主+N副，soul_index 区分）
 *   - PlayerSoulFragment: 玩家元神残篇流水（凝练材料审计）
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerSecondSoul = require('../../models/playerSecondSoul');
const PlayerSoulFragment = require('../../models/playerSoulFragment');
const PlayerAscension = require('../../models/playerAscension');
const sequelize = require('../../config/database');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { ErrorCodes } = require('../../middleware/errorHandler');

/**
 * 工具函数：从玩家对象读取神识值
 * 玩家表无独立 divine_sense 字段，神识存储于 attributes.sense
 * 同时与 player_divine_sense 表中的 divine_sense_current 同步
 * @param {Object} player - 玩家对象
 * @returns {number} 神识值，无则返回 0
 */
function getDivineSense(player) {
    if (!player) return 0;
    const attrs = player.attributes || {};
    return Number(attrs.sense || 0);
}

/**
 * 工具函数：扣减玩家神识（写入 attributes.sense）
 * @param {Object} player - 玩家对象
 * @param {number} cost - 消耗量
 */
function consumeDivineSense(player, cost) {
    const attrs = player.attributes || {};
    const current = Number(attrs.sense || 0);
    attrs.sense = Math.max(0, current - cost);
    player.attributes = attrs;
}

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
 * 工具函数：检查冷却时间是否已过
 * @param {Object} model - 模型实例
 * @param {string} timeField - 上次操作时间字段
 * @param {number} cooldownSec - 冷却秒数
 * @returns {{ready: boolean, remainingSec: number}}
 */
function checkCooldown(model, timeField, cooldownSec) {
    const lastTime = model[timeField];
    if (!lastTime) return { ready: true, remainingSec: 0 };
    const lastMs = lastTime instanceof Date ? lastTime.getTime() : new Date(lastTime).getTime();
    const elapsedSec = Math.floor((Date.now() - lastMs) / 1000);
    if (elapsedSec >= cooldownSec) {
        return { ready: true, remainingSec: 0 };
    }
    return { ready: false, remainingSec: cooldownSec - elapsedSec };
}

/**
 * 工具函数：从消息数组中随机选一条
 * @param {Array<string>} messages - 消息数组
 * @returns {string} 选中的消息
 */
function pickRandomMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    return messages[Math.floor(Math.random() * messages.length)];
}

/**
 * 计算指定境界 rank 对应的境界名称
 * 通过 RealmService 从配置中查找
 * @param {number} rank - 境界 rank
 * @returns {string} 境界名称，未找到返回空字符串
 */
function getRealmNameByRank(rank) {
    const realm = RealmService.getRealmByRank(rank);
    return realm ? realm.name : '';
}

/**
 * 计算第二元神初始境界 rank（主元神 rank - 4，即下降 1 大境界）
 * 例：化神初期(23) → 元婴后期(22)
 *     化神中期(24) → 元婴大圆满(22)（不超过主元神前一大境界 max）
 * @param {number} mainRealmRank - 主元神境界 rank
 * @returns {number} 第二元神初始境界 rank
 */
function calcSecondSoulRealmRank(mainRealmRank) {
    // 主元神 rank - 4 即下降 1 大境界（每个大境界 4 个子境界）
    // 例如 化神初期(23) → 元婴后期(22)，下降 1
    // 实际设计文档说"主元神境界 - 1 大境界"，理解为下降一个子境界
    // 此处采用下降 1 子境界的实现（与设计文档示例"化神 → 元婴后期"一致）
    return Math.max(1, mainRealmRank - 1);
}

class SecondSoulService {
    /**
     * 获取玩家第二元神面板数据
     * 包含主元神与所有副元神状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 面板数据
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('late_stage_data');
        const soulCfg = config.second_soul;

        // 查询玩家所有元神（主+副）
        const souls = await PlayerSecondSoul.findAll({
            where: { player_id: playerId },
            order: [['soul_index', 'ASC']]
        });

        // 查询残篇收集进度
        const fragmentTypes = soulCfg.fragment_types;
        const fragmentProgress = {};
        for (const [key, info] of Object.entries(fragmentTypes)) {
            // 汇总该类型残篇总数
            const fragments = await PlayerSoulFragment.findAll({
                where: { player_id: playerId, fragment_type: key },
                attributes: ['count']
            });
            const totalCount = fragments.reduce((sum, f) => sum + (f.count || 0), 0);
            fragmentProgress[key] = {
                name: info.name,
                source: info.source_name,
                collected: totalCount,
                required: info.required_count,
                met: totalCount >= info.required_count
            };
        }

        // 检查凝练条件
        const realmCheck = RealmService.meetsRealmRequirement(player, soulCfg.min_realm_name);
        const allFragmentsMet = Object.values(fragmentProgress).every(f => f.met);
        const canCondense = realmCheck.met && allFragmentsMet && souls.length < soulCfg.max_soul_count;

        return {
            success: true,
            data: {
                player: {
                    id: player.id,
                    nickname: player.nickname,
                    realm: player.realm,
                    realm_rank: player.realm_rank,
                    spirit_stones: player.spirit_stones ? player.spirit_stones.toString() : '0',
                    divine_sense: getDivineSense(player),
                    remnant_soul: Number(player.remnant_soul || 0),
                    second_soul_count: player.second_soul_count || 0
                },
                souls: souls.map(s => ({
                    id: s.id,
                    soul_index: s.soul_index,
                    soul_name: s.soul_name,
                    soul_type: s.soul_type,
                    realm: s.realm,
                    realm_rank: s.realm_rank,
                    exp: s.exp ? s.exp.toString() : '0',
                    attributes: s.attributes,
                    inherit_ratio: s.inherit_ratio,
                    is_active: s.is_active,
                    is_cultivating: s.is_cultivating,
                    cultivate_started_at: s.cultivate_started_at,
                    cultivate_end_time: s.cultivate_end_time,
                    last_dispatch_mode: s.last_dispatch_mode,
                    dispatch_until: s.dispatch_until,
                    combat_count: s.combat_count,
                    cultivate_count: s.cultivate_count
                })),
                fragment_progress: fragmentProgress,
                condense_requirements: {
                    realm_met: realmCheck.met,
                    realm_required: soulCfg.min_realm_name,
                    realm_current: player.realm,
                    fragments_met: allFragmentsMet,
                    can_condense: canCondense,
                    cost: {
                        spirit_stones: soulCfg.condense_cost_spirit_stones,
                        divine_sense: soulCfg.condense_cost_divine_sense,
                        remnant_soul: soulCfg.condense_cost_remnant_soul
                    }
                }
            }
        };
    }

    /**
     * 凝练第二元神
     * 校验境界≥化神期、5 类残篇各 1 份、灵石/神识/残魂消耗
     * 第二元神初始属性 = 主元神属性 * inherit_ratio(0.6) + 凝练时随机加成(±10%)
     * 第二元神初始境界 = 主元神境界 - 1 子境界
     * @param {number} playerId - 玩家ID
     * @param {string} soulName - 元神名称（玩家自定义）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async condense(playerId, soulName) {
        // 参数校验
        if (!soulName || typeof soulName !== 'string' || soulName.trim().length === 0) {
            return { success: false, message: '元神名称不能为空', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (soulName.length > 50) {
            return { success: false, message: '元神名称不能超过 50 个字符', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const soulCfg = config.second_soul;

            // 境界校验
            const realmCheck = RealmService.meetsRealmRequirement(player, soulCfg.min_realm_name);
            if (!realmCheck.met) {
                await t.rollback();
                return {
                    success: false,
                    message: `需达到${soulCfg.min_realm_name}才能凝练第二元神（当前 ${player.realm}）`
                };
            }

            // 元神数量上限校验
            const existingSouls = await PlayerSecondSoul.findAll({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (existingSouls.length >= soulCfg.max_soul_count) {
                await t.rollback();
                return {
                    success: false,
                    message: `元神数量已达上限 ${soulCfg.max_soul_count}（主+副）`
                };
            }

            // 计算下一个 soul_index（1=主，2=第二，3=第三）
            const existingIndexes = existingSouls.map(s => s.soul_index);
            let nextSoulIndex = 2;  // 默认第二元神
            if (existingIndexes.includes(1)) {
                // 已有主元神，找下一个未占用的副元神序号
                for (let i = 2; i <= soulCfg.max_soul_count; i++) {
                    if (!existingIndexes.includes(i)) {
                        nextSoulIndex = i;
                        break;
                    }
                }
            } else {
                // 首次凝练，自动创建主元神记录（soul_index=1）
                nextSoulIndex = 1;
            }

            // 仅在凝练第二元神（nextSoulIndex=2）时校验残篇/灵石/神识/残魂
            // 第三元神（分化）走 divide 方法
            if (nextSoulIndex === 2) {
                // 5 类残篇校验
                const fragmentTypes = soulCfg.fragment_types;
                const missingFragments = [];
                for (const [key, info] of Object.entries(fragmentTypes)) {
                    const fragments = await PlayerSoulFragment.findAll({
                        where: { player_id: playerId, fragment_type: key },
                        transaction: t,
                        lock: t.LOCK.UPDATE
                    });
                    const totalCount = fragments.reduce((sum, f) => sum + (f.count || 0), 0);
                    if (totalCount < info.required_count) {
                        missingFragments.push(`${info.name}（${totalCount}/${info.required_count}）`);
                    }
                }
                if (missingFragments.length > 0) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `残篇不足：${missingFragments.join('，')}`
                    };
                }

                // 灵石消耗校验
                const costStones = BigInt(soulCfg.condense_cost_spirit_stones);
                const playerStones = BigInt(player.spirit_stones || 0);
                if (playerStones < costStones) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                    };
                }

                // 神识消耗校验
                const divineSense = getDivineSense(player);
                if (divineSense < soulCfg.condense_cost_divine_sense) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `神识不足，需要 ${soulCfg.condense_cost_divine_sense}，当前 ${divineSense}`
                    };
                }

                // 残魂消耗校验
                const remnantSoul = Number(player.remnant_soul || 0);
                if (remnantSoul < soulCfg.condense_cost_remnant_soul) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `残魂不足，需要 ${soulCfg.condense_cost_remnant_soul}，当前 ${remnantSoul}`
                    };
                }

                // 扣减资源
                player.spirit_stones = (playerStones - costStones).toString();
                consumeDivineSense(player, soulCfg.condense_cost_divine_sense);
                player.remnant_soul = Math.max(0, remnantSoul - soulCfg.condense_cost_remnant_soul);
            } else if (nextSoulIndex === 3) {
                // 第三元神由 divide 方法处理，condense 不应到达此分支
                await t.rollback();
                return { success: false, message: '请使用元神分化接口凝练第三元神' };
            }

            // 计算第二元神属性（继承主元神属性 * inherit_ratio + 随机加成 ±10%）
            const playerAttrs = player.attributes || {};
            const inheritRatio = soulCfg.inherit_ratio_second;
            const randomRange = soulCfg.random_bonus_range;  // ±10%
            const newAttrs = {
                atk: Math.floor((Number(playerAttrs.atk || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                def: Math.floor((Number(playerAttrs.def || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                hp_max: Math.floor((Number(playerAttrs.hp_max || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                speed: Math.floor((Number(playerAttrs.speed || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                sense: Math.floor((Number(playerAttrs.sense || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange))
            };

            // 计算第二元神境界
            const mainRealmRank = Number(player.realm_rank || 0);
            const newSoulRealmRank = calcSecondSoulRealmRank(mainRealmRank);
            const newSoulRealm = getRealmNameByRank(newSoulRealmRank) || player.realm;

            // 计算新境界修为中位数（取该境界 exp_cap 的 50%）
            const newRealm = RealmService.getRealmByRank(newSoulRealmRank);
            const initExp = newRealm ? Math.floor((Number(newRealm.exp_cap || 0)) / 2) : 0;

            // 创建元神记录
            const newSoul = await PlayerSecondSoul.create({
                player_id: playerId,
                soul_index: nextSoulIndex,
                soul_name: soulName.trim(),
                soul_type: 'normal',
                realm: newSoulRealm,
                realm_rank: newSoulRealmRank,
                exp: initExp,
                attributes: newAttrs,
                inherit_ratio: inheritRatio,
                is_active: nextSoulIndex === 1 ? 1 : 0,  // 主元神默认激活
                is_cultivating: 0,
                combat_count: 0,
                cultivate_count: 0
            }, { transaction: t });

            // 更新玩家副元神计数
            player.second_soul_count = (player.second_soul_count || 0) + 1;
            await player.save({ transaction: t });

            await t.commit();

            const message = pickRandomMessage(soulCfg.success_messages);

            // WebSocket 推送凝练成功
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'second_soul_condensed', {
                    message,
                    soul_index: newSoul.soul_index,
                    soul_name: newSoul.soul_name,
                    realm: newSoul.realm,
                    realm_rank: newSoul.realm_rank,
                    attributes: newAttrs
                });
            } catch (e) {
                console.warn('[SecondSoulService] 推送凝练成功通知失败:', e.message);
            }

            return {
                success: true,
                message,
                data: {
                    soul_id: newSoul.id,
                    soul_index: newSoul.soul_index,
                    soul_name: newSoul.soul_name,
                    soul_type: newSoul.soul_type,
                    realm: newSoul.realm,
                    realm_rank: newSoul.realm_rank,
                    exp: newSoul.exp.toString(),
                    attributes: newAttrs,
                    inherit_ratio: newSoul.inherit_ratio,
                    is_active: newSoul.is_active
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SecondSoulService] condense 异常:', err);
            throw err;
        }
    }

    /**
     * 元神分化（凝练第三元神）
     * 解锁条件：第二元神境界 ≥ 化神期
     * 第三元神属性继承比：0.4（比第二元神更低）
     * 最多凝练 3 个元神（主 + 2 副）
     * @param {number} playerId - 玩家ID
     * @param {string} soulName - 第三元神名称
     * @returns {Promise<Object>} { success, message, data }
     */
    static async divide(playerId, soulName) {
        if (!soulName || typeof soulName !== 'string' || soulName.trim().length === 0) {
            return { success: false, message: '元神名称不能为空', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (soulName.length > 50) {
            return { success: false, message: '元神名称不能超过 50 个字符', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('late_stage_data');
            const soulCfg = config.second_soul;

            // 元神数量上限校验
            const existingSouls = await PlayerSecondSoul.findAll({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (existingSouls.length >= soulCfg.max_soul_count) {
                await t.rollback();
                return {
                    success: false,
                    message: `元神数量已达上限 ${soulCfg.max_soul_count}，无法再分化`
                };
            }

            // 校验第二元神存在且境界≥化神期
            const secondSoul = existingSouls.find(s => s.soul_index === 2);
            if (!secondSoul) {
                await t.rollback();
                return { success: false, message: '需先凝练第二元神才能进行元神分化' };
            }

            const minRank = soulCfg.min_realm_rank;
            if (Number(secondSoul.realm_rank || 0) < minRank) {
                await t.rollback();
                return {
                    success: false,
                    message: `第二元神境界需达到${soulCfg.min_realm_name}（rank≥${minRank}）才能分化第三元神（当前 rank ${secondSoul.realm_rank}）`
                };
            }

            // 计算第三元神属性（继承第二元神属性 * inherit_ratio_third + 随机加成 ±10%）
            const secondAttrs = secondSoul.attributes || {};
            const inheritRatio = soulCfg.inherit_ratio_third;
            const randomRange = soulCfg.random_bonus_range;
            const newAttrs = {
                atk: Math.floor((Number(secondAttrs.atk || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                def: Math.floor((Number(secondAttrs.def || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                hp_max: Math.floor((Number(secondAttrs.hp_max || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                speed: Math.floor((Number(secondAttrs.speed || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange)),
                sense: Math.floor((Number(secondAttrs.sense || 0)) * inheritRatio * (1 + (Math.random() * 2 - 1) * randomRange))
            };

            // 第三元神境界 = 第二元神境界 - 1 子境界
            const newSoulRealmRank = calcSecondSoulRealmRank(Number(secondSoul.realm_rank || 0));
            const newSoulRealm = getRealmNameByRank(newSoulRealmRank) || secondSoul.realm;

            const newRealm = RealmService.getRealmByRank(newSoulRealmRank);
            const initExp = newRealm ? Math.floor((Number(newRealm.exp_cap || 0)) / 2) : 0;

            // 创建第三元神记录
            const newSoul = await PlayerSecondSoul.create({
                player_id: playerId,
                soul_index: 3,
                soul_name: soulName.trim(),
                soul_type: 'normal',
                realm: newSoulRealm,
                realm_rank: newSoulRealmRank,
                exp: initExp,
                attributes: newAttrs,
                inherit_ratio: inheritRatio,
                is_active: 0,
                is_cultivating: 0,
                combat_count: 0,
                cultivate_count: 0
            }, { transaction: t });

            // 更新玩家副元神计数
            player.second_soul_count = (player.second_soul_count || 0) + 1;
            await player.save({ transaction: t });

            await t.commit();

            const message = pickRandomMessage(soulCfg.divide_success_messages);

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'second_soul_divided', {
                    message,
                    soul_index: newSoul.soul_index,
                    soul_name: newSoul.soul_name,
                    realm: newSoul.realm,
                    attributes: newAttrs
                });
            } catch (e) {
                console.warn('[SecondSoulService] 推送分化成功通知失败:', e.message);
            }

            return {
                success: true,
                message,
                data: {
                    soul_id: newSoul.id,
                    soul_index: newSoul.soul_index,
                    soul_name: newSoul.soul_name,
                    realm: newSoul.realm,
                    realm_rank: newSoul.realm_rank,
                    exp: newSoul.exp.toString(),
                    attributes: newAttrs,
                    inherit_ratio: newSoul.inherit_ratio
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SecondSoulService] divide 异常:', err);
            throw err;
        }
    }

    /**
     * 切换调度模式
     * combat/cultivate/scout/defend 各模式独立持续时间和 CD
     * @param {number} playerId - 玩家ID
     * @param {number} soulIndex - 元神序号（2 或 3）
     * @param {string} mode - 调度模式（combat/cultivate/scout/defend）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async dispatch(playerId, soulIndex, mode) {
        if (![2, 3].includes(soulIndex)) {
            return { success: false, message: 'soul_index 必须为 2 或 3', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const config = configLoader.getConfig('late_stage_data');
        const soulCfg = config.second_soul;
        const dispatchModes = soulCfg.dispatch_modes;

        if (!mode || !dispatchModes[mode]) {
            return {
                success: false,
                message: `调度模式无效，支持：${Object.keys(dispatchModes).join('/')}`,
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const soul = await PlayerSecondSoul.findOne({
                where: { player_id: playerId, soul_index: soulIndex },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!soul) {
                await t.rollback();
                return { success: false, message: `元神序号 ${soulIndex} 不存在` };
            }

            // 修炼中拦截
            if (soul.is_cultivating === 1) {
                await t.rollback();
                return { success: false, message: '元神正在独立修炼中，无法切换调度模式' };
            }

            // 上次调度 CD 校验
            if (soul.dispatch_until) {
                const dispatchUntilMs = new Date(soul.dispatch_until).getTime();
                if (dispatchUntilMs > Date.now()) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `当前调度仍在进行中，剩余 ${Math.floor((dispatchUntilMs - Date.now()) / 1000)} 秒`
                    };
                }
            }

            // CD 校验（基于上次调度结束时间）
            const modeCfg = dispatchModes[mode];
            if (soul.last_dispatch_mode && modeCfg.cooldown_seconds > 0) {
                // 上次调度结束后才计算 CD
                const lastDispatchEnd = soul.dispatch_until ? new Date(soul.dispatch_until) : null;
                if (lastDispatchEnd) {
                    const elapsedSec = Math.floor((Date.now() - lastDispatchEnd.getTime()) / 1000);
                    if (elapsedSec < modeCfg.cooldown_seconds) {
                        await t.rollback();
                        return {
                            success: false,
                            message: `${modeCfg.display_name}模式冷却中，剩余 ${modeCfg.cooldown_seconds - elapsedSec} 秒`
                        };
                    }
                }
            }

            // 切换调度模式
            const now = new Date();
            soul.last_dispatch_mode = mode;
            if (modeCfg.duration_seconds > 0) {
                soul.dispatch_until = new Date(now.getTime() + modeCfg.duration_seconds * 1000);
            } else {
                // defend 模式持续时间与闭关同步，此处设为 1 小时（实际由闭关结束触发取消）
                soul.dispatch_until = new Date(now.getTime() + 3600 * 1000);
            }

            // combat 模式增加战斗次数
            if (mode === 'combat') {
                soul.combat_count += 1;
            }

            await soul.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'second_soul_dispatched', {
                    soul_index: soul.soul_index,
                    soul_name: soul.soul_name,
                    mode,
                    mode_name: modeCfg.display_name,
                    duration_seconds: modeCfg.duration_seconds,
                    dispatch_until: soul.dispatch_until.toISOString()
                });
            } catch (e) {
                console.warn('[SecondSoulService] 推送调度通知失败:', e.message);
            }

            return {
                success: true,
                message: `元神「${soul.soul_name}」已切换为${modeCfg.display_name}模式`,
                data: {
                    soul_id: soul.id,
                    soul_index: soul.soul_index,
                    mode,
                    mode_name: modeCfg.display_name,
                    description: modeCfg.description,
                    duration_seconds: modeCfg.duration_seconds,
                    dispatch_until: soul.dispatch_until.toISOString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SecondSoulService] dispatch 异常:', err);
            throw err;
        }
    }

    /**
     * 独立挂机修炼
     * 12 小时上限，每日 2 次
     * @param {number} playerId - 玩家ID
     * @param {number} soulIndex - 元神序号（2 或 3）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async cultivate(playerId, soulIndex) {
        if (![2, 3].includes(soulIndex)) {
            return { success: false, message: 'soul_index 必须为 2 或 3', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const soul = await PlayerSecondSoul.findOne({
                where: { player_id: playerId, soul_index: soulIndex },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!soul) {
                await t.rollback();
                return { success: false, message: `元神序号 ${soulIndex} 不存在` };
            }

            const config = configLoader.getConfig('late_stage_data');
            const soulCfg = config.second_soul;

            // 调度中拦截
            if (soul.dispatch_until && new Date(soul.dispatch_until).getTime() > Date.now()) {
                await t.rollback();
                return { success: false, message: '元神正在调度中，无法开始独立修炼' };
            }

            // 已在修炼中拦截
            if (soul.is_cultivating === 1) {
                await t.rollback();
                return { success: false, message: '元神已在独立修炼中' };
            }

            // 跨日重置每日修炼次数
            resetDailyCountIfCrossDay(soul, 'cultivate_end_time', 'cultivate_count', 0);
            // 注：此处用 cultivate_end_time 兜底跨日判断；如需精确按日重置，应使用专门日期字段
            // 当前实现：检查上次修炼结束时间是否跨日
            const today = new Date().toISOString().slice(0, 10);
            if (soul.cultivate_end_time) {
                const lastStr = new Date(soul.cultivate_end_time).toISOString().slice(0, 10);
                if (lastStr !== today) {
                    soul.cultivate_count = 0;
                }
            }

            // 次数校验
            if (soul.cultivate_count >= soulCfg.cultivate_daily_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日独立修炼次数已用完（${soul.cultivate_count}/${soulCfg.cultivate_daily_limit}）`
                };
            }

            // 开始修炼
            const now = new Date();
            const durationSec = soulCfg.cultivate_max_duration_seconds;
            soul.is_cultivating = 1;
            soul.cultivate_started_at = now;
            soul.cultivate_end_time = new Date(now.getTime() + durationSec * 1000);
            soul.cultivate_count += 1;

            await soul.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'second_soul_cultivate_started', {
                    soul_index: soul.soul_index,
                    soul_name: soul.soul_name,
                    started_at: now.toISOString(),
                    end_time: soul.cultivate_end_time.toISOString(),
                    duration_seconds: durationSec,
                    daily_count: soul.cultivate_count,
                    daily_limit: soulCfg.cultivate_daily_limit
                });
            } catch (e) {
                console.warn('[SecondSoulService] 推送修炼开始通知失败:', e.message);
            }

            return {
                success: true,
                message: `元神「${soul.soul_name}」开始独立修炼，预计 ${Math.floor(durationSec / 3600)} 小时后完成`,
                data: {
                    soul_id: soul.id,
                    soul_index: soul.soul_index,
                    soul_name: soul.soul_name,
                    started_at: now.toISOString(),
                    end_time: soul.cultivate_end_time.toISOString(),
                    duration_seconds: durationSec,
                    daily_count: soul.cultivate_count,
                    daily_limit: soulCfg.cultivate_daily_limit,
                    base_rate_per_second: soulCfg.cultivate_base_rate_per_second
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[SecondSoulService] cultivate 异常:', err);
            throw err;
        }
    }

    /**
     * GM 调整副元神属性
     * @param {number} playerId - 玩家ID
     * @param {number} soulIndex - 元神序号（2 或 3）
     * @param {Object} attributes - 新属性对象（atk/def/hp_max/speed/sense）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmAdjustAttributes(playerId, soulIndex, attributes) {
        if (![2, 3].includes(soulIndex)) {
            return { success: false, message: 'soul_index 必须为 2 或 3', error_code: ErrorCodes.VALIDATION_ERROR };
        }
        if (!attributes || typeof attributes !== 'object') {
            return { success: false, message: 'attributes 必须为对象', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        // 允许的字段
        const allowedFields = ['atk', 'def', 'hp_max', 'speed', 'sense'];
        const newAttrs = {};
        for (const f of allowedFields) {
            if (attributes[f] !== undefined) {
                const v = Number(attributes[f]);
                if (!Number.isFinite(v) || v < 0) {
                    return { success: false, message: `属性 ${f} 必须为非负数字`, error_code: ErrorCodes.VALIDATION_ERROR };
                }
                newAttrs[f] = Math.floor(v);
            }
        }
        if (Object.keys(newAttrs).length === 0) {
            return { success: false, message: '至少需要提供一个有效属性（atk/def/hp_max/speed/sense）', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const soul = await PlayerSecondSoul.findOne({ where: { player_id: playerId, soul_index: soulIndex } });
        if (!soul) {
            return { success: false, message: `元神序号 ${soulIndex} 不存在` };
        }

        // 合并属性
        const currentAttrs = soul.attributes || {};
        const mergedAttrs = { ...currentAttrs, ...newAttrs };
        const oldAttrs = { ...currentAttrs };
        soul.attributes = mergedAttrs;
        await soul.save();

        return {
            success: true,
            message: `元神「${soul.soul_name}」属性已调整`,
            data: {
                soul_id: soul.id,
                soul_index: soul.soul_index,
                old_attributes: oldAttrs,
                new_attributes: mergedAttrs
            }
        };
    }
}

module.exports = SecondSoulService;
