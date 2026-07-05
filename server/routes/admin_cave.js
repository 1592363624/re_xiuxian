/**
 * 洞府管理路由（GM 后台）
 *
 * 提供以下接口：
 *   1. GET    /api/admin/cave/list                  - 查询所有玩家洞府列表（分页，支持按玩家ID/昵称筛选）
 *   2. GET    /api/admin/cave/:playerId              - 查询指定玩家洞府详情
 *   3. PUT    /api/admin/cave/:playerId/facility     - 调整玩家设施等级（body: { facility, level }）
 *   4. POST   /api/admin/cave/:playerId/reset        - 重置玩家洞府（GM 强制重置）
 *   5. PUT    /api/admin/cave/:playerId/garden-plots - 调整药园地块数（body: { plots }）
 *
 * 安全设计：
 *   - 所有接口需要 JWT 认证 + admin 权限（auth + adminCheck 双层中间件）
 *   - 业务逻辑直接基于 PlayerCave / Player 模型实现，使用事务保证数据一致性
 *   - 所有操作记录到 admin_logs 表，便于审计追溯
 *   - 设施类型、等级、地块数等参数均做白名单/范围校验，防 SQL 注入
 *   - 使用 AppError + ErrorCodes 抛错，由全局 errorHandler 统一处理
 *   - 阈值（分页大小、等级上下限、地块上下限）从 game_balance.admin 读取，不硬编码
 *
 * 路由顺序说明：
 *   静态路径（/list）定义在动态参数路由 /:playerId 之前，避免被 /:playerId 误匹配。
 */

const express = require('express');
const router = express.Router();

// Sequelize 操作符，用于构造 OR 查询
const { Op } = require('sequelize');

// 中间件、模型与基础设施
const auth = require('../middleware/auth');
const AdminLog = require('../models/admin_log');
const Player = require('../models/player');
const PlayerCave = require('../models/playerCave');
const sequelize = require('../config/database');
const { infrastructure } = require('../modules');
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

// 由于 PlayerCave 与 Player 之间未定义 Sequelize 关联，
// 列表与详情接口采用"先查洞府、再批量查玩家"的方式（与 SectService.getAllMembers 风格一致，避免 N+1）

// 通过 ConfigLoader 获取 game_balance 配置（支持热更新，避免硬编码阈值）
const configLoader = infrastructure.ConfigLoader;

/**
 * 读取 game_balance.admin 配置节
 * @returns {Object} admin 配置对象（若未加载则返回空对象，调用方使用默认值兜底）
 */
function getAdminConfig() {
    return configLoader?.getConfig('game_balance')?.admin || {};
}

/**
 * GM 权限校验中间件
 * 复用 admin_sect.js 中的 adminCheck 逻辑：检查 req.player.role === 'admin'
 */
const adminCheck = (req, res, next) => {
    if (req.player && req.player.role === 'admin') {
        next();
    } else {
        res.status(403).json({ code: 403, message: '权限不足：需要管理员权限' });
    }
};

/**
 * 写入管理员操作日志（封装，避免代码重复）
 * 日志写入失败不应阻塞主流程，仅打印警告
 * @param {Object} params - { adminId, action, targetId, detail, req }
 */
async function logAdminAction({ adminId, action, targetId = null, detail = '', req = null }) {
    try {
        await AdminLog.create({
            admin_id: adminId,
            action: action,
            target_id: targetId,
            details: JSON.stringify({ detail }),
            ip: req?.ip || req?.connection?.remoteAddress || null
        });
    } catch (e) {
        // 日志写入失败不应阻塞主流程，仅打印警告
        console.error('[admin_cave] 写入操作日志失败:', e.message);
    }
}

/**
 * 校验 playerId 是否为有效正整数
 * @param {string} playerId - 路径参数
 * @returns {number} 解析后的玩家ID
 */
function parsePlayerId(playerId) {
    const id = parseInt(playerId);
    if (isNaN(id) || id <= 0) {
        throw new AppError('玩家ID必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
    }
    return id;
}

/**
 * 获取设施中文名映射（与 cave_data.json 保持一致，便于日志与返回值展示）
 * @returns {Object} { spirit_vein: '灵脉', ... }
 */
function getFacilityNameMap() {
    return {
        spirit_vein: '灵脉',
        quiet_room: '静室',
        pill_room: '丹房',
        tool_room: '器室',
        grand_formation: '护山大阵'
    };
}

/**
 * GET /api/admin/cave/list
 * 查询所有玩家洞府列表（分页，支持按玩家ID/昵称筛选）
 * 查询参数：
 *   - player_id（可选）：精确匹配玩家ID
 *   - nickname（可选）：模糊匹配玩家昵称
 *   - page（默认1）、page_size（默认从配置读取）
 * 返回：玩家ID、昵称、是否开辟、灵脉等级、静室/丹房/器室/大阵等级、药园地块数、开辟时间
 *
 * 实现说明：
 *   - 由于 PlayerCave 与 Player 之间未定义 Sequelize 关联，
 *     先按 player_id 过滤洞府，再批量查询玩家补充昵称信息（避免 N+1 查询）
 *   - 按 nickname 模糊匹配时，需先在 Player 表中找出匹配的 player_id，再用其过滤洞府
 */
router.get('/list', auth, adminCheck, async (req, res, next) => {
    try {
        const adminConfig = getAdminConfig();
        // 分页参数从配置读取，page_size 不超过配置的最大值
        const pageSize = Math.min(
            parseInt(req.query.page_size) || adminConfig.cave_list_page_size || 20,
            adminConfig.cave_list_max_page_size || 100
        );
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const offset = (page - 1) * pageSize;

        const { player_id, nickname } = req.query;

        // 构造洞府查询条件
        const caveWhere = {};
        if (player_id) {
            // 玩家ID精确匹配
            const pid = parseInt(player_id);
            if (!isNaN(pid) && pid > 0) {
                caveWhere.player_id = pid;
            }
        }

        // 昵称模糊匹配：先查出匹配的玩家ID集合，再用其过滤洞府
        if (nickname) {
            // 转义 SQL LIKE 通配符 % 与 _，防止正则注入
            const safeNick = String(nickname).replace(/[%_]/g, m => '\\' + m);
            const matchedPlayers = await Player.findAll({
                attributes: ['id'],
                where: { nickname: { [Op.like]: `%${safeNick}%` } }
            });
            const matchedIds = matchedPlayers.map(p => p.id);
            if (matchedIds.length === 0) {
                // 无匹配玩家：直接返回空列表，避免全表扫描
                return res.json({
                    code: 200,
                    message: 'success',
                    data: { list: [], total: 0, page, page_size: pageSize, total_pages: 0 }
                });
            }
            // 同时传入 player_id 与 nickname 时取交集：pid 必须在匹配集合内
            if (caveWhere.player_id !== undefined) {
                if (!matchedIds.includes(caveWhere.player_id)) {
                    // 玩家ID与昵称不匹配：返回空
                    return res.json({
                        code: 200,
                        message: 'success',
                        data: { list: [], total: 0, page, page_size: pageSize, total_pages: 0 }
                    });
                }
                // 保持 caveWhere.player_id = pid（更精确的过滤）
            } else {
                // 仅按昵称匹配：用匹配到的玩家ID集合过滤洞府
                caveWhere.player_id = { [Op.in]: matchedIds };
            }
        }

        // 分页查询洞府记录，按创建时间倒序
        const { count, rows } = await PlayerCave.findAndCountAll({
            where: caveWhere,
            limit: pageSize,
            offset,
            order: [['created_at', 'DESC']]
        });

        // 无数据时直接返回空结构
        if (rows.length === 0) {
            return res.json({
                code: 200,
                message: 'success',
                data: { list: [], total: 0, page, page_size: pageSize, total_pages: 0 }
            });
        }

        // 批量查询玩家基础信息，避免逐条查询（N+1 优化）
        const playerIds = rows.map(r => r.player_id);
        const players = await Player.findAll({
            attributes: ['id', 'username', 'nickname', 'realm'],
            where: { id: playerIds }
        });
        const playerMap = new Map(players.map(p => [p.id, p]));

        // 组装返回数据（统一字段命名，便于前端展示）
        const list = rows.map(c => {
            const player = playerMap.get(c.player_id);
            return {
                player_id: c.player_id,
                nickname: player?.nickname || '未知道友',
                username: player?.username || '',
                realm: player?.realm || '凡人',
                is_opened: c.is_opened,
                opened_at: c.opened_at,
                spirit_vein_level: c.spirit_vein_level,
                quiet_room_level: c.quiet_room_level,
                pill_room_level: c.pill_room_level,
                tool_room_level: c.tool_room_level,
                grand_formation_level: c.grand_formation_level,
                garden_plots: c.garden_plots,
                spirit_vein_accumulated: Number(c.spirit_vein_accumulated || 0),
                created_at: c.created_at,
                updated_at: c.updated_at
            };
        });

        res.json({
            code: 200,
            message: 'success',
            data: {
                list,
                total: count,
                page,
                page_size: pageSize,
                total_pages: Math.ceil(count / pageSize)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/admin/cave/:playerId
 * 查询指定玩家洞府详情
 * 返回：洞府全部字段 + 玩家基础信息（昵称、境界）
 */
router.get('/:playerId', auth, adminCheck, async (req, res, next) => {
    try {
        const playerId = parsePlayerId(req.params.playerId);

        // 查询玩家洞府记录
        const cave = await PlayerCave.findOne({ where: { player_id: playerId } });
        if (!cave) {
            throw new AppError('该玩家尚未创建洞府记录', 404, ErrorCodes.NOT_FOUND);
        }

        // 单独查询玩家基础信息（无关联关系）
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'username', 'nickname', 'realm']
        });

        res.json({
            code: 200,
            message: 'success',
            data: {
                player_id: cave.player_id,
                nickname: player?.nickname || '未知道友',
                username: player?.username || '',
                realm: player?.realm || '凡人',
                is_opened: cave.is_opened,
                opened_at: cave.opened_at,
                facilities: {
                    spirit_vein: { name: '灵脉', level: cave.spirit_vein_level },
                    quiet_room: { name: '静室', level: cave.quiet_room_level },
                    pill_room: { name: '丹房', level: cave.pill_room_level },
                    tool_room: { name: '器室', level: cave.tool_room_level },
                    grand_formation: { name: '护山大阵', level: cave.grand_formation_level }
                },
                spirit_vein_accumulated: Number(cave.spirit_vein_accumulated || 0),
                spirit_vein_pending: Number(cave.spirit_vein_pending || 0),
                last_spirit_vein_collect: cave.last_spirit_vein_collect,
                garden_plots: cave.garden_plots,
                created_at: cave.created_at,
                updated_at: cave.updated_at
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/admin/cave/:playerId/facility
 * 调整玩家设施等级（GM 直接覆盖原有等级，不消耗资源）
 * 请求体：{ facility: string, level: number }
 * 校验：
 *   - facility 必须在白名单内（防 SQL 注入）
 *   - level 必须为整数，且在配置的 [cave_facility_min_level, cave_facility_max_level] 范围内
 *   - 玩家必须已开辟洞府（未开辟时不允许调整设施）
 */
router.put('/:playerId/facility', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const { facility, level } = req.body;

        // 参数完整性校验
        if (!facility) {
            throw new AppError('缺少必要参数：facility', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (level === undefined || level === null) {
            throw new AppError('缺少必要参数：level', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const adminConfig = getAdminConfig();
        // 设施类型白名单（从配置读取，默认与 cave_data.json 的五大设施对应）
        const whitelist = adminConfig.cave_facility_whitelist || [
            'spirit_vein', 'quiet_room', 'pill_room', 'tool_room', 'grand_formation'
        ];
        if (!whitelist.includes(facility)) {
            // 白名单校验失败：拒绝请求，防止通过 SQL 注入访问未授权字段
            throw new AppError(`无效的设施类型: ${facility}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 等级范围校验（从配置读取上下限，不硬编码）
        const minLevel = adminConfig.cave_facility_min_level ?? 0;
        const maxLevel = adminConfig.cave_facility_max_level ?? 10;
        const newLevel = parseInt(level);
        if (isNaN(newLevel) || newLevel < minLevel || newLevel > maxLevel) {
            throw new AppError(
                `设施等级必须为整数且在 [${minLevel}, ${maxLevel}] 范围内`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 行级锁查询洞府记录
        const cave = await PlayerCave.findOne({
            where: { player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        if (!cave) {
            throw new AppError('该玩家尚未创建洞府记录', 404, ErrorCodes.NOT_FOUND);
        }
        if (!cave.is_opened) {
            throw new AppError('该玩家尚未开辟洞府，无法调整设施', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 记录旧等级用于日志与返回值
        const oldLevel = cave[`${facility}_level`] || 0;
        // 设置新等级（字段名格式：{facility}_level，与 PlayerCave 模型字段对应）
        cave[`${facility}_level`] = newLevel;
        await cave.save({ transaction: t });

        // 记录操作日志
        const facilityName = getFacilityNameMap()[facility] || facility;
        await logAdminAction({
            adminId: req.player.id,
            action: 'cave_update_facility',
            targetId: playerId,
            detail: `调整玩家 ${playerId} 的【${facilityName}】等级：${oldLevel} -> ${newLevel}`,
            req
        });

        await t.commit();

        res.json({
            code: 200,
            message: `${facilityName}等级调整成功`,
            data: {
                player_id: playerId,
                facility,
                facility_name: facilityName,
                old_level: oldLevel,
                new_level: newLevel
            }
        });
    } catch (error) {
        // 异常时回滚事务
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * POST /api/admin/cave/:playerId/reset
 * 重置玩家洞府（GM 强制重置）
 * 行为：
 *   - 清空所有设施等级为 0
 *   - 灵脉累计/待领取清零
 *   - 药园地块数重置为初始值（从 cave_data.json 读取，默认 3）
 *   - is_opened 重置为 false，opened_at 清空
 *   - 不删除玩家本身，仅重置洞府记录
 * 说明：保留记录行（不删除），便于审计追溯与玩家重新开辟洞府。
 */
router.post('/:playerId/reset', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parsePlayerId(req.params.playerId);

        // 行级锁查询
        const cave = await PlayerCave.findOne({
            where: { player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        if (!cave) {
            throw new AppError('该玩家尚未创建洞府记录', 404, ErrorCodes.NOT_FOUND);
        }

        // 记录重置前的状态用于日志
        const beforeSnapshot = {
            is_opened: cave.is_opened,
            spirit_vein_level: cave.spirit_vein_level,
            quiet_room_level: cave.quiet_room_level,
            pill_room_level: cave.pill_room_level,
            tool_room_level: cave.tool_room_level,
            grand_formation_level: cave.grand_formation_level,
            garden_plots: cave.garden_plots,
            spirit_vein_accumulated: Number(cave.spirit_vein_accumulated || 0)
        };

        // 从 cave_data.json 读取药园初始地块数（避免硬编码）
        // 用 try-catch 包裹：即便 cave_data 配置加载失败，也使用默认值 3 兜底
        let initialPlots = 3;
        try {
            const caveConfig = configLoader?.getConfig('cave_data')?.cave || {};
            initialPlots = caveConfig.garden?.initial_plots || 3;
        } catch (e) {
            console.warn('[admin_cave] 读取 cave_data 配置失败，使用默认地块数 3:', e.message);
        }

        // 重置所有字段
        cave.is_opened = false;
        cave.opened_at = null;
        cave.spirit_vein_level = 0;
        cave.quiet_room_level = 0;
        cave.pill_room_level = 0;
        cave.tool_room_level = 0;
        cave.grand_formation_level = 0;
        cave.spirit_vein_accumulated = 0;
        cave.spirit_vein_pending = 0;
        cave.last_spirit_vein_collect = null;
        cave.garden_plots = initialPlots;
        await cave.save({ transaction: t });

        // 记录操作日志（含重置前快照，便于审计回溯）
        await logAdminAction({
            adminId: req.player.id,
            action: 'cave_reset',
            targetId: playerId,
            detail: `GM 强制重置玩家 ${playerId} 的洞府。重置前状态: ${JSON.stringify(beforeSnapshot)}`,
            req
        });

        await t.commit();

        res.json({
            code: 200,
            message: '洞府已重置',
            data: {
                player_id: playerId,
                is_opened: false,
                garden_plots: initialPlots,
                before: beforeSnapshot
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

/**
 * PUT /api/admin/cave/:playerId/garden-plots
 * 调整玩家药园地块数（GM 直接覆盖，不消耗灵石）
 * 请求体：{ plots: number }
 * 校验：
 *   - plots 必须为整数，且在配置的 [cave_garden_plots_min, cave_garden_plots_max] 范围内
 *   - 玩家必须已开辟洞府
 */
router.put('/:playerId/garden-plots', auth, adminCheck, async (req, res, next) => {
    const t = await sequelize.transaction();
    try {
        const playerId = parsePlayerId(req.params.playerId);
        const { plots } = req.body;

        // 参数完整性校验
        if (plots === undefined || plots === null) {
            throw new AppError('缺少必要参数：plots', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const adminConfig = getAdminConfig();
        // 地块数范围校验（从配置读取上下限，不硬编码）
        const minPlots = adminConfig.cave_garden_plots_min ?? 0;
        const maxPlots = adminConfig.cave_garden_plots_max ?? 9;
        const newPlots = parseInt(plots);
        if (isNaN(newPlots) || newPlots < minPlots || newPlots > maxPlots) {
            throw new AppError(
                `药园地块数必须为整数且在 [${minPlots}, ${maxPlots}] 范围内`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 行级锁查询
        const cave = await PlayerCave.findOne({
            where: { player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });

        if (!cave) {
            throw new AppError('该玩家尚未创建洞府记录', 404, ErrorCodes.NOT_FOUND);
        }
        if (!cave.is_opened) {
            throw new AppError('该玩家尚未开辟洞府，无法调整药园地块', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 记录旧值用于日志与返回值
        const oldPlots = cave.garden_plots || 0;
        cave.garden_plots = newPlots;
        await cave.save({ transaction: t });

        // 记录操作日志
        await logAdminAction({
            adminId: req.player.id,
            action: 'cave_update_garden_plots',
            targetId: playerId,
            detail: `调整玩家 ${playerId} 的药园地块数：${oldPlots} -> ${newPlots}`,
            req
        });

        await t.commit();

        res.json({
            code: 200,
            message: '药园地块数调整成功',
            data: {
                player_id: playerId,
                old_plots: oldPlots,
                new_plots: newPlots
            }
        });
    } catch (error) {
        if (!t.finished) await t.rollback();
        next(error);
    }
});

module.exports = router;
