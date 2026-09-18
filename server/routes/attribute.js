/**
 * 属性系统相关路由
 * 处理属性最大值、恢复、丹药效果等接口
 */
const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');
const game = require('../game');
const authMiddleware = require('../middleware/auth');
const Item = require('../models/item');
const Player = require('../models/player');

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
        const realmConfig = game.RealmService.getRealmByName(player.realm);
        const fullAttributesResult = game.AttributeService.calculateFullAttributes(player);
        const maxValues = game.AttributeMaxService.calculateAttributeMaxValues(player, realmConfig);
        const expCap = game.ExperienceService.getExpCap(player);
        
        // 验证当前属性值是否合法
        const validation = game.AttributeMaxService.validateAttributeValues(player, maxValues);
        
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
                    cultivate_speed: fullAttributesResult.final.cultivate_speed || 10
                },
                // 属性最大值 (使用计算后的最终最大值)
                max: {
                    hp_max: fullAttributesResult.final.hp_max,
                    mp_max: fullAttributesResult.final.mp_max,
                    lifespan_max: maxValues.lifespan_max
                },
                // 经验值信息
                exp: {
                    current: player.exp || 0,
                    cap: expCap.toString()
                },
                // 属性构成分析
                breakdown: fullAttributesResult.breakdown,
                // 附加信息 (天赋、称号等)
                info: {
                    ...fullAttributesResult.info,
                    all_titles: game.AttributeService.getAllTitles(),
                    owned_titles: player.titles || []
                },
                // 玩家统计数据
                player_stats: player.stats || {},
                // 恢复信息
                recovery: {
                    natural: game.AttributeMaxService.getRecoveryRates('natural'),
                    meditation: game.AttributeMaxService.getRecoveryRates('meditation')
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

        const result = await game.AttributeService.allocatePoints(player, points);

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
 *
 * 安全说明：可结算时长由服务端时钟推导（上次恢复结算时点 → 服务器当前时间），
 * duration_minutes 只用于缩短结算区间，客户端无法凭它放大恢复量或瞬间回满。
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

        if (!recovery_type) {
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：recovery_type' 
            });
        }

        if (recovery_type !== 'natural' && recovery_type !== 'meditation') {
            return res.status(400).json({ 
                code: 400, 
                message: '恢复类型必须是 natural 或 meditation' 
            });
        }

        const settledMinutes = game.AttributeMaxService.resolveRecoveryMinutes(player, duration_minutes);
        if (settledMinutes <= 0) {
            return res.status(400).json({
                code: 400,
                message: '距上次恢复结算时间过短，暂无可恢复时长'
            });
        }

        // 计算属性最大值
        const realmConfig = game.RealmService.getRealmByName(player.realm);
        const maxValues = game.AttributeMaxService.calculateAttributeMaxValues(player, realmConfig);
        
        // 处理属性恢复
        const recoveryResult = game.AttributeMaxService.processAttributeRecovery(
            player, 
            maxValues, 
            recovery_type, 
            settledMinutes
        );

        // 更新玩家属性与恢复结算基准时点（本次窗口一经消费即作废，不累积到下次）
        await player.update({
            hp_current: recoveryResult.hp_current,
            mp_current: recoveryResult.mp_current,
            attributes: game.AttributeMaxService.buildAttributesAfterRecovery(player)
        });

        res.json({
            code: 200,
            data: {
                recovery_type: recovery_type,
                requested_minutes: Number(duration_minutes) || null,
                duration_minutes: settledMinutes,
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
 *
 * 安全说明：客户端只传 pill_id，丹药效果由服务端 config/item_data.json 查表得出，
 * 属性键名与数值均经白名单与上限钳制，不接受客户端提交的 pill_effect。
 */
router.post('/use_pill', authMiddleware, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const player = req.player;
        const { pill_id } = req.body;
        
        if (!player) {
            await t.rollback();
            return res.status(404).json({ 
                code: 404, 
                message: '玩家不存在' 
            });
        }

        if (!pill_id || typeof pill_id !== 'string') {
            await t.rollback();
            return res.status(400).json({ 
                code: 400, 
                message: '缺少必要参数：pill_id' 
            });
        }

        // 服务端解析丹药效果，未配置永久属性上限加成的物品不可在此使用
        const pillEffect = game.AttributeMaxService.getPillMaxIncreaseEffect(pill_id);
        if (!pillEffect) {
            await t.rollback();
            return res.status(400).json({
                code: 400,
                message: '该丹药没有永久属性上限加成效果，无法在此使用'
            });
        }

        // 验证玩家是否拥有该丹药（行级锁：防止并发重复消耗同一颗丹药）
        const playerItem = await Item.findOne({
            where: { 
                player_id: player.id, 
                item_key: pill_id 
            },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        if (!playerItem || playerItem.quantity < 1) {
            await t.rollback();
            return res.status(400).json({ 
                code: 400, 
                message: '未拥有该丹药或数量不足' 
            });
        }

        // 累加属性加成并钳制单属性总量上限
        const currentAttributes = typeof player.attributes === 'string' 
            ? JSON.parse(player.attributes) 
            : (player.attributes || {});
        const nextAttributes = game.AttributeMaxService.applyPillBonusToAttributes(
            currentAttributes,
            pillEffect
        );

        await player.update({
            attributes: nextAttributes
        }, { transaction: t });

        // 消耗丹药（数量减1）
        await playerItem.decrement('quantity', { transaction: t });

        // 回显使用后的属性上限
        const newMaxValues = game.AttributeMaxService.applyPillEffect(player, pillEffect);
        
        await t.commit();
        
        res.json({
            code: 200,
            data: {
                pill_id: pill_id,
                effect_type: pillEffect.type,
                applied: pillEffect.attributes,
                new_max_values: newMaxValues,
                remaining_quantity: playerItem.quantity - 1,
                message: '丹药使用成功'
            }
        });
    } catch (error) {
        await t.rollback();
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

/**
 * 重置属性加点
 * POST /api/attribute/reset
 *
 * 规则（attribute_system.json: attribute_reset）：消耗灵石、按冷却限次，
 * 只回收"加点账本"里记录的点数——丹药等其他来源的 *_bonus 既不被扣掉，也不折算成可分配点数。
 */
router.post('/reset', authMiddleware, async (req, res) => {
    const t = await sequelize.transaction();
    try {
        // 行级锁：防止并发重置重复退点
        const player = await Player.findByPk(req.user.id, {
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        if (!player) {
            await t.rollback();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }
        if (player.is_dead) {
            await t.rollback();
            return res.status(400).json({ code: 400, message: '已陨落，无法重置属性点' });
        }

        const resetConfig = game.AttributeService.getAttributeResetConfig();
        const lastResetAt = new Date(player.attributes?.last_attribute_reset_time || 0).getTime();
        if (Number.isFinite(lastResetAt) && lastResetAt > 0) {
            const elapsedMinutes = (Date.now() - lastResetAt) / 60000;
            if (elapsedMinutes < resetConfig.cooldown_minutes) {
                await t.rollback();
                return res.status(400).json({
                    code: 400,
                    message: `重置冷却中，还需等待 ${Math.ceil(resetConfig.cooldown_minutes - elapsedMinutes)} 分钟`
                });
            }
        }

        const resetPlan = game.AttributeService.buildAllocatedPointsReset(player);
        if (resetPlan.refundablePoints <= 0) {
            await t.rollback();
            return res.status(400).json({ code: 400, message: '没有可回收的属性加点' });
        }

        if (Number(player.spirit_stones) < resetConfig.cost_spirit_stones) {
            await t.rollback();
            return res.status(400).json({
                code: 400,
                message: `灵石不足，重置需要 ${resetConfig.cost_spirit_stones} 灵石`
            });
        }

        player.spirit_stones = Number(player.spirit_stones) - resetConfig.cost_spirit_stones;
        player.attribute_points = (Number(player.attribute_points) || 0) + resetPlan.refundablePoints;
        player.attributes = game.AttributeService.buildAttributesAfterReset(resetPlan);
        await player.save({ transaction: t });

        await t.commit();

        const fullAttributesResult = game.AttributeService.calculateFullAttributes(player);

        res.json({
            code: 200,
            message: `属性点重置成功，回收 ${resetPlan.refundablePoints} 点`,
            data: {
                refunded_points: resetPlan.refundablePoints,
                refunded: resetPlan.refunded,
                cost_spirit_stones: resetConfig.cost_spirit_stones,
                attribute_points: player.attribute_points,
                spirit_stones: String(player.spirit_stones || 0),
                current: fullAttributesResult.final
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        console.error('属性点重置失败:', error);
        res.status(500).json({ code: 500, message: '属性点重置失败' });
    }
});

module.exports = router;