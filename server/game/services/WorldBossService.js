/**
 * 世界BOSS核心服务
 *
 * 提供世界BOSS系统的全部核心业务逻辑（参考 docs/批次2_多人玩法设计方案.md 第二章）：
 *   1. 配置读取：getWorldBossConfig / getBossStaticData（world_boss_data.json + game_balance.world_boss）
 *   2. 列表与详情：getAvailableBosses / getBossDetail（含 HP/阶段/技能/排行前10）
 *   3. 核心战斗：attackBoss（事务+行级锁，含伤害计算/阶段切换/反击/击杀结算）
 *   4. 复活与撤退：revive（消耗灵石，CD 60秒）/ retreat（5分钟内禁入）
 *   5. 排行榜：getDamageRanking（个人/宗门）/ getSeasonRanking（赛季）
 *   6. 内部结算：_checkPhaseTransition / _settleBossDefeat / _grantDamageTierRewards
 *   7. BOSS生命周期：spawnBoss / expireBoss
 *   8. 赛季管理：createSeason / settleSeason
 *
 * 设计原则（遵循项目工程规范）：
 *   - 配置中心化：所有可变参数从 game_balance.world_boss 读取，BOSS静态数据从 world_boss_data.json 读取
 *   - 事务+行级锁：attackBoss 涉及 world_bosses/world_boss_damage_records/players 多表，必用事务+ LOCK.UPDATE
 *   - 状态机集成：攻击前调用 PlayerStateMachine.canStart(IN_WORLD_BOSS) 检查互斥
 *   - WebSocket 推送：通过 notifyPlayerUpdate 推玩家数据，sendGlobalAnnouncement 全服广播
 *   - BigInt 安全：HP/伤害全部走 safeBigInt，避免 null/undefined 转 BigInt 抛错
 *   - 错误处理：统一用 AppError + ErrorCodes，禁止裸 throw Error
 *   - 中文注释：文件头/类/方法/关键逻辑全部中文注释
 *
 * 状态机集成说明：
 *   IN_WORLD_BOSS 状态由 worldBoss.js 状态注册文件派生（玩家有最近30分钟伤害记录且 BOSS 仍 active）
 *   本服务不直接 enter/exit 状态，而是在 attackBoss 前调用 canStart 做互斥校验
 */
'use strict';

const WorldBoss = require('../../models/worldBoss');
const WorldBossDamageRecord = require('../../models/worldBossDamageRecord');
const WorldBossSeasonRanking = require('../../models/worldBossSeasonRanking');
const WorldBossSeason = require('../../models/worldBossSeason');
const Player = require('../../models/player');
const PlayerSect = require('../../models/playerSect');
const AttributeService = require('../core/AttributeService');
const RealmService = require('../core/RealmService');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const WorldBossSkillManager = require('./WorldBossSkillManager');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { infrastructure } = require('../../modules');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const sequelize = require('../../config/database');
const { Op } = require('sequelize');

const configLoader = infrastructure.ConfigLoader;

/**
 * BigInt 安全转换工具
 * 防御场景：数据库 BIGINT 字段可能返回 string/null/undefined/number/bigint
 * 直接 BigInt(null) 会抛 TypeError: Cannot convert null to a BigInt，导致接口 500
 * @param {string|number|bigint|null|undefined} value - 待转换的值
 * @returns {bigint} 转换后的 BigInt，null/undefined/空串返回 0n
 */
function safeBigInt(value) {
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'bigint') return value;
    // 统一转字符串再转 BigInt，避免 number 精度丢失
    return BigInt(String(value));
}

/**
 * 将 BigInt 转为字符串用于 JSON 序列化（前端无法直接解析 BigInt）
 * @param {bigint} value - 待转换的 BigInt
 * @returns {string} 字符串表示
 */
function bigIntToString(value) {
    const v = safeBigInt(value);
    return v.toString();
}

class WorldBossService {
    /**
     * 战斗运行时状态缓存（不持久化，服务重启后清空）
     * 设计权衡：
     *   - BOSS战中玩家"虚拟HP/死亡/复活CD/撤退CD"是临时状态，重启后允许重置
     *   - 持久化方案可后续迁移至 world_boss_damage_records 表的扩展字段（battle_state JSON）
     * key: `${bossId}:${playerId}`
     * value: {
     *   battleHp: bigint,         // 玩家在本场BOSS战中的当前HP（独立于 players.hp_current）
     *   battleHpMax: bigint,      // 本场BOSS战 HP 上限（攻击时锁定，避免换装影响）
     *   isDead: boolean,          // 是否当前处于"BOSS战死亡"状态（需复活才能继续攻击）
     *   lastReviveTime: number,   // 上次原地复活时间戳（ms），用于复活CD校验
     *   lastRetreatTime: number,  // 上次撤退时间戳（ms），用于撤退禁入CD校验
     *   attackCount: number,      // 本场攻击次数（用于触发"死亡5次强制退出"反刷机制）
     *   deathCount: number        // 本场死亡次数（用于反刷判定）
     * }
     */
    static _battleRuntime = new Map();

    // =========================================================================
    // 配置读取层
    // =========================================================================

    /**
     * 读取世界BOSS平衡配置（game_balance.json 的 world_boss 块）
     * 包含攻击CD/复活CD/暴击率/奖励档位等所有可变参数
     * @returns {Object} world_boss 配置对象（缺失时返回空对象，调用方做兜底）
     */
    static getWorldBossConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.world_boss || {};
    }

    /**
     * 读取BOSS静态数据（world_boss_data.json）
     * 包含 base_hp/base_atk/阶段技能/drops/spawn_schedule 等
     * @param {string} bossKey - BOSS配置键（如 qingyuanzi/yaoshou/mulan）
     * @returns {Object|null} BOSS静态配置，未找到返回 null
     */
    static getBossStaticData(bossKey) {
        const data = configLoader.getConfig('world_boss_data');
        if (!data?.bosses) return null;
        return data.bosses.find(b => b.boss_key === bossKey) || null;
    }

    /**
     * 获取所有BOSS静态数据列表（供调度器/GM查询）
     * @returns {Array} BOSS静态配置数组
     */
    static getAllBossStaticData() {
        const data = configLoader.getConfig('world_boss_data');
        return data?.bosses || [];
    }

    // =========================================================================
    // 列表与详情查询层
    // =========================================================================

    /**
     * 获取当前可挑战BOSS列表（含即将刷新的 pending 状态BOSS）
     * 排序规则：active 优先（按刷新时间倒序），其次 pending（按刷新时间正序）
     * @returns {Promise<Object>} BOSS列表与赛季信息
     */
    static async getAvailableBosses() {
        const now = new Date();
        // 查询所有未过期且未击败的BOSS（含 pending/active）
        // 已击败/已过期的BOSS不在此接口返回（历史走专门接口）
        const bosses = await WorldBoss.findAll({
            where: {
                status: { [Op.in]: ['pending', 'active'] },
                expire_time: { [Op.gt]: now }
            },
            order: [
                // active 优先：通过 CASE 表达式实现（Sequelize 用 literal）
                [sequelize.literal("CASE WHEN status='active' THEN 0 ELSE 1 END"), 'ASC'],
                ['spawn_time', 'ASC']
            ]
        });

        // 查询当前赛季
        const currentSeason = await WorldBossSeason.findOne({
            where: {
                status: 'active',
                start_date: { [Op.lte]: now },
                end_date: { [Op.gte]: now }
            }
        });

        // 拼装返回数据：BIGINT 字段转字符串，避免前端 JSON 解析失败
        const list = bosses.map(b => ({
            id: b.id,
            boss_key: b.boss_key,
            boss_name: b.boss_name,
            realm_rank_min: b.realm_rank_min,
            phase: b.phase,
            status: b.status,
            spawn_time: b.spawn_time,
            active_start_time: b.active_start_time,
            expire_time: b.expire_time,
            season_id: b.season_id,
            participant_count: b.participant_count,
            // HP 百分比（用于前端进度条），active 状态才有意义
            hp_percentage: b.status === 'active'
                ? Number((safeBigInt(b.hp_current) * 100n) / (safeBigInt(b.hp_max) || 1n))
                : 100,
            hp_current: bigIntToString(b.hp_current),
            hp_max: bigIntToString(b.hp_max),
            killer_player_id: b.killer_player_id,
            killer_nickname: b.killer_nickname,
            // 距离刷新/过期的剩余秒数（前端倒计时用）
            countdown_seconds: b.status === 'pending'
                ? Math.max(0, Math.floor((new Date(b.spawn_time) - now) / 1000))
                : Math.max(0, Math.floor((new Date(b.expire_time) - now) / 1000))
        }));

        return {
            bosses: list,
            current_season: currentSeason ? {
                id: currentSeason.id,
                season_name: currentSeason.season_name,
                start_date: currentSeason.start_date,
                end_date: currentSeason.end_date,
                total_bosses_killed: currentSeason.total_bosses_killed
            } : null,
            server_time: now.toISOString()
        };
    }

    /**
     * 获取BOSS详情（HP/阶段/技能/排行前10）
     * @param {number} bossId - BOSS实例ID
     * @returns {Promise<Object>} BOSS详情
     */
    static async getBossDetail(bossId) {
        // 查询BOSS实例
        const boss = await WorldBoss.findByPk(bossId);
        if (!boss) {
            throw new AppError('世界BOSS不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询BOSS静态配置（技能/drops/description）
        const staticData = this.getBossStaticData(boss.boss_key);

        // 查询伤害排行前10（个人）
        const topDamageRecords = await WorldBossDamageRecord.findAll({
            where: {
                boss_id: bossId,
                is_participant: 1,
                total_damage: { [Op.gt]: 0 }
            },
            order: [['total_damage', 'DESC']],
            limit: 10
        });

        // 查询宗门伤害排行前10（按宗门聚合）
        const sectRanking = await WorldBossDamageRecord.findAll({
            where: {
                boss_id: bossId,
                is_participant: 1,
                total_damage: { [Op.gt]: 0 },
                sect_id: { [Op.ne]: null }
            },
            attributes: [
                'sect_id',
                'sect_name',
                [sequelize.fn('SUM', sequelize.col('total_damage')), 'sect_total_damage'],
                [sequelize.fn('COUNT', sequelize.col('player_id')), 'member_count']
            ],
            group: ['sect_id', 'sect_name'],
            order: [[sequelize.literal('sect_total_damage'), 'DESC']],
            limit: 10,
            raw: true
        });

        // 计算总伤害（用于伤害占比）
        const totalDamageTaken = safeBigInt(boss.total_damage_taken);

        // 拼装返回数据
        return {
            boss: {
                id: boss.id,
                boss_key: boss.boss_key,
                boss_name: boss.boss_name,
                realm_rank_min: boss.realm_rank_min,
                phase: boss.phase,
                status: boss.status,
                atk: boss.atk,
                def: boss.def,
                speed: boss.speed,
                spawn_time: boss.spawn_time,
                active_start_time: boss.active_start_time,
                defeat_time: boss.defeat_time,
                expire_time: boss.expire_time,
                season_id: boss.season_id,
                participant_count: boss.participant_count,
                killer_player_id: boss.killer_player_id,
                killer_nickname: boss.killer_nickname,
                first_kill_server: boss.first_kill_server,
                hp_current: bigIntToString(boss.hp_current),
                hp_max: bigIntToString(boss.hp_max),
                hp_percentage: Number((safeBigInt(boss.hp_current) * 100n) / (safeBigInt(boss.hp_max) || 1n)),
                total_damage_dealt: bigIntToString(boss.total_damage_dealt),
                total_damage_taken: bigIntToString(boss.total_damage_taken)
            },
            // 当前阶段技能列表（从静态配置筛选）
            current_phase_skills: staticData?.skills?.find(s => s.phase === boss.phase)?.skills || [],
            // BOSS描述
            description: staticData?.description || '',
            // 个人伤害排行前10
            personal_ranking: topDamageRecords.map((r, idx) => ({
                rank: idx + 1,
                player_id: r.player_id,
                player_nickname: r.player_nickname,
                player_realm: r.player_realm,
                sect_name: r.sect_name,
                total_damage: bigIntToString(r.total_damage),
                damage_count: r.damage_count,
                best_single_damage: bigIntToString(r.best_single_damage),
                damage_percentage: totalDamageTaken > 0n
                    ? Number((safeBigInt(r.total_damage) * 10000n) / totalDamageTaken) / 100
                    : 0
            })),
            // 宗门伤害排行前10
            sect_ranking: sectRanking.map((s, idx) => ({
                rank: idx + 1,
                sect_id: s.sect_id,
                sect_name: s.sect_name,
                sect_total_damage: bigIntToString(s.sect_total_damage),
                member_count: Number(s.member_count),
                damage_percentage: totalDamageTaken > 0n
                    ? Number((safeBigInt(s.sect_total_damage) * 10000n) / totalDamageTaken) / 100
                    : 0
            })),
            server_time: new Date().toISOString()
        };
    }

    // =========================================================================
    // 核心战斗层
    // =========================================================================

    /**
     * 执行世界BOSS 行动（多行动机制核心战斗逻辑）
     *
     * 4 种行动类型：
     *   - assault       : 强攻（主伤害，但提升魔压、削弱阵势）
     *   - break_banner  : 破幡（削弱幡魂减伤，自身伤害降低）
     *   - suppress_soul : 镇魂（降低魔压，避免压力失控）
     *   - protect_array : 护阵（恢复阵势，避免阵势崩溃）
     *
     * 流程：
     *   1. actionType 参数校验（必须为 4 种之一）
     *   2. 状态机互斥校验（IN_WORLD_BOSS 与其他 exclusive 状态互斥）
     *   3. 开启事务，行级锁 BOSS + 玩家
     *   4. BOSS 状态校验（pending→active 自动激活；defeated/expired 拒绝）
     *   5. 攻击CD校验（默认5秒，从 damage_record.last_attack_time 推导）
     *   6. 读取行动配置（actions[actionType]）+ 重复行动惩罚判定
     *   7. 计算伤害 = attackBoss 原伤害公式 * 行动倍率 * 幡魂减伤 * 魔压玩家惩罚 * 重复惩罚
     *   8. BOSS HP 扣减，更新 banner_soul/magic_pressure/array_integrity 三大状态
     *   9. BOSS 反击：沿用技能系统，BOSS 攻击力乘以魔压/阵势加成
     *  10. UPSERT 伤害记录，更新 last_action/action_streak
     *  11. 检查 BOSS 是否被击杀（hp_current <= 0），若是触发结算
     *  12. 推送 WebSocket 通知（玩家数据 + 全服 HP 广播）
     *
     * @param {number} playerId - 行动玩家ID
     * @param {number} bossId - BOSS实例ID
     * @param {string} actionType - 行动类型（assault/break_banner/suppress_soul/protect_array）
     * @param {string} [skillId='basic'] - 技能ID（basic/skill/ultimate，对应不同倍率）
     * @returns {Promise<Object>} 行动结果（伤害/状态变化/反击/是否击杀/是否死亡）
     */
    static async performAction(playerId, bossId, actionType, skillId = 'basic') {
        const cfg = this.getWorldBossConfig();

        // 全局开关
        if (cfg.enabled === false) {
            throw new AppError('世界BOSS系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验
        if (!playerId || !bossId) {
            throw new AppError('玩家ID与BOSS ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 行动类型校验：必须是 4 种合法行动之一
        // 行动配置来源于 game_balance.json → world_boss.action_system.actions
        const VALID_ACTIONS = ['assault', 'break_banner', 'suppress_soul', 'protect_array'];
        if (!VALID_ACTIONS.includes(actionType)) {
            throw new AppError(
                `actionType 必须是 ${VALID_ACTIONS.join('/')} 之一`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }

        // 读取多行动机制配置（action_system.enabled=false 时仅允许 assault 走老逻辑）
        const actionCfg = cfg.action_system || {};
        const actionsMap = actionCfg.actions || {};
        const actionConfig = actionsMap[actionType] || {
            // 兜底默认值（action_system 未配置时也保证 assault 可走通）
            name: actionType === 'assault' ? '强攻' : actionType,
            damage_multiplier: actionType === 'assault' ? 1.0 : 0.3,
            banner_soul_damage: 0,
            magic_pressure_increase: 0,
            magic_pressure_decrease: 0,
            array_integrity_change: 0,
            description: '默认行动（action_system 配置缺失）'
        };

        // 非强攻行动在 action_system 未启用时拒绝（避免行动系统未上线时被误用）
        if (actionType !== 'assault' && actionCfg.enabled === false) {
            throw new AppError(
                '世界BOSS 多行动机制未开启，暂时无法执行该行动',
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 状态机互斥校验：IN_WORLD_BOSS 与一切 exclusive 状态互斥
        // 注意：玩家首次攻击时无 damage_record，状态为 IDLE，canStart 通过
        //       后续攻击时 getActiveState 返回 IN_WORLD_BOSS，canStart 内部 canTransitionTo 判定
        //       由于玩家要"继续攻击"（仍是 IN_WORLD_BOSS），不应被自身状态拦截
        //       此处仅校验"其他互斥状态"（如 PVP/闭关/移动等），由 canStart 遍历所有激活状态判定
        const activeStates = await PlayerStateMachine.getActiveStates(playerId);
        const hasOtherExclusive = activeStates.some(s =>
            s.stateEnum !== PlayerStateMachine.PlayerState.IN_WORLD_BOSS &&
            s.stateEnum !== PlayerStateMachine.PlayerState.IDLE
        );
        if (hasOtherExclusive) {
            const conflict = activeStates.find(s =>
                s.stateEnum !== PlayerStateMachine.PlayerState.IN_WORLD_BOSS
            );
            throw new AppError(
                `${conflict?.displayName || '当前状态'}中，无法讨伐世界BOSS`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 战斗运行时状态校验：玩家是否处于"BOSS战死亡"状态（需先复活）
        const runtimeKey = `${bossId}:${playerId}`;
        const runtime = this._battleRuntime.get(runtimeKey);
        if (runtime?.isDead) {
            throw new AppError('已在BOSS战中陨落，请原地复活或撤退', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 撤退CD校验：5分钟内不能再进入（CD时长沿用 attack_cooldown 5倍，简化设计）
        const retreatCooldownMs = (cfg.attack_cooldown_seconds || 5) * 60 * 1000; // 5 分钟
        if (runtime?.lastRetreatTime && Date.now() - runtime.lastRetreatTime < retreatCooldownMs) {
            const remain = Math.ceil((retreatCooldownMs - (Date.now() - runtime.lastRetreatTime)) / 1000);
            throw new AppError(`撤退冷却中，${remain} 秒后才能再次挑战`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 反刷机制：死亡5次强制退出战斗（防小号反复送死刷参与奖）
        const maxDeathCount = 5;
        if (runtime?.deathCount >= maxDeathCount) {
            throw new AppError('死亡次数过多，已被强制请离战场，请稍后再来', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // ========== 开启事务，行级锁 BOSS + 玩家 ==========
        const t = await sequelize.transaction();
        try {
            // 行级锁 BOSS（防止并发攻击导致 HP 计算错乱）
            const boss = await WorldBoss.findByPk(bossId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!boss) {
                await t.commit();
                throw new AppError('世界BOSS不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // BOSS 状态校验
            if (boss.status === 'defeated') {
                await t.commit();
                throw new AppError('BOSS已被击杀', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (boss.status === 'expired') {
                await t.commit();
                throw new AppError('BOSS已消失', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            // 过期时间校验（双保险，防止调度器未及时清理）
            if (new Date(boss.expire_time) < new Date()) {
                await t.commit();
                throw new AppError('BOSS已过期', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁玩家
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
                throw new AppError('已身死道消，无法讨伐BOSS', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 境界要求校验：玩家境界rank 必须 >= boss.realm_rank_min
            const realmCheck = RealmService.meetsRealmRequirement(player, this._getMinRealmNameByRank(boss.realm_rank_min));
            if (!realmCheck.met) {
                await t.commit();
                throw new AppError(
                    `境界不足，需达到推荐境界方可挑战（${realmCheck.reason}）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // BOSS 首次被攻击：pending → active 自动激活
            const isFirstAttack = boss.status === 'pending';
            if (isFirstAttack) {
                boss.status = 'active';
                boss.active_start_time = new Date();
            }

            // 攻击CD校验：基于 damage_record.last_attack_time
            const attackCooldownSec = cfg.attack_cooldown_seconds || 5;
            let damageRecord = await WorldBossDamageRecord.findOne({
                where: { boss_id: bossId, player_id: playerId },
                transaction: t
            });
            if (damageRecord?.last_attack_time) {
                const elapsedSec = (Date.now() - new Date(damageRecord.last_attack_time).getTime()) / 1000;
                if (elapsedSec < attackCooldownSec) {
                    await t.commit();
                    const remain = Math.ceil(attackCooldownSec - elapsedSec);
                    throw new AppError(`攻击冷却中，${remain} 秒后可再次攻击`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
            }

            // ========== 多行动机制：重复行动惩罚判定（2026-07-21 新增） ==========
            // 设计目的：避免玩家无脑刷同一个高收益行动（如反复强攻），鼓励行动轮换
            // 判定逻辑：基于 damageRecord.last_action 与 action_streak
            //   - 当前 actionType 与上次 last_action 相同：streak = action_streak + 1
            //   - 不同：streak = 1（reset_on_different_action=true 时重置）
            // 当 streak >= streak_threshold（默认3）时，本次伤害乘以 penalty_multiplier（默认0.5）
            // 配置：game_balance.json → world_boss.action_system.repetition_penalty
            const repetitionPenaltyCfg = actionCfg.repetition_penalty || {};
            const isRepetitionEnabled = repetitionPenaltyCfg.enabled !== false;
            const streakThreshold = repetitionPenaltyCfg.streak_threshold || 3;
            const penaltyMultiplier = repetitionPenaltyCfg.penalty_multiplier || 0.5;
            // 计算新的连续行动次数（事务内读取，避免并发误判）
            const previousAction = damageRecord?.last_action || null;
            const previousStreak = damageRecord?.action_streak || 0;
            const newActionStreak = (previousAction === actionType)
                ? previousStreak + 1
                : 1;
            // 重复惩罚触发条件：启用 + 达到阈值
            const repetitionPenaltyTriggered = isRepetitionEnabled && newActionStreak >= streakThreshold;
            // 实际惩罚系数：触发时为 penalty_multiplier，否则为 1.0
            const repetitionPenaltyFactor = repetitionPenaltyTriggered ? penaltyMultiplier : 1.0;

            // ========== 多行动机制：三大状态值初始化与读取 ==========
            // banner_soul     : 幡魂值，高时 BOSS 减伤（每点减伤 0.5%，最高 50%）
            // magic_pressure  : 魔压值，高时 BOSS 攻击加强 + 玩家伤害下降
            // array_integrity : 阵势值，低时 BOSS 全属性加强
            // 三大状态字段在迁移 0053 中已添加到 world_bosses 表
            // 老数据可能为 null/undefined（迁移默认值已设置），这里做兜底
            const bannerSoulCfg = actionCfg.banner_soul || {};
            const magicPressureCfg = actionCfg.magic_pressure || {};
            const arrayIntegrityCfg = actionCfg.array_integrity || {};

            const currentBannerSoul = Number(boss.banner_soul) ?? bannerSoulCfg.initial ?? 100;
            const currentMagicPressure = Number(boss.magic_pressure) ?? magicPressureCfg.initial ?? 0;
            const currentArrayIntegrity = Number(boss.array_integrity) ?? arrayIntegrityCfg.initial ?? 100;

            // 计算幡魂减伤系数（0~0.5）：banner_soul * 0.005，最高 0.5
            // 玩家最终伤害乘以 (1 - bannerSoulDamageReduction)
            const bannerSoulDamageReduction = Math.min(
                currentBannerSoul * (bannerSoulCfg.damage_reduction_per_point || 0.005),
                bannerSoulCfg.max_damage_reduction || 0.5
            );

            // 计算魔压玩家伤害惩罚系数（0~0.2）：magic_pressure * 0.002，最高 0.2
            // 玩家最终伤害乘以 (1 - magicPressurePlayerPenalty)
            const magicPressurePlayerPenalty = Math.min(
                currentMagicPressure * (magicPressureCfg.player_damage_penalty_per_point || 0.002),
                magicPressureCfg.max_player_damage_penalty || 0.2
            );

            // 计算魔压 BOSS 攻击加成系数（0~0.3）：magic_pressure * 0.003，最高 0.3
            // BOSS 反击伤害乘以 (1 + magicPressureBossBonus)
            const magicPressureBossBonus = Math.min(
                currentMagicPressure * (magicPressureCfg.boss_atk_bonus_per_point || 0.003),
                magicPressureCfg.max_boss_atk_bonus || 0.3
            );

            // 计算阵势低 BOSS 加成系数：array_integrity < 30 时 +0.2，< 10 时再 +0.5
            // 注意：临界阈值 30 时 +0.2，到 10 时再叠加 +0.5，故最低阵势可达 +0.7
            let arrayIntegrityBossBonus = 0;
            const lowThreshold = arrayIntegrityCfg.low_threshold || 30;
            const lowBossBonus = arrayIntegrityCfg.low_boss_bonus || 0.2;
            const criticalThreshold = arrayIntegrityCfg.critical_threshold || 10;
            const criticalBossBonus = arrayIntegrityCfg.critical_boss_bonus || 0.5;
            if (currentArrayIntegrity < criticalThreshold) {
                arrayIntegrityBossBonus = lowBossBonus + criticalBossBonus;
            } else if (currentArrayIntegrity < lowThreshold) {
                arrayIntegrityBossBonus = lowBossBonus;
            }

            // ========== 计算单次伤害 ==========
            // 玩家属性通过 AttributeService.calculateFullAttributesAsync 获取最终属性
            // 异步版本包含装备加成 + 灵兽加成（出战灵兽按比例加成 atk/def/hp_max/speed）
            // 灵兽加成参与 BOSS 战的意义：
            //   1. 灵兽 ATK 加成提升玩家攻击力 → 直接提升伤害
            //   2. 灵兽 HP 加成提升 battleHpMax → 提升生存能力
            //   3. 灵兽元素参与五行相克判定（见下方 elementalCounter）
            //   4. 灵兽独立追加伤害（assist_damage_ratio）
            const attrResult = await AttributeService.calculateFullAttributesAsync(player);
            const finalAttrs = attrResult?.final || {};
            const playerAtk = Number(finalAttrs.atk) || 0;
            const playerDef = Number(finalAttrs.def) || 0;
            const playerHpMax = Number(finalAttrs.hp_max) || 100;

            // 读取灵兽助战信息（来自 AttributeService 异步填充）
            // spiritBeastInfo 含 beast_name/element/star_level/level/bonus_rate/combat_power
            const spiritBeastInfo = attrResult?.info?.spirit_beast || null;
            const spiritBeastBreakdown = attrResult?.breakdown?.spirit_beast || {};

            // 技能倍率（skillId 映射，默认 basic）
            // basic=1.0, skill=1.5, ultimate=2.5（受 BOSS 当前阶段技能表约束）
            const skillMultipliers = { basic: 1.0, skill: 1.5, ultimate: 2.5 };
            const skillMultiplier = skillMultipliers[skillId] || 1.0;

            // 阶段倍率（从配置读取，1.0/1.3/1.8）
            const phaseMultipliers = cfg.phase_multipliers || [1.0, 1.3, 1.8];
            const phaseMultiplier = phaseMultipliers[Math.min(boss.phase - 1, phaseMultipliers.length - 1)] || 1.0;

            // 暴击判定（5% 暴击率，1.5 倍暴击伤害）
            const critRate = cfg.crit_rate || 0.05;
            const critMultiplier = cfg.crit_multiplier || 1.5;
            const isCrit = Math.random() < critRate;
            const critFactor = isCrit ? critMultiplier : 1.0;

            // 随机浮动（±15%）
            const randomRange = cfg.damage_random_range || 0.15;
            const randomFactor = 1 + (Math.random() * 2 - 1) * randomRange;

            // ========== 五行相克系统 ==========
            // 取 BOSS 静态元素（boss_key → world_boss_data.json bosses[].element）
            // 取玩家灵兽元素（无出战灵兽时为 null，按中性 1.0x 处理）
            // 相克方向：玩家灵兽元素 → BOSS元素
            //   - 灵兽克 BOSS：1.5x（如火灵兽 vs 木BOSS）
            //   - 灵兽被 BOSS 克：0.75x（如木灵兽 vs 金BOSS）
            //   - 同元素/无灵兽：1.0x
            const bossStaticData = this.getBossStaticData(boss.boss_key) || {};
            const bossElement = bossStaticData.element || null;
            const playerBeastElement = spiritBeastInfo?.element || null;
            const elementalCounter = this._calculateElementalCounter(playerBeastElement, bossElement, cfg);
            const playerElementalFactor = elementalCounter.factor; // 玩家攻击 BOSS 的相克系数
            const elementalTag = elementalCounter.tag; // 'advantage' / 'disadvantage' / 'neutral'

            // ========== 伤害计算（2026-07-21 修复） ==========
            // 原公式：max(1, atk * skill - boss.def * 0.5) * soloRatio(0.3)
            //   问题：当玩家ATK与BOSS DEF接近时（如625 vs 800），baseDamage 仅剩 225，
            //         再乘 soloRatio=0.3 后 finalDamage≈67，化神初期玩家需攻击 74627 次才能击杀，
            //         完全不可玩。此外 soloRatio=0.3 让单人挑战完全不可行，违背"多人鼓励但不强制"的设计。
            //
            // 新公式：max(1, atk * skill * (1 - def_reduction)) * soloRatio * teamFactor * crit * random * elemental
            //   def_reduction = boss.def / (boss.def + playerAtk * 2 + 1000)
            //   设计理由：
            //     1. 使用除法减伤曲线，避免 ATK 与 DEF 接近时伤害断崖式下跌
            //     2. 当 atk=625, def=800 时：def_reduction = 800/(800+1250+1000) = 0.262
            //        baseDamage = 625 * 1.0 * 0.738 = 461（原公式为 225）
            //     3. 当 atk=2000, def=800 时：def_reduction = 800/(800+4000+1000) = 0.138
            //        baseDamage = 2000 * 1.0 * 0.862 = 1724（高境界玩家有合理压制力）
            //     4. 当 atk=100, def=800 时：def_reduction = 800/(800+200+1000) = 0.4
            //        baseDamage = 100 * 1.0 * 0.6 = 60（低境界玩家仍能蹭伤害拿参与奖）
            //
            // soloRatio 调整：0.3 → 1.0
            //   原设计 soloRatio=0.3 是为强制多人组队，但实际效果是单人完全无法挑战，
            //   组队加成应通过 team_bonus_ratio 体现，而非削弱单人。
            //   修复后：soloRatio=1.0（单人完整伤害），组队人数>=min_team_size 时额外 +team_bonus_ratio
            const defReduction = boss.def / (boss.def + playerAtk * 2 + 1000);
            const baseDamage = Math.max(1, Math.floor(playerAtk * skillMultiplier * (1 - defReduction)));

            // 单人挑战伤害比例（鼓励但不强制组队）
            const soloRatio = cfg.single_player_damage_ratio ?? 1.0;

            // ========== 组队加成（2026-07-21 新增实现） ==========
            // 配置项 team_bonus_ratio / min_team_size 之前仅写在 JSON 中，代码未实现
            // 现在通过查询 BOSS 战中最近 active_window_ms 内的活跃参与者数量判定是否触发加成
            // 设计目的：鼓励玩家在同一时段集中攻击 Boss（多人合作），但不强制组队系统
            const minTeamSize = cfg.min_team_size || 3;
            const teamBonusRatio = cfg.team_bonus_ratio || 1.1;
            const activeWindowMs = cfg.active_window_ms || 300000; // 默认 5 分钟
            const activeParticipantCount = await WorldBossDamageRecord.count({
                where: {
                    boss_id: bossId,
                    last_attack_time: { [Op.gte]: new Date(Date.now() - activeWindowMs) }
                },
                transaction: t
            });
            // 当前玩家也计入活跃人数，故 +1
            const totalActiveCount = activeParticipantCount + 1;
            const teamFactor = totalActiveCount >= minTeamSize ? teamBonusRatio : 1.0;

            // ========== 境界压制加成（2026-07-21 新增） ==========
            // 设计目的：高境界玩家挑战低境界 Boss 时应有压制力，避免高境界玩家被低境界 Boss 卡住
            // 公式：1 + max(0, (playerRealmRank - bossRealmRankMin) * realm_suppression_per_rank)
            //   - 玩家境界 == Boss 推荐境界：1.0（无加成）
            //   - 玩家境界高 10 级：1.5（每级 5% 加成）
            //   - 玩家境界低：不加成（boss.realm_rank_min 是最低要求，不应有惩罚）
            const playerRealmRank = player.realm_rank || 1;
            const bossRealmRankMin = boss.realm_rank_min || 1;
            const realmSuppressionPerRank = cfg.realm_suppression_per_rank || 0.05;
            const realmSuppression = 1 + Math.max(0, (playerRealmRank - bossRealmRankMin) * realmSuppressionPerRank);

            // ========== 最终伤害组装 ==========
            // 原公式：finalDamage = baseDamage * soloRatio * teamFactor * realmSuppression * crit * random * elemental
            // 多行动机制扩展（2026-07-21）：
            //   再乘以行动系统系数：
            //     * actionMultiplier            （行动倍率，assault=1.0, break_banner=0.4, suppress_soul=0.3, protect_array=0.3）
            //     * (1 - bannerSoulDamageReduction)  （幡魂减伤，最高 50%）
            //     * (1 - magicPressurePlayerPenalty) （魔压玩家伤害惩罚，最高 20%）
            //     * repetitionPenaltyFactor     （重复行动惩罚，连续>=3 次同行动触发 0.5 倍）
            //   设计目的：通过行动类型 + 阶段状态联动，让玩家不能无脑强攻，必须配合破幡/镇魂/护阵
            const actionMultiplier = Number(actionConfig.damage_multiplier) || 1.0;
            let finalDamage = Math.floor(
                baseDamage * soloRatio * teamFactor * realmSuppression
                * critFactor * randomFactor * playerElementalFactor
                * actionMultiplier
                * (1 - bannerSoulDamageReduction)
                * (1 - magicPressurePlayerPenalty)
                * repetitionPenaltyFactor
            );
            // 防御性兜底：极端减伤情况下伤害至少为 1（保证参与奖可拿）
            if (finalDamage < 1) finalDamage = 1;

            // ========== 灵兽独立追加伤害 ==========
            // 设计目的：让灵兽不仅是属性加成，还能在 BOSS 战中独立造成一次伤害（视觉/数值上的"灵兽助战"）
            // 计算公式：灵兽ATK加成值 * assist_damage_ratio * 五行相克系数 * 技能倍率
            // 注意：灵兽 ATK 加成已经在 playerAtk 中体现一次，这里按 assist_damage_ratio 二次独立计算
            //       避免"双倍叠加"，独立伤害仅作为"灵兽额外攻击"的视觉表现
            // 多行动机制：灵兽助战伤害同样受行动倍率影响（非强攻时灵兽也配合玩家克制输出）
            const assistCfg = cfg.spirit_beast_assist || {};
            let beastAssistDamage = 0;
            if (assistCfg.enable_assist_damage !== false && spiritBeastInfo) {
                const beastAtkBonus = Number(spiritBeastBreakdown.atk) || 0;
                const assistRatio = Number(assistCfg.assist_damage_ratio) || 0.3;
                // 灵兽独立伤害也参与五行相克（与玩家主伤害一致），同时受行动倍率影响
                beastAssistDamage = Math.floor(
                    beastAtkBonus * assistRatio * skillMultiplier * playerElementalFactor * actionMultiplier
                );
            }

            // 玩家总伤害 = 玩家主伤害 + 灵兽助战伤害
            finalDamage += beastAssistDamage;

            // ========== BOSS HP 扣减 ==========
            const bossHpBefore = safeBigInt(boss.hp_current);
            const damageBigInt = BigInt(finalDamage);
            let bossHpAfter = bossHpBefore - damageBigInt;
            // 防御性兜底：HP 不为负
            if (bossHpAfter < 0n) bossHpAfter = 0n;
            boss.hp_current = bossHpAfter;

            // 累计伤害统计
            boss.total_damage_taken = safeBigInt(boss.total_damage_taken) + damageBigInt;

            // ========== 多行动机制：更新 BOSS 三大状态字段（2026-07-21 新增） ==========
            // 设计目的：玩家行动不仅造成伤害，还会动态改变阶段状态
            //   - banner_soul     : 受 break_banner 削减（15/次），其他行动不影响
            //   - magic_pressure   : 受 action.magic_pressure_increase 提升、suppress_soul 削减（15/次）
            //                         同时每回合自动 +per_round_increase（3，模拟 Boss 主动蓄压）
            //   - array_integrity  : 受 action.array_integrity_change 变化（护阵+12、强攻-3、破幡-1）
            //                         同时每回合自动 -per_round_decrease（2，模拟阵势自然消耗）
            // 三大状态都用 clamp 限制在 [0, 100] 区间，避免越界
            const clampStateValue = (v) => Math.max(0, Math.min(100, v));
            // 魔压变化：行动增减 + 每回合自然增长（suppress_soul 的 magic_pressure_decrease 已在 action 配置中）
            const magicPressureDelta =
                (Number(actionConfig.magic_pressure_increase) || 0)
                - (Number(actionConfig.magic_pressure_decrease) || 0)
                + (Number(magicPressureCfg.per_round_increase) || 0);
            // 阵势变化：行动变化 - 每回合自然消耗
            const arrayIntegrityDelta =
                (Number(actionConfig.array_integrity_change) || 0)
                - (Number(arrayIntegrityCfg.per_round_decrease) || 0);

            const newBannerSoul = clampStateValue(currentBannerSoul - (Number(actionConfig.banner_soul_damage) || 0));
            const newMagicPressure = clampStateValue(currentMagicPressure + magicPressureDelta);
            const newArrayIntegrity = clampStateValue(currentArrayIntegrity + arrayIntegrityDelta);

            // 记录状态变化前值（用于返回结果中展示 diff）
            const bannerSoulBefore = currentBannerSoul;
            const magicPressureBefore = currentMagicPressure;
            const arrayIntegrityBefore = currentArrayIntegrity;

            boss.banner_soul = newBannerSoul;
            boss.magic_pressure = newMagicPressure;
            boss.array_integrity = newArrayIntegrity;

            // ========== 阶段切换检查 ==========
            const phaseChanged = await this._checkPhaseTransition(boss, t);

            // ========== BOSS 反击（使用技能表完整实现） ==========
            // 旧版：固定公式 ATK * phaseMultiplier * randomFactor，简化无策略
            // 新版（2026-07-20）：调用 WorldBossSkillManager 按权重随机选择技能
            //   - 单体基础/技能：直接伤害 + 可能附带流血/眩晕/破甲效果
            //   - AOE / 全屏必杀：高倍率伤害，需广播给所有参战玩家
            //   - 召唤：生成小怪存入 boss.minions，玩家可优先攻击小怪
            //   - 自身 Buff：ATK 提升 / 吸血 / 免控，持续 buff_duration_seconds
            // 技能表来源：world_boss_data.json → bosses[].skills[phase].skills[]
            // 全局配置：game_balance.json → world_boss.boss_skills

            // 1. 先清理过期 Buff 和小怪
            const expiredBuffs = WorldBossSkillManager.cleanupExpiredBuffs(boss);
            const expiredMinions = WorldBossSkillManager.cleanupExpiredMinions(boss);

            // 2. 选择本回合触发的技能（按权重随机 + 冷却检查）
            const selectedSkill = WorldBossSkillManager.selectSkill(
                boss.boss_key,
                boss.phase,
                boss.skill_cooldowns,
                boss.active_buffs
            );

            // 3. 执行技能效果，获得伤害数值和附加效果
            const skillCtx = {
                bossKey: boss.boss_key,
                bossElement: bossElement,
                cfgBalance: cfg,
                playerId: playerId
            };
            const skillTarget = {
                battleHp: 0, // executeSkill 不直接扣血，由外层根据 counter_damage 扣减
                battleHpMax: playerHpMax,
                playerDef: playerDef,
                playerBeastElement: playerBeastElement
            };
            const skillResult = WorldBossSkillManager.executeSkill(boss, selectedSkill, skillTarget, skillCtx);

            // 4. 更新技能冷却
            WorldBossSkillManager.updateCooldown(boss, selectedSkill);

            // 5. 应用 Buff 到 BOSS（如果有）
            if (skillResult.buff_applied) {
                if (!boss.active_buffs) boss.active_buffs = [];
                boss.active_buffs.push(skillResult.buff_applied);
            }

            // 6. 应用召唤小怪到 BOSS（如果有）
            if (skillResult.minions_summoned && skillResult.minions_summoned.length > 0) {
                if (!boss.minions) boss.minions = [];
                boss.minions.push(...skillResult.minions_summoned);
            }

            // 7. 吸血回复（如果触发了吸血）
            if (skillResult.lifesteal_amount > 0) {
                const healAmount = BigInt(skillResult.lifesteal_amount);
                const newBossHp = safeBigInt(boss.hp_current) + healAmount;
                // 吸血不超过 max_hp
                const bossHpMax = safeBigInt(boss.hp_max);
                boss.hp_current = newBossHp > bossHpMax ? bossHpMax : newBossHp;
                skillResult.boss_hp_recovered = skillResult.lifesteal_amount;
            }

            // 8. 取最终反击伤害（单体/AOE/全屏必杀 都通过 counter_damage 体现）
            // 多行动机制扩展（2026-07-21）：
            //   BOSS 反击伤害需要乘以魔压加成（+0~30%）和阵势低加成（+0~70%）
            //   设计目的：让玩家承受"魔压过高 / 阵势崩溃"的代价，强化护阵/镇魂的必要性
            //   修改位置：在 skillResult 计算之后、写入 damageRecord 之前，避免修改 boss.atk 影响其他模块
            const rawBossCounterDamage = skillResult.counter_damage;
            // 阶段加成系数 = 1 + 魔压加成 + 阵势加成
            const bossCounterBonusFactor = 1 + magicPressureBossBonus + arrayIntegrityBossBonus;
            // 应用加成并向下取整（最小 0）
            const bossCounterDamage = Math.max(0, Math.floor(rawBossCounterDamage * bossCounterBonusFactor));
            // 透传加成详情到 skillResult，便于前端展示"魔压加成 +30%"等提示
            skillResult.counter_damage = bossCounterDamage;
            skillResult.counter_bonus_breakdown = {
                raw_damage: rawBossCounterDamage,
                magic_pressure_bonus: Number(magicPressureBossBonus.toFixed(4)),
                array_integrity_bonus: Number(arrayIntegrityBossBonus.toFixed(4)),
                final_factor: Number(bossCounterBonusFactor.toFixed(4)),
                final_damage: bossCounterDamage
            };

            // 9. AOE 伤害广播（仅记录事件，实际广播在外层 commit 后执行，避免事务回滚后误推送）
            const aoeEvent = skillResult.is_aoe ? {
                skill_name: skillResult.skill_name,
                skill_type: skillResult.skill_type,
                aoe_damage: skillResult.aoe_damage,
                description: skillResult.description,
                boss_id: boss.id,
                boss_name: boss.boss_name,
                trigger_player_id: playerId
            } : null;

            // 初始化或更新玩家战斗运行时状态
            // 2026-07-21 修复：增加 BOSS 战玩家 HP 倍率
            //   原设计 battleHp = playerHpMax，但化神初期玩家 hp_max=3500，
            //   BOSS 青元子 atk=2000 单次反击约 1800 伤害，玩家 2 次反击就死亡。
            //   设计上玩家应能承受 5-10 次反击，给玩家足够机会造成伤害。
            //   现通过 player_hp_multiplier（默认 5.0）放大 BOSS 战中玩家 HP 上限，
            //   仅影响 BOSS 战虚拟 HP，不影响玩家真实 HP（players.hp_current）。
            let runtimeState = this._battleRuntime.get(runtimeKey);
            if (!runtimeState) {
                const playerHpMultiplier = cfg.player_hp_multiplier || 5.0;
                const battleHpMaxValue = Math.floor(playerHpMax * playerHpMultiplier);
                runtimeState = {
                    battleHp: BigInt(battleHpMaxValue),
                    battleHpMax: BigInt(battleHpMaxValue),
                    isDead: false,
                    lastReviveTime: 0,
                    lastRetreatTime: 0,
                    attackCount: 0,
                    deathCount: 0
                };
                this._battleRuntime.set(runtimeKey, runtimeState);
            }
            runtimeState.attackCount += 1;

            // 玩家 battleHp 扣减
            const playerHpBefore = runtimeState.battleHp;

            // ===== 道侣护道判定（与 CombatService/PvpService 一致的集成模式）=====
            // 世界BOSS战：BOSS反击玩家时，有概率触发道侣远程护持
            // PVE 场景下护道反击伤害作用于 BOSS（道侣远程协助攻击BOSS）
            // try-catch 兜底：护道判定失败不影响战斗主流程
            let protectInfo = null;
            let counterDamageToBoss = 0;
            let actualCounterToPlayer = bossCounterDamage;  // 默认值：原始反击伤害
            try {
                const DaoCompanionService = require('./DaoCompanionService');
                const protectResult = await DaoCompanionService.tryProtect(
                    playerId,
                    bossCounterDamage,
                    {
                        battleType: 'world_boss',            // 世界BOSS战斗场景
                        battleId: String(bossId),             // BOSS ID
                        battleRound: runtimeState.attackCount,// 攻击次数作为回合数
                        attackerId: null,                     // PVE 中攻击方是BOSS，无玩家ID
                        protectorAtk: 0,                      // 道侣不在战场，反击伤害计算时取配置默认
                        transaction: t                        // 复用当前事务
                    }
                );
                if (protectResult.triggered) {
                    protectInfo = protectResult;
                    // 玩家实际承受伤害（护道方分担了部分）
                    actualCounterToPlayer = Number(protectResult.actual_damage_to_defender);
                    // 反击伤害（BOSS承受）
                    counterDamageToBoss = Number(protectResult.counter_damage) || 0;
                    if (counterDamageToBoss > 0) {
                        boss.current_hp = safeBigInt(boss.current_hp) - BigInt(counterDamageToBoss);
                        // 反击伤害计入玩家对BOSS的总伤害（用于伤害排行）
                        damageBigInt = damageBigInt + BigInt(counterDamageToBoss);
                    }
                }
            } catch (protectErr) {
                // 护道判定失败不影响战斗主流程
                console.warn('[WorldBossService] 道侣护道判定异常:', protectErr.message);
            }

            const counterDamageBigInt = BigInt(actualCounterToPlayer);
            let playerHpAfter = playerHpBefore - counterDamageBigInt;
            let playerDied = false;
            if (playerHpAfter <= 0n) {
                playerHpAfter = 0n;
                playerDied = true;
                runtimeState.isDead = true;
                runtimeState.deathCount += 1;
                // 死亡惩罚：扣 5% 修为（design 文档要求；从玩家 attributes.exp 扣减，不调用 LifespanService）
                this._applyDeathExpPenalty(player, cfg.death_exp_penalty_rate || 0.05);
                boss.total_damage_dealt = safeBigInt(boss.total_damage_dealt) + counterDamageBigInt;
            } else {
                boss.total_damage_dealt = safeBigInt(boss.total_damage_dealt) + counterDamageBigInt;
            }
            runtimeState.battleHp = playerHpAfter;

            // ========== UPSERT 伤害记录 ==========
            const now = new Date();
            // 查询玩家宗门信息（用于宗门伤害排行聚合）
            const playerSect = await PlayerSect.findOne({
                where: { player_id: playerId },
                transaction: t
            });
            const sectId = playerSect?.sect_id || null;
            const sectName = this._getSectNameById(sectId);

            if (damageRecord) {
                // 已有记录：累加伤害/攻击次数/最佳伤害/最后攻击时间
                damageRecord.total_damage = safeBigInt(damageRecord.total_damage) + damageBigInt;
                damageRecord.damage_count += 1;
                damageRecord.best_single_damage = damageBigInt > safeBigInt(damageRecord.best_single_damage)
                    ? damageBigInt
                    : safeBigInt(damageRecord.best_single_damage);
                damageRecord.last_attack_time = now;
                if (playerDied) damageRecord.death_count += 1;
                // 同步冗余字段（玩家可能换境界/换宗门）
                damageRecord.player_realm = player.realm;
                damageRecord.sect_id = sectId;
                damageRecord.sect_name = sectName;
                damageRecord.is_participant = 1;
                // 多行动机制：更新 last_action 与 action_streak（2026-07-21 新增）
                // 重复同一行动 streak+1，切换行动类型重置为 1（reset_on_different_action=true）
                damageRecord.last_action = actionType;
                damageRecord.action_streak = newActionStreak;
                await damageRecord.save({ transaction: t });
            } else {
                // 新建伤害记录（首次攻击）
                damageRecord = await WorldBossDamageRecord.create({
                    boss_id: bossId,
                    player_id: playerId,
                    player_nickname: player.nickname,
                    player_realm: player.realm,
                    sect_id: sectId,
                    sect_name: sectName,
                    total_damage: damageBigInt,
                    damage_count: 1,
                    death_count: playerDied ? 1 : 0,
                    revive_count: 0,
                    best_single_damage: damageBigInt,
                    first_attack_time: now,
                    last_attack_time: now,
                    is_participant: 1,
                    // 多行动机制：首次记录初始化（2026-07-21 新增）
                    last_action: actionType,
                    action_streak: 1
                }, { transaction: t });
            }

            // BOSS 参与人数统计（首次攻击该BOSS的玩家才累加）
            if (isFirstAttack || !damageRecord._options.isNewRecord) {
                // 简化判定：若该玩家是首次留下伤害记录，参与人数+1
                const participantCount = await WorldBossDamageRecord.count({
                    where: { boss_id: bossId, is_participant: 1 },
                    transaction: t
                });
                boss.participant_count = participantCount;
            }

            // ========== 检查 BOSS 是否被击杀 ==========
            let bossDefeated = false;
            let settleResult = null;
            if (bossHpAfter <= 0n) {
                bossDefeated = true;
                boss.status = 'defeated';
                boss.defeat_time = now;
                boss.killer_player_id = playerId;
                boss.killer_nickname = player.nickname;
                // 全服首杀判定：同 boss_key 且 status='defeated' 的历史记录数 == 0
                const defeatedHistoryCount = await WorldBoss.count({
                    where: {
                        boss_key: boss.boss_key,
                        status: 'defeated',
                        id: { [Op.ne]: boss.id }
                    },
                    transaction: t
                });
                boss.first_kill_server = defeatedHistoryCount === 0 ? 1 : 0;
                // 触发结算（首杀/最后一击/伤害档位奖励/宗门积分）
                settleResult = await this._settleBossDefeat(boss, player, t);
            }

            // 保存 BOSS 状态变更
            await boss.save({ transaction: t });
            // 保存玩家状态变更（修为扣减等）
            await player.save({ transaction: t });

            await t.commit();

            // ========== 异步推送 WebSocket 通知（事务外，失败不阻塞） ==========
            try {
                // 推送玩家数据更新（伤害/HP/状态）
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'world_boss_attack', {
                    boss_id: bossId,
                    boss_name: boss.boss_name,
                    damage_dealt: finalDamage,
                    is_crit: isCrit,
                    counter_damage: bossCounterDamage,
                    battle_hp: bigIntToString(runtimeState.battleHp),
                    battle_hp_max: bigIntToString(runtimeState.battleHpMax),
                    is_dead: playerDied,
                    boss_defeated: bossDefeated,
                    phase_changed: phaseChanged,
                    new_phase: boss.phase
                });

                // 全服广播 BOSS HP 更新（active 状态时）
                if (boss.status === 'active') {
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: '世界BOSS动态',
                        content: `${boss.boss_name} 剩余血量：${bigIntToString(boss.hp_current)} / ${bigIntToString(boss.hp_max)}`,
                        priority: 'normal'
                    });
                }

                // 阶段切换广播
                if (phaseChanged) {
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: '世界BOSS阶段切换',
                        content: `${boss.boss_name} 进入第 ${boss.phase} 阶段，技能更加强大！`,
                        priority: 'high'
                    });
                }

                // BOSS 被击杀全服公告
                if (bossDefeated) {
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: boss.first_kill_server === 1 ? '全服首杀诞生！' : '世界BOSS被击杀！',
                        content: `${boss.boss_name} 被 ${player.nickname} 终结！${settleResult?.summary || ''}`,
                        priority: 'high'
                    });
                }
            } catch (e) {
                console.warn('[WorldBossService] WebSocket 推送失败:', e.message);
            }

            return {
                // ========== 多行动机制：行动信息（2026-07-21 新增） ==========
                // 当前行动类型/名称/倍率/重复惩罚标记
                action: {
                    type: actionType,
                    name: actionConfig.name || actionType,
                    description: actionConfig.description || '',
                    damage_multiplier: Number(actionMultiplier),
                    repetition_penalty_applied: repetitionPenaltyTriggered,
                    repetition_penalty_factor: Number(repetitionPenaltyFactor.toFixed(4)),
                    action_streak: newActionStreak,
                    streak_threshold: streakThreshold,
                    // 三大状态对本次伤害的影响（前端展示"幡魂减伤 -50%"等提示）
                    banner_soul_reduction: Number(bannerSoulDamageReduction.toFixed(4)),
                    magic_pressure_penalty: Number(magicPressurePlayerPenalty.toFixed(4))
                },
                attack: {
                    skill_id: skillId,
                    damage: finalDamage,
                    is_crit: isCrit,
                    damage_breakdown: {
                        player_atk: playerAtk,
                        skill_multiplier: skillMultiplier,
                        boss_def: boss.def,
                        // 新增：除法减伤曲线的减伤比例（0~1，越低表示 BOSS 防御削减越少）
                        def_reduction: Number(defReduction.toFixed(4)),
                        // 基础伤害（未乘系数前）
                        base_damage: Math.floor(baseDamage),
                        crit_factor: critFactor,
                        random_factor: Number(randomFactor.toFixed(4)),
                        // 单人挑战伤害比例（1.0=完整伤害，配置可调）
                        solo_ratio: soloRatio,
                        // 组队加成系数（多人合作时 >1.0）
                        team_factor: teamFactor,
                        active_participant_count: totalActiveCount,
                        // 境界压制加成（高境界玩家挑战低境界 Boss 时 >1.0）
                        realm_suppression: Number(realmSuppression.toFixed(4)),
                        player_realm_rank: playerRealmRank,
                        boss_realm_rank_min: bossRealmRankMin,
                        // 五行相克系数
                        elemental_factor: playerElementalFactor,
                        // 最终伤害（含灵兽助战）
                        final_damage: finalDamage,
                        // 灵兽助战详情（前端用于展示"灵兽助战 +X 伤害"）
                        beast_assist_damage: beastAssistDamage,
                        beast_atk_bonus: Number(spiritBeastBreakdown.atk) || 0
                    }
                },
                // 五行相克信息（前端用于展示"灵兽克BOSS！伤害+50%"等提示）
                elemental_counter: {
                    player_beast_element: playerBeastElement,
                    boss_element: bossElement,
                    player_to_boss: {
                        factor: playerElementalFactor,
                        tag: elementalTag,
                        description: elementalCounter.description
                    },
                    // BOSS→玩家相克系数（与反击伤害同源）
                    boss_to_player: {
                        factor: WorldBossSkillManager._calculateElementalCounter(bossElement, playerBeastElement),
                        tag: '',
                        description: ''
                    }
                },
                // 灵兽助战简要信息（beast_name/bonus_rate/element 等）
                spirit_beast: spiritBeastInfo,
                boss: {
                    id: boss.id,
                    name: boss.boss_name,
                    hp_before: bigIntToString(bossHpBefore),
                    // 玩家攻击后的 HP（不含吸血回复）
                    hp_after: bigIntToString(bossHpAfter),
                    // 当前 HP（含吸血回复，与数据库一致）
                    hp_current: bigIntToString(boss.hp_current),
                    hp_max: bigIntToString(boss.hp_max),
                    hp_percentage: Number((safeBigInt(boss.hp_current) * 100n) / (safeBigInt(boss.hp_max) || 1n)),
                    phase: boss.phase,
                    phase_changed: phaseChanged,
                    status: boss.status,
                    defeated: bossDefeated,
                    // BOSS 当前激活的 Buff 列表（前端用于展示"剑意狂暴 - ATK+50%"等状态）
                    active_buffs: boss.active_buffs || [],
                    // BOSS 当前召唤的小怪列表（前端可展示"剑灵分身 x2"等）
                    minions: boss.minions || [],
                    // ========== 多行动机制：三大状态字段（2026-07-21 新增） ==========
                    // 当前 BOSS 阶段机制状态（0-100）
                    banner_soul: newBannerSoul,
                    magic_pressure: newMagicPressure,
                    array_integrity: newArrayIntegrity,
                    // 状态变化前后值（前端展示"+15/-5"等差异）
                    banner_soul_before: bannerSoulBefore,
                    banner_soul_after: newBannerSoul,
                    magic_pressure_before: magicPressureBefore,
                    magic_pressure_after: newMagicPressure,
                    array_integrity_before: arrayIntegrityBefore,
                    array_integrity_after: newArrayIntegrity,
                    // 状态阈值提示（前端用于 UI 警示，如"魔压告警！"）
                    pressure_warning: newMagicPressure >= (magicPressureCfg.pressure_threshold_warning || 60),
                    pressure_critical: newMagicPressure >= (magicPressureCfg.pressure_threshold_critical || 80),
                    array_low: newArrayIntegrity < (arrayIntegrityCfg.low_threshold || 30),
                    array_critical: newArrayIntegrity < (arrayIntegrityCfg.critical_threshold || 10)
                },
                counter: {
                    damage: actualCounterToPlayer,
                    original_damage: bossCounterDamage,
                    phase_multiplier: phaseMultiplier,
                    elemental_factor: skillResult.is_aoe
                        ? WorldBossSkillManager._calculateElementalCounter(bossElement, playerBeastElement)
                        : WorldBossSkillManager._calculateElementalCounter(bossElement, playerBeastElement),
                    // BOSS 技能详情（2026-07-20 新增）
                    skill: {
                        name: skillResult.skill_name,
                        type: skillResult.skill_type,
                        damage_multiplier: skillResult.damage_multiplier,
                        description: skillResult.description,
                        is_aoe: skillResult.is_aoe,
                        is_summon: skillResult.is_summon,
                        is_buff: skillResult.is_buff,
                        effect: skillResult.effect || null,
                        minions_summoned: skillResult.minions_summoned,
                        buff_applied: skillResult.buff_applied,
                        lifesteal_amount: skillResult.lifesteal_amount,
                        boss_hp_recovered: skillResult.boss_hp_recovered
                    },
                    // 多行动机制：BOSS 反击加成详情（2026-07-21 新增）
                    bonus_breakdown: skillResult.counter_bonus_breakdown || null
                },
                // AOE 事件（前端用于全屏特效/广播提示）
                aoe_event: aoeEvent,
                player: {
                    battle_hp_before: bigIntToString(playerHpBefore),
                    battle_hp_after: bigIntToString(playerHpAfter),
                    battle_hp_max: bigIntToString(runtimeState.battleHpMax),
                    is_dead: playerDied,
                    death_count: runtimeState.deathCount,
                    attack_count: runtimeState.attackCount
                },
                // 道侣护道信息（触发时透传给前端，用于展示"道侣护持"特效）
                // 包含字段：triggered/shared_damage/counter_damage/protector_id/log_id
                protect_info: protectInfo,
                settle: settleResult,
                phase_changed: phaseChanged,
                timestamp: now.toISOString()
            };
        } catch (err) {
            // 事务回滚前检查 t.finished，防止重复回滚
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 攻击世界BOSS（向后兼容接口）
     *
     * 多行动机制（2026-07-21）：
     *   原 attackBoss 现已委托给 performAction(playerId, bossId, 'assault', skillId)
     *   保持向后兼容：旧调用方无需修改即可使用强攻行动
     *   新代码应直接调用 performAction 以使用完整的 4 种行动机制
     *
     * @param {number} playerId - 攻击玩家ID
     * @param {number} bossId - BOSS实例ID
     * @param {string} [skillId='basic'] - 技能ID（basic/skill/ultimate，对应不同倍率）
     * @returns {Promise<Object>} 攻击结果（与 performAction 返回结构一致）
     */
    static async attackBoss(playerId, bossId, skillId = 'basic') {
        // 委托给 performAction，使用 'assault' 行动类型保持兼容
        return this.performAction(playerId, bossId, 'assault', skillId);
    }

    /**
     * 原地复活（消耗灵石，CD 60秒）
     *
     * 流程：
     *   1. 校验玩家处于"BOSS战死亡"状态
     *   2. 校验复活CD（默认60秒）
     *   3. 校验灵石足够支付复活费用（默认1000灵石）
     *   4. 扣减灵石，恢复 battleHp 至最大值，清除 isDead 标记
     *   5. 更新伤害记录 revive_count
     *   6. 推送 WebSocket 通知
     *
     * @param {number} playerId - 玩家ID
     * @param {number} bossId - BOSS实例ID
     * @returns {Promise<Object>} 复活结果
     */
    static async revive(playerId, bossId) {
        const cfg = this.getWorldBossConfig();
        const runtimeKey = `${bossId}:${playerId}`;
        const runtime = this._battleRuntime.get(runtimeKey);

        // 校验：必须处于 BOSS 战死亡状态
        if (!runtime?.isDead) {
            throw new AppError('当前未处于BOSS战陨落状态，无需复活', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 复活CD校验
        const reviveCooldownMs = (cfg.revive_cooldown_seconds || 60) * 1000;
        if (runtime.lastReviveTime && Date.now() - runtime.lastReviveTime < reviveCooldownMs) {
            const remain = Math.ceil((reviveCooldownMs - (Date.now() - runtime.lastReviveTime)) / 1000);
            throw new AppError(`复活冷却中，${remain} 秒后可再次复活`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 灵石消耗
        const reviveCost = BigInt(cfg.revive_cost_spirit_stones || 1000);
        const t = await sequelize.transaction();
        try {
            // 行级锁玩家
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
                throw new AppError('已身死道消，无法复活', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 灵石充足校验
            const playerStones = safeBigInt(player.spirit_stones);
            if (playerStones < reviveCost) {
                await t.commit();
                throw new AppError(
                    `灵石不足，原地复活需消耗 ${reviveCost.toString()} 灵石`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 扣减灵石
            player.spirit_stones = playerStones - reviveCost;
            await player.save({ transaction: t });

            // 更新伤害记录 revive_count
            await WorldBossDamageRecord.increment('revive_count', {
                where: { boss_id: bossId, player_id: playerId },
                transaction: t
            });

            await t.commit();

            // 恢复 battleHp 至最大值，清除 isDead
            runtime.battleHp = runtime.battleHpMax;
            runtime.isDead = false;
            runtime.lastReviveTime = Date.now();

            // 推送 WebSocket 通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'world_boss_revive', {
                    boss_id: bossId,
                    battle_hp: bigIntToString(runtime.battleHp),
                    battle_hp_max: bigIntToString(runtime.battleHpMax),
                    spirit_stone_cost: reviveCost.toString(),
                    spirit_stones_remaining: bigIntToString(player.spirit_stones)
                });
            } catch (e) {
                console.warn('[WorldBossService] 复活推送失败:', e.message);
            }

            return {
                success: true,
                message: '原地复活成功',
                battle_hp: bigIntToString(runtime.battleHp),
                battle_hp_max: bigIntToString(runtime.battleHpMax),
                spirit_stone_cost: reviveCost.toString(),
                spirit_stones_remaining: bigIntToString(player.spirit_stones),
                next_revive_available_at: new Date(Date.now() + reviveCooldownMs).toISOString()
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 撤退（退出BOSS战斗，5分钟内不能再进入）
     *
     * 流程：
     *   1. 校验玩家当前在 BOSS 战中（有 runtime 状态）
     *   2. 清除 runtime 状态（battleHp/isDead 等），记录 lastRetreatTime
     *   3. 推送 WebSocket 通知
     *
     * @param {number} playerId - 玩家ID
     * @param {number} bossId - BOSS实例ID
     * @returns {Promise<Object>} 撤退结果
     */
    static async retreat(playerId, bossId) {
        const cfg = this.getWorldBossConfig();
        const runtimeKey = `${bossId}:${playerId}`;
        const runtime = this._battleRuntime.get(runtimeKey);

        // 修复 P0 bug（2026-07-21）：
        // 服务重启后 _battleRuntime 内存数据丢失，但 WorldBossDamageRecord 表中的
        // 伤害记录仍然存在，状态机据此判断玩家在BOSS战中，但 retreat 方法却报
        // "未在BOSS战中"，导致玩家被卡死无法进行任何其他操作。
        // 修复策略：当 _battleRuntime 不存在时，回查伤害记录，如果有最近的攻击
        // 记录且 BOSS 仍 active，则视为"仍在BOSS战中"，允许撤退并清理伤害记录
        // 的 last_attack_time（让状态机不再认为玩家在BOSS战中）
        if (!runtime) {
            const activeWindowMs = cfg.active_window_ms || 300000; // 默认 5 分钟
            const activeThreshold = new Date(Date.now() - activeWindowMs);
            const existingRecord = await WorldBossDamageRecord.findOne({
                where: {
                    player_id: playerId,
                    boss_id: bossId,
                    last_attack_time: { [Op.gte]: activeThreshold }
                }
            });

            if (!existingRecord) {
                throw new AppError('当前未在BOSS战中，无需撤退', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 伤害记录存在但 runtime 丢失：清理 last_attack_time，让状态机释放玩家
            console.log(`[WorldBossService] 玩家 ${playerId} 检测到遗留 BOSS 战记录（runtime 丢失），清理 last_attack_time 释放状态`);
            existingRecord.last_attack_time = new Date(Date.now() - (activeWindowMs + 60000)); // 设为窗口外 1 分钟
            await existingRecord.save();
        } else {
            // 撤退禁入CD：5 分钟（attack_cooldown_seconds * 60，简化设计）
            const retreatCooldownSec = (cfg.attack_cooldown_seconds || 5) * 60;
            const lastRetreatTime = Date.now();

            // 清除 runtime 状态（保留 lastRetreatTime 用于禁入CD校验）
            this._battleRuntime.set(runtimeKey, {
                battleHp: 0n,
                battleHpMax: 0n,
                isDead: false,
                lastReviveTime: 0,
                lastRetreatTime,
                attackCount: 0,
                deathCount: 0
            });

            // 同时清理伤害记录的 last_attack_time，让状态机立即释放玩家
            try {
                await WorldBossDamageRecord.update(
                    { last_attack_time: new Date(Date.now() - 31 * 60 * 1000) }, // 设为 31 分钟前，确保超出 30 分钟窗口
                    { where: { player_id: playerId, boss_id: bossId } }
                );
            } catch (e) {
                console.warn('[WorldBossService] 清理伤害记录 last_attack_time 失败:', e.message);
            }
        }

        const retreatCooldownSec = (cfg.attack_cooldown_seconds || 5) * 60;
        const lastRetreatTime = Date.now();

        // 确保 runtime 状态被正确重置（覆盖两个分支）
        this._battleRuntime.set(runtimeKey, {
            battleHp: 0n,
            battleHpMax: 0n,
            isDead: false,
            lastReviveTime: 0,
            lastRetreatTime,
            attackCount: 0,
            deathCount: 0
        });

        // 推送 WebSocket 通知
        try {
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'world_boss_retreat', {
                boss_id: bossId,
                cooldown_seconds: retreatCooldownSec,
                next_available_at: new Date(lastRetreatTime + retreatCooldownSec * 1000).toISOString()
            });
        } catch (e) {
            console.warn('[WorldBossService] 撤退推送失败:', e.message);
        }

        return {
            success: true,
            message: '已撤退，5分钟内无法再次挑战此BOSS',
            cooldown_seconds: retreatCooldownSec,
            next_available_at: new Date(lastRetreatTime + retreatCooldownSec * 1000).toISOString()
        };
    }

    // =========================================================================
    // 排行榜层
    // =========================================================================

    /**
     * 获取伤害排行（个人/宗门）
     * @param {number} bossId - BOSS实例ID
     * @param {string} [type='personal'] - 排行类型：personal / sect
     * @param {number} [limit=100] - 返回条数上限
     * @returns {Promise<Object>} 排行榜数据
     */
    static async getDamageRanking(bossId, type = 'personal', limit = 100) {
        // 上限校验：防止恶意请求大 limit 导致慢查询
        const maxLimit = Math.min(Math.max(1, Number(limit) || 100), 500);

        const boss = await WorldBoss.findByPk(bossId);
        if (!boss) {
            throw new AppError('世界BOSS不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const totalDamageTaken = safeBigInt(boss.total_damage_taken);

        if (type === 'sect') {
            // 宗门伤害排行：按 sect_id 聚合
            const records = await WorldBossDamageRecord.findAll({
                where: {
                    boss_id: bossId,
                    is_participant: 1,
                    total_damage: { [Op.gt]: 0 },
                    sect_id: { [Op.ne]: null }
                },
                attributes: [
                    'sect_id',
                    'sect_name',
                    [sequelize.fn('SUM', sequelize.col('total_damage')), 'sect_total_damage'],
                    [sequelize.fn('COUNT', sequelize.col('player_id')), 'member_count']
                ],
                group: ['sect_id', 'sect_name'],
                order: [[sequelize.literal('sect_total_damage'), 'DESC']],
                limit: maxLimit,
                raw: true
            });

            return {
                type: 'sect',
                boss_id: bossId,
                boss_name: boss.boss_name,
                total_damage_taken: bigIntToString(totalDamageTaken),
                ranking: records.map((r, idx) => ({
                    rank: idx + 1,
                    sect_id: r.sect_id,
                    sect_name: r.sect_name,
                    sect_total_damage: bigIntToString(r.sect_total_damage),
                    member_count: Number(r.member_count),
                    damage_percentage: totalDamageTaken > 0n
                        ? Number((safeBigInt(r.sect_total_damage) * 10000n) / totalDamageTaken) / 100
                        : 0
                }))
            };
        }

        // 默认个人伤害排行
        const records = await WorldBossDamageRecord.findAll({
            where: {
                boss_id: bossId,
                is_participant: 1,
                total_damage: { [Op.gt]: 0 }
            },
            order: [['total_damage', 'DESC']],
            limit: maxLimit
        });

        return {
            type: 'personal',
            boss_id: bossId,
            boss_name: boss.boss_name,
            total_damage_taken: bigIntToString(totalDamageTaken),
            ranking: records.map((r, idx) => ({
                rank: idx + 1,
                player_id: r.player_id,
                player_nickname: r.player_nickname,
                player_realm: r.player_realm,
                sect_id: r.sect_id,
                sect_name: r.sect_name,
                total_damage: bigIntToString(r.total_damage),
                damage_count: r.damage_count,
                death_count: r.death_count,
                revive_count: r.revive_count,
                best_single_damage: bigIntToString(r.best_single_damage),
                damage_percentage: totalDamageTaken > 0n
                    ? Number((safeBigInt(r.total_damage) * 10000n) / totalDamageTaken) / 100
                    : 0
            }))
        };
    }

    /**
     * 获取赛季排行（赛季累计伤害）
     * @param {number} seasonId - 赛季ID
     * @param {number} [limit=100] - 返回条数上限
     * @returns {Promise<Object>} 赛季排行榜
     */
    static async getSeasonRanking(seasonId, limit = 100) {
        const maxLimit = Math.min(Math.max(1, Number(limit) || 100), 500);

        if (!seasonId) {
            throw new AppError('赛季ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const season = await WorldBossSeason.findByPk(seasonId);
        if (!season) {
            throw new AppError('赛季不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const records = await WorldBossSeasonRanking.findAll({
            where: { season_id: seasonId, total_damage: { [Op.gt]: 0 } },
            order: [['total_damage', 'DESC']],
            limit: maxLimit
        });

        return {
            season_id: seasonId,
            season_name: season.season_name,
            status: season.status,
            total_bosses_killed: season.total_bosses_killed,
            total_damage_dealt: bigIntToString(season.total_damage_dealt),
            ranking: records.map((r, idx) => ({
                rank: idx + 1,
                player_id: r.player_id,
                player_nickname: r.player_nickname,
                sect_id: r.sect_id,
                sect_name: r.sect_name,
                total_damage: bigIntToString(r.total_damage),
                boss_kill_count: r.boss_kill_count,
                first_kill_count: r.first_kill_count,
                best_rank: r.best_rank,
                last_rank: r.last_rank,
                honor_rewarded: r.honor_rewarded
            }))
        };
    }

    // =========================================================================
    // 内部结算层
    // =========================================================================

    /**
     * 检查并触发 BOSS 阶段切换
     * 阶段阈值（默认 [1.0, 0.6, 0.3]）：HP 百分比 <= 阈值时切换到下一阶段
     * @param {Object} boss - BOSS 实例（已加锁，调用方持有事务）
     * @param {Object} t - 事务实例
     * @returns {Promise<boolean>} 是否发生阶段切换
     * @private
     */
    static async _checkPhaseTransition(boss, t) {
        const cfg = this.getWorldBossConfig();
        const phaseThresholds = cfg.phase_thresholds || [1.0, 0.6, 0.3];

        const hpMax = safeBigInt(boss.hp_max);
        const hpCurrent = safeBigInt(boss.hp_current);
        if (hpMax <= 0n) return false;

        // 计算当前 HP 百分比（*100 保留2位精度）
        const hpPercentage = Number((hpCurrent * 10000n) / hpMax) / 100;

        // 从高到低遍历阈值，找到当前应处的阶段
        // 阈值 [1.0, 0.6, 0.3] 对应阶段 [1, 2, 3]
        let targetPhase = 1;
        for (let i = 0; i < phaseThresholds.length; i++) {
            // 第 i 个阈值对应阶段 i+1
            // 当 HP 百分比 <= 阈值[i] 且 > 阈值[i+1]（若有），则处于阶段 i+1
            if (i === phaseThresholds.length - 1) {
                // 最低阈值：HP <= 阈值则进入最终阶段
                if (hpPercentage <= phaseThresholds[i]) {
                    targetPhase = i + 1;
                }
            } else {
                if (hpPercentage <= phaseThresholds[i] && hpPercentage > phaseThresholds[i + 1]) {
                    targetPhase = i + 1;
                }
            }
        }
        // 边界：HP 100% 时为阶段 1
        if (hpPercentage > phaseThresholds[0]) {
            targetPhase = 1;
        }

        // 阶段切换：仅当目标阶段 > 当前阶段时切换（不支持回退）
        if (targetPhase > boss.phase) {
            boss.phase = targetPhase;
            return true;
        }
        return false;
    }

    /**
     * BOSS 被击杀结算（事务内完成所有结算）
     * 包含：
     *   1. 首杀奖励（全服首杀 + 当日首杀）
     *   2. 最后一击奖励（终结者称号 + 灵石）
     *   3. 伤害档位奖励（按伤害占比发放给所有参与者）
     *   4. 宗门积分（按宗门成员伤害占比累加）
     *   5. 赛季排行更新（更新 world_boss_season_rankings）
     *   6. 赛季统计累加（world_boss_seasons.total_bosses_killed / total_damage_dealt）
     *
     * @param {Object} boss - BOSS 实例（已被设置为 defeated，调用方持有事务）
     * @param {Object} killerPlayer - 最后一击玩家
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} 结算摘要
     * @private
     */
    static async _settleBossDefeat(boss, killerPlayer, t) {
        const cfg = this.getWorldBossConfig();
        const now = new Date();
        const summary = [];

        // ===== 1. 最后一击奖励 =====
        const killerReward = cfg.killer_reward || { spirit_stones: 5000, title: '终结者' };
        const killerStones = safeBigInt(killerPlayer.spirit_stones) + BigInt(killerReward.spirit_stones || 0);
        killerPlayer.spirit_stones = killerStones;
        // 称号奖励通过 NotificationService 异步发放（避免事务内调用复杂服务）
        summary.push(`终结者 ${killerPlayer.nickname} 获得 ${killerReward.spirit_stones || 0} 灵石`);

        // ===== 2. 全服首杀奖励 =====
        if (boss.first_kill_server === 1) {
            const firstKillReward = cfg.first_kill_server_reward || { spirit_stones: 50000, title: '首杀功臣' };
            const firstKillStones = BigInt(firstKillReward.spirit_stones || 0);
            killerPlayer.spirit_stones = safeBigInt(killerPlayer.spirit_stones) + firstKillStones;
            summary.push(`全服首杀！${killerPlayer.nickname} 额外获得 ${firstKillStones.toString()} 灵石 + ${firstKillReward.title || '首杀功臣'} 称号`);
        }

        // ===== 3. 伤害档位奖励（发放给所有参与者） =====
        const tierRewardsResult = await this._grantDamageTierRewards(boss, t);
        summary.push(tierRewardsResult.summary);

        // ===== 4. 赛季排行更新 =====
        if (boss.season_id > 0) {
            // 查询本场所有参与者伤害记录，按伤害降序
            const damageRecords = await WorldBossDamageRecord.findAll({
                where: { boss_id: boss.id, is_participant: 1, total_damage: { [Op.gt]: 0 } },
                order: [['total_damage', 'DESC']],
                transaction: t
            });

            // 累加赛季排行：每玩家一条 world_boss_season_rankings 记录
            for (let i = 0; i < damageRecords.length; i++) {
                const record = damageRecords[i];
                const rank = i + 1;
                const isKiller = record.player_id === killerPlayer.id;
                const isFirstKill = boss.first_kill_server === 1 && isKiller;

                // UPSERT 赛季排行记录（season_id + player_id 唯一）
                let seasonRanking = await WorldBossSeasonRanking.findOne({
                    where: { season_id: boss.season_id, player_id: record.player_id },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (seasonRanking) {
                    seasonRanking.total_damage = safeBigInt(seasonRanking.total_damage) + safeBigInt(record.total_damage);
                    seasonRanking.boss_kill_count += 1;
                    if (isFirstKill) seasonRanking.first_kill_count += 1;
                    // 最佳排名取最小值
                    if (rank < seasonRanking.best_rank) seasonRanking.best_rank = rank;
                    seasonRanking.last_rank = rank;
                    await seasonRanking.save({ transaction: t });
                } else {
                    await WorldBossSeasonRanking.create({
                        season_id: boss.season_id,
                        player_id: record.player_id,
                        player_nickname: record.player_nickname,
                        sect_id: record.sect_id,
                        sect_name: record.sect_name,
                        total_damage: safeBigInt(record.total_damage),
                        boss_kill_count: 1,
                        first_kill_count: isFirstKill ? 1 : 0,
                        best_rank: rank,
                        last_rank: rank,
                        honor_rewarded: 0
                    }, { transaction: t });
                }
            }

            // 赛季统计累加
            await WorldBossSeason.increment(
                {
                    total_bosses_killed: 1,
                    total_damage_dealt: safeBigInt(boss.total_damage_taken)
                },
                {
                    where: { id: boss.season_id },
                    transaction: t
                }
            );
        }

        return {
            killer_reward: {
                spirit_stones: killerReward.spirit_stones || 0,
                title: killerReward.title || '终结者'
            },
            first_kill_server: boss.first_kill_server === 1,
            tier_rewards: tierRewardsResult.details,
            summary: summary.join('；')
        };
    }

    /**
     * 发放伤害档位奖励
     * 档位（来自 cfg.damage_share_thresholds + cfg.rewards）：
     *   - 头部 (top)：≥ 15%，顶级材料×3 + 灵石×5000 + 荣誉×200
     *   - 中坚 (mid)：≥ 5%，高级材料×2 + 灵石×2000 + 荣誉×100
     *   - 参与 (participant)：≥ 1%，中级材料×1 + 灵石×500 + 荣誉×30
     *   - 边缘 (edge)：< 1%，灵石×100 + 荣誉×10
     *
     * @param {Object} boss - BOSS 实例
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} 奖励发放结果 { summary, details }
     * @private
     */
    static async _grantDamageTierRewards(boss, t) {
        const cfg = this.getWorldBossConfig();
        const thresholds = cfg.damage_share_thresholds || { top: 0.15, mid: 0.05, participant: 0.01 };
        const rewards = cfg.rewards || {};

        // 查询所有参与者伤害记录
        const damageRecords = await WorldBossDamageRecord.findAll({
            where: { boss_id: boss.id, is_participant: 1, total_damage: { [Op.gt]: 0 } },
            order: [['total_damage', 'DESC']],
            transaction: t
        });

        const totalDamage = safeBigInt(boss.total_damage_taken);
        const details = [];
        let totalHonorGranted = 0;
        let totalStonesGranted = 0n;

        for (const record of damageRecords) {
            const playerDamage = safeBigInt(record.total_damage);
            // 伤害占比（0~1）
            const damageShare = totalDamage > 0n
                ? Number(playerDamage) / Number(totalDamage)
                : 0;

            // 档位判定
            let tier = 'edge';
            if (damageShare >= thresholds.top) {
                tier = 'top';
            } else if (damageShare >= thresholds.mid) {
                tier = 'mid';
            } else if (damageShare >= thresholds.participant) {
                tier = 'participant';
            }

            const tierReward = rewards[tier] || { spirit_stones: 0, honor: 0 };
            const stonesReward = BigInt(tierReward.spirit_stones || 0);
            const honorReward = Number(tierReward.honor) || 0;
            const materialsReward = Number(tierReward.materials) || 0;

            // 行级锁玩家，扣减灵石/累加荣誉
            const player = await Player.findByPk(record.player_id, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!player) continue;

            // 灵石奖励
            player.spirit_stones = safeBigInt(player.spirit_stones) + stonesReward;
            // 荣誉奖励（player.honor 是 BIGINT）
            player.honor = safeBigInt(player.honor) + BigInt(honorReward);
            await player.save({ transaction: t });

            totalHonorGranted += honorReward;
            totalStonesGranted += stonesReward;

            details.push({
                player_id: record.player_id,
                player_nickname: record.player_nickname,
                damage: bigIntToString(playerDamage),
                damage_share: Number((damageShare * 100).toFixed(2)),
                tier,
                rewards: {
                    spirit_stones: stonesReward.toString(),
                    honor: honorReward,
                    materials: materialsReward
                }
            });
        }

        return {
            summary: `共 ${details.length} 名参与者获得奖励，发放灵石 ${totalStonesGranted.toString()} + 荣誉 ${totalHonorGranted}`,
            details
        };
    }

    // =========================================================================
    // BOSS 生命周期管理层
    // =========================================================================

    /**
     * 刷新BOSS（GM调用或调度器调用）
     *
     * 流程：
     *   1. 校验 bossKey 对应的静态配置存在
     *   2. 校验同 boss_key 当前无 active/pending 状态的BOSS（避免重复刷新）
     *   3. 从静态配置读取 base_hp/base_atk/base_def/base_speed
     *   4. 创建 WorldBoss 记录，状态 pending，过期时间 = 当前时间 + expire_hours
     *   5. 推送全服公告
     *
     * @param {string} bossKey - BOSS配置键（如 qingyuanzi）
     * @param {number} [seasonId=0] - 赛季ID（0表示无赛季）
     * @param {number} [customHp=null] - 自定义HP（GM可调，null 则用配置默认值）
     * @returns {Promise<Object>} 刷新结果
     */
    static async spawnBoss(bossKey, seasonId = 0, customHp = null) {
        // 参数校验
        if (!bossKey) {
            throw new AppError('BOSS配置键不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 读取BOSS静态配置
        const staticData = this.getBossStaticData(bossKey);
        if (!staticData) {
            throw new AppError(`BOSS静态配置不存在：${bossKey}`, 404, ErrorCodes.CONFIG_ERROR);
        }

        // 校验当前无同 boss_key 的活跃BOSS
        const existing = await WorldBoss.findOne({
            where: {
                boss_key: bossKey,
                status: { [Op.in]: ['pending', 'active'] }
            }
        });
        if (existing) {
            throw new AppError(
                `BOSS ${staticData.boss_name} 已存在活跃实例（ID: ${existing.id}），不可重复刷新`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 计算 HP / 过期时间
        const hpMax = customHp ? BigInt(customHp) : BigInt(staticData.base_hp);
        const now = new Date();
        const expireHours = Number(staticData.spawn_schedule ? (staticData.expire_hours || 4) : 4);
        const expireTime = new Date(now.getTime() + expireHours * 3600 * 1000);

        // 创建BOSS实例
        const boss = await WorldBoss.create({
            boss_key: bossKey,
            boss_name: staticData.boss_name,
            realm_rank_min: staticData.realm_rank_min,
            hp_max: hpMax,
            hp_current: hpMax,
            atk: staticData.base_atk,
            def: staticData.base_def,
            speed: staticData.base_speed,
            phase: 1,
            status: 'pending',
            spawn_time: now,
            active_start_time: null,
            defeat_time: null,
            expire_time: expireTime,
            season_id: seasonId,
            total_damage_dealt: 0n,
            total_damage_taken: 0n,
            participant_count: 0,
            killer_player_id: null,
            killer_nickname: null,
            first_kill_server: 0
        });

        // 全服公告
        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '世界BOSS降临',
                content: `${staticData.boss_name} 已现世！各位道友速速前往讨伐，过期时间 ${expireTime.toISOString()}`,
                priority: 'high'
            });
        } catch (e) {
            console.warn('[WorldBossService] 刷新公告推送失败:', e.message);
        }

        return {
            success: true,
            boss_id: boss.id,
            boss_key: boss.boss_key,
            boss_name: boss.boss_name,
            hp_max: bigIntToString(boss.hp_max),
            spawn_time: boss.spawn_time,
            expire_time: boss.expire_time,
            season_id: boss.season_id
        };
    }

    /**
     * BOSS 过期（未被击杀自动消失）
     * 由调度器在 expire_time 到达后调用
     * @param {number} bossId - BOSS实例ID
     * @returns {Promise<Object>} 过期结果
     */
    static async expireBoss(bossId) {
        if (!bossId) {
            throw new AppError('BOSS ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const boss = await WorldBoss.findByPk(bossId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!boss) {
                await t.commit();
                throw new AppError('世界BOSS不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 仅 pending/active 状态可过期
            if (boss.status !== 'pending' && boss.status !== 'active') {
                await t.commit();
                throw new AppError(
                    `BOSS当前状态 ${boss.status}，不可过期`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            boss.status = 'expired';
            await boss.save({ transaction: t });
            await t.commit();

            // 全服公告
            try {
                WebSocketNotificationService.sendGlobalAnnouncement({
                    title: '世界BOSS消失',
                    content: `${boss.boss_name} 已消失，未被击杀`,
                    priority: 'normal'
                });
            } catch (e) {
                console.warn('[WorldBossService] 过期公告推送失败:', e.message);
            }

            // 清理所有玩家的 runtime 状态（避免残留 isDead 标记）
            this._cleanupRuntimeByBossId(bossId);

            return {
                success: true,
                boss_id: bossId,
                boss_name: boss.boss_name,
                status: 'expired'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    // =========================================================================
    // 赛季管理层
    // =========================================================================

    /**
     * 创建新赛季
     * @param {string} seasonName - 赛季名称（如 "甲辰年夏季赛"）
     * @param {string} startDate - 开始日期（YYYY-MM-DD）
     * @param {string} endDate - 结束日期（YYYY-MM-DD）
     * @returns {Promise<Object>} 创建结果
     */
    static async createSeason(seasonName, startDate, endDate) {
        // 参数校验
        if (!seasonName || !startDate || !endDate) {
            throw new AppError('赛季名称/开始日期/结束日期不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 日期格式校验（简单正则，更严格可用 moment/dayjs）
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
            throw new AppError('日期格式必须为 YYYY-MM-DD', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (new Date(startDate) >= new Date(endDate)) {
            throw new AppError('开始日期必须早于结束日期', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验当前无 active 状态的赛季（同时只允许一个活跃赛季）
        const activeSeason = await WorldBossSeason.findOne({
            where: { status: 'active' }
        });
        if (activeSeason) {
            throw new AppError(
                `当前已有活跃赛季（${activeSeason.season_name}），需先结算`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 创建赛季
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        // 若开始日期 <= 今天 <= 结束日期，直接置为 active；否则 pending
        const status = (today >= startDate && today <= endDate) ? 'active' : 'pending';

        const season = await WorldBossSeason.create({
            season_name: seasonName,
            start_date: startDate,
            end_date: endDate,
            status,
            total_bosses_killed: 0,
            total_damage_dealt: 0n,
            settlement_time: null
        });

        return {
            success: true,
            season_id: season.id,
            season_name: season.season_name,
            start_date: season.start_date,
            end_date: season.end_date,
            status: season.status
        };
    }

    /**
     * 赛季结算
     * 流程：
     *   1. 校验赛季存在且未结算
     *   2. 标记赛季状态为 ended，记录 settlement_time
     *   3. 推送全服公告（赛季排名前3）
     * @param {number} seasonId - 赛季ID
     * @returns {Promise<Object>} 结算结果
     */
    static async settleSeason(seasonId) {
        if (!seasonId) {
            throw new AppError('赛季ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const season = await WorldBossSeason.findByPk(seasonId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!season) {
                await t.commit();
                throw new AppError('赛季不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (season.status === 'ended') {
                await t.commit();
                throw new AppError('赛季已结算，不可重复结算', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 标记结算
            season.status = 'ended';
            season.settlement_time = new Date();
            await season.save({ transaction: t });
            await t.commit();

            // 查询赛季前3名（用于公告）
            const top3 = await WorldBossSeasonRanking.findAll({
                where: { season_id: seasonId, total_damage: { [Op.gt]: 0 } },
                order: [['total_damage', 'DESC']],
                limit: 3
            });

            // 全服公告
            try {
                const rankingText = top3.map((r, idx) =>
                    `第${idx + 1}名：${r.player_nickname}（伤害 ${bigIntToString(r.total_damage)}）`
                ).join('；');
                WebSocketNotificationService.sendGlobalAnnouncement({
                    title: `赛季结算：${season.season_name}`,
                    content: `赛季已结束！${rankingText || '暂无有效排名'}`,
                    priority: 'high'
                });
            } catch (e) {
                console.warn('[WorldBossService] 赛季结算公告推送失败:', e.message);
            }

            return {
                success: true,
                season_id: seasonId,
                season_name: season.season_name,
                status: 'ended',
                settlement_time: season.settlement_time,
                total_bosses_killed: season.total_bosses_killed,
                total_damage_dealt: bigIntToString(season.total_damage_dealt),
                top_3: top3.map((r, idx) => ({
                    rank: idx + 1,
                    player_id: r.player_id,
                    player_nickname: r.player_nickname,
                    sect_name: r.sect_name,
                    total_damage: bigIntToString(r.total_damage),
                    boss_kill_count: r.boss_kill_count,
                    first_kill_count: r.first_kill_count
                }))
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    // =========================================================================
    // 辅助方法层
    // =========================================================================

    /**
     * 应用死亡修为惩罚（不调用 LifespanService，仅扣 attributes.exp）
     * @param {Object} player - 玩家实例（事务内已加锁）
     * @param {number} penaltyRate - 惩罚比例（如 0.05 表示扣5%）
     * @private
     */
    static _applyDeathExpPenalty(player, penaltyRate) {
        // 解析玩家 attributes JSON
        const attrs = typeof player.attributes === 'string'
            ? JSON.parse(player.attributes)
            : (player.attributes || {});
        const currentExp = Number(attrs.exp) || 0;
        const penalty = Math.floor(currentExp * penaltyRate);
        attrs.exp = Math.max(0, currentExp - penalty);
        // 写回（player.attributes 的 setter 会自动 JSON.stringify）
        player.attributes = attrs;
    }

    /**
     * 计算五行相克系数（金克木/木克土/土克水/水克火/火克金）
     *
     * 用于世界BOSS战的伤害调整：
     *   - 攻击方元素克防御方元素 → 1.5x（伤害+50%）
     *   - 攻击方元素被防御方克制 → 0.75x（伤害-25%）
     *   - 同元素 / 任一方为 null → 1.0x（中性）
     *
     * 配置来源：game_balance.json → world_boss.elemental_counter
     *
     * @param {string|null} attackerElement - 攻击方元素（metal/wood/water/fire/earth）
     * @param {string|null} defenderElement - 防御方元素
     * @param {Object} cfg - world_boss 配置对象
     * @returns {Object} { factor, tag, description }
     *   - factor: 相克系数（1.5 / 0.75 / 1.0）
     *   - tag: 'advantage' / 'disadvantage' / 'neutral'
     *   - description: 中文描述（用于前端展示）
     * @private
     */
    static _calculateElementalCounter(attackerElement, defenderElement, cfg) {
        const elementalCfg = cfg?.elemental_counter || {};
        const advantageMultiplier = Number(elementalCfg.advantage_multiplier) || 1.5;
        const disadvantageMultiplier = Number(elementalCfg.disadvantage_multiplier) || 0.75;
        const neutralMultiplier = Number(elementalCfg.neutral_multiplier) || 1.0;
        const counterMatrix = elementalCfg.counter_matrix || {
            metal: 'wood', wood: 'earth', earth: 'water', water: 'fire', fire: 'metal'
        };

        // 任一方为空（无出战灵兽或BOSS无元素）按中性处理
        if (!attackerElement || !defenderElement) {
            return {
                factor: neutralMultiplier,
                tag: 'neutral',
                description: '无相克（中性）'
            };
        }

        // 同元素相安无事
        if (attackerElement === defenderElement) {
            return {
                factor: neutralMultiplier,
                tag: 'neutral',
                description: '同元素（中性）'
            };
        }

        // 攻击方克防御方
        if (counterMatrix[attackerElement] === defenderElement) {
            const elementNames = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土' };
            return {
                factor: advantageMultiplier,
                tag: 'advantage',
                description: `${elementNames[attackerElement] || attackerElement}克${elementNames[defenderElement] || defenderElement}（伤害+${Math.round((advantageMultiplier - 1) * 100)}%）`
            };
        }

        // 攻击方被防御方克制
        if (counterMatrix[defenderElement] === attackerElement) {
            const elementNames = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土' };
            return {
                factor: disadvantageMultiplier,
                tag: 'disadvantage',
                description: `${elementNames[defenderElement] || defenderElement}克${elementNames[attackerElement] || attackerElement}（伤害-${Math.round((1 - disadvantageMultiplier) * 100)}%）`
            };
        }

        // 非五行内的元素或无相克关系
        return {
            factor: neutralMultiplier,
            tag: 'neutral',
            description: '无相克（中性）'
        };
    }

    /**
     * 通过境界rank 反查境界名称（用于 meetsRealmRequirement 的 minRealmName 参数）
     * 实现说明：RealmService.meetsRealmRequirement 接受境界名称，
     *          此处通过 rank 反查名称作为入参
     * @param {number} rank - 境界rank
     * @returns {string} 境界名称，未找到返回空串
     * @private
     */
    static _getMinRealmNameByRank(rank) {
        const realm = RealmService.getRealmByRank(rank);
        return realm?.name || '';
    }

    /**
     * 通过宗门ID查询宗门名称（从 sect_data.json 静态配置）
     * @param {string} sectId - 宗门ID
     * @returns {string|null} 宗门名称，未找到返回 null
     * @private
     */
    static _getSectNameById(sectId) {
        if (!sectId) return null;
        try {
            const sectConfig = configLoader.getConfig('sect_data');
            const sect = sectConfig?.sects?.find(s => s.id === sectId);
            return sect?.name || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 清理指定 BOSS 的所有 runtime 状态（BOSS 过期/被击杀时调用）
     * @param {number} bossId - BOSS实例ID
     * @private
     */
    static _cleanupRuntimeByBossId(bossId) {
        const prefix = `${bossId}:`;
        for (const key of this._battleRuntime.keys()) {
            if (key.startsWith(prefix)) {
                this._battleRuntime.delete(key);
            }
        }
    }
}

module.exports = WorldBossService;
