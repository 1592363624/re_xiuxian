/**
 * 妖兽入侵核心服务
 *
 * 提供妖兽入侵系统的全部核心业务逻辑（参考 xiuxian_game_guide.md 第16节 妖兽入侵）：
 *   1. 配置读取：getBeastInvasionConfig / getBeastStaticData
 *      （beast_invasion_data.json + game_balance.beast_invasion）
 *   2. 事件生命周期：spawnInvasion / expireInvasion / checkExpired
 *   3. 捐献阶段：contribute（捐献物品累积锁灵大阵进度）
 *   4. 战斗阶段：attackBeast（事务+行级锁，含伤害计算/反击/聚合战报/击杀结算）
 *   5. 复活与撤退：revive（消耗灵石，CD 60秒）/ retreat（5分钟内禁入）
 *   6. 查询接口：getActiveInvasion / getInvasionDetail / getContributionProgress
 *                / getPlayerContribution / getAttackRanking / getHelp / getRewardsInfo
 *
 * 设计原则（遵循项目工程规范）：
 *   - 配置中心化：所有可变参数从 game_balance.beast_invasion 读取，妖兽静态数据从 beast_invasion_data.json 读取
 *   - 事务+行级锁：attackBeast 涉及 beast_invasions/beast_invasion_attacks/players 多表，必用事务+ LOCK.UPDATE
 *   - 状态机集成：攻击前调用 PlayerStateMachine.canStart(IN_BEAST_INVASION) 检查互斥
 *   - WebSocket 推送：通过 notifyPlayerUpdate 推玩家数据，sendGlobalAnnouncement 全服广播
 *   - BigInt 安全：HP/伤害全部走 safeBigInt，避免 null/undefined 转 BigInt 抛错
 *   - 错误处理：统一用 AppError + ErrorCodes，禁止裸 throw Error
 *   - 中文注释：文件头/类/方法/关键逻辑全部中文注释
 *
 * 状态机集成说明：
 *   IN_BEAST_INVASION 状态由 beastInvasion.js 状态注册文件派生
 *   （玩家有最近 active_window_ms 内攻击记录且妖兽仍 active）
 *   本服务不直接 enter/exit 状态，而是在 attackBeast 前调用 canStart 做互斥校验
 *
 * 两阶段流程：
 *   1. 捐献阶段（donation_phase_minutes 分钟）：玩家捐献指定物品累积贡献值
 *      - 达到 donation_target → 自动切换到战斗阶段
 *      - 超时未达标 → 妖兽自行散去（status=expired）
 *   2. 战斗阶段（battle_phase_minutes 分钟）：玩家攻击妖兽
 *      - 妖兽 HP 归零 → 击杀结算（status=defeated）
 *      - 战斗阶段超时未击杀 → 妖兽逃脱（status=escaped）
 */
'use strict';

const BeastInvasion = require('../../models/beastInvasion');
const BeastInvasionDonation = require('../../models/beastInvasionDonation');
const BeastInvasionAttack = require('../../models/beastInvasionAttack');
const Player = require('../../models/player');
const Item = require('../../models/item');
const AttributeService = require('../core/AttributeService');
const RealmService = require('../core/RealmService');
const PlayerStateMachine = require('../state/PlayerStateMachine');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const ArtifactDeepLineService = require('./ArtifactDeepLineService');
const InventoryService = require('./InventoryService');
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

class BeastInvasionService {
    /**
     * 战斗运行时状态缓存（不持久化，服务重启后清空）
     * 与 WorldBossService._battleRuntime 设计一致：
     *   - 妖兽战中玩家"虚拟HP/死亡/复活CD"是临时状态，重启后允许重置
     * key: `${invasionId}:${playerId}`
     * value: {
     *   battleHp: bigint,         // 玩家本场妖兽战中的当前HP
     *   battleHpMax: bigint,      // 本场妖兽战 HP 上限
     *   isDead: boolean,          // 是否陨落（需复活才能继续攻击）
     *   lastReviveTime: number,   // 上次复活时间戳（ms）
     *   lastRetreatTime: number,  // 上次撤退时间戳（ms）
     *   attackCount: number,      // 本场攻击次数
     *   deathCount: number        // 本场死亡次数
     * }
     */
    static _battleRuntime = new Map();

    /**
     * 聚合战报推送时间戳缓存
     * key: invasionId
     * value: 上次推送聚合战报的时间戳（ms）
     * 每 aggregation_window_ms 推送一次聚合战报，避免每次攻击都刷屏
     */
    static _lastAggregationPush = new Map();

    /**
     * 服务初始化（由 server/index.js 调用）
     * @param {Object} cfgLoader - 配置加载器实例
     */
    static initialize(cfgLoader) {
        // configLoader 已通过模块顶部 require 引入，此处仅做日志确认
        console.log('[BeastInvasionService] 初始化完成，妖兽入侵服务已就绪');
    }

    // =========================================================================
    // 配置读取层
    // =========================================================================

    /**
     * 读取妖兽入侵平衡配置（game_balance.json 的 beast_invasion 块）
     * @returns {Object} beast_invasion 配置对象（缺失时返回空对象）
     */
    static getBeastInvasionConfig() {
        const config = configLoader.getConfig('game_balance');
        return config?.beast_invasion || {};
    }

    /**
     * 读取妖兽静态数据（beast_invasion_data.json）
     * @param {string} beastKey - 妖兽配置键（如 xuelang_yaoshou）
     * @returns {Object|null} 妖兽静态配置，未找到返回 null
     */
    static getBeastStaticData(beastKey) {
        const data = configLoader.getConfig('beast_invasion_data');
        if (!data?.beasts) return null;
        return data.beasts.find(b => b.beast_key === beastKey) || null;
    }

    /**
     * 获取所有妖兽静态数据列表
     * @returns {Array} 妖兽静态配置数组
     */
    static getAllBeastStaticData() {
        const data = configLoader.getConfig('beast_invasion_data');
        return data?.beasts || [];
    }

    // =========================================================================
    // 事件生命周期层
    // =========================================================================

    /**
     * 开启一次妖兽入侵（管理员/调度器调用）
     *
     * 流程：
     *   1. 校验 beastKey 对应的静态配置存在
     *   2. 校验当前无 active 状态的妖兽入侵事件（避免并发开启多个）
     *   3. 从静态配置读取 base_hp/base_atk/base_def/base_speed/donation_target
     *   4. 创建 BeastInvasion 记录，phase=donation，status=active
     *   5. 计算 donation_end_time（start + donation_phase_minutes）
     *   6. 推送全服公告
     *
     * @param {string} beastKey - 妖兽配置键
     * @param {number} [hours=null] - 自定义事件总时长（小时），null 则用配置默认值
     * @returns {Promise<Object>} 开启结果
     */
    static async spawnInvasion(beastKey, hours = null) {
        // 参数校验
        if (!beastKey) {
            throw new AppError('妖兽配置键不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 读取妖兽静态配置
        const staticData = this.getBeastStaticData(beastKey);
        if (!staticData) {
            throw new AppError(`妖兽静态配置不存在：${beastKey}`, 404, ErrorCodes.CONFIG_ERROR);
        }

        // 校验当前无活跃妖兽入侵事件
        const existing = await BeastInvasion.findOne({
            where: { status: 'active' }
        });
        if (existing) {
            throw new AppError(
                `已有活跃妖兽入侵事件（ID: ${existing.id}，${existing.beast_name}），不可重复开启`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 计算事件时间窗口
        const cfg = this.getBeastInvasionConfig();
        const donationPhaseMinutes = Number(cfg.donation_phase_minutes) || 30;
        const battlePhaseMinutes = Number(cfg.battle_phase_minutes) || 60;

        // 若调用方指定 hours，则按比例缩放两个阶段
        let donationMinutes = donationPhaseMinutes;
        let battleMinutes = battlePhaseMinutes;
        if (hours && hours > 0) {
            const totalConfigMinutes = donationPhaseMinutes + battlePhaseMinutes;
            const totalCustomMinutes = hours * 60;
            const scale = totalCustomMinutes / totalConfigMinutes;
            donationMinutes = Math.max(1, Math.floor(donationPhaseMinutes * scale));
            battleMinutes = Math.max(1, Math.floor(battlePhaseMinutes * scale));
        }

        const now = new Date();
        const donationEndTime = new Date(now.getTime() + donationMinutes * 60 * 1000);
        const battleEndTime = new Date(donationEndTime.getTime() + battleMinutes * 60 * 1000);

        // 创建妖兽入侵事件
        const invasion = await BeastInvasion.create({
            beast_key: beastKey,
            beast_name: staticData.name,
            realm_rank_min: staticData.realm_rank_min,
            hp_max: BigInt(staticData.base_hp),
            hp_current: BigInt(staticData.base_hp),
            atk: staticData.base_atk,
            def: staticData.base_def,
            speed: staticData.base_speed,
            phase: 'donation',
            donation_target: staticData.donation_target,
            donation_current: 0,
            status: 'active',
            start_time: now,
            donation_end_time: donationEndTime,
            battle_end_time: battleEndTime,
            defeat_time: null,
            killer_player_id: null,
            killer_nickname: null,
            total_damage_taken: 0n,
            total_damage_dealt: 0n,
            participant_count: 0,
            aggregated_battle_log: null,
            season_id: 0
        });

        // 全服公告
        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '妖兽入侵开启',
                content: `${staticData.name} 现世！各位道友速速捐献灵物完成锁灵大阵，否则将深受其害。捐献阶段 ${donationMinutes} 分钟，战斗阶段 ${battleMinutes} 分钟。`,
                priority: 'high'
            });
        } catch (e) {
            console.warn('[BeastInvasionService] 开启公告推送失败:', e.message);
        }

        return {
            success: true,
            invasion_id: invasion.id,
            beast_key: invasion.beast_key,
            beast_name: invasion.beast_name,
            hp_max: bigIntToString(invasion.hp_max),
            donation_target: invasion.donation_target,
            start_time: invasion.start_time,
            donation_end_time: invasion.donation_end_time,
            battle_end_time: invasion.battle_end_time
        };
    }

    /**
     * 获取当前活跃的妖兽入侵事件
     * @returns {Promise<Object|null>} 活跃事件信息，无则返回 null
     */
    static async getActiveInvasion() {
        const invasion = await BeastInvasion.findOne({
            where: { status: 'active' },
            order: [['start_time', 'DESC']]
        });

        if (!invasion) return null;

        const now = new Date();
        return {
            id: invasion.id,
            beast_key: invasion.beast_key,
            beast_name: invasion.beast_name,
            realm_rank_min: invasion.realm_rank_min,
            hp_current: bigIntToString(invasion.hp_current),
            hp_max: bigIntToString(invasion.hp_max),
            hp_percentage: Number((safeBigInt(invasion.hp_current) * 100n) / (safeBigInt(invasion.hp_max) || 1n)),
            atk: invasion.atk,
            def: invasion.def,
            speed: invasion.speed,
            phase: invasion.phase,
            status: invasion.status,
            donation_target: invasion.donation_target,
            donation_current: invasion.donation_current,
            donation_percentage: invasion.donation_target > 0
                ? Math.min(100, Number((invasion.donation_current * 100) / invasion.donation_target))
                : 0,
            start_time: invasion.start_time,
            donation_end_time: invasion.donation_end_time,
            battle_end_time: invasion.battle_end_time,
            defeat_time: invasion.defeat_time,
            killer_player_id: invasion.killer_player_id,
            killer_nickname: invasion.killer_nickname,
            participant_count: invasion.participant_count,
            total_damage_taken: bigIntToString(invasion.total_damage_taken),
            total_damage_dealt: bigIntToString(invasion.total_damage_dealt),
            // 距离阶段切换/结束的剩余秒数
            countdown_seconds: invasion.phase === 'donation'
                ? Math.max(0, Math.floor((new Date(invasion.donation_end_time) - now) / 1000))
                : Math.max(0, Math.floor((new Date(invasion.battle_end_time) - now) / 1000)),
            server_time: now.toISOString()
        };
    }

    /**
     * 获取妖兽入侵事件详情
     * @param {number} invasionId - 事件ID
     * @returns {Promise<Object>} 事件详情
     */
    static async getInvasionDetail(invasionId) {
        if (!invasionId) {
            throw new AppError('事件ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const invasion = await BeastInvasion.findByPk(invasionId);
        if (!invasion) {
            throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 读取静态配置（含技能表/奖励池）
        const staticData = this.getBeastStaticData(invasion.beast_key);

        const now = new Date();
        return {
            invasion: {
                id: invasion.id,
                beast_key: invasion.beast_key,
                beast_name: invasion.beast_name,
                realm_rank_min: invasion.realm_rank_min,
                hp_current: bigIntToString(invasion.hp_current),
                hp_max: bigIntToString(invasion.hp_max),
                hp_percentage: Number((safeBigInt(invasion.hp_current) * 100n) / (safeBigInt(invasion.hp_max) || 1n)),
                atk: invasion.atk,
                def: invasion.def,
                speed: invasion.speed,
                phase: invasion.phase,
                status: invasion.status,
                donation_target: invasion.donation_target,
                donation_current: invasion.donation_current,
                donation_percentage: invasion.donation_target > 0
                    ? Math.min(100, Number((invasion.donation_current * 100) / invasion.donation_target))
                    : 0,
                start_time: invasion.start_time,
                donation_end_time: invasion.donation_end_time,
                battle_end_time: invasion.battle_end_time,
                defeat_time: invasion.defeat_time,
                killer_player_id: invasion.killer_player_id,
                killer_nickname: invasion.killer_nickname,
                total_damage_taken: bigIntToString(invasion.total_damage_taken),
                total_damage_dealt: bigIntToString(invasion.total_damage_dealt),
                participant_count: invasion.participant_count,
                aggregated_battle_log: invasion.aggregated_battle_log,
                season_id: invasion.season_id
            },
            // 妖兽静态描述与技能
            description: staticData?.description || '',
            skills: staticData?.skills || [],
            // 距离阶段切换/结束的剩余秒数
            countdown_seconds: invasion.status === 'active'
                ? (invasion.phase === 'donation'
                    ? Math.max(0, Math.floor((new Date(invasion.donation_end_time) - now) / 1000))
                    : Math.max(0, Math.floor((new Date(invasion.battle_end_time) - now) / 1000)))
                : 0,
            server_time: now.toISOString()
        };
    }

    // =========================================================================
    // 捐献阶段层
    // =========================================================================

    /**
     * 玩家捐献物品到锁灵大阵
     *
     * 流程：
     *   1. 校验事件存在且 phase=donation
     *   2. 校验物品在 donation_items 配置列表中
     *   3. 校验玩家持有该物品足够数量
     *   4. 事务：扣减玩家物品 + 创建捐献记录 + 累加 donation_current
     *   5. 检查是否达到 donation_target，达到则自动切换到战斗阶段
     *   6. 推送 WebSocket 通知
     *
     * @param {number} playerId - 玩家ID
     * @param {number} invasionId - 事件ID
     * @param {string} itemKey - 物品配置键
     * @param {number} quantity - 捐献数量
     * @returns {Promise<Object>} 捐献结果
     */
    static async contribute(playerId, invasionId, itemKey, quantity) {
        // 参数校验
        if (!playerId || !invasionId) {
            throw new AppError('玩家ID与事件ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        if (!itemKey || typeof itemKey !== 'string') {
            throw new AppError('物品配置键不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }
        const qty = parseInt(quantity, 10);
        if (isNaN(qty) || qty <= 0) {
            throw new AppError('捐献数量必须为正整数', 400, ErrorCodes.VALIDATION_ERROR);
        }
        // 上限校验：单次最多 10000 件，防止恶意大数值
        if (qty > 10000) {
            throw new AppError('单次捐献数量不能超过 10000', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 校验事件状态
        const invasion = await BeastInvasion.findByPk(invasionId);
        if (!invasion) {
            throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
        }
        if (invasion.status !== 'active') {
            throw new AppError(`事件已结束（${invasion.status}），不可捐献`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        if (invasion.phase !== 'donation') {
            throw new AppError('当前为战斗阶段，不可捐献', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }
        // 捐献阶段超时校验（防止调度器未及时清理时玩家继续捐献）
        if (new Date(invasion.donation_end_time) < new Date()) {
            throw new AppError('捐献阶段已结束', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 校验物品在 donation_items 配置中
        const staticData = this.getBeastStaticData(invasion.beast_key);
        if (!staticData) {
            throw new AppError(`妖兽静态配置缺失：${invasion.beast_key}`, 500, ErrorCodes.CONFIG_ERROR);
        }
        const donationItemCfg = (staticData.donation_items || []).find(i => i.item_key === itemKey);
        if (!donationItemCfg) {
            throw new AppError(
                `物品 ${itemKey} 不在锁灵大阵所需物品列表中`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 开启事务：扣减玩家物品 + 创建捐献记录 + 累加 donation_current
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
            if (player.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 行级锁物品记录
            // 修复（2026-07-21）：灵石作为特殊货币存储在 player.spirit_stones 字段（BIGINT），
            // 不在 player_items 表中。原代码统一查 Item 表导致灵石捐献永远失败。
            // 现根据 itemKey 区分处理：spirit_stone 走 player.spirit_stones，其他走 Item 表
            if (itemKey === 'spirit_stone') {
                const playerStones = safeBigInt(player.spirit_stones);
                const requiredStones = BigInt(qty);
                if (playerStones < requiredStones) {
                    await t.commit();
                    throw new AppError(
                        `灵石持有量不足（需要 ${qty}，持有 ${playerStones.toString()}）`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
                // 扣减灵石
                player.spirit_stones = playerStones - requiredStones;
                await player.save({ transaction: t });
            } else {
                // 其他物品从 player_items 表扣减
                const itemRecord = await Item.findOne({
                    where: { player_id: playerId, item_key: itemKey },
                    transaction: t,
                    lock: t.LOCK.UPDATE
                });
                if (!itemRecord || itemRecord.quantity < qty) {
                    await t.commit();
                    throw new AppError(
                        `物品 ${donationItemCfg.item_name} 持有量不足（需要 ${qty}，持有 ${itemRecord?.quantity || 0}）`,
                        400,
                        ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }

                // 扣减物品
                itemRecord.quantity -= qty;
                if (itemRecord.quantity <= 0) {
                    await itemRecord.destroy({ transaction: t });
                } else {
                    await itemRecord.save({ transaction: t });
                }
            }

            // 计算贡献值
            const contributionValue = qty * (donationItemCfg.contribution_per_unit || 0);

            // 创建捐献记录
            await BeastInvasionDonation.create({
                invasion_id: invasionId,
                player_id: playerId,
                player_nickname: player.nickname,
                item_key: itemKey,
                item_name: donationItemCfg.item_name,
                quantity: qty,
                contribution_value: contributionValue
            }, { transaction: t });

            // 行级锁事件，累加 donation_current
            const lockedInvasion = await BeastInvasion.findByPk(invasionId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!lockedInvasion) {
                await t.rollback();
                throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
            }
            // 二次校验阶段状态（防止并发切换）
            if (lockedInvasion.phase !== 'donation' || lockedInvasion.status !== 'active') {
                await t.rollback();
                throw new AppError('事件状态已变更，捐献失败', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            lockedInvasion.donation_current = (lockedInvasion.donation_current || 0) + contributionValue;
            // 参与人数 +1（若该玩家首次捐献/攻击，简化为不查重，参与数累计允许偏高）
            // 注：精准去重可后续通过聚合查询重算，此处保留简化逻辑
            lockedInvasion.participant_count = (lockedInvasion.participant_count || 0) + 1;

            // 检查是否达到捐献目标 → 自动切换到战斗阶段
            let phaseSwitched = false;
            if (lockedInvasion.donation_current >= lockedInvasion.donation_target) {
                lockedInvasion.phase = 'battle';
                // 战斗阶段时长从配置读取，battle_end_time 重置为当前时间 + battle_phase_minutes
                const cfg = this.getBeastInvasionConfig();
                const battleMinutes = Number(cfg.battle_phase_minutes) || 60;
                lockedInvasion.battle_end_time = new Date(Date.now() + battleMinutes * 60 * 1000);
                phaseSwitched = true;
            }

            await lockedInvasion.save({ transaction: t });
            await t.commit();

            // 推送 WebSocket 通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_invasion_contribute', {
                    invasion_id: invasionId,
                    beast_name: invasion.beast_name,
                    item_key: itemKey,
                    item_name: donationItemCfg.item_name,
                    quantity: qty,
                    contribution_value: contributionValue,
                    donation_current: lockedInvasion.donation_current,
                    donation_target: lockedInvasion.donation_target,
                    phase_switched: phaseSwitched
                });

                if (phaseSwitched) {
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: '锁灵大阵完成',
                        content: `${lockedInvasion.beast_name} 已被锁灵大阵困住！各位道友可使用 .斩妖 进行攻击，战斗阶段已开启。`,
                        priority: 'high'
                    });
                }
            } catch (e) {
                console.warn('[BeastInvasionService] 捐献推送失败:', e.message);
            }

            return {
                success: true,
                invasion_id: invasionId,
                beast_name: invasion.beast_name,
                item_key: itemKey,
                item_name: donationItemCfg.item_name,
                quantity: qty,
                contribution_value: contributionValue,
                donation_current: lockedInvasion.donation_current,
                donation_target: lockedInvasion.donation_target,
                donation_percentage: lockedInvasion.donation_target > 0
                    ? Math.min(100, Number((lockedInvasion.donation_current * 100) / lockedInvasion.donation_target))
                    : 0,
                phase_switched: phaseSwitched,
                new_phase: lockedInvasion.phase
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 查询捐献进度
     * @param {number} invasionId - 事件ID
     * @returns {Promise<Object>} 捐献进度信息
     */
    static async getContributionProgress(invasionId) {
        if (!invasionId) {
            throw new AppError('事件ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const invasion = await BeastInvasion.findByPk(invasionId);
        if (!invasion) {
            throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询各物品的累计捐献量
        const itemAgg = await BeastInvasionDonation.findAll({
            where: { invasion_id: invasionId },
            attributes: [
                'item_key',
                'item_name',
                [sequelize.fn('SUM', sequelize.col('quantity')), 'total_quantity'],
                [sequelize.fn('SUM', sequelize.col('contribution_value')), 'total_contribution']
            ],
            group: ['item_key', 'item_name'],
            raw: true
        });

        // 查询捐献排行榜（按贡献值）
        const topContributors = await BeastInvasionDonation.findAll({
            where: { invasion_id: invasionId },
            attributes: [
                'player_id',
                'player_nickname',
                [sequelize.fn('SUM', sequelize.col('contribution_value')), 'total_contribution'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'donation_count']
            ],
            group: ['player_id', 'player_nickname'],
            order: [[sequelize.literal('total_contribution'), 'DESC']],
            limit: 20,
            raw: true
        });

        return {
            invasion_id: invasionId,
            beast_name: invasion.beast_name,
            donation_target: invasion.donation_target,
            donation_current: invasion.donation_current,
            donation_percentage: invasion.donation_target > 0
                ? Math.min(100, Number((invasion.donation_current * 100) / invasion.donation_target))
                : 0,
            phase: invasion.phase,
            items_breakdown: itemAgg.map(i => ({
                item_key: i.item_key,
                item_name: i.item_name,
                total_quantity: Number(i.total_quantity),
                total_contribution: Number(i.total_contribution)
            })),
            top_contributors: topContributors.map((c, idx) => ({
                rank: idx + 1,
                player_id: c.player_id,
                player_nickname: c.player_nickname,
                total_contribution: Number(c.total_contribution),
                donation_count: Number(c.donation_count)
            }))
        };
    }

    /**
     * 查询玩家自己的捐献记录
     * @param {number} playerId - 玩家ID
     * @param {number} invasionId - 事件ID
     * @returns {Promise<Object>} 玩家捐献信息
     */
    static async getPlayerContribution(playerId, invasionId) {
        if (!playerId || !invasionId) {
            throw new AppError('玩家ID与事件ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const invasion = await BeastInvasion.findByPk(invasionId);
        if (!invasion) {
            throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 查询玩家在该事件中的所有捐献记录
        const records = await BeastInvasionDonation.findAll({
            where: { invasion_id: invasionId, player_id: playerId },
            order: [['created_at', 'DESC']]
        });

        // 聚合统计
        const totalContribution = records.reduce((sum, r) => sum + (r.contribution_value || 0), 0);
        const totalQuantity = records.reduce((sum, r) => sum + (r.quantity || 0), 0);

        // 按物品聚合
        const itemAgg = {};
        for (const r of records) {
            if (!itemAgg[r.item_key]) {
                itemAgg[r.item_key] = {
                    item_key: r.item_key,
                    item_name: r.item_name,
                    total_quantity: 0,
                    total_contribution: 0
                };
            }
            itemAgg[r.item_key].total_quantity += r.quantity;
            itemAgg[r.item_key].total_contribution += r.contribution_value;
        }

        return {
            invasion_id: invasionId,
            beast_name: invasion.beast_name,
            player_id: playerId,
            total_contribution: totalContribution,
            total_quantity: totalQuantity,
            donation_count: records.length,
            items_breakdown: Object.values(itemAgg),
            recent_records: records.slice(0, 20).map(r => ({
                id: r.id,
                item_key: r.item_key,
                item_name: r.item_name,
                quantity: r.quantity,
                contribution_value: r.contribution_value,
                created_at: r.created_at
            }))
        };
    }

    // =========================================================================
    // 战斗阶段层
    // =========================================================================

    /**
     * 攻击妖兽（核心战斗逻辑）
     *
     * 流程：
     *   1. 状态机互斥校验（IN_BEAST_INVASION 与其他 exclusive 状态互斥）
     *   2. 开启事务，行级锁妖兽 + 玩家
     *   3. 妖兽状态校验（必须 phase=battle 且 status=active）
     *   4. 攻击CD校验（默认10秒，基于 BeastInvasionAttack 最近一条记录的 createdAt）
     *   5. 玩家"妖兽战死亡"状态校验（需先复活才能继续攻击）
     *   6. 计算单次伤害（与 WorldBossService 公式一致）
     *   7. 妖兽 HP 扣减，记录攻击流水
     *   8. 妖兽反击（counter_rate 概率触发，counter_damage_multiplier 倍率）
     *      玩家 battleHp 扣减，检查死亡
     *   9. 聚合战报：每 aggregation_window_ms 推送一次
     *  10. 检查妖兽是否被击杀，若是触发结算
     *  11. 推送 WebSocket 通知
     *
     * @param {number} playerId - 攻击玩家ID
     * @param {number} invasionId - 事件ID
     * @param {Object} [options={}] - 攻击选项
     * @param {string} [options.skill_id='basic'] - 技能ID（basic/skill/ultimate）
     * @returns {Promise<Object>} 攻击结果
     */
    static async attackBeast(playerId, invasionId, options = {}) {
        const cfg = this.getBeastInvasionConfig();

        // 全局开关
        if (cfg.enabled === false) {
            throw new AppError('妖兽入侵系统未开启', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 参数校验
        if (!playerId || !invasionId) {
            throw new AppError('玩家ID与事件ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        // 状态机互斥校验：IN_BEAST_INVASION 与一切 exclusive 状态互斥
        const activeStates = await PlayerStateMachine.getActiveStates(playerId);
        const hasOtherExclusive = activeStates.some(s =>
            s.stateEnum !== PlayerStateMachine.PlayerState.IN_BEAST_INVASION &&
            s.stateEnum !== PlayerStateMachine.PlayerState.IDLE
        );
        if (hasOtherExclusive) {
            const conflict = activeStates.find(s =>
                s.stateEnum !== PlayerStateMachine.PlayerState.IN_BEAST_INVASION
            );
            throw new AppError(
                `${conflict?.displayName || '当前状态'}中，无法斩妖`,
                400,
                ErrorCodes.BUSINESS_LOGIC_ERROR
            );
        }

        // 战斗运行时状态校验：玩家是否处于"妖兽战死亡"状态（需先复活）
        const runtimeKey = `${invasionId}:${playerId}`;
        const runtime = this._battleRuntime.get(runtimeKey);
        if (runtime?.isDead) {
            throw new AppError('已在妖兽战中陨落，请原地复活或撤退', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // 攻击次数上限校验（防小号刷参与）
        const maxAttackCount = Number(cfg.max_attack_count_per_battle) || 100;
        if (runtime?.attackCount >= maxAttackCount) {
            throw new AppError(`已达本场妖兽战攻击次数上限（${maxAttackCount} 次），请等待事件结束`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        // ========== 开启事务，行级锁妖兽 + 玩家 ==========
        const t = await sequelize.transaction();
        try {
            // 行级锁妖兽
            const invasion = await BeastInvasion.findByPk(invasionId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!invasion) {
                await t.commit();
                throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
            }

            // 状态校验
            if (invasion.status !== 'active') {
                await t.commit();
                throw new AppError(`事件已结束（${invasion.status}），不可攻击`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (invasion.phase !== 'battle') {
                await t.commit();
                throw new AppError(
                    invasion.phase === 'donation'
                        ? '当前为捐献阶段，需先完成锁灵大阵才能攻击'
                        : '事件已结束，不可攻击',
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }
            // 战斗阶段超时校验
            if (new Date(invasion.battle_end_time) < new Date()) {
                await t.commit();
                throw new AppError('战斗阶段已结束', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
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
                throw new AppError('已身死道消，无法斩妖', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (player.is_banned) {
                await t.commit();
                throw new AppError('账号已封禁', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 境界要求校验
            const minRealmName = this._getMinRealmNameByRank(invasion.realm_rank_min);
            const realmCheck = RealmService.meetsRealmRequirement(player, minRealmName);
            if (!realmCheck.met) {
                await t.commit();
                throw new AppError(
                    `境界不足，需达到推荐境界方可斩妖（${realmCheck.reason}）`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 攻击CD校验：查询玩家最近一次攻击记录的 createdAt
            const attackCooldownSec = Number(cfg.attack_cooldown_seconds) || 10;
            const cooldownThreshold = new Date(Date.now() - attackCooldownSec * 1000);
            const lastAttack = await BeastInvasionAttack.findOne({
                where: {
                    invasion_id: invasionId,
                    player_id: playerId,
                    created_at: { [Op.gt]: cooldownThreshold }
                },
                order: [['created_at', 'DESC']],
                transaction: t
            });
            if (lastAttack) {
                const elapsedSec = (Date.now() - new Date(lastAttack.created_at).getTime()) / 1000;
                const remain = Math.ceil(attackCooldownSec - elapsedSec);
                await t.commit();
                throw new AppError(`攻击冷却中，${remain} 秒后可再次攻击`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // ========== 计算单次伤害（与 WorldBossService 公式一致） ==========
            const attrResult = await AttributeService.calculateFullAttributesAsync(player);
            const finalAttrs = attrResult?.final || {};
            const playerAtk = Number(finalAttrs.atk) || 0;
            const playerDef = Number(finalAttrs.def) || 0;
            const playerHpMax = Number(finalAttrs.hp_max) || 100;

            // 技能倍率
            const skillId = options.skill_id || 'basic';
            const skillMultipliers = { basic: 1.0, skill: 1.5, ultimate: 2.5 };
            const skillMultiplier = skillMultipliers[skillId] || 1.0;

            // 读取妖兽静态配置中的技能表（无配置则按 basic 处理）
            const beastStaticData = this.getBeastStaticData(invasion.beast_key) || {};
            const skills = beastStaticData.skills || [];
            // 简单实现：随机选择一个技能（无冷却管理，cooldown 字段保留以备扩展）
            let selectedSkill = null;
            if (skills.length > 0) {
                selectedSkill = skills[Math.floor(Math.random() * skills.length)];
            }
            const skillDamageMultiplier = selectedSkill?.damage_multiplier || 1.0;
            const skillName = selectedSkill?.name || null;
            // 最终技能倍率 = 玩家技能倍率 × 妖兽技能伤害倍率（如果触发了妖兽技能）
            const combinedSkillMultiplier = skillMultiplier * skillDamageMultiplier;

            // 暴击判定
            const critRate = Number(cfg.crit_rate) || 0.05;
            const critMultiplier = Number(cfg.crit_multiplier) || 1.5;
            const isCrit = Math.random() < critRate;
            const critFactor = isCrit ? critMultiplier : 1.0;

            // 随机浮动（±15%）
            const randomRange = Number(cfg.damage_random_range) || 0.15;
            const randomFactor = 1 + (Math.random() * 2 - 1) * randomRange;

            // 防御减伤（除法曲线，避免伤害断崖式下跌）
            const defReduction = invasion.def / (invasion.def + playerAtk * 2 + 1000);
            const baseDamage = Math.max(1, Math.floor(playerAtk * combinedSkillMultiplier * (1 - defReduction)));

            // 单人挑战伤害比例
            const soloRatio = cfg.single_player_damage_ratio ?? 1.0;

            // 组队加成（同 WorldBossService）
            const minTeamSize = Number(cfg.min_team_size) || 3;
            const teamBonusRatio = Number(cfg.team_bonus_ratio) || 1.1;
            const activeWindowMs = Number(cfg.active_window_ms) || 300000;
            const activeParticipantCount = await BeastInvasionAttack.count({
                where: {
                    invasion_id: invasionId,
                    created_at: { [Op.gte]: new Date(Date.now() - activeWindowMs) }
                },
                distinct: true,
                col: 'player_id',
                transaction: t
            });
            // 当前玩家也计入活跃人数，故 +1
            const totalActiveCount = activeParticipantCount + 1;
            const teamFactor = totalActiveCount >= minTeamSize ? teamBonusRatio : 1.0;

            // 境界压制加成
            const playerRealmRank = player.realm_rank || 1;
            const beastRealmRankMin = invasion.realm_rank_min || 1;
            const realmSuppressionPerRank = Number(cfg.realm_suppression_per_rank) || 0.05;
            const realmSuppression = 1 + Math.max(0, (playerRealmRank - beastRealmRankMin) * realmSuppressionPerRank);

            // 最终伤害组装
            const finalDamage = Math.floor(
                baseDamage * soloRatio * teamFactor * realmSuppression * critFactor * randomFactor
            );

            // ========== 妖兽 HP 扣减 ==========
            const beastHpBefore = safeBigInt(invasion.hp_current);
            const damageBigInt = BigInt(finalDamage);
            let beastHpAfter = beastHpBefore - damageBigInt;
            if (beastHpAfter < 0n) beastHpAfter = 0n;
            invasion.hp_current = beastHpAfter;
            invasion.total_damage_taken = safeBigInt(invasion.total_damage_taken) + damageBigInt;

            // ========== 妖兽反击 ==========
            // counter_rate 概率触发，counter_damage_multiplier 倍率
            // 玩家 battleHp = playerHpMax * player_hp_multiplier（虚拟 HP，不影响真实 HP）
            let runtimeState = this._battleRuntime.get(runtimeKey);
            if (!runtimeState) {
                const playerHpMultiplier = Number(cfg.player_hp_multiplier) || 3.0;
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
            const playerHpBefore = runtimeState.battleHp;

            // 妖兽反击计算
            const counterRate = Number(beastStaticData.counter_rate) || 0.4;
            const counterDamageMultiplier = Number(beastStaticData.counter_damage_multiplier) || 0.6;
            let counterDamage = 0;
            let playerDied = false;
            let playerHpAfter = playerHpBefore;

            if (Math.random() < counterRate) {
                // 反击伤害计算（与 WorldBossService 反击公式一致）
                const counterDefReduction = playerDef / (playerDef + invasion.atk * 2 + 1000);
                counterDamage = Math.floor(
                    invasion.atk * (1 - counterDefReduction) * counterDamageMultiplier * randomFactor
                );
                const counterDamageBigInt = BigInt(counterDamage);
                playerHpAfter = playerHpBefore - counterDamageBigInt;
                if (playerHpAfter <= 0n) {
                    playerHpAfter = 0n;
                    playerDied = true;
                    runtimeState.isDead = true;
                    runtimeState.deathCount += 1;
                    // 死亡修为惩罚（同 WorldBossService）
                    this._applyDeathExpPenalty(player, Number(cfg.death_exp_penalty_rate) || 0.05);
                    invasion.total_damage_dealt = safeBigInt(invasion.total_damage_dealt) + counterDamageBigInt;
                } else {
                    invasion.total_damage_dealt = safeBigInt(invasion.total_damage_dealt) + counterDamageBigInt;
                }
                runtimeState.battleHp = playerHpAfter;
            }

            // ========== 创建攻击记录 ==========
            await BeastInvasionAttack.create({
                invasion_id: invasionId,
                player_id: playerId,
                player_nickname: player.nickname,
                player_realm: player.realm,
                damage: damageBigInt,
                is_critical: isCrit,
                counter_damage: counterDamage,
                beast_hp_before: beastHpBefore,
                beast_hp_after: beastHpAfter,
                skill_used: skillName
            }, { transaction: t });

            // 参与人数累加（简化：每次新玩家攻击都 +1，可能偏高）
            // 此处通过查询去重数量重算以保证准确
            const distinctParticipants = await BeastInvasionAttack.count({
                where: { invasion_id: invasionId },
                distinct: true,
                col: 'player_id',
                transaction: t
            });
            const distinctDonators = await BeastInvasionDonation.count({
                where: { invasion_id: invasionId },
                distinct: true,
                col: 'player_id',
                transaction: t
            });
            // 取两者并集的最大值（近似，避免双计）
            invasion.participant_count = Math.max(distinctParticipants, distinctDonators);

            // ========== 检查妖兽是否被击杀 ==========
            let beastDefeated = false;
            let settleResult = null;
            if (beastHpAfter <= 0n) {
                beastDefeated = true;
                invasion.status = 'defeated';
                invasion.phase = 'ended';
                invasion.defeat_time = new Date();
                invasion.killer_player_id = playerId;
                invasion.killer_nickname = player.nickname;
                settleResult = await this._settleDefeat(invasionId, playerId, t);
            }

            await invasion.save({ transaction: t });
            await player.save({ transaction: t });
            await t.commit();

            // 大五行幻世轮：妖兽入侵击杀后终结者自动积累悟印（未装备时静默返回）
            // 仅对终结者调用，与WorldBoss同策略，避免每个参与者都触发导致每日上限被快速用完
            if (beastDefeated) {
                await ArtifactDeepLineService.safeAddInsightExp(player.id, {
                    battle_type: 'pve',
                    is_win: true
                });
            }

            // ========== 聚合战报推送（事务外，按时间窗口节流） ==========
            const aggregationWindowMs = Number(cfg.aggregation_window_ms) || 30000;
            const lastPush = this._lastAggregationPush.get(invasionId) || 0;
            if (Date.now() - lastPush >= aggregationWindowMs || beastDefeated) {
                this._lastAggregationPush.set(invasionId, Date.now());
                // 异步更新聚合战报（不阻塞主响应）
                this._updateAggregatedBattleLog(invasionId).catch(e => {
                    console.warn('[BeastInvasionService] 聚合战报更新失败:', e.message);
                });
            }

            // ========== 异步推送 WebSocket 通知 ==========
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_invasion_attack', {
                    invasion_id: invasionId,
                    beast_name: invasion.beast_name,
                    damage_dealt: finalDamage,
                    is_crit: isCrit,
                    counter_damage: counterDamage,
                    battle_hp: bigIntToString(runtimeState.battleHp),
                    battle_hp_max: bigIntToString(runtimeState.battleHpMax),
                    is_dead: playerDied,
                    beast_defeated: beastDefeated,
                    skill_used: skillName
                });

                // 全服广播妖兽 HP 更新
                if (invasion.status === 'active') {
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: '妖兽入侵战况',
                        content: `${invasion.beast_name} 剩余血量：${bigIntToString(invasion.hp_current)} / ${bigIntToString(invasion.hp_max)}`,
                        priority: 'normal'
                    });
                }

                if (beastDefeated) {
                    WebSocketNotificationService.sendGlobalAnnouncement({
                        title: '妖兽被斩杀！',
                        content: `${invasion.beast_name} 被 ${player.nickname} 终结！${settleResult?.summary || ''}`,
                        priority: 'high'
                    });
                }
            } catch (e) {
                console.warn('[BeastInvasionService] WebSocket 推送失败:', e.message);
            }

            return {
                attack: {
                    skill_id: skillId,
                    skill_used: skillName,
                    damage: finalDamage,
                    is_crit: isCrit,
                    damage_breakdown: {
                        player_atk: playerAtk,
                        skill_multiplier: skillMultiplier,
                        beast_skill_multiplier: skillDamageMultiplier,
                        combined_skill_multiplier: combinedSkillMultiplier,
                        beast_def: invasion.def,
                        def_reduction: Number(defReduction.toFixed(4)),
                        base_damage: Math.floor(baseDamage),
                        crit_factor: critFactor,
                        random_factor: Number(randomFactor.toFixed(4)),
                        solo_ratio: soloRatio,
                        team_factor: teamFactor,
                        active_participant_count: totalActiveCount,
                        realm_suppression: Number(realmSuppression.toFixed(4)),
                        player_realm_rank: playerRealmRank,
                        beast_realm_rank_min: beastRealmRankMin,
                        final_damage: finalDamage
                    }
                },
                beast: {
                    id: invasion.id,
                    name: invasion.beast_name,
                    hp_before: bigIntToString(beastHpBefore),
                    hp_after: bigIntToString(beastHpAfter),
                    hp_current: bigIntToString(invasion.hp_current),
                    hp_max: bigIntToString(invasion.hp_max),
                    hp_percentage: Number((safeBigInt(invasion.hp_current) * 100n) / (safeBigInt(invasion.hp_max) || 1n)),
                    status: invasion.status,
                    defeated: beastDefeated
                },
                counter: {
                    triggered: counterDamage > 0,
                    damage: counterDamage,
                    counter_rate: counterRate,
                    counter_damage_multiplier: counterDamageMultiplier
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
                timestamp: new Date().toISOString()
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 原地复活（消耗灵石，CD 60秒）
     * @param {number} playerId - 玩家ID
     * @param {number} invasionId - 事件ID
     * @returns {Promise<Object>} 复活结果
     */
    static async revive(playerId, invasionId) {
        const cfg = this.getBeastInvasionConfig();
        const runtimeKey = `${invasionId}:${playerId}`;
        const runtime = this._battleRuntime.get(runtimeKey);

        if (!runtime?.isDead) {
            throw new AppError('当前未处于妖兽战陨落状态，无需复活', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const reviveCooldownMs = (Number(cfg.revive_cooldown_seconds) || 60) * 1000;
        if (runtime.lastReviveTime && Date.now() - runtime.lastReviveTime < reviveCooldownMs) {
            const remain = Math.ceil((reviveCooldownMs - (Date.now() - runtime.lastReviveTime)) / 1000);
            throw new AppError(`复活冷却中，${remain} 秒后可再次复活`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
        }

        const reviveCost = BigInt(cfg.revive_cost_spirit_stones || 1000);
        const t = await sequelize.transaction();
        try {
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

            const playerStones = safeBigInt(player.spirit_stones);
            if (playerStones < reviveCost) {
                await t.commit();
                throw new AppError(
                    `灵石不足，原地复活需消耗 ${reviveCost.toString()} 灵石`,
                    400,
                    ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            player.spirit_stones = playerStones - reviveCost;
            await player.save({ transaction: t });
            await t.commit();

            runtime.battleHp = runtime.battleHpMax;
            runtime.isDead = false;
            runtime.lastReviveTime = Date.now();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_invasion_revive', {
                    invasion_id: invasionId,
                    battle_hp: bigIntToString(runtime.battleHp),
                    battle_hp_max: bigIntToString(runtime.battleHpMax),
                    spirit_stone_cost: reviveCost.toString(),
                    spirit_stones_remaining: bigIntToString(player.spirit_stones)
                });
            } catch (e) {
                console.warn('[BeastInvasionService] 复活推送失败:', e.message);
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
     * 撤退（退出妖兽战，5分钟内不能再进入）
     * @param {number} playerId - 玩家ID
     * @param {number} invasionId - 事件ID
     * @returns {Promise<Object>} 撤退结果
     */
    static async retreat(playerId, invasionId) {
        const cfg = this.getBeastInvasionConfig();
        const runtimeKey = `${invasionId}:${playerId}`;
        const runtime = this._battleRuntime.get(runtimeKey);

        // 撤退禁入CD：5 分钟
        const retreatCooldownSec = (Number(cfg.attack_cooldown_seconds) || 10) * 60;
        const lastRetreatTime = Date.now();

        if (!runtime) {
            // runtime 不存在但状态机可能仍认为玩家在妖兽战中（服务重启场景）
            // 通过清理最近的攻击记录时间戳让状态机释放玩家
            const activeWindowMs = Number(cfg.active_window_ms) || 300000;
            try {
                await BeastInvasionAttack.update(
                    { created_at: new Date(Date.now() - (activeWindowMs + 60000)) },
                    { where: { player_id: playerId, invasion_id: invasionId } }
                );
            } catch (e) {
                console.warn('[BeastInvasionService] 清理攻击记录时间戳失败:', e.message);
            }
        } else {
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

            // 同时清理攻击记录的 created_at，让状态机立即释放玩家
            try {
                const activeWindowMs = Number(cfg.active_window_ms) || 300000;
                await BeastInvasionAttack.update(
                    { created_at: new Date(Date.now() - (activeWindowMs + 60000)) },
                    { where: { player_id: playerId, invasion_id: invasionId } }
                );
            } catch (e) {
                console.warn('[BeastInvasionService] 清理攻击记录时间戳失败:', e.message);
            }
        }

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

        try {
            WebSocketNotificationService.notifyPlayerUpdate(playerId, 'beast_invasion_retreat', {
                invasion_id: invasionId,
                cooldown_seconds: retreatCooldownSec,
                next_available_at: new Date(lastRetreatTime + retreatCooldownSec * 1000).toISOString()
            });
        } catch (e) {
            console.warn('[BeastInvasionService] 撤退推送失败:', e.message);
        }

        return {
            success: true,
            message: '已撤退，5分钟内无法再次挑战此妖兽',
            cooldown_seconds: retreatCooldownSec,
            next_available_at: new Date(lastRetreatTime + retreatCooldownSec * 1000).toISOString()
        };
    }

    // =========================================================================
    // 排行与查询层
    // =========================================================================

    /**
     * 获取伤害排行
     * @param {number} invasionId - 事件ID
     * @param {number} [limit=100] - 返回条数上限
     * @returns {Promise<Object>} 排行榜数据
     */
    static async getAttackRanking(invasionId, limit = 100) {
        const maxLimit = Math.min(Math.max(1, Number(limit) || 100), 500);

        const invasion = await BeastInvasion.findByPk(invasionId);
        if (!invasion) {
            throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
        }

        // 按玩家聚合伤害（注：本表为流水明细，需 SUM 聚合得到玩家累计伤害）
        const records = await BeastInvasionAttack.findAll({
            where: { invasion_id: invasionId },
            attributes: [
                'player_id',
                'player_nickname',
                'player_realm',
                [sequelize.fn('SUM', sequelize.col('damage')), 'total_damage'],
                [sequelize.fn('COUNT', sequelize.col('id')), 'attack_count'],
                [sequelize.fn('MAX', sequelize.col('damage')), 'best_single_damage'],
                [sequelize.fn('SUM', sequelize.col('counter_damage')), 'total_counter_damage']
            ],
            group: ['player_id', 'player_nickname', 'player_realm'],
            order: [[sequelize.literal('total_damage'), 'DESC']],
            limit: maxLimit,
            raw: true
        });

        const totalDamageTaken = safeBigInt(invasion.total_damage_taken);

        return {
            invasion_id: invasionId,
            beast_name: invasion.beast_name,
            total_damage_taken: bigIntToString(totalDamageTaken),
            ranking: records.map((r, idx) => ({
                rank: idx + 1,
                player_id: r.player_id,
                player_nickname: r.player_nickname,
                player_realm: r.player_realm,
                total_damage: bigIntToString(r.total_damage),
                attack_count: Number(r.attack_count),
                best_single_damage: bigIntToString(r.best_single_damage),
                total_counter_damage: Number(r.total_counter_damage),
                damage_percentage: totalDamageTaken > 0n
                    ? Number((safeBigInt(r.total_damage) * 10000n) / totalDamageTaken) / 100
                    : 0
            }))
        };
    }

    /**
     * 获取帮助信息（妖兽入侵玩法说明）
     * @param {number} [invasionId=null] - 事件ID（可选，传入则包含当前事件信息）
     * @returns {Promise<Object>} 帮助信息
     */
    static async getHelp(invasionId = null) {
        let currentInvasion = null;
        if (invasionId) {
            try {
                currentInvasion = await this.getInvasionDetail(invasionId);
            } catch (e) {
                // 事件不存在时静默处理，仅返回通用帮助
            }
        }

        return {
            title: '妖兽入侵玩法说明',
            content: [
                '【第一阶段·捐献】',
                '使用 .贡献 <物品名> <数量> 捐献灵物，完成锁灵大阵。',
                '可捐献物品：灵石（1贡献/个）、灵草（5贡献/个）、妖丹（50贡献/个）。',
                '捐献值达到目标后自动切换到战斗阶段。',
                '使用 .贡献查询 查看捐献进度。',
                '',
                '【第二阶段·战斗】',
                '使用 .斩妖 攻击妖兽，每次攻击有冷却（默认10秒）。',
                '妖兽会反击，玩家虚拟HP归零后需复活（消耗灵石，60秒CD）或撤退（5分钟内禁入）。',
                '伤害计算：玩家ATK × 技能倍率 × 防御减伤 × 暴击 × 随机浮动 × 单人比例 × 组队加成 × 境界压制。',
                '境界高于妖兽推荐境界时，每级额外+5%伤害。',
                '',
                '【奖励】',
                '参与奖：所有造成伤害的玩家均可获得（经验+灵石）。',
                'TOP3 奖：伤害排行前3的玩家获得银色妖兽令+大量经验灵石。',
                'TOP10 奖：伤害排行前10的玩家获得铜色妖兽令+经验灵石。',
                '终结奖：最后一击击杀妖兽的玩家获得金色妖兽令+海量经验灵石。',
                '使用 .妖兽入侵奖励 查看当期奖励池详情。',
                '',
                '【聚合战报】',
                '战斗阶段每30秒推送一次聚合战报，包含所有玩家伤害总和与妖兽HP变化，避免刷屏。'
            ].join('\n'),
            current_invasion: currentInvasion
        };
    }

    /**
     * 获取奖励池说明
     * @param {number} invasionId - 事件ID
     * @returns {Promise<Object>} 奖励池信息
     */
    static async getRewardsInfo(invasionId) {
        if (!invasionId) {
            throw new AppError('事件ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const invasion = await BeastInvasion.findByPk(invasionId);
        if (!invasion) {
            throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const staticData = this.getBeastStaticData(invasion.beast_key);
        if (!staticData) {
            throw new AppError(`妖兽静态配置缺失：${invasion.beast_key}`, 500, ErrorCodes.CONFIG_ERROR);
        }

        const rewards = staticData.rewards || {};
        return {
            invasion_id: invasionId,
            beast_name: invasion.beast_name,
            rewards: {
                participation: rewards.participation || { exp: 0, spirit_stones: 0 },
                top_3: rewards.top_3 || { exp: 0, spirit_stones: 0, items: [] },
                top_10: rewards.top_10 || { exp: 0, spirit_stones: 0, items: [] },
                killer: rewards.killer || { exp: 0, spirit_stones: 0, items: [] }
            },
            // 奖励计算说明
            reward_rules: {
                participation: '所有造成伤害的玩家均可获得参与奖（按伤害比例分配）',
                top_3: '伤害排行前3的玩家在参与奖基础上额外获得',
                top_10: '伤害排行前10的玩家在参与奖基础上额外获得',
                killer: '最后一击击杀妖兽的玩家额外获得',
                realm_multiplier: '奖励数值会应用境界加成倍率（1.0 + (realm_rank - 1) × 0.1）'
            }
        };
    }

    // =========================================================================
    // 过期与结算层
    // =========================================================================

    /**
     * 检查妖兽入侵事件是否过期（由调度器周期调用）
     * 处理：
     *   1. 捐献阶段超时未达标 → status=expired
     *   2. 战斗阶段超时未击杀 → status=escaped
     * @returns {Promise<Object>} 检查结果 { expired_count, escaped_count }
     */
    static async checkExpired() {
        const now = new Date();
        const result = { expired_count: 0, escaped_count: 0 };

        // 查询所有 active 状态的事件
        const activeInvasions = await BeastInvasion.findAll({
            where: { status: 'active' }
        });

        for (const invasion of activeInvasions) {
            try {
                if (invasion.phase === 'donation' && new Date(invasion.donation_end_time) < now) {
                    // 捐献阶段超时
                    // 但若已达标则切换到战斗阶段（兜底）
                    if (invasion.donation_current >= invasion.donation_target) {
                        await this._switchToBattlePhase(invasion);
                    } else {
                        await this._settleExpire(invasion);
                        result.expired_count += 1;
                    }
                } else if (invasion.phase === 'battle' && new Date(invasion.battle_end_time) < now) {
                    // 战斗阶段超时
                    await this._settleEscape(invasion);
                    result.escaped_count += 1;
                }
            } catch (err) {
                console.error(`[BeastInvasionService] 事件 ${invasion.id} 过期检查失败:`, err.message);
            }
        }

        return result;
    }

    /**
     * 强制结束事件（管理员调用）
     * @param {number} invasionId - 事件ID
     * @returns {Promise<Object>} 结束结果
     */
    static async expireInvasion(invasionId) {
        if (!invasionId) {
            throw new AppError('事件ID不能为空', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const invasion = await BeastInvasion.findByPk(invasionId, {
                lock: t.LOCK.UPDATE,
                transaction: t
            });
            if (!invasion) {
                await t.commit();
                throw new AppError('妖兽入侵事件不存在', 404, ErrorCodes.NOT_FOUND);
            }
            if (invasion.status !== 'active') {
                await t.commit();
                throw new AppError(`事件当前状态 ${invasion.status}，不可强制结束`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            invasion.status = 'expired';
            invasion.phase = 'ended';
            await invasion.save({ transaction: t });
            await t.commit();

            // 清理所有玩家的 runtime 状态
            this._cleanupRuntimeByInvasionId(invasionId);

            try {
                WebSocketNotificationService.sendGlobalAnnouncement({
                    title: '妖兽入侵事件已结束',
                    content: `${invasion.beast_name} 入侵事件已被管理员强制结束`,
                    priority: 'normal'
                });
            } catch (e) {
                console.warn('[BeastInvasionService] 强制结束公告推送失败:', e.message);
            }

            return {
                success: true,
                invasion_id: invasionId,
                beast_name: invasion.beast_name,
                status: 'expired'
            };
        } catch (err) {
            if (!t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 切换到战斗阶段（捐献达标时调用）
     * @param {Object} invasion - 事件实例（已加锁）
     * @param {Object} [t=null] - 事务实例
     * @private
     */
    static async _switchToBattlePhase(invasion, t = null) {
        const cfg = this.getBeastInvasionConfig();
        const battleMinutes = Number(cfg.battle_phase_minutes) || 60;
        invasion.phase = 'battle';
        invasion.battle_end_time = new Date(Date.now() + battleMinutes * 60 * 1000);
        await invasion.save({ transaction: t });

        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '锁灵大阵完成',
                content: `${invasion.beast_name} 已被锁灵大阵困住！战斗阶段已开启，时长 ${battleMinutes} 分钟。`,
                priority: 'high'
            });
        } catch (e) {
            console.warn('[BeastInvasionService] 阶段切换公告推送失败:', e.message);
        }
    }

    /**
     * 捐献阶段超时结算（妖兽自行散去）
     * @param {Object} invasion - 事件实例
     * @private
     */
    static async _settleExpire(invasion) {
        invasion.status = 'expired';
        invasion.phase = 'ended';
        await invasion.save();

        // 清理 runtime
        this._cleanupRuntimeByInvasionId(invasion.id);

        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '妖兽入侵结束',
                content: `${invasion.beast_name} 因锁灵大阵未能完成而散去，捐献进度 ${invasion.donation_current}/${invasion.donation_target}`,
                priority: 'normal'
            });
        } catch (e) {
            console.warn('[BeastInvasionService] 过期公告推送失败:', e.message);
        }
    }

    /**
     * 战斗阶段超时结算（妖兽逃脱）
     * @param {Object} invasion - 事件实例
     * @private
     */
    static async _settleEscape(invasion) {
        invasion.status = 'escaped';
        invasion.phase = 'ended';
        await invasion.save();

        // 清理 runtime
        this._cleanupRuntimeByInvasionId(invasion.id);

        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '妖兽逃脱',
                content: `${invasion.beast_name} 在战斗阶段结束未被斩杀，已破阵逃脱！剩余血量 ${bigIntToString(invasion.hp_current)} / ${bigIntToString(invasion.hp_max)}`,
                priority: 'high'
            });
        } catch (e) {
            console.warn('[BeastInvasionService] 逃脱公告推送失败:', e.message);
        }
    }

    /**
     * 妖兽被击杀结算（事务内完成所有结算）
     * 包含：
     *   1. 最后一击奖励（终结者）
     *   2. 伤害档位奖励（top_3 / top_10 / participation）
     *   3. 奖励数值应用境界加成倍率（1.0 + (realm_rank - 1) × 0.1）
     *
     * @param {number} invasionId - 事件ID
     * @param {number} killerPlayerId - 最后一击玩家ID
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} 结算摘要
     * @private
     */
    static async _settleDefeat(invasionId, killerPlayerId, t) {
        const invasion = await BeastInvasion.findByPk(invasionId, { transaction: t });
        if (!invasion) return { summary: '事件不存在，结算失败' };

        const staticData = this.getBeastStaticData(invasion.beast_key);
        const rewards = staticData?.rewards || {};
        const summary = [];

        // ===== 1. 最后一击奖励 =====
        const killerReward = rewards.killer || { exp: 0, spirit_stones: 0, items: [] };
        const killerPlayer = await Player.findByPk(killerPlayerId, {
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (killerPlayer) {
            const realmMultiplier = this._getRealmMultiplier(killerPlayer);
            const finalExp = Math.floor((killerReward.exp || 0) * realmMultiplier);
            const finalStones = Math.floor((killerReward.spirit_stones || 0) * realmMultiplier);
            killerPlayer.exp = safeBigInt(killerPlayer.exp) + BigInt(finalExp);
            killerPlayer.spirit_stones = safeBigInt(killerPlayer.spirit_stones) + BigInt(finalStones);
            await killerPlayer.save({ transaction: t });
            // 发放物品奖励
            if (killerReward.items && killerReward.items.length > 0) {
                for (const itemKey of killerReward.items) {
                    try {
                        await InventoryService.addItem(killerPlayerId, itemKey, 1, t);
                    } catch (e) {
                        console.warn(`[BeastInvasionService] 终结者物品发放失败 ${itemKey}:`, e.message);
                    }
                }
            }
            summary.push(`终结者 ${killerPlayer.nickname} 获得 ${finalExp} 修为 + ${finalStones} 灵石 + ${(killerReward.items || []).join(',')} `);
        }

        // ===== 2. 伤害档位奖励 =====
        // 查询所有参战玩家伤害排行
        const damageRanking = await BeastInvasionAttack.findAll({
            where: { invasion_id: invasionId },
            attributes: [
                'player_id',
                'player_nickname',
                [sequelize.fn('SUM', sequelize.col('damage')), 'total_damage']
            ],
            group: ['player_id', 'player_nickname'],
            order: [[sequelize.literal('total_damage'), 'DESC']],
            transaction: t,
            raw: true
        });

        const participationReward = rewards.participation || { exp: 0, spirit_stones: 0 };
        const top3Reward = rewards.top_3 || { exp: 0, spirit_stones: 0, items: [] };
        const top10Reward = rewards.top_10 || { exp: 0, spirit_stones: 0, items: [] };
        const totalDamage = safeBigInt(invasion.total_damage_taken);

        let rewardCount = 0;
        for (let i = 0; i < damageRanking.length; i++) {
            const record = damageRanking[i];
            const rank = i + 1;
            const playerDamage = safeBigInt(record.total_damage);
            if (playerDamage <= 0n) continue;

            const participant = await Player.findByPk(record.player_id, {
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!participant) continue;

            const realmMultiplier = this._getRealmMultiplier(participant);
            // 参与奖按伤害比例分配（基础参与奖 × 伤害占比，最低保底50%）
            const damageShare = totalDamage > 0n
                ? Number(playerDamage) / Number(totalDamage)
                : 1.0;
            const participationExp = Math.floor(participationReward.exp * realmMultiplier * Math.max(0.5, damageShare));
            const participationStones = Math.floor(participationReward.spirit_stones * realmMultiplier * Math.max(0.5, damageShare));

            let bonusExp = 0;
            let bonusStones = 0;
            let bonusItems = [];

            if (rank <= 3) {
                bonusExp = Math.floor((top3Reward.exp || 0) * realmMultiplier);
                bonusStones = Math.floor((top3Reward.spirit_stones || 0) * realmMultiplier);
                bonusItems = top3Reward.items || [];
            } else if (rank <= 10) {
                bonusExp = Math.floor((top10Reward.exp || 0) * realmMultiplier);
                bonusStones = Math.floor((top10Reward.spirit_stones || 0) * realmMultiplier);
                bonusItems = top10Reward.items || [];
            }

            const totalExp = participationExp + bonusExp;
            const totalStones = participationStones + bonusStones;

            participant.exp = safeBigInt(participant.exp) + BigInt(totalExp);
            participant.spirit_stones = safeBigInt(participant.spirit_stones) + BigInt(totalStones);
            await participant.save({ transaction: t });

            // 发放物品奖励
            for (const itemKey of bonusItems) {
                try {
                    await InventoryService.addItem(record.player_id, itemKey, 1, t);
                } catch (e) {
                    console.warn(`[BeastInvasionService] 物品发放失败 ${itemKey} → 玩家 ${record.player_id}:`, e.message);
                }
            }

            rewardCount += 1;
        }

        summary.push(`共 ${rewardCount} 名参与者获得奖励`);

        // 清理所有玩家的 runtime 状态
        this._cleanupRuntimeByInvasionId(invasionId);

        return {
            killer_reward: killerReward,
            participant_count: rewardCount,
            summary: summary.join('；')
        };
    }

    /**
     * 更新聚合战报（每 aggregation_window_ms 调用一次）
     * @param {number} invasionId - 事件ID
     * @private
     */
    static async _updateAggregatedBattleLog(invasionId) {
        const cfg = this.getBeastInvasionConfig();
        const windowMs = Number(cfg.aggregation_window_ms) || 30000;
        const fromTime = new Date(Date.now() - windowMs);

        // 查询窗口内的攻击记录聚合
        const recentAttacks = await BeastInvasionAttack.findAll({
            where: {
                invasion_id: invasionId,
                created_at: { [Op.gte]: fromTime }
            },
            attributes: [
                [sequelize.fn('COUNT', sequelize.col('id')), 'attack_count'],
                [sequelize.fn('SUM', sequelize.col('damage')), 'total_damage'],
                [sequelize.fn('SUM', sequelize.col('counter_damage')), 'total_counter_damage'],
                [sequelize.fn('COUNT', sequelize.literal('DISTINCT player_id')), 'participant_count']
            ],
            raw: true
        });

        const agg = recentAttacks[0] || {};
        const invasion = await BeastInvasion.findByPk(invasionId);
        if (!invasion) return;

        // 构建聚合战报对象
        const battleLog = {
            window_start: fromTime.toISOString(),
            window_end: new Date().toISOString(),
            attack_count: Number(agg.attack_count) || 0,
            total_damage: bigIntToString(agg.total_damage || 0),
            total_counter_damage: Number(agg.total_counter_damage) || 0,
            participant_count: Number(agg.participant_count) || 0,
            beast_hp_current: bigIntToString(invasion.hp_current),
            beast_hp_max: bigIntToString(invasion.hp_max),
            beast_hp_percentage: Number((safeBigInt(invasion.hp_current) * 100n) / (safeBigInt(invasion.hp_max) || 1n))
        };

        invasion.aggregated_battle_log = battleLog;
        await invasion.save();

        // 推送聚合战报
        try {
            WebSocketNotificationService.sendGlobalAnnouncement({
                title: '妖兽入侵聚合战报',
                content: `最近 ${windowMs / 1000} 秒：${battleLog.attack_count} 次攻击 / ${battleLog.participant_count} 名玩家 / 总伤害 ${battleLog.total_damage} / 妖兽剩余 HP ${battleLog.beast_hp_percentage}%`,
                priority: 'normal'
            });
        } catch (e) {
            console.warn('[BeastInvasionService] 聚合战报推送失败:', e.message);
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
        const attrs = typeof player.attributes === 'string'
            ? JSON.parse(player.attributes)
            : (player.attributes || {});
        const currentExp = Number(attrs.exp) || 0;
        const penalty = Math.floor(currentExp * penaltyRate);
        attrs.exp = Math.max(0, currentExp - penalty);
        player.attributes = attrs;
    }

    /**
     * 计算境界加成倍率（与 AdventureEventService.getRealmMultiplier 一致）
     * 公式：1.0 + (realm_rank - 1) × 0.1
     * @param {Object} player - 玩家对象
     * @returns {number} 境界加成倍率
     * @private
     */
    static _getRealmMultiplier(player) {
        try {
            const rank = Number(player?.realm_rank);
            if (rank > 0) {
                return 1.0 + (rank - 1) * 0.1;
            }
            const realmName = player?.realm;
            if (realmName) {
                const realmConfig = RealmService.getRealmByName(realmName);
                if (realmConfig && realmConfig.rank) {
                    return 1.0 + (realmConfig.rank - 1) * 0.1;
                }
            }
        } catch (e) {
            console.warn('[BeastInvasionService] 获取境界加成失败:', e.message);
        }
        return 1.0;
    }

    /**
     * 通过境界rank 反查境界名称（用于 meetsRealmRequirement 的 minRealmName 参数）
     * @param {number} rank - 境界rank
     * @returns {string} 境界名称，未找到返回空串
     * @private
     */
    static _getMinRealmNameByRank(rank) {
        const realm = RealmService.getRealmByRank(rank);
        return realm?.name || '';
    }

    /**
     * 清理指定妖兽入侵事件的所有 runtime 状态
     * @param {number} invasionId - 事件ID
     * @private
     */
    static _cleanupRuntimeByInvasionId(invasionId) {
        const prefix = `${invasionId}:`;
        for (const key of this._battleRuntime.keys()) {
            if (key.startsWith(prefix)) {
                this._battleRuntime.delete(key);
            }
        }
        this._lastAggregationPush.delete(invasionId);
    }

    /**
     * 列出所有妖兽入侵事件（含历史，管理员用）
     * @param {Object} [filter={}] - 过滤条件
     * @param {string} [filter.status] - 状态过滤
     * @param {number} [filter.limit=20] - 返回条数上限
     * @param {number} [filter.offset=0] - 偏移量
     * @returns {Promise<Object>} 事件列表
     */
    static async listInvasions(filter = {}) {
        const limit = Math.min(Math.max(1, Number(filter.limit) || 20), 100);
        const offset = Math.max(0, Number(filter.offset) || 0);
        const whereClause = {};
        if (['active', 'defeated', 'escaped', 'expired'].includes(filter.status)) {
            whereClause.status = filter.status;
        }

        const { count, rows } = await BeastInvasion.findAndCountAll({
            where: whereClause,
            order: [['id', 'DESC']],
            limit,
            offset
        });

        return {
            total: count,
            limit,
            offset,
            invasions: rows.map(inv => ({
                id: inv.id,
                beast_key: inv.beast_key,
                beast_name: inv.beast_name,
                realm_rank_min: inv.realm_rank_min,
                hp_max: bigIntToString(inv.hp_max),
                hp_current: bigIntToString(inv.hp_current),
                atk: inv.atk,
                def: inv.def,
                phase: inv.phase,
                status: inv.status,
                donation_target: inv.donation_target,
                donation_current: inv.donation_current,
                start_time: inv.start_time,
                donation_end_time: inv.donation_end_time,
                battle_end_time: inv.battle_end_time,
                defeat_time: inv.defeat_time,
                killer_player_id: inv.killer_player_id,
                killer_nickname: inv.killer_nickname,
                total_damage_taken: bigIntToString(inv.total_damage_taken),
                total_damage_dealt: bigIntToString(inv.total_damage_dealt),
                participant_count: inv.participant_count,
                season_id: inv.season_id
            }))
        };
    }
}

module.exports = BeastInvasionService;
