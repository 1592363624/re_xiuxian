/**
 * 突破相关路由
 * 处理境界突破相关接口
 */
const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const Player = require('../models/player');
const { core } = require('../modules');

/**
 * 尝试境界突破
 * POST /api/breakthrough/try
 */
router.post('/try', async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const playerId = req.user?.id || req.headers['x-player-id'];
        
        if (!playerId) {
            await t.rollback();
            return res.status(401).json({ 
                code: 401, 
                message: '未登录或登录已过期' 
            });
        }

        const player = await Player.findByPk(playerId, { 
            transaction: t, 
        });
        
        if (!player) {
            await t.rollback();
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const currentRealm = core.RealmService.getRealmConfig(player.realm);
        if (!currentRealm) {
            await t.rollback();
            return res.status(400).json({ 
                code: 400, 
                message: '当前境界数据异常，无法突破' 
            });
        }

        const nextRealm = core.RealmService.getNextRealm(currentRealm);
        if (!nextRealm) {
            await t.rollback();
            return res.status(400).json({ 
                code: 400, 
                message: '已是最高境界，无法继续突破' 
            });
        }

        const canBreakthrough = core.ExperienceService.canBreakthrough(player);
        if (!canBreakthrough.canBreak) {
            await t.rollback();
            return res.status(400).json({
                code: 400,
                message: canBreakthrough.reason,
                data: {
                    current_exp: canBreakthrough.currentExp,
                    required_exp: canBreakthrough.requiredExp
                }
            });
        }

        const probability = core.RealmService.calculateBreakthroughProbability(player, nextRealm);
        const roll = Math.random() * 100;
        const success = roll < probability;

        if (!success) {
            await t.commit();
            
            const expLoss = BigInt(Math.floor(Number(player.exp) * 0.1));
            player.exp = BigInt(player.exp) - expLoss;
            
            const ageIncrease = currentRealm.rank * 2;
            player.lifespan_current = (player.lifespan_current || 0) + ageIncrease;
            await player.save();

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

        const oldRealm = player.realm;
        player.realm = nextRealm.name;

        const newExpCap = core.ExperienceService.getExpCap(player);
        player.exp = player.exp;

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

        player.lifespan_max = nextRealm.lifespan_max || player.lifespan_max;
        player.hp_current = nextRealm.base_hp || player.hp_current;
        player.mp_current = nextRealm.base_mp || player.mp_current;

        await player.save({ transaction: t });
        await t.commit();

        const attributeGain = core.ExperienceService.getBreakthroughAttributeGain(oldRealm, nextRealm.name);

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
        console.error('突破失败:', error);
        return res.status(500).json({ 
            code: 500, 
            message: '服务器错误',
            error: error.message 
        });
    }
});

/**
 * 获取突破信息
 * GET /api/breakthrough/info
 */
router.get('/info', async (req, res) => {
    try {
        const playerId = req.user?.id || req.headers['x-player-id'];
        
        if (!playerId) {
            return res.status(401).json({ 
                code: 401, 
                message: '未登录或登录已过期' 
            });
        }

        const player = await Player.findByPk(playerId);
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const currentRealm = core.RealmService.getRealmConfig(player.realm);
        const nextRealm = currentRealm ? core.RealmService.getNextRealm(currentRealm) : null;
        const expCap = core.ExperienceService.getExpCap(player);
        const canBreakthrough = core.ExperienceService.canBreakthrough(player);
        
        const probability = nextRealm 
            ? core.RealmService.calculateBreakthroughProbability(player, nextRealm)
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
                    ? core.ExperienceService.getBreakthroughAttributeGain(currentRealm.name, nextRealm.name)
                    : null
            }
        });
    } catch (error) {
        console.error('获取突破信息失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

module.exports = router;
