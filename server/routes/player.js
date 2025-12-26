/**
 * 玩家相关路由
 * 处理玩家信息获取、更新等接口
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const { core } = require('../modules');
const authMiddleware = require('../middleware/auth');

/**
 * 获取当前玩家信息
 * GET /api/player/me
 */
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const realmConfig = core.RealmService.getRealmByName(player.realm);
        const fullAttributes = core.AttributeService.calculateFullAttributes(player);
        const lifespanStatus = core.LifespanService.getLifespanStatus(player);
        const expResult = core.ExperienceService.getExpCap(player);
        const canBreakthrough = core.ExperienceService.canBreakthrough(player);

        const responseData = {
            code: 200,
            data: {
                id: player.id,
                username: player.username,
                nickname: player.nickname,
                realm: player.realm,
                role: player.role,
                realmInfo: realmConfig ? {
                    name: realmConfig.name,
                    rank: realmConfig.rank,
                    description: realmConfig.description
                } : null,
                exp: player.exp?.toString() || '0',
                exp_next: expResult.toString(),
                exp_cap: expResult.toString(),
                exp_progress: player.exp && expResult > 0n 
                    ? Math.floor(Number(BigInt(player.exp) * 10000n / expResult) / 10000 * 100) / 100 
                    : 0,
                can_breakthrough: canBreakthrough.canBreak,
                spirit_roots: player.spirit_roots ? {
                    type: player.spirit_roots.type || 'wood',
                    value: player.spirit_roots.value || 0
                } : null,
                spirit_stones: player.spirit_stones?.toString() || '0',
                age: player.age,
                lifespan: lifespanStatus,
                attributes: fullAttributes,
                hp_current: player.hp_current,
                hp_max: fullAttributes.hp_max,
                mp_current: player.mp_current,
                mp_max: fullAttributes.mp_max,
                is_secluded: player.is_secluded || false,
                seclusion_end_time: player.seclusion_end_time,
                created_at: player.created_at,
                updated_at: player.updated_at
            }
        };

        res.json(responseData);
    } catch (error) {
        console.error('获取玩家信息失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误', 
            error: error.message 
        });
    }
});

/**
 * 获取玩家完整属性
 * GET /api/player/attributes
 */
router.get('/attributes', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const fullAttributes = core.AttributeService.calculateFullAttributes(player);
        const battleAttributes = core.AttributeService.getBattleAttributes(player, 'normal');

        res.json({
            code: 200,
            data: {
                basic_attributes: fullAttributes,
                battle_attributes: battleAttributes,
                spirit_root_bonus: core.AttributeService.getSpiritRootBonus(player.spirit_root)
            }
        });
    } catch (error) {
        console.error('获取玩家属性失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 更新玩家信息
 * PUT /api/player/me
 */
router.put('/me', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const updates = req.body;
        const allowedUpdates = [
            'nickname', 'realm', 'exp', 'spirit_stones',
            'lifespan_current', 'lifespan_max', 'attributes',
            'hp_current', 'mp_current', 'toxicity', 'is_secluded',
            'seclusion_end_time'
        ];

        allowedUpdates.forEach(key => {
            if (updates[key] !== undefined) {
                player[key] = updates[key];
            }
        });

        await player.save();

        res.json({
            code: 200,
            message: '更新成功',
            data: {
                id: player.id,
                nickname: player.nickname,
                realm: player.realm,
                updated_at: player.updated_at
            }
        });
    } catch (error) {
        console.error('更新玩家信息失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '更新失败' 
        });
    }
});

/**
 * 获取玩家境界信息
 * GET /api/player/realm
 */
router.get('/realm', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        const currentRealm = core.RealmService.getRealmByName(player.realm);
        const nextRealm = currentRealm ? core.RealmService.getNextRealm(currentRealm) : null;
        const expCap = core.ExperienceService.getExpCap(player);
        const breakthroughCheck = core.ExperienceService.canBreakthrough(player);

        res.json({
            code: 200,
            data: {
                current_realm: currentRealm,
                next_realm: nextRealm,
                exp: player.exp?.toString() || '0',
                exp_cap: expCap.toString(),
                can_breakthrough: breakthroughCheck.canBreak,
                breakthrough_requirement: breakthroughCheck.reason || null
            }
        });
    } catch (error) {
        console.error('获取境界信息失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

/**
 * 执行境界突破
 * POST /api/player/breakthrough
 */
router.post('/breakthrough', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        console.log('开始境界突破，玩家ID:', player.id, '当前境界:', player.realm, '经验:', player.exp?.toString());
        const result = await core.RealmService.breakthrough(player.id);
        console.log('境界突破结果:', result);

        if (result.success) {
            res.json({
                code: 200,
                message: result.message,
                data: {
                    newRealm: result.newRealm
                }
            });
        } else {
            res.status(400).json({
                code: 400,
                message: result.message
            });
        }
    } catch (error) {
        console.error('境界突破失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '服务器错误' 
        });
    }
});

module.exports = router;
