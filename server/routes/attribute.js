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
        const fullAttributesResult = core.AttributeService.calculateFullAttributes(player);
        const maxValues = core.AttributeMaxService.calculateAttributeMaxValues(player, realmConfig);
        
        // 验证当前属性值是否合法
        const validation = core.AttributeMaxService.validateAttributeValues(player, maxValues);
        
        const responseData = {
            code: 200,
            data: {
                // 当前属性值 (包含最终计算的所有加成)
                current: {
                    hp: player.hp_current || 100,
                    mp: player.mp_current || 0,
                    atk: fullAttributesResult.final.atk || 10,
                    def: fullAttributesResult.final.def || 5,
                    speed: fullAttributesResult.final.speed || 10,
                    sense: fullAttributesResult.final.sense || 10,
                    luck: fullAttributesResult.final.luck || 10,
                    wisdom: fullAttributesResult.final.wisdom || 10,
                    physique: fullAttributesResult.final.physique || 10,
                    cultivate_speed: fullAttributesResult.final.cultivate_speed || 10
                },
                // 属性最大值 (使用计算后的最终最大值)
                max: {
                    hp_max: fullAttributesResult.final.hp_max,
                    mp_max: fullAttributesResult.final.mp_max,
                    lifespan_max: maxValues.lifespan_max
                },
                // 属性构成分析
                breakdown: fullAttributesResult.breakdown,
                // 附加信息 (天赋、称号等)
                info: {
                    ...fullAttributesResult.info,
                    all_titles: core.AttributeService.getAllTitles(),
                    owned_titles: player.titles || []
                },
                // 玩家统计数据
                player_stats: player.stats || {},
                // 恢复信息
                recovery: {
                    natural: core.AttributeMaxService.getRecoveryRates('natural'),
                    meditation: core.AttributeMaxService.getRecoveryRates('meditation')
                },
                // 验证结果
                validation: validation,
                // 可分配属性点
                attribute_points: player.attribute_points || 0
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
 * 分配属性点
 * POST /api/attribute/allocate
 */
router.post('/allocate', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        const { points } = req.body;
        
        if (!player) {
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        if (!points || typeof points !== 'object') {
            return res.status(400).json({ 
                code: 400, 
                message: '参数格式错误' 
            });
        }

        const result = await core.AttributeService.allocatePoints(player, points);

        if (result.success) {
            res.json({
                code: 200,
                message: result.message,
                data: {
                    newAttributes: result.newAttributes,
                    remainingPoints: result.remainingPoints
                }
            });
        } else {
            res.status(400).json({
                code: 400,
                message: result.message
            });
        }
    } catch (error) {
        console.error('属性分配失败:', error);
        res.status(500).json({ 
            code: 500, 
            message: '属性分配失败' 
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

/**
 * 装备称号
 * POST /api/attribute/equip_title
 */
router.post('/equip_title', authMiddleware, async (req, res) => {
    try {
        const player = req.player;
        const { title_id } = req.body;
        
        if (!player) {
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        if (!title_id) {
            return res.status(400).json({ code: 400, message: '缺少参数: title_id' });
        }

        const titles = player.titles || [];
        if (!titles.includes(title_id)) {
            return res.status(400).json({ code: 400, message: '未获得该称号' });
        }

        player.equipped_title_id = title_id;
        await player.save();

        res.json({
            code: 200,
            message: '称号装备成功',
            data: {
                equipped_title_id: title_id
            }
        });
    } catch (error) {
        console.error('装备称号失败:', error);
        res.status(500).json({ code: 500, message: '装备称号失败' });
    }
});

module.exports = router;