/**
 * 慕兰战线核心服务
 *
 * 实现玩法文档第16节"世界事件与大型公共战斗"中的慕兰烽烟完整闭环：
 *   1. 慕兰军议 - 每日战局 + 密令/险棋/粮道 3 个关键提示
 *   2. 支援慕兰 - 4 种路线（斥候/破灯/护阵/奇袭），各有不同收益和风险
 *   3. 慕兰谍影 - 搜集军报 + 辨报 + 公开军报（真假情报小游戏）
 *   4. 军功司 - 军衔晋升 + 里程碑奖励 + 物品兑换
 *   5. 灵兽边境 - 派灵兽巡边（斥候/护粮/袭营）
 *   6. 残图匣 - 4 类残片合成完整残图 + 按图探禁
 *   7. 临战刻印 - 给法宝施加一次性刻印
 *
 * 核心设计：
 *   - 累计军功（merit_total）与可用军功（merit_available）分离
 *     累计军功只增不减，决定军衔；可用军功可兑换消耗
 *   - 每日行动标记用 DATE 字段，跨日自动重置，无需后台任务
 *   - 军议每日随机生成 3 个特殊路线（密令/险棋/粮道），支援时根据匹配情况加成
 *   - 军报真假概率 50%，辨报成功率 = 50% + 军衔加成 - 混淆度
 *   - 里程碑奖励通过 UNIQUE KEY (player_id, milestone_merit) 保证幂等
 *   - 临战刻印24小时过期，支援时自动检查匹配并触发
 *
 * 配置：server/config/border_military_data.json
 * 数据库：migration_0041_border_military_tables.js
 */
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const BorderIntelReport = require('../../models/border_intel_report');
const BorderBeastPatrol = require('../../models/border_beast_patrol');
const BorderMilestoneReward = require('../../models/border_milestone_reward');
const BorderWarImprint = require('../../models/border_war_imprint');
const BorderSupportLog = require('../../models/border_support_log');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');
const game = require('../index');

// 单例状态
let _initialized = false;
let _config = null;

// 每日军议缓存（每日0点重置）：{ date: 'YYYY-MM-DD', secret_order: 'scout', risky_route: 'raid', grain_route: 'array_guard' }
let _dailyBriefingCache = null;

class BorderMilitaryService {
    /**
     * 初始化服务：加载配置
     */
    initialize(configLoaderInstance) {
        if (_initialized) return;
        try {
            _config = configLoaderInstance.getConfig('border_military_data');
        } catch (e) {
            console.warn('[BorderMilitaryService] 配置 border_military_data 未加载，服务不可用:', e.message);
            return;
        }
        if (!_config) {
            console.warn('[BorderMilitaryService] 配置 border_military_data 为空，服务不可用');
            return;
        }
        _initialized = true;
        console.log('[BorderMilitaryService] 慕兰战线服务初始化完成');
    }

    /**
     * 获取配置
     */
    getConfig() {
        if (!_initialized || !_config) {
            try {
                _config = configLoader.getConfig('border_military_data');
                _initialized = !!_config;
            } catch (e) {
                // 配置未加载，返回 null，业务方法会判断处理
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
     * 工具：随机数 [min, max] 整数
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
     * 获取玩家军衔信息
     * 累计军功决定军衔，军衔不可倒退
     */
    getMilitaryRank(player) {
        const config = this.getConfig();
        if (!config) return { rank: 0, name: '白丁', daily_support_bonus: 0, intel_identify_bonus: 0 };

        const meritTotal = player.border_military_merit_total || 0;
        const ranks = config.ranks?.levels || [];
        let currentRank = ranks[0];
        for (const r of ranks) {
            if (meritTotal >= r.min_merit) currentRank = r;
        }
        return {
            rank: currentRank.rank,
            name: currentRank.name,
            min_merit: currentRank.min_merit,
            daily_support_bonus: currentRank.daily_support_bonus || 0,
            intel_identify_bonus: currentRank.intel_identify_bonus || 0,
            is_milestone: currentRank.is_milestone || false,
            merit_total: meritTotal,
            merit_available: player.border_military_merit_available || 0
        };
    }

    /**
     * 检查玩家境界是否满足参与要求
     */
    _checkRealm(player) {
        const config = this.getConfig();
        if (!config) return { met: false, reason: '慕兰战线配置未加载' };
        const minRealm = config.settings?.min_realm || '结丹期';
        const realmCheck = game.RealmService.meetsRealmRequirement(player, minRealm);
        return realmCheck;
    }

    /**
     * 获取或生成今日军议
     * 每日0点后第一次访问时生成并缓存，跨日自动重置
     */
    getDailyBriefing() {
        const config = this.getConfig();
        if (!config) return null;

        const today = this._todayStr();
        if (_dailyBriefingCache && _dailyBriefingCache.date === today) {
            return _dailyBriefingCache;
        }

        // 生成今日军议：3 个特殊路线
        const routes = config.daily_briefing?.routes || ['scout', 'lamp_breaker', 'array_guard', 'raid'];
        const shuffled = [...routes].sort(() => Math.random() - 0.5);

        _dailyBriefingCache = {
            date: today,
            secret_order: shuffled[0],   // 密令路线：押中后军功+50%
            risky_route: shuffled[1],    // 险棋路线：失败惩罚+30%，成功额外+50%军功
            grain_route: shuffled[2],    // 粮道路线：灵石收益+50%
            description: `今日军议：密令路线=${this._routeName(shuffled[0])}，险棋路线=${this._routeName(shuffled[1])}，粮道路线=${this._routeName(shuffled[2])}`
        };

        return _dailyBriefingCache;
    }

    /**
     * 路线键转中文名
     */
    _routeName(routeKey) {
        const names = { scout: '斥候', lamp_breaker: '破灯', array_guard: '护阵', raid: '奇袭' };
        return names[routeKey] || routeKey;
    }

    /**
     * 查询玩家战线状态
     * 返回：军衔/可用军功/今日军议/今日已支援路线/各子系统今日状态
     */
    async getStatus(player) {
        const config = this.getConfig();
        if (!config) throw new Error('慕兰战线配置未加载');

        // 境界检查
        const realmCheck = this._checkRealm(player);
        if (!realmCheck.met) {
            return {
                can_participate: false,
                reason: realmCheck.reason,
                min_realm: config.settings?.min_realm
            };
        }

        const today = this._todayStr();
        const rankInfo = this.getMilitaryRank(player);
        const briefing = this.getDailyBriefing();

        // 检查各子系统今日状态
        const alreadySupported = player.border_last_support_date &&
            player.border_last_support_date === today;
        const intelCollected = player.border_intel_collected_date &&
            player.border_intel_collected_date === today;
        const beastPatrolDone = player.border_beast_patrol_date &&
            player.border_beast_patrol_date === today;
        const remnantExplored = player.border_remnant_explore_date &&
            player.border_remnant_explore_date === today;
        const imprintDone = player.border_imprint_date &&
            player.border_imprint_date === today;

        // 查询里程碑已发放列表
        const milestones = await BorderMilestoneReward.findAll({
            where: { player_id: player.id },
            order: [['milestone_merit', 'ASC']]
        });
        const nextMilestone = (config.milestones?.thresholds || []).find(
            m => !milestones.some(g => g.milestone_merit === m.merit)
        );

        return {
            can_participate: true,
            rank: rankInfo,
            daily_briefing: briefing,
            today_actions: {
                supported: alreadySupported,
                support_route: alreadySupported ? player.border_today_support_route : null,
                intel_collected: intelCollected,
                intel_public_done: !!player.border_intel_public_done,
                beast_patrol_done: beastPatrolDone,
                remnant_explored: remnantExplored,
                imprint_done: imprintDone
            },
            milestones: {
                granted: milestones.map(m => ({ merit: m.milestone_merit, title: m.milestone_title, granted_at: m.granted_at })),
                next: nextMilestone || null
            }
        };
    }

    /**
     * 执行支援慕兰行动
     * @param {Object} player - 玩家对象
     * @param {string} route - 路线：scout/lamp_breaker/array_guard/raid
     * @returns {Object} 行动结果
     */
    async supportMulanan(player, route) {
        const config = this.getConfig();
        if (!config) throw new Error('慕兰战线配置未加载');

        // 境界检查
        const realmCheck = this._checkRealm(player);
        if (!realmCheck.met) {
            return { success: false, message: `境界不足：${realmCheck.reason}` };
        }

        // 路线校验
        const routeConfig = config.support_routes?.[route];
        if (!routeConfig) {
            return { success: false, message: `无效路线：${route}（可选：scout/lamp_breaker/array_guard/raid）` };
        }

        // 每日次数检查
        const today = this._todayStr();
        const alreadySupported = player.border_last_support_date &&
            player.border_last_support_date === today;
        if (alreadySupported) {
            return {
                success: false,
                message: `今日已支援过（路线：${this._routeName(player.border_today_support_route)}），明日再来`
            };
        }

        // 检查玩家死亡状态
        if (player.is_dead) {
            return { success: false, message: '玩家已死亡，无法参与战线' };
        }

        // 事务处理：避免数据不一致
        const t = await sequelize.transaction();
        try {
            // 重新锁定玩家记录
            const freshPlayer = await Player.findByPk(player.id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!freshPlayer) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 双重校验：防止并发
            if (freshPlayer.border_last_support_date &&
                freshPlayer.border_last_support_date === today) {
                await t.rollback();
                return { success: false, message: '今日已支援过（并发拦截）' };
            }

            // 获取今日军议
            const briefing = this.getDailyBriefing();
            const isSecretOrder = briefing.secret_order === route;
            const isRiskyRoute = briefing.risky_route === route;
            const isGrainRoute = briefing.grain_route === route;

            // 检查临战刻印（未触发且未过期的）
            const activeImprint = await BorderWarImprint.findOne({
                where: {
                    player_id: player.id,
                    triggered: false,
                    expires_at: { [Op.gt]: new Date() }
                                },
                transaction: t
            });
            let imprintTriggered = false;
            let imprintBonusRate = 0;
            if (activeImprint) {
                const matchedRoutes = activeImprint.matched_route.split(',');
                if (matchedRoutes.includes(route)) {
                    imprintTriggered = true;
                    imprintBonusRate = parseFloat(activeImprint.bonus_rate) || 0;
                    // 标记刻印已触发
                    activeImprint.triggered = true;
                    activeImprint.triggered_at = new Date();
                    activeImprint.trigger_route = route;
                    await activeImprint.save({ transaction: t });
                }
            }

            // 计算军报加成（如果今日已公开真军报）
            let intelBonusRate = 0;
            const todayReports = await BorderIntelReport.findAll({
                where: {
                    player_id: player.id,
                    report_date: today,
                    public_status: 'publiced',
                    identified_result: 'correct'
                },
                transaction: t
            });
            if (todayReports.length > 0) {
                intelBonusRate = (config.intel.true_report_reward.support_bonus_rate || 0.20) * todayReports.length;
            }

            // 计算军衔加成
            const rankInfo = this.getMilitaryRank(freshPlayer);
            const rankBonusRate = rankInfo.daily_support_bonus || 0;

            // 判断行动是否失败
            const failureRate = routeConfig.failure_rate || 0;
            const isFailed = Math.random() < failureRate;

            if (isFailed) {
                // 失败：扣灵石、扣HP
                const penalty = routeConfig.failure_penalty || {};
                const spiritStoneLoss = penalty.spirit_stones || 0;
                const hpLossRate = penalty.hp_loss_rate || 0;
                const currentHp = BigInt(freshPlayer.hp_current?.toString() || '0');
                const hpMax = BigInt(1000); // 简化：用属性计算较慢，这里用估算
                const hpLoss = BigInt(Math.floor(Number(hpMax) * hpLossRate));

                freshPlayer.spirit_stones = BigInt(freshPlayer.spirit_stones?.toString() || '0') - BigInt(spiritStoneLoss);
                freshPlayer.hp_current = currentHp > hpLoss ? currentHp - hpLoss : BigInt(0);

                // 险棋路线失败惩罚加重
                const riskyPenaltyRate = config.daily_briefing.risky_route_failure_penalty || 0;
                if (isRiskyRoute) {
                    const extraLoss = BigInt(Math.floor(spiritStoneLoss * riskyPenaltyRate));
                    freshPlayer.spirit_stones = freshPlayer.spirit_stones - extraLoss;
                }

                // 写入支援日志
                await BorderSupportLog.create({
                    player_id: freshPlayer.id,
                    support_route: route,
                    support_date: today,
                    is_secret_order: isSecretOrder,
                    is_risky_route: isRiskyRoute,
                    is_grain_route: isGrainRoute,
                    base_merit: 0,
                    final_merit: 0,
                    merit_bonus_rate: 0,
                    spirit_stones_gained: 0,
                    items_dropped: null,
                    imprint_triggered: imprintTriggered,
                    imprint_bonus_rate: imprintBonusRate,
                    intel_bonus_rate: intelBonusRate,
                    failed: true,
                    failure_penalty: JSON.stringify({ spirit_stones: spiritStoneLoss, hp_loss: hpLoss.toString() })
                }, { transaction: t });

                // 标记今日已支援
                freshPlayer.border_last_support_date = today;
                freshPlayer.border_today_support_route = route;

                await freshPlayer.save({ transaction: t });
                await t.commit();

                return {
                    success: false,
                    failed: true,
                    message: `支援${this._routeName(route)}失败！损失 ${spiritStoneLoss} 灵石、${hpLoss} HP${isRiskyRoute ? '（险棋路线额外惩罚）' : ''}`,
                    data: {
                        route,
                        route_name: this._routeName(route),
                        is_secret_order: isSecretOrder,
                        is_risky_route: isRiskyRoute,
                        spirit_stones_loss: spiritStoneLoss,
                        hp_loss: hpLoss.toString()
                    }
                };
            }

            // 成功：计算奖励
            const baseMerit = routeConfig.base_merit || 1;
            const totalBonusRate = rankBonusRate + imprintBonusRate + intelBonusRate +
                (isSecretOrder ? (config.daily_briefing.secret_order_bonus_rate || 0) : 0) +
                (isRiskyRoute ? (config.daily_briefing.risky_route_success_bonus_rate || 0) : 0);

            const finalMerit = Math.max(1, Math.floor(baseMerit * (1 + totalBonusRate)));

            // 灵石收益
            const stoneRange = routeConfig.spirit_stone_range || [0, 0];
            let spiritStonesGained = this._randomInt(stoneRange[0], stoneRange[1]);
            if (isGrainRoute) {
                spiritStonesGained = Math.floor(spiritStonesGained * (1 + (config.daily_briefing.grain_route_spirit_stone_bonus_rate || 0)));
            }

            // 物品掉落
            const drops = this._rollDrops(routeConfig.item_drops);

            // 更新玩家军功（累计+可用）
            freshPlayer.border_military_merit_total = (freshPlayer.border_military_merit_total || 0) + finalMerit;
            freshPlayer.border_military_merit_available = (freshPlayer.border_military_merit_available || 0) + finalMerit;
            freshPlayer.spirit_stones = BigInt(freshPlayer.spirit_stones?.toString() || '0') + BigInt(spiritStonesGained);
            freshPlayer.border_last_support_date = today;
            freshPlayer.border_today_support_route = route;

            await freshPlayer.save({ transaction: t });

            // 发放物品（调用 InventoryService，第 4 参数直接传 transaction 实例）
            if (drops.length > 0) {
                try {
                    const InventoryService = game.InventoryService;
                    for (const drop of drops) {
                        await InventoryService.addItem(freshPlayer.id, drop.key, drop.quantity, t);
                    }
                } catch (e) {
                    console.warn('[BorderMilitaryService] 物品发放失败（不影响主线）:', e.message);
                }
            }

            // 写入支援日志
            await BorderSupportLog.create({
                player_id: freshPlayer.id,
                support_route: route,
                support_date: today,
                is_secret_order: isSecretOrder,
                is_risky_route: isRiskyRoute,
                is_grain_route: isGrainRoute,
                base_merit: baseMerit,
                final_merit: finalMerit,
                merit_bonus_rate: totalBonusRate,
                spirit_stones_gained: spiritStonesGained,
                items_dropped: drops.length > 0 ? JSON.stringify(drops) : null,
                imprint_triggered: imprintTriggered,
                imprint_bonus_rate: imprintBonusRate,
                intel_bonus_rate: intelBonusRate,
                failed: false,
                failure_penalty: null
            }, { transaction: t });

            await t.commit();

            // 检查里程碑奖励（事务外，避免阻塞主流程）
            const milestoneResult = await this._checkMilestones(freshPlayer);

            return {
                success: true,
                message: `支援${this._routeName(route)}成功！获得军功 ${finalMerit}、灵石 ${spiritStonesGained}${drops.length > 0 ? `、物品 ${drops.map(d => d.key + '×' + d.quantity).join(', ')}` : ''}${isSecretOrder ? '（密令路线加成）' : ''}${isRiskyRoute ? '（险棋路线加成）' : ''}${isGrainRoute ? '（粮道路线加成）' : ''}${imprintTriggered ? '（临战刻印触发）' : ''}${intelBonusRate > 0 ? '（军报加成）' : ''}${milestoneResult.triggered ? `；里程碑达成：${milestoneResult.title}` : ''}`,
                data: {
                    route,
                    route_name: this._routeName(route),
                    base_merit: baseMerit,
                    final_merit: finalMerit,
                    merit_bonus_rate: totalBonusRate,
                    spirit_stones_gained: spiritStonesGained,
                    items_dropped: drops,
                    is_secret_order: isSecretOrder,
                    is_risky_route: isRiskyRoute,
                    is_grain_route: isGrainRoute,
                    imprint_triggered: imprintTriggered,
                    intel_bonus_rate: intelBonusRate,
                    new_rank: this.getMilitaryRank(freshPlayer),
                    milestone: milestoneResult
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[BorderMilitaryService] supportMulanan 异常:', err);
            return { success: false, message: `支援失败：${err.message}` };
        }
    }

    /**
     * 检查里程碑奖励发放
     * 通过 UNIQUE KEY (player_id, milestone_merit) 保证幂等
     */
    async _checkMilestones(player) {
        const config = this.getConfig();
        if (!config) return { triggered: false };

        const meritTotal = player.border_military_merit_total || 0;
        const thresholds = config.milestones?.thresholds || [];

        for (const threshold of thresholds) {
            if (meritTotal >= threshold.merit) {
                // 检查是否已发放
                const existing = await BorderMilestoneReward.findOne({
                    where: {
                        player_id: player.id,
                        milestone_merit: threshold.merit
                    }
                });
                if (!existing) {
                    // 发放奖励
                    try {
                        await BorderMilestoneReward.create({
                            player_id: player.id,
                            milestone_merit: threshold.merit,
                            milestone_title: threshold.title,
                            rewards_data: JSON.stringify(threshold.rewards)
                        });

                        // 发放具体奖励
                        const rewards = threshold.rewards || {};
                        if (rewards.spirit_stones) {
                            const freshPlayer = await Player.findByPk(player.id);
                            freshPlayer.spirit_stones = BigInt(freshPlayer.spirit_stones?.toString() || '0') + BigInt(rewards.spirit_stones);
                            await freshPlayer.save();
                        }
                        if (rewards.items && Array.isArray(rewards.items)) {
                            try {
                                const InventoryService = game.InventoryService;
                                for (const item of rewards.items) {
                                    await InventoryService.addItem(player.id, item.key, item.quantity);
                                }
                            } catch (e) {
                                console.warn('[BorderMilitaryService] 里程碑物品发放失败:', e.message);
                            }
                        }

                        return { triggered: true, title: threshold.title, merit: threshold.merit, rewards: threshold.rewards };
                    } catch (e) {
                        // 唯一约束冲突表示已被其他并发流程发放
                        console.log('[BorderMilitaryService] 里程碑奖励已被并发流程发放:', e.message);
                    }
                }
            }
        }

        return { triggered: false };
    }

    /**
     * 搜集军报（每日1次）
     * 生成 3 条真假混杂的军报
     */
    async collectIntel(player) {
        const config = this.getConfig();
        if (!config) throw new Error('慕兰战线配置未加载');

        // 境界检查
        const realmCheck = this._checkRealm(player);
        if (!realmCheck.met) {
            return { success: false, message: `境界不足：${realmCheck.reason}` };
        }

        const today = this._todayStr();
        if (player.border_intel_collected_date === today) {
            return { success: false, message: '今日已搜集过军报，明日再来' };
        }

        // 生成 3 条军报
        const reportTypes = config.intel?.report_types || [];
        if (reportTypes.length === 0) {
            return { success: false, message: '军报类型配置缺失' };
        }

        const trueRate = config.intel?.true_report_rate || 0.5;
        const reports = [];
        const usedTypes = new Set();

        for (let i = 0; i < 3; i++) {
            // 随机选类型，不重复
            let typeInfo;
            do {
                typeInfo = reportTypes[Math.floor(Math.random() * reportTypes.length)];
            } while (usedTypes.has(typeInfo.type) && usedTypes.size < reportTypes.length);
            usedTypes.add(typeInfo.type);

            const isTrue = Math.random() < trueRate;
            const content = this._generateIntelContent(typeInfo, isTrue);

            const report = await BorderIntelReport.create({
                player_id: player.id,
                report_date: today,
                report_index: i + 1,
                report_type: typeInfo.type,
                is_true: isTrue,
                content: content,
                confusion_rate: typeInfo.confusion_rate || 0.1,
                identified: false,
                identified_result: null,
                identified_at: null,
                public_status: 'pending',
                publiced_at: null,
                merit_change: 0
            });

            reports.push({
                id: report.id,
                index: i + 1,
                type: typeInfo.type,
                type_description: typeInfo.description,
                content: content,
                is_true: isTrue,  // 注意：实际接口不返回此字段，这里用于测试
                identified: false,
                public_status: 'pending'
            });
        }

        // 更新玩家搜集日期
        player.border_intel_collected_date = today;
        await player.save();

        return {
            success: true,
            message: `搜集到 ${reports.length} 条军报，请用 .辨报 <编号> 研判`,
            data: {
                reports: reports.map(r => ({
                    id: r.id,
                    index: r.index,
                    type: r.type,
                    type_description: r.type_description,
                    content: r.content,
                    identified: r.identified,
                    public_status: r.public_status
                    // 不返回 is_true，玩家需要辨报才能知道
                }))
            }
        };
    }

    /**
     * 生成军报内容
     */
    _generateIntelContent(typeInfo, isTrue) {
        const templates = {
            troop_movement: isTrue ?
                '斥候来报：慕兰军先锋已悄然东移，意图袭我侧翼。' :
                '斥候来报：慕兰军前锋稳守本阵，未见异动。（此报疑为混淆视听）',
            supply_line: isTrue ?
                '粮道消息：慕兰粮草辎重受阻于黄龙旧道，补给紧张。' :
                '粮道消息：慕兰粮道畅通无阻，补给充足。（此报疑为伪报）',
            lamp_status: isTrue ?
                '圣灯观测：慕兰圣灯今日火光黯淡，似被阵法压制。' :
                '圣灯观测：慕兰圣灯火势正旺，威能不减。（此报疑为敌方诱饵）',
            array_intel: isTrue ?
                '阵法情报：慕兰法阵中枢位于西北角，可一举破之。' :
                '阵法情报：慕兰法阵布于四面八方，无隙可乘。（此报真伪难辨）',
            elite_movement: isTrue ?
                '精锐动向：慕兰神将亲卫队已悄然离营，去向不明。' :
                '精锐动向：慕兰神将亲卫队驻守大营，寸步不离。（此报疑为障眼法）'
        };
        return templates[typeInfo.type] || '前线军报：内容不详，需研判。';
    }

    /**
     * 辨报（研判某条军报的真伪）
     * 成功率 = base_success_rate + 军衔加成 - 混淆度
     */
    async identifyIntel(player, reportId) {
        const config = this.getConfig();
        if (!config) throw new Error('慕兰战线配置未加载');

        const report = await BorderIntelReport.findByPk(reportId);
        if (!report) {
            return { success: false, message: '军报不存在' };
        }
        if (report.player_id !== player.id) {
            return { success: false, message: '无权辨报他人军报' };
        }
        if (report.identified) {
            return { success: false, message: '此军报已辨报过', data: { identified_result: report.identified_result } };
        }

        // 计算辨报成功率
        const rankInfo = this.getMilitaryRank(player);
        const baseRate = config.intel?.identify_difficulty?.base_success_rate || 0.5;
        const maxRate = config.intel?.identify_difficulty?.max_success_rate || 0.95;
        const rankBonus = rankInfo.intel_identify_bonus || 0;
        const confusionRate = parseFloat(report.confusion_rate) || 0;

        let successRate = baseRate + rankBonus - confusionRate;
        successRate = Math.max(0.1, Math.min(maxRate, successRate));

        // 判定辨报是否正确
        const identifiedAsTrue = Math.random() < successRate;
        const actualIsTrue = report.is_true;
        const isCorrect = identifiedAsTrue === actualIsTrue;

        report.identified = true;
        report.identified_result = isCorrect ? 'correct' : 'wrong';
        report.identified_at = new Date();
        await report.save();

        return {
            success: true,
            message: `辨报完成：此军报研判为${identifiedAsTrue ? '真' : '伪'}，研判${isCorrect ? '正确' : '失误'}`,
            data: {
                report_id: report.id,
                identified_as: identifiedAsTrue ? 'true' : 'false',
                actual: actualIsTrue ? 'true' : 'false',  // 实际真伪（辨报后揭示）
                is_correct: isCorrect,
                identified_result: report.identified_result,
                success_rate: successRate
            }
        };
    }

    /**
     * 公开军报（将辨报后的军报交给前线）
     * 真军报：+3 军功 + 当日支援加成
     * 假军报：-1 军功 + 当日支援惩罚
     */
    async publicIntel(player, reportId) {
        const config = this.getConfig();
        if (!config) throw new Error('慕兰战线配置未加载');

        const today = this._todayStr();
        if (player.border_intel_public_done) {
            return { success: false, message: '今日已公开过军报' };
        }

        const report = await BorderIntelReport.findByPk(reportId);
        if (!report) {
            return { success: false, message: '军报不存在' };
        }
        if (report.player_id !== player.id) {
            return { success: false, message: '无权公开他人军报' };
        }
        if (report.report_date !== today) {
            return { success: false, message: '只能公开今日搜集的军报' };
        }
        if (!report.identified) {
            return { success: false, message: '军报未辨报，无法公开' };
        }
        if (report.public_status !== 'pending') {
            return { success: false, message: `军报已处理（状态：${report.public_status}）` };
        }

        const t = await sequelize.transaction();
        try {
            const freshPlayer = await Player.findByPk(player.id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            const isTrue = report.is_true;
            const identifiedCorrect = report.identified_result === 'correct';
            const trueReward = config.intel?.true_report_reward || {};
            const falsePenalty = config.intel?.false_report_penalty || {};

            let meritChange = 0;
            let supportEffect = 'none';
            let supportRate = 0;

            if (isTrue && identifiedCorrect) {
                // 辨报正确且是真军报：奖励
                meritChange = trueReward.merit || 3;
                supportEffect = 'bonus';
                supportRate = trueReward.support_bonus_rate || 0.20;
            } else if (!isTrue && identifiedCorrect) {
                // 辨报正确但是假军报：小幅奖励
                meritChange = 1;
                supportEffect = 'none';
                supportRate = 0;
            } else {
                // 辨报失误：惩罚
                meritChange = -(falsePenalty.merit_loss || 1);
                supportEffect = 'penalty';
                supportRate = -(falsePenalty.support_penalty_rate || 0.20);
            }

            // 更新军功
            freshPlayer.border_military_merit_total = Math.max(0, (freshPlayer.border_military_merit_total || 0) + Math.max(0, meritChange));
            freshPlayer.border_military_merit_available = Math.max(0, (freshPlayer.border_military_merit_available || 0) + meritChange);
            freshPlayer.border_intel_public_done = true;
            await freshPlayer.save({ transaction: t });

            // 更新军报状态
            report.public_status = 'publiced';
            report.publiced_at = new Date();
            report.merit_change = meritChange;
            await report.save({ transaction: t });

            await t.commit();

            // 重新识别identified_result以确定公开后的最终判断
            // 注意：support_bonus_rate 已在 supportMulanan 中通过查询 identified_result='correct' 的公开军报数量实现

            return {
                success: true,
                message: `公开军报完成：${isTrue ? '真军报' : '假军报'}${identifiedCorrect ? '（辨报正确）' : '（辨报失误）'}，军功${meritChange > 0 ? '+' : ''}${meritChange}${supportEffect === 'bonus' ? '，当日支援加成 +20%' : supportEffect === 'penalty' ? '，当日支援惩罚 -20%' : ''}`,
                data: {
                    report_id: report.id,
                    is_true: isTrue,
                    identified_correct: identifiedCorrect,
                    merit_change: meritChange,
                    support_effect: supportEffect,
                    support_rate: supportRate
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[BorderMilitaryService] publicIntel 异常:', err);
            return { success: false, message: `公开军报失败：${err.message}` };
        }
    }

    /**
     * 查询军功司兑换物品列表
     */
    getMilitaryShop(player) {
        const config = this.getConfig();
        if (!config) return { success: false, message: '配置未加载' };

        const rankInfo = this.getMilitaryRank(player);
        const items = (config.military_shop?.items || []).map(item => ({
            key: item.key,
            name: item.name,
            cost_merit: item.cost_merit,
            description: item.description,
            daily_limit: item.daily_limit,
            requires_rank: item.requires_rank || 0,
            can_exchange: rankInfo.rank >= (item.requires_rank || 0)
        }));

        return {
            success: true,
            data: {
                rank: rankInfo,
                items
            }
        };
    }

    /**
     * 军功兑换
     */
    async exchangeMerit(player, itemKey, quantity = 1) {
        const config = this.getConfig();
        if (!config) throw new Error('配置未加载');

        const shopItem = (config.military_shop?.items || []).find(i => i.key === itemKey);
        if (!shopItem) {
            return { success: false, message: `兑换物品不存在：${itemKey}` };
        }

        const rankInfo = this.getMilitaryRank(player);
        if (rankInfo.rank < (shopItem.requires_rank || 0)) {
            return {
                success: false,
                message: `军衔不足：需要军衔等级 ${shopItem.requires_rank}（${config.ranks.levels.find(r => r.rank === shopItem.requires_rank)?.name || '未知'}），当前 ${rankInfo.name}`
            };
        }

        if (quantity < 1 || quantity > (shopItem.daily_limit || 1)) {
            return { success: false, message: `兑换数量无效：每日限兑 ${shopItem.daily_limit} 个` };
        }

        const totalCost = shopItem.cost_merit * quantity;
        if ((player.border_military_merit_available || 0) < totalCost) {
            return {
                success: false,
                message: `可用军功不足：需要 ${totalCost}（${shopItem.cost_merit}×${quantity}），当前 ${player.border_military_merit_available}`
            };
        }

        const t = await sequelize.transaction();
        try {
            const freshPlayer = await Player.findByPk(player.id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });

            if ((freshPlayer.border_military_merit_available || 0) < totalCost) {
                await t.rollback();
                return { success: false, message: '可用军功不足（并发拦截）' };
            }

            // 扣减军功
            freshPlayer.border_military_merit_available = freshPlayer.border_military_merit_available - totalCost;
            await freshPlayer.save({ transaction: t });

            // 发放物品
            try {
                const InventoryService = game.InventoryService;
                await InventoryService.addItem(freshPlayer.id, itemKey, quantity, t);
            } catch (e) {
                await t.rollback();
                return { success: false, message: `物品发放失败：${e.message}` };
            }

            await t.commit();

            return {
                success: true,
                message: `兑换成功：${shopItem.name} × ${quantity}，消耗 ${totalCost} 军功`,
                data: {
                    item_key: itemKey,
                    item_name: shopItem.name,
                    quantity,
                    cost_merit: totalCost,
                    merit_available: freshPlayer.border_military_merit_available
                }
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[BorderMilitaryService] exchangeMerit 异常:', err);
            return { success: false, message: `兑换失败：${err.message}` };
        }
    }

    /**
     * 查询慕兰谍影军报列表
     */
    async getIntelList(player, onlyToday = true) {
        const where = { player_id: player.id };
        if (onlyToday) {
            where.report_date = this._todayStr();
        }

        const reports = await BorderIntelReport.findAll({
            where,
            order: [['report_date', 'DESC'], ['report_index', 'ASC']]
        });

        return {
            success: true,
            data: {
                reports: reports.map(r => ({
                    id: r.id,
                    report_date: r.report_date,
                    index: r.report_index,
                    type: r.report_type,
                    content: r.content,
                    identified: r.identified,
                    identified_result: r.identified_result,
                    public_status: r.public_status,
                    merit_change: r.merit_change,
                    // 已辨报或已公开后才能看到真伪
                    is_true: (r.identified || r.public_status === 'publiced') ? r.is_true : null
                })),
                today_public_done: !!player.border_intel_public_done
            }
        };
    }

    /**
     * 查询支援历史
     */
    async getSupportHistory(player, limit = 20) {
        const logs = await BorderSupportLog.findAll({
            where: { player_id: player.id },
            order: [['created_at', 'DESC']],
            limit: Math.min(limit, 100)
        });

        return {
            success: true,
            data: {
                logs: logs.map(l => ({
                    id: l.id,
                    support_date: l.support_date,
                    route: l.support_route,
                    route_name: this._routeName(l.support_route),
                    is_secret_order: l.is_secret_order,
                    is_risky_route: l.is_risky_route,
                    is_grain_route: l.is_grain_route,
                    base_merit: l.base_merit,
                    final_merit: l.final_merit,
                    spirit_stones_gained: l.spirit_stones_gained?.toString(),
                    items_dropped: l.items_dropped ? JSON.parse(l.items_dropped) : null,
                    imprint_triggered: l.imprint_triggered,
                    intel_bonus_rate: parseFloat(l.intel_bonus_rate),
                    failed: l.failed,
                    created_at: l.created_at
                }))
            }
        };
    }

    // ===== 子系统方法（在 SubService 文件中实现，这里只做代理） =====

    /**
     * 灵兽边境巡边（在 BorderBeastPatrolService 中实现，这里转发）
     * 留作扩展点
     */
    async beastPatrol(player, beastId, route) {
        const BorderBeastPatrolSubService = require('./BorderBeastPatrolSubService');
        return await BorderBeastPatrolSubService.patrol(player, beastId, route);
    }

    /**
     * 灵兽巡边归来结算
     */
    async beastPatrolReturn(player, patrolId) {
        const BorderBeastPatrolSubService = require('./BorderBeastPatrolSubService');
        return await BorderBeastPatrolSubService.returnFromPatrol(player, patrolId);
    }

    /**
     * 查询灵兽巡边状态（active + 最近 10 条历史）
     */
    async beastPatrolStatus(player) {
        const BorderBeastPatrolSubService = require('./BorderBeastPatrolSubService');
        return await BorderBeastPatrolSubService.getStatus(player);
    }

    /**
     * 残图匣查询
     */
    async getRemnantMapStatus(player) {
        const RemnantMapSubService = require('./RemnantMapSubService');
        return await RemnantMapSubService.getStatus(player);
    }

    /**
     * 拼残图
     */
    async combineRemnantMap(player) {
        const RemnantMapSubService = require('./RemnantMapSubService');
        return await RemnantMapSubService.combine(player);
    }

    /**
     * 按图探禁
     */
    async exploreRemnantMap(player) {
        const RemnantMapSubService = require('./RemnantMapSubService');
        return await RemnantMapSubService.explore(player);
    }

    /**
     * 临战刻印
     */
    async applyWarImprint(player, artifactId, imprintType) {
        const WarImprintSubService = require('./WarImprintSubService');
        return await WarImprintSubService.apply(player, artifactId, imprintType);
    }

    /**
     * 查询临战刻印状态
     */
    async getImprintStatus(player) {
        const WarImprintSubService = require('./WarImprintSubService');
        return await WarImprintSubService.getStatus(player);
    }
}

// 单例导出（与项目其他服务一致）
module.exports = new BorderMilitaryService();
