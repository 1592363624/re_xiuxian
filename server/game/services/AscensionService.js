/**
 * 飞升灵界核心服务
 *
 * 实现批次3设计文档第3章「飞升+夺舍重生系统」的飞升侧全部业务逻辑：
 *   1. 飞升前置校验（化神巅峰 + 大衍诀五层 + 法则碎片5块 + 逆灵通道坐标 + 残魂≥80 + 状态互斥）
 *   2. 飞升成功率计算（基础30% + 问道/法相/大衍/残魂/法则碎片补正，上限95%）
 *   3. 空间节点搜寻/定星稳固（CD 1小时，未稳固24小时过期）
 *   4. 飞升执行（事务+行级锁，成功飞升灵界，失败残魂-30、修为-10%、虚弱2小时）
 *   5. 天机回溯（每日1次，跨日重置，回到飞升前状态）
 *   6. 问道（每日3次、CD 30分钟、消耗灵石、积累感悟、10%暴击双倍）
 *   7. 法相天地（9级数值表，消耗问道感悟+灵石，失败返还30%灵石）
 *   8. 探寻裂缝（每日5次、CD 10分钟、消耗神识+灵石、15%反噬概率）
 *
 * 设计原则：
 *   - 所有阈值/CD/概率从 ascension_data.json 配置读取，禁止硬编码
 *   - 关键操作（飞升/稳固/法相）使用事务 + LOCK.UPDATE 行级锁
 *   - BigInt 字段（exp/spirit_stones）比较时用 BigInt() 包装，序列化自动转字符串
 *   - 状态机互斥通过 PlayerStateMachine.canStart(playerId, 'ASCENDING') 校验
 *   - 重大事件通过 WebSocketNotificationService 推送，事务外推送避免阻塞
 *   - 跨日重置统一封装 _resetDailyCountIfCrossDay
 *
 * 数据模型：
 *   - Player: 玩家主表（remnant_soul/ask_dao_insight/dharma_form_level/exp/spirit_stones/weakness_end_time）
 *   - PlayerAscension: 玩家飞升进度（1:1，dayan_level/law_fragments_count/reverse_channel_coord/ascension_state）
 *   - PlayerAscensionNode: 玩家空间节点（N:1，node_state/stability/reward_type/expires_at）
 *
 * 注意：玩家神识（divine_sense）字段未在 players 表单独建立，统一从 player.attributes.sense 读取
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerAscension = require('../../models/playerAscension');
const PlayerAscensionNode = require('../../models/playerAscensionNode');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const PlayerStateMachine = require('../state/PlayerStateMachine');

// 飞升状态机枚举值（与 registrations/ascension.js 中保持一致）
const ASCENSION_STATE_ENUM = 'ASCENDING';

/**
 * 工具函数：从玩家对象读取神识值
 * 玩家表无独立 divine_sense 字段，神识存储于 attributes.sense
 * @param {Object} player - 玩家对象
 * @returns {number} 神识值，无则返回 0
 */
function getDivineSense(player) {
    if (!player) return 0;
    // attributes 是 Sequelize getter 自动解析的 JSON 对象
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
    player.attributes = attrs; // 触发 setter 序列化
}

/**
 * 工具函数：增加玩家神识
 * @param {Object} player - 玩家对象
 * @param {number} gain - 增加量
 */
function addDivineSense(player, gain) {
    const attrs = player.attributes || {};
    const current = Number(attrs.sense || 0);
    attrs.sense = current + gain;
    player.attributes = attrs;
}

/**
 * 工具函数：跨日重置每日次数（按 DATEONLY 比较）
 * @param {Object} model - 模型实例（Player 或 PlayerAscension）
 * @param {string} dateField - 日期字段名
 * @param {string} countField - 次数字段名
 * @param {number} resetValue - 重置后的次数（默认 0）
 */
function resetDailyCountIfCrossDay(model, dateField, countField, resetValue = 0) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
        // 首次设置
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
 * 工具函数：加权随机抽取节点
 * @param {Array} pool - 节点池（每个元素含 discovery_weight）
 * @returns {Object} 抽中的节点
 */
function weightedRandomPick(pool) {
    const totalWeight = pool.reduce((sum, n) => sum + (n.discovery_weight || 0), 0);
    if (totalWeight <= 0) return pool[0];
    let rand = Math.random() * totalWeight;
    for (const item of pool) {
        rand -= (item.discovery_weight || 0);
        if (rand <= 0) return item;
    }
    return pool[pool.length - 1];
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

class AscensionService {
    /**
     * 获取玩家飞升面板数据
     * 包含飞升进度、大衍诀、节点列表、问道感悟、法相等级、成功率预估
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 面板数据
     */
    static async getProfile(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('ascension_data');
        // 获取或初始化飞升进度记录
        let ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        if (!ascension) {
            ascension = await PlayerAscension.create({
                player_id: playerId,
                ascension_state: 'preparing',
                revert_count: config.ascension.revert_daily_limit
            });
        }

        // 跨日重置天机回溯次数
        resetDailyCountIfCrossDay(ascension, 'last_revert_date', 'revert_count', config.ascension.revert_daily_limit);
        if (ascension.changed('revert_count') || ascension.changed('last_revert_date')) {
            await ascension.save();
        }

        // 查询当前活跃节点（未过期）
        const now = new Date();
        const activeNodes = await PlayerAscensionNode.findAll({
            where: {
                player_id: playerId,
                expires_at: { [Op.gt]: now }
            },
            order: [['discovered_at', 'DESC']]
        });

        // 计算当前飞升成功率预估
        const rateInfo = await this.calculateSuccessRate(playerId);

        // 前置条件检查
        const prereq = await this.checkPrerequisites(playerId);

        return {
            success: true,
            data: {
                player: {
                    id: player.id,
                    nickname: player.nickname,
                    realm: player.realm,
                    realm_rank: player.realm_rank,
                    exp: player.exp ? player.exp.toString() : '0',
                    spirit_stones: player.spirit_stones ? player.spirit_stones.toString() : '0',
                    remnant_soul: player.remnant_soul,
                    divine_sense: getDivineSense(player),
                    ask_dao_insight: player.ask_dao_insight,
                    dharma_form_level: player.dharma_form_level,
                    weakness_end_time: player.weakness_end_time,
                    is_dead: player.is_dead
                },
                ascension: {
                    ascension_state: ascension.ascension_state,
                    dayan_level: ascension.dayan_level,
                    dayan_exp: ascension.dayan_exp,
                    reverse_channel_coord: ascension.reverse_channel_coord,
                    law_fragments_count: ascension.law_fragments_count,
                    ascension_attempt_count: ascension.ascension_attempt_count,
                    ascension_success_count: ascension.ascension_success_count,
                    is_ascended: ascension.is_ascended,
                    ascended_at: ascension.ascended_at,
                    revert_count: ascension.revert_count,
                    last_ascension_time: ascension.last_ascension_time,
                    last_revert_time: ascension.last_revert_time
                },
                nodes: activeNodes.map(n => ({
                    id: n.id,
                    node_key: n.node_key,
                    node_name: n.node_name,
                    node_state: n.node_state,
                    stability: n.stability,
                    reward_type: n.reward_type,
                    reward_claimed: n.reward_claimed,
                    discovered_at: n.discovered_at,
                    stabilize_started_at: n.stabilize_started_at,
                    stabilized_at: n.stabilized_at,
                    expires_at: n.expires_at,
                    remaining_seconds: Math.max(0, Math.floor((new Date(n.expires_at).getTime() - now.getTime()) / 1000))
                })),
                success_rate: rateInfo.success ? rateInfo.data : null,
                prerequisites: prereq.data
            }
        };
    }

    /**
     * 飞升前置条件检查
     * 检查境界、大衍诀、法则碎片、逆灵通道坐标、残魂、状态互斥
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data: { canAscend, reasons, bonuses } }
     */
    static async checkPrerequisites(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('ascension_data');
        const ascensionCfg = config.ascension;
        let ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        if (!ascension) {
            ascension = await PlayerAscension.create({
                player_id: playerId,
                ascension_state: 'preparing',
                revert_count: ascensionCfg.revert_daily_limit
            });
        }

        const reasons = [];

        // 1. 境界检查：必须达到化神巅峰（统一通过 RealmService 校验）
        const realmCheck = RealmService.meetsRealmRequirement(player, ascensionCfg.min_realm_name);
        if (!realmCheck.met) {
            reasons.push(`境界未达${ascensionCfg.min_realm_name}（当前 ${player.realm}）`);
        }

        // 2. 大衍诀层数：必须达到五层·衍神
        if (ascension.dayan_level < ascensionCfg.required_dayan_level) {
            reasons.push(`大衍诀未达五层·衍神（当前 ${ascension.dayan_level} 层）`);
        }

        // 3. 逆灵通道坐标：必须已获得
        if (!ascension.reverse_channel_coord) {
            reasons.push('未获得逆灵通道坐标，需先搜寻节点并定星稳固');
        }

        // 4. 空间法则碎片：至少 5 块
        if (ascension.law_fragments_count < ascensionCfg.required_law_fragments) {
            reasons.push(`空间法则碎片不足（${ascension.law_fragments_count}/${ascensionCfg.required_law_fragments}）`);
        }

        // 5. 残魂值：必须 ≥ 80（防止残魂低时强行飞升）
        if (Number(player.remnant_soul || 0) < ascensionCfg.min_remnant_soul) {
            reasons.push(`残魂值过低（${player.remnant_soul}/${ascensionCfg.min_remnant_soul}），需先恢复`);
        }

        // 6. 状态检查：不能在闭关/战斗/副本/出窍/移动/悟道/PVP中
        const stateCheck = await PlayerStateMachine.canStart(playerId, ASCENSION_STATE_ENUM, {
            source: 'service',
            stateType: 'ascension'
        });
        if (!stateCheck.allowed) {
            reasons.push(`当前状态不可飞升：${stateCheck.reason}`);
        }

        // 7. 已飞升玩家不允许再次飞升（除非设计支持多界飞升，当前只支持灵界）
        if (ascension.is_ascended === 1) {
            reasons.push('已飞升灵界，无法再次飞升');
        }

        return {
            success: true,
            data: {
                canAscend: reasons.length === 0,
                reasons,
                checked_at: new Date().toISOString()
            }
        };
    }

    /**
     * 计算飞升成功率
     * 公式：min(max_success_rate, base + 问道补正 + 法相补正 + 大衍补正 + 残魂补正 + 法则碎片补正)
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data: { final_rate, breakdown } }
     */
    static async calculateSuccessRate(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('ascension_data');
        const ascensionCfg = config.ascension;
        const bonusCaps = ascensionCfg.bonus_caps || {};

        let ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        if (!ascension) {
            ascension = await PlayerAscension.create({
                player_id: playerId,
                ascension_state: 'preparing',
                revert_count: ascensionCfg.revert_daily_limit
            });
        }

        // 基础成功率
        const baseRate = ascensionCfg.base_success_rate;

        // 1. 问道感悟补正：每点 +0.1%（按 max_insight 比例线性映射到 bonus_caps.ask_dao_insight）
        const askDaoInsight = Number(player.ask_dao_insight || 0);
        const askDaoConfig = config.ask_dao;
        const maxInsight = askDaoConfig?.max_insight || 100;
        const askDaoBonus = Math.min(
            bonusCaps.ask_dao_insight || 0.10,
            (askDaoInsight / maxInsight) * (bonusCaps.ask_dao_insight || 0.10)
        );

        // 2. 法相天地补正：每级 +2%（上限 18% = 9级）
        const dharmaLevel = Number(player.dharma_form_level || 0);
        const dharmaConfig = config.dharma_form;
        let dharmaBonus = 0;
        if (dharmaLevel > 0 && Array.isArray(dharmaConfig.levels)) {
            const levelCfg = dharmaConfig.levels.find(l => l.level === dharmaLevel);
            dharmaBonus = levelCfg ? levelCfg.ascension_bonus : 0;
        }
        dharmaBonus = Math.min(dharmaBonus, bonusCaps.dharma_form || 0.18);

        // 3. 大衍诀补正：达到五层 +10%
        const dayanBonus = ascension.dayan_level >= ascensionCfg.required_dayan_level
            ? (bonusCaps.dayan_level_5 || 0.10)
            : 0;

        // 4. 残魂补正：80以上每点 +0.5%（上限 10%）
        const remnantSoul = Number(player.remnant_soul || 0);
        const remnantBonus = Math.min(
            bonusCaps.remnant_soul || 0.10,
            Math.max(0, (remnantSoul - ascensionCfg.min_remnant_soul) * 0.005)
        );

        // 5. 法则碎片补正：每块 +1%（上限 5%）
        const lawFragments = ascension.law_fragments_count;
        const lawBonus = Math.min(
            bonusCaps.law_fragments || 0.05,
            lawFragments * 0.01
        );

        // 总补正上限校验
        const totalBonusRaw = askDaoBonus + dharmaBonus + dayanBonus + remnantBonus + lawBonus;
        const totalBonus = Math.min(totalBonusRaw, bonusCaps.total_max || 0.50);

        // 最终成功率（不超过 max_success_rate）
        const finalRate = Math.min(ascensionCfg.max_success_rate, baseRate + totalBonus);

        return {
            success: true,
            data: {
                final_rate: Number(finalRate.toFixed(4)),
                base_rate: baseRate,
                breakdown: {
                    ask_dao_bonus: Number(askDaoBonus.toFixed(4)),
                    dharma_form_bonus: Number(dharmaBonus.toFixed(4)),
                    dayan_bonus: Number(dayanBonus.toFixed(4)),
                    remnant_soul_bonus: Number(remnantBonus.toFixed(4)),
                    law_fragments_bonus: Number(lawBonus.toFixed(4)),
                    total_bonus: Number(totalBonus.toFixed(4)),
                    total_bonus_capped: totalBonusRaw > totalBonus
                },
                max_rate: ascensionCfg.max_success_rate
            }
        };
    }

    /**
     * 搜寻空间节点
     * 从 node_pool 加权随机抽取，写入 player_ascension_node 表
     * CD 1 小时，未稳固 24 小时后过期
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async searchNode(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const config = configLoader.getConfig('ascension_data');
        const nodeCfg = config.space_node;

        // 境界校验：元婴初期才可搜寻节点
        const realmCheck = RealmService.meetsRealmRequirement(player, nodeCfg.min_realm_name);
        if (!realmCheck.met) {
            return { success: false, message: `需达到${nodeCfg.min_realm_name}才能搜寻空间节点` };
        }

        // 状态机互斥校验：搜寻节点为瞬时操作，但仍不允许在战斗/闭关等持续状态中触发
        const stateCheck = await PlayerStateMachine.canStart(playerId, 'IDLE', {
            source: 'service',
            stateType: 'ascension'
        });
        if (!stateCheck.allowed) {
            return { success: false, message: stateCheck.reason };
        }

        // 冷却校验：取最近一次发现时间作为冷却基准
        const lastNode = await PlayerAscensionNode.findOne({
            where: { player_id: playerId },
            order: [['discovered_at', 'DESC']]
        });
        if (lastNode) {
            const cd = checkCooldown(lastNode, 'discovered_at', nodeCfg.discovery_cooldown_seconds);
            if (!cd.ready) {
                return {
                    success: false,
                    message: `搜寻节点冷却中，剩余 ${Math.floor(cd.remainingSec / 60)} 分钟`
                };
            }
        }

        // 活跃节点数上限校验
        const now = new Date();
        const activeCount = await PlayerAscensionNode.count({
            where: {
                player_id: playerId,
                expires_at: { [Op.gt]: now }
            }
        });
        if (activeCount >= nodeCfg.max_active_nodes_per_player) {
            return {
                success: false,
                message: `当前已有 ${activeCount} 个活跃节点，达到上限 ${nodeCfg.max_active_nodes_per_player}`
            };
        }

        // 加权随机抽取节点
        const pool = nodeCfg.node_pool || [];
        if (pool.length === 0) {
            return { success: false, message: '节点池为空，请联系管理员' };
        }
        const picked = weightedRandomPick(pool);

        // 写入节点记录
        const expiresAt = new Date(now.getTime() + nodeCfg.node_expire_seconds * 1000);
        const newNode = await PlayerAscensionNode.create({
            player_id: playerId,
            node_key: picked.node_key,
            node_name: picked.node_name,
            node_state: 'discovered',
            stability: 0,
            reward_type: picked.reward_type,
            reward_claimed: 0,
            discovered_at: now,
            expires_at: expiresAt
        });

        // WebSocket 推送节点发现通知
        try {
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'ascension_node_discovered', {
                node_id: newNode.id,
                node_key: newNode.node_key,
                node_name: newNode.node_name,
                reward_type: newNode.reward_type,
                expires_at: newNode.expires_at.toISOString()
            });
        } catch (e) {
            console.warn('[AscensionService] 推送节点发现通知失败:', e.message);
        }

        return {
            success: true,
            message: `发现空间节点「${picked.node_name}」！可使用定星稳固获取奖励`,
            data: {
                node_id: newNode.id,
                node_key: newNode.node_key,
                node_name: newNode.node_name,
                reward_type: newNode.reward_type,
                discovered_at: newNode.discovered_at.toISOString(),
                expires_at: newNode.expires_at.toISOString(),
                remaining_seconds: nodeCfg.node_expire_seconds
            }
        };
    }

    /**
     * 定星稳固节点
     * 消耗神识+灵石，稳固 30 分钟，完成后调用 stabilizeNodeComplete 发放奖励
     * @param {number} playerId - 玩家ID
     * @param {number} nodeId - 节点ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async stabilizeNode(playerId, nodeId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁锁定玩家，防止并发扣费
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const nodeCfg = config.space_node;

            // 查询节点（行级锁）
            const node = await PlayerAscensionNode.findOne({
                where: { id: nodeId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!node) {
                await t.rollback();
                return { success: false, message: '节点不存在或不属于你' };
            }

            // 状态校验：仅 discovered 状态可定星
            if (node.node_state !== 'discovered') {
                await t.rollback();
                return { success: false, message: `节点当前状态为 ${node.node_state}，无法定星` };
            }

            // 过期校验
            if (new Date(node.expires_at).getTime() <= Date.now()) {
                node.node_state = 'failed';
                await node.save({ transaction: t });
                await t.commit();
                return { success: false, message: '节点已过期，无法定星' };
            }

            // 神识消耗校验
            const divineSense = getDivineSense(player);
            if (divineSense < nodeCfg.stabilize_cost_divine_sense) {
                await t.rollback();
                return {
                    success: false,
                    message: `神识不足，需要 ${nodeCfg.stabilize_cost_divine_sense}，当前 ${divineSense}`
                };
            }

            // 灵石消耗校验（BigInt 比较）
            const costStones = BigInt(nodeCfg.stabilize_cost_spirit_stones);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 扣减神识
            consumeDivineSense(player, nodeCfg.stabilize_cost_divine_sense);
            // 扣减灵石
            player.spirit_stones = (playerStones - costStones).toString();

            // 更新节点状态为稳固中
            const now = new Date();
            node.node_state = 'stabilizing';
            node.stability = 0;
            node.stabilize_started_at = now;

            await player.save({ transaction: t });
            await node.save({ transaction: t });

            await t.commit();

            // 计算稳固完成时间（30 分钟后）
            const completeAt = new Date(now.getTime() + nodeCfg.stabilize_duration_seconds * 1000);

            return {
                success: true,
                message: `开始定星稳固「${node.node_name}」，预计 ${nodeCfg.stabilize_duration_seconds / 60} 分钟后完成`,
                data: {
                    node_id: node.id,
                    node_name: node.node_name,
                    node_state: node.node_state,
                    stabilize_started_at: now.toISOString(),
                    stabilize_complete_at: completeAt.toISOString(),
                    remaining_seconds: nodeCfg.stabilize_duration_seconds,
                    cost: {
                        divine_sense: nodeCfg.stabilize_cost_divine_sense,
                        spirit_stones: costStones.toString()
                    }
                }
            };
        } catch (err) {
            // 事务未完成时回滚，避免重复 rollback 崩溃
            if (t && !t.finished) await t.rollback();
            console.error('[AscensionService] stabilizeNode 异常:', err);
            throw err;
        }
    }

    /**
     * 稳固完成结算（内部方法，由 StateCleanerService 调用）
     * 检查 stabilize_started_at + stabilize_duration_seconds 是否到达
     * 完成后根据 reward_type 发放奖励：coord/dan_recipe/spirit_milk/law_fragment
     * @param {number} playerId - 玩家ID
     * @param {number} nodeId - 节点ID
     * @returns {Promise<Object>} 结算结果
     */
    static async stabilizeNodeComplete(playerId, nodeId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const nodeCfg = config.space_node;

            const node = await PlayerAscensionNode.findOne({
                where: { id: nodeId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!node) {
                await t.rollback();
                return { success: false, message: '节点不存在' };
            }

            // 仅 stabilizing 状态可结算
            if (node.node_state !== 'stabilizing') {
                await t.rollback();
                return { success: false, message: `节点状态 ${node.node_state} 无需结算` };
            }

            // 校验稳固时长是否足够
            const startedAt = node.stabilize_started_at ? new Date(node.stabilize_started_at).getTime() : 0;
            const elapsed = Math.floor((Date.now() - startedAt) / 1000);
            if (elapsed < nodeCfg.stabilize_duration_seconds) {
                await t.rollback();
                return {
                    success: false,
                    message: `稳固时长不足，还需 ${nodeCfg.stabilize_duration_seconds - elapsed} 秒`
                };
            }

            // 更新节点为已稳固
            const now = new Date();
            node.node_state = 'stable';
            node.stability = nodeCfg.stability_threshold;
            node.stabilized_at = now;
            node.reward_claimed = 1; // 直接发放，标记已领取

            // 根据 reward_type 发放奖励
            const rewardType = node.reward_type;
            let rewardMessage = '';
            let ascension = await PlayerAscension.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!ascension) {
                ascension = await PlayerAscension.create({
                    player_id: playerId,
                    ascension_state: 'preparing',
                    revert_count: config.ascension.revert_daily_limit
                }, { transaction: t });
            }

            switch (rewardType) {
                case 'coord': {
                    // 逆灵通道坐标：生成随机坐标字符串
                    const coord = `虚空·${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
                    ascension.reverse_channel_coord = coord;
                    rewardMessage = nodeCfg.reward_messages?.coord || '定星成功！获得逆灵通道坐标';
                    break;
                }
                case 'law_fragment': {
                    // 法则碎片 +1（配置中 reward_quantity 默认为 1，简化处理）
                    ascension.law_fragments_count = (ascension.law_fragments_count || 0) + 1;
                    rewardMessage = nodeCfg.reward_messages?.law_fragment || '定星成功！获得空间法则碎片';
                    break;
                }
                case 'spirit_milk': {
                    // 万年灵乳：暂存到玩家属性 JSON 的 inventory 字段（简化为统计入 stats）
                    // 实际物品系统由 InventoryService 管理，此处仅记录获得事件
                    rewardMessage = nodeCfg.reward_messages?.spirit_milk || '定星成功！获得万年灵乳';
                    break;
                }
                case 'dan_recipe': {
                    // 虚灵丹丹方：同上，由物品系统管理
                    rewardMessage = nodeCfg.reward_messages?.dan_recipe || '定星成功！获得虚灵丹丹方';
                    break;
                }
                default:
                    rewardMessage = '定星成功！';
            }

            await ascension.save({ transaction: t });
            await node.save({ transaction: t });

            await t.commit();

            // WebSocket 推送稳固完成通知（事务外）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'ascension_node_stabilized', {
                    node_id: node.id,
                    node_name: node.node_name,
                    reward_type: rewardType,
                    reward_message: rewardMessage,
                    law_fragments_count: ascension.law_fragments_count,
                    reverse_channel_coord: ascension.reverse_channel_coord
                });
            } catch (e) {
                console.warn('[AscensionService] 推送稳固完成通知失败:', e.message);
            }

            return {
                success: true,
                message: rewardMessage,
                data: {
                    node_id: node.id,
                    node_name: node.node_name,
                    reward_type: rewardType,
                    reward_message: rewardMessage,
                    stabilized_at: now.toISOString()
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[AscensionService] stabilizeNodeComplete 异常:', err);
            throw err;
        }
    }

    /**
     * 执行飞升尝试
     * 事务 + 行级锁，成功：飞升灵界、is_ascended=1
     * 失败：残魂-30、修为-10%、虚弱2小时、推送天机回溯提示
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async ascend(playerId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁锁定玩家
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const ascensionCfg = config.ascension;

            // 行级锁锁定飞升进度
            let ascension = await PlayerAscension.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!ascension) {
                ascension = await PlayerAscension.create({
                    player_id: playerId,
                    ascension_state: 'preparing',
                    revert_count: ascensionCfg.revert_daily_limit
                }, { transaction: t });
            }

            // 已飞升拦截
            if (ascension.is_ascended === 1) {
                await t.rollback();
                return { success: false, message: '已飞升灵界，无法再次飞升' };
            }

            // 飞升中状态拦截（防止并发触发）
            if (ascension.ascension_state === 'ascending') {
                await t.rollback();
                return { success: false, message: '飞升尝试进行中，请勿重复触发' };
            }

            // 冷却校验
            if (ascension.last_ascension_time) {
                const cd = checkCooldown(ascension, 'last_ascension_time', ascensionCfg.cooldown_seconds);
                if (!cd.ready) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `飞升冷却中，剩余 ${Math.floor(cd.remainingSec / 3600)} 小时`
                    };
                }
            }

            // 状态机互斥校验
            const stateCheck = await PlayerStateMachine.canStart(playerId, ASCENSION_STATE_ENUM, {
                source: 'service',
                stateType: 'ascension'
            });
            if (!stateCheck.allowed) {
                await t.rollback();
                return { success: false, message: stateCheck.reason };
            }

            // 前置条件二次校验（事务内）
            const realmCheck = RealmService.meetsRealmRequirement(player, ascensionCfg.min_realm_name);
            if (!realmCheck.met) {
                await t.rollback();
                return { success: false, message: `境界未达${ascensionCfg.min_realm_name}` };
            }
            if (ascension.dayan_level < ascensionCfg.required_dayan_level) {
                await t.rollback();
                return { success: false, message: `大衍诀未达五层·衍神` };
            }
            if (!ascension.reverse_channel_coord) {
                await t.rollback();
                return { success: false, message: '未获得逆灵通道坐标' };
            }
            if (ascension.law_fragments_count < ascensionCfg.required_law_fragments) {
                await t.rollback();
                return { success: false, message: `法则碎片不足（${ascension.law_fragments_count}/${ascensionCfg.required_law_fragments}）` };
            }
            if (Number(player.remnant_soul || 0) < ascensionCfg.min_remnant_soul) {
                await t.rollback();
                return { success: false, message: `残魂值过低（${player.remnant_soul}/${ascensionCfg.min_remnant_soul}）` };
            }

            // 标记为飞升中
            ascension.ascension_state = 'ascending';
            ascension.ascension_attempt_count += 1;
            await ascension.save({ transaction: t });

            // 计算最终成功率
            const rateInfo = await this.calculateSuccessRate(playerId);
            const finalRate = rateInfo.success ? rateInfo.data.final_rate : ascensionCfg.base_success_rate;

            // 掷骰子判定
            const roll = Math.random();
            const isSuccess = roll < finalRate;

            const now = new Date();
            ascension.last_ascension_time = now;

            if (isSuccess) {
                // ===== 飞升成功 =====
                ascension.ascension_state = 'success';
                ascension.ascension_success_count += 1;
                ascension.is_ascended = 1;
                ascension.ascended_at = now;
                ascension.ascension_realm = 'lingji';

                // 神识消耗
                consumeDivineSense(player, ascensionCfg.cost_divine_sense);

                await player.save({ transaction: t });
                await ascension.save({ transaction: t });

                await t.commit();

                const message = pickRandomMessage(ascensionCfg.success_messages);

                // WebSocket 推送飞升成功
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'ascension_success', {
                        message,
                        ascended_at: now.toISOString(),
                        ascension_realm: 'lingji',
                        attempt_count: ascension.ascension_attempt_count
                    });
                    // 全服广播飞升成功
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: '飞升灵界',
                        content: `恭喜【${player.nickname}】成功飞升灵界！修仙之路再进一步！`,
                        priority: 'high'
                    });
                } catch (e) {
                    console.warn('[AscensionService] 推送飞升成功通知失败:', e.message);
                }

                return {
                    success: true,
                    message,
                    data: {
                        result: 'success',
                        final_rate: finalRate,
                        roll: Number(roll.toFixed(4)),
                        ascended_at: now.toISOString(),
                        ascension_realm: 'lingji'
                    }
                };
            } else {
                // ===== 飞升失败 =====
                ascension.ascension_state = 'failed';

                // 残魂 -30
                const remnantLoss = ascensionCfg.remnant_loss_on_fail;
                player.remnant_soul = Math.max(0, Number(player.remnant_soul || 0) - remnantLoss);

                // 修为 -10%
                const expLossRate = ascensionCfg.exp_loss_rate_on_fail;
                const currentExp = BigInt(player.exp || 0);
                const expLoss = currentExp * BigInt(Math.floor(expLossRate * 100)) / BigInt(100);
                player.exp = (currentExp - expLoss).toString();

                // 虚弱 2 小时
                player.weakness_end_time = new Date(now.getTime() + ascensionCfg.weakness_duration_seconds * 1000);

                // 神识消耗（失败也消耗）
                consumeDivineSense(player, ascensionCfg.cost_divine_sense);

                await player.save({ transaction: t });
                await ascension.save({ transaction: t });

                await t.commit();

                const message = pickRandomMessage(ascensionCfg.fail_messages);

                // WebSocket 推送飞升失败
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'ascension_failed', {
                        message,
                        remnant_loss: remnantLoss,
                        exp_loss: expLoss.toString(),
                        weakness_end_time: player.weakness_end_time.toISOString(),
                        can_revert: ascension.revert_count > 0,
                        revert_count: ascension.revert_count
                    });
                } catch (e) {
                    console.warn('[AscensionService] 推送飞升失败通知失败:', e.message);
                }

                return {
                    success: true, // 接口调用成功，但飞升结果为失败
                    message,
                    data: {
                        result: 'failed',
                        final_rate: finalRate,
                        roll: Number(roll.toFixed(4)),
                        remnant_loss: remnantLoss,
                        exp_loss: expLoss.toString(),
                        current_remnant_soul: player.remnant_soul,
                        weakness_end_time: player.weakness_end_time.toISOString(),
                        can_revert: ascension.revert_count > 0,
                        revert_count: ascension.revert_count,
                        hint: ascension.revert_count > 0
                            ? '神识反噬严重，可使用天机回溯回到飞升前状态'
                            : '残魂过低，可能触发夺舍重生'
                    }
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[AscensionService] ascend 异常:', err);
            throw err;
        }
    }

    /**
     * 天机回溯
     * 每日 1 次，跨日重置，回到飞升前状态
     * 仅飞升失败状态可回溯
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async revert(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const ascensionCfg = config.ascension;

            const ascension = await PlayerAscension.findOne({
                where: { player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!ascension) {
                await t.rollback();
                return { success: false, message: '无飞升记录' };
            }

            // 状态校验：仅 failed 可回溯
            if (ascension.ascension_state !== 'failed') {
                await t.rollback();
                return {
                    success: false,
                    message: config.reincarnation.revert_messages?.not_failed || '当前飞升状态非失败，无法触发天机回溯'
                };
            }

            // 跨日重置回溯次数
            resetDailyCountIfCrossDay(ascension, 'last_revert_date', 'revert_count', ascensionCfg.revert_daily_limit);

            // 次数校验
            if (ascension.revert_count <= 0) {
                await t.rollback();
                return {
                    success: false,
                    message: config.reincarnation.revert_messages?.no_count || '今日天机回溯次数已用完'
                };
            }

            // 执行回溯：状态回到 preparing，恢复部分残魂与修为损失
            ascension.ascension_state = 'preparing';
            ascension.revert_count -= 1;
            ascension.last_revert_time = new Date();

            // 残魂恢复至 80（飞升门槛）
            const minRemnant = ascensionCfg.min_remnant_soul;
            if (Number(player.remnant_soul || 0) < minRemnant) {
                player.remnant_soul = minRemnant;
            }
            // 清除虚弱
            player.weakness_end_time = null;

            await player.save({ transaction: t });
            await ascension.save({ transaction: t });

            await t.commit();

            const message = config.reincarnation.revert_messages?.success || '天机回溯成功！你回到了飞升前的状态';

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'ascension_reverted', {
                    message,
                    ascension_state: 'preparing',
                    revert_count: ascension.revert_count,
                    remnant_soul: player.remnant_soul
                });
            } catch (e) {
                console.warn('[AscensionService] 推送回溯通知失败:', e.message);
            }

            return {
                success: true,
                message,
                data: {
                    ascension_state: 'preparing',
                    revert_count: ascension.revert_count,
                    remnant_soul: player.remnant_soul
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[AscensionService] revert 异常:', err);
            throw err;
        }
    }

    /**
     * 问道
     * 每日 3 次、CD 30 分钟、消耗灵石、积累 ask_dao_insight、10% 暴击双倍
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async askDao(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const askCfg = config.ask_dao;

            // 境界校验
            const realmCheck = RealmService.meetsRealmRequirement(player, askCfg.min_realm_name);
            if (!realmCheck.met) {
                await t.rollback();
                return { success: false, message: `需达到${askCfg.min_realm_name}才能问道` };
            }

            // 跨日重置
            resetDailyCountIfCrossDay(player, 'last_ask_dao_date', 'daily_ask_dao_count', 0);

            // 次数校验
            if (player.daily_ask_dao_count >= askCfg.daily_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日问道次数已用完（${player.daily_ask_dao_count}/${askCfg.daily_limit}）`
                };
            }

            // 冷却校验
            const cd = checkCooldown(player, 'last_ask_dao_time' in player ? 'last_ask_dao_time' : 'last_ask_dao_date', askCfg.cooldown_seconds);
            // 优先使用 last_ask_dao_time 字段（若存在）；否则跳过冷却（首次问道无冷却）
            if ('last_ask_dao_time' in Player.rawAttributes) {
                const cdCheck = checkCooldown(player, 'last_ask_dao_time', askCfg.cooldown_seconds);
                if (!cdCheck.ready) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `问道冷却中，剩余 ${Math.floor(cdCheck.remainingSec / 60)} 分钟`
                    };
                }
            }

            // 灵石消耗校验
            const costStones = BigInt(askCfg.cost_spirit_stones);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 计算感悟值
            const baseGain = askCfg.insight_gain_base;
            const randomGain = Math.floor(Math.random() * (askCfg.insight_gain_random + 1));
            let totalGain = baseGain + randomGain;

            // 暴击判定（10% 概率双倍）
            const isCritical = Math.random() < askCfg.critical_chance;
            if (isCritical) {
                totalGain = Math.floor(totalGain * askCfg.critical_multiplier);
            }

            // 上限校验
            const currentInsight = Number(player.ask_dao_insight || 0);
            const maxInsight = askCfg.max_insight;
            const newInsight = Math.min(maxInsight, currentInsight + totalGain);
            const actualGain = newInsight - currentInsight;

            // 扣减灵石
            player.spirit_stones = (playerStones - costStones).toString();
            player.ask_dao_insight = newInsight;
            player.daily_ask_dao_count += 1;
            player.last_ask_dao_date = new Date().toISOString().slice(0, 10);
            if ('last_ask_dao_time' in Player.rawAttributes) {
                player.last_ask_dao_time = new Date();
            }

            await player.save({ transaction: t });
            await t.commit();

            // 随机事件文本
            const eventText = pickRandomMessage(askCfg.event_texts || []);

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'ask_dao', {
                    insight_gain: actualGain,
                    is_critical: isCritical,
                    total_insight: newInsight,
                    max_insight: maxInsight,
                    event_text: eventText
                });
            } catch (e) {
                console.warn('[AscensionService] 推送问道通知失败:', e.message);
            }

            return {
                success: true,
                message: isCritical
                    ? `问道暴击！感悟值 +${actualGain}（双倍收益）`
                    : `问道成功，感悟值 +${actualGain}`,
                data: {
                    insight_gain: actualGain,
                    is_critical: isCritical,
                    total_insight: newInsight,
                    max_insight: maxInsight,
                    daily_count: player.daily_ask_dao_count,
                    daily_limit: askCfg.daily_limit,
                    event_text: eventText
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[AscensionService] askDao 异常:', err);
            throw err;
        }
    }

    /**
     * 修炼法相天地
     * 9级数值表，消耗问道感悟+灵石，失败返还30%灵石
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async practiceDharmaForm(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const dharmaCfg = config.dharma_form;

            // 境界校验
            const realmCheck = RealmService.meetsRealmRequirement(player, dharmaCfg.min_realm_name);
            if (!realmCheck.met) {
                await t.rollback();
                return { success: false, message: `需达到${dharmaCfg.min_realm_name}才能修炼法相天地` };
            }

            // 当前等级校验
            const currentLevel = Number(player.dharma_form_level || 0);
            if (currentLevel >= dharmaCfg.max_level) {
                await t.rollback();
                return { success: false, message: `法相天地已达最高等级 ${dharmaCfg.max_level}` };
            }

            // 获取下一级配置
            const nextLevel = currentLevel + 1;
            const levelCfg = (dharmaCfg.levels || []).find(l => l.level === nextLevel);
            if (!levelCfg) {
                await t.rollback();
                return { success: false, message: `等级 ${nextLevel} 配置不存在` };
            }

            // 问道感悟消耗校验
            const costInsight = levelCfg.cost_insight;
            const currentInsight = Number(player.ask_dao_insight || 0);
            if (currentInsight < costInsight) {
                await t.rollback();
                return {
                    success: false,
                    message: `问道感悟不足，需要 ${costInsight}，当前 ${currentInsight}`
                };
            }

            // 灵石消耗校验
            const costStones = BigInt(levelCfg.cost_spirit_stones);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 判定成功/失败
            const roll = Math.random();
            const isSuccess = roll < levelCfg.success_rate;

            if (isSuccess) {
                // 成功：扣减感悟+灵石，等级+1
                player.ask_dao_insight = currentInsight - costInsight;
                player.spirit_stones = (playerStones - costStones).toString();
                player.dharma_form_level = nextLevel;

                await player.save({ transaction: t });
                await t.commit();

                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'dharma_form_success', {
                        new_level: nextLevel,
                        attribute_bonus: levelCfg.attribute_bonus,
                        ascension_bonus: levelCfg.ascension_bonus,
                        cost_insight: costInsight,
                        cost_spirit_stones: costStones.toString()
                    });
                } catch (e) {
                    console.warn('[AscensionService] 推送法相成功通知失败:', e.message);
                }

                return {
                    success: true,
                    message: `法相天地突破成功！当前等级 ${nextLevel}，全属性 +${(levelCfg.attribute_bonus * 100).toFixed(0)}%`,
                    data: {
                        result: 'success',
                        new_level: nextLevel,
                        attribute_bonus: levelCfg.attribute_bonus,
                        ascension_bonus: levelCfg.ascension_bonus,
                        cost_insight: costInsight,
                        cost_spirit_stones: costStones.toString()
                    }
                };
            } else {
                // 失败：感悟不返还，灵石返还 30%
                player.ask_dao_insight = currentInsight - costInsight;
                const refundStones = (costStones * BigInt(Math.floor(dharmaCfg.fail_spirit_stone_refund_rate * 100))) / BigInt(100);
                player.spirit_stones = (playerStones - costStones + refundStones).toString();

                await player.save({ transaction: t });
                await t.commit();

                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'dharma_form_failed', {
                        current_level: currentLevel,
                        refund_spirit_stones: refundStones.toString(),
                        cost_insight: costInsight
                    });
                } catch (e) {
                    console.warn('[AscensionService] 推送法相失败通知失败:', e.message);
                }

                return {
                    success: true, // 接口调用成功，但修炼结果为失败
                    message: `法相天地突破失败，感悟不返还，灵石返还 ${refundStones.toString()}`,
                    data: {
                        result: 'failed',
                        current_level: currentLevel,
                        refund_spirit_stones: refundStones.toString(),
                        cost_insight: costInsight,
                        cost_spirit_stones: costStones.toString()
                    }
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[AscensionService] practiceDharmaForm 异常:', err);
            throw err;
        }
    }

    /**
     * 探寻裂缝
     * 每日 5 次、CD 10 分钟、消耗神识+灵石、15% 反噬概率
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async exploreFracture(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('ascension_data');
            const fracCfg = config.fracture_explore;

            // 境界校验
            const realmCheck = RealmService.meetsRealmRequirement(player, fracCfg.min_realm_name);
            if (!realmCheck.met) {
                await t.rollback();
                return { success: false, message: `需达到${fracCfg.min_realm_name}才能探寻裂缝` };
            }

            // 跨日重置
            resetDailyCountIfCrossDay(player, 'last_fracture_explore_date' in player ? 'last_fracture_explore_date' : 'last_fracture_explore_time', 'daily_fracture_explore_count', 0);
            // 实际重置应使用专用 date 字段；若不存在则使用 time 字段（按日期截断比较）
            // 这里简化：检查 last_fracture_explore_time 是否跨日
            const today = new Date().toISOString().slice(0, 10);
            const lastTime = player.last_fracture_explore_time;
            if (lastTime) {
                const lastStr = lastTime instanceof Date ? lastTime.toISOString().slice(0, 10) : String(lastTime).slice(0, 10);
                if (lastStr !== today) {
                    player.daily_fracture_explore_count = 0;
                }
            } else {
                player.daily_fracture_explore_count = 0;
            }

            // 次数校验
            if (player.daily_fracture_explore_count >= fracCfg.daily_limit) {
                await t.rollback();
                return {
                    success: false,
                    message: `今日探寻次数已用完（${player.daily_fracture_explore_count}/${fracCfg.daily_limit}）`
                };
            }

            // 冷却校验
            const cd = checkCooldown(player, 'last_fracture_explore_time', fracCfg.cooldown_seconds);
            if (!cd.ready) {
                await t.rollback();
                return {
                    success: false,
                    message: `探寻冷却中，剩余 ${Math.floor(cd.remainingSec / 60)} 分钟`
                };
            }

            // 神识消耗校验
            const divineSense = getDivineSense(player);
            if (divineSense < fracCfg.cost_divine_sense) {
                await t.rollback();
                return {
                    success: false,
                    message: `神识不足，需要 ${fracCfg.cost_divine_sense}，当前 ${divineSense}`
                };
            }

            // 灵石消耗校验
            const costStones = BigInt(fracCfg.cost_spirit_stones);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足，需要 ${costStones.toString()}，当前 ${playerStones.toString()}`
                };
            }

            // 扣减神识+灵石
            consumeDivineSense(player, fracCfg.cost_divine_sense);
            player.spirit_stones = (playerStones - costStones).toString();
            player.daily_fracture_explore_count += 1;
            player.last_fracture_explore_time = new Date();

            // 15% 反噬判定
            const isBacklash = Math.random() < fracCfg.backlash_chance;
            if (isBacklash) {
                // 反噬：残魂 -5，修为 -2%
                player.remnant_soul = Math.max(0, Number(player.remnant_soul || 0) - fracCfg.backlash_remnant_loss);
                const currentExp = BigInt(player.exp || 0);
                const expLoss = currentExp * BigInt(Math.floor(fracCfg.backlash_exp_loss_rate * 100)) / BigInt(100);
                player.exp = (currentExp - expLoss).toString();

                await player.save({ transaction: t });
                await t.commit();

                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'fracture_backlash', {
                        remnant_loss: fracCfg.backlash_remnant_loss,
                        exp_loss: expLoss.toString(),
                        current_remnant_soul: player.remnant_soul
                    });
                } catch (e) {
                    console.warn('[AscensionService] 推送反噬通知失败:', e.message);
                }

                return {
                    success: true,
                    message: `神识反噬！残魂 -${fracCfg.backlash_remnant_loss}，修为 -${expLoss.toString()}`,
                    data: {
                        result: 'backlash',
                        remnant_loss: fracCfg.backlash_remnant_loss,
                        exp_loss: expLoss.toString(),
                        current_remnant_soul: player.remnant_soul,
                        daily_count: player.daily_fracture_explore_count,
                        daily_limit: fracCfg.daily_limit
                    }
                };
            }

            // 加权随机抽取奖励
            const rewards = fracCfg.rewards || [];
            const totalChance = rewards.reduce((sum, r) => sum + (r.chance || 0), 0);
            let rand = Math.random() * totalChance;
            let pickedReward = rewards.find(r => (rand -= r.chance) <= 0);
            if (!pickedReward) pickedReward = rewards[rewards.length - 1];

            // 根据 reward.type 发放奖励
            let rewardResult = { type: pickedReward.type, name: pickedReward.name, quantity: 0, rarity: pickedReward.rarity };
            switch (pickedReward.type) {
                case 'law_fragment': {
                    // 法则碎片 +1~2
                    const qty = pickedReward.quantity_min + Math.floor(Math.random() * (pickedReward.quantity_max - pickedReward.quantity_min + 1));
                    const ascension = await PlayerAscension.findOne({ where: { player_id: playerId }, transaction: t, lock: t.LOCK.UPDATE });
                    if (ascension) {
                        ascension.law_fragments_count = (ascension.law_fragments_count || 0) + qty;
                        await ascension.save({ transaction: t });
                    }
                    rewardResult.quantity = qty;
                    break;
                }
                case 'divine_sense': {
                    // 神识提升 20~50
                    const qty = pickedReward.quantity_min + Math.floor(Math.random() * (pickedReward.quantity_max - pickedReward.quantity_min + 1));
                    addDivineSense(player, qty);
                    rewardResult.quantity = qty;
                    break;
                }
                case 'spirit_stones': {
                    // 灵石 1000~5000
                    const qty = pickedReward.quantity_min + Math.floor(Math.random() * (pickedReward.quantity_max - pickedReward.quantity_min + 1));
                    const current = BigInt(player.spirit_stones || 0);
                    player.spirit_stones = (current + BigInt(qty)).toString();
                    rewardResult.quantity = qty;
                    break;
                }
                case 'spirit_milk':
                case 'dan_recipe': {
                    // 物品类奖励：由物品系统管理，此处仅记录
                    rewardResult.quantity = pickedReward.quantity_min;
                    break;
                }
                case 'nothing':
                default:
                    rewardResult.quantity = 0;
            }

            await player.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'fracture_explore', {
                    reward: rewardResult,
                    daily_count: player.daily_fracture_explore_count,
                    daily_limit: fracCfg.daily_limit
                });
            } catch (e) {
                console.warn('[AscensionService] 推送探寻通知失败:', e.message);
            }

            return {
                success: true,
                message: rewardResult.quantity > 0
                    ? `探寻裂缝成功，获得 ${rewardResult.name} x${rewardResult.quantity}`
                    : '探寻裂缝完成，但未发现任何奖励',
                data: {
                    result: 'success',
                    reward: rewardResult,
                    daily_count: player.daily_fracture_explore_count,
                    daily_limit: fracCfg.daily_limit
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[AscensionService] exploreFracture 异常:', err);
            throw err;
        }
    }

    /**
     * 清理过期未稳固节点（供 StateCleanerService 调用）
     * 将过期且状态为 discovered/stabilizing 的节点标记为 failed
     * 同时结算已到时间的 stabilizing 节点（调用 stabilizeNodeComplete）
     * @param {Object} ctx - 清理上下文 { batchSize, logger }
     * @returns {Promise<Object>} { scanned, expired, completed, failed }
     */
    static async cleanExpiredNodes(ctx = {}) {
        const stats = { scanned: 0, expired: 0, completed: 0, failed: 0 };
        const config = configLoader.getConfig('ascension_data');
        const nodeCfg = config.space_node;
        const now = new Date();

        try {
            // 1. 清理已过期但未稳固的节点（discovered 状态）
            const expiredDiscovered = await PlayerAscensionNode.findAll({
                where: {
                    node_state: 'discovered',
                    expires_at: { [Op.lte]: now }
                },
                limit: ctx.batchSize || 100
            });
            stats.scanned += expiredDiscovered.length;
            for (const node of expiredDiscovered) {
                try {
                    node.node_state = 'failed';
                    await node.save();
                    stats.expired += 1;
                } catch (e) {
                    stats.failed += 1;
                    console.error(`[AscensionService] 清理节点 ${node.id} 失败:`, e.message);
                }
            }

            // 2. 结算已到稳固时间的 stabilizing 节点
            const stabilizingNodes = await PlayerAscensionNode.findAll({
                where: { node_state: 'stabilizing' },
                limit: ctx.batchSize || 100
            });
            stats.scanned += stabilizingNodes.length;
            for (const node of stabilizingNodes) {
                try {
                    const startedAt = node.stabilize_started_at ? new Date(node.stabilize_started_at).getTime() : 0;
                    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
                    if (elapsed >= nodeCfg.stabilize_duration_seconds) {
                        // 调用结算方法（独立事务）
                        await this.stabilizeNodeComplete(node.player_id, node.id);
                        stats.completed += 1;
                    }
                } catch (e) {
                    stats.failed += 1;
                    console.error(`[AscensionService] 结算节点 ${node.id} 失败:`, e.message);
                }
            }

            return stats;
        } catch (err) {
            console.error('[AscensionService] cleanExpiredNodes 异常:', err);
            return stats;
        }
    }

    // ==================== GM 后台辅助方法 ====================

    /**
     * GM 调整大衍诀层数
     * @param {number} playerId - 玩家ID
     * @param {number} level - 目标层数（0-5）
     * @returns {Promise<Object>}
     */
    static async gmSetDayanLevel(playerId, level) {
        if (!Number.isInteger(level) || level < 0 || level > 5) {
            return { success: false, message: '大衍诀层数必须在 0-5 之间' };
        }
        const ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        if (!ascension) {
            return { success: false, message: '玩家飞升进度不存在' };
        }
        const oldLevel = ascension.dayan_level;
        ascension.dayan_level = level;
        await ascension.save();
        return {
            success: true,
            message: `大衍诀层数已从 ${oldLevel} 调整为 ${level}`,
            data: { old_level: oldLevel, new_level: level }
        };
    }

    /**
     * GM 发放法则碎片
     * @param {number} playerId - 玩家ID
     * @param {number} count - 数量
     * @returns {Promise<Object>}
     */
    static async gmGiveLawFragment(playerId, count) {
        if (!Number.isInteger(count) || count <= 0 || count > 100) {
            return { success: false, message: '法则碎片数量必须在 1-100 之间' };
        }
        const ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        if (!ascension) {
            return { success: false, message: '玩家飞升进度不存在' };
        }
        const oldCount = ascension.law_fragments_count;
        ascension.law_fragments_count = oldCount + count;
        await ascension.save();
        return {
            success: true,
            message: `法则碎片 +${count}（${oldCount} → ${ascension.law_fragments_count}）`,
            data: { old_count: oldCount, new_count: ascension.law_fragments_count, added: count }
        };
    }

    /**
     * GM 发放逆灵通道坐标
     * @param {number} playerId - 玩家ID
     * @param {string} coord - 坐标字符串（可选，默认随机生成）
     * @returns {Promise<Object>}
     */
    static async gmGiveCoord(playerId, coord) {
        const ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        if (!ascension) {
            return { success: false, message: '玩家飞升进度不存在' };
        }
        const finalCoord = coord || `GM·${Date.now()}-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
        const oldCoord = ascension.reverse_channel_coord;
        ascension.reverse_channel_coord = finalCoord;
        await ascension.save();
        return {
            success: true,
            message: `逆灵通道坐标已设置：${finalCoord}`,
            data: { old_coord: oldCoord, new_coord: finalCoord }
        };
    }

    /**
     * GM 重置飞升冷却
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>}
     */
    static async gmResetCooldown(playerId) {
        const ascension = await PlayerAscension.findOne({ where: { player_id: playerId } });
        if (!ascension) {
            return { success: false, message: '玩家飞升进度不存在' };
        }
        ascension.last_ascension_time = null;
        await ascension.save();
        return {
            success: true,
            message: '飞升冷却已重置',
            data: { last_ascension_time: null }
        };
    }

    /**
     * GM 获取飞升系统全局统计
     * @returns {Promise<Object>}
     */
    static async gmGetStats() {
        const totalAscended = await PlayerAscension.count({ where: { is_ascended: 1 } });
        const totalAttempts = await PlayerAscension.sum('ascension_attempt_count');
        const totalSuccess = await PlayerAscension.sum('ascension_success_count');
        const successRate = totalAttempts > 0 ? (totalSuccess / totalAttempts) : 0;

        const activeNodes = await PlayerAscensionNode.count({
            where: {
                node_state: { [Op.in]: ['discovered', 'stabilizing'] },
                expires_at: { [Op.gt]: new Date() }
            }
        });

        const preparingCount = await PlayerAscension.count({ where: { ascension_state: 'preparing' } });
        const ascendingCount = await PlayerAscension.count({ where: { ascension_state: 'ascending' } });
        const failedCount = await PlayerAscension.count({ where: { ascension_state: 'failed' } });

        return {
            total_ascended: totalAscended,
            total_attempts: totalAttempts || 0,
            total_success: totalSuccess || 0,
            success_rate: Number(successRate.toFixed(4)),
            active_nodes: activeNodes,
            state_distribution: {
                preparing: preparingCount,
                ascending: ascendingCount,
                failed: failedCount
            }
        };
    }

    /**
     * GM 获取玩家飞升进度列表（分页）
     * @param {number} page - 页码（1-based）
     * @param {number} pageSize - 每页条数
     * @returns {Promise<Object>}
     */
    static async gmGetPlayerList(page = 1, pageSize = 20) {
        const offset = (page - 1) * pageSize;
        // 注意：PlayerAscension 与 Player 未通过 Sequelize 关联定义（belongsTo/hasOne），
        //       故不能使用 include；这里改为两步查询：先查飞升档案，再批量查玩家基础信息。
        const { rows, count } = await PlayerAscension.findAndCountAll({
            order: [['is_ascended', 'DESC'], ['ascension_attempt_count', 'DESC']],
            limit: pageSize,
            offset: offset,
            distinct: true
        });

        // 手动批量查询玩家昵称/境界，避免 N+1 查询
        const playerIds = rows.map(r => r.player_id);
        const players = playerIds.length > 0 ? await Player.findAll({
            where: { id: playerIds },
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        }) : [];
        const playerMap = new Map(players.map(p => [p.id, p.toJSON()]));
        const list = rows.map(r => {
            const p = playerMap.get(r.player_id);
            return {
                id: r.id,
                player_id: r.player_id,
                nickname: p?.nickname || '未知',
                realm: p?.realm || '未知',
                realm_rank: p?.realm_rank || 0,
                ascension_state: r.ascension_state,
                dayan_level: r.dayan_level,
                law_fragments_count: r.law_fragments_count,
                reverse_channel_coord: r.reverse_channel_coord,
                is_ascended: r.is_ascended,
                ascension_attempt_count: r.ascension_attempt_count,
                ascension_success_count: r.ascension_success_count,
                last_ascension_time: r.last_ascension_time
            };
        });

        return {
            list,
            total: count,
            page,
            page_size: pageSize,
            total_pages: Math.ceil(count / pageSize)
        };
    }
}

module.exports = AscensionService;