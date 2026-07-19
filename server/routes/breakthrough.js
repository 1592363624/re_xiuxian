/**
 * 突破相关路由
 * 处理境界突破相关接口
 *
 * 第三阶段改造：集成瓶颈系统
 * 1. 突破前检查是否进入瓶颈期（瓶颈境界需先悟道积累感悟）
 * 2. 瓶颈未破除时拒绝突破，引导玩家进行静思悟道
 * 3. 突破失败调用 handleBreakthroughFailure 累加失败次数和感悟补偿
 * 4. 突破成功调用 handleBreakthroughSuccess 清理瓶颈状态
 */
const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const game = require('../game');
const NotificationService = require('../game/services/NotificationService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
// 引入宗门服务（导出单例实例），用于获取突破成功率加成
const SectService = require('../game/services/SectService');
const MeditationService = require('../game/services/MeditationService');
// 引入元婴服务（用于高阶境界突破的虚弱惩罚、问道加成、突破成功后清零感悟）
const NascentSoulService = require('../game/services/NascentSoulService');
const authenticateToken = require('../middleware/auth');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');
const ConfigHelper = require('../utils/configHelper');

// 使用 ConfigHelper 安全读取突破惩罚数值，提供默认值
const FAILURE_EXP_LOSS_RATE = ConfigHelper.getNumericConfig(
    'game_balance', 'breakthrough.failure_exp_loss_rate', 0.1, 0, 1
);
const FAILURE_AGE_MULTIPLIER = ConfigHelper.getNumericConfig(
    'game_balance', 'breakthrough.failure_age_multiplier', 1, 0, 100
);

/**
 * 尝试境界突破
 * POST /api/breakthrough/try
 */
router.post('/try', authenticateToken, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = req.user?.id;
        
        if (!playerId) {
            await t.rollback();
            throw new AppError('未登录或登录已过期', 401, ErrorCodes.UNAUTHORIZED);
        }

        // 行级锁：防止并发突破与瓶颈状态变更冲突
        const player = await Player.findByPk(playerId, { 
            lock: t.LOCK.UPDATE,
            transaction: t, 
        });
        
        if (!player) {
            await t.rollback();
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const currentRealm = game.RealmService.getRealmByName(player.realm);
        if (!currentRealm) {
            await t.rollback();
            throw new AppError('当前境界数据异常，无法突破', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const nextRealm = game.RealmService.getNextRealm(currentRealm);
        if (!nextRealm) {
            await t.rollback();
            throw new AppError('已是最高境界，无法继续突破', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const canBreakthrough = game.ExperienceService.canBreakthrough(player);
        if (!canBreakthrough.canBreak) {
            await t.rollback();
            throw new AppError(canBreakthrough.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 瓶颈系统：检查并触发瓶颈状态
        const bottleneckCheck = MeditationService.checkAndTriggerBottleneck(player, nextRealm);
        if (bottleneckCheck.triggered) {
            // 触发瓶颈：保存状态后拒绝本次突破
            await player.save({ transaction: t });
            await t.commit();

            return res.json({
                code: 200,
                success: false,
                bottleneck_triggered: true,
                message: bottleneckCheck.reason,
                data: {
                    realm: player.realm,
                    bottleneck_state: player.bottleneck_state,
                    bottleneck_threshold: player.bottleneck_threshold,
                    bottleneck_insight: player.bottleneck_insight,
                    hint: '请通过静思悟道积累感悟，破除瓶颈后再尝试突破'
                }
            });
        }

        // 瓶颈校验：若当前处于瓶颈期且未破除，拒绝突破
        if (player.bottleneck_state === 'active') {
            await t.commit();
            return res.json({
                code: 200,
                success: false,
                bottleneck_active: true,
                message: `当前处于瓶颈期，需积累感悟 ${player.bottleneck_threshold - player.bottleneck_insight} 点方可破除瓶颈`,
                data: {
                    realm: player.realm,
                    bottleneck_state: player.bottleneck_state,
                    bottleneck_insight: player.bottleneck_insight,
                    bottleneck_threshold: player.bottleneck_threshold,
                    hint: '请通过静思悟道积累感悟'
                }
            });
        }

        // 计算成功率：瓶颈已破除时提供额外加成
        let probability = game.RealmService.calculateBreakthroughProbability(player, nextRealm);
        const btCfg = MeditationService.getBreakthroughConfig();
        if (player.bottleneck_state === 'broken' && btCfg.broken_breakthrough_bonus) {
            probability = Math.min(100, probability + (btCfg.broken_breakthrough_bonus || 0));
        }

        // 获取宗门突破加成
        let finalProbability = probability;
        try {
            const sectInfo = await SectService.getPlayerSectBonus(player.id);
            const breakthroughBonus = sectInfo.bonus?.breakthrough_bonus || 0;
            finalProbability = Math.min(100, finalProbability + breakthroughBonus * 100);
        } catch (e) {
            finalProbability = probability;
        }

        // 高阶境界系统：问道感悟值加成（每10点感悟提供1%加成，最高20%）
        const askDaoBonus = NascentSoulService.getAskDaoBreakthroughBonus(player);
        if (askDaoBonus > 0) {
            finalProbability = Math.min(100, finalProbability + askDaoBonus);
        }

        // 高阶境界系统：虚弱状态惩罚（默认-20%突破成功率）
        const weaknessPenalty = NascentSoulService.getWeaknessBreakthroughPenalty(player);
        if (weaknessPenalty > 0) {
            finalProbability = Math.max(0, finalProbability - weaknessPenalty);
        }

        const roll = Math.random() * 100;
        const success = roll < finalProbability;

        if (!success) {
            // 突破失败：处理修为损失和年龄增加
            const expLoss = BigInt(Math.floor(Number(player.exp) * FAILURE_EXP_LOSS_RATE));
            player.exp = BigInt(player.exp) - expLoss;

            const ageIncrease = currentRealm.rank * FAILURE_AGE_MULTIPLIER;
            player.lifespan_current = (player.lifespan_current || 0) + ageIncrease;

            // 瓶颈失败处理：累加失败次数，提供感悟补偿
            const failureResult = await MeditationService.handleBreakthroughFailure(player, t);

            // 高阶境界系统：突破失败触发虚弱状态（持续1小时）
            // 仅对化神及以上境界生效（rank >= 23），低境界保持原有惩罚逻辑
            const currentRealmRank = currentRealm.rank || 0;
            if (currentRealmRank >= 23) {
                try {
                    await NascentSoulService.triggerWeakness(player, null, t);
                } catch (weakErr) {
                    console.warn('[Breakthrough] 触发虚弱状态失败:', weakErr.message);
                }
            }

            await player.save({ transaction: t });
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'breakthrough_failure', {
                    realm: player.realm,
                    exp: player.exp.toString(),
                    lifespan_current: player.lifespan_current,
                    exp_loss: expLoss.toString(),
                    age_increase: ageIncrease,
                    bottleneck_state: player.bottleneck_state,
                    bottleneck_insight: player.bottleneck_insight,
                    bottleneck_broken: failureResult.bottleneck_broken
                });
            } catch (wsError) {
                console.error('WebSocket 推送突破失败更新失败:', wsError);
            }

            const failureMsg = failureResult.bottleneck_broken
                ? `突破失败！损失 ${expLoss.toString()} 点修为，年龄增加 ${ageIncrease} 岁。然瓶颈已破，下次突破将获得成功率加成！`
                : `突破失败！损失 ${expLoss.toString()} 点修为，年龄增加 ${ageIncrease} 岁`;

            return res.json({
                code: 200,
                success: false,
                message: failureMsg,
                data: {
                    realm: player.realm,
                    exp: player.exp.toString(),
                    exp_cap: canBreakthrough.expCap,
                    next_realm: nextRealm.name,
                    probability: finalProbability,
                    rolled: roll.toFixed(2),
                    exp_loss: expLoss.toString(),
                    age_increase: ageIncrease,
                    bottleneck_state: player.bottleneck_state,
                    bottleneck_insight: player.bottleneck_insight,
                    bottleneck_threshold: player.bottleneck_threshold,
                    bottleneck_broken: failureResult.bottleneck_broken,
                    failure_count: failureResult.failure_count
                }
            });
        }

        // 突破成功：更新境界
        const oldRealm = player.realm;
        player.realm = nextRealm.name;

        if (nextRealm.base_hp) {
            const attrs = typeof player.attributes === 'string' 
                ? JSON.parse(player.attributes) 
                : (player.attributes || {});
            attrs.hp_max = nextRealm.base_hp;
            attrs.mp_max = nextRealm.base_mp;
            attrs.atk = nextRealm.base_atk;
            attrs.def = nextRealm.base_def;
            player.attributes = attrs;
        }

        player.lifespan_max = nextRealm.base_lifespan || player.lifespan_max;
        player.hp_current = nextRealm.base_hp || player.hp_current;
        player.mp_current = nextRealm.base_mp || player.mp_current;

        // 瓶颈成功处理：清理瓶颈状态
        await MeditationService.handleBreakthroughSuccess(player, t);

        // 高阶境界系统：突破成功后清零问道感悟值（感悟已用于本次突破）
        if (player.ask_dao_insight && player.ask_dao_insight > 0) {
            try {
                await NascentSoulService.clearAskDaoInsightOnBreakthrough(player, t);
            } catch (clearErr) {
                console.warn('[Breakthrough] 清零问道感悟失败:', clearErr.message);
            }
        }

        await player.save({ transaction: t });
        await t.commit();

        const newExpCap = game.ExperienceService.getExpCap(player);
        const attributeGain = game.ExperienceService.getBreakthroughAttributeGain(oldRealm, nextRealm.name);

        try {
            await NotificationService.sendBreakthroughNotification(
                { id: player.id, nickname: player.nickname },
                oldRealm,
                nextRealm.name
            );
        } catch (notificationError) {
            console.error('发送突破通知失败:', notificationError);
        }

        try {
            WebSocketNotificationService.notifyPlayerUpdate(player.id, 'breakthrough', {
                realm: nextRealm.name,
                exp: player.exp.toString(),
                attributes: player.attributes,
                bottleneck_state: player.bottleneck_state
            });
        } catch (wsError) {
            console.error('WebSocket 推送突破更新失败:', wsError);
        }

        return res.json({
            code: 200,
            success: true,
            message: `突破成功！从 ${oldRealm} 晋升为 ${nextRealm.name}`,
            data: {
                old_realm: oldRealm,
                new_realm: nextRealm.name,
                exp: player.exp.toString(),
                exp_cap: newExpCap.toString(),
                attribute_gain: attributeGain,
                new_hp_max: nextRealm.base_hp,
                new_mp_max: nextRealm.base_mp,
                new_lifespan_max: nextRealm.lifespan_max,
                bottleneck_state: player.bottleneck_state
            }
        });
    } catch (error) {
        // 修复：仅在事务未完成时回滚，避免对已 rollback/commit 的事务重复操作导致服务崩溃
        if (t && !t.finished) {
            await t.rollback();
        }
        next(error);
    }
});

/**
 * 获取突破信息
 * GET /api/breakthrough/info
 */
router.get('/info', authenticateToken, async (req, res, next) => {
    try {
        const playerId = req.user?.id;
        
        if (!playerId) {
            throw new AppError('未登录或登录已过期', 401, ErrorCodes.UNAUTHORIZED);
        }

        const player = await Player.findByPk(playerId);
        
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const currentRealm = game.RealmService.getRealmByName(player.realm);
        const nextRealm = currentRealm ? game.RealmService.getNextRealm(currentRealm) : null;
        const expCap = game.ExperienceService.getExpCap(player);
        const canBreakthrough = game.ExperienceService.canBreakthrough(player);
        
        let probability = nextRealm 
            ? game.RealmService.calculateBreakthroughProbability(player, nextRealm)
            : 0;

        // 瓶颈已破除时提供额外加成
        const btCfg = MeditationService.getBreakthroughConfig();
        let bottleneckBonus = 0;
        if (player.bottleneck_state === 'broken' && btCfg.broken_breakthrough_bonus) {
            bottleneckBonus = btCfg.broken_breakthrough_bonus;
            probability = Math.min(100, probability + bottleneckBonus);
        }

        // 判断是否处于瓶颈境界
        const bottleneckRealms = btCfg.bottleneck_realms || [];
        const inBottleneckRealm = bottleneckRealms.includes(player.realm_rank || 0);

        // 高阶境界系统信息：问道感悟加成 + 虚弱状态惩罚
        const askDaoBonus = NascentSoulService.getAskDaoBreakthroughBonus(player);
        const weaknessPenalty = NascentSoulService.getWeaknessBreakthroughPenalty(player);
        const isWeak = NascentSoulService.isWeak(player);
        const dharmaFormBonus = NascentSoulService.getDharmaFormBonus(player);

        res.json({
            code: 200,
            data: {
                current_realm: currentRealm,
                next_realm: nextRealm,
                current_exp: player.exp?.toString() || '0',
                exp_cap: expCap.toString(),
                can_breakthrough: canBreakthrough.canBreak,
                breakthrough_probability: probability,
                attribute_gain: nextRealm && currentRealm
                    ? game.ExperienceService.getBreakthroughAttributeGain(currentRealm.name, nextRealm.name)
                    : null,
                // 瓶颈系统信息
                bottleneck: {
                    enabled: btCfg.bottleneck_enabled !== false,
                    state: player.bottleneck_state || 'none',
                    in_bottleneck_realm: inBottleneckRealm,
                    insight: player.bottleneck_insight || 0,
                    threshold: player.bottleneck_threshold || 100,
                    failure_count: player.breakthrough_failure_count || 0,
                    max_failure_count: btCfg.bottleneck_max_failure_count || 3,
                    broken_bonus: bottleneckBonus,
                    started_at: player.bottleneck_started_at
                },
                // 高阶境界系统信息（化神及以上境界展示）
                high_realm: {
                    ask_dao_bonus: askDaoBonus,                       // 问道感悟提供的突破加成（百分比）
                    ask_dao_insight: player.ask_dao_insight || 0,     // 当前问道感悟值
                    is_weak: isWeak,                                  // 是否处于虚弱状态
                    weakness_penalty: weaknessPenalty,                // 虚弱提供的突破惩罚（百分比）
                    weakness_end_time: player.weakness_end_time || null,
                    dharma_form_level: player.dharma_form_level || 0, // 法相天地等级
                    dharma_form_bonus: dharmaFormBonus,               // 法相天地属性加成系数
                    remnant_soul: player.remnant_soul ?? 100          // 残魂值
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
