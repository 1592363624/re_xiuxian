/**
 * GM 后台灵兽系统管理路由
 *
 * 提供灵兽系统的GM管理接口（参考 docs/批次2_多人玩法设计方案.md 第三章 灵兽系统）：
 *   1. GET    /stats                       - 全局统计（总数/出战数/稀有度分布/元素分布/Top 玩家）
 *   2. GET    /beasts                      - 分页查询所有灵兽（多条件过滤）
 *   3. GET    /beasts/:beastId             - 灵兽详情（含玩家昵称/境界）
 *   4. GET    /players/:playerId/beasts    - 查询指定玩家全部灵兽
 *   5. POST   /give                        - GM 直接给玩家发放灵兽（绕过捕获概率/灵力/境界限制）
 *   6. PUT    /beasts/:beastId             - 修改灵兽属性（名称/星级/等级/经验/忠诚/属性/出战状态）
 *   7. DELETE /beasts/:beastId             - 删除灵兽（GM 介入，绕过放生返还逻辑）
 *   8. POST   /beasts/:beastId/set-active  - 强制设置出战（GM 介入，绕过玩家校验）
 *   9. POST   /beasts/:beastId/reset-cooldowns - 重置冷却（喂养/互动）
 *
 * 权限：所有接口需要 auth + adminCheck 双层验证
 * 审计：所有写操作记录 admin_logs 表（操作人/操作类型/目标/详情/IP）
 *
 * 设计原则：
 *   - 路由层仅做参数校验、调用 SpiritBeast 静态方法、AdminLog 写入
 *   - GM 介入接口必须绕过玩家侧校验（境界/灵力/冷却/捕获次数）
 *   - 修改灵兽属性时同步重新计算 hp_max/atk/def/speed（按 base × level × star 公式）
 *   - 强制出战时需要将玩家其他灵兽 is_active 置 false（事务保证唯一）
 *   - 所有 BIGINT 字段（exp/hp_max）响应中转字符串
 */
'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const SpiritBeast = require('../models/spiritBeast');
const Player = require('../models/player');
const AdminLog = require('../models/admin_log');
const auth = require('../middleware/auth');
const sequelize = require('../config/database');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const configLoader = infrastructure.ConfigLoader;

/**
 * 管理员权限中间件
 * 校验 req.player.role === 'admin'，否则拒绝访问
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 记录管理员操作日志（审计）
 * 注意：日志写入失败不阻塞主流程，仅打印告警
 * @param {number} adminId - 管理员ID
 * @param {string} action - 操作类型（如 spirit_beast_give / spirit_beast_update / spirit_beast_delete）
 * @param {Object} details - 操作详情
 * @param {Object} req - 请求对象（用于获取 IP）
 */
async function logAdminAction(adminId, action, details, req) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action,
            details: JSON.stringify(details),
            ip: req.ip || req.connection?.remoteAddress
        });
    } catch (error) {
        console.error('[AdminSpiritBeast] 记录管理员日志失败:', error);
    }
}

/**
 * 工具函数：根据配置基础值和灵兽等级/星级计算实际属性
 * 与 SpiritBeastService.calcAttr 保持一致的公式：base * (1 + (level-1)*0.1) * star_level
 * @param {number} baseValue - 配置中的基础值
 * @param {number} level - 灵兽等级
 * @param {number} starLevel - 星级
 * @returns {number} 计算后的属性值
 */
function calcAttr(baseValue, level, starLevel) {
    const levelFactor = 1 + (level - 1) * 0.1;
    return Math.floor(Number(baseValue) * levelFactor * starLevel);
}

/**
 * 校验灵兽种类是否存在并返回配置
 * @param {string} beastKey - 灵兽种类key
 * @returns {Object|null} 灵兽种类配置，不存在返回 null
 */
function findBeastType(beastKey) {
    const config = configLoader.getConfig('spirit_beast_data');
    return (config?.beast_types || []).find(bt => bt.beast_key === beastKey) || null;
}

/**
 * 格式化灵兽对象为响应数据
 * 统一处理 BigInt 字段序列化与玩家信息拼装
 * @param {Object} beast - SpiritBeast 模型实例
 * @param {Object} [player] - 关联的 Player 模型实例（可选）
 * @returns {Object} 响应数据对象
 */
function formatBeast(beast, player) {
    if (!beast) return null;
    return {
        beast_id: beast.id,
        player_id: beast.player_id,
        player_nickname: player?.nickname || null,
        player_realm: player?.realm || null,
        player_realm_rank: player?.realm_rank || null,
        beast_key: beast.beast_key,
        beast_name: beast.beast_name,
        element: beast.element,
        rarity: beast.rarity,
        star_level: beast.star_level,
        level: beast.level,
        exp: beast.exp?.toString() || '0',
        hp_max: beast.hp_max?.toString() || '0',
        atk: beast.atk,
        def: beast.def,
        speed: beast.speed,
        loyalty: beast.loyalty,
        is_active: beast.is_active,
        last_feed_time: beast.last_feed_time,
        last_interact_time: beast.last_interact_time,
        caught_at: beast.caught_at,
        created_at: beast.createdAt,
        updated_at: beast.updatedAt
    };
}

// ==================== 查询类接口 ====================

/**
 * GET /api/admin/spirit-beast/stats
 * 全局灵兽系统统计指标
 * 返回：总灵兽数/出战灵兽数/玩家拥有灵兽数/稀有度分布/元素分布/捕获次数 Top10
 */
router.get('/stats', auth, adminCheck, async (req, res, next) => {
    try {
        // 总灵兽数
        const totalBeasts = await SpiritBeast.count();
        // 出战灵兽数
        const activeBeasts = await SpiritBeast.count({ where: { is_active: true } });
        // 拥有灵兽的玩家数（去重）
        const playersWithBeasts = await SpiritBeast.count({
            distinct: true,
            col: 'player_id'
        });

        // 按稀有度分布
        const rarityDistribution = await SpiritBeast.findAll({
            attributes: [
                'rarity',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            group: ['rarity'],
            raw: true
        });

        // 按元素分布
        const elementDistribution = await SpiritBeast.findAll({
            attributes: [
                'element',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            group: ['element'],
            raw: true
        });

        // 按种类分布
        const breedDistribution = await SpiritBeast.findAll({
            attributes: [
                'beast_key',
                [sequelize.fn('COUNT', sequelize.col('id')), 'count']
            ],
            group: ['beast_key'],
            raw: true
        });

        // 今日新增捕获数
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayNewBeasts = await SpiritBeast.count({
            where: { caught_at: { [Op.gte]: todayStart } }
        });

        // 灵兽数量 Top10 玩家
        const topPlayers = await SpiritBeast.findAll({
            attributes: [
                'player_id',
                [sequelize.fn('COUNT', sequelize.col('id')), 'beast_count']
            ],
            group: ['player_id'],
            order: [[sequelize.literal('beast_count'), 'DESC']],
            limit: 10,
            raw: true
        });

        // 补充玩家昵称
        const topPlayerIds = topPlayers.map(t => t.player_id);
        const topPlayerInfos = topPlayerIds.length > 0
            ? await Player.findAll({
                where: { id: { [Op.in]: topPlayerIds } },
                attributes: ['id', 'nickname', 'realm', 'realm_rank'],
                raw: true
            })
            : [];
        const playerMap = new Map(topPlayerInfos.map(p => [p.id, p]));

        // 读取配置用于展示稀有度中文名
        const config = configLoader.getConfig('spirit_beast_data');
        const rarityConfig = config?.rarity_config || {};
        const elementsConfig = config?.elements || {};

        res.json({
            code: 200,
            data: {
                total_beasts: totalBeasts,
                active_beasts: activeBeasts,
                players_with_beasts: playersWithBeasts,
                today_new_beasts: todayNewBeasts,
                rarity_distribution: rarityDistribution.map(r => ({
                    rarity: r.rarity,
                    rarity_name: rarityConfig[r.rarity]?.name || r.rarity,
                    count: Number(r.count)
                })),
                element_distribution: elementDistribution.map(e => ({
                    element: e.element,
                    element_name: elementsConfig[e.element]?.name || e.element,
                    count: Number(e.count)
                })),
                breed_distribution: breedDistribution.map(b => ({
                    beast_key: b.beast_key,
                    count: Number(b.count)
                })),
                top_players: topPlayers.map(t => {
                    const p = playerMap.get(t.player_id);
                    return {
                        player_id: t.player_id,
                        player_nickname: p?.nickname || '未知',
                        player_realm: p?.realm || '未知',
                        beast_count: Number(t.beast_count)
                    };
                })
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/spirit-beast/beasts
 * 分页查询所有灵兽（多条件过滤）
 * 查询参数：
 *   - page=1, limit=20
 *   - player_id（按玩家过滤）
 *   - beast_key（按种类过滤）
 *   - rarity（按稀有度过滤）
 *   - element（按元素过滤）
 *   - is_active（按出战状态过滤，'true'/'false'）
 *   - keyword（按 beast_name 模糊搜索）
 */
router.get('/beasts', auth, adminCheck, async (req, res, next) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;

        // 构造 where 条件
        const whereClause = {};
        if (req.query.player_id) {
            const pid = parseInt(req.query.player_id);
            if (!isNaN(pid) && pid > 0) whereClause.player_id = pid;
        }
        if (req.query.beast_key) {
            whereClause.beast_key = req.query.beast_key;
        }
        if (req.query.rarity) {
            whereClause.rarity = req.query.rarity;
        }
        if (req.query.element) {
            whereClause.element = req.query.element;
        }
        if (req.query.is_active === 'true') {
            whereClause.is_active = true;
        } else if (req.query.is_active === 'false') {
            whereClause.is_active = false;
        }
        if (req.query.keyword) {
            whereClause.beast_name = { [Op.like]: `%${req.query.keyword}%` };
        }

        const { count, rows } = await SpiritBeast.findAndCountAll({
            where: whereClause,
            order: [['id', 'DESC']],
            limit,
            offset
        });

        // 批量查询关联玩家信息
        const playerIds = [...new Set(rows.map(b => b.player_id))];
        const players = playerIds.length > 0
            ? await Player.findAll({
                where: { id: { [Op.in]: playerIds } },
                attributes: ['id', 'nickname', 'realm', 'realm_rank'],
                raw: true
            })
            : [];
        const playerMap = new Map(players.map(p => [p.id, p]));

        res.json({
            code: 200,
            data: {
                total: count,
                page,
                limit,
                beasts: rows.map(b => formatBeast(b, playerMap.get(b.player_id)))
            }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/spirit-beast/beasts/:beastId
 * 灵兽详情（含玩家信息）
 */
router.get('/beasts/:beastId', auth, adminCheck, async (req, res, next) => {
    try {
        const beastId = parseInt(req.params.beastId);
        if (!beastId || beastId <= 0) {
            throw new AppError('灵兽ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const beast = await SpiritBeast.findByPk(beastId);
        if (!beast) {
            throw new AppError('灵兽不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询关联玩家
        const player = await Player.findByPk(beast.player_id, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank', 'role']
        });

        res.json({
            code: 200,
            data: formatBeast(beast, player)
        });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/spirit-beast/players/:playerId/beasts
 * 查询指定玩家全部灵兽
 */
router.get('/players/:playerId/beasts', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parseInt(req.params.playerId);
        if (!playerId || playerId <= 0) {
            throw new AppError('玩家ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验玩家存在
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询该玩家所有灵兽（出战优先，再按星级/等级/捕获时间排序）
        const beasts = await SpiritBeast.findAll({
            where: { player_id: playerId },
            order: [
                ['is_active', 'DESC'],
                ['star_level', 'DESC'],
                ['level', 'DESC'],
                ['caught_at', 'DESC']
            ]
        });

        res.json({
            code: 200,
            data: {
                player: {
                    id: player.id,
                    nickname: player.nickname,
                    realm: player.realm,
                    realm_rank: player.realm_rank
                },
                beasts: beasts.map(b => formatBeast(b, player)),
                total: beasts.length
            }
        });
    } catch (err) {
        next(err);
    }
});

// ==================== 写操作接口 ====================

/**
 * POST /api/admin/spirit-beast/give
 * GM 直接给玩家发放灵兽（绕过捕获概率/灵力/境界限制）
 * body: {
 *   player_id: number,         必填，目标玩家ID
 *   beast_key: string,         必填，灵兽种类key
 *   star_level?: number,       可选，初始星级（默认1，范围1-10）
 *   level?: number,            可选，初始等级（默认1，范围1-100）
 *   loyalty?: number,          可选，初始忠诚度（默认50，范围0-100）
 *   is_active?: boolean,       可选，是否立即出战（默认false）
 *   beast_name?: string        可选，自定义昵称
 * }
 * 审计：记录 admin_logs
 */
router.post('/give', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const { player_id, beast_key, star_level, level, loyalty, is_active, beast_name } = req.body;

        // 参数校验
        if (!player_id || !Number.isInteger(Number(player_id)) || Number(player_id) <= 0) {
            throw new AppError('player_id 必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!beast_key || typeof beast_key !== 'string') {
            throw new AppError('beast_key 必填', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验灵兽种类
        const beastType = findBeastType(beast_key);
        if (!beastType) {
            throw new AppError(`灵兽种类 ${beast_key} 不存在`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验玩家存在
        const playerId = Number(player_id);
        const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!player) {
            throw new AppError('目标玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 解析可选参数并校验范围
        const config = configLoader.getConfig('spirit_beast_data');
        const maxStar = Number(config?.settings?.max_star_level) || 10;
        const maxLevel = Number(config?.settings?.max_level) || 100;
        const maxLoyalty = Number(config?.settings?.max_loyalty) || 100;
        const minLoyalty = Number(config?.settings?.min_loyalty) || 0;
        const maxBeasts = Number(config?.settings?.max_beasts_per_player) || 10;

        const finalStar = star_level ? parseInt(star_level) : 1;
        const finalLevel = level ? parseInt(level) : 1;
        const finalLoyalty = loyalty !== undefined ? parseInt(loyalty) : 50;
        const finalIsActive = is_active === true;

        if (isNaN(finalStar) || finalStar < 1 || finalStar > maxStar) {
            throw new AppError(`star_level 必须在 1-${maxStar} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (isNaN(finalLevel) || finalLevel < 1 || finalLevel > maxLevel) {
            throw new AppError(`level 必须在 1-${maxLevel} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (isNaN(finalLoyalty) || finalLoyalty < minLoyalty || finalLoyalty > maxLoyalty) {
            throw new AppError(`loyalty 必须在 ${minLoyalty}-${maxLoyalty} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (beast_name && typeof beast_name !== 'string') {
            throw new AppError('beast_name 必须为字符串', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 背包容量校验
        const currentCount = await SpiritBeast.count({
            where: { player_id: playerId },
            transaction: t
        });
        if (currentCount >= maxBeasts) {
            throw new AppError(`玩家灵兽背包已满（${maxBeasts} 只上限），请先清理`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 若设为出战，先取消该玩家其他出战灵兽
        if (finalIsActive) {
            await SpiritBeast.update(
                { is_active: false },
                { where: { player_id: playerId, is_active: true }, transaction: t }
            );
        }

        // 按公式计算属性：base * (1 + (level-1)*0.1) * star_level
        const hpMax = calcAttr(beastType.base_hp, finalLevel, finalStar);
        const atk = calcAttr(beastType.base_atk, finalLevel, finalStar);
        const def = calcAttr(beastType.base_def, finalLevel, finalStar);
        const speed = calcAttr(beastType.base_speed, finalLevel, finalStar);

        // 创建灵兽
        const newBeast = await SpiritBeast.create({
            player_id: playerId,
            beast_key: beast_key,
            beast_name: beast_name || null,
            element: beastType.element,
            rarity: beastType.rarity,
            star_level: finalStar,
            level: finalLevel,
            exp: 0,
            hp_max: hpMax,
            atk,
            def,
            speed,
            loyalty: finalLoyalty,
            is_active: finalIsActive,
            last_feed_time: null,
            last_interact_time: null,
            caught_at: new Date()
        }, { transaction: t });

        await t.commit();

        // 审计日志
        await logAdminAction(req.player.id, 'spirit_beast_give', {
            target_player_id: playerId,
            beast_id: newBeast.id,
            beast_key,
            beast_name: beast_name || null,
            star_level: finalStar,
            level: finalLevel,
            loyalty: finalLoyalty,
            is_active: finalIsActive
        }, req);

        res.json({
            code: 200,
            message: `已向玩家 ${player.nickname} 发放灵兽 ${beastType.name}`,
            data: formatBeast(newBeast, player)
        });
    } catch (err) {
        if (!t.finished) await t.rollback();
        next(err);
    }
});

/**
 * PUT /api/admin/spirit-beast/beasts/:beastId
 * 修改灵兽属性
 * body: {
 *   beast_name?: string|null,
 *   star_level?: number,
 *   level?: number,
 *   exp?: number|string,
 *   loyalty?: number,
 *   atk?: number,
 *   def?: number,
 *   hp_max?: number|string,
 *   speed?: number,
 *   is_active?: boolean,
 *   recalculate?: boolean  是否按新 level/star 重算属性，默认 false
 * }
 * 审计：记录 admin_logs
 */
router.put('/beasts/:beastId', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const beastId = parseInt(req.params.beastId);
        if (!beastId || beastId <= 0) {
            throw new AppError('灵兽ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const beast = await SpiritBeast.findByPk(beastId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!beast) {
            throw new AppError('灵兽不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const config = configLoader.getConfig('spirit_beast_data');
        const maxStar = Number(config?.settings?.max_star_level) || 10;
        const maxLevel = Number(config?.settings?.max_level) || 100;
        const maxLoyalty = Number(config?.settings?.max_loyalty) || 100;
        const minLoyalty = Number(config?.settings?.min_loyalty) || 0;

        const updates = {};
        const changes = {};

        // 处理 beast_name
        if (req.body.beast_name !== undefined) {
            if (req.body.beast_name !== null && typeof req.body.beast_name !== 'string') {
                throw new AppError('beast_name 必须为字符串或 null', 400, ErrorCodes.VALIDATION_ERROR);
            }
            updates.beast_name = req.body.beast_name;
            changes.beast_name = { from: beast.beast_name, to: req.body.beast_name };
        }

        // 处理 star_level
        if (req.body.star_level !== undefined) {
            const newStar = parseInt(req.body.star_level);
            if (isNaN(newStar) || newStar < 1 || newStar > maxStar) {
                throw new AppError(`star_level 必须在 1-${maxStar} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
            }
            updates.star_level = newStar;
            changes.star_level = { from: beast.star_level, to: newStar };
        }

        // 处理 level
        if (req.body.level !== undefined) {
            const newLevel = parseInt(req.body.level);
            if (isNaN(newLevel) || newLevel < 1 || newLevel > maxLevel) {
                throw new AppError(`level 必须在 1-${maxLevel} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
            }
            updates.level = newLevel;
            changes.level = { from: beast.level, to: newLevel };
        }

        // 处理 exp（BIGINT 字段，支持 string/number）
        if (req.body.exp !== undefined) {
            const newExp = BigInt(String(req.body.exp));
            if (newExp < 0n) {
                throw new AppError('exp 不能为负数', 400, ErrorCodes.VALIDATION_ERROR);
            }
            updates.exp = newExp.toString();
            changes.exp = { from: beast.exp?.toString() || '0', to: newExp.toString() };
        }

        // 处理 loyalty
        if (req.body.loyalty !== undefined) {
            const newLoyalty = parseInt(req.body.loyalty);
            if (isNaN(newLoyalty) || newLoyalty < minLoyalty || newLoyalty > maxLoyalty) {
                throw new AppError(`loyalty 必须在 ${minLoyalty}-${maxLoyalty} 之间`, 400, ErrorCodes.VALIDATION_ERROR);
            }
            updates.loyalty = newLoyalty;
            changes.loyalty = { from: beast.loyalty, to: newLoyalty };
        }

        // 处理 is_active（强制出战）
        if (req.body.is_active !== undefined) {
            const newActive = !!req.body.is_active;
            // 若设为出战，先取消该玩家其他出战灵兽
            if (newActive) {
                await SpiritBeast.update(
                    { is_active: false },
                    { where: { player_id: beast.player_id, is_active: true, id: { [Op.ne]: beastId } }, transaction: t }
                );
            }
            updates.is_active = newActive;
            changes.is_active = { from: beast.is_active, to: newActive };
        }

        // 处理 atk/def/hp_max/speed（手动覆盖）
        ['atk', 'def', 'speed'].forEach(field => {
            if (req.body[field] !== undefined) {
                const val = parseInt(req.body[field]);
                if (isNaN(val) || val < 0) {
                    throw new AppError(`${field} 必须为非负整数`, 400, ErrorCodes.VALIDATION_ERROR);
                }
                updates[field] = val;
                changes[field] = { from: beast[field], to: val };
            }
        });
        if (req.body.hp_max !== undefined) {
            const val = BigInt(String(req.body.hp_max));
            if (val < 0n) {
                throw new AppError('hp_max 不能为负数', 400, ErrorCodes.VALIDATION_ERROR);
            }
            updates.hp_max = val.toString();
            changes.hp_max = { from: beast.hp_max?.toString() || '0', to: val.toString() };
        }

        // 是否按新 level/star 重算属性
        if (req.body.recalculate === true) {
            const beastType = findBeastType(beast.beast_key);
            if (beastType) {
                const finalLevel = updates.level ?? beast.level;
                const finalStar = updates.star_level ?? beast.star_level;
                const hpMax = calcAttr(beastType.base_hp, finalLevel, finalStar);
                const atk = calcAttr(beastType.base_atk, finalLevel, finalStar);
                const def = calcAttr(beastType.base_def, finalLevel, finalStar);
                const speed = calcAttr(beastType.base_speed, finalLevel, finalStar);
                updates.hp_max = String(hpMax);
                updates.atk = atk;
                updates.def = def;
                updates.speed = speed;
                changes.recalculated = {
                    base_hp: beastType.base_hp,
                    base_atk: beastType.base_atk,
                    base_def: beastType.base_def,
                    base_speed: beastType.base_speed,
                    final_level: finalLevel,
                    final_star: finalStar,
                    new_hp_max: String(hpMax),
                    new_atk: atk,
                    new_def: def,
                    new_speed: speed
                };
            }
        }

        if (Object.keys(updates).length === 0) {
            await t.rollback();
            return res.json({ code: 200, message: '无更新字段', data: formatBeast(beast) });
        }

        // 执行更新
        await beast.update(updates, { transaction: t });
        await t.commit();

        // 审计日志
        await logAdminAction(req.player.id, 'spirit_beast_update', {
            target_player_id: beast.player_id,
            beast_id: beastId,
            changes
        }, req);

        // 重新查询完整数据
        const refreshed = await SpiritBeast.findByPk(beastId);
        const player = await Player.findByPk(beast.player_id, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank']
        });

        res.json({
            code: 200,
            message: '灵兽属性已更新',
            data: formatBeast(refreshed, player)
        });
    } catch (err) {
        if (!t.finished) await t.rollback();
        next(err);
    }
});

/**
 * DELETE /api/admin/spirit-beast/beasts/:beastId
 * 删除灵兽（GM 介入，绕过放生返还逻辑）
 * query: reason - 删除原因（可选，记录审计日志）
 * 审计：记录 admin_logs
 */
router.delete('/beasts/:beastId', auth, adminCheck, async (req, res, next) => {
    try {
        const beastId = parseInt(req.params.beastId);
        if (!beastId || beastId <= 0) {
            throw new AppError('灵兽ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const beast = await SpiritBeast.findByPk(beastId);
        if (!beast) {
            throw new AppError('灵兽不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 保存删除前的信息用于审计
        const beastSnapshot = formatBeast(beast);

        // 物理删除（GM 介入不返还灵石，与玩家放生不同）
        await beast.destroy();

        // 审计日志
        await logAdminAction(req.player.id, 'spirit_beast_delete', {
            target_player_id: beast.player_id,
            beast_id: beastId,
            reason: req.query.reason || 'GM 介入删除',
            beast_snapshot: beastSnapshot
        }, req);

        res.json({
            code: 200,
            message: '灵兽已删除',
            data: { beast_id: beastId, deleted: true }
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/spirit-beast/beasts/:beastId/set-active
 * 强制设置出战（GM 介入，绕过玩家侧冷却/状态校验）
 * body: { active: boolean }  true=设为出战，false=取消出战
 * 审计：记录 admin_logs
 */
router.post('/beasts/:beastId/set-active', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const beastId = parseInt(req.params.beastId);
        if (!beastId || beastId <= 0) {
            throw new AppError('灵兽ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const active = req.body.active !== false; // 默认 true
        const beast = await SpiritBeast.findByPk(beastId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!beast) {
            throw new AppError('灵兽不存在', 404, ErrorCodes.NOT_FOUND);
        }

        if (active) {
            // 设为出战：先取消该玩家其他出战灵兽
            await SpiritBeast.update(
                { is_active: false },
                { where: { player_id: beast.player_id, is_active: true, id: { [Op.ne]: beastId } }, transaction: t }
            );
        }
        beast.is_active = active;
        await beast.save({ transaction: t });

        await t.commit();

        // 审计日志
        await logAdminAction(req.player.id, 'spirit_beast_force_set_active', {
            target_player_id: beast.player_id,
            beast_id: beastId,
            is_active: active
        }, req);

        res.json({
            code: 200,
            message: active ? '已强制设为出战' : '已取消出战',
            data: { beast_id: beastId, is_active: active }
        });
    } catch (err) {
        if (!t.finished) await t.rollback();
        next(err);
    }
});

/**
 * POST /api/admin/spirit-beast/beasts/:beastId/reset-cooldowns
 * 重置灵兽的冷却时间（喂养/互动）
 * body: { type: 'feed'|'interact'|'all' }  默认 'all'
 * 审计：记录 admin_logs
 */
router.post('/beasts/:beastId/reset-cooldowns', auth, adminCheck, async (req, res, next) => {
    try {
        const beastId = parseInt(req.params.beastId);
        if (!beastId || beastId <= 0) {
            throw new AppError('灵兽ID格式错误', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const type = req.body?.type || 'all';
        if (!['feed', 'interact', 'all'].includes(type)) {
            throw new AppError('type 必须为 feed/interact/all', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const beast = await SpiritBeast.findByPk(beastId);
        if (!beast) {
            throw new AppError('灵兽不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const updates = {};
        if (type === 'feed' || type === 'all') updates.last_feed_time = null;
        if (type === 'interact' || type === 'all') updates.last_interact_time = null;

        if (Object.keys(updates).length > 0) {
            await beast.update(updates);
        }

        // 审计日志
        await logAdminAction(req.player.id, 'spirit_beast_reset_cooldowns', {
            target_player_id: beast.player_id,
            beast_id: beastId,
            reset_type: type
        }, req);

        res.json({
            code: 200,
            message: `已重置 ${type === 'all' ? '全部' : type} 冷却`,
            data: {
                beast_id: beastId,
                reset_type: type,
                last_feed_time: beast.last_feed_time,
                last_interact_time: beast.last_interact_time
            }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
