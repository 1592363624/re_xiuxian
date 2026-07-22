/**
 * 境界服务
 * 核心逻辑层 - 处理境界相关的核心玩法逻辑
 *
 * 提供：
 * 1. 基础查询：getAllRealms / getRealmByName / getRealmById / getRealmByRank / getNextRealm
 * 2. 境界比较：getRealmRank / resolveMinRealmRank / meetsRealmRequirement
 * 3. 突破逻辑：canBreakthrough / breakthrough / calculateBreakthroughProbability
 *
 * 关键设计（2026-07-19 修复 B1 bug）：
 *   历史代码用 REALM_ORDER.indexOf 做境界比较，但"筑基期/化神期"等大境界名
 *   不在 REALM_ORDER 中（玩家实际境界是"筑基初期/化神中期"等子境界名），
 *   导致化神期及以上玩家被深度闭关等系统错误拦截。
 *   现在统一通过 getRealmRank + resolveMinRealmRank 完成"大境界名→rank"解析。
 */
// 修复：统一通过 modules/index.js 导出引用 ConfigLoader
const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const sequelize = require('../../config/database');
const { REALM_TIER_MIN_RANK } = require('../../utils/gameConstants');

// 突破流程依赖的服务（懒加载避免循环依赖）
// - MeditationService：瓶颈系统（checkAndTriggerBottleneck / handleBreakthroughSuccess / handleBreakthroughFailure）
// - AttributeMaxService：突破后按新境界重算 HP/MP 上限
// - WebSocketNotificationService：突破结果实时推送
// - AppError/ErrorCodes：业务异常
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');

class RealmService {
    /**
     * 获取所有境界配置
     */
    getAllRealms() {
        const config = configLoader.getConfig('realm_breakthrough');
        return config?.realms || [];
    }

    /**
     * 根据境界名称获取境界信息
     */
    getRealmByName(realmName) {
        const realms = this.getAllRealms();
        return realms.find(r => r.name === realmName);
    }

    /**
     * 根据境界ID获取境界信息
     */
    getRealmById(realmId) {
        const realms = this.getAllRealms();
        return realms.find(r => r.id === realmId);
    }

    /**
     * 根据境界排名获取境界信息
     */
    getRealmByRank(rank) {
        const realms = this.getAllRealms();
        return realms.find(r => r.rank === rank);
    }

    /**
     * 获取下一境界信息
     */
    getNextRealm(currentRealm) {
        if (!currentRealm) return null;
        const currentRank = currentRealm.rank !== undefined ? currentRealm.rank : 1;
        return this.getRealmByRank(currentRank + 1);
    }

    /**
     * 获取境界排名（用于比较境界高低）
     * @param {string} realmName - 境界名称
     * @returns {number} 排名，0 表示未找到
     */
    getRealmRank(realmName) {
        const realm = this.getRealmByName(realmName);
        return realm?.rank || 0;
    }

    /**
     * 解析境界要求为最低 rank
     *
     * 支持两种输入：
     *   1. 大境界名（如"筑基期"）→ 该境界最低子境界 rank（即"筑基初期"的 rank=11）
     *   2. 具体境界名（如"筑基初期"、"化神中期"）→ 直接返回该境界的 rank
     *   3. 同义大境界名 + 子境界后缀（如"结丹后期"、"元神中期"）→ 标准大境界 rank + 偏移量
     *
     * 用途：配置文件中的 min_realm 字段（如 seclusion.json 的 "min_realm": "筑基期"）
     *      统一通过此函数转换为数值 rank，再与玩家境界 rank 比较。
     *
     * 修复（2026-07-21）：
     *   苍坤洞府配置 leader_min_realm="结丹后期"，因"结丹"是"金丹"的同义别名，
     *   REALM_ORDER 中只有"金丹后期"而无"结丹后期"，导致 getRealmByName 精确匹配失败，
     *   REALM_TIER_MIN_RANK 也只有"结丹期"而无"结丹后期"，导致解析返回 0。
     *   新增第3步：自动识别"同义大境界名+子境界后缀"组合，按偏移量计算 rank。
     *   偏移规则：初期+0 / 中期+1 / 后期+2 / 大圆满+3（与 REALM_ORDER 顺序对齐）
     *
     * @param {string} minRealmName - 境界要求名称（大境界名或具体境界名）
     * @returns {number} 最低 rank；未匹配返回 0
     */
    resolveMinRealmRank(minRealmName) {
        if (!minRealmName || typeof minRealmName !== 'string') return 0;

        // 1. 优先精确匹配具体境界名（覆盖"筑基初期/化神中期"等所有子境界）
        const exactRealm = this.getRealmByName(minRealmName);
        if (exactRealm) return exactRealm.rank;

        // 2. 兜底：匹配大境界名映射表（"筑基期"→11、"化神期"→23 等）
        if (Object.prototype.hasOwnProperty.call(REALM_TIER_MIN_RANK, minRealmName)) {
            return REALM_TIER_MIN_RANK[minRealmName];
        }

        // 3. 新增（2026-07-21）：处理"同义大境界名 + 子境界后缀"组合
        // 同义大境界名前缀 → 标准大境界名前缀（与 REALM_ORDER 对齐）
        // 例："结丹后期" → "金丹期" rank 15 + 偏移 2 = rank 17
        //     "元神中期" → "化神期" rank 23 + 偏移 1 = rank 24
        const synonymPrefixMap = {
            '结丹': '金丹',  // 结丹 = 金丹（凝聚金丹之意）
            '元神': '化神'   // 元神 = 化神（元神出窍之意）
        };
        // 子境界后缀 → 偏移量（与 REALM_ORDER 中"初期/中期/后期/大圆满"的顺序对齐）
        const subRealmOffset = {
            '初期': 0,
            '中期': 1,
            '后期': 2,
            '大圆满': 3
        };

        for (const [synonym, standard] of Object.entries(synonymPrefixMap)) {
            if (minRealmName.startsWith(synonym)) {
                const suffix = minRealmName.substring(synonym.length);
                if (Object.prototype.hasOwnProperty.call(subRealmOffset, suffix)) {
                    const standardTierName = standard + '期';
                    if (Object.prototype.hasOwnProperty.call(REALM_TIER_MIN_RANK, standardTierName)) {
                        return REALM_TIER_MIN_RANK[standardTierName] + subRealmOffset[suffix];
                    }
                }
            }
        }

        // 4. 都不匹配：返回 0（调用方应判断 <=0 表示配置错误）
        return 0;
    }

    /**
     * 判断玩家是否满足境界要求
     *
     * 统一封装"玩家境界 rank vs 配置要求 rank"的比较逻辑，
     * 避免 server 中各处再写一遍 getRealmRank + resolveMinRealmRank 的样板代码。
     *
     * 修复 B45：优先使用 player.realm_rank（数值更可靠），fallback 到 getRealmRank(player.realm)
     * 避免玩家 realm 字段被错误设置（如 admin 强制突破只改 realm 不改 realm_rank）时业务判断错乱
     *
     * @param {Object|string} playerOrRealm - 玩家对象 或 玩家境界名称
     * @param {string} minRealmName - 配置中的境界要求（大境界名或具体境界名）
     * @returns {{ met: boolean, playerRank: number, requiredRank: number, reason?: string }}
     */
    meetsRealmRequirement(playerOrRealm, minRealmName) {
        let playerRank;
        let playerRealmName;
        if (typeof playerOrRealm === 'string') {
            // 传入字符串：按字符串解析
            playerRealmName = playerOrRealm;
            playerRank = this.getRealmRank(playerRealmName);
        } else {
            // 传入对象：优先用 realm_rank（数值更可靠），fallback 到 realm 字符串解析
            // 修复 B45：避免 realm 与 realm_rank 不一致时业务判断错乱
            playerRealmName = playerOrRealm?.realm;
            playerRank = (playerOrRealm?.realm_rank && playerOrRealm.realm_rank > 0)
                ? playerOrRealm.realm_rank
                : this.getRealmRank(playerRealmName);
        }
        const requiredRank = this.resolveMinRealmRank(minRealmName);

        if (playerRank <= 0) {
            return { met: false, playerRank, requiredRank, reason: `玩家境界【${playerRealmName}】未在配置中找到` };
        }
        if (requiredRank <= 0) {
            return { met: false, playerRank, requiredRank, reason: `境界要求【${minRealmName}】无法解析为 rank` };
        }
        if (playerRank < requiredRank) {
            return { met: false, playerRank, requiredRank, reason: `需要达到 ${minRealmName}（rank ${requiredRank}），当前 ${playerRealmName}（rank ${playerRank}）` };
        }
        return { met: true, playerRank, requiredRank };
    }

    /**
     * 计算当前境界修为上限
     */
    getCultivationLimit(realmId) {
        const realm = this.getRealmById(realmId);
        return realm?.cultivation_limit || 0;
    }

    /**
     * 检查是否可以突破
     */
    canBreakthrough(player) {
        const realm = this.getRealmByName(player.realm);
        if (!realm) return { can: false, reason: '境界配置不存在' };

        const currentExp = Number(player.exp || 0);
        const expCap = Number(realm.exp_cap || realm.cultivation_limit || 0);

        if (currentExp >= expCap) {
            return { can: true, nextRealm: this.getNextRealm(realm) };
        }

        return { 
            can: false, 
            reason: `修为不足，需要 ${expCap} 点修为才能突破，当前：${currentExp}` 
        };
    }

    /**
     * 执行突破（完整流程：瓶颈检查 + 概率判定 + 状态同步 + WebSocket 推送）
     *
     * 修复（2026-07-21）：
     *   原 breakthrough 方法严重不完整，只更新了 realm 和 exp，缺失多项关键逻辑：
     *     1. 未更新 realm_rank（导致 realm 与 realm_rank 不一致，B45 修过遗留数据但根因未解决）
     *     2. 未实现突破概率检查（calculateBreakthroughProbability 定义的但从未调用，玩家 100% 突破成功）
     *     3. 未更新 lifespan_max（新境界寿命上限未应用）
     *     4. 未更新 hp_current/mp_current（新境界 HP/MP 上限未应用）
     *     5. 未触发瓶颈系统（MeditationService.checkAndTriggerBottleneck）
     *     6. 未触发虚弱状态（突破失败应设 weakness_end_time）
     *     7. 未清理瓶颈状态（MeditationService.handleBreakthroughSuccess）
     *     8. 未推送 WebSocket 通知
     *     9. 未使用事务和行级锁
     *
     * 现在完整实现突破流程：
     *   1. 事务 + 行级锁防止并发突破
     *   2. 死亡/闭关/悟道等状态互斥校验
     *   3. 瓶颈触发检查（bottleneck_realms 配置的境界必须先破除瓶颈才能突破）
     *   4. 突破概率判定（realm.breakthrough_probability，瓶颈状态下额外扣减）
     *   5. 成功：同步更新 realm/realm_rank/exp/lifespan_max/hp_current/mp_current，
     *           清理瓶颈，恢复满 HP/MP，推送 player_breakthrough_success
     *   6. 失败：扣修为（failure_exp_loss_rate），触发虚弱（weakness_end_time），
     *           累加瓶颈失败次数，推送 player_breakthrough_failed
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, newRealm?, oldRealm?, expLoss?, bottleneckTriggered? }
     */
    async breakthrough(playerId) {
        // 懒加载依赖服务，避免循环依赖
        const MeditationService = require('../services/MeditationService');
        const AttributeMaxService = require('./AttributeMaxService');
        const WebSocketNotificationService = require('../services/WebSocketNotificationService');

        // 读取突破配置
        const btCfg = configLoader.getConfig('game_balance')?.breakthrough || {};
        // 读取高阶境界配置中的虚弱配置
        const highRealmCfg = configLoader.getConfig('realm_breakthrough')?.high_realm_features || {};
        const weaknessCfg = highRealmCfg.weakness || {
            exp_loss_rate_on_breakthrough_fail: 0.15,
            duration_sec: 3600,
            exp_gain_rate_penalty: 0.5,
            breakthrough_prob_penalty: 20
        };

        // 事务包裹整个突破流程，保证原子性
        const t = await sequelize.transaction();
        try {
            // 行级锁：防止双开 tab 并发突破导致状态错乱
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.commit();
                return { success: false, message: '角色不存在' };
            }

            // 死亡玩家不可突破
            if (player.is_dead) {
                await t.commit();
                return { success: false, message: '已身死道消，无法突破，请先轮回重生' };
            }
            // 闭关/悟道中不可突破（状态互斥）
            if (player.is_secluded) {
                await t.commit();
                return { success: false, message: '闭关中无法突破，请先出关' };
            }
            if (player.is_meditating) {
                await t.commit();
                return { success: false, message: '悟道中无法突破，请先结束悟道' };
            }

            // 修为是否足够
            const checkResult = this.canBreakthrough(player);
            if (!checkResult.can) {
                await t.commit();
                return { success: false, message: checkResult.reason };
            }
            const nextRealm = checkResult.nextRealm;
            if (!nextRealm) {
                await t.commit();
                return { success: false, message: '已达到最高境界，无法继续突破' };
            }

            const oldRealm = this.getRealmByName(player.realm);
            const oldRealmName = player.realm;

            // 瓶颈触发检查：若当前境界属于瓶颈境界且未进入瓶颈，则触发瓶颈并拦截本次突破
            // 玩家需先通过深度悟道/失败积累感悟破除瓶颈后才能再次尝试突破
            let bottleneckTriggered = false;
            if (btCfg.bottleneck_enabled) {
                const bottleneckRealms = btCfg.bottleneck_realms || [];
                if (bottleneckRealms.includes(player.realm_rank || 0)) {
                    // 仅当未处于瓶颈期时触发（active/broken/failed 状态不再重复触发）
                    if (player.bottleneck_state !== 'active' &&
                        player.bottleneck_state !== 'broken' &&
                        player.bottleneck_state !== 'failed') {
                        const triggerResult = MeditationService.checkAndTriggerBottleneck(player, nextRealm);
                        if (triggerResult.triggered) {
                            bottleneckTriggered = true;
                            await player.save({ transaction: t });
                            await t.commit();
                            return {
                                success: false,
                                message: triggerResult.reason,
                                bottleneck_triggered: true,
                                bottleneck_threshold: triggerResult.bottleneck_threshold
                            };
                        }
                    }
                    // 已处于瓶颈 active 状态：直接拦截
                    if (player.bottleneck_state === 'active') {
                        await t.commit();
                        return {
                            success: false,
                            message: `当前处于瓶颈期，需积累感悟 ${player.bottleneck_threshold || 100} 点方可突破（当前 ${player.bottleneck_insight || 0}）`,
                            bottleneck_state: 'active'
                        };
                    }
                }
            }

            // 计算最终突破概率
            // 基础概率来自 realm_breakthrough.json 的 breakthrough_probability 字段
            // 瓶颈已破除（broken）时获得 broken_breakthrough_bonus 加成
            // 瓶颈失败状态（failed）时受 breakthrough_prob_penalty 扣减
            let baseProb = this.calculateBreakthroughProbability(player, nextRealm);
            if (player.bottleneck_state === 'broken') {
                baseProb += (btCfg.broken_breakthrough_bonus || 0);
            } else if (player.bottleneck_state === 'failed') {
                baseProb -= (weaknessCfg.breakthrough_prob_penalty || 0);
            }
            // 虚弱状态下额外扣减
            if (player.weakness_end_time && new Date(player.weakness_end_time) > new Date()) {
                baseProb -= (weaknessCfg.breakthrough_prob_penalty || 0);
            }
            baseProb = Math.max(0, Math.min(100, baseProb));

            // 概率判定
            const dice = Math.random() * 100;
            const isSuccess = dice < baseProb;

            if (isSuccess) {
                // =======================
                // 突破成功：同步所有字段
                // =======================
                player.realm = nextRealm.name;
                player.realm_rank = nextRealm.rank;  // 关键：同步 realm_rank，避免 realm 与 realm_rank 不一致
                player.exp = 0n;  // 突破后修为重置为 0

                // 同步寿命上限到新境界配置（如化神初期 lifespan_max=2000）
                if (nextRealm.lifespan_max) {
                    player.lifespan_max = nextRealm.lifespan_max;
                }

                // 同步 HP/MP 到新境界上限（突破后状态满满，符合修仙设定）
                try {
                    const maxValues = AttributeMaxService.calculateAttributeMaxValues(player, nextRealm);
                    const maxHp = maxValues.hp_max || 100;
                    const maxMp = maxValues.mp_max || 0;
                    player.hp_current = BigInt(maxHp);
                    player.mp_current = BigInt(maxMp);
                } catch (attrErr) {
                    // 属性计算失败不阻塞突破，仅打印警告
                    console.warn('[RealmService] 突破后重算 HP/MP 上限失败:', attrErr.message);
                }

                // 清理瓶颈状态（突破成功后瓶颈自动消失）
                if (btCfg.bottleneck_enabled && player.bottleneck_state !== 'none') {
                    await MeditationService.handleBreakthroughSuccess(player, t);
                }

                // 清理虚弱状态（突破成功意味着元气恢复）
                player.weakness_end_time = null;

                await player.save({ transaction: t });
                await t.commit();

                // 推送突破成功事件（事务提交后再推送，避免回滚后误推）
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'player_breakthrough_success', {
                        old_realm: oldRealmName,
                        new_realm: nextRealm.name,
                        new_realm_rank: nextRealm.rank,
                        lifespan_max: player.lifespan_max,
                        hp_current: player.hp_current?.toString() || '0',
                        mp_current: player.mp_current?.toString() || '0',
                        timestamp: new Date().toISOString()
                    });
                } catch (e) {
                    console.warn('[RealmService] 推送突破成功事件失败:', e.message);
                }

                return {
                    success: true,
                    message: `突破成功！当前境界：${nextRealm.name}`,
                    newRealm: nextRealm,
                    oldRealm: oldRealm,
                    bottleneck_triggered: false
                };
            } else {
                // =======================
                // 突破失败：扣修为 + 触发虚弱 + 累加瓶颈失败次数
                // =======================
                const lossRate = btCfg.failure_exp_loss_rate ?? 0.1;
                const currentExp = BigInt(player.exp || 0);
                const expLoss = currentExp * BigInt(Math.round(lossRate * 100)) / 100n;
                const newExp = currentExp - expLoss;
                player.exp = newExp < 0n ? 0n : newExp;

                // 触发虚弱状态（持续 weaknessCfg.duration_sec 秒）
                const weaknessDuration = weaknessCfg.duration_sec || 3600;
                player.weakness_end_time = new Date(Date.now() + weaknessDuration * 1000);

                // 累加瓶颈失败次数（若处于瓶颈期）
                let failureResult = null;
                if (btCfg.bottleneck_enabled && player.bottleneck_state !== 'none') {
                    failureResult = await MeditationService.handleBreakthroughFailure(player, t);
                } else {
                    await player.save({ transaction: t });
                }

                await t.commit();

                // 推送突破失败事件
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'player_breakthrough_failed', {
                        current_realm: oldRealmName,
                        attempted_realm: nextRealm.name,
                        exp_loss: expLoss.toString(),
                        weakness_end_time: player.weakness_end_time,
                        bottleneck_state: player.bottleneck_state,
                        bottleneck_info: failureResult,
                        timestamp: new Date().toISOString()
                    });
                } catch (e) {
                    console.warn('[RealmService] 推送突破失败事件失败:', e.message);
                }

                return {
                    success: false,
                    message: `突破失败！修为损失 ${expLoss.toString()} 点，进入虚弱状态 ${Math.floor(weaknessDuration / 60)} 分钟`,
                    oldRealm: oldRealm,
                    attemptedRealm: nextRealm,
                    expLoss: expLoss.toString(),
                    weakness_end_time: player.weakness_end_time,
                    bottleneck_info: failureResult,
                    bottleneck_triggered: false
                };
            }
        } catch (err) {
            if (!t.finished) await t.rollback();
            console.error('[RealmService] 突破流程异常:', err);
            throw err;
        }
    }

    /**
     * 获取境界突破配置
     */
    getBreakthroughConfig(realmId) {
        const config = configLoader.getConfig('realm_breakthrough');
        const realm = this.getRealmById(realmId);
        if (!realm) return null;

        return {
            currentRealm: realm,
            nextRealm: this.getNextRealm(realm),
            requirement: realm.cultivation_limit,
            bonus: config.breakthrough_bonus || {}
        };
    }

    /**
     * 计算突破成功率
     * @param {Object} player - 玩家对象
     * @param {Object} nextRealm - 下一境界配置
     * @returns {number} 成功率 (0-100)
     */
    calculateBreakthroughProbability(player, nextRealm) {
        const currentRealm = this.getRealmByName(player.realm);
        if (!currentRealm || !nextRealm) {
            throw new Error('境界配置不存在，无法计算突破概率');
        }

        if (currentRealm.breakthrough_probability === undefined) {
            throw new Error(`境界【${currentRealm.name}】未配置突破成功率，请检查配置文件`);
        }

        return currentRealm.breakthrough_probability;
    }
}

module.exports = new RealmService();
