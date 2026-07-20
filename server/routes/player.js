/**
 * 玩家相关路由
 * 处理玩家信息获取、更新等接口
 */
const express = require('express');
const router = express.Router();
const Player = require('../models/player');
const game = require('../game');
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

        const realmConfig = game.RealmService.getRealmByName(player.realm);
        const fullAttributes = game.AttributeService.calculateFullAttributes(player);
        const lifespanStatus = game.LifespanService.getLifespanStatus(player);
        const expResult = game.ExperienceService.getExpCap(player);
        const canBreakthrough = game.ExperienceService.canBreakthrough(player);

        const responseData = {
            code: 200,
            data: {
                id: player.id,
                username: player.username,
                nickname: player.nickname,
                realm: player.realm,
                role: player.role,
                // 新增：暴露 is_dead 字段供前端渲染 DeathOverlay
                // 修复 B3/B4：之前 is_dead 字段从未暴露给前端，前端无法判断玩家是否死亡
                is_dead: player.is_dead || false,
                death_reason: player.death_reason || null,
                realmInfo: realmConfig ? {
                    name: realmConfig.name,
                    rank: realmConfig.rank,
                    description: realmConfig.description
                } : null,
                exp: player.exp?.toString() || '0',
                exp_next: expResult.toString(),
                exp_cap: expResult.toString(),
                exp_progress: game.ExperienceService.calculateExpProgress(player.exp, expResult),
                can_breakthrough: canBreakthrough.canBreak,
                spirit_roots: player.spirit_roots ? {
                    type: player.spirit_roots.type || 'wood',
                    value: player.spirit_roots.value || 0
                } : null,
                spirit_stones: player.spirit_stones?.toString() || '0',
                // 第四阶段新增字段同步暴露给前端（保证前后端数据一致）
                pawnshop_credit: player.pawnshop_credit || 0,        // 当铺信用额度
                pvp_score: player.pvp_score || 0,                    // PVP 段位积分
                pvp_rank: player.pvp_rank || '散修',                 // PVP 段位名称
                honor: player.honor?.toString() || '0',             // 荣誉值（BIGINT 转字符串）
                karma: player.karma || 0,                            // 因果值
                weakness_end_time: player.weakness_end_time,        // 虚弱状态结束时间
                stock_account_balance: player.stock_account_balance?.toString() || '0', // 股市账户余额
                stock_margin_debt: player.stock_margin_debt?.toString() || '0',       // 融资负债金额
                is_stock_trading_locked: player.is_stock_trading_locked || false,     // 股市交易锁定
                // 批次3 飞升+夺舍+后期系统字段（v0031迁移新增，前端用于显示飞升资格/神识/法则等）
                reincarnation_count: player.reincarnation_count || 0,                  // 历史夺舍次数
                ascension_eligible: player.ascension_eligible || 0,                    // 是否满足飞升前置（0否1是）
                second_soul_count: player.second_soul_count || 0,                      // 第二元神数量
                small_world_id: player.small_world_id || null,                        // 所属小世界ID
                dao_companion_id: player.dao_companion_id || null,                    // 道侣关系ID
                concubine_count: player.concubine_count || 0,                         // 侍妾数量
                incense_balance: player.incense_balance || 0,                         // 香火余额
                divine_sense_balance: player.divine_sense_balance || 0,               // 神识余额
                law_points: player.law_points || 0,                                   // 法则点数
                age: player.lifespan_current,
                lifespan: lifespanStatus,
                attributes: fullAttributes.final,
                // 修复 B15：hp_current 是 BIGINT 序列化为 string，hp_max 是 Number，
                // 前端做除法时类型混乱。统一为字符串，前端用 Number/BigInt 显式转换。
                hp_current: player.hp_current?.toString() || '0',
                hp_max: String(fullAttributes.final.hp_max || 0),
                mp_current: player.mp_current?.toString() || '0',
                mp_max: String(fullAttributes.final.mp_max || 0),
                is_secluded: player.is_secluded || false,
                seclusion_end_time: player.seclusion_end_time,
                last_seclusion_time: player.last_seclusion_time,
                created_at: player.created_at,
                updated_at: player.updated_at,
                total_online_time: player.total_online_time || 0
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
 * 轮回重生
 * POST /api/player/reincarnate
 *
 * 玩家寿元耗尽死亡后，可通过此接口轮回重生：
 * 1. 重置 is_dead=false / death_reason=null / death_time=null
 * 2. 重置境界为"凡人"，lifespan_current 重置为初始值，lifespan_max 重置为凡人上限
 * 3. 修为保留 10%（"前世记忆"加成），其余清零
 * 4. 保留 username / nickname / spirit_roots（灵根是天生的）
 * 5. 通过 WebSocket 推送 player_reincarnate 事件，前端刷新数据并隐藏 DeathOverlay
 *
 * 设计依据：玩法简介文档第3节"境界与突破"提到死亡后可通过 .夺舍重生 等流程处理，
 *          本接口为最基础的轮回入口，完整夺舍/重生系统将在后续批次实现。
 */
router.post('/reincarnate', authMiddleware, async (req, res) => {
    const t = await require('../config/database').transaction();
    try {
        const player = req.player;

        if (!player) {
            await t.commit();
            return res.status(404).json({ code: 404, message: '玩家不存在' });
        }

        if (!player.is_dead) {
            await t.commit();
            return res.status(400).json({ code: 400, message: '玩家未死亡，无需轮回' });
        }

        // 读取配置：轮回保留修为比例、初始寿元
        const roleInitConfig = require('../modules').infrastructure.ConfigLoader.getConfig('role_init');
        const initialAge = roleInitConfig?.initialAge ?? 16;
        const initialLifespan = roleInitConfig?.initialLifespan ?? 60;
        const reincarnateExpKeepRate = roleInitConfig?.reincarnateExpKeepRate ?? 0.1;

        // 计算保留修为（10%）
        const oldExp = BigInt(player.exp || 0);
        const keptExp = oldExp * BigInt(Math.round(reincarnateExpKeepRate * 100)) / 100n;

        // 重置玩家状态
        player.is_dead = false;
        player.death_reason = null;
        player.death_time = null;
        player.realm = '凡人';
        player.exp = keptExp;
        player.lifespan_current = initialAge;
        player.lifespan_max = initialLifespan;
        player.hp_current = BigInt(100);   // 凡人基础 HP
        player.mp_current = BigInt(100);   // 凡人基础 MP
        // 重置闭关/悟道/瓶颈等状态，避免残留
        player.is_secluded = false;
        player.is_meditating = false;
        player.bottleneck_state = 'none';
        player.bottleneck_insight = 0;
        player.weakness_end_time = null;

        await player.save({ transaction: t });
        await t.commit();

        // 推送轮回事件给前端
        try {
            const WebSocketNotificationService = require('../game/services/WebSocketNotificationService');
            WebSocketNotificationService.notifyPlayerUpdate(player.id, 'player_reincarnate', {
                message: '轮回成功，重入修仙之道',
                new_realm: '凡人',
                kept_exp: keptExp.toString()
            });
        } catch (e) {
            console.warn('[Player] 推送轮回事件失败:', e.message);
        }

        return res.json({
            code: 200,
            message: '轮回成功，重入轮回道',
            data: {
                is_dead: false,
                realm: '凡人',
                exp: keptExp.toString(),
                lifespan_current: initialAge,
                lifespan_max: initialLifespan
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        console.error('轮回失败:', error);
        return res.status(500).json({
            code: 500,
            message: '轮回失败',
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

        const fullAttributes = game.AttributeService.calculateFullAttributes(player);
        const battleAttributes = game.AttributeService.getBattleAttributes(player, 'normal');

        res.json({
            code: 200,
            data: {
                basic_attributes: fullAttributes,
                battle_attributes: battleAttributes,
                spirit_root_bonus: game.AttributeService.getSpiritRootBonus(player.spirit_roots)
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
        // 仅允许更新非敏感字段，敏感字段（exp/realm/spirit_stones等）需通过专用接口处理
        const allowedUpdates = [
            'nickname', 'is_secluded', 'seclusion_end_time'
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

        const currentRealm = game.RealmService.getRealmByName(player.realm);
        const nextRealm = currentRealm ? game.RealmService.getNextRealm(currentRealm) : null;
        const expCap = game.ExperienceService.getExpCap(player);
        const breakthroughCheck = game.ExperienceService.canBreakthrough(player);

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
        const result = await game.RealmService.breakthrough(player.id);
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

/**
 * 获取玩家进行中状态聚合快照
 * GET /api/player/state
 *
 * 一次性返回玩家所有进行中状态（闭关/战斗/历练/移动/封禁），
 * 替代前端分别调用 3 个 fetch 接口，消除中间态不一致窗口。
 *
 * 适用场景：
 *   - 页面刷新后恢复 UI 状态
 *   - Socket 重连后主动拉取（作为 state:snapshot 推送的兜底）
 *   - GM 后台查询玩家当前状态
 *
 * 响应示例：
 *   {
 *     "code": 200,
 *     "data": {
 *       "player_id": 9,
 *       "server_time": "2026-07-04T...",
 *       "states": {
 *         "seclusion": { "is_secluded": true, "mode": "deep", ... },
 *         "combat": { "in_battle": false },
 *         "adventure": { "is_adventuring": false },
 *         "moving": { "is_moving": false },
 *         "ban": { "is_banned": false }
 *       },
 *       "active_enums": ["SECLUDED"]
 *     }
 *   }
 */
router.get('/state', authMiddleware, async (req, res, next) => {
    try {
        const PlayerStateService = require('../game/services/PlayerStateService');
        const snapshot = await PlayerStateService.getStateSnapshot(req.player.id);
        res.json({
            code: 200,
            data: snapshot
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
