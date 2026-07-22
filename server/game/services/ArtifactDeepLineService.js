/**
 * 法宝深线服务（玩法文档第19节）
 *
 * 提供法宝深线系统的核心业务逻辑，当前实现血魔剑残契线：
 *   1. getBloodSwordStatus：获取血魔剑残契状态（血契阶数/魔染/镇契/铭印/封鞘）
 *   2. bloodSacrifice：祭血推进血契阶数（18h 冷却 + 每周 36 进度上限）
 *   3. suppressBloodSword：镇契降低魔染、提高镇契值
 *   4. thunderWashBloodSword：雷洗用天雷竹/金雷竹强力降魔染（24h 冷却）
 *   5. imprintBloodSword：铭印选择血契或镇契路线（7 天冷却）
 *   6. sheathBloodSword：封鞘 24h 期间不可出战，结束后大幅降魔染提镇契
 *   7. getBloodSwordCombatBonus：供战斗系统调用的战力加成计算
 *
 * 设计原则：
 *   - 所有可变参数从 artifact_deep_lines.json 读取，禁止硬编码
 *   - 多字段变更使用事务 + 行级锁（player + player_equipment）
 *   - 材料消耗通过 InventoryService.removeItem 统一扣减
 *   - WebSocket 推送通过 WebSocketNotificationService.notifyPlayerUpdate
 *   - 路由层不直接调用本服务以外的方法，保持单一入口
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
'use strict';

const sequelize = require('../../config/database');
const PlayerEquipment = require('../../models/playerEquipment');
const Player = require('../../models/player');
const PlayerSect = require('../../models/playerSect');
const InventoryService = require('./InventoryService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const { AppError, ErrorCodes } = require('../../middleware/errorHandler');
const { infrastructure } = require('../../modules');

// 配置加载器：通过 modules/index.js 统一导出，避免循环依赖
const configLoader = infrastructure.ConfigLoader;

/**
 * 默认血魔剑状态（首次访问时初始化）
 * 所有字段含义参见 playerEquipment.js 模型注释
 */
const DEFAULT_BLOOD_SWORD_STATE = {
    blood_pact_stage: 0,            // 血契阶数 0~5
    blood_pact_weekly_progress: 0,  // 本周血契累计进度
    blood_pact_week_reset_at: null, // 周重置日期（YYYY-MM-DD，ISO 周一）
    last_sacrifice_at: null,        // 上次祭血时间（18h 冷却）
    last_thunder_wash_at: null,     // 上次雷洗时间（24h 冷却）
    corruption: 0,                  // 魔染值 0~100
    suppression: 0,                 // 镇契值 0~100
    imprint_type: 'none',           // 铭印类型：none/blood/suppress
    last_imprint_at: null,          // 上次铭印时间（7d 冷却）
    sheath_until: null              // 封鞘截止时间（未到=不可出战）
};

class ArtifactDeepLineService {
    /**
     * 读取法宝深线配置
     * @returns {Object} 法宝深线配置对象
     */
    static getDeepLineConfig() {
        return configLoader.getConfig('artifact_deep_lines')?.settings || {};
    }

    /**
     * 读取血魔剑线配置
     * @returns {Object} 血魔剑线配置
     */
    static getBloodSwordConfig() {
        return this.getDeepLineConfig().blood_sword || {};
    }

    /**
     * 获取血魔剑物品配置（从 item_data.json 读取静态属性）
     * @returns {Object|null} 血魔剑物品配置
     */
    static getBloodSwordItemConfig() {
        const items = configLoader.getConfig('item_data')?.items || [];
        const cfg = this.getBloodSwordConfig();
        return items.find(i => i.id === cfg.item_key) || null;
    }

    /**
     * 获取 ISO 周一日期字符串（YYYY-MM-DD）
     * 用于"每周血契进度上限"的重置判定，周一 0 点为重置点
     * @param {Date} date - 任意日期
     * @returns {string} 该日期所在周的周一日期
     */
    static _getISOWeekStart(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        // getDay() 周日=0，周一=1...周六=6
        // 转换为"距离周一的偏移天数"：周日=6, 周一=0, 周二=1...
        const day = d.getDay();
        const diff = (day === 0 ? 6 : day - 1);
        d.setDate(d.getDate() - diff);
        return d.toISOString().slice(0, 10);
    }

    /**
     * 跨周重置血契进度（若已跨周）
     * @param {Object} state - 血魔剑状态对象（会被原地修改）
     */
    static _resetWeeklyProgressIfNeeded(state) {
        const currentWeekStart = this._getISOWeekStart(new Date());
        if (state.blood_pact_week_reset_at !== currentWeekStart) {
            state.blood_pact_weekly_progress = 0;
            state.blood_pact_week_reset_at = currentWeekStart;
        }
    }

    /**
     * 初始化血魔剑状态（首次访问时创建默认状态）
     * @param {Object} equipment - PlayerEquipment 实例
     * @returns {Object} 初始化后的血魔剑状态
     */
    static _initBloodSwordState(equipment) {
        const deepLine = equipment.deep_line_state || {};
        if (!deepLine.blood_sword) {
            const today = this._getISOWeekStart(new Date());
            deepLine.blood_sword = {
                ...DEFAULT_BLOOD_SWORD_STATE,
                blood_pact_week_reset_at: today
            };
            equipment.deep_line_state = deepLine;
        } else {
            // 补全可能缺失的字段（向后兼容旧数据）
            const today = this._getISOWeekStart(new Date());
            deepLine.blood_sword = {
                ...DEFAULT_BLOOD_SWORD_STATE,
                ...deepLine.blood_sword,
                blood_pact_week_reset_at: deepLine.blood_sword.blood_pact_week_reset_at || today
            };
            equipment.deep_line_state = deepLine;
            // 跨周重置
            this._resetWeeklyProgressIfNeeded(deepLine.blood_sword);
        }
        return deepLine.blood_sword;
    }

    /**
     * 查找玩家已装备的血魔剑记录
     * @param {number} playerId - 玩家ID
     * @param {Object} [t] - 事务实例（可选）
     * @param {boolean} [lock=false] - 是否加行级锁
     * @returns {Promise<Object|null>} PlayerEquipment 实例
     */
    static async _findBloodSwordEquipment(playerId, t = null, lock = false) {
        const cfg = this.getBloodSwordConfig();
        const query = {
            where: {
                player_id: playerId,
                item_key: cfg.item_key
            }
        };
        if (t) {
            query.transaction = t;
            if (lock) query.lock = t.LOCK.UPDATE;
        }
        return await PlayerEquipment.findOne(query);
    }

    /**
     * 获取血魔剑残契状态（玩法文档第19节：.法宝 血魔剑）
     *
     * 返回字段说明：
     *   - has_blood_sword: 是否拥有血魔剑（已装备）
     *   - blood_pact_stage: 当前血契阶数 0~5
     *   - blood_pact_stage_name: 当前血契阶数名（"血契初萌"等）
     *   - blood_pact_weekly_progress: 本周血契累计进度
     *   - blood_pact_weekly_limit: 每周血契进度上限（36）
     *   - corruption: 当前魔染值 0~100
     *   - corruption_level: 魔染等级（正常/轻微反噬/中度反噬/严重反噬）
     *   - suppression: 当前镇契值 0~100
     *   - imprint_type: 当前铭印类型 none/blood/suppress
     *   - imprint_name: 铭印中文名
     *   - sheath_until: 封鞘截止时间（null=未封鞘）
     *   - is_sheathed: 当前是否处于封鞘状态
     *   - sacrifice_cooldown_remaining: 祭血冷却剩余秒数
     *   - thunder_wash_cooldown_remaining: 雷洗冷却剩余秒数
     *   - imprint_cooldown_remaining: 铭印冷却剩余秒数
     *   - combat_bonus: 战力加成汇总（atk_bonus_rate / hp_steal_bonus_rate 等）
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 血魔剑状态快照
     */
    static async getBloodSwordStatus(playerId) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank', 'is_dead']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getBloodSwordConfig();
        const equipment = await this._findBloodSwordEquipment(playerId);

        // 未装备血魔剑：返回 has_blood_sword=false，前端据此显示"未持有血魔剑"
        if (!equipment) {
            return {
                has_blood_sword: false,
                item_key: cfg.item_key,
                item_name: cfg.item_name,
                min_realm_rank: cfg.min_realm_rank,
                player_realm: player.realm,
                player_realm_rank: player.realm_rank,
                meets_realm: (player.realm_rank || 0) >= (cfg.min_realm_rank || 15),
                source_hint: '血魔剑来自掩月抢亲副本成功后的成品法宝掉落（掉率 0.1%）',
                config: {
                    max_stage: cfg.blood_pact?.max_stage || 5,
                    weekly_limit: cfg.blood_pact?.weekly_progress_limit || 36,
                    sacrifice_cooldown_hours: cfg.blood_pact?.sacrifice_cooldown_hours || 18,
                    thunder_wash_cooldown_hours: cfg.thunder_wash?.cooldown_hours || 24,
                    imprint_cooldown_days: cfg.imprint?.cooldown_days || 7,
                    sheath_duration_hours: cfg.sheath?.duration_hours || 24
                }
            };
        }

        // 已装备：初始化状态并返回完整快照
        const state = this._initBloodSwordState(equipment);
        // 若状态有变更（首次初始化或跨周重置），持久化
        if (equipment.changed('deep_line_state')) {
            await equipment.save();
        }

        const now = Date.now();
        const sacrificeCooldownMs = (cfg.blood_pact?.sacrifice_cooldown_hours || 18) * 3600 * 1000;
        const thunderWashCooldownMs = (cfg.thunder_wash?.cooldown_hours || 24) * 3600 * 1000;
        const imprintCooldownMs = (cfg.imprint?.cooldown_days || 7) * 24 * 3600 * 1000;

        // 计算各操作冷却剩余秒数（<0 视为 0）
        const calcRemaining = (lastTime, cooldownMs) => {
            if (!lastTime) return 0;
            const lastMs = new Date(lastTime).getTime();
            if (isNaN(lastMs)) return 0;
            const remaining = cooldownMs - (now - lastMs);
            return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
        };

        const sacrificeCooldownRemaining = calcRemaining(state.last_sacrifice_at, sacrificeCooldownMs);
        const thunderWashCooldownRemaining = calcRemaining(state.last_thunder_wash_at, thunderWashCooldownMs);
        const imprintCooldownRemaining = calcRemaining(state.last_imprint_at, imprintCooldownMs);

        // 封鞘状态判定
        const sheathUntilMs = state.sheath_until ? new Date(state.sheath_until).getTime() : 0;
        const isSheathed = sheathUntilMs > now;
        const sheathRemainingSeconds = isSheathed ? Math.ceil((sheathUntilMs - now) / 1000) : 0;

        // 魔染等级判定（从高到低匹配）
        const corruptionCfg = cfg.corruption?.backlash_thresholds || [];
        let corruptionLevel = '正常';
        let corruptionExtraBacklashRate = 0;
        let corruptionLossControlChance = 0;
        for (const t of corruptionCfg) {
            if (state.corruption >= t.min && state.corruption <= t.max) {
                corruptionLevel = t.level;
                corruptionExtraBacklashRate = t.extra_backlash_rate || 0;
                corruptionLossControlChance = t.loss_control_chance || 0;
                break;
            }
        }

        // 铭印中文名
        const imprintNameMap = { none: '无铭印', blood: '血契铭印', suppress: '镇契铭印' };

        // 当前血契阶数配置
        const stages = cfg.blood_pact?.stages || [];
        const currentStage = stages.find(s => s.stage === state.blood_pact_stage);

        // 计算战力加成（血契阶数 + 铭印）
        const combatBonus = this._calculateCombatBonus(state, cfg);

        return {
            has_blood_sword: true,
            item_key: cfg.item_key,
            item_name: cfg.item_name,
            equipment_id: equipment.id,
            slot: equipment.slot,
            durability: equipment.durability,
            max_durability: equipment.max_durability,
            refine_level: equipment.refine_level,
            is_benming: equipment.is_benming,
            is_summoned: equipment.is_summoned,
            // 血契状态
            blood_pact_stage: state.blood_pact_stage,
            blood_pact_stage_name: currentStage?.name || '未启血契',
            blood_pact_stage_description: currentStage?.description || '',
            blood_pact_max_stage: cfg.blood_pact?.max_stage || 5,
            blood_pact_weekly_progress: state.blood_pact_weekly_progress,
            blood_pact_weekly_limit: cfg.blood_pact?.weekly_progress_limit || 36,
            // 魔染/镇契
            corruption: state.corruption,
            corruption_max: cfg.corruption?.max || 100,
            corruption_level: corruptionLevel,
            corruption_extra_backlash_rate: corruptionExtraBacklashRate,
            corruption_loss_control_chance: corruptionLossControlChance,
            suppression: state.suppression,
            suppression_max: cfg.suppression?.max || 100,
            // 铭印
            imprint_type: state.imprint_type,
            imprint_name: imprintNameMap[state.imprint_type] || '无铭印',
            last_imprint_at: state.last_imprint_at,
            // 封鞘
            sheath_until: state.sheath_until,
            is_sheathed: isSheathed,
            sheath_remaining_seconds: sheathRemainingSeconds,
            // 冷却剩余
            sacrifice_cooldown_remaining: sacrificeCooldownRemaining,
            thunder_wash_cooldown_remaining: thunderWashCooldownRemaining,
            imprint_cooldown_remaining: imprintCooldownRemaining,
            // 战力加成
            combat_bonus: combatBonus,
            // 配置回显
            config: {
                max_stage: cfg.blood_pact?.max_stage || 5,
                weekly_limit: cfg.blood_pact?.weekly_progress_limit || 36,
                sacrifice_cooldown_hours: cfg.blood_pact?.sacrifice_cooldown_hours || 18,
                thunder_wash_cooldown_hours: cfg.thunder_wash?.cooldown_hours || 24,
                imprint_cooldown_days: cfg.imprint?.cooldown_days || 7,
                sheath_duration_hours: cfg.sheath?.duration_hours || 24
            },
            server_time: now
        };
    }

    /**
     * 计算血魔剑战力加成（供战斗系统调用）
     * 加成来源：血契阶数 + 当前铭印
     * 注意：封鞘期间不提供战力加成（返回 0）
     *
     * @param {Object} state - 血魔剑状态
     * @param {Object} cfg - 血魔剑配置
     * @returns {Object} 战力加成对象
     */
    static _calculateCombatBonus(state, cfg) {
        const now = Date.now();
        // 封鞘期间不提供战力
        if (state.sheath_until && new Date(state.sheath_until).getTime() > now) {
            return {
                atk_bonus_rate: 0,
                hp_steal_bonus_rate: 0,
                def_bonus_rate: 0,
                crit_rate_bonus: 0,
                crit_damage_bonus: 0,
                blood_backlash_hp_rate_per_round: 0,
                is_active: false,
                reason: '封鞘中，不提供战力'
            };
        }

        // 血契阶数加成
        const stages = cfg.blood_pact?.stages || [];
        const currentStage = stages.find(s => s.stage === state.blood_pact_stage);
        let atkBonusRate = currentStage?.atk_bonus_rate || 0;
        let hpStealBonusRate = currentStage?.hp_steal_bonus_rate || 0;
        let defBonusRate = 0;
        let critRateBonus = 0;
        let critDamageBonus = 0;
        let bloodBacklashHpRatePerRound = 0;

        // 铭印加成（叠加在血契基础上）
        if (state.imprint_type === 'blood') {
            const imp = cfg.imprint?.blood_imprint || {};
            atkBonusRate += imp.atk_bonus_rate || 0;
            hpStealBonusRate += imp.hp_steal_bonus_rate || 0;
            critRateBonus += imp.crit_rate_bonus || 0;
            critDamageBonus += imp.crit_damage_bonus || 0;
            bloodBacklashHpRatePerRound = imp.blood_backlash_hp_rate_per_round || 0;
            // 魔染反噬加成：根据魔染等级累加反噬比例
            const corruptionCfg = cfg.corruption?.backlash_thresholds || [];
            for (const t of corruptionCfg) {
                if (state.corruption >= t.min && state.corruption <= t.max) {
                    bloodBacklashHpRatePerRound += t.extra_backlash_rate || 0;
                    break;
                }
            }
            // 镇契减免：镇契值 ≥ 50 时反噬减半
            const supCfg = cfg.suppression || {};
            if (state.suppression >= (supCfg.high_threshold || 50)) {
                bloodBacklashHpRatePerRound *= (1 - (supCfg.high_threshold_reduction_rate || 0.5));
            } else {
                // 镇契 < 50 时按每 10 点降低 1% 反噬
                const reduction = Math.floor(state.suppression / 10) * (supCfg.backlash_reduction_per_10_points || 0.01);
                bloodBacklashHpRatePerRound *= (1 - reduction);
            }
        } else if (state.imprint_type === 'suppress') {
            const imp = cfg.imprint?.suppress_imprint || {};
            atkBonusRate += imp.atk_bonus_rate || 0;
            hpStealBonusRate += imp.hp_steal_bonus_rate || 0;
            defBonusRate += imp.def_bonus_rate || 0;
            critRateBonus += imp.crit_rate_bonus || 0;
            critDamageBonus += imp.crit_damage_bonus || 0;
            bloodBacklashHpRatePerRound = imp.blood_backlash_hp_rate_per_round || 0;
        }

        return {
            atk_bonus_rate: atkBonusRate,
            hp_steal_bonus_rate: hpStealBonusRate,
            def_bonus_rate: defBonusRate,
            crit_rate_bonus: critRateBonus,
            crit_damage_bonus: critDamageBonus,
            blood_backlash_hp_rate_per_round: bloodBacklashHpRatePerRound,
            is_active: true,
            imprint_type: state.imprint_type
        };
    }

    /**
     * 祭血推进血契阶数（玩法文档第19节：.法宝 祭血 血魔剑）
     *
     * 业务规则：
     *   1. 必须已装备血魔剑
     *   2. 血契阶数 < 5（max_stage）
     *   3. 祭血冷却已结束（18 小时）
     *   4. 本周血契进度 < 36（weekly_progress_limit）
     *   5. 消耗当前阶数→下一阶数所需材料
     *   6. 推进阶数 + 增加魔染（按阶段配置随机）+ 累加本周进度
     *   7. 封鞘中不可祭血
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 祭血结果
     */
    static async bloodSacrifice(playerId) {
        const cfg = this.getBloodSwordConfig();
        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法祭血', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            // 查询血魔剑装备（加锁）
            const equipment = await this._findBloodSwordEquipment(playerId, t, true);
            if (!equipment) {
                throw new AppError('未持有血魔剑，无法祭血', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (equipment.durability <= 0) {
                throw new AppError('血魔剑已破碎，无法祭血', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const state = this._initBloodSwordState(equipment);
            this._resetWeeklyProgressIfNeeded(state);

            // 封鞘中不可祭血
            if (state.sheath_until && new Date(state.sheath_until).getTime() > Date.now()) {
                throw new AppError('血魔剑封鞘中，无法祭血', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 血契阶数上限校验
            const maxStage = cfg.blood_pact?.max_stage || 5;
            if (state.blood_pact_stage >= maxStage) {
                throw new AppError(`血契已大圆满（${maxStage} 阶），无需继续祭血`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 祭血冷却校验（18 小时）
            const cooldownHours = cfg.blood_pact?.sacrifice_cooldown_hours || 18;
            if (state.last_sacrifice_at) {
                const lastMs = new Date(state.last_sacrifice_at).getTime();
                const elapsed = Date.now() - lastMs;
                const cooldownMs = cooldownHours * 3600 * 1000;
                if (elapsed < cooldownMs) {
                    const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
                    throw new AppError(
                        `祭血冷却中，还需 ${Math.ceil(remaining / 3600)} 小时 ${Math.ceil((remaining % 3600) / 60)} 分钟`,
                        400, ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 每周血契进度上限校验
            const weeklyLimit = cfg.blood_pact?.weekly_progress_limit || 36;
            if (state.blood_pact_weekly_progress >= weeklyLimit) {
                throw new AppError(
                    `本周血契进度已达上限 ${weeklyLimit}，下周一 0 点重置`,
                    400, ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 获取下一阶配置（祭血从当前阶数 stage 推进到 stage+1）
            // stage=0 时推进到 stage=1，需要 stages[0] 的材料
            const nextStage = (cfg.blood_pact?.stages || []).find(s => s.stage === state.blood_pact_stage + 1);
            if (!nextStage) {
                throw new AppError('血契阶段配置错误，请联系管理员', 500, ErrorCodes.INTERNAL_ERROR);
            }

            // 校验材料
            const materials = nextStage.materials || [];
            for (const m of materials) {
                const has = await InventoryService.hasItem(playerId, m.item_key, m.count, t);
                if (!has) {
                    throw new AppError(
                        `材料不足：需要 ${m.count} 个 ${m.item_key}（${this._getItemName(m.item_key)}）`,
                        400, ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 扣除材料
            for (const m of materials) {
                const removed = await InventoryService.removeItem(playerId, m.item_key, m.count, t);
                if (!removed) {
                    throw new AppError(`材料 ${m.item_key} 扣减失败`, 500, ErrorCodes.INTERNAL_ERROR);
                }
            }

            // 推进血契阶数
            const oldStage = state.blood_pact_stage;
            state.blood_pact_stage = nextStage.stage;

            // 增加魔染（按阶段配置随机范围）
            const corruptionGain = nextStage.corruption_gain_min + Math.floor(
                Math.random() * (nextStage.corruption_gain_max - nextStage.corruption_gain_min + 1)
            );
            const corruptionMax = cfg.corruption?.max || 100;
            state.corruption = Math.min(corruptionMax, state.corruption + corruptionGain);

            // 累加本周血契进度（每次祭血 +1）
            state.blood_pact_weekly_progress += 1;
            state.last_sacrifice_at = new Date();

            // 保存装备状态
            equipment.deep_line_state = { ...equipment.deep_line_state, blood_sword: state };
            // 显式标记 deep_line_state 字段已变更（Sequelize 对 JSON 字段需 touch）
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            // 推送状态变更给前端
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'blood_sword_sacrifice', {
                    blood_pact_stage: state.blood_pact_stage,
                    blood_pact_stage_name: nextStage.name,
                    corruption: state.corruption,
                    blood_pact_weekly_progress: state.blood_pact_weekly_progress,
                    timestamp: new Date().toISOString()
                });
            } catch (e) {
                console.warn('[ArtifactDeepLine] 推送祭血事件失败:', e.message);
            }

            return {
                success: true,
                message: `祭血成功！血契阶数 ${oldStage} → ${state.blood_pact_stage}（${nextStage.name}），魔染 +${corruptionGain}（当前 ${state.corruption}）`,
                blood_pact_stage: state.blood_pact_stage,
                blood_pact_stage_name: nextStage.name,
                corruption: state.corruption,
                corruption_gain: corruptionGain,
                blood_pact_weekly_progress: state.blood_pact_weekly_progress,
                blood_pact_weekly_remaining: Math.max(0, weeklyLimit - state.blood_pact_weekly_progress),
                materials_consumed: materials.map(m => ({ item_key: m.item_key, count: m.count }))
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 镇契降低魔染、提高镇契值（玩法文档第19节：.法宝 镇契 血魔剑）
     *
     * 业务规则：
     *   1. 必须已装备血魔剑
     *   2. 消耗素女禁纹×1 + 掩月镜砂×1
     *   3. 无冷却，但魔染为 0 时不可镇契
     *   4. 降低魔染 5~10，提高镇契 5~10
     *   5. 封鞘中不可镇契
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 镇契结果
     */
    static async suppressBloodSword(playerId) {
        const cfg = this.getBloodSwordConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法镇契', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findBloodSwordEquipment(playerId, t, true);
            if (!equipment) {
                throw new AppError('未持有血魔剑，无法镇契', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (equipment.durability <= 0) {
                throw new AppError('血魔剑已破碎，无法镇契', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const state = this._initBloodSwordState(equipment);

            // 封鞘中不可镇契
            if (state.sheath_until && new Date(state.sheath_until).getTime() > Date.now()) {
                throw new AppError('血魔剑封鞘中，无法镇契', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 魔染为 0 时不可镇契（避免无意义操作）
            if (state.corruption <= 0) {
                throw new AppError('魔染已清，无需镇契', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 校验材料
            const materials = cfg.suppress?.materials || [];
            for (const m of materials) {
                const has = await InventoryService.hasItem(playerId, m.item_key, m.count, t);
                if (!has) {
                    throw new AppError(
                        `材料不足：需要 ${m.count} 个 ${this._getItemName(m.item_key)}`,
                        400, ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }
            for (const m of materials) {
                await InventoryService.removeItem(playerId, m.item_key, m.count, t);
            }

            // 计算镇契效果
            const supCfg = cfg.suppress;
            const corruptionReduce = supCfg.corruption_reduce_min + Math.floor(
                Math.random() * (supCfg.corruption_reduce_max - supCfg.corruption_reduce_min + 1)
            );
            const suppressionGain = supCfg.suppression_gain_min + Math.floor(
                Math.random() * (supCfg.suppression_gain_max - supCfg.suppression_gain_min + 1)
            );
            const corruptionMax = cfg.corruption?.max || 100;
            const suppressionMax = cfg.suppression?.max || 100;

            const oldCorruption = state.corruption;
            const oldSuppression = state.suppression;
            state.corruption = Math.max(0, state.corruption - corruptionReduce);
            state.suppression = Math.min(suppressionMax, state.suppression + suppressionGain);

            equipment.deep_line_state = { ...equipment.deep_line_state, blood_sword: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'blood_sword_suppress', {
                    corruption: state.corruption,
                    suppression: state.suppression,
                    timestamp: new Date().toISOString()
                });
            } catch (e) {
                console.warn('[ArtifactDeepLine] 推送镇契事件失败:', e.message);
            }

            return {
                success: true,
                message: `镇契成功：魔染 ${oldCorruption} → ${state.corruption}（-${corruptionReduce}），镇契 ${oldSuppression} → ${state.suppression}（+${suppressionGain}）`,
                corruption: state.corruption,
                suppression: state.suppression,
                corruption_reduce: corruptionReduce,
                suppression_gain: suppressionGain,
                materials_consumed: materials.map(m => ({ item_key: m.item_key, count: m.count }))
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 雷洗用天雷竹/金雷竹强力降魔染（玩法文档第19节：.法宝 雷洗 血魔剑）
     *
     * 业务规则：
     *   1. 必须已装备血魔剑
     *   2. 冷却 24 小时（比祭血长，但降魔染更显著）
     *   3. material_type: 'tianlei' 用天雷竹（降 20~30），'jinlei' 用金雷竹（降 35~50）
     *   4. 雷洗会同时小幅提升镇契（2~5）
     *   5. 封鞘中不可雷洗
     *
     * @param {number} playerId - 玩家ID
     * @param {string} materialType - 材料类型 'tianlei'|'jinlei'，默认 'tianlei'
     * @returns {Promise<Object>} 雷洗结果
     */
    static async thunderWashBloodSword(playerId, materialType = 'tianlei') {
        if (!['tianlei', 'jinlei'].includes(materialType)) {
            throw new AppError('材料类型无效，应为 tianlei 或 jinlei', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const cfg = this.getBloodSwordConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法雷洗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findBloodSwordEquipment(playerId, t, true);
            if (!equipment) {
                throw new AppError('未持有血魔剑，无法雷洗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (equipment.durability <= 0) {
                throw new AppError('血魔剑已破碎，无法雷洗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const state = this._initBloodSwordState(equipment);

            // 封鞘中不可雷洗
            if (state.sheath_until && new Date(state.sheath_until).getTime() > Date.now()) {
                throw new AppError('血魔剑封鞘中，无法雷洗', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 雷洗冷却校验（24 小时）
            const cooldownHours = cfg.thunder_wash?.cooldown_hours || 24;
            if (state.last_thunder_wash_at) {
                const lastMs = new Date(state.last_thunder_wash_at).getTime();
                const elapsed = Date.now() - lastMs;
                const cooldownMs = cooldownHours * 3600 * 1000;
                if (elapsed < cooldownMs) {
                    const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
                    throw new AppError(
                        `雷洗冷却中，还需 ${Math.ceil(remaining / 3600)} 小时`,
                        400, ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 校验材料（按类型选择）
            const materials = materialType === 'jinlei'
                ? (cfg.thunder_wash?.materials_jinlei || [])
                : (cfg.thunder_wash?.materials_tianlei || []);
            if (materials.length === 0) {
                throw new AppError('雷洗材料配置错误', 500, ErrorCodes.INTERNAL_ERROR);
            }
            for (const m of materials) {
                const has = await InventoryService.hasItem(playerId, m.item_key, m.count, t);
                if (!has) {
                    throw new AppError(
                        `材料不足：需要 ${m.count} 个 ${this._getItemName(m.item_key)}`,
                        400, ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }
            for (const m of materials) {
                await InventoryService.removeItem(playerId, m.item_key, m.count, t);
            }

            // 计算雷洗效果
            const twCfg = cfg.thunder_wash;
            let corruptionReduceMin, corruptionReduceMax;
            if (materialType === 'jinlei') {
                corruptionReduceMin = twCfg.corruption_reduce_jinlei_min || 35;
                corruptionReduceMax = twCfg.corruption_reduce_jinlei_max || 50;
            } else {
                corruptionReduceMin = twCfg.corruption_reduce_tianlei_min || 20;
                corruptionReduceMax = twCfg.corruption_reduce_tianlei_max || 30;
            }
            const corruptionReduce = corruptionReduceMin + Math.floor(
                Math.random() * (corruptionReduceMax - corruptionReduceMin + 1)
            );
            const suppressionGain = (twCfg.suppression_gain_min || 2) + Math.floor(
                Math.random() * ((twCfg.suppression_gain_max || 5) - (twCfg.suppression_gain_min || 2) + 1)
            );
            const suppressionMax = cfg.suppression?.max || 100;

            const oldCorruption = state.corruption;
            const oldSuppression = state.suppression;
            state.corruption = Math.max(0, state.corruption - corruptionReduce);
            state.suppression = Math.min(suppressionMax, state.suppression + suppressionGain);
            state.last_thunder_wash_at = new Date();

            equipment.deep_line_state = { ...equipment.deep_line_state, blood_sword: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'blood_sword_thunder_wash', {
                    corruption: state.corruption,
                    suppression: state.suppression,
                    material_type: materialType,
                    timestamp: new Date().toISOString()
                });
            } catch (e) {
                console.warn('[ArtifactDeepLine] 推送雷洗事件失败:', e.message);
            }

            const materialName = materialType === 'jinlei' ? '金雷竹' : '天雷竹';
            return {
                success: true,
                message: `雷洗成功（${materialName}）：魔染 ${oldCorruption} → ${state.corruption}（-${corruptionReduce}），镇契 ${oldSuppression} → ${state.suppression}（+${suppressionGain}）`,
                corruption: state.corruption,
                suppression: state.suppression,
                corruption_reduce: corruptionReduce,
                suppression_gain: suppressionGain,
                material_type: materialType,
                materials_consumed: materials.map(m => ({ item_key: m.item_key, count: m.count }))
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 铭印选择血契或镇契路线（玩法文档第19节：.法宝 铭印 血魔剑 血契|镇契）
     *
     * 业务规则：
     *   1. 必须已装备血魔剑
     *   2. 冷却 7 天
     *   3. imprint_type: 'blood' 高输出+反噬，'suppress' 稳定无反噬
     *   4. 血契阶数 ≥ 1 才能铭印
     *   5. 封鞘中不可铭印
     *
     * @param {number} playerId - 玩家ID
     * @param {string} imprintType - 铭印类型 'blood'|'suppress'
     * @returns {Promise<Object>} 铭印结果
     */
    static async imprintBloodSword(playerId, imprintType) {
        if (!['blood', 'suppress'].includes(imprintType)) {
            throw new AppError('铭印类型无效，应为 blood 或 suppress', 400, ErrorCodes.VALIDATION_ERROR);
        }

        const cfg = this.getBloodSwordConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法铭印', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findBloodSwordEquipment(playerId, t, true);
            if (!equipment) {
                throw new AppError('未持有血魔剑，无法铭印', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (equipment.durability <= 0) {
                throw new AppError('血魔剑已破碎，无法铭印', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const state = this._initBloodSwordState(equipment);

            // 封鞘中不可铭印
            if (state.sheath_until && new Date(state.sheath_until).getTime() > Date.now()) {
                throw new AppError('血魔剑封鞘中，无法铭印', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 血契阶数 ≥ 1 才能铭印
            if (state.blood_pact_stage < 1) {
                throw new AppError('血契阶数不足，需至少 1 阶血契方可铭印', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 铭印冷却校验（7 天）
            const cooldownDays = cfg.imprint?.cooldown_days || 7;
            if (state.last_imprint_at) {
                const lastMs = new Date(state.last_imprint_at).getTime();
                const elapsed = Date.now() - lastMs;
                const cooldownMs = cooldownDays * 24 * 3600 * 1000;
                if (elapsed < cooldownMs) {
                    const remainingDays = Math.ceil((cooldownMs - elapsed) / (24 * 3600 * 1000));
                    throw new AppError(
                        `铭印冷却中，还需 ${remainingDays} 天`,
                        400, ErrorCodes.BUSINESS_LOGIC_ERROR
                    );
                }
            }

            // 切换铭印
            const oldImprint = state.imprint_type;
            state.imprint_type = imprintType;
            state.last_imprint_at = new Date();

            equipment.deep_line_state = { ...equipment.deep_line_state, blood_sword: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            const imprintNameMap = { none: '无铭印', blood: '血契铭印', suppress: '镇契铭印' };
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'blood_sword_imprint', {
                    imprint_type: state.imprint_type,
                    imprint_name: imprintNameMap[state.imprint_type],
                    timestamp: new Date().toISOString()
                });
            } catch (e) {
                console.warn('[ArtifactDeepLine] 推送铭印事件失败:', e.message);
            }

            return {
                success: true,
                message: `铭印成功：${imprintNameMap[oldImprint]} → ${imprintNameMap[state.imprint_type]}`,
                imprint_type: state.imprint_type,
                imprint_name: imprintNameMap[state.imprint_type],
                last_imprint_at: state.last_imprint_at
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 封鞘 24 小时（玩法文档第19节：.法宝 封鞘 血魔剑）
     *
     * 业务规则：
     *   1. 必须已装备血魔剑
     *   2. 未处于封鞘状态
     *   3. 血契阶数 ≥ 1 才能封鞘（避免无意义封鞘）
     *   4. 封鞘后：24h 内不提供战力且不可祭出
     *   5. 封鞘期间不可祭血/镇契/雷洗/铭印
     *   6. 封鞘到期后自动结算：-魔染 25~35，+镇契 15~25
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 封鞘结果
     */
    static async sheathBloodSword(playerId) {
        const cfg = this.getBloodSwordConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已陨落，无法封鞘', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findBloodSwordEquipment(playerId, t, true);
            if (!equipment) {
                throw new AppError('未持有血魔剑，无法封鞘', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }
            if (equipment.durability <= 0) {
                throw new AppError('血魔剑已破碎，无法封鞘', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const state = this._initBloodSwordState(equipment);

            // 已封鞘中不可重复封鞘
            if (state.sheath_until && new Date(state.sheath_until).getTime() > Date.now()) {
                const remaining = Math.ceil((new Date(state.sheath_until).getTime() - Date.now()) / 1000);
                throw new AppError(
                    `血魔剑已封鞘中，还需 ${Math.ceil(remaining / 3600)} 小时方可解封`,
                    400, ErrorCodes.BUSINESS_LOGIC_ERROR
                );
            }

            // 血契阶数 ≥ 1 才能封鞘
            if (state.blood_pact_stage < 1) {
                throw new AppError('血契阶数不足，需至少 1 阶血契方可封鞘', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 计算封鞘截止时间
            const durationHours = cfg.sheath?.duration_hours || 24;
            const sheathUntil = new Date(Date.now() + durationHours * 3600 * 1000);
            state.sheath_until = sheathUntil;

            // 封鞘期间自动收回祭出状态
            if (equipment.is_summoned) {
                equipment.is_summoned = false;
            }

            equipment.deep_line_state = { ...equipment.deep_line_state, blood_sword: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'blood_sword_sheath', {
                    sheath_until: state.sheath_until,
                    is_summoned: false,
                    timestamp: new Date().toISOString()
                });
            } catch (e) {
                console.warn('[ArtifactDeepLine] 推送封鞘事件失败:', e.message);
            }

            return {
                success: true,
                message: `血魔剑已封鞘 ${durationHours} 小时，期间不提供战力且不可祭出。封鞘到期后将自动结算：魔染 -25~35，镇契 +15~25`,
                sheath_until: state.sheath_until,
                sheath_duration_hours: durationHours,
                is_summoned: false
            };
        } catch (error) {
            if (t && !t.finished) await t.rollback();
            throw error;
        }
    }

    /**
     * 封鞘到期结算（供 StateCleanerService 周期调用）
     * 扫描所有 sheath_until 已到期的血魔剑，结算 -魔染 +镇契 效果
     *
     * @returns {Promise<Object>} 结算结果 { settled_count, errors: [] }
     */
    static async settleExpiredSheaths() {
        const cfg = this.getBloodSwordConfig();
        const now = new Date();
        let settledCount = 0;
        const errors = [];

        // 查询所有 sheath_until 已到期但未结算的记录（deep_line_state 含 sheath_until 字段）
        // MySQL 5.6 不支持 JSON 查询，需全表扫描后内存过滤
        const allEquipments = await PlayerEquipment.findAll({
            where: { item_key: cfg.item_key }
        });

        for (const equipment of allEquipments) {
            try {
                const deepLine = equipment.deep_line_state || {};
                const state = deepLine.blood_sword;
                if (!state || !state.sheath_until) continue;

                const sheathUntilMs = new Date(state.sheath_until).getTime();
                if (sheathUntilMs > now.getTime()) continue;  // 未到期，跳过

                // 结算封鞘效果
                const sheathCfg = cfg.sheath;
                const corruptionReduce = (sheathCfg.corruption_reduce_min || 25) + Math.floor(
                    Math.random() * ((sheathCfg.corruption_reduce_max || 35) - (sheathCfg.corruption_reduce_min || 25) + 1)
                );
                const suppressionGain = (sheathCfg.suppression_gain_min || 15) + Math.floor(
                    Math.random() * ((sheathCfg.suppression_gain_max || 25) - (sheathCfg.suppression_gain_min || 15) + 1)
                );
                const corruptionMax = cfg.corruption?.max || 100;
                const suppressionMax = cfg.suppression?.max || 100;

                state.corruption = Math.max(0, state.corruption - corruptionReduce);
                state.suppression = Math.min(suppressionMax, state.suppression + suppressionGain);
                state.sheath_until = null;  // 清除封鞘状态

                equipment.deep_line_state = { ...deepLine, blood_sword: state };
                equipment.changed('deep_line_state', true);
                await equipment.save();

                // 推送封鞘到期结算通知
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(equipment.player_id, 'blood_sword_sheath_settled', {
                        corruption: state.corruption,
                        suppression: state.suppression,
                        corruption_reduce: corruptionReduce,
                        suppression_gain: suppressionGain,
                        timestamp: now.toISOString()
                    });
                } catch (e) {
                    // 推送失败不阻塞结算
                }

                settledCount += 1;
            } catch (err) {
                errors.push({ equipment_id: equipment.id, error: err.message });
            }
        }

        return { settled_count: settledCount, errors };
    }

    /**
     * 内部工具：获取物品中文名（错误信息用）
     * @param {string} itemKey - 物品 key
     * @returns {string} 物品中文名，未找到返回 itemKey
     */
    static _getItemName(itemKey) {
        const items = configLoader.getConfig('item_data')?.items || [];
        return items.find(i => i.id === itemKey)?.name || itemKey;
    }

    /**
     * 供战斗系统调用：获取玩家血魔剑战力加成
     * 战斗系统在计算玩家总战力时调用此方法，叠加血魔剑的 atk/hp_steal/def 加成
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 战力加成对象（无血魔剑时返回 is_active=false 的默认值）
     */
    static async getBloodSwordCombatBonus(playerId) {
        const equipment = await this._findBloodSwordEquipment(playerId);
        if (!equipment) {
            return { is_active: false, reason: '未持有血魔剑' };
        }

        const state = this._initBloodSwordState(equipment);
        const cfg = this.getBloodSwordConfig();
        return this._calculateCombatBonus(state, cfg);
    }

    // ==================== 虚天鼎/乾蓝冰焰线（玩法文档第19节） ====================
    // 双线并行成长：鼎本体（防御向）+ 乾蓝冰焰（攻击向）+ 化极分支（紫罗极火反噬高攻 vs 乾蓝冰焰稳定中攻）
    // 核心差异（vs 血魔剑线）：双线并行成长 + 神识消耗 + 化极不可逆分支选择 + 无封鞘机制

    /**
     * 默认虚天鼎状态（首次访问时初始化）
     * 所有字段存储在 player_equipment.deep_line_state.xutian_cauldron 子对象中
     */
    static get DEFAULT_XUTIAN_STATE() {
        return {
            cauldron_stage: 0,              // 虚天鼎本体阶数 0~10（通宝推进，防御向）
            flame_extracted: false,         // 是否已抽离乾蓝冰焰（炼焰后置 true）
            flame_stage: 0,                 // 乾蓝冰焰阶数 0~10（炼焰推进，攻击向）
            flame_polarity: 'none',         // 灵焰化极方向：none/qianlan_bingyan/ziluo_jihuo
            last_advance_cauldron_at: null, // 上次通宝时间（12h 冷却）
            last_refine_flame_at: null,     // 上次炼焰时间（24h 冷却）
            last_polarize_at: null          // 上次化极时间（48h 冷却）
        };
    }

    /**
     * 读取虚天鼎线配置
     * @returns {Object} 虚天鼎线配置
     */
    static getXutianCauldronConfig() {
        return this.getDeepLineConfig().xutian_cauldron || {};
    }

    /**
     * 初始化虚天鼎状态（首次访问时创建默认状态，补全缺失字段）
     * @param {Object} equipment - PlayerEquipment 实例
     * @returns {Object} 虚天鼎状态对象
     */
    static _initXutianCauldronState(equipment) {
        const deepLine = equipment.deep_line_state || {};
        if (!deepLine.xutian_cauldron) {
            deepLine.xutian_cauldron = { ...this.DEFAULT_XUTIAN_STATE };
            equipment.deep_line_state = deepLine;
        } else {
            // 补全可能缺失的字段（向后兼容旧数据）
            deepLine.xutian_cauldron = {
                ...this.DEFAULT_XUTIAN_STATE,
                ...deepLine.xutian_cauldron
            };
            equipment.deep_line_state = deepLine;
        }
        return deepLine.xutian_cauldron;
    }

    /**
     * 查找玩家已装备的虚天鼎记录
     * @param {number} playerId - 玩家ID
     * @param {Object} [t] - 事务实例（可选）
     * @param {boolean} [lock=false] - 是否加行级锁
     * @returns {Promise<Object|null>} PlayerEquipment 实例
     */
    static async _findXutianCauldronEquipment(playerId, t = null, lock = false) {
        const cfg = this.getXutianCauldronConfig();
        const query = {
            where: {
                player_id: playerId,
                item_key: cfg.item_key
            }
        };
        if (t) {
            query.transaction = t;
            if (lock) query.lock = t.LOCK.UPDATE;
        }
        return await PlayerEquipment.findOne(query);
    }

    /**
     * 神识扣减辅助方法（事务内调用）
     * 直接操作 PlayerDivineSense 模型，行级锁防并发
     * @param {number} playerId - 玩家ID
     * @param {number} amount - 扣减量（正整数）
     * @param {Object} t - 事务实例
     * @returns {Promise<Object>} { success, current, message }
     */
    static async _deductDivineSense(playerId, amount, t) {
        const PlayerDivineSense = require('../../models/playerDivineSense');
        const sense = await PlayerDivineSense.findOne({
            where: { player_id: playerId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!sense) {
            return { success: false, message: '神识记录不存在，请先通过神识系统初始化' };
        }
        const current = Number(sense.divine_sense_current) || 0;
        if (current < amount) {
            return { success: false, message: `神识不足，需要 ${amount}，当前 ${current}`, current };
        }
        sense.divine_sense_current = current - amount;
        sense.total_consumed = (Number(sense.total_consumed) || 0) + amount;
        await sense.save({ transaction: t });
        return { success: true, current: sense.divine_sense_current, consumed: amount };
    }

    /**
     * 获取虚天鼎/乾蓝冰焰状态（玩法文档第19节：.法宝 虚天鼎）
     *
     * 返回字段说明：
     *   - has_xutian_cauldron: 是否拥有虚天鼎（已装备）
     *   - cauldron_stage: 当前本体阶数 0~10
     *   - cauldron_stage_name: 阶数名（"鼎焰初萌"等）
     *   - flame_extracted: 是否已抽离乾蓝冰焰
     *   - flame_stage: 乾蓝冰焰阶数 0~10
     *   - flame_polarity: 灵焰化极方向 none/qianlan_bingyan/ziluo_jihuo
     *   - flame_polarity_name: 化极方向中文名
     *   - advance_cooldown_remaining: 通宝冷却剩余秒数
     *   - refine_flame_cooldown_remaining: 炼焰冷却剩余秒数
     *   - polarize_cooldown_remaining: 化极冷却剩余秒数
     *   - combat_bonus: 战力加成汇总（def_bonus / atk_bonus / atk_multiplier / backlash_rate）
     *   - divine_sense: 玩家当前神识信息
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 虚天鼎状态快照
     */
    static async getXutianCauldronStatus(playerId) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank', 'is_dead']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getXutianCauldronConfig();
        const equipment = await this._findXutianCauldronEquipment(playerId);

        // 未装备虚天鼎：返回 has_xutian_cauldron=false
        if (!equipment) {
            return {
                has_xutian_cauldron: false,
                item_key: cfg.item_key,
                item_name: cfg.item_name,
                min_realm_rank: cfg.min_realm_rank,
                player_realm: player.realm,
                player_realm_rank: player.realm_rank,
                meets_realm: (player.realm_rank || 0) >= (cfg.min_realm_rank || 19),
                source_hint: '虚天鼎来自虚天殿副本队长掉落（0.1%），或集齐残片后通过按图索骥合成',
                config: {
                    max_cauldron_stage: (cfg.cauldron_stages || []).length,
                    max_flame_stage: (cfg.refine_flame?.flame_stages || []).length,
                    advance_cooldown_seconds: cfg.advance_cauldron?.cooldown_seconds || 43200,
                    refine_flame_cooldown_seconds: cfg.refine_flame?.cooldown_seconds || 86400,
                    polarize_cooldown_seconds: cfg.polarize?.cooldown_seconds || 172800,
                    min_cauldron_stage_for_flame: cfg.refine_flame?.min_cauldron_stage || 3,
                    min_flame_stage_for_polarize: cfg.polarize?.min_flame_stage || 7
                }
            };
        }

        // 已装备：初始化状态并返回完整快照
        const state = this._initXutianCauldronState(equipment);
        if (equipment.changed('deep_line_state')) {
            await equipment.save();
        }

        const now = Date.now();
        const advanceCooldownMs = (cfg.advance_cauldron?.cooldown_seconds || 43200) * 1000;
        const refineFlameCooldownMs = (cfg.refine_flame?.cooldown_seconds || 86400) * 1000;
        const polarizeCooldownMs = (cfg.polarize?.cooldown_seconds || 172800) * 1000;

        // 冷却剩余秒数计算
        const calcRemaining = (lastTime, cooldownMs) => {
            if (!lastTime) return 0;
            const lastMs = new Date(lastTime).getTime();
            if (isNaN(lastMs)) return 0;
            const remaining = cooldownMs - (now - lastMs);
            return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
        };

        // 阶数名映射
        const cauldronStageNames = ['未启灵', '鼎焰初萌', '寒火交融', '虚天初成', '鼎威渐显', '虚天小成',
                                     '寒极火极', '虚天大成', '鼎镇虚空', '虚天圆满', '鼎开天门'];
        const flameStageNames = ['未抽离', '灵焰初生', '冰焰凝形', '寒火相济', '冰焰小成', '冰焰中成',
                                  '冰焰大成', '冰焰极成', '冰焰化形', '冰焰通灵', '冰焰归真'];

        // 化极方向中文名
        const polarityNameMap = {
            'none': '未化极',
            'qianlan_bingyan': '乾蓝冰焰（强化）',
            'ziluo_jihuo': '紫罗极火'
        };

        // 查询玩家神识
        const PlayerDivineSense = require('../../models/playerDivineSense');
        const senseRecord = await PlayerDivineSense.findOne({ where: { player_id: playerId } });
        const divineSense = senseRecord ? {
            current: Number(senseRecord.divine_sense_current) || 0,
            max: Number(senseRecord.divine_sense_max) || 100
        } : { current: 0, max: 0 };

        // 战力加成计算
        const combatBonus = this._calculateXutianCombatBonus(state, cfg);

        return {
            has_xutian_cauldron: true,
            item_key: cfg.item_key,
            item_name: cfg.item_name,
            cauldron_stage: state.cauldron_stage,
            cauldron_stage_name: cauldronStageNames[state.cauldron_stage] || `第${state.cauldron_stage}阶`,
            flame_extracted: state.flame_extracted,
            flame_stage: state.flame_stage,
            flame_stage_name: flameStageNames[state.flame_stage] || `第${state.flame_stage}阶`,
            flame_polarity: state.flame_polarity,
            flame_polarity_name: polarityNameMap[state.flame_polarity] || '未知',
            advance_cooldown_remaining: calcRemaining(state.last_advance_cauldron_at, advanceCooldownMs),
            refine_flame_cooldown_remaining: calcRemaining(state.last_refine_flame_at, refineFlameCooldownMs),
            polarize_cooldown_remaining: calcRemaining(state.last_polarize_at, polarizeCooldownMs),
            combat_bonus: combatBonus,
            divine_sense: divineSense,
            config: {
                max_cauldron_stage: (cfg.cauldron_stages || []).length,
                max_flame_stage: (cfg.refine_flame?.flame_stages || []).length,
                advance_cooldown_seconds: cfg.advance_cauldron?.cooldown_seconds || 43200,
                refine_flame_cooldown_seconds: cfg.refine_flame?.cooldown_seconds || 86400,
                polarize_cooldown_seconds: cfg.polarize?.cooldown_seconds || 172800,
                min_cauldron_stage_for_flame: cfg.refine_flame?.min_cauldron_stage || 3,
                min_flame_stage_for_polarize: cfg.polarize?.min_flame_stage || 7,
                divine_sense_cost: cfg.divine_sense_cost || {}
            }
        };
    }

    /**
     * 计算虚天鼎战力加成
     * 鼎本体提供 def_bonus（防御向），乾蓝冰焰提供 atk_bonus（攻击向），化极后乘以 atk_multiplier
     * @param {Object} state - 虚天鼎状态
     * @param {Object} cfg - 虚天鼎配置
     * @returns {Object} 战力加成对象
     */
    static _calculateXutianCombatBonus(state, cfg) {
        const cauldronStages = cfg.cauldron_stages || [];
        const flameStages = cfg.refine_flame?.flame_stages || [];

        // 鼎本体防御加成：累加当前阶数及以下所有阶的 def_bonus
        let defBonus = 0;
        for (let i = 0; i < state.cauldron_stage && i < cauldronStages.length; i++) {
            defBonus += Number(cauldronStages[i].def_bonus) || 0;
        }

        // 乾蓝冰焰攻击加成：累加当前阶数及以下所有阶的 atk_bonus
        let atkBonus = 0;
        if (state.flame_extracted) {
            for (let i = 0; i < state.flame_stage && i < flameStages.length; i++) {
                atkBonus += Number(flameStages[i].atk_bonus) || 0;
            }
        }

        // 化极倍率
        let atkMultiplier = 1.0;
        let backlashRate = 0;
        let backlashTarget = 'none';
        if (state.flame_polarity !== 'none') {
            const polarizeOption = cfg.polarize?.options?.[state.flame_polarity];
            if (polarizeOption) {
                atkMultiplier = Number(polarizeOption.atk_multiplier) || 1.0;
                backlashRate = Number(polarizeOption.backlash_rate_per_round) || 0;
                backlashTarget = polarizeOption.backlash_target || 'none';
            }
        }

        return {
            is_active: state.cauldron_stage > 0 || state.flame_stage > 0,
            def_bonus: defBonus,
            atk_bonus: atkBonus,
            atk_multiplier: atkMultiplier,
            final_atk_bonus: Math.floor(atkBonus * atkMultiplier),
            backlash_rate_per_round: backlashRate,
            backlash_target: backlashTarget
        };
    }

    /**
     * 通宝推进虚天鼎本体（玩法文档第19节：.法宝 通宝 虚天鼎）
     *
     * 消耗：神识（divine_sense_cost.advance_cauldron）+ 灵石 + 虚天寒晶/虚天火精（交替）
     * 冷却：12h
     * 成功率：1-5阶 100%，6-10阶递减（90%/80%/70%/60%/50%）
     * 失败：材料全损，但不降级
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 推进结果
     */
    static async advanceCauldron(playerId) {
        const cfg = this.getXutianCauldronConfig();
        if (!cfg.enabled) {
            return { success: false, message: '虚天鼎线未开启', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            // 行级锁查询玩家
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE,
                attributes: ['id', 'nickname', 'realm', 'realm_rank', 'is_dead', 'spirit_stones']
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在', error_code: ErrorCodes.NOT_FOUND };
            }
            if (player.is_dead) {
                await t.rollback();
                return { success: false, message: '已陨落，无法操作法宝', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 境界校验
            const requiredRank = Number(cfg.min_realm_rank) || 19;
            if ((Number(player.realm_rank) || 0) < requiredRank) {
                await t.rollback();
                return { success: false, message: `境界不足，需达到 rank ${requiredRank}（化神期）`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 查装备记录
            const equipment = await this._findXutianCauldronEquipment(playerId, t, true);
            if (!equipment) {
                await t.rollback();
                return { success: false, message: '未持有虚天鼎，请先通过虚天殿副本或按图索骥获取', error_code: ErrorCodes.NOT_FOUND };
            }

            const state = this._initXutianCauldronState(equipment);
            const cauldronStages = cfg.cauldron_stages || [];
            const maxStage = cauldronStages.length;

            // 阶数上限校验
            if (state.cauldron_stage >= maxStage) {
                await t.rollback();
                return { success: false, message: `虚天鼎本体已满阶（${maxStage}阶），无法继续推进`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 冷却校验
            const cooldownSec = Number(cfg.advance_cauldron?.cooldown_seconds) || 43200;
            if (state.last_advance_cauldron_at) {
                const lastMs = new Date(state.last_advance_cauldron_at).getTime();
                const elapsedSec = (Date.now() - lastMs) / 1000;
                if (elapsedSec < cooldownSec) {
                    await t.rollback();
                    const remaining = Math.ceil(cooldownSec - elapsedSec);
                    return { success: false, message: `通宝冷却中，剩余 ${remaining} 秒`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
                }
            }

            // 当前阶配置
            const currentStageCfg = cauldronStages[state.cauldron_stage];
            if (!currentStageCfg) {
                await t.rollback();
                return { success: false, message: '阶数配置异常', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 神识消耗
            const divineSenseCost = Number(cfg.divine_sense_cost?.advance_cauldron) || 100;
            const senseResult = await this._deductDivineSense(playerId, divineSenseCost, t);
            if (!senseResult.success) {
                await t.rollback();
                return { success: false, message: senseResult.message, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 灵石消耗
            const spiritStonesCost = BigInt(cfg.advance_cauldron?.spirit_stones_cost || 10000);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < spiritStonesCost) {
                await t.rollback();
                return { success: false, message: `灵石不足，需要 ${spiritStonesCost.toString()}，当前 ${playerStones.toString()}`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            player.spirit_stones = (playerStones - spiritStonesCost).toString();
            await player.save({ transaction: t });

            // 材料消耗
            const materialKey = currentStageCfg.material_key;
            const materialCost = Number(currentStageCfg.material_cost) || 1;
            const hasMaterial = await InventoryService.hasItem(playerId, materialKey, materialCost, t);
            if (!hasMaterial) {
                await t.rollback();
                return { success: false, message: `${this._getItemName(materialKey)}不足，需要 ${materialCost} 个`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            await InventoryService.removeItem(playerId, materialKey, materialCost, t);

            // 成功率判定
            const successRate = Number(currentStageCfg.success_rate) || 1.0;
            const isSuccess = Math.random() < successRate;

            if (isSuccess) {
                // 成功：阶数+1
                state.cauldron_stage += 1;
                state.last_advance_cauldron_at = new Date();
                equipment.deep_line_state = { ...equipment.deep_line_state, xutian_cauldron: state };
                equipment.changed('deep_line_state', true);
                await equipment.save({ transaction: t });
                await t.commit();

                // WebSocket 推送（事务外，失败不影响主流程）
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'xutian_cauldron_advanced', {
                        new_stage: state.cauldron_stage,
                        def_bonus: currentStageCfg.def_bonus,
                        consumed: { divine_sense: divineSenseCost, spirit_stones: spiritStonesCost.toString(), material: materialKey, material_cost: materialCost }
                    });
                } catch (wsErr) {
                    console.warn(`[ArtifactDeepLine] 推送 xutian_cauldron_advanced 通知失败: ${wsErr.message}`);
                }

                return {
                    success: true,
                    message: `虚天鼎本体推进成功！当前第${state.cauldron_stage}阶，防御+${currentStageCfg.def_bonus}`,
                    data: {
                        old_stage: state.cauldron_stage - 1,
                        new_stage: state.cauldron_stage,
                        def_bonus: currentStageCfg.def_bonus,
                        consumed: {
                            divine_sense: divineSenseCost,
                            spirit_stones: spiritStonesCost.toString(),
                            material_key: materialKey,
                            material_cost: materialCost
                        },
                        divine_sense_remaining: senseResult.current
                    }
                };
            } else {
                // 失败：材料全损，不降级
                state.last_advance_cauldron_at = new Date();
                equipment.deep_line_state = { ...equipment.deep_line_state, xutian_cauldron: state };
                equipment.changed('deep_line_state', true);
                await equipment.save({ transaction: t });
                await t.commit();

                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'xutian_cauldron_advance_failed', {
                        stage: state.cauldron_stage,
                        consumed: { divine_sense: divineSenseCost, spirit_stones: spiritStonesCost.toString(), material: materialKey, material_cost: materialCost }
                    });
                } catch (wsErr) {
                    console.warn(`[ArtifactDeepLine] 推送 xutian_cauldron_advance_failed 通知失败: ${wsErr.message}`);
                }

                return {
                    success: false,
                    message: `通宝失败！灵焰不稳，材料已损毁。虚天鼎仍停留在第${state.cauldron_stage}阶`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR,
                    data: {
                        stage: state.cauldron_stage,
                        consumed: {
                            divine_sense: divineSenseCost,
                            spirit_stones: spiritStonesCost.toString(),
                            material_key: materialKey,
                            material_cost: materialCost
                        },
                        divine_sense_remaining: senseResult.current
                    }
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 炼焰：抽离/推进乾蓝冰焰（玩法文档第19节：.法宝 炼焰 虚天鼎）
     *
     * 首次炼焰：从虚天鼎中抽离乾蓝冰焰（需本体≥3阶），获得灵焰物品
     * 后续炼焰：推进乾蓝冰焰阶数（消耗神识+乾蓝寒髓+灵石）
     * 冷却：24h
     * 成功率：1-5阶 100%，6-10阶递减
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 炼焰结果
     */
    static async refineFlame(playerId) {
        const cfg = this.getXutianCauldronConfig();
        if (!cfg.enabled || !cfg.refine_flame?.enabled) {
            return { success: false, message: '炼焰功能未开启', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE,
                attributes: ['id', 'nickname', 'realm', 'realm_rank', 'is_dead', 'spirit_stones']
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在', error_code: ErrorCodes.NOT_FOUND };
            }
            if (player.is_dead) {
                await t.rollback();
                return { success: false, message: '已陨落，无法操作法宝', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            const equipment = await this._findXutianCauldronEquipment(playerId, t, true);
            if (!equipment) {
                await t.rollback();
                return { success: false, message: '未持有虚天鼎', error_code: ErrorCodes.NOT_FOUND };
            }

            const state = this._initXutianCauldronState(equipment);
            const refineFlameCfg = cfg.refine_flame;
            const flameStages = refineFlameCfg.flame_stages || [];
            const maxFlameStage = flameStages.length;

            // 首次抽离校验
            if (!state.flame_extracted) {
                // 需本体≥min_cauldron_stage
                const minCauldronStage = Number(refineFlameCfg.min_cauldron_stage) || 3;
                if (state.cauldron_stage < minCauldronStage) {
                    await t.rollback();
                    return { success: false, message: `虚天鼎本体需达到第${minCauldronStage}阶方可抽离乾蓝冰焰`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
                }
            } else {
                // 已抽离：阶数上限校验
                if (state.flame_stage >= maxFlameStage) {
                    await t.rollback();
                    return { success: false, message: `乾蓝冰焰已满阶（${maxFlameStage}阶），请使用化极进阶`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
                }
            }

            // 冷却校验
            const cooldownSec = Number(refineFlameCfg.cooldown_seconds) || 86400;
            if (state.last_refine_flame_at) {
                const lastMs = new Date(state.last_refine_flame_at).getTime();
                const elapsedSec = (Date.now() - lastMs) / 1000;
                if (elapsedSec < cooldownSec) {
                    await t.rollback();
                    const remaining = Math.ceil(cooldownSec - elapsedSec);
                    return { success: false, message: `炼焰冷却中，剩余 ${remaining} 秒`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
                }
            }

            // 神识消耗
            const divineSenseCost = Number(cfg.divine_sense_cost?.refine_flame) || 200;
            const senseResult = await this._deductDivineSense(playerId, divineSenseCost, t);
            if (!senseResult.success) {
                await t.rollback();
                return { success: false, message: senseResult.message, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 灵石消耗
            const spiritStonesCost = BigInt(refineFlameCfg.spirit_stones_cost || 50000);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < spiritStonesCost) {
                await t.rollback();
                return { success: false, message: `灵石不足，需要 ${spiritStonesCost.toString()}，当前 ${playerStones.toString()}`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            player.spirit_stones = (playerStones - spiritStonesCost).toString();
            await player.save({ transaction: t });

            // 材料消耗（乾蓝寒髓）
            const materialKey = refineFlameCfg.material_key || 'qianlan_hansui';
            const materialCost = Number(refineFlameCfg.material_cost) || 2;
            const hasMaterial = await InventoryService.hasItem(playerId, materialKey, materialCost, t);
            if (!hasMaterial) {
                await t.rollback();
                return { success: false, message: `${this._getItemName(materialKey)}不足，需要 ${materialCost} 个`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            await InventoryService.removeItem(playerId, materialKey, materialCost, t);

            // 首次抽离：100%成功，获得乾蓝冰焰物品
            if (!state.flame_extracted) {
                state.flame_extracted = true;
                state.flame_stage = 1;
                state.last_refine_flame_at = new Date();
                equipment.deep_line_state = { ...equipment.deep_line_state, xutian_cauldron: state };
                equipment.changed('deep_line_state', true);
                await equipment.save({ transaction: t });
                // 发放乾蓝冰焰物品
                await InventoryService.addItem(playerId, cfg.flame_item_key || 'qianlan_bingyan', 1, t);
                await t.commit();

                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'xutian_flame_extracted', {
                        flame_stage: 1,
                        atk_bonus: flameStages[0]?.atk_bonus || 80
                    });
                } catch (wsErr) {
                    console.warn(`[ArtifactDeepLine] 推送 xutian_flame_extracted 通知失败: ${wsErr.message}`);
                }

                return {
                    success: true,
                    message: `成功从虚天鼎中抽离乾蓝冰焰！灵焰初生，攻击+${flameStages[0]?.atk_bonus || 80}`,
                    data: {
                        action: 'extract',
                        flame_stage: 1,
                        atk_bonus: flameStages[0]?.atk_bonus || 80,
                        consumed: { divine_sense: divineSenseCost, spirit_stones: spiritStonesCost.toString(), material: materialKey, material_cost: materialCost },
                        divine_sense_remaining: senseResult.current
                    }
                };
            }

            // 后续推进：成功率判定
            const currentFlameStageCfg = flameStages[state.flame_stage];
            const successRate = Number(currentFlameStageCfg?.success_rate) || 1.0;
            const isSuccess = Math.random() < successRate;

            if (isSuccess) {
                state.flame_stage += 1;
                state.last_refine_flame_at = new Date();
                equipment.deep_line_state = { ...equipment.deep_line_state, xutian_cauldron: state };
                equipment.changed('deep_line_state', true);
                await equipment.save({ transaction: t });
                await t.commit();

                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, 'xutian_flame_refined', {
                        new_stage: state.flame_stage,
                        atk_bonus: currentFlameStageCfg.atk_bonus
                    });
                } catch (wsErr) {
                    console.warn(`[ArtifactDeepLine] 推送 xutian_flame_refined 通知失败: ${wsErr.message}`);
                }

                return {
                    success: true,
                    message: `乾蓝冰焰推进成功！当前第${state.flame_stage}阶，攻击+${currentFlameStageCfg.atk_bonus}`,
                    data: {
                        action: 'refine',
                        old_stage: state.flame_stage - 1,
                        new_stage: state.flame_stage,
                        atk_bonus: currentFlameStageCfg.atk_bonus,
                        consumed: { divine_sense: divineSenseCost, spirit_stones: spiritStonesCost.toString(), material: materialKey, material_cost: materialCost },
                        divine_sense_remaining: senseResult.current
                    }
                };
            } else {
                state.last_refine_flame_at = new Date();
                equipment.deep_line_state = { ...equipment.deep_line_state, xutian_cauldron: state };
                equipment.changed('deep_line_state', true);
                await equipment.save({ transaction: t });
                await t.commit();

                return {
                    success: false,
                    message: `炼焰失败！灵焰波动不稳，材料已损毁。乾蓝冰焰仍停留在第${state.flame_stage}阶`,
                    error_code: ErrorCodes.BUSINESS_LOGIC_ERROR,
                    data: {
                        action: 'refine',
                        flame_stage: state.flame_stage,
                        consumed: { divine_sense: divineSenseCost, spirit_stones: spiritStonesCost.toString(), material: materialKey, material_cost: materialCost },
                        divine_sense_remaining: senseResult.current
                    }
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 化极进阶灵焰（玩法文档第19节：.法宝 化极 乾蓝冰焰）
     *
     * 条件：乾蓝冰焰≥7阶，未化极过
     * 两个不可逆选项：
     *   - ziluo_jihuo（紫罗极火）：攻击+50%，但每回合反噬自身气血5%
     *   - qianlan_bingyan（乾蓝冰焰强化）：攻击+20%，无反噬
     * 冷却：48h
     *
     * @param {number} playerId - 玩家ID
     * @param {string} polarity - 化极方向：ziluo_jihuo / qianlan_bingyan
     * @returns {Promise<Object>} 化极结果
     */
    static async polarizeFlame(playerId, polarity) {
        const VALID_POLARITIES = ['ziluo_jihuo', 'qianlan_bingyan'];
        if (!VALID_POLARITIES.includes(polarity)) {
            return { success: false, message: '化极方向无效，可选：ziluo_jihuo（紫罗极火）/ qianlan_bingyan（乾蓝冰焰强化）', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const cfg = this.getXutianCauldronConfig();
        if (!cfg.enabled || !cfg.polarize?.enabled) {
            return { success: false, message: '化极功能未开启', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                transaction: t,
                lock: t.LOCK.UPDATE,
                attributes: ['id', 'nickname', 'realm', 'realm_rank', 'is_dead', 'spirit_stones']
            });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在', error_code: ErrorCodes.NOT_FOUND };
            }
            if (player.is_dead) {
                await t.rollback();
                return { success: false, message: '已陨落，无法操作法宝', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            const equipment = await this._findXutianCauldronEquipment(playerId, t, true);
            if (!equipment) {
                await t.rollback();
                return { success: false, message: '未持有虚天鼎', error_code: ErrorCodes.NOT_FOUND };
            }

            const state = this._initXutianCauldronState(equipment);

            // 已化极校验（不可逆）
            if (state.flame_polarity !== 'none') {
                await t.rollback();
                return { success: false, message: `灵焰已化极为「${state.flame_polarity}」，此操作不可逆`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 未抽离灵焰校验
            if (!state.flame_extracted) {
                await t.rollback();
                return { success: false, message: '尚未抽离乾蓝冰焰，无法化极', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 灵焰阶数校验
            const minFlameStage = Number(cfg.polarize.min_flame_stage) || 7;
            if (state.flame_stage < minFlameStage) {
                await t.rollback();
                return { success: false, message: `乾蓝冰焰需达到第${minFlameStage}阶方可化极`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 冷却校验
            const cooldownSec = Number(cfg.polarize.cooldown_seconds) || 172800;
            if (state.last_polarize_at) {
                const lastMs = new Date(state.last_polarize_at).getTime();
                const elapsedSec = (Date.now() - lastMs) / 1000;
                if (elapsedSec < cooldownSec) {
                    await t.rollback();
                    const remaining = Math.ceil(cooldownSec - elapsedSec);
                    return { success: false, message: `化极冷却中，剩余 ${remaining} 秒`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
                }
            }

            // 神识消耗
            const divineSenseCost = Number(cfg.polarize.divine_sense_cost) || 500;
            const senseResult = await this._deductDivineSense(playerId, divineSenseCost, t);
            if (!senseResult.success) {
                await t.rollback();
                return { success: false, message: senseResult.message, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            // 灵石消耗
            const spiritStonesCost = BigInt(cfg.polarize.spirit_stones_cost || 200000);
            const playerStones = BigInt(player.spirit_stones || 0);
            if (playerStones < spiritStonesCost) {
                await t.rollback();
                return { success: false, message: `灵石不足，需要 ${spiritStonesCost.toString()}，当前 ${playerStones.toString()}`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            player.spirit_stones = (playerStones - spiritStonesCost).toString();
            await player.save({ transaction: t });

            // 材料消耗
            const materialKey = cfg.polarize.material_key || 'qianlan_hansui';
            const materialCost = Number(cfg.polarize.material_cost) || 10;
            const hasMaterial = await InventoryService.hasItem(playerId, materialKey, materialCost, t);
            if (!hasMaterial) {
                await t.rollback();
                return { success: false, message: `${this._getItemName(materialKey)}不足，需要 ${materialCost} 个`, error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }
            await InventoryService.removeItem(playerId, materialKey, materialCost, t);

            // 执行化极（100%成功，化极本身不失败）
            const polarizeOption = cfg.polarize.options?.[polarity];
            if (!polarizeOption) {
                await t.rollback();
                return { success: false, message: '化极方向配置异常', error_code: ErrorCodes.BUSINESS_LOGIC_ERROR };
            }

            state.flame_polarity = polarity;
            state.last_polarize_at = new Date();
            equipment.deep_line_state = { ...equipment.deep_line_state, xutian_cauldron: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            // 紫罗极火路线：发放紫罗极火物品（替换乾蓝冰焰）
            if (polarity === 'ziluo_jihuo') {
                // 移除乾蓝冰焰，发放紫罗极火
                const currentFlameQty = await InventoryService.getItemQuantity(playerId, cfg.flame_item_key || 'qianlan_bingyan');
                if (currentFlameQty > 0) {
                    await InventoryService.removeItem(playerId, cfg.flame_item_key || 'qianlan_bingyan', currentFlameQty, t);
                }
                await InventoryService.addItem(playerId, cfg.polarized_flame_item_key || 'ziluo_jihuo', 1, t);
            }

            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'xutian_flame_polarized', {
                    polarity: polarity,
                    polarity_name: polarizeOption.name,
                    atk_multiplier: polarizeOption.atk_multiplier,
                    backlash_rate: polarizeOption.backlash_rate_per_round
                });
            } catch (wsErr) {
                console.warn(`[ArtifactDeepLine] 推送 xutian_flame_polarized 通知失败: ${wsErr.message}`);
            }

            return {
                success: true,
                message: `化极成功！灵焰化为「${polarizeOption.name}」：${polarizeOption.description}`,
                data: {
                    polarity: polarity,
                    polarity_name: polarizeOption.name,
                    atk_multiplier: polarizeOption.atk_multiplier,
                    backlash_rate_per_round: polarizeOption.backlash_rate_per_round,
                    backlash_target: polarizeOption.backlash_target,
                    consumed: {
                        divine_sense: divineSenseCost,
                        spirit_stones: spiritStonesCost.toString(),
                        material_key: materialKey,
                        material_cost: materialCost
                    },
                    divine_sense_remaining: senseResult.current
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            throw err;
        }
    }

    /**
     * 供战斗系统调用：获取玩家虚天鼎战力加成
     * 战斗系统在计算玩家总战力时调用此方法，叠加虚天鼎的 def/atk 加成
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 战力加成对象（无虚天鼎时返回 is_active=false 的默认值）
     */
    static async getXutianCauldronCombatBonus(playerId) {
        const equipment = await this._findXutianCauldronEquipment(playerId);
        if (!equipment) {
            return { is_active: false, reason: '未持有虚天鼎' };
        }

        const state = this._initXutianCauldronState(equipment);
        const cfg = this.getXutianCauldronConfig();
        return this._calculateXutianCombatBonus(state, cfg);
    }

    // ==================== 掌天瓶线（玩法文档第19节·法宝深线第三条） ====================

    /**
     * 读取掌天瓶线配置
     * @returns {Object} 掌天瓶线配置
     */
    static getSkyBottleConfig() {
        return this.getDeepLineConfig().sky_bottle || {};
    }

    /**
     * 掌天瓶默认状态（首次访问时初始化）
     * 绿液量 + 各功能冷却 + 4 条材料线成长度
     */
    static get DEFAULT_SKY_BOTTLE_STATE() {
        return {
            green_liquid: 0,                  // 当前绿液量 0~1000
            last_condense_at: null,           // 上次凝液时间（6h 冷却）
            last_alchemy_at: null,            // 上次炼丹时间（2h 冷却）
            last_garden_at: null,             // 上次药园施术时间（12h 冷却）
            last_star_platform_at: null,      // 上次星台施术时间（12h 冷却）
            bamboo_growth: 0,                 // 天雷竹成长度 0~100
            last_nurture_bamboo_at: null,     // 上次养竹时间（4h 冷却）
            last_transform_bamboo_at: null,   // 上次化竹时间（4h 冷却）
            soul_wood_growth: 0,              // 养魂木成长度 0~100
            last_nurture_wood_at: null,       // 上次养木时间（24h 冷却）
            spirit_tree_growth: 0,            // 灵眼树成长度 0~100
            last_nurture_tree_at: null        // 上次养树时间（48h 冷却）
        };
    }

    /**
     * 初始化掌天瓶状态（首次访问时创建默认状态，向后兼容补全字段）
     * @param {Object} equipment - PlayerEquipment 实例
     * @returns {Object} 初始化后的掌天瓶状态
     */
    static _initSkyBottleState(equipment) {
        const deepLine = equipment.deep_line_state || {};
        if (!deepLine.sky_bottle) {
            // 首次初始化：创建新顶层对象确保 Sequelize 检测变更
            equipment.deep_line_state = { ...deepLine, sky_bottle: { ...this.DEFAULT_SKY_BOTTLE_STATE } };
        } else {
            // 补全可能缺失的字段（向后兼容旧数据），同样创建新顶层对象
            equipment.deep_line_state = {
                ...deepLine,
                sky_bottle: { ...this.DEFAULT_SKY_BOTTLE_STATE, ...deepLine.sky_bottle }
            };
        }
        return equipment.deep_line_state.sky_bottle;
    }

    /**
     * 查找玩家已装备的掌天瓶记录
     * @param {number} playerId - 玩家ID
     * @param {Object} [t] - 事务实例（可选）
     * @param {boolean} [lock=false] - 是否加行级锁
     * @returns {Promise<Object|null>} PlayerEquipment 实例
     */
    static async _findSkyBottleEquipment(playerId, t = null, lock = false) {
        const cfg = this.getSkyBottleConfig();
        const query = {
            where: {
                player_id: playerId,
                item_key: cfg.item_key
            }
        };
        if (t) {
            query.transaction = t;
            if (lock) query.lock = t.LOCK.UPDATE;
        }
        return await PlayerEquipment.findOne(query);
    }

    /**
     * 计算冷却剩余秒数的通用方法
     * @param {string|null} lastTime - 上次操作时间
     * @param {number} cooldownMs - 冷却毫秒数
     * @returns {number} 剩余秒数（0 表示已冷却完毕）
     */
    static _calcCooldownRemaining(lastTime, cooldownMs) {
        if (!lastTime) return 0;
        const lastMs = new Date(lastTime).getTime();
        if (isNaN(lastMs)) return 0;
        const remaining = cooldownMs - (Date.now() - lastMs);
        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }

    /**
     * 获取掌天瓶完整状态快照（玩法文档第19节：掌天瓶线）
     *
     * 返回字段说明：
     *   - has_sky_bottle: 是否拥有掌天瓶
     *   - green_liquid: 当前绿液量
     *   - green_liquid_max: 绿液上限
     *   - 各功能冷却剩余秒数
     *   - 材料线成长度（bamboo/soul_wood/spirit_tree）
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 掌天瓶状态快照
     */
    static async getSkyBottleStatus(playerId) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank', 'is_dead']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getSkyBottleConfig();
        const equipment = await this._findSkyBottleEquipment(playerId);

        // 未装备掌天瓶
        if (!equipment) {
            return {
                has_sky_bottle: false,
                item_key: cfg.item_key,
                item_name: cfg.item_name,
                min_realm_rank: cfg.min_realm_rank,
                player_realm: player.realm,
                player_realm_rank: player.realm_rank,
                meets_realm: (player.realm_rank || 0) >= (cfg.min_realm_rank || 19),
                source_hint: '掌天瓶来自上古遗留，可通过虚天殿副本或按图索骥获取',
                config: this._extractSkyBottleConfigSummary(cfg)
            };
        }

        // 已装备：初始化状态并返回完整快照
        const state = this._initSkyBottleState(equipment);
        if (equipment.changed('deep_line_state')) {
            await equipment.save();
        }

        return {
            has_sky_bottle: true,
            item_key: cfg.item_key,
            item_name: cfg.item_name,
            equipment_id: equipment.id,
            slot: equipment.slot,
            // 绿液
            green_liquid: state.green_liquid,
            green_liquid_max: cfg.green_liquid?.max || 1000,
            // 冷却剩余
            condense_cooldown_remaining: this._calcCooldownRemaining(state.last_condense_at, (cfg.green_liquid?.condense?.cooldown_seconds || 21600) * 1000),
            alchemy_cooldown_remaining: this._calcCooldownRemaining(state.last_alchemy_at, (cfg.alchemy?.cooldown_seconds || 7200) * 1000),
            garden_cooldown_remaining: this._calcCooldownRemaining(state.last_garden_at, (cfg.garden?.cooldown_seconds || 43200) * 1000),
            star_platform_cooldown_remaining: this._calcCooldownRemaining(state.last_star_platform_at, (cfg.star_platform?.cooldown_seconds || 43200) * 1000),
            nurture_bamboo_cooldown_remaining: this._calcCooldownRemaining(state.last_nurture_bamboo_at, (cfg.bamboo?.nurture?.cooldown_seconds || 14400) * 1000),
            transform_bamboo_cooldown_remaining: this._calcCooldownRemaining(state.last_transform_bamboo_at, (cfg.bamboo?.transform?.cooldown_seconds || 14400) * 1000),
            nurture_wood_cooldown_remaining: this._calcCooldownRemaining(state.last_nurture_wood_at, (cfg.soul_wood?.cooldown_seconds || 86400) * 1000),
            nurture_tree_cooldown_remaining: this._calcCooldownRemaining(state.last_nurture_tree_at, (cfg.spirit_tree?.cooldown_seconds || 172800) * 1000),
            // 材料线成长度
            bamboo_growth: state.bamboo_growth,
            bamboo_max_growth: cfg.bamboo?.nurture?.max_growth || 100,
            soul_wood_growth: state.soul_wood_growth,
            soul_wood_max_growth: cfg.soul_wood?.max_growth || 100,
            spirit_tree_growth: state.spirit_tree_growth,
            spirit_tree_max_growth: cfg.spirit_tree?.max_growth || 100,
            // 配置回显
            config: this._extractSkyBottleConfigSummary(cfg),
            server_time: Date.now()
        };
    }

    /**
     * 提取掌天瓶配置摘要（用于状态接口回显）
     * @param {Object} cfg - 掌天瓶配置
     * @returns {Object} 配置摘要
     */
    static _extractSkyBottleConfigSummary(cfg) {
        return {
            condense: {
                cooldown_seconds: cfg.green_liquid?.condense?.cooldown_seconds || 21600,
                base_amount: cfg.green_liquid?.condense?.base_amount || 10,
                realm_bonus_per_rank: cfg.green_liquid?.condense?.realm_bonus_per_rank || 2
            },
            alchemy: {
                cooldown_seconds: cfg.alchemy?.cooldown_seconds || 7200,
                stable_cost: cfg.alchemy?.stable?.green_liquid_cost || 50,
                variable_cost: cfg.alchemy?.variable?.green_liquid_cost || 30,
                stable_success_rate: cfg.alchemy?.stable?.success_rate || 1.0,
                variable_success_rate: cfg.alchemy?.variable?.success_rate || 0.6,
                variable_bonus_rate: cfg.alchemy?.variable?.quality_bonus_rate || 0.2
            },
            garden: {
                cooldown_seconds: cfg.garden?.cooldown_seconds || 43200,
                green_liquid_cost: cfg.garden?.green_liquid_cost || 80,
                yield_bonus_rate: cfg.garden?.yield_bonus_rate || 0.2,
                required_sect: cfg.garden?.required_sect || 'huangfeng'
            },
            star_platform: {
                cooldown_seconds: cfg.star_platform?.cooldown_seconds || 43200,
                green_liquid_cost: cfg.star_platform?.green_liquid_cost || 100,
                reward_bonus_rate: cfg.star_platform?.reward_bonus_rate || 0.15,
                required_sect: cfg.star_platform?.required_sect || 'xinggong'
            },
            bamboo: {
                nurture_cost: cfg.bamboo?.nurture?.green_liquid_cost || 40,
                transform_cost: cfg.bamboo?.transform?.green_liquid_cost || 60,
                growth_per_action: cfg.bamboo?.nurture?.growth_per_action || 10,
                max_growth: cfg.bamboo?.nurture?.max_growth || 100
            },
            soul_wood: {
                cooldown_seconds: cfg.soul_wood?.cooldown_seconds || 86400,
                green_liquid_cost: cfg.soul_wood?.green_liquid_cost || 200,
                growth_per_action: cfg.soul_wood?.growth_per_action || 5
            },
            spirit_tree: {
                cooldown_seconds: cfg.spirit_tree?.cooldown_seconds || 172800,
                green_liquid_cost: cfg.spirit_tree?.green_liquid_cost || 500,
                growth_per_action: cfg.spirit_tree?.growth_per_action || 3
            }
        };
    }

    /**
     * 凝液：聚集掌天绿液
     * 6h 冷却，绿液量 = 基础值 + 境界加成
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 凝液结果
     */
    static async condenseLiquid(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                attributes: ['id', 'realm_rank', 'is_dead'],
                transaction: t, lock: t.LOCK.UPDATE
            });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('玩家已死亡，无法操作', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findSkyBottleEquipment(playerId, t, true);
            if (!equipment) throw new AppError('未装备掌天瓶', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const state = this._initSkyBottleState(equipment);
            const cfg = this.getSkyBottleConfig();

            // 冷却检查
            const cooldownSec = cfg.green_liquid?.condense?.cooldown_seconds || 21600;
            const remaining = this._calcCooldownRemaining(state.last_condense_at, cooldownSec * 1000);
            if (remaining > 0) {
                await t.rollback();
                return { success: false, message: `凝液冷却中，剩余 ${remaining} 秒` };
            }

            // 计算绿液量 = 基础值 + 境界加成
            const baseAmount = cfg.green_liquid?.condense?.base_amount || 10;
            const realmBonus = (cfg.green_liquid?.condense?.realm_bonus_per_rank || 2) * Math.max(0, (player.realm_rank || 0) - 18);
            const liquidGain = baseAmount + realmBonus;
            const maxLiquid = cfg.green_liquid?.max || 1000;

            // 累加绿液（不超过上限）
            const oldLiquid = state.green_liquid;
            const newLiquid = Math.min(oldLiquid + liquidGain, maxLiquid);
            const actualGain = newLiquid - oldLiquid;

            state.green_liquid = newLiquid;
            state.last_condense_at = new Date().toISOString();

            // 保存（整体赋值 + 显式覆盖 sky_bottle 确保 get()/set() 自定义访问器正确持久化修改）
            equipment.deep_line_state = { ...equipment.deep_line_state, sky_bottle: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'sky_bottle_condensed', {
                    green_liquid: newLiquid,
                    gain: actualGain
                });
            } catch (wsErr) {
                console.warn(`[ArtifactDeepLine] 推送 sky_bottle_condensed 通知失败: ${wsErr.message}`);
            }

            return {
                success: true,
                message: `凝液成功！获得 ${actualGain} 点掌天绿液（基础${baseAmount}+境界${realmBonus}），当前 ${newLiquid}/${maxLiquid}`,
                data: {
                    green_liquid: newLiquid,
                    green_liquid_max: maxLiquid,
                    gain: actualGain,
                    base_amount: baseAmount,
                    realm_bonus: realmBonus
                }
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 炼丹：稳定/变丹两种模式
     * 2h 冷却，消耗绿液 + 产出丹药
     *
     * @param {number} playerId - 玩家ID
     * @param {string} mode - 炼丹模式：stable(稳定) / variable(变丹)
     * @param {string} pillKey - 目标丹药 item_key
     * @returns {Promise<Object>} 炼丹结果
     */
    static async alchemy(playerId, mode, pillKey) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                attributes: ['id', 'realm_rank', 'is_dead'],
                transaction: t, lock: t.LOCK.UPDATE
            });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('玩家已死亡，无法操作', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findSkyBottleEquipment(playerId, t, true);
            if (!equipment) throw new AppError('未装备掌天瓶', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const state = this._initSkyBottleState(equipment);
            const cfg = this.getSkyBottleConfig();

            // 冷却检查
            const cooldownSec = cfg.alchemy?.cooldown_seconds || 7200;
            const remaining = this._calcCooldownRemaining(state.last_alchemy_at, cooldownSec * 1000);
            if (remaining > 0) {
                await t.rollback();
                return { success: false, message: `炼丹冷却中，剩余 ${remaining} 秒` };
            }

            // 获取模式配置
            const modeCfg = mode === 'stable' ? cfg.alchemy?.stable : cfg.alchemy?.variable;
            if (!modeCfg) throw new AppError('炼丹模式无效', 400, ErrorCodes.VALIDATION_ERROR);

            // 绿液检查
            const cost = modeCfg.green_liquid_cost || 50;
            if (state.green_liquid < cost) {
                await t.rollback();
                return { success: false, message: `绿液不足，需要 ${cost}，当前 ${state.green_liquid}` };
            }

            // 丹药白名单检查
            const supportedPills = cfg.alchemy?.supported_pills || [];
            if (!supportedPills.includes(pillKey)) {
                await t.rollback();
                return { success: false, message: `不支持炼制此丹药：${pillKey}` };
            }

            // 扣减绿液
            state.green_liquid -= cost;

            // 成功率判定
            const successRate = modeCfg.success_rate || 1.0;
            const isSuccess = Math.random() < successRate;

            let resultMessage = '';
            let outputKey = pillKey;
            let outputQty = 1;
            let isBonus = false;

            if (!isSuccess) {
                resultMessage = `炼丹失败！绿液消耗 ${cost}，未产出丹药`;
            } else {
                // 变丹模式：检查品质加成
                if (mode === 'variable') {
                    const bonusRate = modeCfg.quality_bonus_rate || 0.2;
                    if (Math.random() < bonusRate) {
                        isBonus = true;
                        outputQty = 2; // 变丹产出 2 颗
                        resultMessage = `变丹成功！产出 ${outputQty} 颗丹药（机缘加成）`;
                    } else {
                        resultMessage = `炼丹成功！产出 1 颗丹药`;
                    }
                } else {
                    resultMessage = `稳定炼丹成功！产出 1 颗丹药`;
                }

                // 发放丹药
                await InventoryService.addItem(playerId, outputKey, outputQty, t);
            }

            state.last_alchemy_at = new Date().toISOString();
            equipment.deep_line_state = { ...equipment.deep_line_state, sky_bottle: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'sky_bottle_alchemy', {
                    mode, success: isSuccess, is_bonus: isBonus,
                    pill_key: outputKey, pill_qty: outputQty,
                    green_liquid_remaining: state.green_liquid
                });
            } catch (wsErr) {
                console.warn(`[ArtifactDeepLine] 推送 sky_bottle_alchemy 通知失败: ${wsErr.message}`);
            }

            return {
                success: isSuccess,
                message: resultMessage,
                data: {
                    mode,
                    is_bonus: isBonus,
                    pill_key: isSuccess ? outputKey : null,
                    pill_qty: isSuccess ? outputQty : 0,
                    green_liquid_remaining: state.green_liquid,
                    consumed: { green_liquid: cost }
                }
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 通用：绿液消耗 + 冷却更新 + 状态保存的辅助方法
     * 用于药园/星台/养竹/化竹/养木/养树等操作
     *
     * @param {number} playerId - 玩家ID
     * @param {Object} options - 操作选项
     * @param {string} options.opName - 操作名称（用于日志）
     * @param {string} options.cooldownField - 状态中的冷却字段名
     * @param {number} options.cooldownSec - 冷却秒数
     * @param {number} options.greenLiquidCost - 绿液消耗
     * @param {Function} options.onSuccess - 成功时的回调（在事务内，返回额外数据）
     * @returns {Promise<Object>} 操作结果
     */
    static async _executeSkyBottleOp(playerId, options) {
        const { opName, cooldownField, cooldownSec, greenLiquidCost, onSuccess } = options;
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                attributes: ['id', 'realm_rank', 'is_dead'],
                transaction: t, lock: t.LOCK.UPDATE
            });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('玩家已死亡，无法操作', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findSkyBottleEquipment(playerId, t, true);
            if (!equipment) throw new AppError('未装备掌天瓶', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const state = this._initSkyBottleState(equipment);

            // 冷却检查
            const remaining = this._calcCooldownRemaining(state[cooldownField], cooldownSec * 1000);
            if (remaining > 0) {
                await t.rollback();
                return { success: false, message: `${opName}冷却中，剩余 ${remaining} 秒` };
            }

            // 绿液检查
            if (state.green_liquid < greenLiquidCost) {
                await t.rollback();
                return { success: false, message: `绿液不足，需要 ${greenLiquidCost}，当前 ${state.green_liquid}` };
            }

            // 扣减绿液
            state.green_liquid -= greenLiquidCost;

            // 执行操作特定逻辑
            const extraData = onSuccess ? await onSuccess(state, player, t) : {};

            // 更新冷却时间
            state[cooldownField] = new Date().toISOString();

            // 保存（显式覆盖 sky_bottle 确保 get()/set() 自定义访问器正确持久化修改）
            equipment.deep_line_state = { ...equipment.deep_line_state, sky_bottle: state };
            equipment.changed('deep_line_state', true);
            await equipment.save({ transaction: t });

            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, `sky_bottle_${opName}`, {
                    green_liquid_remaining: state.green_liquid,
                    ...extraData
                });
            } catch (wsErr) {
                console.warn(`[ArtifactDeepLine] 推送 sky_bottle_${opName} 通知失败: ${wsErr.message}`);
            }

            return {
                success: true,
                message: extraData.message || `${opName}成功`,
                data: {
                    green_liquid_remaining: state.green_liquid,
                    consumed: { green_liquid: greenLiquidCost },
                    ...extraData
                }
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 药园施术：对灵田施术提升产量
     * 12h 冷却，需黄枫谷宗门
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 施术结果
     */
    static async gardenBoost(playerId) {
        const cfg = this.getSkyBottleConfig();
        const gardenCfg = cfg.garden || {};
        const requiredSect = gardenCfg.required_sect || 'huangfeng';

        return await this._executeSkyBottleOp(playerId, {
            opName: '药园施术',
            cooldownField: 'last_garden_at',
            cooldownSec: gardenCfg.cooldown_seconds || 43200,
            greenLiquidCost: gardenCfg.green_liquid_cost || 80,
            onSuccess: async (state, player, t) => {
                // 宗门检查：从 PlayerSect 表查询玩家所属宗门（Player 模型无 sect_id 字段）
                const playerSect = await PlayerSect.findOne({
                    where: { player_id: playerId },
                    transaction: t
                });
                if (!playerSect || playerSect.sect_id !== requiredSect) {
                    throw new AppError(`需加入${requiredSect === 'huangfeng' ? '黄枫谷' : requiredSect}宗门方可施术药园`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                return {
                    message: `药园施术成功！灵田产量提升 ${(gardenCfg.yield_bonus_rate || 0.2) * 100}%`,
                    yield_bonus_rate: gardenCfg.yield_bonus_rate || 0.2,
                    sect: requiredSect
                };
            }
        });
    }

    /**
     * 星台施术：对观星台施术提升任务奖励
     * 12h 冷却，需星宫宗门
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 施术结果
     */
    static async starPlatformBoost(playerId) {
        const cfg = this.getSkyBottleConfig();
        const starCfg = cfg.star_platform || {};
        const requiredSect = starCfg.required_sect || 'xinggong';

        return await this._executeSkyBottleOp(playerId, {
            opName: '星台施术',
            cooldownField: 'last_star_platform_at',
            cooldownSec: starCfg.cooldown_seconds || 43200,
            greenLiquidCost: starCfg.green_liquid_cost || 100,
            onSuccess: async (state, player, t) => {
                // 宗门检查：从 PlayerSect 表查询玩家所属宗门（Player 模型无 sect_id 字段）
                const playerSect = await PlayerSect.findOne({
                    where: { player_id: playerId },
                    transaction: t
                });
                if (!playerSect || playerSect.sect_id !== requiredSect) {
                    throw new AppError(`需加入${requiredSect === 'xinggong' ? '星宫' : requiredSect}宗门方可施术星台`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                return {
                    message: `星台施术成功！星宫任务奖励提升 ${(starCfg.reward_bonus_rate || 0.15) * 100}%`,
                    reward_bonus_rate: starCfg.reward_bonus_rate || 0.15,
                    sect: requiredSect
                };
            }
        });
    }

    /**
     * 养竹：推进天雷竹成长度
     * 4h 冷却，每次成长 +10，满 100 可化竹
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 养竹结果
     */
    static async nurtureBamboo(playerId) {
        const cfg = this.getSkyBottleConfig();
        const nurtureCfg = cfg.bamboo?.nurture || {};

        return await this._executeSkyBottleOp(playerId, {
            opName: '养竹',
            cooldownField: 'last_nurture_bamboo_at',
            cooldownSec: nurtureCfg.cooldown_seconds || 14400,
            greenLiquidCost: nurtureCfg.green_liquid_cost || 40,
            onSuccess: async (state, player, t) => {
                const maxGrowth = nurtureCfg.max_growth || 100;
                const growthPerAction = nurtureCfg.growth_per_action || 10;
                const oldGrowth = state.bamboo_growth;
                const newGrowth = Math.min(oldGrowth + growthPerAction, maxGrowth);
                state.bamboo_growth = newGrowth;

                const isReady = newGrowth >= maxGrowth;
                return {
                    message: `养竹成功！天雷竹成长度 ${oldGrowth}→${newGrowth}/${maxGrowth}${isReady ? '（已成熟，可化竹）' : ''}`,
                    bamboo_growth: newGrowth,
                    bamboo_max_growth: maxGrowth,
                    is_ready: isReady
                };
            }
        });
    }

    /**
     * 化竹：将成熟天雷竹转化为天雷竹材料
     * 4h 冷却，需成长度≥100，产出天雷竹×1
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 化竹结果
     */
    static async transformBamboo(playerId) {
        const cfg = this.getSkyBottleConfig();
        const transformCfg = cfg.bamboo?.transform || {};

        return await this._executeSkyBottleOp(playerId, {
            opName: '化竹',
            cooldownField: 'last_transform_bamboo_at',
            cooldownSec: transformCfg.cooldown_seconds || 14400,
            greenLiquidCost: transformCfg.green_liquid_cost || 60,
            onSuccess: async (state, player, t) => {
                const minGrowth = transformCfg.min_growth_required || 100;
                if (state.bamboo_growth < minGrowth) {
                    throw new AppError(`天雷竹成长度不足，需要 ${minGrowth}，当前 ${state.bamboo_growth}`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
                }
                // 重置成长度
                state.bamboo_growth = 0;
                // 发放天雷竹
                const outputKey = transformCfg.output_key || 'tianlei_bamboo';
                const outputQty = transformCfg.output_quantity || 1;
                await InventoryService.addItem(playerId, outputKey, outputQty, t);

                return {
                    message: `化竹成功！获得 ${outputQty} 个天雷竹`,
                    output_key: outputKey,
                    output_qty: outputQty,
                    bamboo_growth: 0
                };
            }
        });
    }

    /**
     * 养木：推进万年养魂木成长度
     * 24h 冷却，每次成长 +5，满 100 获得万年养魂木×1
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 养木结果
     */
    static async nurtureSoulWood(playerId) {
        const cfg = this.getSkyBottleConfig();
        const woodCfg = cfg.soul_wood || {};

        return await this._executeSkyBottleOp(playerId, {
            opName: '养木',
            cooldownField: 'last_nurture_wood_at',
            cooldownSec: woodCfg.cooldown_seconds || 86400,
            greenLiquidCost: woodCfg.green_liquid_cost || 200,
            onSuccess: async (state, player, t) => {
                const maxGrowth = woodCfg.max_growth || 100;
                const growthPerAction = woodCfg.growth_per_action || 5;
                const oldGrowth = state.soul_wood_growth;
                const newGrowth = Math.min(oldGrowth + growthPerAction, maxGrowth);
                state.soul_wood_growth = newGrowth;

                // 满 100 自动产出万年养魂木
                let outputKey = null;
                let outputQty = 0;
                let message = `养木成功！养魂木成长度 ${oldGrowth}→${newGrowth}/${maxGrowth}`;

                if (newGrowth >= maxGrowth) {
                    state.soul_wood_growth = 0;
                    outputKey = woodCfg.output_key || 'soul_nurturing_wood';
                    outputQty = woodCfg.output_quantity || 1;
                    await InventoryService.addItem(playerId, outputKey, outputQty, t);
                    message = `养木成熟！获得 ${outputQty} 个万年养魂木，成长度重置`;
                }

                return {
                    message,
                    soul_wood_growth: state.soul_wood_growth,
                    soul_wood_max_growth: maxGrowth,
                    output_key: outputKey,
                    output_qty: outputQty
                };
            }
        });
    }

    /**
     * 养树：推进灵眼之树成长度
     * 48h 冷却，每次成长 +3，满 100 获得灵眼之树×1
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 养树结果
     */
    static async nurtureSpiritTree(playerId) {
        const cfg = this.getSkyBottleConfig();
        const treeCfg = cfg.spirit_tree || {};

        return await this._executeSkyBottleOp(playerId, {
            opName: '养树',
            cooldownField: 'last_nurture_tree_at',
            cooldownSec: treeCfg.cooldown_seconds || 172800,
            greenLiquidCost: treeCfg.green_liquid_cost || 500,
            onSuccess: async (state, player, t) => {
                const maxGrowth = treeCfg.max_growth || 100;
                const growthPerAction = treeCfg.growth_per_action || 3;
                const oldGrowth = state.spirit_tree_growth;
                const newGrowth = Math.min(oldGrowth + growthPerAction, maxGrowth);
                state.spirit_tree_growth = newGrowth;

                // 满 100 自动产出灵眼之树
                let outputKey = null;
                let outputQty = 0;
                let message = `养树成功！灵眼树成长度 ${oldGrowth}→${newGrowth}/${maxGrowth}`;

                if (newGrowth >= maxGrowth) {
                    state.spirit_tree_growth = 0;
                    outputKey = treeCfg.output_key || 'spirit_eye_tree';
                    outputQty = treeCfg.output_quantity || 1;
                    await InventoryService.addItem(playerId, outputKey, outputQty, t);
                    message = `灵眼树成熟！获得 ${outputQty} 个灵眼之树，成长度重置`;
                }

                return {
                    message,
                    spirit_tree_growth: state.spirit_tree_growth,
                    spirit_tree_max_growth: maxGrowth,
                    output_key: outputKey,
                    output_qty: outputQty
                };
            }
        });
    }

    // ========== 大五行幻世轮线（玩法文档第19节·法宝深线第四条） ==========
    // 设计差异化：唯一一条"被动战斗驱动成长"的法宝深线
    //   - 不消耗材料/灵石，通过祭出后斗法自动积累悟印经验
    //   - 五行定相系统（6 相位）+ 五行相生相克联动
    //   - 轮转技能（5 阶解锁，战斗中自动切换相位）
    //   - 与血魔剑(战斗向主动) / 虚天鼎(战斗向主动) / 掌天瓶(辅助向主动) 形成完整差异化矩阵

    /**
     * 读取大五行幻世轮线配置
     * @returns {Object} 大五行幻世轮线配置
     */
    static getFiveElementWheelConfig() {
        return this.getDeepLineConfig().five_element_wheel || {};
    }

    /**
     * 大五行幻世轮默认状态（首次访问时初始化）
     * 字段含义：
     *   - insight_stage: 悟印阶数 0~10
     *   - insight_exp: 当前悟印经验（累计值，不随升阶重置）
     *   - daily_insight_gained: 今日已获悟印经验（每日上限 100）
     *   - daily_insight_reset_at: 每日重置日期（YYYY-MM-DD，UTC 0 点重置）
     *   - current_phase: 当前定相 rotation/metal/water/wood/fire/earth
     *   - last_set_phase_at: 上次定相时间（7 天冷却）
     *   - wheel_spin_enabled: 轮转技能是否开启（5 阶解锁）
     *   - total_battles: 累计战斗场次（统计用）
     *   - total_insight_gained: 累计悟印获取总量（统计用）
     */
    static get DEFAULT_WHEEL_STATE() {
        return {
            insight_stage: 0,
            insight_exp: 0,
            daily_insight_gained: 0,
            daily_insight_reset_at: null,
            current_phase: 'rotation',
            last_set_phase_at: null,
            wheel_spin_enabled: false,
            total_battles: 0,
            total_insight_gained: 0
        };
    }

    /**
     * 初始化大五行幻世轮状态（首次访问时创建默认状态）
     * 注意：因 deep_line_state 有自定义 get()/set() 访问器，必须创建新顶层对象确保 Sequelize 检测变更
     * @param {Object} equipment - PlayerEquipment 实例
     * @returns {Object} 初始化后的幻世轮状态
     */
    static _initWheelState(equipment) {
        const deepLine = equipment.deep_line_state || {};
        if (!deepLine.five_element_wheel) {
            // 首次初始化：创建新顶层对象确保 Sequelize 检测变更
            const today = new Date().toISOString().slice(0, 10);
            equipment.deep_line_state = {
                ...deepLine,
                five_element_wheel: {
                    ...this.DEFAULT_WHEEL_STATE,
                    daily_insight_reset_at: today
                }
            };
        } else {
            // 补全可能缺失的字段（向后兼容旧数据），同样创建新顶层对象
            equipment.deep_line_state = {
                ...deepLine,
                five_element_wheel: { ...this.DEFAULT_WHEEL_STATE, ...deepLine.five_element_wheel }
            };
        }
        return equipment.deep_line_state.five_element_wheel;
    }

    /**
     * 查找玩家已装备的大五行幻世轮记录
     * @param {number} playerId - 玩家ID
     * @param {Object} [t] - 事务实例（可选）
     * @param {boolean} [lock=false] - 是否加行级锁
     * @returns {Promise<Object|null>} PlayerEquipment 实例
     */
    static async _findWheelEquipment(playerId, t = null, lock = false) {
        const cfg = this.getFiveElementWheelConfig();
        const query = {
            where: {
                player_id: playerId,
                item_key: cfg.item_key
            }
        };
        if (t) {
            query.transaction = t;
            if (lock) query.lock = t.LOCK.UPDATE;
        }
        return await PlayerEquipment.findOne(query);
    }

    /**
     * 每日悟印上限重置（若已跨日）
     * @param {Object} state - 幻世轮状态对象（会被原地修改）
     * @param {Object} cfg - 幻世轮配置
     */
    static _resetDailyInsightIfNeeded(state, cfg) {
        const today = new Date().toISOString().slice(0, 10);
        if (state.daily_insight_reset_at !== today) {
            state.daily_insight_gained = 0;
            state.daily_insight_reset_at = today;
        }
    }

    /**
     * 五行相克判定
     * @param {string} myPhase - 我方相位 rotation/metal/water/wood/fire/earth
     * @param {string} opponentPhase - 对手相位（可能未知，传 null 视为 neutral）
     * @param {Object} cfg - 幻世轮配置
     * @returns {string} 'advantage'(我克敌) / 'disadvantage'(敌克我) / 'neutral'(无克制)
     */
    static _checkPhaseAdvantage(myPhase, opponentPhase, cfg) {
        // 轮转不受克制，也不会克制别人
        if (!opponentPhase || myPhase === 'rotation' || opponentPhase === 'rotation') {
            return 'neutral';
        }
        const overcomes = cfg.element_relations?.overcomes || {};
        // 金克木、木克土、土克水、水克火、火克金
        if (overcomes[myPhase] === opponentPhase) {
            return 'advantage';
        }
        if (overcomes[opponentPhase] === myPhase) {
            return 'disadvantage';
        }
        return 'neutral';
    }

    /**
     * 计算当前相位战力加成（供战斗系统和状态查询共用）
     * 加成 = 相位基础加成 × 当前阶数倍率（phase_multiplier）
     * @param {Object} state - 幻世轮状态
     * @param {Object} cfg - 幻世轮配置
     * @returns {Object} { phase, phase_name, multiplier, bonus }
     */
    static _calculatePhaseBonus(state, cfg) {
        const phase = state.current_phase || 'rotation';
        const phaseCfg = cfg.phases?.[phase] || cfg.phases?.rotation || {};
        const stages = cfg.stages || [];
        const currentStage = stages.find(s => s.stage === state.insight_stage);
        const multiplier = currentStage?.phase_multiplier || 1.0;

        // 基础加成 × 阶数倍率
        const bonus = {};
        for (const [key, value] of Object.entries(phaseCfg)) {
            // 跳过非数值字段（name/description/comment）
            if (typeof value === 'number') {
                bonus[key] = Math.round(value * multiplier * 10000) / 10000; // 保留4位小数
            }
        }
        return { phase, phase_name: phaseCfg.name || '轮转', multiplier, bonus };
    }

    /**
     * 获取大五行幻世轮状态（玩法文档第19节：.幻世轮 / .大五行幻世轮）
     *
     * 返回字段说明：
     *   - has_wheel: 是否拥有大五行幻世轮（已装备）
     *   - insight_stage: 当前悟印阶数 0~10
     *   - insight_stage_name: 当前阶数名（"初悟五行"等）
     *   - insight_exp: 当前悟印经验
     *   - next_stage_required: 下一阶所需经验（满阶返回 null）
     *   - current_phase: 当前定相
     *   - current_phase_name: 当前定相中文名
     *   - daily_insight_gained / daily_insight_limit: 今日已获/上限
     *   - set_phase_cooldown_remaining: 定相冷却剩余秒数
     *   - wheel_spin_enabled: 轮转技能是否开启
     *   - wheel_spin_unlocked: 轮转技能是否已解锁（5阶）
     *   - combat_bonus: 当前战力加成汇总
     *   - element_advantage_hint: 五行相克提示
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 幻世轮状态快照
     */
    static async getFiveElementWheelStatus(playerId) {
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'nickname', 'realm', 'realm_rank', 'is_dead']
        });
        if (!player) {
            throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
        }

        const cfg = this.getFiveElementWheelConfig();
        const equipment = await this._findWheelEquipment(playerId);

        // 未装备：返回 has_wheel=false
        if (!equipment) {
            return {
                has_wheel: false,
                item_key: cfg.item_key,
                item_name: cfg.item_name,
                min_realm_rank: cfg.min_realm_rank,
                player_realm: player.realm,
                player_realm_rank: player.realm_rank,
                meets_realm: (player.realm_rank || 0) >= (cfg.min_realm_rank || 23),
                source_hint: '大五行幻世轮来自高阶副本掉落或特殊合成（详见玩法文档）',
                config: {
                    max_stage: cfg.max_stage || 10,
                    daily_insight_limit: cfg.daily_insight_limit || 100,
                    set_phase_cooldown_days: cfg.set_phase_cooldown_days || 7,
                    wheel_spin_unlock_stage: cfg.wheel_spin_unlock_stage || 5,
                    phases: Object.keys(cfg.phases || {})
                }
            };
        }

        // 已装备：初始化状态并返回完整快照
        const state = this._initWheelState(equipment);
        this._resetDailyInsightIfNeeded(state, cfg);
        // 若状态有变更（首次初始化或跨日重置），持久化
        if (equipment.changed('deep_line_state')) {
            await equipment.save();
        }

        const stages = cfg.stages || [];
        const currentStage = stages.find(s => s.stage === state.insight_stage);
        const nextStage = stages.find(s => s.stage === state.insight_stage + 1);

        // 定相冷却剩余
        const setPhaseCooldownMs = (cfg.set_phase_cooldown_days || 7) * 24 * 3600 * 1000;
        const setPhaseCooldownRemaining = this._calcCooldownRemaining(state.last_set_phase_at, setPhaseCooldownMs);

        // 轮转技能解锁状态
        const wheelSpinUnlockStage = cfg.wheel_spin_unlock_stage || 5;
        const wheelSpinUnlocked = state.insight_stage >= wheelSpinUnlockStage;

        // 战力加成
        const phaseBonus = this._calculatePhaseBonus(state, cfg);

        // 五行相克提示
        const overcomes = cfg.element_relations?.overcomes || {};
        const myPhase = state.current_phase;
        let elementAdvantageHint = '轮转相位不受相生相克影响，各项加成均衡';
        if (myPhase !== 'rotation' && overcomes[myPhase]) {
            const overcomeName = cfg.phases?.[overcomes[myPhase]]?.name || overcomes[myPhase];
            const bonusRate = ((cfg.element_relations?.overcome_insight_bonus_rate || 0.5) * 100).toFixed(0);
            elementAdvantageHint = `当前${cfg.phases?.[myPhase]?.name}相克制${overcomeName}相对手，战斗悟印获取+${bonusRate}%`;
        }

        return {
            has_wheel: true,
            item_key: cfg.item_key,
            item_name: cfg.item_name,
            equipment_id: equipment.id,
            slot: equipment.slot,
            // 悟印阶数
            insight_stage: state.insight_stage,
            insight_stage_name: currentStage?.name || '未启悟印',
            insight_stage_description: currentStage?.description || '',
            insight_max_stage: cfg.max_stage || 10,
            insight_exp: state.insight_exp,
            next_stage_required: nextStage?.insight_required || null,
            // 定相
            current_phase: myPhase,
            current_phase_name: cfg.phases?.[myPhase]?.name || '轮转',
            current_phase_description: cfg.phases?.[myPhase]?.description || '',
            set_phase_cooldown_remaining: setPhaseCooldownRemaining,
            // 每日上限
            daily_insight_gained: state.daily_insight_gained,
            daily_insight_limit: cfg.daily_insight_limit || 100,
            // 轮转技能
            wheel_spin_enabled: state.wheel_spin_enabled,
            wheel_spin_unlocked: wheelSpinUnlocked,
            wheel_spin_unlock_stage: wheelSpinUnlockStage,
            wheel_spin_divine_sense_cost_per_round: cfg.wheel_spin_divine_sense_cost_per_round || 10,
            // 战力加成
            phase_multiplier: phaseBonus.multiplier,
            combat_bonus: phaseBonus.bonus,
            // 五行相克提示
            element_advantage_hint: elementAdvantageHint,
            // 统计
            total_battles: state.total_battles,
            total_insight_gained: state.total_insight_gained,
            // 配置回显
            config: {
                max_stage: cfg.max_stage || 10,
                daily_insight_limit: cfg.daily_insight_limit || 100,
                set_phase_cooldown_days: cfg.set_phase_cooldown_days || 7,
                wheel_spin_unlock_stage: wheelSpinUnlockStage,
                phases: Object.keys(cfg.phases || {})
            },
            server_time: Date.now()
        };
    }

    /**
     * 定相（玩法文档第19节：.法宝 定相 <轮转/金/水/木/火/土>）
     * 决定大五行幻世轮的成长倾向，7 天冷却，切换后悟印经验保留但成长倾向改变
     *
     * @param {number} playerId - 玩家ID
     * @param {string} phase - 目标相位 rotation/metal/water/wood/fire/earth
     * @returns {Promise<Object>} 定相结果
     */
    static async setPhase(playerId, phase) {
        const cfg = this.getFiveElementWheelConfig();
        const validPhases = Object.keys(cfg.phases || {});
        if (!validPhases.includes(phase)) {
            throw new AppError(`定相无效，应为：${validPhases.join('/')}`, 400, ErrorCodes.VALIDATION_ERROR);
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                attributes: ['id', 'is_dead'],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已坐化，无法操作法宝', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findWheelEquipment(playerId, t, true);
            if (!equipment) throw new AppError('未装备大五行幻世轮', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const state = this._initWheelState(equipment);

            // 相同相位无需重复定相
            if (state.current_phase === phase) {
                throw new AppError(`当前已是${cfg.phases[phase]?.name}相，无需重复定相`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            // 定相冷却检查（7 天）
            const cooldownMs = (cfg.set_phase_cooldown_days || 7) * 24 * 3600 * 1000;
            const remaining = this._calcCooldownRemaining(state.last_set_phase_at, cooldownMs);
            if (remaining > 0) {
                const hours = Math.ceil(remaining / 3600);
                throw new AppError(`定相冷却中，剩余 ${hours} 小时`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const oldPhase = state.current_phase;
            state.current_phase = phase;
            state.last_set_phase_at = new Date();

            // 显式覆盖子对象（避免 Sequelize TEXT 字段 get()/set() 陷阱）
            equipment.deep_line_state = { ...equipment.deep_line_state, five_element_wheel: state };
            await equipment.save({ transaction: t });

            await t.commit();

            // WebSocket 推送（同步方法，try-catch 包裹）
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, {
                    type: 'five_element_wheel_phase_changed',
                    old_phase: oldPhase,
                    new_phase: phase
                });
            } catch (_) { /* 推送失败不影响业务 */ }

            return {
                success: true,
                message: `定相成功：${cfg.phases[oldPhase]?.name || oldPhase}→${cfg.phases[phase]?.name}`,
                old_phase: oldPhase,
                old_phase_name: cfg.phases[oldPhase]?.name,
                new_phase: phase,
                new_phase_name: cfg.phases[phase]?.name,
                new_phase_description: cfg.phases[phase]?.description
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 查看悟印提示（玩法文档第19节：.法宝 悟印）
     * 返回悟印成长进度、每日剩余、战斗预期收益、五行相克加成等提示信息
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 悟印提示信息
     */
    static async getInsightHint(playerId) {
        const cfg = this.getFiveElementWheelConfig();
        const player = await Player.findByPk(playerId, {
            attributes: ['id', 'realm', 'realm_rank']
        });
        if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);

        const equipment = await this._findWheelEquipment(playerId);
        if (!equipment) throw new AppError('未装备大五行幻世轮', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

        const state = this._initWheelState(equipment);
        this._resetDailyInsightIfNeeded(state, cfg);
        if (equipment.changed('deep_line_state')) {
            await equipment.save();
        }

        const stages = cfg.stages || [];
        const currentStage = stages.find(s => s.stage === state.insight_stage);
        const nextStage = stages.find(s => s.stage === state.insight_stage + 1);

        const rewards = cfg.battle_insight_rewards || {};
        const dailyLimit = cfg.daily_insight_limit || 100;
        const dailyRemaining = Math.max(0, dailyLimit - (state.daily_insight_gained || 0));

        // 当前相位克制关系提示
        const overcomes = cfg.element_relations?.overcomes || {};
        const myPhase = state.current_phase;
        let advantageHint = '轮转相位不受相生相克影响，悟印获取无加成也无减损';
        if (myPhase !== 'rotation' && overcomes[myPhase]) {
            const overcomeName = cfg.phases?.[overcomes[myPhase]]?.name || overcomes[myPhase];
            const bonusRate = ((cfg.element_relations?.overcome_insight_bonus_rate || 0.5) * 100).toFixed(0);
            advantageHint = `当前${cfg.phases?.[myPhase]?.name}相克制${overcomeName}相对手，悟印获取+${bonusRate}%`;
        }

        // 7 阶翻倍提示
        let extraHint = '';
        if (state.insight_stage >= 7) {
            extraHint = '（已达7阶，战斗悟印获取翻倍）';
        }

        return {
            current_stage: state.insight_stage,
            current_stage_name: currentStage?.name || '未启悟印',
            insight_exp: state.insight_exp,
            next_stage_required: nextStage?.insight_required || null,
            next_stage_name: nextStage?.name || '已满阶',
            daily_insight_gained: state.daily_insight_gained,
            daily_insight_limit: dailyLimit,
            daily_insight_remaining: dailyRemaining,
            current_phase: myPhase,
            current_phase_name: cfg.phases?.[myPhase]?.name || '轮转',
            advantage_hint: advantageHint,
            battle_rewards_preview: {
                pve_win: rewards.pve_win_base || 10,
                pve_loss: rewards.pve_loss_base || 3,
                pvp_win: rewards.pvp_win_base || 20,
                pvp_loss: rewards.pvp_loss_base || 5,
                dungeon_win: rewards.dungeon_win_base || 15,
                dungeon_loss: rewards.dungeon_loss_base || 4
            },
            wheel_spin_unlocked: state.insight_stage >= (cfg.wheel_spin_unlock_stage || 5),
            extra_hint: extraHint,
            hint: '祭出大五行幻世轮参与斗法（PVE/PVP/副本）可自动积累悟印经验，无需主动操作'
        };
    }

    /**
     * 轮转技能开关（5 阶解锁，战斗中每 3 回合自动切换相位适应对手）
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 轮转技能切换结果
     */
    static async toggleWheelSpin(playerId) {
        const cfg = this.getFiveElementWheelConfig();
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, {
                attributes: ['id', 'is_dead'],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!player) throw new AppError('玩家不存在', 404, ErrorCodes.NOT_FOUND);
            if (player.is_dead) throw new AppError('已坐化，无法操作法宝', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const equipment = await this._findWheelEquipment(playerId, t, true);
            if (!equipment) throw new AppError('未装备大五行幻世轮', 400, ErrorCodes.BUSINESS_LOGIC_ERROR);

            const state = this._initWheelState(equipment);

            // 5 阶解锁检查
            const unlockStage = cfg.wheel_spin_unlock_stage || 5;
            if (state.insight_stage < unlockStage) {
                throw new AppError(`轮转技能需悟印达到 ${unlockStage} 阶（${cfg.stages?.[unlockStage - 1]?.name || ''}）方可解锁`, 400, ErrorCodes.BUSINESS_LOGIC_ERROR);
            }

            const oldEnabled = state.wheel_spin_enabled;
            state.wheel_spin_enabled = !oldEnabled;

            // 显式覆盖子对象
            equipment.deep_line_state = { ...equipment.deep_line_state, five_element_wheel: state };
            await equipment.save({ transaction: t });

            await t.commit();

            // WebSocket 推送
            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, {
                    type: 'five_element_wheel_spin_toggled',
                    wheel_spin_enabled: state.wheel_spin_enabled
                });
            } catch (_) { /* 推送失败不影响业务 */ }

            return {
                success: true,
                message: state.wheel_spin_enabled
                    ? '轮转技能已开启：战斗中每 3 回合自动切换五行相位，适应对手属性'
                    : '轮转技能已关闭：将固定使用当前相位进行战斗',
                wheel_spin_enabled: state.wheel_spin_enabled,
                divine_sense_cost_per_round: cfg.wheel_spin_divine_sense_cost_per_round || 10
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 战斗结算时自动积累悟印经验（供战斗系统调用，非用户直接接口）
     *
     * 悟印奖励计算：
     *   基础奖励（战斗类型 × 胜负）+ 对手境界差加成
     *   × 五行相克系数（克制+50% / 被克-30% / 无 0%）
     *   × 7 阶翻倍系数（≥7 阶 ×2.0）
     *
     * @param {number} playerId - 玩家ID
     * @param {Object} battleResult - 战斗结果
     *   - battle_type: 'pve' | 'pvp' | 'dungeon'
     *   - is_win: boolean
     *   - opponent_realm_rank: number（对手境界 rank，用于境界差加成）
     *   - opponent_phase: string（对手五行相位，用于相克判定，可选）
     * @returns {Promise<Object>} 悟印积累结果
     */
    static async addInsightExp(playerId, battleResult) {
        const cfg = this.getFiveElementWheelConfig();
        const t = await sequelize.transaction();
        try {
            const equipment = await this._findWheelEquipment(playerId, t, true);
            // 未装备幻世轮：静默返回，不报错（战斗系统可统一调用）
            if (!equipment) {
                await t.commit();
                return { success: false, reason: '未装备大五行幻世轮' };
            }

            const state = this._initWheelState(equipment);
            this._resetDailyInsightIfNeeded(state, cfg);

            // 每日上限检查
            const dailyLimit = cfg.daily_insight_limit || 100;
            if (state.daily_insight_gained >= dailyLimit) {
                await t.commit();
                return { success: false, reason: '今日悟印已达上限', daily_insight_gained: state.daily_insight_gained, daily_insight_limit: dailyLimit };
            }

            // 计算基础悟印奖励（战斗类型 × 胜负）
            const rewards = cfg.battle_insight_rewards || {};
            const battleType = battleResult.battle_type || 'pve';
            const isWin = battleResult.is_win;
            let baseInsight = 0;
            if (battleType === 'pve') {
                baseInsight = isWin ? (rewards.pve_win_base || 10) : (rewards.pve_loss_base || 3);
            } else if (battleType === 'pvp') {
                baseInsight = isWin ? (rewards.pvp_win_base || 20) : (rewards.pvp_loss_base || 5);
            } else if (battleType === 'dungeon') {
                baseInsight = isWin ? (rewards.dungeon_win_base || 15) : (rewards.dungeon_loss_base || 4);
            } else {
                baseInsight = isWin ? (rewards.pve_win_base || 10) : (rewards.pve_loss_base || 3);
            }

            // 对手境界差加成（越级挑战奖励更多）
            const player = await Player.findByPk(playerId, {
                attributes: ['realm_rank'],
                transaction: t
            });
            const myRank = player?.realm_rank || 0;
            const opponentRank = battleResult.opponent_realm_rank || myRank;
            const rankDiff = Math.max(0, opponentRank - myRank);
            const maxDiffBonus = rewards.max_opponent_rank_diff_bonus || 20;
            const diffBonus = Math.min(rankDiff * (rewards.opponent_rank_diff_bonus_per_rank || 1), maxDiffBonus);

            // 五行相克系数
            let elementMultiplier = 1.0;
            const advantage = this._checkPhaseAdvantage(state.current_phase, battleResult.opponent_phase, cfg);
            if (advantage === 'advantage') {
                elementMultiplier = 1 + (cfg.element_relations?.overcome_insight_bonus_rate || 0.5);
            } else if (advantage === 'disadvantage') {
                elementMultiplier = 1 - (cfg.element_relations?.overcome_by_insight_penalty_rate || 0.3);
            }

            // 7 阶翻倍（幻世初显）
            if (state.insight_stage >= 7) {
                elementMultiplier *= 2.0;
            }

            // 计算最终悟印（保底 1 点）
            const rawInsight = (baseInsight + diffBonus) * elementMultiplier;
            const finalInsight = Math.max(1, Math.round(rawInsight));

            // 每日上限裁剪
            const remaining = dailyLimit - state.daily_insight_gained;
            const actualInsight = Math.min(finalInsight, remaining);

            // 积累悟印
            state.insight_exp += actualInsight;
            state.daily_insight_gained += actualInsight;
            state.total_insight_gained += actualInsight;
            state.total_battles += 1;

            // 检查连续升阶
            let stageUp = false;
            const oldStage = state.insight_stage;
            let newStage = oldStage;
            const maxStage = cfg.max_stage || 10;
            const stages = cfg.stages || [];
            while (newStage < maxStage) {
                const nextStageInfo = stages.find(s => s.stage === newStage + 1);
                if (nextStageInfo && state.insight_exp >= nextStageInfo.insight_required) {
                    newStage += 1;
                    state.insight_stage = newStage;
                    stageUp = true;
                } else {
                    break;
                }
            }

            // 显式覆盖子对象
            equipment.deep_line_state = { ...equipment.deep_line_state, five_element_wheel: state };
            await equipment.save({ transaction: t });

            await t.commit();

            // 升阶时 WebSocket 推送
            if (stageUp) {
                try {
                    WebSocketNotificationService.notifyPlayerUpdate(playerId, {
                        type: 'five_element_wheel_stage_up',
                        old_stage: oldStage,
                        new_stage: newStage,
                        new_stage_name: stages.find(s => s.stage === newStage)?.name
                    });
                } catch (_) { /* 推送失败不影响业务 */ }
            }

            return {
                success: true,
                insight_gained: actualInsight,
                raw_insight: finalInsight,
                insight_exp: state.insight_exp,
                insight_stage: state.insight_stage,
                stage_up: stageUp,
                old_stage: oldStage,
                new_stage: newStage,
                new_stage_name: stageUp ? stages.find(s => s.stage === newStage)?.name : undefined,
                element_advantage: advantage,
                element_multiplier: elementMultiplier,
                base_insight: baseInsight,
                rank_diff_bonus: diffBonus,
                daily_insight_gained: state.daily_insight_gained,
                daily_insight_limit: dailyLimit
            };
        } catch (error) {
            await t.rollback();
            throw error;
        }
    }

    /**
     * 获取大五行幻世轮战力加成（供战斗系统调用）
     * 战斗系统在计算属性时调用此方法，获取当前相位 × 阶数的战力加成
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { has_wheel, phase, insight_stage, wheel_spin_enabled, combat_bonus }
     */
    static async getFiveElementWheelCombatBonus(playerId) {
        const cfg = this.getFiveElementWheelConfig();
        const equipment = await this._findWheelEquipment(playerId);
        if (!equipment) {
            return { has_wheel: false, combat_bonus: {} };
        }
        const state = this._initWheelState(equipment);
        const phaseBonus = this._calculatePhaseBonus(state, cfg);
        return {
            has_wheel: true,
            phase: state.current_phase,
            phase_name: phaseBonus.phase_name,
            insight_stage: state.insight_stage,
            wheel_spin_enabled: state.wheel_spin_enabled,
            phase_multiplier: phaseBonus.multiplier,
            combat_bonus: phaseBonus.bonus
        };
    }

    // ==================== 法宝深线战力加成统一聚合（供 AttributeService 调用） ====================

    /**
     * 获取玩家所有法宝深线的统一战力加成（供 AttributeService.calculateFullAttributesAsync 调用）
     *
     * 设计说明：
     *   三条法宝深线（血魔剑/虚天鼎/大五行幻世轮）的 CombatBonus 方法返回结构各不相同：
     *     - 血魔剑：百分比加成（atk_bonus_rate=0.05 表示 +5%）+ 战斗特殊效果（暴击/吸血/反噬）
     *     - 虚天鼎：绝对值加成（def_bonus=100 表示 +100 防御）+ 化极倍率 + 反噬
     *     - 大五行幻世轮：百分比加成（atk_bonus_rate=0.08 表示 +8%）+ 相位 × 阶数倍率
     *   本方法将三者归一化为统一结构，便于 AttributeService 统一叠加：
     *     - absolute: 绝对值加成（直接 addAttr 到 final）
     *     - percent: 百分比加成（基于 final 乘算，0.05 表示 +5%）
     *     - effects: 战斗特殊效果（不体现在属性面板，供战斗系统读取）
     *     - breakdown: 各法宝深线的原始返回（供前端展示和调试）
     *
     * 掌天瓶线为纯辅助法宝（炼丹/药园/养竹等），无战力加成，不参与本方法聚合
     *
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} 归一化后的统一战力加成对象
     */
    static async getAllArtifactDeepLineCombatBonuses(playerId) {
        // 并行查询三条法宝深线的战力加成（提升性能）
        const [bloodSwordBonus, xutianCauldronBonus, wheelBonus] = await Promise.all([
            this.getBloodSwordCombatBonus(playerId).catch(() => ({ is_active: false })),
            this.getXutianCauldronCombatBonus(playerId).catch(() => ({ is_active: false })),
            this.getFiveElementWheelCombatBonus(playerId).catch(() => ({ has_wheel: false, combat_bonus: {} }))
        ]);

        // 绝对值加成（直接叠加到 final 属性）
        const absolute = { atk: 0, def: 0, hp_max: 0, speed: 0, mp_max: 0, sense: 0, luck: 0, wisdom: 0 };
        // 百分比加成（基于 final 乘算，0.05 表示 +5%）
        const percent = { atk: 0, def: 0, hp_max: 0, speed: 0 };
        // 战斗特殊效果（不体现在属性面板，供战斗系统读取）
        const effects = {
            crit_rate_bonus: 0,           // 暴击率加成
            crit_damage_bonus: 0,         // 暴击伤害加成
            hp_steal_bonus_rate: 0,       // 吸血率加成
            damage_reduction_rate: 0,     // 伤害减免
            hp_regen_bonus_rate: 0,       // 生命回复加成
            backlash_rate_per_round: 0,   // 每回合反噬比例
            backlash_target: 'none',      // 反噬目标（none/self）
            wheel_spin_enabled: false,    // 轮转技能是否开启
            active_sources: []            // 当前生效的法宝深线来源列表
        };
        const breakdown = {};

        // 1. 血魔剑加成归一化
        if (bloodSwordBonus.is_active) {
            breakdown.blood_sword = bloodSwordBonus;
            effects.active_sources.push('blood_sword');
            // 血魔剑为百分比加成（atk_bonus_rate=0.05 表示 +5%）
            percent.atk += bloodSwordBonus.atk_bonus_rate || 0;
            percent.def += bloodSwordBonus.def_bonus_rate || 0;
            // 战斗特殊效果
            effects.crit_rate_bonus += bloodSwordBonus.crit_rate_bonus || 0;
            effects.crit_damage_bonus += bloodSwordBonus.crit_damage_bonus || 0;
            effects.hp_steal_bonus_rate += bloodSwordBonus.hp_steal_bonus_rate || 0;
            effects.backlash_rate_per_round += bloodSwordBonus.blood_backlash_hp_rate_per_round || 0;
            if (bloodSwordBonus.blood_backlash_hp_rate_per_round > 0) {
                effects.backlash_target = 'self';
            }
        }

        // 2. 虚天鼎加成归一化
        if (xutianCauldronBonus.is_active) {
            breakdown.xutian_cauldron = xutianCauldronBonus;
            effects.active_sources.push('xutian_cauldron');
            // 虚天鼎为绝对值加成（def_bonus=100 表示 +100 防御）
            absolute.def += xutianCauldronBonus.def_bonus || 0;
            // 化极后的最终攻击加成 = atk_bonus × atk_multiplier
            absolute.atk += xutianCauldronBonus.final_atk_bonus || 0;
            // 反噬效果
            if (xutianCauldronBonus.backlash_rate_per_round > 0) {
                effects.backlash_rate_per_round += xutianCauldronBonus.backlash_rate_per_round;
                effects.backlash_target = xutianCauldronBonus.backlash_target || 'self';
            }
        }

        // 3. 大五行幻世轮加成归一化
        if (wheelBonus.has_wheel) {
            breakdown.five_element_wheel = wheelBonus;
            effects.active_sources.push('five_element_wheel');
            effects.wheel_spin_enabled = !!wheelBonus.wheel_spin_enabled;
            // 幻世轮 combat_bonus 内含相位基础加成 × 阶数倍率（百分比形式）
            const cb = wheelBonus.combat_bonus || {};
            // atk_bonus_rate/def_bonus_rate/hp_bonus_rate 等为百分比加成
            percent.atk += cb.atk_bonus_rate || 0;
            percent.def += cb.def_bonus_rate || 0;
            percent.hp_max += cb.hp_bonus_rate || 0;
            percent.speed += cb.speed_bonus_rate || 0;
            // 战斗特殊效果
            effects.crit_rate_bonus += cb.crit_rate_bonus || 0;
            effects.crit_damage_bonus += cb.crit_damage_bonus || 0;
            effects.damage_reduction_rate += cb.damage_reduction_rate || 0;
            effects.hp_regen_bonus_rate += cb.hp_regen_bonus_rate || 0;
        }

        const is_active = effects.active_sources.length > 0;
        return { is_active, absolute, percent, effects, breakdown };
    }

    // ==================== 战斗结算集成辅助方法 ====================

    /**
     * 安全调用 addInsightExp（供所有战斗 Service 结算时统一调用）
     *
     * 设计说明：
     *   大五行幻世轮的核心机制是"被动战斗驱动成长"，即玩家祭出幻世轮后参与斗法自动积累悟印。
     *   本方法封装了 try/catch + 日志，确保即使悟印积累失败也不影响主战斗流程。
     *   未装备幻世轮时 addInsightExp 内部静默返回，可无条件调用。
     *
     * 调用时机约束：
     *   - 必须在调用方的事务 commit() 之后调用，避免嵌套事务/锁竞争
     *   - 建议在 WebSocket 推送之前或之后均可，互不影响
     *
     * @param {number} playerId - 玩家ID
     * @param {Object} battleResult - 战斗结果
     *   @param {string} battleResult.battle_type - 战斗类型：'pve' | 'pvp' | 'dungeon'
     *   @param {boolean} battleResult.is_win - 是否胜利
     *   @param {number} [battleResult.opponent_realm_rank] - 对手境界排名（可选，缺失时回退到玩家自身 rank）
     *   @param {string} [battleResult.opponent_phase] - 对手五行相位（可选，用于五行相克判定）
     * @returns {Promise<Object>} addInsightExp 的返回值（失败时返回 { success: false, reason }）
     */
    static async safeAddInsightExp(playerId, battleResult) {
        if (!playerId || !battleResult) {
            return { success: false, reason: '参数缺失' };
        }
        try {
            const result = await this.addInsightExp(playerId, battleResult);
            // 仅在成功获得悟印时记日志，便于排查
            if (result && result.success && result.insight_gained > 0) {
                console.log(`[ArtifactDeepLine] 玩家${playerId}战斗悟印+${result.insight_gained}（${battleResult.battle_type}/${battleResult.is_win ? '胜' : '败'}）`);
            }
            return result || { success: false, reason: '未知原因' };
        } catch (error) {
            // 悟印积累失败不影响主战斗流程，仅记错误日志
            console.error(`[ArtifactDeepLine] safeAddInsightExp 失败 player=${playerId}:`, error?.message || error);
            return { success: false, reason: '悟印积累异常' };
        }
    }
}

module.exports = ArtifactDeepLineService;
