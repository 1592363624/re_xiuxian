/**
 * 属性系统相关路由
 * 处理属性最大值、恢复、丹药效果等接口
 */
const express = require('express');
const router = express.Router();
const { core } = require('../modules');
const authMiddleware = require('../middleware/auth');

/**
 * 获取玩家完整属性信息（包含最大值）
 * GET /api/attribute/full
 */
router.get('/full', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        // 计算完整属性（包含最大值）
        const realmConfig = core.RealmService.getRealmByName(player.realm);
        const fullAttributes = core.AttributeService.calculateFullAttributes(player);
        const maxValues = core.AttributeMaxService.calculateAttributeMaxValues(player, realmConfig);
        
        // 验证当前属性值是否合法
        const validation = core.AttributeMaxService.validateAttributeValues(player, maxValues);
        
        const responseData = {
            code: 200,
            data: {
                // 当前属性值
                current: {
                    hp: player.hp_current || 100,
                    mp: player.mp_current || 0,
                    atk: fullAttributes.atk || 10,
                    def: fullAttributes.def || 5,
                    speed: fullAttributes.speed || 10,
                    sense: fullAttributes.sense || 10,
                    luck: fullAttributes.luck || 10,
                    wisdom: fullAttributes.wisdom || 10
                },
                // 属性最大值
                max: maxValues,
                // 恢复信息
                recovery: {
                    natural: core.AttributeMaxService.getRecoveryRates('natural'),
                    meditation: core.AttributeMaxService.getRecoveryRates('meditation')
                },
                // 验证结果
                validation: validation
            }
        };

        res.json(responseData);
    } catch (error) {
        console.error('获取属性信息失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '获取属性信息失败' 
        });
    }
});

/**
 * 恢复属性（自然恢复或打坐恢复）
 * POST /api/attribute/recover
 */
router.post('/recover', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        const { recovery_type, duration_minutes } = req.body;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        if (!recovery_type || !duration_minutes) {
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：recovery_type, duration_minutes' 
            });
        }

        if (recovery_type !== 'natural' && recovery_type !== 'meditation') {
            return res.status(400).json({ 
                code: 400, 
                message: '恢复类型必须是 natural 或 meditation' 
            });
        }

        // 计算属性最大值
        const realmConfig = core.RealmService.getRealmByName(player.realm);
        const maxValues = core.AttributeMaxService.calculateAttributeMaxValues(player, realmConfig);
        
        // 处理属性恢复
        const recoveryResult = core.AttributeMaxService.processAttributeRecovery(
            player, 
            maxValues, 
            recovery_type, 
            duration_minutes
        );

        // 更新玩家属性
        await player.update({
            hp_current: recoveryResult.hp_current,
            mp_current: recoveryResult.mp_current
        });

        res.json({
            code: 200,
            data: {
                recovery_type: recovery_type,
                duration_minutes: duration_minutes,
                recovered: recoveryResult.recovered,
                new_values: {
                    hp: recoveryResult.hp_current,
                    mp: recoveryResult.mp_current
                }
            }
        });
    } catch (error) {
        console.error('属性恢复失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '属性恢复失败' 
        });
    }
});

/**
 * 使用丹药提升属性最大值
 * POST /api/attribute/use_pill
 */
router.post('/use_pill', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        const { pill_id, pill_effect } = req.body;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        if (!pill_id || !pill_effect) {
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：pill_id, pill_effect' 
            });
        }

        // TODO: 验证玩家是否拥有该丹药
        // 这里需要集成物品系统来检查丹药所有权
        
        // 应用丹药效果
        const newMaxValues = core.AttributeMaxService.applyPillEffect(player, pill_effect);
        
        // 更新玩家属性（这里需要根据丹药类型决定如何更新）
        if (pill_effect.type === 'permanent_max_increase') {
            // 永久提升 - 更新属性加成
            const currentAttributes = typeof player.attributes === 'string' 
                ? JSON.parse(player.attributes) 
                : (player.attributes || {});
            
            for (const [attrKey, increase] of Object.entries(pill_effect.attributes)) {
                const bonusKey = `${attrKey}_bonus`;
                currentAttributes[bonusKey] = (currentAttributes[bonusKey] || 0) + increase;
            }
            
            await player.update({
                attributes: currentAttributes
            });
        }

        // TODO: 消耗丹药
        
        res.json({
            code: 200,
            data: {
                pill_id: pill_id,
                effect_type: pill_effect.type,
                new_max_values: newMaxValues,
                message: '丹药使用成功'
            }
        });
    } catch (error) {
        console.error('使用丹药失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '使用丹药失败' 
        });
    }
});

module.exports = router;