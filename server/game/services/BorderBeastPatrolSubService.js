/**
 * 灵兽边境巡边子服务（慕兰战线支线 #5）
 *
 * 实现玩法文档第16节"慕兰战线"中"灵兽边境"完整闭环：
 *   - patrol(player, beastId, route)  : 派出灵兽巡边（斥候/护粮/袭营）
 *   - returnFromPatrol(player, patrolId) : 巡边归来结算
 *
 * 设计要点：
 *   - 每日每玩家仅可派出 1 次（player.border_beast_patrol_date 标记）
 *   - 巡边时长 1 小时（settings.patrol_duration_seconds），到期才可结算
 *   - 袭营路线有 failure_rate，失败扣 HP/灵石，无奖励
 *   - 灵兽获得经验（beast_exp）会反馈到 spirit_beasts.exp
 *   - 玩家获得军功（border_military_merit_total/available）+灵石+经验+物品
 *   - 调用 _checkMilestones 检查里程碑奖励
 *
 * 数据库：border_beast_patrols 表
 * 配置：border_military_data.json#beast_patrol
 */
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const SpiritBeast = require('../../models/spiritBeast');
const BorderBeastPatrol = require('../../models/border_beast_patrol');
const BorderMilitaryService = require('./BorderMilitaryService');
const game = require('../index');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');

// 单例状态
let _initialized = false;
let _config = null;

class BorderBeastPatrolSubService {
    /**
     * 初始化子服务：加载配置
     */
    initialize() {
        if (_initialized) return;
        try {
            _config = configLoader.getConfig('border_military_data');
        } catch (e) {
            console.warn('[BorderBeastPatrolSubService] 配置 border_military_data 未加载:', e.message);
            return;
        }
        if (!_config) return;
        _initialized = true;
        console.log('[BorderBeastPatrolSubService] 灵兽边境子服务初始化完成');
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
     * 工具：今日日期字符串 YYYY-MM-DD
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
     * 路线键转中文名
     */
    _routeName(routeKey) {
        const names = { scout: '斥候', grain_guard: '护粮', camp_raid: '袭营' };
        return names[routeKey] || routeKey;
    }

    /**
     * 派出灵兽参与巡边
     * @param {Object} player - 玩家对象
     * @param {number} beastId - 灵兽实例ID
     * @param {string} route - 路线：scout/grain_guard/camp_raid
     * @returns {Promise<Object>} 派出结果
     */
    static async patrol(player, beastId, route) {
        const self = BorderBeastPatrolSubService._instance;
        const config = self._getConfig();
        if (!config) throw new Error('慕兰战线配置未加载');

        // 境界检查（复用主服务的境界校验）
        const realmCheck = BorderMilitaryService._checkRealm(player);
        if (!realmCheck.met) {
            return { success: false, message: `境界不足：${realmCheck.reason}` };
        }

        // 死亡校验
        if (player.is_dead) {
            return { success: false, message: '玩家已死亡，无法参与战线' };
        }

        // 路线校验
        const routeConfig = config.beast_patrol?.routes?.[route];
        if (!routeConfig) {
            return {
                success: false,
                message: `无效路线：${route}（可选：scout/grain_guard/camp_raid）`
            };
        }

        // 每日次数校验（player 维度，每条灵兽每日仅一只可派出）
        const today = self._todayStr();
        if (player.border_beast_patrol_date === today) {
            return { success: false, message: '今日已派出灵兽巡边，明日再来' };
        }

        // 灵兽归属与状态校验
        const beast = await SpiritBeast.findOne({
            where: { id: beastId, player_id: player.id }
        });
        if (!beast) {
            return { success: false, message: '灵兽不存在或不属于您' };
        }

        // 灵兽等级/忠诚度校验
        const minLevel = config.beast_patrol?.min_beast_level || 1;
        const minLoyalty = config.beast_patrol?.min_beast_loyalty || 30;
        if (beast.level < minLevel) {
            return { success: false, message: `灵兽等级不足：需要 ${minLevel} 级，当前 ${beast.level} 级` };
        }
        if (beast.loyalty < minLoyalty) {
            return { success: false, message: `灵兽忠诚度过低：需要 ${minLoyalty}，当前 ${beast.loyalty}` };
        }

        // 检查是否已有未结算的巡边记录
        const existing = await BorderBeastPatrol.findOne({
            where: {
                player_id: player.id,
                beast_id: beastId,
                settled: false
            }
        });
        if (existing) {
            return {
                success: false,
                message: `该灵兽已在巡边中（路线：${self._routeName(existing.patrol_route)}），请先结算`
            };
        }

        // 事务：创建派出记录 + 标记玩家今日已派
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
            if (freshPlayer.border_beast_patrol_date === today) {
                await t.rollback();
                return { success: false, message: '今日已派出灵兽巡边（并发拦截）' };
            }

            // 计算预计归来时间
            const durationSec = routeConfig.duration_seconds || 3600;
            const startTime = new Date();
            const endTime = new Date(startTime.getTime() + durationSec * 1000);

            // 创建巡边记录
            const patrolRecord = await BorderBeastPatrol.create({
                player_id: freshPlayer.id,
                beast_id: beastId,
                patrol_route: route,
                start_time: startTime,
                end_time: endTime,
                settled: false,
                merit_gained: 0,
                spirit_stones_gained: 0,
                exp_gained: 0,
                beast_exp_gained: 0,
                items_dropped: null,
                failed: false,
                failure_penalty: null
            }, { transaction: t });

            // 标记玩家今日已派
            freshPlayer.border_beast_patrol_date = today;
            await freshPlayer.save({ transaction: t });

            await t.commit();

            return {
                success: true,
                message: `灵兽已派出巡边（路线：${self._routeName(route)}），预计 ${self._formatDuration(durationSec)} 后归来，使用 .巡边归来 <编号> 结算`,
                data: {
                    patrol_id: patrolRecord.id,
                    beast_id: beastId,
                    beast_name: beast.beast_name || beast.beast_key,
                    route,
                    route_name: self._routeName(route),
                    start_time: startTime,
                    end_time: endTime,
                    duration_seconds: durationSec
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[BorderBeastPatrolSubService] patrol 异常:', err);
            return { success: false, message: `派出失败：${err.message}` };
        }
    }

    /**
     * 巡边归来结算
     * @param {Object} player - 玩家对象
     * @param {number} patrolId - 巡边记录ID
     * @returns {Promise<Object>} 结算结果
     */
    static async returnFromPatrol(player, patrolId) {
        const self = BorderBeastPatrolSubService._instance;
        const config = self._getConfig();
        if (!config) throw new Error('慕兰战线配置未加载');

        const patrol = await BorderBeastPatrol.findByPk(patrolId);
        if (!patrol) {
            return { success: false, message: '巡边记录不存在' };
        }
        if (patrol.player_id !== player.id) {
            return { success: false, message: '无权结算他人巡边' };
        }
        if (patrol.settled) {
            return { success: false, message: '此巡边已结算过', data: { patrol_id: patrolId, settled: true } };
        }

        // 时间校验：必须到达 end_time 后才可结算
        const now = new Date();
        if (now < patrol.end_time) {
            const remainSec = Math.ceil((patrol.end_time - now) / 1000);
            return {
                success: false,
                message: `巡边尚未结束，还需 ${self._formatDuration(remainSec)} 后归来`
            };
        }

        // 获取路线配置
        const routeConfig = config.beast_patrol?.routes?.[patrol.patrol_route];
        if (!routeConfig) {
            return { success: false, message: `路线配置缺失：${patrol.patrol_route}` };
        }

        // 事务：结算奖励 + 更新玩家 + 更新灵兽
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

            const freshBeast = await SpiritBeast.findByPk(patrol.beast_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!freshBeast) {
                await t.rollback();
                return { success: false, message: '灵兽不存在' };
            }

            // 袭营路线有失败概率
            const failureRate = routeConfig.failure_rate || 0;
            const isFailed = Math.random() < failureRate;

            if (isFailed) {
                // 失败：扣 HP/灵石
                const penalty = routeConfig.failure_penalty || {};
                const spiritLoss = penalty.spirit_stones || 0;
                const hpLossRate = penalty.hp_loss_rate || 0;
                const currentHp = BigInt(freshPlayer.hp_current?.toString() || '0');
                const hpLoss = BigInt(Math.floor(Number(currentHp) * hpLossRate));

                freshPlayer.spirit_stones = BigInt(freshPlayer.spirit_stones?.toString() || '0') - BigInt(spiritLoss);
                freshPlayer.hp_current = currentHp > hpLoss ? currentHp - hpLoss : BigInt(0);

                patrol.settled = true;
                patrol.settled_at = new Date();
                patrol.failed = true;
                patrol.failure_penalty = JSON.stringify({
                    spirit_stones: spiritLoss,
                    hp_loss: hpLoss.toString()
                });
                await patrol.save({ transaction: t });
                await freshPlayer.save({ transaction: t });

                await t.commit();

                return {
                    success: false,
                    failed: true,
                    message: `灵兽巡边${self._routeName(patrol.patrol_route)}失败！损失 ${spiritLoss} 灵石、${hpLoss} HP`,
                    data: {
                        patrol_id: patrol.id,
                        route: patrol.patrol_route,
                        route_name: self._routeName(patrol.patrol_route),
                        failed: true,
                        spirit_stones_loss: spiritLoss,
                        hp_loss: hpLoss.toString()
                    }
                };
            }

            // 成功：计算奖励
            const meritRange = routeConfig.merit_range || [1, 1];
            const meritGained = self._randomInt(meritRange[0], meritRange[1]);
            const stoneRange = routeConfig.spirit_stone_range || [0, 0];
            const stonesGained = self._randomInt(stoneRange[0], stoneRange[1]);
            const beastExpGained = routeConfig.beast_exp || 0;
            const playerExpGained = self._randomInt(
                (config.remnant_map?.explore?.exp_range || [50, 100])[0],
                (config.remnant_map?.explore?.exp_range || [50, 100])[1]
            );
            // 注：灵兽巡边玩家经验较低（约为探禁的 1/5）
            const playerExp = Math.floor(playerExpGained / 5);
            const drops = self._rollDrops(routeConfig.item_drops);

            // 更新玩家
            freshPlayer.border_military_merit_total = (freshPlayer.border_military_merit_total || 0) + meritGained;
            freshPlayer.border_military_merit_available = (freshPlayer.border_military_merit_available || 0) + meritGained;
            freshPlayer.spirit_stones = BigInt(freshPlayer.spirit_stones?.toString() || '0') + BigInt(stonesGained);

            // 更新灵兽经验
            const beastExp = BigInt(freshBeast.exp?.toString() || '0') + BigInt(beastExpGained);
            freshBeast.exp = beastExp;

            await freshPlayer.save({ transaction: t });
            await freshBeast.save({ transaction: t });

            // 发放玩家经验（事务外或事务内皆可，ExperienceService 内部读 player）
            if (playerExp > 0) {
                try {
                    // 注意：ExperienceService.addExp 不接 transaction 参数，使用事务内的 freshPlayer 直接修改
                    const expGain = BigInt(playerExp);
                    freshPlayer.exp = BigInt(freshPlayer.exp?.toString() || '0') + expGain;
                    await freshPlayer.save({ transaction: t });
                } catch (e) {
                    console.warn('[BorderBeastPatrolSubService] 玩家经验发放失败（不影响主线）:', e.message);
                }
            }

            // 发放物品
            if (drops.length > 0) {
                try {
                    const InventoryService = game.InventoryService;
                    for (const drop of drops) {
                        await InventoryService.addItem(freshPlayer.id, drop.key, drop.quantity, t);
                    }
                } catch (e) {
                    console.warn('[BorderBeastPatrolSubService] 物品发放失败（不影响主线）:', e.message);
                }
            }

            // 更新巡边记录
            patrol.settled = true;
            patrol.settled_at = new Date();
            patrol.merit_gained = meritGained;
            patrol.spirit_stones_gained = stonesGained;
            patrol.exp_gained = playerExp;
            patrol.beast_exp_gained = beastExpGained;
            patrol.items_dropped = drops.length > 0 ? JSON.stringify(drops) : null;
            patrol.failed = false;
            await patrol.save({ transaction: t });

            await t.commit();

            // 检查里程碑奖励
            const milestoneResult = await BorderMilitaryService._checkMilestones(freshPlayer);

            return {
                success: true,
                message: `灵兽巡边${self._routeName(patrol.patrol_route)}归来！获得军功 ${meritGained}、灵石 ${stonesGained}、玩家修为 ${playerExp}、灵兽经验 ${beastExpGained}${drops.length > 0 ? `、物品 ${drops.map(d => d.key + '×' + d.quantity).join(', ')}` : ''}${milestoneResult.triggered ? `；里程碑达成：${milestoneResult.title}` : ''}`,
                data: {
                    patrol_id: patrol.id,
                    route: patrol.patrol_route,
                    route_name: self._routeName(patrol.patrol_route),
                    merit_gained: meritGained,
                    spirit_stones_gained: stonesGained,
                    player_exp_gained: playerExp,
                    beast_exp_gained: beastExpGained,
                    items_dropped: drops,
                    new_rank: BorderMilitaryService.getMilitaryRank(freshPlayer),
                    milestone: milestoneResult
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[BorderBeastPatrolSubService] returnFromPatrol 异常:', err);
            return { success: false, message: `结算失败：${err.message}` };
        }
    }

    /**
     * 工具：将秒数格式化为人类可读时长
     * @param {number} seconds - 秒数
     * @returns {string} 例如 "1小时5分钟"
     */
    _formatDuration(seconds) {
        if (seconds < 60) return `${seconds}秒`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}分钟`;
        const hours = Math.floor(minutes / 60);
        const remainMin = minutes % 60;
        return remainMin > 0 ? `${hours}小时${remainMin}分钟` : `${hours}小时`;
    }

    /**
     * 查询玩家当前未结算的巡边记录
     * @param {Object} player - 玩家对象
     * @returns {Promise<Object>} 巡边状态
     */
    static async getStatus(player) {
        const config = BorderBeastPatrolSubService._instance._getConfig();
        if (!config) return { success: false, message: '配置未加载' };

        const today = BorderBeastPatrolSubService._instance._todayStr();
        const patrols = await BorderBeastPatrol.findAll({
            where: {
                player_id: player.id,
                settled: false
            },
            order: [['start_time', 'DESC']]
        });

        // 同时查最近10条已结算的
        const recent = await BorderBeastPatrol.findAll({
            where: {
                player_id: player.id,
                settled: true
            },
            order: [['settled_at', 'DESC']],
            limit: 10
        });

        return {
            success: true,
            data: {
                today_done: player.border_beast_patrol_date === today,
                active_patrols: patrols.map(p => ({
                    id: p.id,
                    beast_id: p.beast_id,
                    route: p.patrol_route,
                    route_name: BorderBeastPatrolSubService._instance._routeName(p.patrol_route),
                    start_time: p.start_time,
                    end_time: p.end_time,
                    can_settle: new Date() >= p.end_time
                })),
                recent_patrols: recent.map(p => ({
                    id: p.id,
                    beast_id: p.beast_id,
                    route: p.patrol_route,
                    route_name: BorderBeastPatrolSubService._instance._routeName(p.patrol_route),
                    settled_at: p.settled_at,
                    merit_gained: p.merit_gained,
                    spirit_stones_gained: p.spirit_stones_gained?.toString(),
                    beast_exp_gained: p.beast_exp_gained,
                    failed: p.failed
                }))
            }
        };
    }
}

// 创建单例并暴露
BorderBeastPatrolSubService._instance = new BorderBeastPatrolSubService();
// 暴露实例方法到类静态方法（便于 require 后直接 .patrol/.returnFromPatrol/.getStatus）
// 注意：static 方法已直接定义在类上，这里仅初始化单例用于内部 self 引用
BorderBeastPatrolSubService._instance.initialize();

module.exports = BorderBeastPatrolSubService;
