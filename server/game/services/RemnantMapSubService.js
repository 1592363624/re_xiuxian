/**
 * 残图匣子服务（慕兰战线支线 #6）
 *
 * 实现玩法文档第16节"慕兰战线"中"残图匣"完整闭环：
 *   - getStatus(player)  : 查询玩家持有的 4 类残片数量
 *   - combine(player)    : 拼残图（消耗 4 类残片各 1 个 + 灵石，获得 1 张完整残图）
 *   - explore(player)    : 按图探禁（消耗 1 张完整残图，进入苍坤旧禁边缘，2 小时冷却）
 *
 * 设计要点：
 *   - 4 类残片（A/B/C/D）存储于 items 表，item_key 形如 cangkun_remnant_fragment_a
 *   - 完整残图 item_key: cangkun_remnant_map（独立物品）
 *   - 拼图消耗灵石（默认 500），用于经济平衡
 *   - 探禁每日限 1 次（player.border_remnant_explore_date 标记）
 *   - 探禁失败概率 10%，失败扣 HP/灵石
 *   - 探禁成功获得军功+灵石+经验+物品（含神识玉简/黄龙军功牌/苍坤旧料等）
 *
 * 数据库：players.border_remnant_explore_date 字段
 * 配置：border_military_data.json#remnant_map
 */
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const BorderMilitaryService = require('./BorderMilitaryService');
const game = require('../index');
const sequelize = require('../../config/database');

// 单例状态
let _initialized = false;
let _config = null;

class RemnantMapSubService {
    /**
     * 初始化子服务
     */
    initialize() {
        if (_initialized) return;
        try {
            _config = configLoader.getConfig('border_military_data');
        } catch (e) {
            console.warn('[RemnantMapSubService] 配置 border_military_data 未加载:', e.message);
            return;
        }
        if (!_config) return;
        _initialized = true;
        console.log('[RemnantMapSubService] 残图匣子服务初始化完成');
    }

    /**
     * 获取配置（懒加载兜底）
     */
    _getConfig() {
        if (!_initialized || !_config) {
            try {
                _config = configLoader.getConfig('border_military_data');
                _initialized = !!_config;
            } catch (e) {
                return null;
            }
        }
        return _config;
    }

    /**
     * 工具：今日日期字符串
     */
    _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /**
     * 工具：随机整数 [min, max]
     */
    _randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    /**
     * 工具：按 drop_rate 概率掉落物品
     */
    _rollDrops(dropsConfig) {
        if (!dropsConfig || !Array.isArray(dropsConfig)) return [];
        const dropped = [];
        for (const drop of dropsConfig) {
            if (Math.random() < drop.drop_rate) {
                const qty = this._randomInt(drop.quantity_range[0], drop.quantity_range[1]);
                dropped.push({ key: drop.key, quantity: qty });
            }
        }
        return dropped;
    }

    /**
     * 查询玩家残图匣状态
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} 残图匣状态
     */
    static async getStatus(player) {
        const self = RemnantMapSubService._instance;
        const config = self._getConfig();
        if (!config) return { success: false, message: '配置未加载' };

        // 查询 4 类残片持有数量
        const InventoryService = game.InventoryService;
        const fragmentTypes = config.remnant_map?.fragment_types || ['A', 'B', 'C', 'D'];
        const fragmentNames = config.remnant_map?.fragment_names || {};
        const fragments = {};
        for (const type of fragmentTypes) {
            const itemKey = `cangkun_remnant_fragment_${type.toLowerCase()}`;
            const qty = await InventoryService.getItemQuantity(player.id, itemKey);
            fragments[type] = {
                item_key: itemKey,
                name: fragmentNames[type] || `苍坤残片·${type}`,
                quantity: qty
            };
        }

        // 查询完整残图数量
        const mapQty = await InventoryService.getItemQuantity(player.id, 'cangkun_remnant_map');

        // 检查今日是否已探禁
        const today = self._todayStr();
        const exploredToday = player.border_remnant_explore_date === today;

        // 计算是否可拼图（4 类残片各 >= 1）
        const canCombine = fragmentTypes.every(t => fragments[t].quantity >= 1);
        const combineCost = config.remnant_map?.combine_cost_spirit_stones || 500;
        const canCombineWithCost = canCombine && (parseInt(player.spirit_stones?.toString() || '0') >= combineCost);

        // 是否可探禁（有完整残图 + 今日未探禁）
        const canExplore = mapQty >= 1 && !exploredToday;

        return {
            success: true,
            data: {
                fragments,
                complete_maps: mapQty,
                combine_cost_spirit_stones: combineCost,
                can_combine: canCombineWithCost,
                can_combine_missing: canCombine ? null : fragmentTypes.filter(t => fragments[t].quantity < 1),
                can_explore: canExplore,
                explore_block_reason: exploredToday ? '今日已探禁' : (mapQty < 1 ? '无完整残图' : null),
                today_explored: exploredToday
            }
        };
    }

    /**
     * 拼残图（消耗 4 类残片各 1 个 + 灵石，获得 1 张完整残图）
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} 拼图结果
     */
    static async combine(player) {
        const self = RemnantMapSubService._instance;
        const config = self._getConfig();
        if (!config) throw new Error('配置未加载');

        // 境界检查
        const realmCheck = BorderMilitaryService._checkRealm(player);
        if (!realmCheck.met) {
            return { success: false, message: `境界不足：${realmCheck.reason}` };
        }

        // 死亡校验
        if (player.is_dead) {
            return { success: false, message: '玩家已死亡，无法操作' };
        }

        const fragmentTypes = config.remnant_map?.fragment_types || ['A', 'B', 'C', 'D'];
        const combineCost = config.remnant_map?.combine_cost_spirit_stones || 500;
        const InventoryService = game.InventoryService;

        // 事务：扣残片+扣灵石+加完整残图
        const t = await sequelize.transaction();
        try {
            const freshPlayer = await Player.findByPk(player.id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!freshPlayer) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 灵石校验
            const currentStones = BigInt(freshPlayer.spirit_stones?.toString() || '0');
            if (currentStones < BigInt(combineCost)) {
                await t.rollback();
                return {
                    success: false,
                    message: `灵石不足：需要 ${combineCost}，当前 ${currentStones.toString()}`
                };
            }

            // 检查 4 类残片是否各拥有 1 个
            for (const type of fragmentTypes) {
                const itemKey = `cangkun_remnant_fragment_${type.toLowerCase()}`;
                const has = await InventoryService.hasItem(freshPlayer.id, itemKey, 1, t);
                if (!has) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `残片不足：缺少 ${config.remnant_map?.fragment_names?.[type] || '苍坤残片·' + type}`
                    };
                }
            }

            // 扣除 4 类残片
            for (const type of fragmentTypes) {
                const itemKey = `cangkun_remnant_fragment_${type.toLowerCase()}`;
                await InventoryService.removeItem(freshPlayer.id, itemKey, 1, t);
            }

            // 扣除灵石
            freshPlayer.spirit_stones = currentStones - BigInt(combineCost);
            await freshPlayer.save({ transaction: t });

            // 增加完整残图
            await InventoryService.addItem(freshPlayer.id, 'cangkun_remnant_map', 1, t);

            await t.commit();

            return {
                success: true,
                message: `拼图成功！消耗 4 类残片各 1 个 + ${combineCost} 灵石，获得【苍坤残图】×1`,
                data: {
                    complete_maps: await InventoryService.getItemQuantity(player.id, 'cangkun_remnant_map'),
                    spirit_stones_cost: combineCost,
                    spirit_stones_remaining: freshPlayer.spirit_stones?.toString()
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[RemnantMapSubService] combine 异常:', err);
            return { success: false, message: `拼图失败：${err.message}` };
        }
    }

    /**
     * 按图探禁（消耗 1 张完整残图，进入苍坤旧禁边缘）
     * 每日限 1 次，2 小时冷却（实际为每日重置，与玩法文档一致）
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} 探禁结果
     */
    static async explore(player) {
        const self = RemnantMapSubService._instance;
        const config = self._getConfig();
        if (!config) throw new Error('配置未加载');

        // 境界检查
        const realmCheck = BorderMilitaryService._checkRealm(player);
        if (!realmCheck.met) {
            return { success: false, message: `境界不足：${realmCheck.reason}` };
        }

        // 死亡校验
        if (player.is_dead) {
            return { success: false, message: '玩家已死亡，无法探禁' };
        }

        // 每日次数校验
        const today = self._todayStr();
        if (player.border_remnant_explore_date === today) {
            return { success: false, message: '今日已探禁，明日再来' };
        }

        // 探禁配置
        const exploreConfig = config.remnant_map?.explore;
        if (!exploreConfig) {
            return { success: false, message: '探禁配置缺失' };
        }

        const InventoryService = game.InventoryService;

        // 事务：扣残图+标记今日探禁+发放奖励
        const t = await sequelize.transaction();
        try {
            const freshPlayer = await Player.findByPk(player.id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!freshPlayer) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 并发双重校验
            if (freshPlayer.border_remnant_explore_date === today) {
                await t.rollback();
                return { success: false, message: '今日已探禁（并发拦截）' };
            }

            // 校验完整残图
            const hasMap = await InventoryService.hasItem(freshPlayer.id, 'cangkun_remnant_map', 1, t);
            if (!hasMap) {
                await t.rollback();
                return { success: false, message: '无完整残图，无法探禁' };
            }

            // 扣除完整残图
            await InventoryService.removeItem(freshPlayer.id, 'cangkun_remnant_map', 1, t);

            // 判断探禁是否失败
            const failureRate = exploreConfig.failure_rate || 0;
            const isFailed = Math.random() < failureRate;

            if (isFailed) {
                // 失败：扣 HP/灵石
                const penalty = exploreConfig.failure_penalty || {};
                const spiritLoss = penalty.spirit_stones || 0;
                const hpLossRate = penalty.hp_loss_rate || 0;
                const currentHp = BigInt(freshPlayer.hp_current?.toString() || '0');
                const hpLoss = BigInt(Math.floor(Number(currentHp) * hpLossRate));

                freshPlayer.spirit_stones = BigInt(freshPlayer.spirit_stones?.toString() || '0') - BigInt(spiritLoss);
                freshPlayer.hp_current = currentHp > hpLoss ? currentHp - hpLoss : BigInt(0);
                freshPlayer.border_remnant_explore_date = today;
                await freshPlayer.save({ transaction: t });

                await t.commit();

                return {
                    success: false,
                    failed: true,
                    message: `探禁失败！触发苍坤旧禁反噬，损失 ${spiritLoss} 灵石、${hpLoss} HP`,
                    data: {
                        failed: true,
                        spirit_stones_loss: spiritLoss,
                        hp_loss: hpLoss.toString()
                    }
                };
            }

            // 成功：计算奖励
            const meritRange = exploreConfig.merit_range || [3, 8];
            const meritGained = self._randomInt(meritRange[0], meritRange[1]);
            const expRange = exploreConfig.exp_range || [100, 500];
            const expGained = self._randomInt(expRange[0], expRange[1]);
            const stoneRange = exploreConfig.spirit_stone_range || [200, 800];
            const stonesGained = self._randomInt(stoneRange[0], stoneRange[1]);
            const drops = self._rollDrops(exploreConfig.item_drops);

            // 更新玩家
            freshPlayer.border_military_merit_total = (freshPlayer.border_military_merit_total || 0) + meritGained;
            freshPlayer.border_military_merit_available = (freshPlayer.border_military_merit_available || 0) + meritGained;
            freshPlayer.spirit_stones = BigInt(freshPlayer.spirit_stones?.toString() || '0') + BigInt(stonesGained);
            freshPlayer.exp = BigInt(freshPlayer.exp?.toString() || '0') + BigInt(expGained);
            freshPlayer.border_remnant_explore_date = today;
            await freshPlayer.save({ transaction: t });

            // 发放物品
            if (drops.length > 0) {
                try {
                    for (const drop of drops) {
                        await InventoryService.addItem(freshPlayer.id, drop.key, drop.quantity, t);
                    }
                } catch (e) {
                    console.warn('[RemnantMapSubService] 物品发放失败（不影响主线）:', e.message);
                }
            }

            await t.commit();

            // 检查里程碑
            const milestoneResult = await BorderMilitaryService._checkMilestones(freshPlayer);

            return {
                success: true,
                message: `探禁成功！获得军功 ${meritGained}、灵石 ${stonesGained}、修为 ${expGained}${drops.length > 0 ? `、物品 ${drops.map(d => d.key + '×' + d.quantity).join(', ')}` : ''}${milestoneResult.triggered ? `；里程碑达成：${milestoneResult.title}` : ''}`,
                data: {
                    merit_gained: meritGained,
                    spirit_stones_gained: stonesGained,
                    exp_gained: expGained,
                    items_dropped: drops,
                    new_rank: BorderMilitaryService.getMilitaryRank(freshPlayer),
                    milestone: milestoneResult
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[RemnantMapSubService] explore 异常:', err);
            return { success: false, message: `探禁失败：${err.message}` };
        }
    }
}

// 创建单例并暴露
RemnantMapSubService._instance = new RemnantMapSubService();
RemnantMapSubService._instance.initialize();

module.exports = RemnantMapSubService;
