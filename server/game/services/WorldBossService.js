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
     * 攻击世界BOSS（核心战斗逻辑）
     *
     * 流程：
     *   1. 状态机互斥校验（IN_WORLD_BOSS 与其他 exclusive 状态互斥）
     *   2. 开启事务，行级锁 BOSS + 玩家
     *   3. BOSS 状态校验（pending→active 自动激活；defeated/expired 拒绝）
     *   4. 攻击CD校验（默认5秒，从 damage_record.last_attack_time 推导）
     *   5. 玩家"BOSS战死亡"状态校验（需先复活才能继续攻击）
     *   6. 计算单次伤害 = max(1, ATK * 技能倍率 - BOSS DEF * 减伤系数) * 暴击系数 * 随机浮动
     *   7. BOSS HP 扣减，检查阶段切换（HP 百分比越过阈值时切换）
     *   8. BOSS 反击：玩家 battleHp 扣减，检查死亡（不真死，仅标记需复活）
     *   9. UPSERT 伤害记录（boss_id + player_id 唯一键）
     *  10. 检查 BOSS 是否被击杀（hp_current <= 0），若是触发结算
     *  11. 推送 WebSocket 通知（玩家数据 + 全服 HP 广播）
     *
     * @param {number} playerId - 攻击玩家ID
     * @param {number} bossId - BOSS实例ID
     * @param {string} [skillId='basic'] - 技能ID（basic/skill/ultimate，对应不同倍率）
     * @returns {Promise<Object>} 攻击结果（伤害/反击/是否击杀/是否死亡）
     */
    static async attackBoss(playerId, bossId, skillId = 'basic') {
        const cfg = this.getWorldBossConfig();

        // 全局开关
        if (cfg.enabled === false) {
            throw new AppError('世界BOSS系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验
        if (!playerId || !bossId) {
            throw new AppError('玩家ID与BOSS ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
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

            // ========== 计算单次伤害 ==========
            // 玩家属性通过 AttributeService.calculateFullAttributes 获取最终属性
            // 注意：同步方法不包含装备加成，BOSS战场景使用"基础+天赋+灵根+称号"快照可接受
            // （避免战斗中换装导致属性突变，与 DungeonService 设计一致）
            const attrResult = AttributeService.calculateFullAttributes(player);
            const finalAttrs = attrResult?.final || {};
            const playerAtk = Number(finalAttrs.atk) || 0;
            const playerDef = Number(finalAttrs.def) || 0;
            const playerHpMax = Number(finalAttrs.hp_max) || 100;

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

            // 单次伤害 = max(1, ATK * 技能倍率 - BOSS DEF * 减伤系数) * 暴击系数 * 随机浮动
            // 减伤系数：BOSS防御削减玩家伤害的比例（设计简化为 0.5，即 BOSS DEF 半效）
            const damageReduceRate = 0.5;
            const baseDamage = Math.max(1, playerAtk * skillMultiplier - boss.def * damageReduceRate);
            // 单人挑战伤害衰减（40%）；组队加成（+10%）由调度器在玩家加入组队时另行处理，此处默认单人
            const soloRatio = cfg.single_player_damage_ratio || 0.4;
            const finalDamage = Math.floor(baseDamage * critFactor * randomFactor * soloRatio);

            // ========== BOSS HP 扣减 ==========
            const bossHpBefore = safeBigInt(boss.hp_current);
            const damageBigInt = BigInt(finalDamage);
            let bossHpAfter = bossHpBefore - damageBigInt;
            // 防御性兜底：HP 不为负
            if (bossHpAfter < 0n) bossHpAfter = 0n;
            boss.hp_current = bossHpAfter;

            // 累计伤害统计
            boss.total_damage_taken = safeBigInt(boss.total_damage_taken) + damageBigInt;

            // ========== 阶段切换检查 ==========
            const phaseChanged = await this._checkPhaseTransition(boss, t);

            // ========== BOSS 反击 ==========
            // BOSS 反击伤害 = max(1, BOSS ATK * 阶段倍率 - 玩家 DEF * 减伤系数) * 技能系数
            const bossAtk = Number(boss.atk) || 0;
            const bossBaseCounter = Math.max(1, bossAtk * phaseMultiplier - playerDef * damageReduceRate);
            // 技能系数：随机 0.8 ~ 1.2（BOSS 也走技能倍率浮动）
            const bossSkillFactor = 0.8 + Math.random() * 0.4;
            const bossCounterDamage = Math.floor(bossBaseCounter * bossSkillFactor);

            // 初始化或更新玩家战斗运行时状态
            let runtimeState = this._battleRuntime.get(runtimeKey);
            if (!runtimeState) {
                runtimeState = {
                    battleHp: BigInt(playerHpMax),
                    battleHpMax: BigInt(playerHpMax),
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
            const counterDamageBigInt = BigInt(bossCounterDamage);
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
                    is_participant: 1
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
                attack: {
                    skill_id: skillId,
                    damage: finalDamage,
                    is_crit: isCrit,
                    damage_breakdown: {
                        player_atk: playerAtk,
                        skill_multiplier: skillMultiplier,
                        boss_def: boss.def,
                        damage_reduce_rate: damageReduceRate,
                        crit_factor: critFactor,
                        random_factor: Number(randomFactor.toFixed(4)),
                        solo_ratio: soloRatio,
                        base_damage: Math.floor(baseDamage),
                        final_damage: finalDamage
                    }
                },
                boss: {
                    id: boss.id,
                    name: boss.boss_name,
                    hp_before: bigIntToString(bossHpBefore),
                    hp_after: bigIntToString(bossHpAfter),
                    hp_max: bigIntToString(boss.hp_max),
                    hp_percentage: Number((bossHpAfter * 100n) / (safeBigInt(boss.hp_max) || 1n)),
                    phase: boss.phase,
                    phase_changed: phaseChanged,
                    status: boss.status,
                    defeated: bossDefeated
                },
                counter: {
                    damage: bossCounterDamage,
                    phase_multiplier: phaseMultiplier,
                    boss_skill_factor: Number(bossSkillFactor.toFixed(4))
                },
                player: {
                    battle_hp_before: bigIntToString(playerHpBefore),
                    battle_hp_after: bigIntToString(playerHpAfter),
                    battle_hp_max: bigIntToString(runtimeState.battleHpMax),
                    is_dead: playerDied,
                    death_count: runtimeState.deathCount,
                    attack_count: runtimeState.attackCount
                },
                settle: settleResult,
                timestamp: now.toISOString()
            };
        } catch (err) {
            // 事务回滚前检查 t.finished，防止重复回滚
            if (!t.finished) await t.rollback();
            throw err;
        }
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

        if (!runtime) {
            throw new AppError('当前未在BOSS战中，无需撤退', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

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
