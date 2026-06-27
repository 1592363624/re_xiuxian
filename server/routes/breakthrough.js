/**
 * 突破相关路由
 * 处理境界突破相关接口
 */
const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const game = require('../game');
const NotificationService = require('../game/services/NotificationService');
const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
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

        const player = await Player.findByPk(playerId, { 
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

        const probability = game.RealmService.calculateBreakthroughProbability(player, nextRealm);
        const roll = Math.random() * 100;
        const success = roll < probability;

        if (!success) {
            // 突破失败：在事务内处理修为损失和年龄增加（使用配置文件中的惩罚数值）
            const expLoss = BigInt(Math.floor(Number(player.exp) * FAILURE_EXP_LOSS_RATE));
            player.exp = BigInt(player.exp) - expLoss;
            
            const ageIncrease = currentRealm.rank * FAILURE_AGE_MULTIPLIER;
            player.lifespan_current = (player.lifespan_current || 0) + ageIncrease;
            
            // 在事务内保存玩家数据
            await player.save({ transaction: t });
            await t.commit();

            // 通过 WebSocket 推送玩家数据更新（失败时修为和年龄已变化，需同步给前端）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(player.id, 'breakthrough_failure', {
                    realm: player.realm,
                    exp: player.exp.toString(),
                    lifespan_current: player.lifespan_current,
                    exp_loss: expLoss.toString(),
                    age_increase: ageIncrease
                });
            } catch (wsError) {
                console.error('WebSocket 推送突破失败更新失败:', wsError);
            }

            return res.json({
                code: 200,
                success: false,
                message: `突破失败！损失 ${expLoss.toString()} 点修为，年龄增加 ${ageIncrease} 岁`,
                data: {
                    realm: player.realm,
                    exp: player.exp.toString(),
                    exp_cap: canBreakthrough.expCap,
                    next_realm: nextRealm.name,
                    probability: probability,
                    rolled: roll.toFixed(2),
                    exp_loss: expLoss.toString(),
                    age_increase: ageIncrease
                }
            });
        }

        // 突破成功：更新境界
        const oldRealm = player.realm;
        player.realm = nextRealm.name;

        // 更新突破后的属性
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

        // 通过 WebSocket 推送玩家数据更新
        try {
            WebSocketNotificationService.notifyPlayerUpdate(player.id, 'breakthrough', {
                realm: nextRealm.name,
                exp: player.exp.toString(),
                attributes: player.attributes
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
                new_lifespan_max: nextRealm.lifespan_max
            }
        });
    } catch (error) {
        await t.rollback();
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
        
        const probability = nextRealm 
            ? game.RealmService.calculateBreakthroughProbability(player, nextRealm)
            : 0;

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
                    : null
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
