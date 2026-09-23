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
const PlayerStateStore = require('../game/persistence/PlayerStateStore');

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
        // 这里必须用"完整快照"（含装备/灵兽/功法/傀儡），不能用静态快照：
        // 本接口是给人看的，而 /player/me 的气血条用的就是完整快照。
        // 两者口径不一致时，同一屏会出现"气血上限 3500 / 血条 3657"这种自相矛盾的数字。
        // （静态快照的用途是副本与宗门战开局锁定属性，那是另一条路径。）
        const realmConfig = game.RealmService.getRealmByName(player.realm);
        const fullAttributesResult = await game.AttributeService.calculateFullAttributesAsync(player);
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
                // 属性面板字段定义（标签/图标/说明/后缀来自属性注册表）
                // 前端按这份渲染，新增属性就不需要再改前端的标签表
                panel_schema: game.AttributeService.getPanelSchema(),
                final_attributes: fullAttributesResult.final,
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
 * 属性面板字段定义
 * GET /api/attribute/panel
 *
 * 这条接口是"加属性不用改前端"的最后一环：标签/图标/说明/后缀/显示位置/能否加点
 * 全部来自属性注册表（基础定义 + 已启用的资料片），前端只负责渲染。
 * 内容只在服务端启动时装配一次，客户端按会话缓存即可。
 */
router.get('/panel', authMiddleware, async (req, res) => {
    try {
        const content = require('../game/content').contentRegistry();
        res.json({
            code: 200,
            data: {
                stats: game.AttributeService.getPanelSchema(),
                allocatable: game.AttributeService.allocatableBonusKeys,
                // 非属性类物品效果（气血恢复/灵石/突破加成…）的展示名
                effects: content ? content.effectVocabulary() : []
            }
        });
    } catch (error) {
        console.error('获取属性面板定义失败:', error);
        res.status(500).json({ code: 500, message: '获取属性面板定义失败' });
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

        const realmConfig = game.RealmService.getRealmByName(player.realm);

        // 在行锁内以最新一行为基准重算并写回：
        // 恢复量依赖"当前 hp/mp 与上次结算时点"，用请求开始时的旧快照算会重复结算同一段时间，
        // 整块回写 attributes 又会抹掉这段时间内别的流程（丹药、加点、宗门战）写进去的键。
        const settled = await PlayerStateStore.withTransaction(async (t) => {
            const fresh = await PlayerStateStore.readForUpdate(player.id, { transaction: t });

            const freshMinutes = game.AttributeMaxService.resolveRecoveryMinutes(fresh, duration_minutes);
            if (freshMinutes <= 0) return null;

            const maxValues = game.AttributeMaxService.calculateAttributeMaxValues(fresh, realmConfig);
            const recovery = game.AttributeMaxService.processAttributeRecovery(
                fresh, maxValues, recovery_type, freshMinutes
            );

            const updated = await PlayerStateStore.patchPlayerState(fresh.id, {
                columns: {
                    hp_current: recovery.hp_current,
                    mp_current: recovery.mp_current
                },
                attributes: game.AttributeMaxService.buildRecoveryWatermarkPatch()
            }, { transaction: t });

            return { recovery, freshMinutes, updated };
        });

        if (!settled) {
            return res.status(400).json({
                code: 400,
                message: '距上次恢复结算时间过短，暂无可恢复时长'
            });
        }

        res.json({
            code: 200,
            data: {
                recovery_type: recovery_type,
                requested_minutes: Number(duration_minutes) || null,
                duration_minutes: settled.freshMinutes,
                recovered: settled.recovery.recovered,
                new_values: {
                    hp: settled.recovery.hp_current,
                    mp: settled.recovery.mp_current
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
        // 基准必须是行锁内最新一行的 attributes：丹药物品行虽然已 FOR UPDATE，
        // 但 players 行此前从未加锁，双提交同一颗丹药时两次"读旧 attributes → 整块写回"
        // 只会加一次加成，而数量却会正确地扣两次。
        const fresh = await PlayerStateStore.readForUpdate(player.id, { transaction: t });
        const nextAttributes = game.AttributeMaxService.applyPillBonusToAttributes(
            fresh.attributes,
            pillEffect
        );

        const updated = await PlayerStateStore.patchPlayerState(
            player.id,
            { attributes: nextAttributes },
            { transaction: t }
        );

        // 消耗丹药（数量减1）
        await playerItem.decrement('quantity', { transaction: t });

        // 回显使用后的属性上限（用写回后的那一行，避免把刚加成的键再算一遍）
        const newMaxValues = game.AttributeMaxService.applyPillEffect(updated, pillEffect);
        
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

        // 一次键级落库：扣费与退点走列上原子加减，attributes 只发补丁（回收的那几个键 $add 负增量、
        // 账本删键、冷却时点写一个键）。以前这里是"改这份实例 + save 整行"，
        // 会把这一坨 blob 里别的流程（丹药、神识、各玩法）写的键按手上这份快照一起盖回去。
        const updated = await PlayerStateStore.patchPlayerState(req.user.id, {
            amounts: {
                spirit_stones: -resetConfig.cost_spirit_stones,
                attribute_points: resetPlan.refundablePoints
            },
            attributes: game.AttributeService.buildAttributesResetPatch(resetPlan)
        }, { transaction: t });
        // 回执与随后的 calculateFullAttributes 都读落库那一份；这一行不再参与整块写回
        PlayerStateStore.mirrorPatchedBlob(player, updated);
        for (const column of ['spirit_stones', 'attribute_points']) player.setDataValue(column, updated.getDataValue(column));

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