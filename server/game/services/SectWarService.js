/**
 * 宗门战/领地争夺系统核心服务
 *
 * 文件功能：
 *   实现宗门战全部核心业务逻辑，包括赛季管理、资源点争夺、宣战/加入/攻击/占领/认输等。
 *   参考 docs/批次2_多人玩法设计方案.md 第三章"宗门战/领地争夺系统设计"。
 *
 * 设计原则：
 *   1. 配置中心化：所有可变参数从 game_balance.json 的 sect_war 块读取；
 *      资源点静态配置从 sect_war_data.json 读取，禁止硬编码。
 *   2. 业务逻辑统一后端实现：本服务处理所有宗门战业务逻辑，前端仅展示与调用接口。
 *   3. 事务+行级锁：宣战/加入战役/攻击/占领均涉及多表更新，必须用事务 + LOCK.UPDATE。
 *   4. 状态机集成：参战时调用 PlayerStateMachine.canStart 检查 IN_SECT_WAR 互斥状态。
 *   5. WebSocket 推送：通过 WebSocketNotificationService 推送玩家数据更新与全服广播。
 *   6. BigInt 安全：伤害/灵石等 BIGINT 字段统一使用 safeBigInt 转换，避免精度丢失。
 *   7. 错误处理：统一使用 AppError + ErrorCodes，禁止裸 throw Error。
 *
 * 战役状态机：
 *   preparing（准备期，宣战后→开战前2小时）
 *     ↓ prepare_end_time 到达
 *   announced（宣战期，开战前2小时→开战，允许双方调兵遣将/加入）
 *     ↓ active_start_time 到达
 *   active（交战期，30分钟，可攻击/占领）
 *     ↓ active_end_time 到达 / 一方认输 / 全员阵亡
 *   settled（结算期，立即结算并发放奖励）
 *
 * 胜负判定（来自设计文档 3.3.2）：
 *   攻方积分 = 占领资源点数 × 100 + 击杀数 × 5
 *   守方积分 = 防守成功资源点数 × 100 + 击杀数 × 5
 *   积分高者胜，平局则守方胜（守方优势）
 *
 * 战斗公式（简化版，参考 PvpService）：
 *   单次伤害 = max(1, 攻击方ATK × 技能倍率 - 防守方DEF × 减伤系数) × 暴击系数 × 随机浮动
 *   减伤系数：0.5 / 暴击概率：5% / 暴击倍率：1.5 / 随机浮动：±15%
 */
'use strict';

// ===== 模型依赖 =====
const SectWar = require('../../models/sectWar');
const SectWarTerritory = require('../../models/sectWarTerritory');
const SectWarParticipant = require('../../models/sectWarParticipant');
const SectWarSeason = require('../../models/sectWarSeason');
const SectWarSeasonRanking = require('../../models/sectWarSeasonRanking');
const SectFund = require('../../models/sectFund');
const PlayerSect = require('../../models/playerSect');
const Player = require('../../models/player');

// ===== 核心服务依赖 =====
const AttributeService = require('../core/AttributeService');
const RealmService = require('../core/RealmService');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const SectService = require('./SectService');
// 大五行幻世轮服务（同目录引用，用于宗门战结算后被动积累悟印）
const ArtifactDeepLineService = require('./ArtifactDeepLineService');

// ===== 基础设施依赖 =====
const { infrastructure } = require('../../modules');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');

// 配置加载器（与 PvpService 风格一致，从 infrastructure 注入）
const configLoader = infrastructure.ConfigLoader;

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * 直接 BigInt(null) 会抛 TypeError: Cannot convert null to a BigInt，导致接口 500
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined/空字符串返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    // 统一转字符串再转 BigInt，避免 number 精度丢失
    return BigInt(String(value));
}

/**
 * 宗门战服务类
 * 静态方法风格，与 PvpService/SectService 保持一致
 */
class SectWarService {
    /**
     * ===== 内存级占领计时器 =====
     * 用于资源点占领的 30 秒倒计时（territory_capture_seconds 配置）。
     * 服务重启会丢失内存计时器，因此同时持久化 is_under_attack 标志到 DB，
     * 重启后通过 clearStaleCaptureFlags 清理脏标志（中断的占领需玩家重新发起）。
     * Key: `${warId}_${territoryId}`
     * Value: { playerId, startTime, timeoutId }
     */
    static activeCaptures = new Map();

    /**
     * 读取宗门战配置（game_balance.sect_war）
     * @returns {Object} 宗门战配置对象
     */
    static getSectWarConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.sect_war || {};
    }

    /**
     * 读取资源点静态配置（sect_war_data.territories）
     * @param {string} territoryKey - 资源点配置键（如 qingyun_spirit_vein）
     * @returns {Object|null} 资源点静态配置，未找到返回 null
     */
    static getTerritoryStaticData(territoryKey) {
        const data = configLoader.getConfig('sect_war_data');
        const territories = data?.territories || [];
        return territories.find(t => t.territory_key === territoryKey) || null;
    }

    /**
     * 获取所有资源点静态配置
     * @returns {Array} 资源点静态配置数组
     */
    static getAllTerritoryStaticData() {
        const data = configLoader.getConfig('sect_war_data');
        return data?.territories || [];
    }

    // ============================================================
    // ===== 查询类接口 =====
    // ============================================================

    /**
     * 获取当前进行中的赛季信息
     * 赛季状态：pending（待开始）/ active（进行中）/ ended（已结束）
     * @returns {Promise<Object|null>} 当前赛季对象，无则返回 null
     */
    static async getCurrentSeason() {
        // 优先查询 active 状态的赛季
        let season = await SectWarSeason.findOne({
            where: { status: 'active' },
            order: [['id', 'DESC']]
        });
        // 没有 active 赛季时，查询最近一个 pending 赛季（便于前端展示即将开始的赛季）
        if (!season) {
            season = await SectWarSeason.findOne({
                where: { status: 'pending' },
                order: [['start_date', 'ASC']]
            });
        }
        return season;
    }

    /**
     * 获取所有资源点（含占领状态）
     * 若 seasonId 未传，自动取当前赛季；赛季不存在则返回静态配置（无归属）
     * @param {number} [seasonId] - 赛季ID，可选
     * @returns {Promise<Array>} 资源点列表（含占领/驻防信息）
     */
    static async getTerritories(seasonId) {
        // 未指定赛季时取当前赛季
        if (!seasonId) {
            const season = await this.getCurrentSeason();
            seasonId = season?.id || 0;
        }

        // 查询赛季下的所有资源点动态记录
        const dbTerritories = await SectWarTerritory.findAll({
            where: { season_id: seasonId },
            order: [['map_x', 'ASC'], ['map_y', 'ASC']]
        });

        // 数据库有记录则直接返回（含占领状态）
        if (dbTerritories.length > 0) {
            return dbTerritories.map(t => this._formatTerritory(t));
        }

        // 数据库无记录（赛季尚未初始化资源点），返回静态配置（无归属）
        const staticData = this.getAllTerritoryStaticData();
        return staticData.map(s => ({
            territory_key: s.territory_key,
            territory_name: s.territory_name,
            territory_type: s.territory_type,
            map_x: s.map_x,
            map_y: s.map_y,
            owner_sect_id: null,
            owner_sect_name: null,
            owner_since: null,
            defense_level: 1,
            defense_formation: null,
            defender_player_ids: [],
            daily_production: s.base_daily_production || 0,
            production_type: s.production_type,
            is_under_attack: 0,
            last_battle_time: null,
            season_id: seasonId,
            description: s.description,
            strategic_win_bonus: s.strategic_win_bonus || 0
        }));
    }

    /**
     * 获取本宗门战役信息（资金/积分/成员/当前战役）
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 本宗门战役信息
     */
    static async getMySectInfo(playerId) {
        // 查询玩家宗门归属
        const playerSect = await PlayerSect.findOne({ where: { player_id: playerId } });
        if (!playerSect) {
            throw new AppError('尚未加入任何宗门，无法查看宗门战信息', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const sectId = playerSect.sect_id;
        // 获取宗门静态配置（名称等）
        const sectConfig = SectService.findSectById ? SectService.findSectById(sectId) : null;
        const sectName = sectConfig?.name || sectId;

        // 获取或创建宗门资金记录
        const fund = await this._getOrCreateSectFund(sectId, sectName, null);

        // 查询当前赛季
        const season = await this.getCurrentSeason();
        const seasonId = season?.id || 0;

        // 查询本赛季本宗门参与的进行中/即将开始的战役
        const ongoingWars = await SectWar.findAll({
            where: {
                season_id: seasonId,
                [Op.and]: [
                    { status: { [Op.in]: ['preparing', 'announced', 'active'] } },
                    { [Op.or]: [{ attacker_sect_id: sectId }, { defender_sect_id: sectId }] }
                ]
            },
            order: [['active_start_time', 'ASC']]
        });

        // 查询本赛季本宗门占领的资源点
        const territories = await SectWarTerritory.findAll({
            where: { season_id: seasonId, owner_sect_id: sectId }
        });

        // 查询本宗门成员数（用于显示参战比例）
        const memberCount = await PlayerSect.count({ where: { sect_id: sectId } });

        return {
            sect_id: sectId,
            sect_name: sectName,
            role: playerSect.role,
            is_leader: fund.leader_player_id === Number(playerId) || playerSect.role === 'leader',
            fund: {
                fund_balance: safeBigInt(fund.fund_balance).toString(),
                war_score: fund.war_score,
                season_war_score: fund.season_war_score,
                territories_count: fund.territories_count
            },
            season: season ? {
                id: season.id,
                season_name: season.season_name,
                start_date: season.start_date,
                end_date: season.end_date,
                status: season.status
            } : null,
            ongoing_wars: ongoingWars.map(w => this._formatWar(w)),
            owned_territories: territories.map(t => this._formatTerritory(t)),
            member_count: memberCount
        };
    }

    /**
     * 获取战役列表（进行中/历史）
     * @param {string} [status='all'] - 状态筛选：all/preparing/announced/active/settled/cancelled
     * @param {number} [page=1] - 页码
     * @param {number} [limit=20] - 每页数量
     * @returns {Promise<Object>} 分页战役列表 { list, total, page, limit }
     */
    static async getWarList(status = 'all', page = 1, limit = 20) {
        // 参数校验与归一化
        const validStatuses = ['all', 'preparing', 'announced', 'active', 'settled', 'cancelled'];
        if (!validStatuses.includes(status)) {
            throw new AppError(`无效的战役状态：${status}`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

        // 构造查询条件
        const where = {};
        if (status !== 'all') {
            where.status = status;
        }

        // 并行查询列表与总数
        const [list, total] = await Promise.all([
            SectWar.findAll({
                where,
                order: [['created_at', 'DESC']],
                offset: (pageNum - 1) * pageSize,
                limit: pageSize
            }),
            SectWar.count({ where })
        ]);

        return {
            list: list.map(w => this._formatWar(w)),
            total,
            page: pageNum,
            limit: pageSize
        };
    }

    /**
     * 获取战役详情（双方分数/参战人员）
     * @param {number} warId - 战役ID
     * @returns {Promise<Object>} 战役详情
     */
    static async getWarDetail(warId) {
        // 查询战役主体
        const war = await SectWar.findByPk(warId);
        if (!war) {
            throw new AppError('战役不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询双方参战人员（含击杀/伤害/贡献）
        const participants = await SectWarParticipant.findAll({
            where: { war_id: warId, leave_time: null },
            order: [['contribution_score', 'DESC']]
        });

        // 按阵营分组
        const attackers = participants.filter(p => p.side === 'attacker');
        const defenders = participants.filter(p => p.side === 'defender');

        // 若有目标资源点，附带资源点信息
        let targetTerritory = null;
        if (war.target_territory_id) {
            const territory = await SectWarTerritory.findByPk(war.target_territory_id);
            if (territory) {
                targetTerritory = this._formatTerritory(territory);
            }
        }

        return {
            ...this._formatWar(war),
            target_territory: targetTerritory,
            attackers: attackers.map(p => this._formatParticipant(p)),
            defenders: defenders.map(p => this._formatParticipant(p)),
            attacker_count: attackers.length,
            defender_count: defenders.length
        };
    }

    /**
     * 获取赛季宗门排行
     * @param {number} [seasonId] - 赛季ID，未传则取当前赛季
     * @param {number} [limit=100] - 返回数量上限
     * @returns {Promise<Array>} 宗门排行列表
     */
    static async getSeasonRanking(seasonId, limit = 100) {
        // 未指定赛季时取当前赛季
        if (!seasonId) {
            const season = await this.getCurrentSeason();
            seasonId = season?.id || 0;
        }
        const topLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

        // 按 total_score 降序查询
        const rankings = await SectWarSeasonRanking.findAll({
            where: { season_id: seasonId },
            order: [['total_score', 'DESC'], ['war_wins', 'DESC']],
            limit: topLimit
        });

        return rankings.map((r, idx) => ({
            rank: idx + 1,
            sect_id: r.sect_id,
            sect_name: r.sect_name,
            total_score: r.total_score,
            war_wins: r.war_wins,
            war_losses: r.war_losses,
            war_draws: r.war_draws,
            territories_held: r.territories_held,
            total_kills: r.total_kills,
            total_participants: r.total_participants,
            final_rank: r.final_rank
        }));
    }

    /**
     * 获取我的参战记录（历史）
     * @param {number} playerId - 玩家ID
     * @param {number} [page=1] - 页码
     * @param {number} [limit=20] - 每页数量
     * @returns {Promise<Object>} 分页参战记录 { list, total, page, limit }
     */
    static async getMyWarRecords(playerId, page = 1, limit = 20) {
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

        const where = { player_id: playerId };
        const [list, total] = await Promise.all([
            SectWarParticipant.findAll({
                where,
                include: [{
                    model: SectWar,
                    as: 'war',
                    required: false,
                    attributes: ['id', 'war_name', 'status', 'attacker_sect_name', 'defender_sect_name', 'winner_sect_id', 'active_start_time', 'settle_time']
                }],
                order: [['join_time', 'DESC']],
                offset: (pageNum - 1) * pageSize,
                limit: pageSize
            }),
            SectWarParticipant.count({ where })
        ]);

        return {
            list: list.map(p => this._formatParticipant(p)),
            total,
            page: pageNum,
            limit: pageSize
        };
    }

    // ============================================================
    // ===== 战役生命周期：宣战/加入/离开/攻击/占领/认输 =====
    // ============================================================

    /**
     * 宗主宣战（消耗宗门资金 declare_cost_spirit_stones 灵石）
     *
     * 校验流程：
     *   1. 玩家存在且未死亡/未封禁
     *   2. 玩家是攻方宗门的宗主（SectFund.leader_player_id 或 PlayerSect.role === 'leader'）
     *   3. 宣战时间窗：开战时间必须为每周三/六 20:00，且提前至少 24 小时
     *   4. 守方宗门存在且与攻方不同
     *   5. 攻方宗门资金 >= declare_cost_spirit_stones
     *   6. 同一攻方对同一守方在目标资源点上不能有进行中战役
     *
     * 写操作：
     *   - 扣除攻方 sect_funds.fund_balance，存入 sect_wars.war_chest
     *   - 创建 sect_wars 记录，状态 preparing
     *   - 推送双方宗门成员通知
     *
     * @param {number} playerId - 宣战玩家ID（宗主）
     * @param {string} defenderSectId - 防守方宗门ID
     * @param {number} targetTerritoryId - 争夺的资源点ID（可选，NULL 表示纯荣誉战）
     * @returns {Promise<Object>} 宣战结果
     */
    static async declareWar(playerId, defenderSectId, targetTerritoryId) {
        const cfg = this.getSectWarConfig();

        // 全局开关校验
        if (cfg.enabled === false) {
            throw new AppError('宗门战系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验
        if (!defenderSectId) {
            throw new AppError('防守方宗门ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 计算下次开战时间（每周三/六 20:00，提前至少 24 小时）
        const warStartTime = this._computeNextWarStartTime(cfg, cfg.prepare_duration_hours || 24);
        if (!warStartTime) {
            throw new AppError('当前时间无法宣战，请在开战前24小时以上发起', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询宣战玩家
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法宣战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁，无法宣战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查询玩家宗门归属
            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            if (!playerSect) {
                await t.commit();
                throw new AppError('尚未加入任何宗门，无法宣战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const attackerSectId = playerSect.sect_id;
            // 不可对自身宗门宣战
            if (attackerSectId === defenderSectId) {
                await t.commit();
                throw new AppError('不可对自身宗门宣战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 获取攻方宗门静态配置（名称）
            const attackerSectConfig = SectService.findSectById ? SectService.findSectById(attackerSectId) : null;
            const attackerSectName = attackerSectConfig?.name || attackerSectId;
            const defenderSectConfig = SectService.findSectById ? SectService.findSectById(defenderSectId) : null;
            if (!defenderSectConfig) {
                await t.commit();
                throw new AppError('防守方宗门不存在', 404, ErrorCodes.NOT_FOUND);
            }
            const defenderSectName = defenderSectConfig.name;

            // 行级锁获取攻方宗门资金记录
            const attackerFund = await this._getOrCreateSectFund(attackerSectId, attackerSectName, t);
            // 宗主校验：SectFund.leader_player_id 优先，回退 PlayerSect.role
            const isLeader = (attackerFund.leader_player_id === Number(playerId)) || (playerSect.role === 'leader');
            if (!isLeader) {
                await t.commit();
                throw new AppError('仅宗主可发起宣战', 403, ErrorCodes.UNAUTHORIZED);
            }

            // 宗门资金校验
            const declareCost = BigInt(cfg.declare_cost_spirit_stones || 5000);
            const fundBalance = safeBigInt(attackerFund.fund_balance);
            if (fundBalance < declareCost) {
                await t.commit();
                throw new AppError(`宗门资金不足，宣战需消耗 ${declareCost.toString()} 灵石`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验目标资源点归属（若指定）：
            // 资源点必须属于守方或无主，且必须存在
            let targetTerritory = null;
            if (targetTerritoryId) {
                targetTerritory = await SectWarTerritory.findByPk(targetTerritoryId, {
                    lock: t.LOCK.UPDATE,
                    transaction: t
                });
                if (!targetTerritory) {
                    await t.commit();
                    throw new AppError('目标资源点不存在', 404, ErrorCodes.NOT_FOUND);
                }
                // 资源点必须属于守方或无主
                if (targetTerritory.owner_sect_id && targetTerritory.owner_sect_id !== defenderSectId) {
                    await t.commit();
                    throw new AppError('目标资源点不属于防守方宗门，无法宣战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // 校验攻方对同一守方在同一资源点上无进行中战役
            const existingWar = await SectWar.findOne({
                where: {
                    attacker_sect_id: attackerSectId,
                    defender_sect_id: defenderSectId,
                    target_territory_id: targetTerritoryId || null,
                    status: { [Op.in]: ['preparing', 'announced', 'active'] }
                },
                transaction: t
            });
            if (existingWar) {
                await t.commit();
                throw new AppError('已对该守方发起过进行中的战役，请等待结算', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验当前赛季
            let season = await SectWarSeason.findOne({
                where: { status: 'active' },
                transaction: t
            });
            if (!season) {
                await t.commit();
                throw new AppError('当前无进行中的赛季，无法宣战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算战役各阶段时间点
            const announceDurationMs = (cfg.announce_duration_hours || 2) * 3600 * 1000;
            const activeDurationMs = (cfg.active_duration_minutes || 30) * 60 * 1000;
            const prepareEndTime = new Date(warStartTime.getTime() - announceDurationMs); // 准备期结束 = 开战前2小时
            const activeEndTime = new Date(warStartTime.getTime() + activeDurationMs);     // 交战期结束 = 开战后30分钟

            // 扣除宗门资金到 war_chest
            attackerFund.fund_balance = fundBalance - declareCost;
            await attackerFund.save({ transaction: t });

            // 创建战役记录
            const warName = `${attackerSectName}讨伐${defenderSectName}${targetTerritory ? '·' + targetTerritory.territory_name : '之战'}`;
            const war = await SectWar.create({
                war_name: warName,
                season_id: season.id,
                attacker_sect_id: attackerSectId,
                attacker_sect_name: attackerSectName,
                defender_sect_id: defenderSectId,
                defender_sect_name: defenderSectName,
                target_territory_id: targetTerritoryId || null,
                status: 'preparing',
                announce_time: new Date(),
                prepare_end_time: prepareEndTime,
                active_start_time: warStartTime,
                active_end_time: activeEndTime,
                attacker_score: 0,
                defender_score: 0,
                attacker_kills: 0,
                defender_kills: 0,
                attacker_participants: 0,
                defender_participants: 0,
                war_chest: declareCost
            }, { transaction: t });

            await t.commit();

            // 事务外推送通知（双方宗门成员）
            this._notifySectMembers(attackerSectId, {
                type: 'sect_war_declare',
                title: '宗门战宣告',
                content: `${attackerSectName} 已向 ${defenderSectName} 宣战，将于 ${warStartTime.toLocaleString('zh-CN')} 开战！请做好战斗准备。`,
                priority: 'high'
            }).catch(err => console.warn('[SectWar] 推送宣战通知失败（攻方）:', err.message));
            this._notifySectMembers(defenderSectId, {
                type: 'sect_war_defend',
                title: '宗门遭袭',
                content: `${attackerSectName} 来犯！目标 ${targetTerritory ? targetTerritory.territory_name : '我宗'}，开战时间 ${warStartTime.toLocaleString('zh-CN')}。请速组织防御！`,
                priority: 'high'
            }).catch(err => console.warn('[SectWar] 推送宣战通知失败（守方）:', err.message));

            return {
                war_id: war.id,
                war_name: war.war_name,
                status: war.status,
                active_start_time: war.active_start_time,
                active_end_time: war.active_end_time,
                prepare_end_time: war.prepare_end_time,
                war_chest: safeBigInt(war.war_chest).toString(),
                message: '宣战成功'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 加入战役（自动分配阵营）
     *
     * 校验流程：
     *   1. 状态机互斥校验（IN_SECT_WAR 与一切状态互斥）
     *   2. 玩家存在且未死亡/未封禁
     *   3. 玩家所属宗门是该战役的攻方或守方
     *   4. 战役状态为 announced 或 active（preparing 阶段不允许加入）
     *   5. 阵营人数未达上限（攻方 max_attackers / 守方 max_defenders）
     *   6. 玩家未已在战役中
     *
     * @param {number} playerId - 玩家ID
     * @param {number} warId - 战役ID
     * @returns {Promise<Object>} 加入结果
     */
    static async joinWar(playerId, warId) {
        const cfg = this.getSectWarConfig();

        // 状态机互斥校验：IN_SECT_WAR 与一切 exclusive 状态互斥
        const stateCheck = await PlayerStateMachine.canStart(
            playerId,
            PlayerStateMachine.PlayerState.IN_SECT_WAR,
            { source: 'route', stateType: 'sect_war' }
        );
        if (!stateCheck.allowed) {
            throw new AppError(stateCheck.reason, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) {
                await t.commit();
                throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (player.is_dead) {
                await t.commit();
                throw new AppError('已身死道消，无法参战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁，无法参战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查询玩家宗门归属
            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            if (!playerSect) {
                await t.commit();
                throw new AppError('尚未加入任何宗门，无法参战', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁查询战役
            const war = await SectWar.findByPk(warId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!war) {
                await t.commit();
                throw new AppError('战役不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 战役状态校验：preparing 阶段不允许加入（仅 announced/active 可加入）
            if (!['announced', 'active'].includes(war.status)) {
                await t.commit();
                throw new AppError(`当前战役状态为 ${war.status}，无法加入`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 阵营判定：玩家宗门是攻方还是守方
            let side;
            if (playerSect.sect_id === war.attacker_sect_id) {
                side = 'attacker';
            } else if (playerSect.sect_id === war.defender_sect_id) {
                side = 'defender';
            } else {
                await t.commit();
                throw new AppError('本宗门非该战役参战方，无法加入', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 阵营人数上限校验
            const maxCount = side === 'attacker'
                ? (cfg.max_attackers || 20)
                : (cfg.max_defenders || 30);
            const currentCount = await SectWarParticipant.count({
                where: { war_id: warId, side, leave_time: null },
                transaction: t
            });
            if (currentCount >= maxCount) {
                await t.commit();
                throw new AppError(`${side === 'attacker' ? '攻方' : '守方'}参战人数已达上限（${maxCount}人）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验玩家未已在战役中（含其他战役）
            const existing = await SectWarParticipant.findOne({
                where: { player_id: playerId, leave_time: null },
                transaction: t
            });
            if (existing) {
                await t.commit();
                throw new AppError('已在其他宗门战中，请先离开后再加入', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 获取宗门静态配置（名称）
            const sectConfig = SectService.findSectById ? SectService.findSectById(playerSect.sect_id) : null;
            const sectName = sectConfig?.name || playerSect.sect_id;

            // 初始化玩家战斗 HP/MP（写入 attributes JSON）
            const attrs = { ...(player.attributes || {}) };
            const fullAttrs = AttributeService.calculateFullAttributes(player);
            attrs.hp_current = Number(fullAttrs.final.hp_max) || 100;
            attrs.mp_current = Number(fullAttrs.final.mp_max) || 0;
            attrs.sect_war_defend_until = null;  // 无防御 buff
            attrs.sect_war_death_time = null;    // 无死亡时间
            player.attributes = attrs;
            await player.save({ transaction: t });

            // 创建参战记录
            const participant = await SectWarParticipant.create({
                war_id: warId,
                player_id: playerId,
                player_nickname: player.nickname,
                sect_id: playerSect.sect_id,
                sect_name: sectName,
                side,
                kill_count: 0,
                death_count: 0,
                damage_dealt: 0,
                damage_taken: 0,
                contribution_score: 0,
                honor_rewarded: 0,
                spirit_stone_rewarded: 0,
                is_online: 1,
                join_time: new Date()
            }, { transaction: t });

            // 累加战役参战人数
            if (side === 'attacker') {
                war.attacker_participants = (war.attacker_participants || 0) + 1;
            } else {
                war.defender_participants = (war.defender_participants || 0) + 1;
            }
            await war.save({ transaction: t });

            await t.commit();

            // 推送玩家参战状态更新
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'sect_war_joined', {
                war_id: warId,
                war_name: war.war_name,
                side,
                role: playerSect.role
            });

            return {
                war_id: warId,
                war_name: war.war_name,
                side,
                participant_id: participant.id,
                hp_current: attrs.hp_current,
                hp_max: Number(fullAttrs.final.hp_max) || 100,
                message: '成功加入战役'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 离开战役
     * @param {number} playerId - 玩家ID
     * @param {number} warId - 战役ID
     * @returns {Promise<Object>} 离开结果
     */
    static async leaveWar(playerId, warId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁查询参战记录
            const participant = await SectWarParticipant.findOne({
                where: { war_id: warId, player_id: playerId, leave_time: null },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!participant) {
                await t.commit();
                throw new AppError('未在该战役中或已离开', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 标记离开时间
            participant.leave_time = new Date();
            participant.is_online = 0;
            await participant.save({ transaction: t });

            // 战役参战人数递减（不低于 0）
            const war = await SectWar.findByPk(warId, { transaction: t });
            if (war) {
                if (participant.side === 'attacker') {
                    war.attacker_participants = Math.max(0, (war.attacker_participants || 0) - 1);
                } else {
                    war.defender_participants = Math.max(0, (war.defender_participants || 0) - 1);
                }
                await war.save({ transaction: t });
            }

            // 清理玩家 attributes 中的宗门战临时字段
            const player = await Player.findByPk(playerId, { transaction: t });
            if (player) {
                const attrs = { ...(player.attributes || {}) };
                delete attrs.sect_war_defend_until;
                delete attrs.sect_war_death_time;
                player.attributes = attrs;
                await player.save({ transaction: t });
            }

            await t.commit();

            // 推送玩家离开通知
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'sect_war_left', {
                war_id: warId,
                message: '已离开战役'
            });

            return { war_id: warId, message: '已离开战役' };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 攻击敌方玩家（复用 PvpService 战斗公式）
     *
     * 校验流程：
     *   1. 行级锁双方玩家
     *   2. 双方都在同一战役且不同阵营
     *   3. 战役状态为 active
     *   4. 攻击方未在占领资源点（占领中移动则中断）
     *   5. 防守方未死亡或已过复活冷却
     *
     * 伤害计算（参考 PvpService.executeAction）：
     *   单次伤害 = max(1, atk × 技能倍率 - def × 减伤系数) × 暴击系数 × 随机浮动
     *
     * @param {number} attackerId - 攻击方玩家ID
     * @param {number} warId - 战役ID
     * @param {number} targetPlayerId - 防守方玩家ID
     * @param {string} action - 行动类型：attack/skill/defend
     * @returns {Promise<Object>} 攻击结果
     */
    static async attackPlayer(attackerId, warId, targetPlayerId, action) {
        const cfg = this.getSectWarConfig();

        // 参数校验
        const allowedActions = ['attack', 'skill', 'defend'];
        if (!allowedActions.includes(action)) {
            throw new AppError(`无效的行动类型：${action}，可选值：${allowedActions.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 不可攻击自己
        if (Number(attackerId) === Number(targetPlayerId)) {
            throw new AppError('不可攻击自己', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询双方参战记录
            const [attackerP, defenderP] = await Promise.all([
                SectWarParticipant.findOne({
                    where: { war_id: warId, player_id: attackerId, leave_time: null },
                    lock: t.LOCK.UPDATE,
                    transaction: t
                }),
                SectWarParticipant.findOne({
                    where: { war_id: warId, player_id: targetPlayerId, leave_time: null },
                    lock: t.LOCK.UPDATE,
                    transaction: t
                })
            ]);
            if (!attackerP) {
                await t.commit();
                throw new AppError('你未在该战役中或已离开', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (!defenderP) {
                await t.commit();
                throw new AppError('目标未在该战役中或已离开', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 阵营校验：双方必须不同阵营
            if (attackerP.side === defenderP.side) {
                await t.commit();
                throw new AppError('不可攻击同阵营玩家', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁查询战役
            const war = await SectWar.findByPk(warId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!war || war.status !== 'active') {
                await t.commit();
                throw new AppError('战役不在交战期，无法攻击', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁双方玩家
            const [attacker, defender] = await Promise.all([
                Player.findByPk(attackerId, { lock: t.LOCK.UPDATE, transaction: t }),
                Player.findByPk(targetPlayerId, { lock: t.LOCK.UPDATE, transaction: t })
            ]);
            if (!attacker || !defender) {
                await t.commit();
                throw new AppError('玩家数据异常', 404, ErrorCodes.NOT_FOUND);
            }

            // 计算双方完整属性（含装备加成）
            const attackerFull = await AttributeService.calculateFullAttributesAsync(attacker);
            const defenderFull = await AttributeService.calculateFullAttributesAsync(defender);
            const attackerAtk = Number(attackerFull.final.atk) || 10;
            const defenderDef = Number(defenderFull.final.def) || 5;
            const attackerHpMax = Number(attackerFull.final.hp_max) || 100;
            const defenderHpMax = Number(defenderFull.final.hp_max) || 100;

            // 读取玩家 attributes 中的战斗 HP/MP
            const attackerAttrs = { ...(attacker.attributes || {}) };
            const defenderAttrs = { ...(defender.attributes || {}) };
            let attackerHp = Number(attackerAttrs.hp_current);
            if (!Number.isFinite(attackerHp) || attackerHp <= 0) attackerHp = attackerHpMax;
            let attackerMp = Number(attackerAttrs.mp_current) || 0;
            let defenderHp = Number(defenderAttrs.hp_current);
            if (!Number.isFinite(defenderHp) || defenderHp <= 0) defenderHp = defenderHpMax;
            const defenderMp = Number(defenderAttrs.mp_current) || 0;

            // 攻击方死亡复活校验：若已阵亡且未过复活冷却，不可攻击
            const respawnSeconds = cfg.respawn_seconds || 60;
            if (attackerAttrs.sect_war_death_time) {
                const deathTime = new Date(attackerAttrs.sect_war_death_time).getTime();
                const elapsed = (Date.now() - deathTime) / 1000;
                if (elapsed < respawnSeconds) {
                    await t.commit();
                    const remain = Math.ceil(respawnSeconds - elapsed);
                    throw new AppError(`已阵亡，等待复活中（剩余 ${remain} 秒）`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                // 已过复活冷却，自动复活
                attackerHp = attackerHpMax;
                attackerAttrs.sect_war_death_time = null;
            }

            // 防守方死亡校验：不可攻击已死亡玩家
            if (defenderAttrs.sect_war_death_time) {
                const deathTime = new Date(defenderAttrs.sect_war_death_time).getTime();
                const elapsed = (Date.now() - deathTime) / 1000;
                if (elapsed < respawnSeconds) {
                    await t.commit();
                    throw new AppError('目标已阵亡，等待复活中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                // 防守方已过复活冷却，自动复活（但仍可被攻击）
                defenderHp = defenderHpMax;
                defenderAttrs.sect_war_death_time = null;
            }

            // 读取战斗相关配置（减伤系数/暴击/随机浮动）
            const reduceRate = 0.5;          // 减伤系数：DEF × 0.5
            const critRate = 0.05;           // 暴击概率：5%
            const critMultiplier = 1.5;      // 暴击倍率：1.5
            const randomRange = 0.15;        // 随机浮动：±15%
            const skillMpCost = configLoader.getConfig('game_balance')?.combat?.skill_mp_cost || 20;

            // 计算伤害
            let damage = 0n;
            let actualAction = action;
            let isCrit = false;
            if (action === 'attack') {
                // 普攻：技能倍率 1.0
                damage = this._calculateDamage(attackerAtk, 1.0, defenderDef, reduceRate, critRate, critMultiplier, randomRange);
                isCrit = damage.isCrit;
                damage = damage.value;
            } else if (action === 'skill') {
                // 技能攻击：技能倍率 1.5，消耗 MP
                if (attackerMp >= skillMpCost) {
                    attackerMp -= skillMpCost;
                    damage = this._calculateDamage(attackerAtk, 1.5, defenderDef, reduceRate, critRate, critMultiplier, randomRange);
                    isCrit = damage.isCrit;
                    damage = damage.value;
                } else {
                    // MP 不足，降级为普通攻击
                    actualAction = 'attack';
                    damage = this._calculateDamage(attackerAtk, 1.0, defenderDef, reduceRate, critRate, critMultiplier, randomRange);
                    isCrit = damage.isCrit;
                    damage = damage.value;
                }
            } else if (action === 'defend') {
                // 防御：本回合不造成伤害，恢复少量 MP，设置 5 秒防御 buff（受击伤害减半）
                attackerMp = Math.min(attackerMp + 10, Number(attackerFull.final.mp_max) || 0);
                attackerAttrs.sect_war_defend_until = new Date(Date.now() + 5000).toISOString();
                damage = 0n;
            }

            // 检查防守方是否有防御 buff（受击伤害减半）
            let actualDamage = damage;
            if (defenderAttrs.sect_war_defend_until) {
                const defendUntil = new Date(defenderAttrs.sect_war_defend_until).getTime();
                if (Date.now() < defendUntil && action !== 'defend') {
                    actualDamage = damage / 2n;
                    // 防御 buff 消耗后清除
                    defenderAttrs.sect_war_defend_until = null;
                } else if (Date.now() >= defendUntil) {
                    // 过期清除
                    defenderAttrs.sect_war_defend_until = null;
                }
            }

            // 应用伤害到防守方
            defenderHp = Math.max(0, defenderHp - Number(actualDamage));

            // 检查防守方是否阵亡
            let defenderKilled = false;
            if (defenderHp <= 0) {
                defenderKilled = true;
                defenderAttrs.sect_war_death_time = new Date().toISOString();
                // 累加击杀/死亡统计
                attackerP.kill_count = (attackerP.kill_count || 0) + 1;
                defenderP.death_count = (defenderP.death_count || 0) + 1;
                // 累加战役击杀数
                if (attackerP.side === 'attacker') {
                    war.attacker_kills = (war.attacker_kills || 0) + 1;
                } else {
                    war.defender_kills = (war.defender_kills || 0) + 1;
                }
                // 击杀荣誉奖励
                const honorPerKill = cfg.honor_per_kill || 5;
                attackerP.contribution_score = (attackerP.contribution_score || 0) + 10; // 击杀贡献分
            }

            // 回写防守方 HP/MP
            defenderAttrs.hp_current = defenderHp;
            defenderAttrs.mp_current = defenderMp;
            defender.attributes = defenderAttrs;

            // 回写攻击方 HP/MP
            attackerAttrs.hp_current = attackerHp;
            attackerAttrs.mp_current = attackerMp;
            attacker.attributes = attackerAttrs;

            // 累加伤害统计（BIGINT 安全）
            attackerP.damage_dealt = safeBigInt(attackerP.damage_dealt) + actualDamage;
            defenderP.damage_taken = safeBigInt(defenderP.damage_taken) + actualDamage;
            // 伤害贡献分：每 100 伤害 1 分
            attackerP.contribution_score = (attackerP.contribution_score || 0) + Math.floor(Number(actualDamage) / 100);

            // 持久化双方玩家与参战记录
            await attacker.save({ transaction: t });
            await defender.save({ transaction: t });
            await attackerP.save({ transaction: t });
            await defenderP.save({ transaction: t });
            await war.save({ transaction: t });

            await t.commit();

            // 事务外推送 WebSocket 通知
            WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, 'sect_war_attacked', {
                war_id: warId,
                attacker_id: attackerId,
                attacker_nickname: attacker.nickname,
                action: actualAction,
                damage: actualDamage.toString(),
                is_crit: isCrit,
                hp_current: defenderHp,
                hp_max: defenderHpMax,
                killed: defenderKilled
            });
            WebSocketNotificationService.notifyPlayerUpdate(attackerId, 'sect_war_attack_result', {
                war_id: warId,
                target_id: targetPlayerId,
                target_nickname: defender.nickname,
                action: actualAction,
                damage: actualDamage.toString(),
                is_crit: isCrit,
                killed: defenderKilled,
                contribution_score: attackerP.contribution_score
            });

            return {
                war_id: warId,
                action: actualAction,
                damage: actualDamage.toString(),
                is_crit: isCrit,
                attacker_hp: attackerHp,
                defender_hp: defenderHp,
                defender_killed: defenderKilled,
                attacker_contribution: attackerP.contribution_score,
                attacker_kills: attackerP.kill_count
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 占领资源点（在资源点停留 territory_capture_seconds 秒不被打断）
     *
     * 实现说明：
     *   - 使用内存 setTimeout 维护 30 秒计时（territory_capture_seconds 配置）
     *   - 同时持久化 territory.is_under_attack = 1，便于前端展示与重启恢复
     *   - 占领期间玩家被攻击不会自动中断（需攻击方主动取消或重新占领）
     *     但被攻击致死亡会中断（attackPlayer 中检测到死亡会清除此 capture）
     *   - 服务重启后内存计时器丢失，需调用 clearStaleCaptureFlags 清理脏标志
     *
     * 校验流程：
     *   1. 玩家是攻方阵营
     *   2. 资源点属于守方或无主
     *   3. 战役状态为 active
     *   4. 该资源点未被其他玩家占领中
     *
     * @param {number} playerId - 玩家ID
     * @param {number} warId - 战役ID
     * @param {number} territoryId - 资源点ID
     * @returns {Promise<Object>} 占领开始结果
     */
    static async captureTerritory(playerId, warId, territoryId) {
        const cfg = this.getSectWarConfig();
        const captureSeconds = cfg.territory_capture_seconds || 30;

        // 内存级校验：该资源点是否已被其他玩家占领中
        const captureKey = `${warId}_${territoryId}`;
        const existingCapture = this.activeCaptures.get(captureKey);
        if (existingCapture) {
            if (existingCapture.playerId !== Number(playerId)) {
                throw new AppError('该资源点正被其他玩家占领中', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 同一玩家重复请求，返回已在占领中
            const elapsed = (Date.now() - existingCapture.startTime) / 1000;
            const remain = Math.max(0, Math.ceil(captureSeconds - elapsed));
            return {
                war_id: warId,
                territory_id: territoryId,
                status: 'capturing',
                remaining_seconds: remain,
                message: '占领进行中'
            };
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询参战记录
            const participant = await SectWarParticipant.findOne({
                where: { war_id: warId, player_id: playerId, leave_time: null },
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!participant) {
                await t.commit();
                throw new AppError('未在该战役中或已离开', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 仅攻方可占领资源点
            if (participant.side !== 'attacker') {
                await t.commit();
                throw new AppError('仅攻方可占领资源点', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁查询战役
            const war = await SectWar.findByPk(warId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!war || war.status !== 'active') {
                await t.commit();
                throw new AppError('战役不在交战期，无法占领', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁查询资源点
            const territory = await SectWarTerritory.findByPk(territoryId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!territory) {
                await t.commit();
                throw new AppError('资源点不存在', 404, ErrorCodes.NOT_FOUND);
            }
            // 资源点必须属于守方或无主
            if (territory.owner_sect_id && territory.owner_sect_id !== war.defender_sect_id) {
                await t.commit();
                throw new AppError('该资源点不属于防守方，无法在此战役中占领', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 校验资源点属于本战役的目标资源点或同赛季任意资源点
            if (territory.season_id !== war.season_id) {
                await t.commit();
                throw new AppError('资源点不属于本赛季', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 标记资源点为被攻击状态
            territory.is_under_attack = 1;
            territory.last_battle_time = new Date();
            await territory.save({ transaction: t });

            await t.commit();
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }

        // 事务外启动 30 秒占领计时（异步，不阻塞响应）
        const startTime = Date.now();
        const timeoutId = setTimeout(() => {
            this._completeCapture(warId, territoryId, playerId).catch(err => {
                console.warn(`[SectWar] 完成占领失败 war=${warId} territory=${territoryId} player=${playerId}:`, err.message);
            });
        }, captureSeconds * 1000);

        this.activeCaptures.set(captureKey, {
            playerId: Number(playerId),
            startTime,
            timeoutId
        });

        // 推送占领开始通知
        WebSocketNotificationService.notifyPlayerUpdate(playerId, 'sect_war_capture_start', {
            war_id: warId,
            territory_id: territoryId,
            capture_seconds: captureSeconds,
            message: '开始占领资源点'
        });

        return {
            war_id: warId,
            territory_id: territoryId,
            status: 'capturing',
            remaining_seconds: captureSeconds,
            message: '开始占领资源点，需保持不被击杀'
        };
    }

    /**
     * 宗主认输
     * @param {number} playerId - 认输玩家ID（宗主）
     * @param {number} warId - 战役ID
     * @returns {Promise<Object>} 认输结果
     */
    static async surrender(playerId, warId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁查询战役
            const war = await SectWar.findByPk(warId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!war) {
                await t.commit();
                throw new AppError('战役不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (war.status !== 'active') {
                await t.commit();
                throw new AppError('战役不在交战期，无法认输', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查询玩家宗门归属
            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            if (!playerSect) {
                await t.commit();
                throw new AppError('尚未加入任何宗门', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 判定认输方阵营
            let surrenderSide;
            if (playerSect.sect_id === war.attacker_sect_id) {
                surrenderSide = 'attacker';
            } else if (playerSect.sect_id === war.defender_sect_id) {
                surrenderSide = 'defender';
            } else {
                await t.commit();
                throw new AppError('本宗门非该战役参战方', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 宗主校验
            const fund = await this._getOrCreateSectFund(playerSect.sect_id, playerSect.sect_id, t);
            const isLeader = (fund.leader_player_id === Number(playerId)) || (playerSect.role === 'leader');
            if (!isLeader) {
                await t.commit();
                throw new AppError('仅宗主可认输', 403, ErrorCodes.UNAUTHORIZED);
            }

            // 认输方判负，对方获胜
            const winnerSectId = surrenderSide === 'attacker' ? war.defender_sect_id : war.attacker_sect_id;
            const loserSectId = surrenderSide === 'attacker' ? war.attacker_sect_id : war.defender_sect_id;
            war.winner_sect_id = winnerSectId;
            war.loser_sect_id = loserSectId;
            war.status = 'settled';
            war.settle_time = new Date();

            // 调用内部结算
            const settleResult = await this._settleWar(war, t);
            await t.commit();

            // 大五行幻世轮：宗门战认输结算后所有参与者自动积累悟印（未装备时静默返回）
            try {
                const swParticipants = await SectWarParticipant.findAll({ where: { war_id: war.id } });
                if (swParticipants && swParticipants.length > 0) {
                    await Promise.all(swParticipants.map(p =>
                        ArtifactDeepLineService.safeAddInsightExp(p.player_id, {
                            battle_type: 'pvp',
                            is_win: p.sect_id === winnerSectId
                        })
                    ));
                }
            } catch (e) { /* 悟印积累失败不阻塞主流程 */ }

            // 推送双方宗门成员通知
            this._notifySectMembers(war.attacker_sect_id, {
                type: 'sect_war_end',
                title: '战役结束',
                content: `${war.war_name} 已结束，${surrenderSide === 'attacker' ? '我方认输' : '对方认输'}，胜方：${winnerSectId === war.attacker_sect_id ? war.attacker_sect_name : war.defender_sect_name}`,
                priority: 'high'
            }).catch(() => {});
            this._notifySectMembers(war.defender_sect_id, {
                type: 'sect_war_end',
                title: '战役结束',
                content: `${war.war_name} 已结束，${surrenderSide === 'defender' ? '我方认输' : '对方认输'}，胜方：${winnerSectId === war.attacker_sect_id ? war.attacker_sect_name : war.defender_sect_name}`,
                priority: 'high'
            }).catch(() => {});

            return {
                war_id: warId,
                status: 'settled',
                winner_sect_id: winnerSectId,
                loser_sect_id: loserSectId,
                settle: settleResult,
                message: '认输成功，战役已结算'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    // ============================================================
    // ===== 调度器调用：状态推进/结算/产出/赛季管理 =====
    // ============================================================

    /**
     * 战役状态推进（preparing → announced → active → settled）
     * 由 SectWarSchedulerService 每 30 秒调用一次
     * @param {number} warId - 战役ID
     * @returns {Promise<Object|null>} 推进结果，无变化返回 null
     */
    static async advanceWarState(warId) {
        const t = await sequelize.transaction();
        try {
            // 行级锁查询战役
            const war = await SectWar.findByPk(warId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!war) {
                await t.commit();
                return null;
            }
            // 仅处理未结算的战役
            if (['settled', 'cancelled'].includes(war.status)) {
                await t.commit();
                return null;
            }

            const now = new Date();
            let advanced = false;

            // preparing → announced：到达 prepare_end_time
            if (war.status === 'preparing' && war.prepare_end_time && now >= war.prepare_end_time) {
                war.status = 'announced';
                advanced = true;
            }
            // announced → active：到达 active_start_time
            if (war.status === 'announced' && war.active_start_time && now >= war.active_start_time) {
                war.status = 'active';
                advanced = true;
                // 推送开战通知
                this._notifySectMembers(war.attacker_sect_id, {
                    type: 'sect_war_active',
                    title: '战役开始',
                    content: `${war.war_name} 已进入交战期！速速加入战场！`,
                    priority: 'high'
                }).catch(() => {});
                this._notifySectMembers(war.defender_sect_id, {
                    type: 'sect_war_active',
                    title: '战役开始',
                    content: `${war.war_name} 已进入交战期！速速组织防御！`,
                    priority: 'high'
                }).catch(() => {});
            }
            // active → settled：到达 active_end_time
            if (war.status === 'active' && war.active_end_time && now >= war.active_end_time) {
                war.status = 'settled';
                war.settle_time = now;
                advanced = true;
                // 调用结算（事务内）
                await this._settleWar(war, t);
            }

            if (advanced) {
                await war.save({ transaction: t });
            }
            await t.commit();

            // 大五行幻世轮：宗门战自然结算后所有参与者自动积累悟印（未装备时静默返回）
            if (war.status === 'settled' && war.winner_sect_id) {
                try {
                    const swParticipants = await SectWarParticipant.findAll({ where: { war_id: war.id } });
                    if (swParticipants && swParticipants.length > 0) {
                        await Promise.all(swParticipants.map(p =>
                            ArtifactDeepLineService.safeAddInsightExp(p.player_id, {
                                battle_type: 'pvp',
                                is_win: p.sect_id === war.winner_sect_id
                            })
                        ));
                    }
                } catch (e) { /* 悟印积累失败不阻塞主流程 */ }
            }

            return advanced ? { war_id: warId, status: war.status } : null;
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 内部：战役结算
     * 胜负判定：积分高者胜，平局守方胜
     * 攻方积分 = 占领资源点数 × attacker_score_per_territory + 攻方击杀 × attacker_score_per_kill
     * 守方积分 = 防守成功资源点数 × defender_score_per_territory + 守方击杀 × defender_score_per_kill
     *
     * 结算内容：
     *   1. 计算最终积分与胜负
     *   2. 更新 sect_wars.winner_sect_id/loser_sect_id
     *   3. 发放奖励：胜方分得 war_chest，参战人员荣誉值
     *   4. 更新 sect_funds（资金/积分）
     *   5. 更新 sect_war_season_rankings（赛季宗门积分/胜负）
     *   6. 若有资源点易主，更新 sect_war_territories 归属
     *
     * @param {Object} war - SectWar 实例（已加锁）
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} 结算结果
     */
    static async _settleWar(war, t) {
        const cfg = this.getSectWarConfig();

        // 实时计算双方积分（基于当前击杀数与资源点占领）
        // 资源点占领数：查询本战役期间被攻方占领的资源点
        let attackerTerritories = 0;
        let defenderTerritories = 0;
        if (war.target_territory_id) {
            // 单资源点战役：若资源点已被攻方占领，则攻方+1，否则守方+1（防守成功）
            const territory = await SectWarTerritory.findByPk(war.target_territory_id, { transaction: t });
            if (territory && territory.owner_sect_id === war.attacker_sect_id) {
                attackerTerritories = 1;
            } else {
                defenderTerritories = 1;
            }
        } else {
            // 纯荣誉战：无资源点，按击杀数判定
        }

        const attackerScorePerTerritory = cfg.attacker_score_per_territory || 100;
        const attackerScorePerKill = cfg.attacker_score_per_kill || 5;
        const defenderScorePerTerritory = cfg.defender_score_per_territory || 100;
        const defenderScorePerKill = cfg.defender_score_per_kill || 5;

        // 重算实时积分（覆盖 war.attacker_score/defender_score）
        war.attacker_score = attackerTerritories * attackerScorePerTerritory + (war.attacker_kills || 0) * attackerScorePerKill;
        war.defender_score = defenderTerritories * defenderScorePerTerritory + (war.defender_kills || 0) * defenderScorePerKill;

        // 胜负判定：积分高者胜，平局守方胜（守方优势）
        let winnerSectId, loserSectId, isDraw = false;
        // 若 surrender 已设置 winner_sect_id，优先使用
        if (war.winner_sect_id) {
            winnerSectId = war.winner_sect_id;
            loserSectId = war.loser_sect_id || (winnerSectId === war.attacker_sect_id ? war.defender_sect_id : war.attacker_sect_id);
        } else if (war.attacker_score > war.defender_score) {
            winnerSectId = war.attacker_sect_id;
            loserSectId = war.defender_sect_id;
        } else if (war.defender_score > war.attacker_score) {
            winnerSectId = war.defender_sect_id;
            loserSectId = war.attacker_sect_id;
        } else {
            // 平局：守方胜
            winnerSectId = war.defender_sect_id;
            loserSectId = war.attacker_sect_id;
            isDraw = true;
        }
        war.winner_sect_id = winnerSectId;
        war.loser_sect_id = loserSectId;

        // 发放奖励：胜方获得 war_chest
        const warChest = safeBigInt(war.war_chest);
        const winnerFund = await this._getOrCreateSectFund(winnerSectId,
            winnerSectId === war.attacker_sect_id ? war.attacker_sect_name : war.defender_sect_name, t);
        winnerFund.fund_balance = safeBigInt(winnerFund.fund_balance) + warChest;
        // 胜方宗门积分
        const honorPerWin = cfg.honor_per_win || 50;
        const honorPerLoss = cfg.honor_per_loss || 10;
        winnerFund.season_war_score = (winnerFund.season_war_score || 0) + (war.attacker_score + war.defender_score);
        winnerFund.war_score = (winnerFund.war_score || 0) + 100; // 历史总积分
        await winnerFund.save({ transaction: t });

        // 败方宗门积分（少量）
        const loserFund = await this._getOrCreateSectFund(loserSectId,
            loserSectId === war.attacker_sect_id ? war.attacker_sect_name : war.defender_sect_name, t);
        loserFund.season_war_score = (loserFund.season_war_score || 0) + Math.floor((war.attacker_score + war.defender_score) / 2);
        loserFund.war_score = (loserFund.war_score || 0) + 30;
        await loserFund.save({ transaction: t });

        // 更新赛季宗门排行（胜负/积分/击杀/参战人次）
        await this._updateSeasonRanking(war.season_id, war.attacker_sect_id, war.attacker_sect_name, {
            is_win: winnerSectId === war.attacker_sect_id,
            is_draw: isDraw,
            score: war.attacker_score,
            kills: war.attacker_kills,
            participants: war.attacker_participants,
            territories_held_delta: attackerTerritories - defenderTerritories > 0 ? 1 : 0
        }, t);
        await this._updateSeasonRanking(war.season_id, war.defender_sect_id, war.defender_sect_name, {
            is_win: winnerSectId === war.defender_sect_id,
            is_draw: isDraw,
            score: war.defender_score,
            kills: war.defender_kills,
            participants: war.defender_participants,
            territories_held_delta: defenderTerritories - attackerTerritories > 0 ? 1 : 0
        }, t);

        // 发放参战人员荣誉值（胜方 honor_per_win，败方 honor_per_loss）
        const participants = await SectWarParticipant.findAll({
            where: { war_id: war.id },
            transaction: t
        });
        for (const p of participants) {
            const isWinner = p.sect_id === winnerSectId;
            const honorGain = isWinner ? honorPerWin : honorPerLoss;
            p.honor_rewarded = honorGain;
            // 贡献分按伤害/击杀综合计算（已在 attackPlayer 中累加）
            p.spirit_stone_rewarded = isWinner ? BigInt(Math.floor(Number(warChest) * 0.1 / Math.max(1, participants.filter(pp => pp.sect_id === winnerSectId).length))) : 0n;
            await p.save({ transaction: t });

            // 累加玩家荣誉值（事务外推送，避免锁竞争）
            // 注意：玩家行未加锁，使用 increment 原子操作
            await Player.increment({ honor: honorGain }, {
                where: { id: p.player_id },
                transaction: t
            });
        }

        // 资源点易主：若攻方占领了目标资源点，更新归属
        if (war.target_territory_id && attackerTerritories > 0) {
            const territory = await SectWarTerritory.findByPk(war.target_territory_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (territory) {
                const oldOwnerId = territory.owner_sect_id;
                territory.owner_sect_id = war.attacker_sect_id;
                territory.owner_sect_name = war.attacker_sect_name;
                territory.owner_since = new Date();
                territory.is_under_attack = 0;
                await territory.save({ transaction: t });

                // 更新双方宗门的 territories_count
                if (oldOwnerId) {
                    await SectFund.decrement({ territories_count: 1 }, {
                        where: { sect_id: oldOwnerId },
                        transaction: t
                    });
                }
                await SectFund.increment({ territories_count: 1 }, {
                    where: { sect_id: war.attacker_sect_id },
                    transaction: t
                });
            }
        }

        // 清理内存中本战役的占领计时器
        for (const [key, capture] of this.activeCaptures.entries()) {
            if (key.startsWith(`${war.id}_`)) {
                clearTimeout(capture.timeoutId);
                this.activeCaptures.delete(key);
            }
        }

        return {
            winner_sect_id: winnerSectId,
            loser_sect_id: loserSectId,
            is_draw: isDraw,
            attacker_score: war.attacker_score,
            defender_score: war.defender_score,
            war_chest_distributed: warChest.toString(),
            participant_count: participants.length
        };
    }

    /**
     * 资源点产出（每日结算）
     * 由调度器在每日 00:05 触发
     * 按资源点类型产出：灵石/材料/贡献度
     * @returns {Promise<Object>} 产出结算统计
     */
    static async settleTerritoryProduction() {
        const cfg = this.getSectWarConfig();
        const productionRates = cfg.production_rates || {};
        const stats = { territories_settled: 0, spirit_stones_distributed: 0n, materials_distributed: 0, contribution_distributed: 0 };

        // 查询当前赛季
        const season = await this.getCurrentSeason();
        if (!season) {
            return stats;
        }

        // 查询本赛季所有已占领的资源点
        const territories = await SectWarTerritory.findAll({
            where: {
                season_id: season.id,
                owner_sect_id: { [Op.ne]: null }
            }
        });

        const t = await sequelize.transaction();
        try {
            for (const territory of territories) {
                // 按类型计算产出量
                const productionRate = productionRates[territory.territory_type] || 0;
                if (productionRate <= 0) continue;

                if (territory.production_type === 'spirit_stones') {
                    // 灵脉：产出灵石到宗门资金
                    const fund = await this._getOrCreateSectFund(territory.owner_sect_id, territory.owner_sect_name || territory.owner_sect_id, t);
                    fund.fund_balance = safeBigInt(fund.fund_balance) + BigInt(productionRate);
                    await fund.save({ transaction: t });
                    stats.spirit_stones_distributed += BigInt(productionRate);
                } else if (territory.production_type === 'contribution') {
                    // 秘境入口：产出贡献度，均分给宗门成员
                    const members = await PlayerSect.findAll({
                        where: { sect_id: territory.owner_sect_id },
                        transaction: t
                    });
                    if (members.length > 0) {
                        const perMember = Math.floor(productionRate / members.length);
                        if (perMember > 0) {
                            // 累加贡献度（直接更新 PlayerSect.contribution）
                            await PlayerSect.increment({ contribution: perMember }, {
                                where: { sect_id: territory.owner_sect_id },
                                transaction: t
                            });
                            stats.contribution_distributed += perMember * members.length;
                        }
                    }
                }
                // materials 类型暂不入库（缺材料库存表，预留扩展点）
                stats.territories_settled++;
            }
            await t.commit();
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }

        console.log(`[SectWar] 资源点日产出结算完成: ${stats.territories_settled} 个资源点，灵石 ${stats.spirit_stones_distributed.toString()}`);
        return stats;
    }

    /**
     * 创建新赛季
     * @param {string} seasonName - 赛季名称
     * @param {string} startDate - 开始日期 YYYY-MM-DD
     * @param {string} endDate - 结束日期 YYYY-MM-DD
     * @returns {Promise<Object>} 创建结果
     */
    static async createSeason(seasonName, startDate, endDate) {
        if (!seasonName || !startDate || !endDate) {
            throw new AppError('赛季名称、开始日期、结束日期均不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验日期格式
        const start = new Date(startDate);
        const end = new Date(endDate);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            throw new AppError('日期格式无效，需为 YYYY-MM-DD', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (start >= end) {
            throw new AppError('开始日期必须早于结束日期', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            // 校验无 active 赛季
            const activeSeason = await SectWarSeason.findOne({
                where: { status: 'active' },
                transaction: t
            });
            if (activeSeason) {
                await t.commit();
                throw new AppError(`已有进行中的赛季：${activeSeason.season_name}，请先结算`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 创建赛季
            const season = await SectWarSeason.create({
                season_name: seasonName,
                start_date: startDate,
                end_date: endDate,
                status: 'active',
                total_wars: 0,
                total_participants: 0
            }, { transaction: t });

            // 初始化赛季资源点（按静态配置创建，清空归属）
            await this.initializeTerritories(season.id, t);

            await t.commit();

            return {
                season_id: season.id,
                season_name: season.season_name,
                start_date: season.start_date,
                end_date: season.end_date,
                status: season.status,
                message: '赛季创建成功'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 赛季结算
     * 按赛季宗门排行发放奖励（前1/2-3/4-10名）
     * @param {number} seasonId - 赛季ID
     * @returns {Promise<Object>} 结算结果
     */
    static async settleSeason(seasonId) {
        const cfg = this.getSectWarConfig();
        const rewards = cfg.rewards || {};

        const t = await sequelize.transaction();
        try {
            // 行级锁查询赛季
            const season = await SectWarSeason.findByPk(seasonId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!season) {
                await t.commit();
                throw new AppError('赛季不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (season.status === 'ended') {
                await t.commit();
                throw new AppError('赛季已结算', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 查询赛季宗门排行（按 total_score 降序）
            const rankings = await SectWarSeasonRanking.findAll({
                where: { season_id: seasonId },
                order: [['total_score', 'DESC'], ['war_wins', 'DESC']],
                transaction: t
            });

            // 发放排名奖励
            const distributed = [];
            for (let i = 0; i < rankings.length; i++) {
                const ranking = rankings[i];
                const rank = i + 1;
                ranking.final_rank = rank;

                let fundReward = 0;
                let artifactReward = null;
                if (rank === 1 && rewards.season_rank_1) {
                    fundReward = rewards.season_rank_1.fund || 0;
                    artifactReward = rewards.season_rank_1.artifact || null;
                } else if ((rank === 2 || rank === 3) && rewards.season_rank_2_3) {
                    fundReward = rewards.season_rank_2_3.fund || 0;
                } else if (rank >= 4 && rank <= 10 && rewards.season_rank_4_10) {
                    fundReward = rewards.season_rank_4_10.fund || 0;
                }

                if (fundReward > 0) {
                    const fund = await this._getOrCreateSectFund(ranking.sect_id, ranking.sect_name, t);
                    fund.fund_balance = safeBigInt(fund.fund_balance) + BigInt(fundReward);
                    await fund.save({ transaction: t });
                }

                distributed.push({
                    rank,
                    sect_id: ranking.sect_id,
                    sect_name: ranking.sect_name,
                    total_score: ranking.total_score,
                    fund_reward: fundReward,
                    artifact_reward: artifactReward
                });

                await ranking.save({ transaction: t });
            }

            // 标记赛季结束
            season.status = 'ended';
            season.settlement_time = new Date();
            await season.save({ transaction: t });

            await t.commit();

            // 全服公告赛季结算
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '宗门战赛季结算',
                content: `${season.season_name} 已结算，恭喜冠军宗门：${rankings[0]?.sect_name || '无'}！`,
                priority: 'high'
            });

            return {
                season_id: seasonId,
                season_name: season.season_name,
                settlement_time: season.settlement_time,
                rankings: distributed
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 内部：初始化赛季资源点
     * 赛季开始时按静态配置创建资源点记录，清空归属
     * @param {number} seasonId - 赛季ID
     * @param {Object} [t] - 事务实例，可选
     * @returns {Promise<number>} 创建的资源点数量
     */
    static async initializeTerritories(seasonId, t) {
        const staticData = this.getAllTerritoryStaticData();
        let created = 0;

        for (const s of staticData) {
            // 检查是否已存在（幂等）
            const existing = await SectWarTerritory.findOne({
                where: { territory_key: s.territory_key, season_id: seasonId },
                transaction: t
            });
            if (existing) continue;

            await SectWarTerritory.create({
                territory_key: s.territory_key,
                territory_name: s.territory_name,
                territory_type: s.territory_type,
                map_x: s.map_x,
                map_y: s.map_y,
                owner_sect_id: null,
                owner_sect_name: null,
                owner_since: null,
                defense_level: 1,
                defense_formation: null,
                defender_player_ids: [],
                daily_production: s.base_daily_production || 0,
                production_type: s.production_type,
                is_under_attack: 0,
                last_battle_time: null,
                season_id: seasonId
            }, { transaction: t });
            created++;
        }

        return created;
    }

    /**
     * 内部：获取或创建宗门资金记录
     * 行级锁查询，不存在则创建（首次参与宗门战的宗门）
     * @param {string} sectId - 宗门ID
     * @param {string} sectName - 宗门名
     * @param {Object} [t] - 事务实例，可选
     * @returns {Promise<Object>} SectFund 实例
     */
    static async _getOrCreateSectFund(sectId, sectName, t) {
        // 事务内行级锁查询
        const options = t ? { lock: t.LOCK.UPDATE, transaction: t } : {};
        let fund = await SectFund.findOne({
            where: { sect_id: sectId },
            ...options
        });
        if (!fund) {
            // 新建宗门资金记录（初始资金 0，宗主未知）
            const createOptions = t ? { transaction: t } : {};
            fund = await SectFund.create({
                sect_id: sectId,
                sect_name: sectName || sectId,
                fund_balance: 0,
                war_score: 0,
                season_war_score: 0,
                territories_count: 0,
                leader_player_id: null
            }, createOptions);
            // 尝试从宗门成员中推断宗主（role === 'leader'）
            const leader = await PlayerSect.findOne({
                where: { sect_id: sectId, role: 'leader' }
            });
            if (leader) {
                fund.leader_player_id = Number(leader.player_id);
                await fund.save(createOptions);
            }
        }
        return fund;
    }

    // ============================================================
    // ===== 内部辅助方法 =====
    // ============================================================

    /**
     * 计算下次开战时间（每周三/六 20:00，提前至少 prepareHours 小时）
     * @param {Object} cfg - 宗门战配置
     * @param {number} prepareHours - 提前宣战小时数
     * @returns {Date|null} 下次开战时间，无合适时间返回 null
     */
    static _computeNextWarStartTime(cfg, prepareHours = 24) {
        const warDays = cfg.war_days_of_week || [3, 6]; // 默认周三、周六
        const warHour = cfg.war_start_hour || 20;       // 默认 20:00
        const now = new Date();
        const minDeclareTime = new Date(now.getTime() + prepareHours * 3600 * 1000);

        // 在未来 14 天内查找合适的开战日
        for (let i = 0; i < 14; i++) {
            const candidate = new Date(now);
            candidate.setDate(candidate.getDate() + i);
            candidate.setHours(warHour, 0, 0, 0);
            // 跳过今天已过开战时间点
            if (i === 0 && candidate <= now) continue;
            // 校验星期几是否为开战日（getDay: 0=周日, 3=周三, 6=周六）
            if (warDays.includes(candidate.getDay())) {
                // 必须在 minDeclareTime 之后（即提前至少 prepareHours 宣战）
                if (candidate >= minDeclareTime) {
                    return candidate;
                }
            }
        }
        return null;
    }

    /**
     * 计算单次伤害（参考 PvpService 战斗公式）
     * 单次伤害 = max(1, atk × 技能倍率 - def × 减伤系数) × 暴击系数 × 随机浮动
     * @param {number} atk - 攻击方攻击力
     * @param {number} skillMultiplier - 技能倍率（1.0 普攻 / 1.5 技能）
     * @param {number} def - 防守方防御力
     * @param {number} reduceRate - 减伤系数（默认 0.5）
     * @param {number} critRate - 暴击概率（默认 0.05）
     * @param {number} critMultiplier - 暴击倍率（默认 1.5）
     * @param {number} randomRange - 随机浮动范围（默认 0.15 = ±15%）
     * @returns {{value: bigint, isCrit: boolean}} 伤害值（BigInt）与是否暴击
     */
    static _calculateDamage(atk, skillMultiplier, def, reduceRate = 0.5, critRate = 0.05, critMultiplier = 1.5, randomRange = 0.15) {
        // 基础伤害：max(1, atk × 倍率 - def × 减伤系数)
        const baseDamage = Math.max(1, Math.floor(atk * skillMultiplier - def * reduceRate));
        // 暴击判定
        const isCrit = Math.random() < critRate;
        const critMul = isCrit ? critMultiplier : 1.0;
        // 随机浮动：±15%
        const randomFactor = 1 + (Math.random() * 2 - 1) * randomRange;
        // 最终伤害
        const finalDamage = Math.max(1, Math.floor(baseDamage * critMul * randomFactor));
        return { value: BigInt(finalDamage), isCrit };
    }

    /**
     * 完成 30 秒占领计时（由 setTimeout 触发）
     * @param {number} warId - 战役ID
     * @param {number} territoryId - 资源点ID
     * @param {number} playerId - 占领玩家ID
     * @returns {Promise<Object>} 占领完成结果
     */
    static async _completeCapture(warId, territoryId, playerId) {
        const captureKey = `${warId}_${territoryId}`;
        const capture = this.activeCaptures.get(captureKey);

        const t = await sequelize.transaction();
        try {
            // 校验玩家仍在战役中且未死亡
            const participant = await SectWarParticipant.findOne({
                where: { war_id: warId, player_id: playerId, leave_time: null },
                transaction: t
            });
            if (!participant) {
                await t.commit();
                this.activeCaptures.delete(captureKey);
                return { success: false, reason: '玩家已离开战役' };
            }

            // 校验玩家未在占领期间阵亡
            const player = await Player.findByPk(playerId, { transaction: t });
            if (!player) {
                await t.commit();
                this.activeCaptures.delete(captureKey);
                return { success: false, reason: '玩家数据异常' };
            }
            const attrs = player.attributes || {};
            if (attrs.sect_war_death_time) {
                const deathTime = new Date(attrs.sect_war_death_time).getTime();
                const elapsed = (Date.now() - deathTime) / 1000;
                if (elapsed < 60) {
                    await t.commit();
                    this.activeCaptures.delete(captureKey);
                    return { success: false, reason: '占领期间阵亡，占领失败' };
                }
            }

            // 行级锁查询战役与资源点
            const war = await SectWar.findByPk(warId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!war || war.status !== 'active') {
                await t.commit();
                this.activeCaptures.delete(captureKey);
                return { success: false, reason: '战役已结束' };
            }

            const territory = await SectWarTerritory.findByPk(territoryId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!territory) {
                await t.commit();
                this.activeCaptures.delete(captureKey);
                return { success: false, reason: '资源点不存在' };
            }

            // 占领成功：更新资源点归属
            const oldOwnerId = territory.owner_sect_id;
            territory.owner_sect_id = participant.sect_id;
            territory.owner_sect_name = participant.sect_name;
            territory.owner_since = new Date();
            territory.is_under_attack = 0;
            territory.last_battle_time = new Date();
            await territory.save({ transaction: t });

            // 更新宗门 territories_count
            if (oldOwnerId && oldOwnerId !== participant.sect_id) {
                await SectFund.decrement({ territories_count: 1 }, {
                    where: { sect_id: oldOwnerId },
                    transaction: t
                });
            }
            await SectFund.increment({ territories_count: 1 }, {
                where: { sect_id: participant.sect_id },
                transaction: t
            });

            // 占领贡献分
            participant.contribution_score = (participant.contribution_score || 0) + 50;
            await participant.save({ transaction: t });

            await t.commit();

            // 清理内存计时器
            this.activeCaptures.delete(captureKey);

            // 全服广播资源点易主
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '资源点易主',
                content: `${participant.sect_name} 在 ${war.war_name} 中占领了 ${territory.territory_name}！`,
                priority: 'normal'
            });
            // 推送占领玩家
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'sect_war_capture_success', {
                war_id: warId,
                territory_id: territoryId,
                territory_name: territory.territory_name,
                contribution_gain: 50,
                message: '占领成功！'
            });

            return {
                success: true,
                war_id: warId,
                territory_id: territoryId,
                new_owner_sect_id: participant.sect_id,
                new_owner_sect_name: participant.sect_name
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            // 失败也清理计时器，避免泄漏
            this.activeCaptures.delete(captureKey);
            throw err;
        }
    }

    /**
     * 取消玩家正在进行的占领（被攻击时调用）
     * @param {number} playerId - 玩家ID
     * @returns {boolean} 是否取消了占领
     */
    static _cancelCaptureByPlayer(playerId) {
        for (const [key, capture] of this.activeCaptures.entries()) {
            if (capture.playerId === Number(playerId)) {
                clearTimeout(capture.timeoutId);
                this.activeCaptures.delete(key);
                // 异步清理资源点 is_under_attack 标志
                const [warId, territoryId] = key.split('_').map(Number);
                SectWarTerritory.update({ is_under_attack: 0 }, { where: { id: territoryId } })
                    .catch(() => {});
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'sect_war_capture_interrupted', {
                    war_id: warId,
                    territory_id: territoryId,
                    message: '占领被中断'
                });
                return true;
            }
        }
        return false;
    }

    /**
     * 更新赛季宗门排行（UPSERT 累加）
     * @param {number} seasonId - 赛季ID
     * @param {string} sectId - 宗门ID
     * @param {string} sectName - 宗门名
     * @param {Object} stats - 统计数据 { is_win, is_draw, score, kills, participants, territories_held_delta }
     * @param {Object} t - 事务实例
     */
    static async _updateSeasonRanking(seasonId, sectId, sectName, stats, t) {
        // 查询或创建排行记录
        let ranking = await SectWarSeasonRanking.findOne({
            where: { season_id: seasonId, sect_id: sectId },
            lock: t.LOCK.UPDATE,
            transaction: t
        });
        if (!ranking) {
            ranking = await SectWarSeasonRanking.create({
                season_id: seasonId,
                sect_id: sectId,
                sect_name: sectName,
                total_score: 0,
                war_wins: 0,
                war_losses: 0,
                war_draws: 0,
                territories_held: 0,
                total_kills: 0,
                total_participants: 0,
                final_rank: null
            }, { transaction: t });
        }

        // 累加统计
        ranking.total_score = (ranking.total_score || 0) + (stats.score || 0);
        ranking.total_kills = (ranking.total_kills || 0) + (stats.kills || 0);
        ranking.total_participants = (ranking.total_participants || 0) + (stats.participants || 0);
        if (stats.is_draw) {
            ranking.war_draws = (ranking.war_draws || 0) + 1;
        } else if (stats.is_win) {
            ranking.war_wins = (ranking.war_wins || 0) + 1;
        } else {
            ranking.war_losses = (ranking.war_losses || 0) + 1;
        }
        // territories_held_delta 为正表示净增占领数（实际占用由 territory 表实时反映，此处仅做趋势记录）
        await ranking.save({ transaction: t });
    }

    /**
     * 推送通知给宗门全体成员
     * @param {string} sectId - 宗门ID
     * @param {Object} notification - 通知内容 { type, title, content, priority }
     */
    static async _notifySectMembers(sectId, notification) {
        // 查询宗门所有成员
        const members = await PlayerSect.findAll({
            where: { sect_id: sectId },
            attributes: ['player_id']
        });
        // 逐个推送（在线成员才会收到，离线成员由通知系统持久化）
        for (const m of members) {
            WebSocketNotificationService.sendToPlayer(m.player_id, notification);
        }
    }

    /**
     * 格式化战役对象（前端友好）
     * @param {Object} war - SectWar 实例
     * @returns {Object} 格式化后的战役对象
     */
    static _formatWar(war) {
        return {
            id: war.id,
            war_name: war.war_name,
            season_id: war.season_id,
            attacker_sect_id: war.attacker_sect_id,
            attacker_sect_name: war.attacker_sect_name,
            defender_sect_id: war.defender_sect_id,
            defender_sect_name: war.defender_sect_name,
            target_territory_id: war.target_territory_id,
            status: war.status,
            announce_time: war.announce_time,
            prepare_end_time: war.prepare_end_time,
            active_start_time: war.active_start_time,
            active_end_time: war.active_end_time,
            settle_time: war.settle_time,
            winner_sect_id: war.winner_sect_id,
            loser_sect_id: war.loser_sect_id,
            attacker_score: war.attacker_score,
            defender_score: war.defender_score,
            attacker_kills: war.attacker_kills,
            defender_kills: war.defender_kills,
            attacker_participants: war.attacker_participants,
            defender_participants: war.defender_participants,
            war_chest: safeBigInt(war.war_chest).toString(),
            created_at: war.created_at
        };
    }

    /**
     * 格式化资源点对象（前端友好）
     * @param {Object} t - SectWarTerritory 实例
     * @returns {Object} 格式化后的资源点对象
     */
    static _formatTerritory(t) {
        return {
            id: t.id,
            territory_key: t.territory_key,
            territory_name: t.territory_name,
            territory_type: t.territory_type,
            map_x: t.map_x,
            map_y: t.map_y,
            owner_sect_id: t.owner_sect_id,
            owner_sect_name: t.owner_sect_name,
            owner_since: t.owner_since,
            defense_level: t.defense_level,
            defense_formation: t.defense_formation,
            defender_player_ids: t.defender_player_ids || [],
            daily_production: t.daily_production,
            production_type: t.production_type,
            is_under_attack: t.is_under_attack,
            last_battle_time: t.last_battle_time,
            season_id: t.season_id
        };
    }

    /**
     * 格式化参战记录对象（前端友好）
     * @param {Object} p - SectWarParticipant 实例
     * @returns {Object} 格式化后的参战记录对象
     */
    static _formatParticipant(p) {
        return {
            id: p.id,
            war_id: p.war_id,
            player_id: p.player_id,
            player_nickname: p.player_nickname,
            sect_id: p.sect_id,
            sect_name: p.sect_name,
            side: p.side,
            kill_count: p.kill_count,
            death_count: p.death_count,
            damage_dealt: safeBigInt(p.damage_dealt).toString(),
            damage_taken: safeBigInt(p.damage_taken).toString(),
            contribution_score: p.contribution_score,
            honor_rewarded: p.honor_rewarded,
            spirit_stone_rewarded: safeBigInt(p.spirit_stone_rewarded).toString(),
            is_online: p.is_online,
            join_time: p.join_time,
            leave_time: p.leave_time,
            war: p.war ? this._formatWar(p.war) : undefined
        };
    }

    /**
     * 清理服务重启后残留的资源点占领标志
     * 由服务启动时调用，清理 is_under_attack = 1 但内存中无计时器的脏数据
     * @returns {Promise<number>} 清理的记录数
     */
    static async clearStaleCaptureFlags() {
        const [updated] = await SectWarTerritory.update(
            { is_under_attack: 0 },
            { where: { is_under_attack: 1 } }
        );
        if (updated > 0) {
            console.log(`[SectWar] 清理 ${updated} 个残留的资源点占领标志`);
        }
        this.activeCaptures.clear();
        return updated;
    }
}

module.exports = SectWarService;
