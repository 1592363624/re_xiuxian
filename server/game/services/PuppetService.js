/**
 * 傀儡工坊服务
 *
 * 实现玩法文档第23节·大衍诀与傀儡路线的全部业务逻辑：
 *   1. 查看工坊（傀儡列表 + 已学图谱 + 配置信息）
 *   2. 参悟图谱（消耗图谱物品，解锁对应傀儡制造权限）
 *   3. 制造傀儡（5种类型，消耗灵石+材料，需对应图谱+大衍诀层数）
 *   4. 出战/护法设置（出战加成PVP/PVE属性，护法闭关时自动反击）
 *   5. 淬炼升级（消耗灵石+机关核心，提升等级与属性，成功率递减）
 *   6. 维修耐久（消耗灵石+机关核心，恢复耐久度）
 *   7. 回收傀儡（二步确认，返还部分材料+灵石）
 *
 * 大衍诀联动：
 *   - 第三层·控傀（dayan_level≥3）解锁机关木傀/铁甲战傀/五行灵傀
 *   - 第四层·千机（dayan_level≥4）解锁影傀
 *   - 第五层·衍神（dayan_level≥5）解锁大衍灵傀
 *
 * 多人交互设计：
 *   - 出战傀儡：PVP/PVE战斗中提供 battle_stat_ratio（30%）属性加成
 *   - 护法傀儡：闭关被袭击时自动反击，造成 guard_counter_ratio（50%）攻击伤害
 *   - 图谱获取：来自多人副本（虚天殿/昆吾山/苍坤/世界Boss），促进多人协作
 *
 * 数据模型：
 *   - Player: 玩家主表（spirit_stones BIGINT）
 *   - PlayerPuppet: 傀儡表（1:N，每玩家最多 max_puppets 个）
 *   - PlayerPuppetBlueprint: 图谱表（1:N，记录已学图谱）
 *   - PlayerAscension: 飞升表（dayan_level 用于权限校验）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-23
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const PlayerPuppet = require('../../models/playerPuppet');
const PlayerPuppetBlueprint = require('../../models/playerPuppetBlueprint');
const PlayerAscension = require('../../models/playerAscension');
const sequelize = require('../../config/database');
const InventoryService = require('./InventoryService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { Op } = require('sequelize');
const { ErrorCodes } = require('../../middleware/errorHandler');

class PuppetService {
    static _initialized = false;
    static _config = null;

    /**
     * 初始化服务（从 ConfigLoader 读取 puppet_data 配置）
     * @param {Object} configLoaderInstance - ConfigLoader 实例
     */
    static initialize(configLoaderInstance) {
        this._config = configLoaderInstance.getConfig('puppet_data');
        if (!this._config) {
            console.warn('[PuppetService] puppet_data 配置未加载');
            return;
        }
        this._initialized = true;
        console.log('[PuppetService] 傀儡工坊服务初始化完成');
    }

    /**
     * 获取配置（供路由层使用）
     * @returns {Object} 傀儡工坊配置
     */
    static getConfig() {
        return this._config;
    }

    /**
     * 计算傀儡当前属性（base_stats × (1 + (level-1) × growth_rate)）
     * @param {Object} typeCfg - 傀儡类型配置
     * @param {number} level - 当前等级
     * @returns {Object} { atk, def, hp, speed }
     */
    static _calcStats(typeCfg, level) {
        const growth = this._config.quench.stat_growth_rate;
        const multiplier = 1 + (level - 1) * growth.atk; // 各属性增长率相同
        return {
            atk: Math.floor(typeCfg.base_stats.atk * multiplier),
            def: Math.floor(typeCfg.base_stats.def * multiplier),
            hp: Math.floor(typeCfg.base_stats.hp * multiplier),
            speed: Math.floor(typeCfg.base_stats.speed * (1 + (level - 1) * growth.speed))
        };
    }

    /**
     * 获取玩家大衍诀层数
     * @param {number} playerId - 玩家ID
     * @param {Object} [transaction] - 事务
     * @returns {Promise<number>} 大衍诀层数（0-5）
     */
    static async _getDayanLevel(playerId, transaction = null) {
        const ascension = await PlayerAscension.findOne({
            where: { player_id: playerId },
            transaction
        });
        return ascension ? Number(ascension.dayan_level || 0) : 0;
    }

    /**
     * 1. 查看傀儡工坊
     * 返回：玩家所有傀儡 + 已学图谱 + 配置信息 + 大衍诀层数
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getWorkshop(playerId) {
        const player = await Player.findByPk(playerId);
        if (!player) {
            return { success: false, message: '玩家不存在' };
        }

        const dayanLevel = await this._getDayanLevel(playerId);
        const puppets = await PlayerPuppet.findAll({
            where: { player_id: playerId },
            order: [['created_at', 'ASC']]
        });
        const blueprints = await PlayerPuppetBlueprint.findAll({
            where: { player_id: playerId },
            order: [['learned_at', 'ASC']]
        });

        // 组装傀儡列表（附加类型配置信息）
        const puppetList = puppets.map(p => {
            const typeCfg = this._config.puppet_types[p.puppet_type];
            return {
                id: p.id,
                puppet_type: p.puppet_type,
                name: p.name,
                quality: typeCfg ? typeCfg.quality : 'common',
                level: p.level,
                durability: p.durability,
                max_durability: p.max_durability,
                atk: p.atk,
                def: p.def,
                hp: p.hp,
                speed: p.speed,
                status: p.status,
                description: typeCfg ? typeCfg.description : '',
                color: typeCfg ? typeCfg.color : 'stone',
                created_at: p.created_at
            };
        });

        // 组装已学图谱列表
        const blueprintList = blueprints.map(b => ({
            blueprint_key: b.blueprint_key,
            blueprint_name: b.blueprint_name,
            puppet_type: b.puppet_type,
            learned_at: b.learned_at,
            source: this._config.blueprints[b.blueprint_key]?.source || ''
        }));

        // 组装可制造列表（含是否满足条件）
        const manufacturable = Object.entries(this._config.puppet_types).map(([typeKey, typeCfg]) => {
            const hasBlueprint = blueprints.some(b => b.puppet_type === typeKey);
            const dayanMet = dayanLevel >= typeCfg.required_dayan_level;
            return {
                puppet_type: typeKey,
                name: typeCfg.name,
                quality: typeCfg.quality,
                description: typeCfg.description,
                required_dayan_level: typeCfg.required_dayan_level,
                has_blueprint: hasBlueprint,
                dayan_met: dayanMet,
                can_manufacture: hasBlueprint && dayanMet,
                manufacture_cost: typeCfg.manufacture_cost,
                base_stats: typeCfg.base_stats,
                blueprint_source: this._config.blueprints[typeCfg.blueprint_key]?.source || ''
            };
        });

        return {
            success: true,
            data: {
                enabled: this._config.enabled,
                dayan_level: dayanLevel,
                min_dayan_level: this._config.min_dayan_level,
                max_puppets: this._config.max_puppets,
                puppet_count: puppets.length,
                puppets: puppetList,
                blueprints: blueprintList,
                manufacturable: manufacturable,
                battle_stat_ratio: this._config.battle_stat_ratio,
                guard_counter_ratio: this._config.guard_counter_ratio,
                quench_config: {
                    max_level: this._config.quench.max_level,
                    cost_per_level: this._config.quench.cost_per_level
                },
                repair_config: {
                    max_durability: this._config.repair.max_durability,
                    spirit_stone_per_point: this._config.repair.spirit_stone_per_point
                },
                recycle_config: {
                    material_return_rate: this._config.recycle.material_return_rate,
                    spirit_stone_return_rate: this._config.recycle.spirit_stone_return_rate
                }
            }
        };
    }

    /**
     * 2. 参悟图谱（消耗图谱物品，解锁制造权限）
     * @param {number} playerId - 玩家ID
     * @param {string} blueprintKey - 图谱key（如 mechanical_wood_blueprint）
     * @returns {Promise<Object>} { success, message }
     */
    static async learnBlueprint(playerId, blueprintKey) {
        const blueprintCfg = this._config.blueprints[blueprintKey];
        if (!blueprintCfg) {
            return { success: false, message: '图谱不存在', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            // 检查是否已学过
            const existing = await PlayerPuppetBlueprint.findOne({
                where: { player_id: playerId, blueprint_key: blueprintKey },
                transaction: t
            });
            if (existing) {
                await t.rollback();
                return { success: false, message: `已参悟过 ${blueprintCfg.name}，无需重复参悟` };
            }

            // 检查背包是否有图谱物品
            const hasItem = await InventoryService.hasItem(playerId, blueprintKey, 1, t);
            if (!hasItem) {
                await t.rollback();
                return { success: false, message: `背包中没有 ${blueprintCfg.name}，请先获取图谱` };
            }

            // 消耗图谱物品
            await InventoryService.removeItem(playerId, blueprintKey, 1, t);

            // 记录已学图谱
            await PlayerPuppetBlueprint.create({
                player_id: playerId,
                blueprint_key: blueprintKey,
                blueprint_name: blueprintCfg.name,
                puppet_type: blueprintCfg.puppet_type
            }, { transaction: t });

            await t.commit();

            // 事务外推送通知
            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'puppet_blueprint_learned',
                    message: `参悟图谱成功：${blueprintCfg.name}，现可制造 ${this._config.puppet_types[blueprintCfg.puppet_type]?.name || ''}`,
                    data: { blueprint_key: blueprintKey, puppet_type: blueprintCfg.puppet_type }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `参悟图谱成功：${blueprintCfg.name}`,
                data: {
                    blueprint_key: blueprintKey,
                    blueprint_name: blueprintCfg.name,
                    puppet_type: blueprintCfg.puppet_type
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[PuppetService.learnBlueprint] 错误:', err);
            return { success: false, message: '参悟图谱失败：服务器内部错误' };
        }
    }

    /**
     * 3. 制造傀儡
     * 校验：大衍诀层数 + 已学图谱 + 灵石 + 材料 + 傀儡数量上限
     * @param {number} playerId - 玩家ID
     * @param {string} puppetType - 傀儡类型key
     * @returns {Promise<Object>} { success, message, data }
     */
    static async manufacture(playerId, puppetType) {
        const typeCfg = this._config.puppet_types[puppetType];
        if (!typeCfg) {
            return { success: false, message: '傀儡类型不存在', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            // 锁定玩家行
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 大衍诀层数校验
            const dayanLevel = await this._getDayanLevel(playerId, t);
            if (dayanLevel < typeCfg.required_dayan_level) {
                await t.rollback();
                return {
                    success: false,
                    message: `大衍诀层数不足，制造 ${typeCfg.name} 需大衍诀 ${typeCfg.required_dayan_level} 层，当前 ${dayanLevel} 层`
                };
            }

            // 图谱校验
            const hasBlueprint = await PlayerPuppetBlueprint.findOne({
                where: { player_id: playerId, puppet_type: puppetType },
                transaction: t
            });
            if (!hasBlueprint) {
                await t.rollback();
                return { success: false, message: `尚未参悟 ${typeCfg.blueprint_key} 图谱，无法制造 ${typeCfg.name}` };
            }

            // 傀儡数量上限校验
            const puppetCount = await PlayerPuppet.count({
                where: { player_id: playerId },
                transaction: t
            });
            if (puppetCount >= this._config.max_puppets) {
                await t.rollback();
                return { success: false, message: `傀儡数量已达上限（${this._config.max_puppets} 个）` };
            }

            // 灵石消耗校验（BigInt 安全）
            const cost = typeCfg.manufacture_cost;
            const spiritStones = BigInt(player.spirit_stones || 0);
            const costStones = BigInt(cost.spirit_stone);
            if (spiritStones < costStones) {
                await t.rollback();
                return { success: false, message: `灵石不足，需要 ${cost.spirit_stone}，当前 ${spiritStones.toString()}` };
            }

            // 材料消耗校验
            for (const [matKey, matQty] of Object.entries(cost.materials)) {
                const has = await InventoryService.hasItem(playerId, matKey, matQty, t);
                if (!has) {
                    await t.rollback();
                    return { success: false, message: `材料不足：${matKey} 需要 ${matQty}` };
                }
            }

            // 执行消耗：扣灵石
            player.spirit_stones = (spiritStones - costStones).toString();

            // 扣材料
            for (const [matKey, matQty] of Object.entries(cost.materials)) {
                await InventoryService.removeItem(playerId, matKey, matQty, t);
            }

            // 计算初始属性（1级 = base_stats）
            const stats = this._calcStats(typeCfg, 1);

            // 创建傀儡
            const puppet = await PlayerPuppet.create({
                player_id: playerId,
                puppet_type: puppetType,
                name: typeCfg.name,
                level: 1,
                exp: 0,
                durability: this._config.repair.max_durability,
                max_durability: this._config.repair.max_durability,
                atk: stats.atk,
                def: stats.def,
                hp: stats.hp,
                speed: stats.speed,
                status: 'idle'
            }, { transaction: t });

            await player.save({ transaction: t });
            await t.commit();

            // 事务外推送通知
            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'puppet_manufactured',
                    message: `傀儡制造成功：${typeCfg.name}（等级1，ATK ${stats.atk}/DEF ${stats.def}/HP ${stats.hp}/SPD ${stats.speed}）`,
                    data: { puppet_id: puppet.id, puppet_type: puppetType }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `傀儡制造成功：${typeCfg.name}`,
                data: {
                    puppet_id: puppet.id,
                    puppet_type: puppetType,
                    name: typeCfg.name,
                    level: 1,
                    atk: stats.atk,
                    def: stats.def,
                    hp: stats.hp,
                    speed: stats.speed,
                    durability: this._config.repair.max_durability,
                    spirit_stones_after: player.spirit_stones
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[PuppetService.manufacture] 错误:', err);
            return { success: false, message: '制造傀儡失败：服务器内部错误' };
        }
    }

    /**
     * 4. 设置出战傀儡
     * 同一玩家同时只有 1 个出战傀儡，设置新出战时自动取消旧的
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async setBattle(playerId, puppetId) {
        return this._setRole(playerId, puppetId, 'battle');
    }

    /**
     * 5. 设置护法傀儡
     * 同一玩家同时只有 1 个护法傀儡，设置新护法时自动取消旧的
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async setGuard(playerId, puppetId) {
        return this._setRole(playerId, puppetId, 'guard');
    }

    /**
     * 6. 取消出战/护法（设为闲置）
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @returns {Promise<Object>} { success, message }
     */
    static async unsetRole(playerId, puppetId) {
        const t = await sequelize.transaction();
        try {
            const puppet = await PlayerPuppet.findOne({
                where: { id: puppetId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!puppet) {
                await t.rollback();
                return { success: false, message: '傀儡不存在或不属于你' };
            }
            if (puppet.status === 'idle') {
                await t.rollback();
                return { success: false, message: '该傀儡已是闲置状态' };
            }
            const oldStatus = puppet.status;
            puppet.status = 'idle';
            await puppet.save({ transaction: t });
            await t.commit();

            return {
                success: true,
                message: `已取消${oldStatus === 'battle' ? '出战' : '护法'}`,
                data: { puppet_id: puppetId, status: 'idle' }
            };
        } catch (err) {
            await t.rollback();
            console.error('[PuppetService.unsetRole] 错误:', err);
            return { success: false, message: '取消设置失败：服务器内部错误' };
        }
    }

    /**
     * 内部方法：设置出战/护法角色（通用逻辑）
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @param {string} role - 'battle' 或 'guard'
     * @returns {Promise<Object>}
     */
    static async _setRole(playerId, puppetId, role) {
        const t = await sequelize.transaction();
        try {
            const puppet = await PlayerPuppet.findOne({
                where: { id: puppetId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!puppet) {
                await t.rollback();
                return { success: false, message: '傀儡不存在或不属于你' };
            }

            // 耐久度校验：耐久为0不能出战/护法
            if (puppet.durability <= 0) {
                await t.rollback();
                return { success: false, message: '傀儡耐久度为0，请先维修' };
            }

            // 取消该玩家同角色的其他傀儡
            await PlayerPuppet.update(
                { status: 'idle' },
                { where: { player_id: playerId, status: role }, transaction: t }
            );

            // 设置新角色
            puppet.status = role;
            await puppet.save({ transaction: t });
            await t.commit();

            const roleLabel = role === 'battle' ? '出战' : '护法';
            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: role === 'battle' ? 'puppet_battle_set' : 'puppet_guard_set',
                    message: `${puppet.name} 已设置为${roleLabel}傀儡`,
                    data: { puppet_id: puppetId, role }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `${puppet.name} 已设置为${roleLabel}傀儡`,
                data: {
                    puppet_id: puppetId,
                    name: puppet.name,
                    role,
                    atk: puppet.atk,
                    def: puppet.def,
                    hp: puppet.hp,
                    speed: puppet.speed
                }
            };
        } catch (err) {
            await t.rollback();
            console.error(`[PuppetService._setRole:${role}] 错误:`, err);
            return { success: false, message: '设置失败：服务器内部错误' };
        }
    }

    /**
     * 7. 淬炼傀儡（提升等级，增加属性）
     * 消耗：灵石（base + per_level × current_level）+ 机关核心×1
     * 成功率：随等级递减（base - decay × level，下限 min_rate）
     * 失败：材料消耗，等级不变
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async quench(playerId, puppetId) {
        const t = await sequelize.transaction();
        try {
            const puppet = await PlayerPuppet.findOne({
                where: { id: puppetId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!puppet) {
                await t.rollback();
                return { success: false, message: '傀儡不存在或不属于你' };
            }

            // 等级上限校验
            const maxLevel = this._config.quench.max_level;
            if (puppet.level >= maxLevel) {
                await t.rollback();
                return { success: false, message: `傀儡已达最高等级（${maxLevel}级）` };
            }

            // 耐久度校验
            if (puppet.durability <= 0) {
                await t.rollback();
                return { success: false, message: '傀儡耐久度为0，无法淬炼' };
            }

            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 灵石消耗（BigInt 安全）
            const qCfg = this._config.quench;
            const costStones = BigInt(qCfg.cost_per_level.spirit_stone_base + qCfg.cost_per_level.spirit_stone_per_level * puppet.level);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return { success: false, message: `灵石不足，淬炼需要 ${costStones.toString()}，当前 ${playerStones.toString()}` };
            }

            // 机关核心消耗
            const coreKey = 'mechanism_core';
            const coreQty = qCfg.cost_per_level.mechanism_core;
            const hasCore = await InventoryService.hasItem(playerId, coreKey, coreQty, t);
            if (!hasCore) {
                await t.rollback();
                return { success: false, message: `材料不足：机关核心 需要 ${coreQty}` };
            }

            // 成功率判定
            const successRate = Math.max(
                qCfg.min_success_rate,
                qCfg.success_rate_base - qCfg.success_rate_per_level_decay * puppet.level
            );
            const isSuccess = Math.random() < successRate;

            // 执行消耗（无论成功失败都消耗）
            player.spirit_stones = (playerStones - costStones).toString();
            await InventoryService.removeItem(playerId, coreKey, coreQty, t);

            if (isSuccess) {
                // 成功：等级+1，属性提升，耐久-2
                const newLevel = puppet.level + 1;
                const typeCfg = this._config.puppet_types[puppet.puppet_type];
                const newStats = this._calcStats(typeCfg, newLevel);
                puppet.level = newLevel;
                puppet.atk = newStats.atk;
                puppet.def = newStats.def;
                puppet.hp = newStats.hp;
                puppet.speed = newStats.speed;
                puppet.durability = Math.max(0, puppet.durability - qCfg.durability_cost);
            }

            await player.save({ transaction: t });
            await puppet.save({ transaction: t });
            await t.commit();

            // 事务外推送
            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'puppet_quenched',
                    message: isSuccess
                        ? `淬炼成功！${puppet.name} 升至 ${puppet.level} 级`
                        : `淬炼失败，${puppet.name} 等级不变（成功率 ${(successRate * 100).toFixed(0)}%）`,
                    data: { puppet_id: puppetId, success: isSuccess, level: puppet.level }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: isSuccess
                    ? `淬炼成功！${puppet.name} 升至 ${puppet.level} 级`
                    : `淬炼失败，${puppet.name} 等级不变`,
                data: {
                    puppet_id: puppetId,
                    quench_success: isSuccess,
                    success_rate: successRate,
                    level: puppet.level,
                    atk: puppet.atk,
                    def: puppet.def,
                    hp: puppet.hp,
                    speed: puppet.speed,
                    durability: puppet.durability,
                    spirit_stones_after: player.spirit_stones
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[PuppetService.quench] 错误:', err);
            return { success: false, message: '淬炼失败：服务器内部错误' };
        }
    }

    /**
     * 8. 维修傀儡（恢复耐久度）
     * 消耗：灵石（per_point × 缺失耐久）+ 机关核心×1
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async repair(playerId, puppetId) {
        const t = await sequelize.transaction();
        try {
            const puppet = await PlayerPuppet.findOne({
                where: { id: puppetId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!puppet) {
                await t.rollback();
                return { success: false, message: '傀儡不存在或不属于你' };
            }

            const missingDurability = puppet.max_durability - puppet.durability;
            if (missingDurability <= 0) {
                await t.rollback();
                return { success: false, message: '耐久度已满，无需维修' };
            }

            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 灵石消耗
            const rCfg = this._config.repair;
            const costStones = BigInt(rCfg.spirit_stone_per_point * missingDurability);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < costStones) {
                await t.rollback();
                return { success: false, message: `灵石不足，维修需要 ${costStones.toString()}，当前 ${playerStones.toString()}` };
            }

            // 机关核心消耗
            const coreQty = rCfg.mechanism_core_per_repair;
            const hasCore = await InventoryService.hasItem(playerId, 'mechanism_core', coreQty, t);
            if (!hasCore) {
                await t.rollback();
                return { success: false, message: `材料不足：机关核心 需要 ${coreQty}` };
            }

            // 执行维修
            player.spirit_stones = (playerStones - costStones).toString();
            await InventoryService.removeItem(playerId, 'mechanism_core', coreQty, t);
            puppet.durability = puppet.max_durability;

            await player.save({ transaction: t });
            await puppet.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'puppet_repaired',
                    message: `${puppet.name} 维修完成，耐久度恢复至 ${puppet.max_durability}`,
                    data: { puppet_id: puppetId, durability: puppet.durability }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `${puppet.name} 维修完成，耐久度恢复至 ${puppet.max_durability}`,
                data: {
                    puppet_id: puppetId,
                    durability: puppet.durability,
                    max_durability: puppet.max_durability,
                    repaired_points: missingDurability,
                    cost_spirit_stones: costStones.toString(),
                    spirit_stones_after: player.spirit_stones
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[PuppetService.repair] 错误:', err);
            return { success: false, message: '维修失败：服务器内部错误' };
        }
    }

    /**
     * 9. 回收预览（计算返还材料，不实际执行）
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @returns {Promise<Object>} { success, data }
     */
    static async recyclePreview(playerId, puppetId) {
        const puppet = await PlayerPuppet.findOne({
            where: { id: puppetId, player_id: playerId }
        });
        if (!puppet) {
            return { success: false, message: '傀儡不存在或不属于你' };
        }

        if (puppet.status !== 'idle') {
            return { success: false, message: '出战/护法中的傀儡不可回收，请先取消出战/护法' };
        }

        const typeCfg = this._config.puppet_types[puppet.puppet_type];
        if (!typeCfg) {
            return { success: false, message: '傀儡类型配置缺失' };
        }

        const matReturnRate = this._config.recycle.material_return_rate;
        const stoneReturnRate = this._config.recycle.spirit_stone_return_rate;

        // 计算材料返还（制造消耗 × 返还率）
        const materialReturns = {};
        for (const [matKey, matQty] of Object.entries(typeCfg.manufacture_cost.materials)) {
            const returnQty = Math.floor(matQty * matReturnRate);
            if (returnQty > 0) {
                materialReturns[matKey] = returnQty;
            }
        }

        // 计算灵石返还（制造消耗 × 返还率 + 淬炼投入估算）
        const baseStoneReturn = Math.floor(typeCfg.manufacture_cost.spirit_stone * stoneReturnRate);
        // 淬炼投入的灵石估算（base + per_level × avg_level）
        const qCfg = this._config.quench;
        let quenchStoneInvest = 0;
        for (let lvl = 1; lvl < puppet.level; lvl++) {
            quenchStoneInvest += qCfg.cost_per_level.spirit_stone_base + qCfg.cost_per_level.spirit_stone_per_level * lvl;
        }
        const quenchStoneReturn = Math.floor(quenchStoneInvest * stoneReturnRate);
        const totalStoneReturn = baseStoneReturn + quenchStoneReturn;

        return {
            success: true,
            data: {
                puppet_id: puppetId,
                puppet_name: puppet.name,
                puppet_type: puppet.puppet_type,
                level: puppet.level,
                material_returns: materialReturns,
                spirit_stone_return: totalStoneReturn,
                material_return_rate: matReturnRate,
                spirit_stone_return_rate: stoneReturnRate,
                require_confirmation: true
            }
        };
    }

    /**
     * 10. 确认回收（删除傀儡，返还材料+灵石）
     * @param {number} playerId - 玩家ID
     * @param {number} puppetId - 傀儡ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async recycle(playerId, puppetId) {
        const t = await sequelize.transaction();
        try {
            const puppet = await PlayerPuppet.findOne({
                where: { id: puppetId, player_id: playerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!puppet) {
                await t.rollback();
                return { success: false, message: '傀儡不存在或不属于你' };
            }
            if (puppet.status !== 'idle') {
                await t.rollback();
                return { success: false, message: '出战/护法中的傀儡不可回收，请先取消出战/护法' };
            }

            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const typeCfg = this._config.puppet_types[puppet.puppet_type];
            const matReturnRate = this._config.recycle.material_return_rate;
            const stoneReturnRate = this._config.recycle.spirit_stone_return_rate;

            // 计算返还
            const materialReturns = {};
            for (const [matKey, matQty] of Object.entries(typeCfg.manufacture_cost.materials)) {
                const returnQty = Math.floor(matQty * matReturnRate);
                if (returnQty > 0) {
                    materialReturns[matKey] = returnQty;
                    await InventoryService.addItem(playerId, matKey, returnQty, t);
                }
            }

            const baseStoneReturn = Math.floor(typeCfg.manufacture_cost.spirit_stone * stoneReturnRate);
            const qCfg = this._config.quench;
            let quenchStoneInvest = 0;
            for (let lvl = 1; lvl < puppet.level; lvl++) {
                quenchStoneInvest += qCfg.cost_per_level.spirit_stone_base + qCfg.cost_per_level.spirit_stone_per_level * lvl;
            }
            const quenchStoneReturn = Math.floor(quenchStoneInvest * stoneReturnRate);
            const totalStoneReturn = BigInt(baseStoneReturn + quenchStoneReturn);

            // 返还灵石
            player.spirit_stones = (BigInt(player.spirit_stones || 0) + totalStoneReturn).toString();

            // 删除傀儡
            await puppet.destroy({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayer(playerId, {
                    type: 'puppet_recycled',
                    message: `${puppet.name} 已回收，返还灵石 ${totalStoneReturn.toString()}`,
                    data: { puppet_id: puppetId, material_returns: materialReturns, spirit_stone_return: totalStoneReturn.toString() }
                });
            } catch (e) { /* 推送失败不影响主流程 */ }

            return {
                success: true,
                message: `${puppet.name} 已回收`,
                data: {
                    puppet_id: puppetId,
                    material_returns: materialReturns,
                    spirit_stone_return: totalStoneReturn.toString(),
                    spirit_stones_after: player.spirit_stones
                }
            };
        } catch (err) {
            await t.rollback();
            console.error('[PuppetService.recycle] 错误:', err);
            return { success: false, message: '回收失败：服务器内部错误' };
        }
    }

    /**
     * 辅助方法：获取玩家出战傀儡的属性加成（供 CombatService 调用）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object|null>} { atk, def, hp, speed, puppet_name } 或 null
     */
    static async getBattlePuppetBonus(playerId) {
        const puppet = await PlayerPuppet.findOne({
            where: { player_id: playerId, status: 'battle' }
        });
        if (!puppet || puppet.durability <= 0) return null;

        const ratio = this._config.battle_stat_ratio;
        return {
            atk: Math.floor(puppet.atk * ratio),
            def: Math.floor(puppet.def * ratio),
            hp: Math.floor(puppet.hp * ratio),
            speed: Math.floor(puppet.speed * ratio),
            puppet_name: puppet.name,
            puppet_id: puppet.id
        };
    }

    /**
     * 辅助方法：获取玩家护法傀儡的反击伤害（供 SeclusionService/PvpService 调用）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object|null>} { counter_atk, puppet_name, puppet_id } 或 null
     */
    static async getGuardPuppetCounter(playerId) {
        const puppet = await PlayerPuppet.findOne({
            where: { player_id: playerId, status: 'guard' }
        });
        if (!puppet || puppet.durability <= 0) return null;

        const ratio = this._config.guard_counter_ratio;
        return {
            counter_atk: Math.floor(puppet.atk * ratio),
            puppet_name: puppet.name,
            puppet_id: puppet.id
        };
    }
}

module.exports = PuppetService;
