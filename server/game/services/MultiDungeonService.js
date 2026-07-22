/**
 * 多人副本系统服务
 *
 * 实现批次3设计文档第6章「多人副本系统」业务逻辑：
 *   1. 掩月抢亲（yanyue）：3-5 人剧情副本，6 幕抉择，队长决策影响全员
 *   2. 端午镇蛟（duanwu）：10 人强制协作副本，4 幕流程，投粽机制 + 空舟惩罚
 *
 * 设计原则：
 *   - 所有阈值/概率/消耗从 multi_dungeon_data.json 配置读取，禁止硬编码
 *   - 所有写操作使用 sequelize.transaction() + LOCK.UPDATE 行级锁
 *   - 抉择必须按幕顺序推进（不能跳幕，不能回退）
 *   - 队长权限校验：multi_dungeon_instance.leader_player_id === playerId
 *   - 状态机校验：preparing → active → cleared/failed/dissolved
 *   - 通过 WebSocketNotificationService.notifyPlayerUpdate 实时推送副本进度
 *   - 冷却到期自动失效（查询时校验 cooldown_end_time > NOW）
 *
 * 数据模型：
 *   - MultiDungeonInstance: 副本实例表（状态机 + 4 变量 + 收获倍率）
 *   - MultiDungeonMember:   成员表（role=leader/member，contribution，zongzi_invested）
 *   - MultiDungeonChoice:   抉择记录表（每幕抉择的变量变化审计）
 *   - MultiDungeonCooldown: 冷却表（玩家×副本键粒度，按 reason 区分通关/失败/惩罚）
 *
 * 返回格式：{ success, message, data, error_code? }
 */
'use strict';

const { infrastructure } = require('../../modules');
const configLoader = infrastructure.ConfigLoader;
const Player = require('../../models/player');
const MultiDungeonInstance = require('../../models/multiDungeonInstance');
const MultiDungeonMember = require('../../models/multiDungeonMember');
const MultiDungeonChoice = require('../../models/multiDungeonChoice');
const MultiDungeonCooldown = require('../../models/multiDungeonCooldown');
const sequelize = require('../../config/database');
const RealmService = require('../core/RealmService');
const WebSocketNotificationService = require('./WebSocketNotificationService');
const InventoryService = require('./InventoryService');
// 大五行幻世轮服务（同目录引用，用于多人副本通关后被动积累悟印）
const ArtifactDeepLineService = require('./ArtifactDeepLineService');
const { ErrorCodes } = require('../../middleware/errorHandler');
const { Op } = require('sequelize');

// 副本终态集合（不可再变更状态）
const TERMINAL_STATES = ['cleared', 'failed', 'dissolved'];

// 建立模型关联关系（模块加载时执行一次，支持 include 链表查询）
// 设计说明：项目约定不在 Model 文件中互相 require 以避免循环依赖，
//           统一在使用方建立关联。Sequelize 的 associations 是双向生效的。
MultiDungeonInstance.hasMany(MultiDungeonMember, { foreignKey: 'instance_id', as: 'MultiDungeonMembers' });
MultiDungeonInstance.hasMany(MultiDungeonChoice, { foreignKey: 'instance_id', as: 'MultiDungeonChoices' });
MultiDungeonMember.belongsTo(MultiDungeonInstance, { foreignKey: 'instance_id', as: 'MultiDungeonInstance' });
MultiDungeonChoice.belongsTo(MultiDungeonInstance, { foreignKey: 'instance_id', as: 'MultiDungeonInstance' });

// 副本变量允许范围（从 global 配置读取兜底，避免越界）
const VARIABLE_BOUNDS = {
    morale: { min: 0, max: 100 },
    vigilance: { min: 0, max: 100 },
    demon_corruption: { min: 0, max: 100 },
    seal_stability: { min: 0, max: 100 },
    soul_stability: { min: 0, max: 100 },
    harvest_multiplier: { min: 0.5, max: 3.0 },
    // 昆吾山·封魔塔专属变量边界（2026-07-21 新增）
    demonic_qi: { min: 0, max: 100 },
    mountain_seal: { min: 0, max: 100 },
    treasure_pressure: { min: 0, max: 100 },
    linglong: { min: 0, max: 100 },
    seal_progress: { min: 0, max: 100 },
    // tower_shadow_hp 无边界限制（BIGINT，可为0表示被击败）
    // 虚天殿专属变量边界（2026-07-21 新增）
    path_choice: { min: 0, max: 2 },         // 0=未选 / 1=冰道 / 2=火道
    formation_power: { min: 0, max: 100 },   // 阵法强度，影响决战伤害与通关
    // void_soul_hp 无边界限制（BIGINT，可为0表示被击败）
    // 小极宫专属变量边界（2026-07-21 新增）
    // curse_disorder / ice_seal_power / flame_power / yinluo_banner_qi 均为 0-100 整数
    // 落云秘圃专属变量边界（2026-07-21 新增，migration_0055）
    // spirit_vein_power / root_stability / branch_vigor / spirit_plant_aura 均为 0-100 整数
    spirit_vein_power: { min: 0, max: 100 },   // 灵脉之力，影响灵植生长
    root_stability: { min: 0, max: 100 },       // 根脉稳定，第3幕需≥50才不致失败
    branch_vigor: { min: 0, max: 100 },         // 枝桠活力，影响灵眼树胚掉落
    spirit_plant_aura: { min: 0, max: 100 },     // 灵植灵气，影响最终奖励
    // 苍坤洞府专属变量边界（2026-07-21 新增，migration_0057）
    // forbidden_rift / scroll_clue / escape_difficulty 均为 0-100 整数
    forbidden_rift: { min: 0, max: 100 },        // 禁制裂隙，影响门票线索掉率与脱身难度
    scroll_clue: { min: 0, max: 100 },           // 卷轴线索，千机残篇线索累积度
    escape_difficulty: { min: 0, max: 100 },     // 脱身难度，影响决战回合数与门票掉率
    // cangkun_guardian_hp 无边界限制（BIGINT，可为0表示被击败）
    // 血色试炼专属变量边界（2026-07-21 新增，migration_0058）
    blood_qi_avg: { min: 0, max: 100 },          // 团队平均血气，第4幕决战每回合-10，归零团灭
    blood_fury: { min: 0, max: 200 },            // 血怒，第4幕决战伤害加成
    eliminations: { min: 0, max: 6 },            // 累计淘汰人数（最多6人副本）
    survivor_count: { min: 0, max: 6 },          // 最终幸存人数
    // 个人级变量边界（存于 member 表，第3幕淘汰判定用）
    member_blood_qi: { min: 0, max: 100 },       // 个人血气，归零即被淘汰
    member_kill_score: { min: 0, max: 200 },     // 个人杀戮分，影响最终奖励
    // xuese_boss_hp 无边界限制（BIGINT，可为0表示被击败）
    // 坠魔谷专属变量边界（2026-07-21 新增，migration_0059）
    avg_heart_demon: { min: 0, max: 100 },       // 团队平均心魔，第4幕决战每回合+5，满100团灭
    avg_dao_heart: { min: 0, max: 100 },         // 团队平均道心，第4幕决战每回合-5，归0团灭
    member_heart_demon: { min: 0, max: 100 },    // 个人心魔，满100则堕魔淘汰
    member_dao_heart: { min: 0, max: 100 },      // 个人道心，归0则道心破碎淘汰
    // demon_boss_hp 无边界限制（BIGINT，可为0表示被击败）
    // 黄龙山专属变量边界（2026-07-21 新增，migration_0060）
    // huanglong_formation_power 阵法强度，0-200，影响决战伤害与称号奖励
    huanglong_formation_power: { min: 0, max: 200 },  // 阵法强度（区别于虚天殿 formation_power 0-100）
    huanglong_resonance_count: { min: 0, max: 5 },    // 共鸣数，相同阵眼≥2人触发
    member_huanglong_contribution_score: { min: 0, max: 1000 }  // 个人贡献分，影响奖励分配
    // huanglong_boss_hp 无边界限制（BIGINT，可为0表示被击败）
};

class MultiDungeonService {
    // ==================== 玩家方法 ====================

    /**
     * 获取副本规则说明
     * 返回所有副本的玩法说明、前置条件、奖励池概要
     * @returns {Promise<Object>} { success, data }
     */
    static async getHelp() {
        const config = configLoader.getConfig('multi_dungeon_data');
        const dungeons = config.dungeons;
        const help = {};

        for (const [key, cfg] of Object.entries(dungeons)) {
            help[key] = {
                name: cfg.name,
                desc: cfg.desc,
                member_min: cfg.member_min,
                member_max: cfg.member_max,
                leader_min_realm: cfg.leader_min_realm,
                leader_min_realm_rank: cfg.leader_min_realm_rank,
                member_min_realm: cfg.member_min_realm,
                member_min_realm_rank: cfg.member_min_realm_rank,
                consume_item_key: cfg.consume_item_key,
                consume_item_count: cfg.consume_item_count,
                cooldown_hours: cfg.cooldown_hours,
                expire_hours: cfg.expire_hours,
                act_count: cfg.acts.length,
                has_empty_boat_penalty: !!cfg.empty_boat_penalty,
                rewards_summary: cfg.rewards && cfg.rewards.normal_drops
                    ? `普通掉落${cfg.rewards.normal_drops.length}种`
                    : (cfg.rewards && cfg.rewards.base_rewards ? `基础奖励${cfg.rewards.base_rewards.length}种` : '无')
            };
        }

        return {
            success: true,
            data: {
                dungeons: help,
                state_machine: config.state_machine,
                global_bounds: config.global
            }
        };
    }

    /**
     * 队长开启副本
     * 校验前置条件（境界/冷却/物品/已有副本），消耗物品，创建实例 + 队长成员
     * @param {number} playerId - 玩家ID
     * @param {string} dungeonKey - 副本键（yanyue/duanwu）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async create(playerId, dungeonKey) {
        // 2026-07-21 新增 kunwu（昆吾山·封魔塔）5人剧情副本
        // 2026-07-21 新增 xutian（虚天殿）4-6人剧情副本
        // 2026-07-21 新增 xiaoji（北冥小极宫）4-5人剧情副本
        // 2026-07-21 新增 luoyun（落云秘圃）3-5人剧情副本
        // 2026-07-21 新增 cangkun（苍坤洞府）3-5人剧情副本，掩月抢亲前置副本
        // 2026-07-21 新增 xuese（血色试炼）4-6人 PVPvE 淘汰制副本
        // 2026-07-21 新增 zhuimo（坠魔谷）3-5人 PVE 心魔博弈副本
        // 2026-07-21 新增 huanglong（黄龙山）5人固定编制宗门协同阵法副本（首个同宗门强制副本）
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian', 'xiaoji', 'luoyun', 'cangkun', 'xuese', 'zhuimo', 'huanglong'].includes(dungeonKey)) {
            return {
                success: false,
                message: 'dungeon_key 必须为 yanyue(掩月抢亲) / duanwu(端午镇蛟) / kunwu(昆吾山·封魔塔) / xutian(虚天殿) / xiaoji(北冥小极宫) / luoyun(落云秘圃) / cangkun(苍坤洞府) / xuese(血色试炼) / zhuimo(坠魔谷) / huanglong(黄龙山)',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            const config = configLoader.getConfig('multi_dungeon_data');
            const dungeonCfg = config.dungeons[dungeonKey];

            // 校验队长境界
            const realmCheck = RealmService.meetsRealmRequirement(player, dungeonCfg.leader_min_realm);
            if (!realmCheck.met) {
                await t.rollback();
                return {
                    success: false,
                    message: `队长境界不足，需要 ${dungeonCfg.leader_min_realm}（rank≥${dungeonCfg.leader_min_realm_rank}），当前 ${player.realm}`
                };
            }

            // 校验队长是否已在某个未终态副本中
            const existingMembership = await MultiDungeonMember.findOne({
                where: { player_id: playerId },
                include: [{
                    model: MultiDungeonInstance, as: 'MultiDungeonInstance',
                    where: { instance_state: { [Op.notIn]: TERMINAL_STATES } },
                    required: true
                }],
                transaction: t
            });
            if (existingMembership) {
                await t.rollback();
                return { success: false, message: `你已在副本【${existingMembership.MultiDungeonInstance.instance_name}】中，请先解散或退出` };
            }

            // 校验冷却（查询最新一条冷却记录，看是否在冷却期内）
            const inCooldown = await MultiDungeonService._isPlayerInCooldown(playerId, dungeonKey, t);
            if (inCooldown) {
                await t.rollback();
                return {
                    success: false,
                    message: `副本【${dungeonCfg.name}】冷却中，到期时间：${inCooldown.cooldown_end_time.toLocaleString()}（原因：${inCooldown.reason}）`
                };
            }

            // 校验并消耗物品（掩月消耗【红绫婚帖】，端午不消耗物品但开打时需投粽）
            if (dungeonCfg.consume_item_key && dungeonCfg.consume_item_count > 0) {
                const hasItem = await InventoryService.hasItem(playerId, dungeonCfg.consume_item_key, dungeonCfg.consume_item_count, t);
                if (!hasItem) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `需要消耗【${dungeonCfg.consume_item_key}】×${dungeonCfg.consume_item_count}，物品不足`
                    };
                }
                const removed = await InventoryService.removeItem(playerId, dungeonCfg.consume_item_key, dungeonCfg.consume_item_count, t);
                if (!removed) {
                    await t.rollback();
                    return { success: false, message: `消耗物品【${dungeonCfg.consume_item_key}】失败` };
                }
            }

            // 计算过期时间
            const expireAt = new Date();
            expireAt.setHours(expireAt.getHours() + dungeonCfg.expire_hours);

            // 创建副本实例
            // 2026-07-21 扩展：kunwu 副本初始化 6 变量（含 demonic_qi/mountain_seal/treasure_pressure/linglong/tower_shadow_hp/seal_progress）
            const instanceData = {
                instance_key: dungeonKey,
                instance_name: dungeonCfg.name,
                leader_player_id: playerId,
                leader_nickname: player.nickname,
                current_act: 1,
                current_act_state: 'pending',
                instance_state: 'preparing',
                member_count: 1,
                member_max: dungeonCfg.member_max,
                member_min: dungeonCfg.member_min,
                consume_item_key: dungeonCfg.consume_item_key || null,
                consume_item_count: dungeonCfg.consume_item_count || 0,
                morale: dungeonCfg.init_morale,
                vigilance: dungeonCfg.init_vigilance,
                demon_corruption: dungeonCfg.init_demon_corruption,
                seal_stability: dungeonCfg.init_seal_stability,
                soul_stability: dungeonCfg.init_soul_stability,
                harvest_multiplier: dungeonCfg.init_harvest_multiplier,
                first_clear: 0,
                started_at: null,
                cleared_at: null,
                dissolved_at: null,
                expire_at: expireAt,
                cooldown_hours: dungeonCfg.cooldown_hours,
                cooldown_until: null
            };
            // 昆吾山·封魔塔专属变量初始化
            if (dungeonKey === 'kunwu') {
                instanceData.demonic_qi = dungeonCfg.init_demonic_qi ?? 0;
                instanceData.mountain_seal = dungeonCfg.init_mountain_seal ?? 30;
                instanceData.treasure_pressure = dungeonCfg.init_treasure_pressure ?? 0;
                instanceData.linglong = dungeonCfg.init_linglong ?? 50;
                instanceData.tower_shadow_hp = dungeonCfg.init_tower_shadow_hp ?? 1000000;
                instanceData.seal_progress = dungeonCfg.init_seal_progress ?? 50;
            }
            // 虚天殿专属变量初始化（2026-07-21 新增）
            if (dungeonKey === 'xutian') {
                instanceData.path_choice = dungeonCfg.init_path_choice ?? 0;          // 0=未选 / 1=冰道 / 2=火道
                instanceData.formation_power = dungeonCfg.init_formation_power ?? 30;  // 阵法强度初始30
                // void_soul_hp 初始为 null，由 _processXutianFinalAct 在首次进入第六幕时初始化
                // 这样设计的目的：明确区分"未进入第六幕"和"虚天主魂HP=0"两种状态
                instanceData.void_soul_hp = null;
                // 复用 treasure_pressure 字段（虚天殿也使用宝压变量）
                instanceData.treasure_pressure = dungeonCfg.init_treasure_pressure ?? 0;
            }
            // 小极宫专属变量初始化（2026-07-21 新增）
            // curse_disorder 咒扰值、ice_seal_power 冰封之力、flame_power 火焰之力、yinluo_banner_qi 阴罗幡煞气
            // yinluo_banner_qi 在队员加入时按阴罗宗成员累加（见 join 方法）
            if (dungeonKey === 'xiaoji') {
                instanceData.curse_disorder = dungeonCfg.init_curse_disorder ?? 0;
                instanceData.ice_seal_power = dungeonCfg.init_ice_seal_power ?? 50;
                instanceData.flame_power = dungeonCfg.init_flame_power ?? 0;
                instanceData.yinluo_banner_qi = dungeonCfg.init_yinluo_banner_qi ?? 0;
            }
            // 落云秘圃专属变量初始化（2026-07-21 新增，migration_0055）
            // spirit_vein_power 灵脉之力、root_stability 根脉稳定、branch_vigor 枝桠活力、spirit_plant_aura 灵植灵气
            // act3_choice 第3幕抉择键，初始为 null，第3幕抉择时设置
            if (dungeonKey === 'luoyun') {
                instanceData.spirit_vein_power = dungeonCfg.init_spirit_vein_power ?? 60;
                instanceData.root_stability = dungeonCfg.init_root_stability ?? 80;
                instanceData.branch_vigor = dungeonCfg.init_branch_vigor ?? 50;
                instanceData.spirit_plant_aura = dungeonCfg.init_spirit_plant_aura ?? 30;
                instanceData.act3_choice = null;
            }
            // 苍坤洞府专属变量初始化（2026-07-21 新增，migration_0057）
            // forbidden_rift 禁制裂隙（默认0，第1幕强破禁制/第3幕破禁抉择累加）
            // scroll_clue 卷轴线索（默认0，第2幕搜寻宝物抉择累加，影响门票线索掉率）
            // escape_difficulty 脱身难度（默认30，第4幕自动决战中累积，越高决战回合数越长）
            // escape_choice 第4幕脱身抉择键（null，决战后由队长抉择设置）
            // cangkun_guardian_hp 苍坤守灵HP（null，第4幕决战首次进入时初始化为 cangkun_guardian_hp_base）
            if (dungeonKey === 'cangkun') {
                instanceData.forbidden_rift = dungeonCfg.init_forbidden_rift ?? 0;
                instanceData.scroll_clue = dungeonCfg.init_scroll_clue ?? 0;
                instanceData.escape_difficulty = dungeonCfg.init_escape_difficulty ?? 30;
                instanceData.escape_choice = null;
                instanceData.cangkun_guardian_hp = null;
            }
            // 血色试炼专属变量初始化（2026-07-21 新增，migration_0058）
            // blood_qi_avg 团队平均血气（默认100，第4幕决战每回合-10，归零团灭）
            // blood_fury 血怒（默认0，前3幕抉择累加，第4幕决战伤害加成）
            // eliminations 累计淘汰人数（默认0，第1/3幕各淘汰1人时累加）
            // survivor_count 最终幸存人数（默认0，第3幕结束后更新为幸存者数量）
            // xuese_boss_hp 血色尊者HP（null，第4幕决战首次进入时初始化为 xuese_boss_hp_base）
            if (dungeonKey === 'xuese') {
                instanceData.blood_qi_avg = dungeonCfg.init_blood_qi_avg ?? 100;
                instanceData.blood_fury = dungeonCfg.init_blood_fury ?? 0;
                instanceData.eliminations = dungeonCfg.init_eliminations ?? 0;
                instanceData.survivor_count = dungeonCfg.init_survivor_count ?? 0;
                instanceData.xuese_boss_hp = null;
            }
            // 坠魔谷专属变量初始化（2026-07-21 新增，migration_0059）
            // avg_heart_demon 团队平均心魔（默认0，第4幕决战每回合+5，满100团灭）
            // avg_dao_heart 团队平均道心（默认100，第4幕决战每回合-5，归0团灭）
            // demon_boss_hp 心魔Boss HP（null，第4幕决战首次进入时初始化为 demon_boss_hp_base）
            if (dungeonKey === 'zhuimo') {
                instanceData.avg_heart_demon = dungeonCfg.init_avg_heart_demon ?? 0;
                instanceData.avg_dao_heart = dungeonCfg.init_avg_dao_heart ?? 100;
                instanceData.demon_boss_hp = null;
            }
            // 黄龙山专属变量初始化（2026-07-21 新增，migration_0060）
            // huanglong_formation_power 阵法强度（默认0，0-200，第1幕起由阵眼选择与共鸣累加）
            // huanglong_resonance_count 共鸣数（默认0，0-5，相同阵眼≥2人触发共鸣累加）
            // huanglong_boss_hp 黄龙Boss HP（null，第4幕决战首次进入时初始化为 huanglong_boss_hp_base）
            if (dungeonKey === 'huanglong') {
                instanceData.huanglong_formation_power = dungeonCfg.init_formation_power ?? 0;
                instanceData.huanglong_resonance_count = dungeonCfg.init_resonance_count ?? 0;
                instanceData.huanglong_boss_hp = null;
            }
            const instance = await MultiDungeonInstance.create(instanceData, { transaction: t });

            // 创建队长成员记录
            // 2026-07-21 新增 xuese 专属字段：blood_qi（个人血气）/ kill_score（杀戮分）/ is_eliminated（淘汰标记）
            const memberInitData = {
                instance_id: instance.id,
                player_id: playerId,
                player_nickname: player.nickname,
                player_realm: player.realm,
                player_realm_rank: player.realm_rank || 0,
                role: 'leader',
                join_time: new Date(),
                is_ready: 1,
                is_present: 1,
                contribution: 0,
                hp_remaining: BigInt(player.hp_current || 100),
                zongzi_invested: 0,
                cooldown_end_time: null
            };
            // 血色试炼：初始化个人血气与杀戮分（migration_0058）
            if (dungeonKey === 'xuese') {
                memberInitData.blood_qi = dungeonCfg.member_init_blood_qi ?? 100;
                memberInitData.kill_score = dungeonCfg.member_init_kill_score ?? 0;
                memberInitData.is_eliminated = 0;
            }
            // 坠魔谷：初始化个人心魔与道心（migration_0059）
            // heart_demon 心魔（默认0，满100则堕魔淘汰）
            // dao_heart 道心（默认100，归0则道心破碎淘汰）
            // is_fallen 是否已堕魔（默认0）
            if (dungeonKey === 'zhuimo') {
                memberInitData.heart_demon = dungeonCfg.member_init_heart_demon ?? 0;
                memberInitData.dao_heart = dungeonCfg.member_init_dao_heart ?? 100;
                memberInitData.is_fallen = 0;
            }
            // 黄龙山：初始化阵眼位置、贡献分、叛道标记（migration_0060）
            // huanglong_eye_position 阵眼位置（默认'unassigned'，第1幕入阵固守抉择后更新）
            // huanglong_contribution_score 个人贡献分（默认0，第1-3幕抉择累加，叛道双倍）
            // huanglong_is_defecting 是否已叛道（默认0，第3幕叛道抉择后置1）
            if (dungeonKey === 'huanglong') {
                memberInitData.huanglong_eye_position = dungeonCfg.member_init_eye_position ?? 'unassigned';
                memberInitData.huanglong_contribution_score = dungeonCfg.member_init_contribution_score ?? 0;
                memberInitData.huanglong_is_defecting = dungeonCfg.member_init_is_defecting ? 1 : 0;
            }
            await MultiDungeonMember.create(memberInitData, { transaction: t });

            await t.commit();

            // 推送副本创建通知
            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_created', {
                instance_id: instance.id,
                dungeon_key: dungeonKey,
                dungeon_name: dungeonCfg.name,
                leader: { id: playerId, nickname: player.nickname },
                expire_at: expireAt
            });

            return {
                success: true,
                message: `副本【${dungeonCfg.name}】已开启，等待队员加入（实例ID: ${instance.id}）`,
                data: {
                    instance_id: instance.id,
                    dungeon_key: dungeonKey,
                    dungeon_name: dungeonCfg.name,
                    instance_state: 'preparing',
                    current_act: 1,
                    member_count: 1,
                    member_max: dungeonCfg.member_max,
                    member_min: dungeonCfg.member_min,
                    expire_at: expireAt
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] create 异常:', err);
            throw err;
        }
    }

    /**
     * 队员加入副本
     * 校验：实例存在 / 状态为 preparing / 未满员 / 境界达标 / 未在冷却 / 未在其他副本
     * @param {number} playerId - 队员玩家ID
     * @param {number} instanceId - 副本实例ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async join(playerId, instanceId) {
        if (!instanceId || typeof instanceId !== 'number') {
            return {
                success: false,
                message: 'instance_id 必填且必须为数字',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 锁定实例
            const instance = await MultiDungeonInstance.findByPk(instanceId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!instance) {
                await t.rollback();
                return { success: false, message: '副本实例不存在' };
            }

            // 状态机校验：仅 preparing 状态允许加入
            if (instance.instance_state !== 'preparing') {
                await t.rollback();
                return {
                    success: false,
                    message: `副本当前状态为 ${instance.instance_state}，无法加入（仅 preparing 状态可加入）`
                };
            }

            // 过期校验
            if (new Date(instance.expire_at) < new Date()) {
                instance.instance_state = 'dissolved';
                instance.dissolved_at = new Date();
                await instance.save({ transaction: t });
                await t.commit();
                return { success: false, message: '副本已过期，自动解散' };
            }

            const config = configLoader.getConfig('multi_dungeon_data');
            const dungeonCfg = config.dungeons[instance.instance_key];

            // 满员校验
            if (instance.member_count >= instance.member_max) {
                await t.rollback();
                return {
                    success: false,
                    message: `副本已满员（${instance.member_count}/${instance.member_max}）`
                };
            }

            // 队员境界校验
            const realmCheck = RealmService.meetsRealmRequirement(player, dungeonCfg.member_min_realm);
            if (!realmCheck.met) {
                await t.rollback();
                return {
                    success: false,
                    message: `队员境界不足，需要 ${dungeonCfg.member_min_realm}（rank≥${dungeonCfg.member_min_realm_rank}），当前 ${player.realm}`
                };
            }

            // 2026-07-21 新增：同宗门校验（黄龙山 require_same_sect=true 时强制）
            // 设计目的：黄龙山是首个"5人固定编制+同宗门强制"副本，确保队员与队长属于同一宗门
            // 校验逻辑：查询队长和当前玩家的 PlayerSect，比较 sect_id 是否一致
            if (dungeonCfg.require_same_sect === true) {
                try {
                    const PlayerSect = require('../../models/playerSect');
                    // 查询队长的宗门
                    const leaderSect = await PlayerSect.findOne({
                        where: { player_id: instance.leader_player_id },
                        transaction: t
                    });
                    if (!leaderSect) {
                        await t.rollback();
                        return {
                            success: false,
                            message: `队长未加入任何宗门，无法开启同宗门副本【${dungeonCfg.name}】`
                        };
                    }
                    // 查询当前玩家的宗门
                    const memberSect = await PlayerSect.findOne({
                        where: { player_id: playerId },
                        transaction: t
                    });
                    if (!memberSect) {
                        await t.rollback();
                        return {
                            success: false,
                            message: `你未加入任何宗门，无法加入同宗门副本【${dungeonCfg.name}】（队长宗门：${leaderSect.sect_id}）`
                        };
                    }
                    // 比较宗门是否一致
                    if (leaderSect.sect_id !== memberSect.sect_id) {
                        await t.rollback();
                        return {
                            success: false,
                            message: `宗门不一致：队长属于【${leaderSect.sect_id}】，你属于【${memberSect.sect_id}】，无法加入同宗门副本【${dungeonCfg.name}】`
                        };
                    }
                } catch (e) {
                    console.warn(`[MultiDungeonService] join 同宗门校验异常（玩家 ${playerId}）: ${e.message}`);
                    await t.rollback();
                    return {
                        success: false,
                        message: `同宗门校验失败：${e.message}`
                    };
                }
            }

            // 校验队员是否已在其他未终态副本中
            const existingMembership = await MultiDungeonMember.findOne({
                where: { player_id: playerId },
                include: [{
                    model: MultiDungeonInstance, as: 'MultiDungeonInstance',
                    where: { instance_state: { [Op.notIn]: TERMINAL_STATES } },
                    required: true
                }],
                transaction: t
            });
            if (existingMembership) {
                await t.rollback();
                return {
                    success: false,
                    message: `你已在副本【${existingMembership.MultiDungeonInstance.instance_name}】中，请先解散或退出`
                };
            }

            // 冷却校验
            const inCooldown = await MultiDungeonService._isPlayerInCooldown(playerId, instance.instance_key, t);
            if (inCooldown) {
                await t.rollback();
                return {
                    success: false,
                    message: `副本【${dungeonCfg.name}】冷却中，到期时间：${inCooldown.cooldown_end_time.toLocaleString()}`
                };
            }

            // 创建成员记录
            // 2026-07-21 新增 xuese 专属字段：blood_qi / kill_score / is_eliminated
            const joinMemberData = {
                instance_id: instance.id,
                player_id: playerId,
                player_nickname: player.nickname,
                player_realm: player.realm,
                player_realm_rank: player.realm_rank || 0,
                role: 'member',
                join_time: new Date(),
                is_ready: 0,
                is_present: 1,
                contribution: 0,
                hp_remaining: BigInt(player.hp_current || 100),
                zongzi_invested: 0,
                cooldown_end_time: null
            };
            // 血色试炼：队员加入时初始化个人血气与杀戮分（migration_0058）
            if (instance.instance_key === 'xuese') {
                const xueseCfg = dungeonCfg;
                joinMemberData.blood_qi = xueseCfg?.member_init_blood_qi ?? 100;
                joinMemberData.kill_score = xueseCfg?.member_init_kill_score ?? 0;
                joinMemberData.is_eliminated = 0;
            }
            // 坠魔谷：队员加入时初始化个人心魔与道心（migration_0059）
            if (instance.instance_key === 'zhuimo') {
                const zhuimoCfg = dungeonCfg;
                joinMemberData.heart_demon = zhuimoCfg?.member_init_heart_demon ?? 0;
                joinMemberData.dao_heart = zhuimoCfg?.member_init_dao_heart ?? 100;
                joinMemberData.is_fallen = 0;
            }
            // 黄龙山：队员加入时初始化阵眼位置、贡献分、叛道标记（migration_0060）
            //   - huanglong_eye_position 默认 'unassigned'，第1幕入阵固守后由抉择更新
            //   - huanglong_contribution_score 默认 0，第1-3幕抉择累加
            //   - huanglong_is_defecting 默认 0，第3幕叛道抉择后置 1
            if (instance.instance_key === 'huanglong') {
                const huanglongCfg = dungeonCfg;
                joinMemberData.huanglong_eye_position = huanglongCfg?.member_init_eye_position ?? 'unassigned';
                joinMemberData.huanglong_contribution_score = huanglongCfg?.member_init_contribution_score ?? 0;
                joinMemberData.huanglong_is_defecting = huanglongCfg?.member_init_is_defecting ? 1 : 0;
            }
            await MultiDungeonMember.create(joinMemberData, { transaction: t });

            instance.member_count += 1;
            await instance.save({ transaction: t });

            // 小极宫专属：若加入的队员属于阴罗宗，则累加阴罗幡煞气到实例
            // 设计说明：阴罗幡煞气是阴罗宗队员的"集体资源池"，第3幕"阴幡镇魂"抉择需消耗 ≥50
            // 简化处理：每个阴罗宗队员加入时按基础值（默认100）累加到 instance.yinluo_banner_qi
            if (instance.instance_key === 'xiaoji') {
                try {
                    const PlayerSect = require('../../models/playerSect');
                    const playerSect = await PlayerSect.findOne({
                        where: { player_id: playerId },
                        transaction: t
                    });
                    if (playerSect && playerSect.sect_id === 'yinluo') {
                        const xiaojiCfg = config.dungeons.xiaoji;
                        const baseQi = xiaojiCfg.yinluo_base_banner_qi_per_member ?? 100;
                        instance.yinluo_banner_qi = (instance.yinluo_banner_qi || 0) + baseQi;
                        await instance.save({ transaction: t });
                    }
                } catch (e) {
                    // 阴罗幡煞气累加失败不阻塞加入流程，仅记录日志
                    console.warn(`[MultiDungeonService] join 小极宫：累加阴罗幡煞气失败（玩家 ${playerId}）: ${e.message}`);
                }
            }

            await t.commit();

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_member_joined', {
                instance_id: instance.id,
                member: { id: playerId, nickname: player.nickname, realm: player.realm },
                member_count: instance.member_count,
                member_max: instance.member_max
            });

            return {
                success: true,
                message: `已加入副本【${instance.instance_name}】（成员 ${instance.member_count}/${instance.member_max}）`,
                data: {
                    instance_id: instance.id,
                    dungeon_name: instance.instance_name,
                    member_count: instance.member_count,
                    member_max: instance.member_max
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] join 异常:', err);
            throw err;
        }
    }

    /**
     * 队长进入开打
     * 校验：队长权限 / 状态 preparing / 人数达标 / 端午需满 10 人 + 至少 1 个粽子
     * 状态转移：preparing → active，记录 started_at，进入第 1 幕
     * 特殊：端午第 1 幕需校验投粽总数，0 个触发空舟惩罚失败
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async enter(playerId) {
        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 查询玩家作为队长的未终态副本
            const instance = await MultiDungeonInstance.findOne({
                where: {
                    leader_player_id: playerId,
                    instance_state: { [Op.notIn]: TERMINAL_STATES }
                },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!instance) {
                await t.rollback();
                return { success: false, message: '你不是任何未结副本的队长，无法进入开打' };
            }

            if (instance.instance_state !== 'preparing') {
                await t.rollback();
                return {
                    success: false,
                    message: `副本状态为 ${instance.instance_state}，仅 preparing 状态可进入开打`
                };
            }

            // 人数下限校验
            if (instance.member_count < instance.member_min) {
                await t.rollback();
                return {
                    success: false,
                    message: `人数不足，需要至少 ${instance.member_min} 人，当前 ${instance.member_count} 人`
                };
            }

            const config = configLoader.getConfig('multi_dungeon_data');
            const dungeonCfg = config.dungeons[instance.instance_key];

            // 端午特殊校验：满 10 人 + 至少 1 个粽子
            if (instance.instance_key === 'duanwu') {
                if (instance.member_count < instance.member_max) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `端午镇蛟必须满 ${instance.member_max} 人开打，当前 ${instance.member_count} 人`
                    };
                }
                // 查询全队投粽总数
                const totalZongzi = await MultiDungeonMember.sum('zongzi_invested', {
                    where: { instance_id: instance.id },
                    transaction: t
                }) || 0;
                if (totalZongzi < 1) {
                    // 空舟惩罚！直接进入失败状态
                    await MultiDungeonService._applyEmptyBoatPenalty(instance, dungeonCfg, t);
                    await t.commit();
                    return {
                        success: false,
                        message: '空舟入江！未投任何粽子，全员扣除 388 灵石 + 500 修为，进入 23 小时冷却',
                        data: { penalty_applied: true, instance_state: 'failed' }
                    };
                }
                // 投粽加成：seal_stability += 投粽数 * 5
                const sealBonus = totalZongzi * dungeonCfg.zongzi_seal_stability_bonus_per_unit;
                instance.seal_stability = Math.min(
                    VARIABLE_BOUNDS.seal_stability.max,
                    instance.seal_stability + sealBonus
                );
            }

            // 进入 active 状态，开始第 1 幕
            instance.instance_state = 'active';
            instance.current_act = 1;
            instance.current_act_state = 'active';
            instance.started_at = new Date();
            await instance.save({ transaction: t });

            await t.commit();

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_entered', {
                instance_id: instance.id,
                dungeon_name: instance.instance_name,
                started_at: instance.started_at,
                current_act: 1,
                act_name: dungeonCfg.acts[0].act_name
            });

            return {
                success: true,
                message: `副本【${instance.instance_name}】正式开打！第 1 幕：${dungeonCfg.acts[0].act_name}`,
                data: {
                    instance_id: instance.id,
                    instance_state: 'active',
                    current_act: 1,
                    act_name: dungeonCfg.acts[0].act_name,
                    act_description: dungeonCfg.acts[0].description,
                    choices: dungeonCfg.acts[0].choices.map(c => ({
                        key: c.key,
                        text: c.text,
                        desc: c.desc
                    })),
                    variables: {
                        morale: instance.morale,
                        vigilance: instance.vigilance,
                        demon_corruption: instance.demon_corruption,
                        seal_stability: instance.seal_stability,
                        soul_stability: instance.soul_stability,
                        harvest_multiplier: instance.harvest_multiplier
                    }
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] enter 异常:', err);
            throw err;
        }
    }

    /**
     * 查看当前副本进度
     * 查询玩家参与的未终态副本，返回完整状态、成员、当前幕抉择选项
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getStatus(playerId) {
        const membership = await MultiDungeonMember.findOne({
            where: { player_id: playerId },
            include: [{
                model: MultiDungeonInstance, as: 'MultiDungeonInstance',
                where: { instance_state: { [Op.notIn]: TERMINAL_STATES } },
                required: true
            }]
        });
        if (!membership) {
            return {
                success: true,
                data: { has_instance: false, message: '当前未参与任何进行中的副本' }
            };
        }

        const instance = membership.MultiDungeonInstance;
        const config = configLoader.getConfig('multi_dungeon_data');
        const dungeonCfg = config.dungeons[instance.instance_key];
        const currentAct = dungeonCfg.acts.find(a => a.act_number === instance.current_act);

        // 查询所有成员
        const members = await MultiDungeonMember.findAll({
            where: { instance_id: instance.id, is_present: 1 },
            order: [['role', 'DESC'], ['join_time', 'ASC']]
        });

        // 查询历史抉择
        const choices = await MultiDungeonChoice.findAll({
            where: { instance_id: instance.id },
            order: [['act_number', 'ASC']]
        });

        // 2026-07-21 新增：第三幕进度查询（已抉择的阵眼数）
        let multiChoiceProgress = null;
        if (currentAct && currentAct.is_multi_choice_act) {
            const finishedCount = choices.filter(c => c.act_number === currentAct.act_number).length;
            const sequence = currentAct.multi_choice_sequence || [];
            const nextEyeKey = sequence[finishedCount];
            const nextEyeConfig = nextEyeKey ? (currentAct.multi_choice_pool || {})[nextEyeKey] : null;
            multiChoiceProgress = {
                finished_count: finishedCount,
                total_count: currentAct.multi_choice_count || sequence.length,
                next_eye_key: nextEyeKey || null,
                next_eye_name: nextEyeConfig ? nextEyeConfig.eye_name : null,
                next_eye_choices: nextEyeConfig ? nextEyeConfig.choices.map(c => ({
                    key: c.key, text: c.text, desc: c.desc
                })) : []
            };
        }

        // 2026-07-21 新增：根据幕类型动态生成 choices
        // - is_random_choice：返回 random_pool 全部项（前端可自选随机子集展示）
        // - is_multi_choice_act：返回当前阵眼的选项（从 multi_choice_progress 拿）
        // - is_auto_advance：返回空数组，并附加 is_auto_advance=true 标识
        // - 普通幕：返回 choices 数组
        let availableChoices = [];
        let isAutoAdvance = false;
        if (currentAct && instance.instance_state === 'active') {
            if (currentAct.is_auto_advance) {
                isAutoAdvance = true;
                availableChoices = [];
            } else if (currentAct.is_random_choice) {
                availableChoices = (currentAct.random_pool || []).map(c => ({
                    key: c.key, text: c.text, desc: c.desc
                }));
            } else if (currentAct.is_multi_choice_act) {
                availableChoices = multiChoiceProgress ? multiChoiceProgress.next_eye_choices : [];
            } else {
                availableChoices = (currentAct.choices || []).map(c => ({
                    key: c.key, text: c.text, desc: c.desc
                }));
            }
        }

        return {
            success: true,
            data: {
                has_instance: true,
                instance: {
                    id: instance.id,
                    dungeon_key: instance.instance_key,
                    dungeon_name: instance.instance_name,
                    instance_state: instance.instance_state,
                    current_act: instance.current_act,
                    current_act_state: instance.current_act_state,
                    member_count: instance.member_count,
                    member_max: instance.member_max,
                    member_min: instance.member_min,
                    expire_at: instance.expire_at,
                    started_at: instance.started_at,
                    is_leader: instance.leader_player_id === playerId,
                    role: membership.role
                },
                variables: {
                    morale: instance.morale,
                    vigilance: instance.vigilance,
                    demon_corruption: instance.demon_corruption,
                    seal_stability: instance.seal_stability,
                    soul_stability: instance.soul_stability,
                    harvest_multiplier: instance.harvest_multiplier,
                    // 昆吾山专属变量（非昆吾副本这些字段为默认值，前端可按 dungeon_key 判断是否展示）
                    demonic_qi: instance.demonic_qi,
                    mountain_seal: instance.mountain_seal,
                    treasure_pressure: instance.treasure_pressure,
                    linglong: instance.linglong,
                    seal_progress: instance.seal_progress,
                    tower_shadow_hp: instance.tower_shadow_hp ? instance.tower_shadow_hp.toString() : null,
                    // 虚天殿专属变量（2026-07-21 新增，非虚天殿副本为默认值，前端可按 dungeon_key 判断是否展示）
                    path_choice: instance.path_choice,                 // 0=未选 / 1=冰道 / 2=火道
                    formation_power: instance.formation_power,         // 阵法强度 0-100
                    void_soul_hp: instance.void_soul_hp ? instance.void_soul_hp.toString() : null, // 虚天主魂HP（第六幕使用）
                    // 小极宫专属变量（2026-07-21 新增，非小极宫副本为默认值，前端可按 dungeon_key 判断是否展示）
                    curse_disorder: instance.curse_disorder,           // 咒扰值 0-100，完美通关需 < 30
                    ice_seal_power: instance.ice_seal_power,           // 冰封之力 0-100，第4幕需达到 100 通关
                    flame_power: instance.flame_power,                 // 火焰之力 0-100，第2幕机关机制
                    yinluo_banner_qi: instance.yinluo_banner_qi,       // 阴罗幡煞气，第3幕阴幡镇魂需 ≥ 50
                    // 落云秘圃专属变量（2026-07-21 新增，migration_0055，非落云副本为默认值，前端可按 dungeon_key 判断是否展示）
                    spirit_vein_power: instance.spirit_vein_power,     // 灵脉之力 0-100，影响灵植生长
                    root_stability: instance.root_stability,           // 根脉稳定 0-100，第3幕需 ≥ 50 才不致失败
                    branch_vigor: instance.branch_vigor,               // 枝桠活力 0-100，影响灵眼树胚掉落
                    spirit_plant_aura: instance.spirit_plant_aura,     // 灵植灵气 0-100，影响最终奖励
                    act3_choice: instance.act3_choice,                 // 第3幕抉择键（cut_seal/branch_care/balanced_harvest）
                    // 苍坤洞府专属变量（2026-07-21 新增，migration_0057，非苍坤副本为默认值，前端可按 dungeon_key 判断是否展示）
                    forbidden_rift: instance.forbidden_rift,           // 禁制裂隙 0-100，影响门票线索掉率与脱身难度
                    scroll_clue: instance.scroll_clue,                 // 卷轴线索 0-100，千机残篇线索累积度
                    escape_difficulty: instance.escape_difficulty,     // 脱身难度 0-100，影响决战回合数与门票掉率
                    escape_choice: instance.escape_choice,             // 第4幕脱身抉择键（forced_breakout/formation_escape/stealth_escape）
                    cangkun_guardian_hp: instance.cangkun_guardian_hp ? instance.cangkun_guardian_hp.toString() : null, // 苍坤守灵HP（第4幕使用）
                    // 血色试炼专属变量（2026-07-21 新增，migration_0058，非血色副本为默认值，前端可按 dungeon_key 判断是否展示）
                    blood_qi_avg: instance.blood_qi_avg,               // 团队平均血气 0-100，第4幕决战每回合-10，归零团灭
                    blood_fury: instance.blood_fury,                   // 血怒 0-200，第4幕决战伤害加成
                    eliminations: instance.eliminations,               // 累计淘汰人数
                    survivor_count: instance.survivor_count,           // 最终幸存人数
                    xuese_boss_hp: instance.xuese_boss_hp ? instance.xuese_boss_hp.toString() : null, // 血色尊者HP（第4幕使用）
                    // 坠魔谷专属变量（2026-07-21 新增，migration_0059，非坠魔副本为默认值，前端可按 dungeon_key 判断是否展示）
                    avg_heart_demon: instance.avg_heart_demon,         // 团队平均心魔 0-100，第4幕决战每回合+5，满100团灭
                    avg_dao_heart: instance.avg_dao_heart,             // 团队平均道心 0-100，第4幕决战每回合-5，归0团灭
                    demon_boss_hp: instance.demon_boss_hp ? instance.demon_boss_hp.toString() : null, // 心魔Boss HP（第4幕使用）
                    // 黄龙山专属变量（2026-07-21 新增，migration_0060，非黄龙山副本为默认值，前端可按 dungeon_key 判断是否展示）
                    huanglong_formation_power: instance.huanglong_formation_power,  // 阵法强度 0-200，影响决战伤害与称号奖励
                    huanglong_resonance_count: instance.huanglong_resonance_count,  // 共鸣数 0-5，相同阵眼≥2人触发
                    huanglong_boss_hp: instance.huanglong_boss_hp ? instance.huanglong_boss_hp.toString() : null // 黄龙Boss HP（第4幕使用）
                },
                current_act: currentAct ? {
                    act_number: currentAct.act_number,
                    act_name: currentAct.act_name,
                    description: currentAct.description,
                    is_final_act: !!currentAct.is_final_act,
                    is_random_choice: !!currentAct.is_random_choice,
                    is_multi_choice_act: !!currentAct.is_multi_choice_act,
                    is_auto_advance: isAutoAdvance,
                    rounds_max: currentAct.rounds_max || null,
                    choices: availableChoices,
                    // 2026-07-21 新增：苍坤洞府第4幕的脱身抉择选项（仅 cangkun 第4幕有值）
                    // 前端在 is_auto_advance=true 且 escape_choices 非空时，要求玩家先选择脱身方式后再调用 /advance
                    escape_choices: Array.isArray(currentAct.escape_choices)
                        ? currentAct.escape_choices.map(c => ({
                            key: c.key, text: c.text, desc: c.desc,
                            escape_choice: c.escape_choice,
                            escape_difficulty_change: c.escape_difficulty_change,
                            ticket_clue_bonus: c.ticket_clue_bonus
                        }))
                        : [],
                    multi_choice_progress: multiChoiceProgress
                } : null,
                members: members.map(m => ({
                    player_id: m.player_id,
                    nickname: m.player_nickname,
                    realm: m.player_realm,
                    role: m.role,
                    contribution: m.contribution,
                    zongzi_invested: m.zongzi_invested,
                    is_ready: !!m.is_ready,
                    // 血色试炼专属：个人血气/杀戮分/淘汰标记（migration_0058，非血色副本为默认值）
                    blood_qi: m.blood_qi !== undefined ? m.blood_qi : 100,
                    kill_score: m.kill_score !== undefined ? m.kill_score : 0,
                    is_eliminated: !!m.is_eliminated,
                    // 坠魔谷专属：个人心魔/道心/堕魔标记（migration_0059，非坠魔副本为默认值）
                    heart_demon: m.heart_demon !== undefined ? m.heart_demon : 0,
                    dao_heart: m.dao_heart !== undefined ? m.dao_heart : 100,
                    is_fallen: !!m.is_fallen,
                    // 黄龙山专属：阵眼位置/贡献分/叛道标记（migration_0060，非黄龙山副本为默认值）
                    huanglong_eye_position: m.huanglong_eye_position || 'unassigned',
                    huanglong_contribution_score: m.huanglong_contribution_score !== undefined ? m.huanglong_contribution_score : 0,
                    huanglong_is_defecting: !!m.huanglong_is_defecting
                })),
                history_choices: choices.map(c => ({
                    act_number: c.act_number,
                    act_name: c.act_name,
                    chosen_option: c.chosen_option,
                    choice_text: c.choice_text,
                    eye_key: c.eye_key,
                    round_number: c.round_number,
                    chosen_at: c.chosen_at
                }))
            }
        };
    }

    /**
     * 队长推进抉择
     * 校验：队长权限 / 状态 active / 抉择键属于当前幕
     * 流程：应用抉择效果 → 检查失败条件 → 推进幕数 / 通关结算
     * 
     * 2026-07-21 扩展：支持昆吾山·封魔塔三种特殊幕类型
     *   - is_random_choice（第二幕）：从 random_pool 随机子集中选择
     *   - is_multi_choice_act（第三幕）：3 个阵眼按 multi_choice_sequence 顺序抉择
     *   - is_auto_advance（第四幕）：拒绝手动 choose，自动由 _processKunwuFinalAct 推进
     *
     * @param {number} playerId - 队长玩家ID
     * @param {string} choiceKey - 抉择键（如 stealth_hidden / baling_eye:suppress）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async choose(playerId, choiceKey) {
        if (!choiceKey || typeof choiceKey !== 'string') {
            return {
                success: false,
                message: 'choice_key 必填且必须为字符串',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            // 锁定玩家作为队长的 active 副本
            const instance = await MultiDungeonInstance.findOne({
                where: {
                    leader_player_id: playerId,
                    instance_state: 'active'
                },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!instance) {
                await t.rollback();
                return { success: false, message: '你不是任何 active 副本的队长，无法推进抉择' };
            }

            const config = configLoader.getConfig('multi_dungeon_data');
            const dungeonCfg = config.dungeons[instance.instance_key];
            const currentAct = dungeonCfg.acts.find(a => a.act_number === instance.current_act);
            if (!currentAct) {
                await t.rollback();
                return { success: false, message: `幕数 ${instance.current_act} 配置不存在` };
            }

            // 2026-07-21 新增：自动决战幕拒绝手动 choose
            // 昆吾山第四幕为 5 回合自动推进，进入时由 advance 接口触发
            if (currentAct.is_auto_advance) {
                await t.rollback();
                return {
                    success: false,
                    message: `第 ${instance.current_act} 幕【${currentAct.act_name}】为自动决战，无需手动抉择，请调用 /api/multi-dungeon/advance 触发推进`
                };
            }

            // 根据幕类型分流解析抉择
            let choice = null;
            let eyeKey = null;       // 第三幕阵眼键
            let eyeName = null;      // 第三幕阵眼名
            let randomRollInfo = null; // 第二幕随机池信息

            if (currentAct.is_random_choice) {
                // === 第二幕：随机池抉择 ===
                // 设计：choice_key 直接匹配 random_pool 中的项（不预先固定子集，保持灵活）
                // 若需"先看到3个再选1个"的UI体验，前端可通过 /status 拿到随机子集
                const randomPool = currentAct.random_pool || [];
                choice = randomPool.find(c => c.key === choiceKey);
                if (!choice) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `抉择键 ${choiceKey} 不属于第 ${instance.current_act} 幕【${currentAct.act_name}】的随机池`
                    };
                }
                randomRollInfo = {
                    pool_size: randomPool.length,
                    chosen: choice.key
                };
            } else if (currentAct.is_multi_choice_act) {
                // === 第三幕：多次抉择 ===
                // 通过查询本幕已有 choice 记录数确定当前阵眼
                const existingChoicesInAct = await MultiDungeonChoice.count({
                    where: { instance_id: instance.id, act_number: currentAct.act_number },
                    transaction: t
                });
                const multiChoiceCount = currentAct.multi_choice_count || 1;
                if (existingChoicesInAct >= multiChoiceCount) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `第 ${currentAct.act_number} 幕已完成 ${multiChoiceCount} 次阵眼抉择，应已自动推进，请勿重复调用`
                    };
                }
                // 按序列顺序确定当前阵眼
                const sequence = currentAct.multi_choice_sequence || [];
                eyeKey = sequence[existingChoicesInAct];
                if (!eyeKey) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `阵眼序列配置错误：第 ${existingChoicesInAct + 1} 个阵眼未定义`
                    };
                }
                const eyeConfig = (currentAct.multi_choice_pool || {})[eyeKey];
                if (!eyeConfig) {
                    await t.rollback();
                    return { success: false, message: `阵眼配置缺失：${eyeKey}` };
                }
                eyeName = eyeConfig.eye_name;
                // 支持 "baling_eye:suppress" 或 "suppress" 两种格式
                const normalizedKey = choiceKey.includes(':') ? choiceKey.split(':')[1] : choiceKey;
                choice = (eyeConfig.choices || []).find(c => c.key === normalizedKey);
                if (!choice) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `抉择键 ${choiceKey} 不属于阵眼【${eyeName}】的选项（suppress/plunder/break）`
                    };
                }
            } else {
                // === 普通幕：标准查找 ===
                choice = (currentAct.choices || []).find(c => c.key === choiceKey);
                if (!choice) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `抉择键 ${choiceKey} 不属于第 ${instance.current_act} 幕【${currentAct.act_name}】的选项`
                    };
                }
            }

            // 校验前置条件（requires_item / requires_concubine / requires_dao_companion / requires_artifact / requires_formation）
            const prereqCheck = await MultiDungeonService._checkChoicePrerequisites(playerId, choice, t);
            if (!prereqCheck.met) {
                await t.rollback();
                return { success: false, message: prereqCheck.message };
            }

            // 小极宫专属校验：requires_yinluo（第3幕"阴幡镇魂"选项需阴罗宗队员 + 煞气≥50）
            if (choice.requires_yinluo === true) {
                const yinluoCheck = await MultiDungeonService._checkYinluoRequirement(instance, choice, t);
                if (!yinluoCheck.met) {
                    await t.rollback();
                    return { success: false, message: yinluoCheck.message };
                }
            }

            // 小极宫专属：success_rate 抉择成功率判定
            // 设计说明：选择低概率成功率的抉择失败时仍应用 effects（按比例折扣），但效果减半
            // 简化处理：失败时不应用 items_granted，且 harvest_multiplier_change 减半（已默认应用）
            let successRateRoll = null;
            if (typeof choice.success_rate === 'number' && choice.success_rate < 1.0) {
                const roll = Math.random();
                successRateRoll = { roll, threshold: choice.success_rate, passed: roll < choice.success_rate };
            }

            // 校验抉择消耗（灵石/神识）
            if (choice.cost_spirit_stones > 0) {
                const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
                const playerStones = BigInt(player.spirit_stones || 0);
                if (playerStones < BigInt(choice.cost_spirit_stones)) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `灵石不足，本抉择需要 ${choice.cost_spirit_stones}，当前 ${playerStones.toString()}`
                    };
                }
                player.spirit_stones = (playerStones - BigInt(choice.cost_spirit_stones)).toString();
                await player.save({ transaction: t });
            }

            // 应用抉择效果（修改变量、消耗物品、HP 损失等）
            const effectResult = await MultiDungeonService._applyChoiceEffect(instance, choice, playerId, t);

            // 小极宫专属：发放 items_granted（仅当 success_rate 通过时）
            // 设计说明：稳采/急采选择会给队长发放对应物品（玄冰花），失败则不发放
            if (Array.isArray(choice.items_granted) && choice.items_granted.length > 0) {
                const shouldGrantItems = !successRateRoll || successRateRoll.passed;
                if (shouldGrantItems) {
                    try {
                        for (const itemKey of choice.items_granted) {
                            await InventoryService.addItem(playerId, itemKey, 1, t);
                        }
                        effectResult.items_granted = choice.items_granted;
                    } catch (e) {
                        // 物品发放失败不阻塞抉择流程，仅记录日志
                        console.warn(`[MultiDungeonService] 小极宫 items_granted 发放失败: ${e.message}`);
                        effectResult.items_granted_error = e.message;
                    }
                } else {
                    effectResult.items_granted_skipped = true;
                    effectResult.items_granted = [];
                }
            }
            // 记录 success_rate 掷骰结果
            if (successRateRoll) {
                effectResult.success_rate_roll = successRateRoll;
            }

            // 写入抉择记录（包含昆吾山 / 虚天殿专属变量变化字段）
            const choiceRecordData = {
                instance_id: instance.id,
                act_number: currentAct.act_number,
                act_name: currentAct.act_name,
                choice_key: eyeKey ? `${eyeKey}:${choice.key}` : choice.key,
                choice_text: eyeName ? `${eyeName} - ${choice.text}` : choice.text,
                chosen_option: choice.key,
                chosen_by: playerId,
                chosen_at: new Date(),
                morale_change: choice.morale_change || 0,
                vigilance_change: choice.vigilance_change || 0,
                demon_corruption_change: choice.demon_corruption_change || 0,
                seal_stability_change: choice.seal_stability_change || 0,
                harvest_multiplier_change: choice.harvest_multiplier_change || 0,
                // 昆吾山专属字段（非昆吾副本写入 0 即可）
                demonic_qi_change: choice.demonic_qi_change || 0,
                mountain_seal_change: choice.mountain_seal_change || 0,
                treasure_pressure_change: choice.treasure_pressure_change || 0,
                linglong_change: choice.linglong_change || 0,
                seal_progress_change: choice.seal_progress_change || 0,
                tower_shadow_hp_change: null,
                round_number: null,
                eye_key: eyeKey,
                // 虚天殿专属字段（2026-07-21 新增）
                // path_choice_change：道路选择变化（直接设置，仅第一幕有值）
                path_choice_change: (choice.path_choice_change !== undefined && choice.path_choice_change !== null)
                    ? choice.path_choice_change
                    : null,
                // formation_power_change：阵法强度变化（累加，非虚天殿写入 0 即可）
                formation_power_change: choice.formation_power_change || 0,
                // void_soul_hp_change：虚天主魂HP变化（仅第六幕自动决战使用）
                void_soul_hp_change: null,
                // 小极宫专属字段（2026-07-21 新增）
                curse_disorder_change: choice.curse_disorder_change || 0,
                ice_seal_power_change: choice.ice_seal_power_change || 0,
                flame_power_change: choice.flame_power_change || 0,
                yinluo_banner_qi_change: choice.yinluo_banner_qi_change || 0,
                // 落云秘圃专属字段（2026-07-21 新增，migration_0055）
                spirit_vein_power_change: choice.spirit_vein_power_change || 0,
                root_stability_change: choice.root_stability_change || 0,
                branch_vigor_change: choice.branch_vigor_change || 0,
                spirit_plant_aura_change: choice.spirit_plant_aura_change || 0,
                // 黄龙山专属字段（2026-07-21 新增，migration_0060）
                // huanglong_formation_power_change：阵法强度变化（累加，非黄龙山写入 0 即可）
                huanglong_formation_power_change: choice.huanglong_formation_power_change || 0,
                // huanglong_resonance_count_change：共鸣数变化（累加）
                huanglong_resonance_count_change: choice.huanglong_resonance_count_change || 0,
                // huanglong_eye_position：阵眼位置（直接设置，仅第1幕入阵固守有值）
                huanglong_eye_position: choice.huanglong_eye_position || null,
                // huanglong_contribution_score_self_change：自身贡献分变化（累加，叛道双倍）
                huanglong_contribution_score_self_change: choice.huanglong_contribution_score_self_change || 0,
                // huanglong_is_defecting_self：是否叛道（直接设置 0/1，仅第3幕叛道抉择有值）
                huanglong_is_defecting_self: (choice.huanglong_is_defecting_self !== undefined && choice.huanglong_is_defecting_self !== null)
                    ? choice.huanglong_is_defecting_self
                    : null
            };
            await MultiDungeonChoice.create(choiceRecordData, { transaction: t });

            // 检查失败条件
            const failCheck = MultiDungeonService._checkFailCondition(instance, currentAct);
            if (failCheck.failed) {
                instance.instance_state = 'failed';
                instance.current_act_state = 'failed';
                await instance.save({ transaction: t });

                // 失败：全员进入冷却（reason=failed，时长为 dungeonCfg.cooldown_hours）
                await MultiDungeonService._applyCooldownToAllMembers(instance, 'failed', t);

                await t.commit();

                MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_failed', {
                    instance_id: instance.id,
                    reason: failCheck.message,
                    reason_code: failCheck.reason,
                    final_act: instance.current_act
                });

                return {
                    success: true,
                    message: `副本失败：${failCheck.message}`,
                    data: {
                        instance_id: instance.id,
                        instance_state: 'failed',
                        failed_at: new Date(),
                        final_act: instance.current_act,
                        effect_applied: effectResult
                    }
                };
            }

            // 判断本幕是否完成
            let actComplete = true;
            if (currentAct.is_multi_choice_act) {
                // 第三幕：需完成 multi_choice_count 次抉择
                const totalChoicesInAct = await MultiDungeonChoice.count({
                    where: { instance_id: instance.id, act_number: currentAct.act_number },
                    transaction: t
                });
                actComplete = totalChoicesInAct >= (currentAct.multi_choice_count || 1);
            }

            // 通关判断：最后一幕 + 本幕完成 + clear_condition
            const isLastAct = instance.current_act >= dungeonCfg.acts.length;
            if (isLastAct && actComplete && currentAct.clear_condition) {
                // 小极宫专属：检查 clear_condition.ice_seal_power_gte 是否满足
                // 设计说明：第4幕"冰海妖围"需在 8 回合内将冰封之力推到 100
                // 若 ice_seal_power 不足目标值，副本失败而非通关
                const iceSealTarget = currentAct.clear_condition.ice_seal_power_gte;
                if (typeof iceSealTarget === 'number' && (instance.ice_seal_power || 0) < iceSealTarget) {
                    // 冰封之力不足，副本失败
                    instance.instance_state = 'failed';
                    instance.current_act_state = 'failed';
                    await instance.save({ transaction: t });

                    // 失败：全员进入冷却
                    await MultiDungeonService._applyCooldownToAllMembers(instance, 'failed', t);
                    await t.commit();

                    MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_failed', {
                        instance_id: instance.id,
                        reason: `冰封之力不足（${instance.ice_seal_power}/${iceSealTarget}），妖兽未尽，副本失败`,
                        reason_code: 'ice_seal_power_insufficient',
                        final_act: instance.current_act
                    });

                    return {
                        success: true,
                        message: `副本失败：冰封之力不足（${instance.ice_seal_power}/${iceSealTarget}），妖兽未尽`,
                        data: {
                            instance_id: instance.id,
                            instance_state: 'failed',
                            failed_at: new Date(),
                            final_act: instance.current_act,
                            ice_seal_power: instance.ice_seal_power,
                            ice_seal_target: iceSealTarget,
                            effect_applied: effectResult
                        }
                    };
                }

                // 落云秘圃专属：检查 clear_condition.root_stability_gte 是否满足
                // 设计说明：第3幕"截枝封灵"需保证 root_stability ≥ final_root_stability_target（默认50）
                // 若 root_stability 不足目标值，副本失败而非通关
                // 同时记录 act3_choice 字段以备后续灵眼树胚掉落判定
                if (instance.instance_key === 'luoyun') {
                    // 兜底：root_stability 不允许负数，强制设为 0
                    if (instance.root_stability < 0) {
                        instance.root_stability = 0;
                    }
                    const rootStabilityTarget = currentAct.clear_condition.root_stability_gte
                        || dungeonCfg.final_root_stability_target
                        || 50;
                    if ((instance.root_stability || 0) < rootStabilityTarget) {
                        // 根脉稳定不足，副本失败
                        instance.instance_state = 'failed';
                        instance.current_act_state = 'failed';
                        await instance.save({ transaction: t });

                        // 失败：全员进入冷却
                        await MultiDungeonService._applyCooldownToAllMembers(instance, 'failed', t);
                        await t.commit();

                        MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_failed', {
                            instance_id: instance.id,
                            reason: `根脉稳定不足（${instance.root_stability}/${rootStabilityTarget}），秘圃崩塌，副本失败`,
                            reason_code: 'root_stability_insufficient',
                            final_act: instance.current_act
                        });

                        return {
                            success: true,
                            message: `副本失败：根脉稳定不足（${instance.root_stability}/${rootStabilityTarget}），秘圃崩塌`,
                            data: {
                                instance_id: instance.id,
                                instance_state: 'failed',
                                failed_at: new Date(),
                                final_act: instance.current_act,
                                root_stability: instance.root_stability,
                                root_stability_target: rootStabilityTarget,
                                act3_choice: instance.act3_choice,
                                effect_applied: effectResult
                            }
                        };
                    }
                }

                instance.instance_state = 'cleared';
                instance.current_act_state = 'resolved';
                instance.cleared_at = new Date();

                // 判定首通
                const existingClears = await MultiDungeonInstance.count({
                    where: {
                        instance_key: instance.instance_key,
                        instance_state: 'cleared'
                    },
                    transaction: t
                });
                instance.first_clear = existingClears === 0 ? 1 : 0;
                await instance.save({ transaction: t });

                // 结算奖励
                const rewardsResult = await MultiDungeonService._settleRewards(instance, t);
                await t.commit();

                // 大五行幻世轮：多人副本通关后所有在场成员自动积累悟印（未装备时静默返回）
                try {
                    const presentMembers = await MultiDungeonMember.findAll({ where: { instance_id: instance.id, is_present: 1 } });
                    if (presentMembers && presentMembers.length > 0) {
                        await Promise.all(presentMembers.map(m =>
                            ArtifactDeepLineService.safeAddInsightExp(m.player_id, {
                                battle_type: 'dungeon',
                                is_win: true
                            })
                        ));
                    }
                } catch (e) { /* 悟印积累失败不阻塞主流程 */ }

                MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_cleared', {
                    instance_id: instance.id,
                    cleared_at: instance.cleared_at,
                    first_clear: !!instance.first_clear,
                    rewards: rewardsResult.summary
                });

                return {
                    success: true,
                    message: `副本通关！${currentAct.clear_condition.clear_message || ''}${instance.first_clear ? '【首通】' : ''}`,
                    data: {
                        instance_id: instance.id,
                        instance_state: 'cleared',
                        cleared_at: instance.cleared_at,
                        first_clear: !!instance.first_clear,
                        final_act: instance.current_act,
                        rewards: rewardsResult.summary
                    }
                };
            }

            // 本幕完成 → 推进到下一幕
            if (actComplete) {
                // 2026-07-21 新增：血色试炼淘汰机制
                // 第1幕和第3幕标记 is_pvp_eliminable=true，幕末淘汰血气最低者（migration_0058）
                // 设计目的：通过淘汰机制制造 PVP 紧张感，前3幕玩家需在侵略（高伤害高杀戮分但自损血气）
                // 与共生（保血气多幸存）之间做策略平衡
                if (instance.instance_key === 'xuese' &&
                    currentAct.is_pvp_eliminable &&
                    (currentAct.elimination_count || 0) > 0) {
                    const eliminated = await MultiDungeonService._applyXueseElimination(
                        instance, currentAct, t
                    );
                    if (eliminated.success) {
                        // 记录淘汰审计日志（写入 choice 表便于回放）
                        await MultiDungeonChoice.create({
                            instance_id: instance.id,
                            act_number: currentAct.act_number,
                            act_name: currentAct.act_name,
                            choice_key: 'elimination',
                            choice_text: `幕末淘汰：${eliminated.eliminated_members.map(m => m.nickname).join('、')}`,
                            chosen_option: 'auto_elimination',
                            chosen_by: instance.leader_player_id,
                            chosen_at: new Date(),
                            morale_change: 0,
                            vigilance_change: 0,
                            demon_corruption_change: 0,
                            seal_stability_change: 0,
                            harvest_multiplier_change: 0,
                            blood_qi_self_change: 0,
                            blood_qi_others_change: 0,
                            kill_score_change: 0,
                            blood_fury_change: 0,
                            round_number: 0,
                            eye_key: null
                        }, { transaction: t });
                    }
                }

                instance.current_act += 1;
                instance.current_act_state = 'active';
                await instance.save({ transaction: t });

                const nextAct = dungeonCfg.acts.find(a => a.act_number === instance.current_act);

                // 2026-07-21：自动决战幕不立即触发，需队长显式调用 /api/multi-dungeon/advance
                // 这样设计目的：
                //   1. 给玩家留出战术准备时间（看清楚前3幕累积的6变量）
                //   2. 前端可展示"进入封魔决战"的二次确认弹窗，避免误触
                //   3. 第四幕5回合自动推进是单次性结算，不可中途干预
                await t.commit();

                MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_choice_made', {
                    instance_id: instance.id,
                    chosen_act: currentAct.act_number,
                    chosen_option: choice.key,
                    next_act: instance.current_act,
                    next_act_name: nextAct ? nextAct.act_name : null,
                    is_auto_advance: !!(nextAct && nextAct.is_auto_advance),
                    effect_applied: effectResult
                });

                // 自动决战幕的提示信息不同
                if (nextAct && nextAct.is_auto_advance) {
                    return {
                        success: true,
                        message: `第 ${currentAct.act_number} 幕抉择【${choice.text}】完成，进入第 ${instance.current_act} 幕：${nextAct.act_name}。本幕为自动决战，请确认后调用 /api/multi-dungeon/advance 触发5回合战斗`,
                        data: {
                            instance_id: instance.id,
                            instance_state: 'active',
                            current_act: instance.current_act,
                            act_name: nextAct.act_name,
                            act_description: nextAct.description,
                            is_auto_advance: true,
                            choices: [],  // 自动决战无需手动抉择
                            rounds_max: nextAct.rounds_max || 5,
                            variables: {
                                morale: instance.morale,
                                vigilance: instance.vigilance,
                                demon_corruption: instance.demon_corruption,
                                seal_stability: instance.seal_stability,
                                soul_stability: instance.soul_stability,
                                harvest_multiplier: instance.harvest_multiplier,
                                // 昆吾山专属变量（含第四幕初始化前的状态）
                                demonic_qi: instance.demonic_qi,
                                mountain_seal: instance.mountain_seal,
                                treasure_pressure: instance.treasure_pressure,
                                linglong: instance.linglong,
                                seal_progress: instance.seal_progress,
                                tower_shadow_hp: instance.tower_shadow_hp ? instance.tower_shadow_hp.toString() : null,
                    // 虚天殿专属变量（2026-07-21 新增，非虚天殿副本为默认值，前端可按 dungeon_key 判断是否展示）
                    path_choice: instance.path_choice,                 // 0=未选 / 1=冰道 / 2=火道
                    formation_power: instance.formation_power,         // 阵法强度 0-100
                    void_soul_hp: instance.void_soul_hp ? instance.void_soul_hp.toString() : null, // 虚天主魂HP（第六幕使用）
                    // 小极宫专属变量（2026-07-21 新增，非小极宫副本为默认值，前端可按 dungeon_key 判断是否展示）
                    curse_disorder: instance.curse_disorder,           // 咒扰值 0-100，完美通关需 < 30
                    ice_seal_power: instance.ice_seal_power,           // 冰封之力 0-100，第4幕需达到 100 通关
                    flame_power: instance.flame_power,                 // 火焰之力 0-100，第2幕机关机制
                    yinluo_banner_qi: instance.yinluo_banner_qi        // 阴罗幡煞气，第3幕阴幡镇魂需 ≥ 50
                            },
                            effect_applied: effectResult
                        }
                    };
                }

                // 普通推进到下一幕
                return {
                    success: true,
                    message: `第 ${currentAct.act_number} 幕抉择【${choice.text}】完成，进入第 ${instance.current_act} 幕：${nextAct ? nextAct.act_name : '未知'}`,
                    data: {
                        instance_id: instance.id,
                        instance_state: 'active',
                        current_act: instance.current_act,
                        act_name: nextAct ? nextAct.act_name : null,
                        act_description: nextAct ? nextAct.description : null,
                        is_auto_advance: false,
                        choices: nextAct ? (nextAct.choices || []).map(c => ({
                            key: c.key,
                            text: c.text,
                            desc: c.desc
                        })) : [],
                        variables: {
                            morale: instance.morale,
                            vigilance: instance.vigilance,
                            demon_corruption: instance.demon_corruption,
                            seal_stability: instance.seal_stability,
                            soul_stability: instance.soul_stability,
                            harvest_multiplier: instance.harvest_multiplier,
                            demonic_qi: instance.demonic_qi,
                            mountain_seal: instance.mountain_seal,
                            treasure_pressure: instance.treasure_pressure,
                            linglong: instance.linglong,
                            seal_progress: instance.seal_progress,
                            tower_shadow_hp: instance.tower_shadow_hp ? instance.tower_shadow_hp.toString() : null,
                    // 虚天殿专属变量（2026-07-21 新增，非虚天殿副本为默认值，前端可按 dungeon_key 判断是否展示）
                    path_choice: instance.path_choice,                 // 0=未选 / 1=冰道 / 2=火道
                    formation_power: instance.formation_power,         // 阵法强度 0-100
                    void_soul_hp: instance.void_soul_hp ? instance.void_soul_hp.toString() : null, // 虚天主魂HP（第六幕使用）
                    // 小极宫专属变量（2026-07-21 新增，非小极宫副本为默认值，前端可按 dungeon_key 判断是否展示）
                    curse_disorder: instance.curse_disorder,           // 咒扰值 0-100，完美通关需 < 30
                    ice_seal_power: instance.ice_seal_power,           // 冰封之力 0-100，第4幕需达到 100 通关
                    flame_power: instance.flame_power,                 // 火焰之力 0-100，第2幕机关机制
                    yinluo_banner_qi: instance.yinluo_banner_qi        // 阴罗幡煞气，第3幕阴幡镇魂需 ≥ 50
                        },
                        effect_applied: effectResult
                    }
                };
            }

            // 第三幕中途：本幕未完成，保持当前幕，更新 act_state 反映进度
            const totalChoicesInAct = await MultiDungeonChoice.count({
                where: { instance_id: instance.id, act_number: currentAct.act_number },
                transaction: t
            });
            instance.current_act_state = `multi_choice_${totalChoicesInAct}`;
            await instance.save({ transaction: t });
            await t.commit();

            // 当前阵眼已处理，下一个阵眼信息
            const sequence = currentAct.multi_choice_sequence || [];
            const nextEyeKey = sequence[totalChoicesInAct];
            const nextEyeConfig = nextEyeKey ? (currentAct.multi_choice_pool || {})[nextEyeKey] : null;

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_choice_made', {
                instance_id: instance.id,
                chosen_act: currentAct.act_number,
                chosen_option: `${eyeKey}:${choice.key}`,
                chosen_eye_name: eyeName,
                next_eye: nextEyeKey,
                next_eye_name: nextEyeConfig ? nextEyeConfig.eye_name : null,
                effect_applied: effectResult
            });

            return {
                success: true,
                message: `阵眼【${eyeName}】抉择【${choice.text}】完成，剩余 ${sequence.length - totalChoicesInAct} 个阵眼`,
                data: {
                    instance_id: instance.id,
                    instance_state: 'active',
                    current_act: instance.current_act,
                    act_name: currentAct.act_name,
                    act_state: instance.current_act_state,
                    next_eye: nextEyeKey,
                    next_eye_name: nextEyeConfig ? nextEyeConfig.eye_name : null,
                    next_eye_choices: nextEyeConfig ? nextEyeConfig.choices.map(c => ({
                        key: c.key,
                        text: c.text,
                        desc: c.desc
                    })) : [],
                    variables: {
                        morale: instance.morale,
                        vigilance: instance.vigilance,
                        demon_corruption: instance.demon_corruption,
                        seal_stability: instance.seal_stability,
                        soul_stability: instance.soul_stability,
                        harvest_multiplier: instance.harvest_multiplier,
                        demonic_qi: instance.demonic_qi,
                        mountain_seal: instance.mountain_seal,
                        treasure_pressure: instance.treasure_pressure,
                        linglong: instance.linglong,
                        seal_progress: instance.seal_progress,
                        tower_shadow_hp: instance.tower_shadow_hp ? instance.tower_shadow_hp.toString() : null,
                    // 虚天殿专属变量（2026-07-21 新增，非虚天殿副本为默认值，前端可按 dungeon_key 判断是否展示）
                    path_choice: instance.path_choice,                 // 0=未选 / 1=冰道 / 2=火道
                    formation_power: instance.formation_power,         // 阵法强度 0-100
                    void_soul_hp: instance.void_soul_hp ? instance.void_soul_hp.toString() : null, // 虚天主魂HP（第六幕使用）
                    // 小极宫专属变量（2026-07-21 新增，非小极宫副本为默认值，前端可按 dungeon_key 判断是否展示）
                    curse_disorder: instance.curse_disorder,           // 咒扰值 0-100，完美通关需 < 30
                    ice_seal_power: instance.ice_seal_power,           // 冰封之力 0-100，第4幕需达到 100 通关
                    flame_power: instance.flame_power,                 // 火焰之力 0-100，第2幕机关机制
                    yinluo_banner_qi: instance.yinluo_banner_qi        // 阴罗幡煞气，第3幕阴幡镇魂需 ≥ 50
                    },
                    effect_applied: effectResult
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] choose 异常:', err);
            throw err;
        }
    }

    /**
     * 端午投粽
     * 队员消耗【美味肉粽】投入副本，单人上限 5 个，全队上限 30 个
     * 仅在 preparing 状态可投，active 后无法再投
     * @param {number} playerId - 玩家ID
     * @param {number} count - 投粽数量（1-5）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async throwZongzi(playerId, count) {
        if (!Number.isInteger(count) || count < 1 || count > 5) {
            return {
                success: false,
                message: 'count 必须为 1-5 之间的整数',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            // 查询玩家参与的 preparing 副本（仅端午）
            const membership = await MultiDungeonMember.findOne({
                where: { player_id: playerId },
                include: [{
                    model: MultiDungeonInstance, as: 'MultiDungeonInstance',
                    where: { instance_state: 'preparing', instance_key: 'duanwu' },
                    required: true
                }],
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!membership) {
                await t.rollback();
                return { success: false, message: '未找到可投粽的端午副本（仅 preparing 状态的端午副本可投粽）' };
            }

            const instance = membership.MultiDungeonInstance;
            const config = configLoader.getConfig('multi_dungeon_data');
            const dungeonCfg = config.dungeons.duanwu;

            // 单人上限校验
            if (membership.zongzi_invested + count > dungeonCfg.zongzi_per_person_max) {
                await t.rollback();
                return {
                    success: false,
                    message: `单人投粽上限 ${dungeonCfg.zongzi_per_person_max}，已投 ${membership.zongzi_invested}，本次最多可投 ${dungeonCfg.zongzi_per_person_max - membership.zongzi_invested}`
                };
            }

            // 全队上限校验
            const teamTotal = await MultiDungeonMember.sum('zongzi_invested', {
                where: { instance_id: instance.id },
                transaction: t
            }) || 0;
            if (teamTotal + count > dungeonCfg.zongzi_team_max) {
                await t.rollback();
                return {
                    success: false,
                    message: `全队投粽上限 ${dungeonCfg.zongzi_team_max}，已投 ${teamTotal}，本次最多可投 ${dungeonCfg.zongzi_team_max - teamTotal}`
                };
            }

            // 校验并消耗物品（美味肉粽）
            const hasItem = await InventoryService.hasItem(playerId, dungeonCfg.consume_item_key, count, t);
            if (!hasItem) {
                await t.rollback();
                return {
                    success: false,
                    message: `需要消耗【${dungeonCfg.consume_item_key}】×${count}，物品不足`
                };
            }
            const removed = await InventoryService.removeItem(playerId, dungeonCfg.consume_item_key, count, t);
            if (!removed) {
                await t.rollback();
                return { success: false, message: '消耗粽子失败' };
            }

            // 更新投粽数量
            membership.zongzi_invested += count;
            membership.contribution += count * 10; // 投粽贡献度 = 数量 * 10
            await membership.save({ transaction: t });

            await t.commit();

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_zongzi_thrown', {
                instance_id: instance.id,
                player_id: playerId,
                count: count,
                personal_total: membership.zongzi_invested,
                team_total: teamTotal + count,
                team_max: dungeonCfg.zongzi_team_max
            });

            return {
                success: true,
                message: `成功投入 ${count} 个粽子，个人累计 ${membership.zongzi_invested}，全队累计 ${teamTotal + count}/${dungeonCfg.zongzi_team_max}`,
                data: {
                    instance_id: instance.id,
                    personal_total: membership.zongzi_invested,
                    team_total: teamTotal + count,
                    team_max: dungeonCfg.zongzi_team_max
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] throwZongzi 异常:', err);
            throw err;
        }
    }

    /**
     * 队长解散副本
     * 幂等：已解散的不报错，直接返回成功
     * 状态转移：preparing/active → dissolved，记录 dissolved_at
     * @param {number} playerId - 队长玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async dissolve(playerId) {
        const t = await sequelize.transaction();
        try {
            const instance = await MultiDungeonInstance.findOne({
                where: {
                    leader_player_id: playerId,
                    instance_state: { [Op.notIn]: TERMINAL_STATES }
                },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            // 幂等：无未终态副本或已解散，返回成功
            if (!instance) {
                await t.commit();
                return {
                    success: true,
                    message: '当前无可解散的副本（可能已解散或未创建）',
                    data: { dissolved: false }
                };
            }

            instance.instance_state = 'dissolved';
            instance.dissolved_at = new Date();
            await instance.save({ transaction: t });

            await t.commit();

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_dissolved', {
                instance_id: instance.id,
                dissolved_at: instance.dissolved_at,
                by: 'leader'
            });

            return {
                success: true,
                message: `副本【${instance.instance_name}】已解散`,
                data: {
                    instance_id: instance.id,
                    instance_state: 'dissolved',
                    dissolved_at: instance.dissolved_at
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] dissolve 异常:', err);
            throw err;
        }
    }

    /**
     * 队长踢人
     * 幂等：被踢成员已不在则返回成功
     * @param {number} playerId - 队长玩家ID
     * @param {number} targetPlayerId - 被踢玩家ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async kick(playerId, targetPlayerId) {
        if (!targetPlayerId || typeof targetPlayerId !== 'number') {
            return {
                success: false,
                message: 'target_player_id 必填且必须为数字',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }
        if (targetPlayerId === playerId) {
            return { success: false, message: '不能踢自己（队长）', error_code: ErrorCodes.VALIDATION_ERROR };
        }

        const t = await sequelize.transaction();
        try {
            const instance = await MultiDungeonInstance.findOne({
                where: {
                    leader_player_id: playerId,
                    instance_state: { [Op.notIn]: TERMINAL_STATES }
                },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!instance) {
                await t.rollback();
                return { success: false, message: '你不是任何未结副本的队长' };
            }

            // 仅 preparing 状态可踢人
            if (instance.instance_state !== 'preparing') {
                await t.rollback();
                return {
                    success: false,
                    message: `副本状态为 ${instance.instance_state}，仅 preparing 状态可踢人`
                };
            }

            const targetMember = await MultiDungeonMember.findOne({
                where: { instance_id: instance.id, player_id: targetPlayerId },
                transaction: t,
                lock: t.LOCK.UPDATE
            });

            // 幂等：目标不在副本中
            if (!targetMember) {
                await t.commit();
                return {
                    success: true,
                    message: `目标玩家 ${targetPlayerId} 不在副本中（已踢出或从未加入）`,
                    data: { kicked: false }
                };
            }

            await targetMember.destroy({ transaction: t });

            instance.member_count = Math.max(0, instance.member_count - 1);
            await instance.save({ transaction: t });

            await t.commit();

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_member_kicked', {
                instance_id: instance.id,
                target_player_id: targetPlayerId,
                member_count: instance.member_count
            });
            // 通知被踢玩家
            try {
                WebSocketNotificationService.notifyPlayerUpdate(targetPlayerId, 'multi_dungeon_kicked', {
                    message: `你已被队长请离副本【${instance.instance_name}】`,
                    instance_id: instance.id
                });
            } catch (e) { /* 推送失败不阻塞 */ }

            return {
                success: true,
                message: `已将玩家 ${targetPlayerId} 请离副本`,
                data: {
                    instance_id: instance.id,
                    member_count: instance.member_count
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] kick 异常:', err);
            throw err;
        }
    }

    /**
     * 查看副本奖励池
     * 返回指定副本的完整奖励配置（普通掉落、首通奖励、稀有掉落）
     *
     * 修复（2026-07-21）：4 个副本的 rewards 字段结构不统一
     *   - yanyue: normal_drops / first_clear_bonus / rare_drop（无 base_rewards）
     *   - duanwu: base_rewards / rare_drops_by_contribution / first_clear_bonus（无 normal_drops/rare_drop）
     *   - kunwu:  base_rewards / normal_drops / first_clear_bonus / rare_drop + treasure_pressure_bonus + linglong_bonus
     *   - xutian: base_rewards / normal_drops / first_clear_bonus / rare_drop + path_choice_bonus + formation_power_bonus
     *
     * 前端 MultiDungeonPanel.vue 期望统一字段：normal_rewards / first_clear_rewards / rare_rewards（数组）
     * 后端做字段转换：将不同结构的配置统一映射为前端期望的数组格式
     *
     * @param {string} dungeonKey - 副本键
     * @returns {Promise<Object>} { success, data }
     */
    static async getRewards(dungeonKey) {
        // 2026-07-21 新增 kunwu（昆吾山·封魔塔）/ xutian（虚天殿）/ xiaoji（北冥小极宫）/ luoyun（落云秘圃）/ cangkun（苍坤洞府）/ xuese（血色试炼）/ zhuimo（坠魔谷）/ huanglong（黄龙山）
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian', 'xiaoji', 'luoyun', 'cangkun', 'xuese', 'zhuimo', 'huanglong'].includes(dungeonKey)) {
            return {
                success: false,
                message: 'dungeon_key 必须为 yanyue / duanwu / kunwu / xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const config = configLoader.getConfig('multi_dungeon_data');
        const dungeonCfg = config.dungeons[dungeonKey];
        const rawRewards = dungeonCfg.rewards || {};

        // 统一字段转换：将不同结构的配置映射为前端期望的 normal_rewards/first_clear_rewards/rare_rewards 数组
        // 每个元素统一结构：{ reward_key, name, description, amount, type }
        const normalRewards = [];
        const firstClearRewards = [];
        const rareRewards = [];

        // 1. base_rewards（基础奖励，3 个副本有，yanyue 没有）
        // 前端归入"普通掉落"区块展示，因为基础奖励也是必得奖励
        if (Array.isArray(rawRewards.base_rewards)) {
            for (const r of rawRewards.base_rewards) {
                normalRewards.push({
                    reward_key: r.item_key || r.type || `base_${normalRewards.length}`,
                    name: r.name || this._getRewardDisplayName(r),
                    description: r.desc || '',
                    amount: this._formatRewardAmount(r),
                    type: 'normal'
                });
            }
        }

        // 2. normal_drops（普通掉落，yanyue/kunwu/xutian 有，duanwu 没有）
        if (Array.isArray(rawRewards.normal_drops)) {
            for (const r of rawRewards.normal_drops) {
                normalRewards.push({
                    reward_key: r.item_key || `drop_${normalRewards.length}`,
                    name: r.name || r.item_key,
                    description: r.desc || '',
                    amount: this._formatDropAmount(r),
                    type: 'normal'
                });
            }
        }

        // 3. first_clear_bonus（首通奖励，4 个副本都有）
        if (Array.isArray(rawRewards.first_clear_bonus)) {
            for (const r of rawRewards.first_clear_bonus) {
                firstClearRewards.push({
                    reward_key: r.item_key || r.title_id || r.type || `first_${firstClearRewards.length}`,
                    name: r.title_name || r.name || this._getRewardDisplayName(r),
                    description: r.desc || '',
                    amount: this._formatRewardAmount(r),
                    type: 'first_clear'
                });
            }
        }

        // 4. rare_drop（稀有掉落，yanyue/kunwu/xutian 有，duanwu 没有）
        // 单个对象转为单元素数组
        if (rawRewards.rare_drop && typeof rawRewards.rare_drop === 'object') {
            const r = rawRewards.rare_drop;
            rareRewards.push({
                reward_key: r.item_key || 'rare_drop',
                name: r.name || r.item_key,
                description: r.desc || '',
                amount: this._formatDropAmount(r),
                type: 'rare'
            });
        }

        // 5. rare_drops_by_contribution（按贡献度掉落，仅 duanwu）
        // 归入"稀有掉落"区块展示，标注按贡献分配
        if (rawRewards.rare_drops_by_contribution && Array.isArray(rawRewards.rare_drops_by_contribution.drops)) {
            const desc = rawRewards.rare_drops_by_contribution.desc || '按贡献度分配';
            for (const r of rawRewards.rare_drops_by_contribution.drops) {
                rareRewards.push({
                    reward_key: r.item_key || r.type || `rare_${rareRewards.length}`,
                    name: r.name || this._getRewardDisplayName(r),
                    description: `${r.desc || ''}（${desc}）`,
                    amount: this._formatDropAmount(r),
                    type: 'rare'
                });
            }
        }

        return {
            success: true,
            data: {
                dungeon_key: dungeonKey,
                dungeon_name: dungeonCfg.name,
                // 顶层暴露统一字段名（前端 MultiDungeonRewardsData 类型期望）
                normal_rewards: normalRewards,
                first_clear_rewards: firstClearRewards,
                rare_rewards: rareRewards,
                // 同时保留原始 rewards 对象，供需要查看特殊机制（treasure_pressure_bonus 等）的场景使用
                rewards: rawRewards
            }
        };
    }

    /**
     * 格式化奖励数量显示
     * 处理 count/count_min/count_max/chance 等不同字段
     * @param {Object} r - 奖励配置
     * @returns {string} 格式化后的数量字符串
     */
    static _formatRewardAmount(r) {
        if (r.count !== undefined) return String(r.count);
        if (r.count_min !== undefined && r.count_max !== undefined) {
            if (r.count_min === r.count_max) return `×${r.count_min}`;
            return `×${r.count_min}-${r.count_max}`;
        }
        if (r.chance !== undefined) return `${(r.chance * 100).toFixed(1)}%`;
        return '-';
    }

    /**
     * 格式化掉落物数量显示（含概率）
     * @param {Object} r - 掉落配置
     * @returns {string} 格式化后的数量字符串
     */
    static _formatDropAmount(r) {
        const parts = [];
        if (r.chance !== undefined) {
            parts.push(`${(r.chance * 100).toFixed(1)}%`);
        }
        if (r.count_min !== undefined && r.count_max !== undefined) {
            if (r.count_min === r.count_max) parts.push(`×${r.count_min}`);
            else parts.push(`×${r.count_min}-${r.count_max}`);
        } else if (r.count !== undefined) {
            parts.push(`×${r.count}`);
        }
        return parts.join(' ') || '-';
    }

    /**
     * 根据 type 字段获取奖励显示名
     * @param {Object} r - 奖励配置
     * @returns {string} 显示名
     */
    static _getRewardDisplayName(r) {
        const typeMap = {
            exp: '修为',
            spirit_stones: '灵石',
            honor: '荣誉值',
            divine_sense: '神识提升',
            title: '称号',
            item: '物品',
            global_announce: '全服公告'
        };
        return typeMap[r.type] || r.type || '未知奖励';
    }

    /**
     * 历史副本记录
     * 分页查询玩家参与过的所有副本（含进行中、已结束）
     * @param {number} playerId - 玩家ID
     * @param {number} page - 页码（1-based）
     * @param {number} size - 每页条数（最大 50）
     * @returns {Promise<Object>} { success, data }
     */
    static async getHistory(playerId, page = 1, size = 20) {
        if (!Number.isInteger(page) || page < 1) page = 1;
        if (!Number.isInteger(size) || size < 1) size = 20;
        if (size > 50) size = 50;

        const offset = (page - 1) * size;
        const { rows, count } = await MultiDungeonMember.findAndCountAll({
            where: { player_id: playerId },
            include: [{
                model: MultiDungeonInstance, as: 'MultiDungeonInstance',
                required: true
            }],
            order: [['join_time', 'DESC']],
            limit: size,
            offset: offset,
            distinct: true
        });

        return {
            success: true,
            data: {
                page,
                size,
                total: count,
                records: rows.map(m => ({
                    instance_id: m.instance_id,
                    dungeon_key: m.MultiDungeonInstance.instance_key,
                    dungeon_name: m.MultiDungeonInstance.instance_name,
                    role: m.role,
                    instance_state: m.MultiDungeonInstance.instance_state,
                    current_act: m.MultiDungeonInstance.current_act,
                    first_clear: !!m.MultiDungeonInstance.first_clear,
                    contribution: m.contribution,
                    zongzi_invested: m.zongzi_invested,
                    started_at: m.MultiDungeonInstance.started_at,
                    cleared_at: m.MultiDungeonInstance.cleared_at,
                    dissolved_at: m.MultiDungeonInstance.dissolved_at,
                    join_time: m.join_time
                }))
            }
        };
    }

    /**
     * 查询冷却状态
     * 返回玩家在两个副本键下的当前冷却状态
     * @param {number} playerId - 玩家ID
     * @returns {Promise<Object>} { success, data }
     */
    static async getCooldown(playerId) {
        const cooldowns = {};
        // 2026-07-21 扩展：覆盖全部8个副本键（含 luoyun 落云秘圃 / cangkun 苍坤洞府 / xuese 血色试炼）
        for (const key of ['yanyue', 'duanwu', 'kunwu', 'xutian', 'xiaoji', 'luoyun', 'cangkun', 'xuese', 'zhuimo', 'huanglong']) {
            const latest = await MultiDungeonCooldown.findOne({
                where: { player_id: playerId, dungeon_key: key },
                order: [['cooldown_end_time', 'DESC']]
            });
            if (latest && new Date(latest.cooldown_end_time) > new Date()) {
                cooldowns[key] = {
                    in_cooldown: true,
                    cooldown_end_time: latest.cooldown_end_time,
                    cooldown_hours: latest.cooldown_hours,
                    reason: latest.reason,
                    remaining_ms: new Date(latest.cooldown_end_time).getTime() - Date.now()
                };
            } else {
                cooldowns[key] = { in_cooldown: false };
            }
        }

        return {
            success: true,
            data: { cooldowns }
        };
    }

    // ==================== GM 管理方法 ====================

    /**
     * GM 强制解散副本
     * @param {number} instanceId - 副本实例ID
     * @param {number} adminId - 管理员ID（用于审计）
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmForceDissolve(instanceId, adminId) {
        if (!instanceId || typeof instanceId !== 'number') {
            return {
                success: false,
                message: 'instance_id 必填且必须为数字',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const instance = await MultiDungeonInstance.findByPk(instanceId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!instance) {
                await t.rollback();
                return { success: false, message: '副本实例不存在' };
            }

            // 已终态幂等返回
            if (TERMINAL_STATES.includes(instance.instance_state)) {
                await t.commit();
                return {
                    success: true,
                    message: `副本已处于终态 ${instance.instance_state}，无需强制解散`,
                    data: { instance_id: instanceId, instance_state: instance.instance_state }
                };
            }

            instance.instance_state = 'dissolved';
            instance.dissolved_at = new Date();
            await instance.save({ transaction: t });

            await t.commit();

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_gm_force_dissolved', {
                instance_id: instance.id,
                admin_id: adminId,
                dissolved_at: instance.dissolved_at
            });

            return {
                success: true,
                message: `已强制解散副本【${instance.instance_name}】（实例ID: ${instance.id}）`,
                data: {
                    instance_id: instance.id,
                    instance_state: 'dissolved',
                    dissolved_at: instance.dissolved_at,
                    admin_id: adminId
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] gmForceDissolve 异常:', err);
            throw err;
        }
    }

    /**
     * GM 调整副本变量
     * 支持通用变量 + 昆吾山/虚天殿专属变量
     * - 通用：morale / vigilance / demon_corruption / seal_stability / soul_stability / harvest_multiplier
     * - 昆吾山：demonic_qi / mountain_seal / treasure_pressure / linglong / seal_progress / tower_shadow_hp
     * - 虚天殿：path_choice / formation_power / void_soul_hp
     *
     * @param {number} instanceId - 副本实例ID
     * @param {string} variable - 变量名
     * @param {number} value - 目标值
     * @param {number} adminId - 管理员ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmAdjustVariable(instanceId, variable, value, adminId) {
        // 2026-07-21 扩展：支持昆吾山/虚天殿/小极宫/落云秘圃专属变量
        const allowedVars = [
            // 通用变量
            'morale', 'vigilance', 'demon_corruption', 'seal_stability', 'soul_stability', 'harvest_multiplier',
            // 昆吾山·封魔塔专属变量
            'demonic_qi', 'mountain_seal', 'treasure_pressure', 'linglong', 'seal_progress', 'tower_shadow_hp',
            // 虚天殿专属变量
            'path_choice', 'formation_power', 'void_soul_hp',
            // 小极宫专属变量
            'curse_disorder', 'ice_seal_power', 'flame_power', 'yinluo_banner_qi',
            // 落云秘圃专属变量（2026-07-21 新增，migration_0055）
            'spirit_vein_power', 'root_stability', 'branch_vigor', 'spirit_plant_aura', 'act3_choice'
        ];
        if (!allowedVars.includes(variable)) {
            return {
                success: false,
                message: `variable 必须为 ${allowedVars.join('/')} 之一`,
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }
        if (typeof value !== 'number' || Number.isNaN(value)) {
            // 落云秘圃 act3_choice 为字符串枚举（cut_seal/branch_care/balanced_harvest），允许字符串
            if (variable !== 'act3_choice') {
                return {
                    success: false,
                    message: 'value 必须为数字',
                    error_code: ErrorCodes.VALIDATION_ERROR
                };
            }
            if (typeof value !== 'string') {
                return {
                    success: false,
                    message: 'act3_choice 必须为字符串（cut_seal/branch_care/balanced_harvest）',
                    error_code: ErrorCodes.VALIDATION_ERROR
                };
            }
        }

        const t = await sequelize.transaction();
        try {
            const instance = await MultiDungeonInstance.findByPk(instanceId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!instance) {
                await t.rollback();
                return { success: false, message: '副本实例不存在' };
            }

            // 边界校验：VARIABLE_BOUNDS 中定义的变量按 min/max 限制
            // tower_shadow_hp / void_soul_hp 为 BIGINT 无边界限制，直接使用传入值
            // act3_choice 为字符串枚举，直接使用传入值
            const bounds = VARIABLE_BOUNDS[variable];
            let clampedValue;
            if (variable === 'act3_choice') {
                // 字符串枚举，直接使用传入值
                clampedValue = value;
            } else if (bounds) {
                clampedValue = Math.max(bounds.min, Math.min(bounds.max, value));
            } else {
                // 无边界的 BIGINT 变量（tower_shadow_hp / void_soul_hp），不允许负数
                clampedValue = Math.max(0, Math.floor(value));
            }

            const oldValue = instance[variable];
            instance[variable] = clampedValue;
            await instance.save({ transaction: t });

            await t.commit();

            MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_gm_adjust_variable', {
                instance_id: instance.id,
                variable,
                old_value: oldValue,
                new_value: clampedValue,
                admin_id: adminId
            });

            return {
                success: true,
                message: `副本 ${instance.id} 变量 ${variable} 已从 ${oldValue} 调整为 ${clampedValue}`,
                data: {
                    instance_id: instance.id,
                    variable,
                    old_value: oldValue,
                    new_value: clampedValue,
                    admin_id: adminId
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] gmAdjustVariable 异常:', err);
            throw err;
        }
    }

    /**
     * GM 直接发放副本奖励
     * 从奖励池中选取指定奖励项，直接发放给玩家
     * @param {number} playerId - 玩家ID
     * @param {string} dungeonKey - 副本键
     * @param {string} rewardKey - 奖励键（normal_drop 的 item_key 或 first_clear_bonus 的标识）
     * @param {number} adminId - 管理员ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmGrantReward(playerId, dungeonKey, rewardKey, adminId) {
        // 2026-07-21 扩展：支持 kunwu / xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian', 'xiaoji', 'luoyun', 'cangkun', 'xuese', 'zhuimo', 'huanglong'].includes(dungeonKey)) {
            return {
                success: false,
                message: 'dungeon_key 必须为 yanyue / duanwu / kunwu / xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const config = configLoader.getConfig('multi_dungeon_data');
        const dungeonCfg = config.dungeons[dungeonKey];

        // 在 normal_drops 中查找
        let reward = null;
        let rewardType = null;
        if (dungeonCfg.rewards.normal_drops) {
            const drop = dungeonCfg.rewards.normal_drops.find(d => d.item_key === rewardKey);
            if (drop) {
                reward = drop;
                rewardType = 'normal_drop';
            }
        }
        // 在 first_clear_bonus 中查找
        if (!reward && dungeonCfg.rewards.first_clear_bonus) {
            const bonus = dungeonCfg.rewards.first_clear_bonus.find(b => b.type === 'item' && b.item_key === rewardKey);
            if (bonus) {
                reward = { item_key: bonus.item_key, name: bonus.item_key, count_min: bonus.count, count_max: bonus.count };
                rewardType = 'first_clear_bonus';
            }
        }
        // 稀有掉落
        if (!reward && dungeonCfg.rewards.rare_drop && dungeonCfg.rewards.rare_drop.item_key === rewardKey) {
            reward = {
                item_key: dungeonCfg.rewards.rare_drop.item_key,
                name: dungeonCfg.rewards.rare_drop.name,
                count_min: 1,
                count_max: 1
            };
            rewardType = 'rare_drop';
        }
        if (!reward) {
            return {
                success: false,
                message: `奖励键 ${rewardKey} 不在副本 ${dungeonKey} 的奖励池中`,
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const t = await sequelize.transaction();
        try {
            const player = await Player.findByPk(playerId, { transaction: t, lock: t.LOCK.UPDATE });
            if (!player) {
                await t.rollback();
                return { success: false, message: '玩家不存在' };
            }

            // 灵石奖励直接加到玩家
            if (reward.is_spirit_stones || reward.item_key === 'spirit_stones') {
                const count = Math.floor(reward.count_min + Math.random() * (reward.count_max - reward.count_min + 1));
                const oldStones = BigInt(player.spirit_stones || 0);
                player.spirit_stones = (oldStones + BigInt(count)).toString();
                await player.save({ transaction: t });
                await t.commit();
                return {
                    success: true,
                    message: `已发放灵石 ${count} 给玩家 ${player.nickname}`,
                    data: {
                        player_id: playerId,
                        reward_type: rewardType,
                        item_key: 'spirit_stones',
                        count: count,
                        admin_id: adminId
                    }
                };
            }

            // 普通物品通过 InventoryService 发放
            const count = Math.floor(reward.count_min + Math.random() * (reward.count_max - reward.count_min + 1));
            try {
                await InventoryService.addItem(playerId, reward.item_key, count, t);
            } catch (addItemErr) {
                await t.rollback();
                return {
                    success: false,
                    message: `发放物品失败：${addItemErr.message}（可能物品配置 ${reward.item_key} 不存在）`
                };
            }
            await t.commit();

            try {
                WebSocketNotificationService.notifyPlayerUpdate(playerId, 'multi_dungeon_gm_grant_reward', {
                    message: `GM 发放副本奖励：${reward.name || reward.item_key} × ${count}`,
                    item_key: reward.item_key,
                    count: count
                });
            } catch (e) { /* 推送失败不阻塞 */ }

            return {
                success: true,
                message: `已发放 ${reward.name || reward.item_key} × ${count} 给玩家 ${player.nickname}`,
                data: {
                    player_id: playerId,
                    reward_type: rewardType,
                    item_key: reward.item_key,
                    count: count,
                    admin_id: adminId
                }
            };
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] gmGrantReward 异常:', err);
            throw err;
        }
    }

    /**
     * GM 重置玩家冷却
     * 删除玩家在某副本键下的所有冷却记录
     * @param {number} playerId - 玩家ID
     * @param {string} dungeonKey - 副本键（'all' 表示全部）
     * @param {number} adminId - 管理员ID
     * @returns {Promise<Object>} { success, message, data }
     */
    static async gmResetCooldown(playerId, dungeonKey, adminId) {
        // 2026-07-21 扩展：支持 kunwu / xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong
        if (!['yanyue', 'duanwu', 'kunwu', 'xutian', 'xiaoji', 'luoyun', 'cangkun', 'xuese', 'zhuimo', 'huanglong', 'all'].includes(dungeonKey)) {
            return {
                success: false,
                message: 'dungeon_key 必须为 yanyue / duanwu / kunwu / xutian / xiaoji / luoyun / cangkun / xuese / zhuimo / huanglong / all',
                error_code: ErrorCodes.VALIDATION_ERROR
            };
        }

        const whereClause = { player_id: playerId };
        if (dungeonKey !== 'all') {
            whereClause.dungeon_key = dungeonKey;
        }

        const deleted = await MultiDungeonCooldown.destroy({ where: whereClause });

        return {
            success: true,
            message: `已重置玩家 ${playerId} 在 ${dungeonKey} 副本的冷却（删除 ${deleted} 条记录）`,
            data: {
                player_id: playerId,
                dungeon_key: dungeonKey,
                deleted_count: deleted,
                admin_id: adminId
            }
        };
    }

    // ==================== 内部方法 ====================

    /**
     * 查询玩家是否在某副本键下处于冷却中
     * @param {number} playerId - 玩家ID
     * @param {string} dungeonKey - 副本键
     * @param {Object} transaction - 事务
     * @returns {Promise<Object|null>} 冷却记录（in_cooldown=true）或 null
     */
    static async _isPlayerInCooldown(playerId, dungeonKey, transaction) {
        const latest = await MultiDungeonCooldown.findOne({
            where: { player_id: playerId, dungeon_key: dungeonKey },
            order: [['cooldown_end_time', 'DESC']],
            transaction
        });
        if (latest && new Date(latest.cooldown_end_time) > new Date()) {
            return latest;
        }
        return null;
    }

    /**
     * 校验抉择的前置条件
     * 支持 requires_item / requires_concubine / requires_dao_companion / requires_artifact / requires_formation
     * @param {number} playerId - 队长玩家ID
     * @param {Object} choice - 抉择配置
     * @param {Object} transaction - 事务
     * @returns {Promise<{met: boolean, message?: string}>}
     */
    static async _checkChoicePrerequisites(playerId, choice, transaction) {
        // requires_item：需要消耗某物品（如素女禁纹×3）
        if (choice.requires_item) {
            const needCount = choice.requires_item_count || 1;
            const hasItem = await InventoryService.hasItem(playerId, choice.requires_item, needCount, transaction);
            if (!hasItem) {
                return { met: false, message: `本抉择需要物品【${choice.requires_item}】×${needCount}` };
            }
            // 扣除物品
            const removed = await InventoryService.removeItem(playerId, choice.requires_item, needCount, transaction);
            if (!removed) {
                return { met: false, message: `扣除物品【${choice.requires_item}】失败` };
            }
        }
        // requires_concubine：需要拥有特定侍妾（简化：仅校验是否存在该侍妾记录）
        if (choice.requires_concubine) {
            const Concubine = require('../../models/concubine');
            const has = await Concubine.findOne({
                where: { player_id: playerId, concubine_key: choice.requires_concubine },
                transaction
            });
            if (!has) {
                return { met: false, message: `本抉择需要侍妾【${choice.requires_concubine}】在场` };
            }
        }
        // requires_dao_companion：需要道侣
        if (choice.requires_dao_companion) {
            const player = await Player.findByPk(playerId, { transaction });
            if (!player || !player.dao_companion_id) {
                return { met: false, message: '本抉择需要道侣在场' };
            }
        }
        // requires_artifact：需要法宝（简化：仅校验物品存在）
        if (choice.requires_artifact) {
            const has = await InventoryService.hasItem(playerId, choice.requires_artifact, 1, transaction);
            if (!has) {
                return { met: false, message: `本抉择需要法宝【${choice.requires_artifact}】` };
            }
        }
        // requires_formation：需要激活阵法（简化：校验玩家 active_formation_id 字段）
        if (choice.requires_formation) {
            const player = await Player.findByPk(playerId, { transaction });
            if (!player || !player.active_formation_id) {
                return { met: false, message: '本抉择需要激活阵法' };
            }
        }
        return { met: true };
    }

    /**
     * 小极宫专属校验：阴罗宗队员 + 阴罗幡煞气充足
     *
     * 业务说明：
     *   - 第3幕"寒骊翻脸"中的"阴幡镇魂"选项要求队伍中有阴罗宗弟子且煞气 ≥ 50
     *   - 阴罗宗判定：PlayerSect.sect_id === 'yinluo'
     *   - 煞气值在队员加入副本时按 yinluo_base_banner_qi_per_member（默认100/人）累加到 instance.yinluo_banner_qi
     *   - 该校验仅做只读判断，不消耗煞气（消耗由 choice.yinluo_banner_qi_change 在 _applyChoiceEffect 中处理）
     *
     * @param {Object} instance - 副本实例
     * @param {Object} choice - 抉择配置（含 min_banner_qi）
     * @param {Object} transaction - 事务
     * @returns {Promise<{met: boolean, message?: string}>} 校验结果
     */
    static async _checkYinluoRequirement(instance, choice, transaction) {
        // 1. 校验队伍中是否存在阴罗宗队员（查 MultiDungeonMember → PlayerSect.sect_id === 'yinluo'）
        const PlayerSect = require('../../models/playerSect');
        const members = await MultiDungeonMember.findAll({
            where: { instance_id: instance.id, is_present: 1 },
            transaction
        });
        if (!members || members.length === 0) {
            return { met: false, message: '队伍中无任何在线成员，无法触发阴幡镇魂' };
        }

        // 查询所有成员的宗门归属，判断是否存在阴罗宗队员
        const memberPlayerIds = members.map(m => m.player_id);
        const yinluoSects = await PlayerSect.findAll({
            where: { player_id: { [Op.in]: memberPlayerIds }, sect_id: 'yinluo' },
            transaction
        });
        if (!yinluoSects || yinluoSects.length === 0) {
            return { met: false, message: '本抉择需要队伍中有阴罗宗弟子方可施展阴幡镇魂' };
        }

        // 2. 校验阴罗幡煞气是否充足（choice.min_banner_qi 默认 50）
        const minBannerQi = (typeof choice.min_banner_qi === 'number') ? choice.min_banner_qi : 50;
        const currentBannerQi = instance.yinluo_banner_qi || 0;
        if (currentBannerQi < minBannerQi) {
            return {
                met: false,
                message: `阴罗幡煞气不足（当前 ${currentBannerQi}/${minBannerQi}），无法施展阴幡镇魂`
            };
        }

        // 校验通过
        return { met: true };
    }

    /**
     * 应用抉择效果
     * 修改变量、扣减神识、扣减队伍 HP、累加收获倍率
     * @param {Object} instance - 副本实例
     * @param {Object} choice - 抉择配置
     * @param {number} playerId - 队长玩家ID
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} 应用效果摘要
     */
    static async _applyChoiceEffect(instance, choice, playerId, transaction) {
        const applied = {};

        // 应用变量变化（带边界限制）
        if (choice.morale_change) {
            instance.morale = Math.max(VARIABLE_BOUNDS.morale.min, Math.min(VARIABLE_BOUNDS.morale.max, instance.morale + choice.morale_change));
            applied.morale = instance.morale;
        }
        if (choice.vigilance_change) {
            instance.vigilance = Math.max(VARIABLE_BOUNDS.vigilance.min, Math.min(VARIABLE_BOUNDS.vigilance.max, instance.vigilance + choice.vigilance_change));
            applied.vigilance = instance.vigilance;
        }
        if (choice.demon_corruption_change) {
            instance.demon_corruption = Math.max(VARIABLE_BOUNDS.demon_corruption.min, Math.min(VARIABLE_BOUNDS.demon_corruption.max, instance.demon_corruption + choice.demon_corruption_change));
            applied.demon_corruption = instance.demon_corruption;
        }
        if (choice.seal_stability_change) {
            instance.seal_stability = Math.max(VARIABLE_BOUNDS.seal_stability.min, Math.min(VARIABLE_BOUNDS.seal_stability.max, instance.seal_stability + choice.seal_stability_change));
            applied.seal_stability = instance.seal_stability;
        }
        if (choice.soul_stability_change) {
            instance.soul_stability = Math.max(VARIABLE_BOUNDS.soul_stability.min, Math.min(VARIABLE_BOUNDS.soul_stability.max, instance.soul_stability + choice.soul_stability_change));
            applied.soul_stability = instance.soul_stability;
        }
        if (choice.harvest_multiplier_change) {
            instance.harvest_multiplier = Math.max(VARIABLE_BOUNDS.harvest_multiplier.min, Math.min(VARIABLE_BOUNDS.harvest_multiplier.max, instance.harvest_multiplier + choice.harvest_multiplier_change));
            applied.harvest_multiplier = instance.harvest_multiplier;
        }

        // 昆吾山·封魔塔专属变量变化（2026-07-21 新增）
        if (choice.demonic_qi_change) {
            instance.demonic_qi = Math.max(VARIABLE_BOUNDS.demonic_qi.min, Math.min(VARIABLE_BOUNDS.demonic_qi.max, (instance.demonic_qi || 0) + choice.demonic_qi_change));
            applied.demonic_qi = instance.demonic_qi;
        }
        if (choice.mountain_seal_change) {
            instance.mountain_seal = Math.max(VARIABLE_BOUNDS.mountain_seal.min, Math.min(VARIABLE_BOUNDS.mountain_seal.max, (instance.mountain_seal || 0) + choice.mountain_seal_change));
            applied.mountain_seal = instance.mountain_seal;
        }
        if (choice.treasure_pressure_change) {
            instance.treasure_pressure = Math.max(VARIABLE_BOUNDS.treasure_pressure.min, Math.min(VARIABLE_BOUNDS.treasure_pressure.max, (instance.treasure_pressure || 0) + choice.treasure_pressure_change));
            applied.treasure_pressure = instance.treasure_pressure;
        }
        if (choice.linglong_change) {
            instance.linglong = Math.max(VARIABLE_BOUNDS.linglong.min, Math.min(VARIABLE_BOUNDS.linglong.max, (instance.linglong || 0) + choice.linglong_change));
            applied.linglong = instance.linglong;
        }

        // 虚天殿专属变量变化（2026-07-21 新增）
        if (choice.path_choice_change !== undefined && choice.path_choice_change !== null) {
            // path_choice 为枚举值（0/1/2），直接设置而非累加
            instance.path_choice = Math.max(VARIABLE_BOUNDS.path_choice.min, Math.min(VARIABLE_BOUNDS.path_choice.max, choice.path_choice_change));
            applied.path_choice = instance.path_choice;
        }
        if (choice.formation_power_change) {
            instance.formation_power = Math.max(VARIABLE_BOUNDS.formation_power.min, Math.min(VARIABLE_BOUNDS.formation_power.max, (instance.formation_power || 0) + choice.formation_power_change));
            applied.formation_power = instance.formation_power;
        }

        // 小极宫专属变量变化（2026-07-21 新增）
        // curse_disorder 咒扰值、ice_seal_power 冰封之力、flame_power 火焰之力、yinluo_banner_qi 阴罗幡煞气
        // 均按 0-100 边界累加，yinluo_banner_qi_change 为负值表示消耗
        if (choice.curse_disorder_change) {
            instance.curse_disorder = Math.max(0, Math.min(100, (instance.curse_disorder || 0) + choice.curse_disorder_change));
            applied.curse_disorder = instance.curse_disorder;
        }
        if (choice.ice_seal_power_change) {
            instance.ice_seal_power = Math.max(0, Math.min(100, (instance.ice_seal_power || 0) + choice.ice_seal_power_change));
            applied.ice_seal_power = instance.ice_seal_power;
        }
        if (choice.flame_power_change) {
            instance.flame_power = Math.max(0, Math.min(100, (instance.flame_power || 0) + choice.flame_power_change));
            applied.flame_power = instance.flame_power;
        }
        if (choice.yinluo_banner_qi_change) {
            // 阴罗幡煞气允许消耗到 0
            instance.yinluo_banner_qi = Math.max(0, (instance.yinluo_banner_qi || 0) + choice.yinluo_banner_qi_change);
            applied.yinluo_banner_qi = instance.yinluo_banner_qi;
        }

        // 落云秘圃专属变量变化（2026-07-21 新增，migration_0055）
        // spirit_vein_power 灵脉之力、root_stability 根脉稳定、branch_vigor 枝桠活力、spirit_plant_aura 灵植灵气
        // 均按 0-100 边界累加；choice.guarantee_sapling / choice.sapling_drop_rate 仅在第3幕抉择上出现
        // 第3幕抉择记录 act3_choice 字段，用于 _settleRewards 中灵眼树胚掉落判定
        if (choice.spirit_vein_power_change) {
            instance.spirit_vein_power = Math.max(0, Math.min(100, (instance.spirit_vein_power || 0) + choice.spirit_vein_power_change));
            applied.spirit_vein_power = instance.spirit_vein_power;
        }
        if (choice.root_stability_change) {
            instance.root_stability = Math.max(0, Math.min(100, (instance.root_stability || 0) + choice.root_stability_change));
            applied.root_stability = instance.root_stability;
        }
        if (choice.branch_vigor_change) {
            instance.branch_vigor = Math.max(0, Math.min(100, (instance.branch_vigor || 0) + choice.branch_vigor_change));
            applied.branch_vigor = instance.branch_vigor;
        }
        if (choice.spirit_plant_aura_change) {
            instance.spirit_plant_aura = Math.max(0, Math.min(100, (instance.spirit_plant_aura || 0) + choice.spirit_plant_aura_change));
            applied.spirit_plant_aura = instance.spirit_plant_aura;
        }
        // 落云秘圃第3幕抉择：记录 act3_choice 与对应灵眼树胚掉落规则
        // - guarantee_sapling=true：必掉 lingyan_sapling（act3_choice='cut_seal'）
        // - sapling_drop_rate=<数值>：按几率掉落（act3_choice='branch_care' 或 'balanced_harvest'）
        if (instance.instance_key === 'luoyun' && choice.guarantee_sapling === true) {
            instance.act3_choice = 'cut_seal';
            applied.act3_choice = instance.act3_choice;
            applied.sapling_drop_rate = 1.0; // 100% 必掉
        } else if (instance.instance_key === 'luoyun' && typeof choice.sapling_drop_rate === 'number') {
            // branch_care=0.25 / balanced_harvest=0.50
            instance.act3_choice = choice.key; // 直接使用 choice.key 作为 act3_choice
            applied.act3_choice = instance.act3_choice;
            applied.sapling_drop_rate = choice.sapling_drop_rate;
        }

        // 苍坤洞府专属变量变化（2026-07-21 新增，migration_0057）
        // forbidden_rift 禁制裂隙（0-100，第1幕强破禁制/第3幕破禁抉择累加，越高越危险但门票掉率越高）
        // scroll_clue 卷轴线索（0-100，第2幕搜寻宝物抉择累加，影响门票掉率与首通加成）
        // escape_difficulty 脱身难度（0-100，第4幕自动决战中累加，影响决战回合数与门票掉率）
        // escape_choice 第4幕脱身抉择键（forced_breakout/formation_escape/stealth_escape），由 _processCangkunFinalAct 内部设置
        // cangkun_guardian_hp_change 仅在 _processCangkunFinalAct 内部使用，不在通用 _applyChoiceEffect 处理
        if (choice.forbidden_rift_change) {
            instance.forbidden_rift = Math.max(VARIABLE_BOUNDS.forbidden_rift.min, Math.min(VARIABLE_BOUNDS.forbidden_rift.max, (instance.forbidden_rift || 0) + choice.forbidden_rift_change));
            applied.forbidden_rift = instance.forbidden_rift;
        }
        if (choice.scroll_clue_change) {
            instance.scroll_clue = Math.max(VARIABLE_BOUNDS.scroll_clue.min, Math.min(VARIABLE_BOUNDS.scroll_clue.max, (instance.scroll_clue || 0) + choice.scroll_clue_change));
            applied.scroll_clue = instance.scroll_clue;
        }
        if (choice.escape_difficulty_change) {
            instance.escape_difficulty = Math.max(VARIABLE_BOUNDS.escape_difficulty.min, Math.min(VARIABLE_BOUNDS.escape_difficulty.max, (instance.escape_difficulty || 0) + choice.escape_difficulty_change));
            applied.escape_difficulty = instance.escape_difficulty;
        }

        // 血色试炼专属变量变化（2026-07-21 新增，migration_0058）
        // 实例级：blood_fury 血怒（前3幕累加，第4幕决战伤害加成）
        if (choice.blood_fury_change) {
            instance.blood_fury = Math.max(VARIABLE_BOUNDS.blood_fury.min, Math.min(VARIABLE_BOUNDS.blood_fury.max, (instance.blood_fury || 0) + choice.blood_fury_change));
            applied.blood_fury = instance.blood_fury;
        }
        // 个人级变量变化（血色试炼 PVP 抉择特有）
        // blood_qi_self_change：自身血气变化（猎杀/挑战会自损血气，潜行/献祭/守护会增加）
        // blood_qi_others_change：他人血气变化（猎杀/挑战/夺取/追击/伏击会对其他成员造成血气伤害）
        // kill_score_change：杀戮分变化（猎杀/挑战/伏击/夺取增加，躲避扣减）
        if (choice.blood_qi_self_change || choice.blood_qi_others_change || choice.kill_score_change) {
            // 查询当前抉择玩家与所有其他在场幸存成员
            const allMembers = await MultiDungeonMember.findAll({
                where: { instance_id: instance.id, is_present: 1, is_eliminated: 0 },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            const currentPlayer = allMembers.find(m => m.player_id === playerId);
            const otherPlayers = allMembers.filter(m => m.player_id !== playerId);

            // 自身血气变化
            if (currentPlayer && choice.blood_qi_self_change) {
                currentPlayer.blood_qi = Math.max(VARIABLE_BOUNDS.member_blood_qi.min,
                    Math.min(VARIABLE_BOUNDS.member_blood_qi.max,
                        (currentPlayer.blood_qi ?? 100) + choice.blood_qi_self_change));
                await currentPlayer.save({ transaction });
                applied.blood_qi_self = currentPlayer.blood_qi;
            }
            // 自身杀戮分变化
            if (currentPlayer && choice.kill_score_change) {
                currentPlayer.kill_score = Math.max(VARIABLE_BOUNDS.member_kill_score.min,
                    Math.min(VARIABLE_BOUNDS.member_kill_score.max,
                        (currentPlayer.kill_score ?? 0) + choice.kill_score_change));
                await currentPlayer.save({ transaction });
                applied.kill_score = currentPlayer.kill_score;
            }
            // 其他成员血气变化（伤害均摊到每个其他在场幸存成员）
            if (otherPlayers.length > 0 && choice.blood_qi_others_change) {
                for (const other of otherPlayers) {
                    other.blood_qi = Math.max(VARIABLE_BOUNDS.member_blood_qi.min,
                        Math.min(VARIABLE_BOUNDS.member_blood_qi.max,
                            (other.blood_qi ?? 100) + choice.blood_qi_others_change));
                    await other.save({ transaction });
                }
                applied.blood_qi_others = choice.blood_qi_others_change;
                applied.affected_others = otherPlayers.length;
            }

            // 同步更新实例级团队平均血气（取所有在场幸存成员的平均值）
            const survivors = allMembers.filter(m => !m.is_eliminated);
            if (survivors.length > 0) {
                const totalBloodQi = survivors.reduce((sum, m) => sum + (m.blood_qi ?? 100), 0);
                instance.blood_qi_avg = Math.max(VARIABLE_BOUNDS.blood_qi_avg.min,
                    Math.min(VARIABLE_BOUNDS.blood_qi_avg.max,
                        Math.floor(totalBloodQi / survivors.length)));
                applied.blood_qi_avg = instance.blood_qi_avg;
            }
        }

        // 坠魔谷专属变量变化（2026-07-21 新增，migration_0059）
        // 设计：心魔（heart_demon）与道心（dao_heart）是对立变量，构成 PVE 心魔博弈核心
        //   - heart_demon_self_change：自身心魔变化（血祭/试道增加，静心/守道降低）
        //   - heart_demon_others_change：他人心魔变化（试道增加他人心魔换取自身收益，护道降低他人心魔）
        //   - heart_demon_others_change_highest：心魔最高者心魔变化（特殊护道，精准拯救濒临堕魔的队友）
        //   - dao_heart_self_change：自身道心变化（守道/护道提升，入魔/心魔侵蚀降低）
        //   - dao_heart_others_change：他人道心变化（护道提升他人道心）
        // 堕魔判定：心魔 ≥ 100（堕魔）或道心 ≤ 0（道心破碎）立即标记 is_fallen=1, is_present=0
        if (choice.heart_demon_self_change || choice.heart_demon_others_change ||
            choice.heart_demon_others_change_highest || choice.dao_heart_self_change ||
            choice.dao_heart_others_change) {
            // 查询当前抉择玩家与所有其他在场未堕魔成员（带行级锁防止并发）
            const allMembers = await MultiDungeonMember.findAll({
                where: { instance_id: instance.id, is_present: 1, is_fallen: 0 },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            const currentPlayer = allMembers.find(m => m.player_id === playerId);
            const otherPlayers = allMembers.filter(m => m.player_id !== playerId);
            const fallenMembers = []; // 本次堕魔的成员列表（用于审计与通知）

            /**
             * 内部辅助：判定并标记堕魔（心魔≥100 或 道心≤0）
             * @param {Object} m - 成员对象
             * @returns {boolean} 是否触发了堕魔
             */
            const checkAndMarkFallen = (m) => {
                if (m.is_fallen) return false;
                if ((m.heart_demon ?? 0) >= 100) {
                    m.is_fallen = 1;
                    m.is_present = 0;
                    return true;
                }
                if ((m.dao_heart ?? 100) <= 0) {
                    m.is_fallen = 1;
                    m.is_present = 0;
                    return true;
                }
                return false;
            };

            // 自身心魔变化
            if (currentPlayer && choice.heart_demon_self_change) {
                currentPlayer.heart_demon = Math.max(VARIABLE_BOUNDS.member_heart_demon.min,
                    Math.min(VARIABLE_BOUNDS.member_heart_demon.max,
                        (currentPlayer.heart_demon ?? 0) + choice.heart_demon_self_change));
                applied.heart_demon_self = currentPlayer.heart_demon;
                if (checkAndMarkFallen(currentPlayer)) {
                    fallenMembers.push({
                        player_id: currentPlayer.player_id,
                        nickname: currentPlayer.player_nickname,
                        reason: (currentPlayer.heart_demon ?? 0) >= 100 ? 'heart_demon_overflow' : 'dao_broken',
                        heart_demon: currentPlayer.heart_demon,
                        dao_heart: currentPlayer.dao_heart
                    });
                }
            }
            // 自身道心变化
            if (currentPlayer && choice.dao_heart_self_change) {
                currentPlayer.dao_heart = Math.max(VARIABLE_BOUNDS.member_dao_heart.min,
                    Math.min(VARIABLE_BOUNDS.member_dao_heart.max,
                        (currentPlayer.dao_heart ?? 100) + choice.dao_heart_self_change));
                applied.dao_heart_self = currentPlayer.dao_heart;
                if (checkAndMarkFallen(currentPlayer)) {
                    // 避免重复加入 fallenMembers（若心魔已触发堕魔则不再加入）
                    if (!fallenMembers.find(f => f.player_id === currentPlayer.player_id)) {
                        fallenMembers.push({
                            player_id: currentPlayer.player_id,
                            nickname: currentPlayer.player_nickname,
                            reason: 'dao_broken',
                            heart_demon: currentPlayer.heart_demon,
                            dao_heart: currentPlayer.dao_heart
                        });
                    }
                }
            }
            // 保存自身变化（堕魔判定后一次性保存）
            if (currentPlayer) {
                await currentPlayer.save({ transaction });
            }

            // 他人心魔变化（伤害均摊到每个其他在场未堕魔成员）
            if (otherPlayers.length > 0 && choice.heart_demon_others_change) {
                for (const other of otherPlayers) {
                    other.heart_demon = Math.max(VARIABLE_BOUNDS.member_heart_demon.min,
                        Math.min(VARIABLE_BOUNDS.member_heart_demon.max,
                            (other.heart_demon ?? 0) + choice.heart_demon_others_change));
                    if (checkAndMarkFallen(other)) {
                        fallenMembers.push({
                            player_id: other.player_id,
                            nickname: other.player_nickname,
                            reason: (other.heart_demon ?? 0) >= 100 ? 'heart_demon_overflow' : 'dao_broken',
                            heart_demon: other.heart_demon,
                            dao_heart: other.dao_heart
                        });
                    }
                    await other.save({ transaction });
                }
                applied.heart_demon_others = choice.heart_demon_others_change;
                applied.affected_others_heart_demon = otherPlayers.length;
            }

            // 心魔最高者心魔变化（护道专用：仅影响心魔最高的队员，避免对全员加心魔的副作用）
            // 设计目的：精准拯救濒临堕魔的队友，提升多人协作的护道收益
            if (otherPlayers.length > 0 && choice.heart_demon_others_change_highest) {
                // 在其他在场未堕魔成员中找出心魔最高者（已堕魔的不参与）
                const sortedByHeartDemon = [...otherPlayers].sort((a, b) => (b.heart_demon ?? 0) - (a.heart_demon ?? 0));
                const highestMember = sortedByHeartDemon[0];
                if (highestMember) {
                    highestMember.heart_demon = Math.max(VARIABLE_BOUNDS.member_heart_demon.min,
                        Math.min(VARIABLE_BOUNDS.member_heart_demon.max,
                            (highestMember.heart_demon ?? 0) + choice.heart_demon_others_change_highest));
                    if (checkAndMarkFallen(highestMember)) {
                        if (!fallenMembers.find(f => f.player_id === highestMember.player_id)) {
                            fallenMembers.push({
                                player_id: highestMember.player_id,
                                nickname: highestMember.player_nickname,
                                reason: (highestMember.heart_demon ?? 0) >= 100 ? 'heart_demon_overflow' : 'dao_broken',
                                heart_demon: highestMember.heart_demon,
                                dao_heart: highestMember.dao_heart
                            });
                        }
                    }
                    await highestMember.save({ transaction });
                    applied.heart_demon_others_change_highest = choice.heart_demon_others_change_highest;
                    applied.heart_demon_highest_target = highestMember.player_id;
                    applied.heart_demon_highest_before = (highestMember.heart_demon ?? 0) - choice.heart_demon_others_change_highest;
                    applied.heart_demon_highest_after = highestMember.heart_demon;
                }
            }

            // 他人道心变化（提升他人道心，护道专用）
            if (otherPlayers.length > 0 && choice.dao_heart_others_change) {
                // 重新查询避免与前面保存的对象冲突
                const otherMembersRefresh = await MultiDungeonMember.findAll({
                    where: { instance_id: instance.id, is_present: 1, is_fallen: 0, player_id: { [Op.ne]: playerId } },
                    transaction,
                    lock: transaction.LOCK.UPDATE
                });
                for (const other of otherMembersRefresh) {
                    other.dao_heart = Math.max(VARIABLE_BOUNDS.member_dao_heart.min,
                        Math.min(VARIABLE_BOUNDS.member_dao_heart.max,
                            (other.dao_heart ?? 100) + choice.dao_heart_others_change));
                    if (checkAndMarkFallen(other)) {
                        if (!fallenMembers.find(f => f.player_id === other.player_id)) {
                            fallenMembers.push({
                                player_id: other.player_id,
                                nickname: other.player_nickname,
                                reason: 'dao_broken',
                                heart_demon: other.heart_demon,
                                dao_heart: other.dao_heart
                            });
                        }
                    }
                    await other.save({ transaction });
                }
                applied.dao_heart_others = choice.dao_heart_others_change;
                applied.affected_others_dao_heart = otherMembersRefresh.length;
            }

            // 同步更新实例级团队平均心魔与道心（取所有在场未堕魔成员的平均值）
            const nonFallenMembers = await MultiDungeonMember.findAll({
                where: { instance_id: instance.id, is_present: 1, is_fallen: 0 },
                transaction
            });
            if (nonFallenMembers.length > 0) {
                const totalHeartDemon = nonFallenMembers.reduce((sum, m) => sum + (m.heart_demon ?? 0), 0);
                const totalDaoHeart = nonFallenMembers.reduce((sum, m) => sum + (m.dao_heart ?? 100), 0);
                instance.avg_heart_demon = Math.max(VARIABLE_BOUNDS.avg_heart_demon.min,
                    Math.min(VARIABLE_BOUNDS.avg_heart_demon.max,
                        Math.floor(totalHeartDemon / nonFallenMembers.length)));
                instance.avg_dao_heart = Math.max(VARIABLE_BOUNDS.avg_dao_heart.min,
                    Math.min(VARIABLE_BOUNDS.avg_dao_heart.max,
                        Math.floor(totalDaoHeart / nonFallenMembers.length)));
                applied.avg_heart_demon = instance.avg_heart_demon;
                applied.avg_dao_heart = instance.avg_dao_heart;
            } else {
                // 全员堕魔：实例级变量归零/满值（触发失败条件）
                instance.avg_heart_demon = 100;
                instance.avg_dao_heart = 0;
                applied.all_fallen = true;
            }

            // 记录本次堕魔的成员（用于审计与通知）
            if (fallenMembers.length > 0) {
                applied.fallen_members = fallenMembers;
            }
        }

        // 黄龙山专属变量处理（2026-07-21 新增，migration_0060）
        // 设计：宗门协同阵法副本，处理 5 大专属字段：
        //   - huanglong_formation_power_change：阵法强度变化（累加到 instance.huanglong_formation_power，0-200）
        //   - huanglong_resonance_count_change：共鸣数变化（累加到 instance.huanglong_resonance_count，0-5）
        //   - huanglong_eye_position：阵眼位置（直接设置 currentPlayer.huanglong_eye_position）
        //   - huanglong_contribution_score_self_change：自身贡献分变化（累加，0-1000，叛道双倍）
        //   - huanglong_is_defecting_self：是否叛道（直接设置 0/1，叛道后不参与共鸣）
        // 共鸣判定：相同阵眼≥2人触发共鸣，共鸣数=相同阵眼≥2人的组数（最多5）
        if (choice.huanglong_formation_power_change ||
            choice.huanglong_resonance_count_change ||
            choice.huanglong_eye_position ||
            choice.huanglong_contribution_score_self_change ||
            choice.huanglong_is_defecting_self !== null && choice.huanglong_is_defecting_self !== undefined) {
            // 查询当前抉择玩家（带行级锁）
            const currentPlayer = await MultiDungeonMember.findOne({
                where: { instance_id: instance.id, player_id: playerId, is_present: 1 },
                transaction,
                lock: transaction.LOCK.UPDATE
            });

            if (currentPlayer) {
                // 1. 阵眼位置设置（直接设置，非累加）
                //    取值：forward前阵 / center中阵 / rear后阵 / left左阵 / right右阵
                if (choice.huanglong_eye_position) {
                    const validPositions = ['forward', 'center', 'rear', 'left', 'right'];
                    if (validPositions.includes(choice.huanglong_eye_position)) {
                        currentPlayer.huanglong_eye_position = choice.huanglong_eye_position;
                        applied.huanglong_eye_position = choice.huanglong_eye_position;
                    }
                }

                // 2. 叛道标记设置（直接设置 0/1，非累加）
                //    叛道后成员不再参与共鸣判定，但保留已获得的贡献分
                if (choice.huanglong_is_defecting_self !== null && choice.huanglong_is_defecting_self !== undefined) {
                    currentPlayer.huanglong_is_defecting = choice.huanglong_is_defecting_self ? 1 : 0;
                    applied.huanglong_is_defecting = !!choice.huanglong_is_defecting_self;
                    if (choice.huanglong_is_defecting_self) {
                        applied.huanglong_defecting_player = currentPlayer.player_id;
                    }
                }

                // 3. 自身贡献分变化（累加，叛道抉择获得双倍贡献分）
                //    边界：0-1000，影响最终奖励分配权重
                if (choice.huanglong_contribution_score_self_change) {
                    // 叛道成员获得双倍贡献分（在 choice 配置中已设置为双倍值，此处直接累加）
                    currentPlayer.huanglong_contribution_score = Math.max(
                        VARIABLE_BOUNDS.member_huanglong_contribution_score.min,
                        Math.min(VARIABLE_BOUNDS.member_huanglong_contribution_score.max,
                            (currentPlayer.huanglong_contribution_score || 0) + choice.huanglong_contribution_score_self_change)
                    );
                    applied.huanglong_contribution_score_self = currentPlayer.huanglong_contribution_score;
                }

                await currentPlayer.save({ transaction });
            }

            // 4. 阵法强度变化（累加到 instance.huanglong_formation_power，0-200）
            //    影响第4幕决战伤害（每点 +3000）和称号奖励阈值（≥120）
            if (choice.huanglong_formation_power_change) {
                instance.huanglong_formation_power = Math.max(
                    VARIABLE_BOUNDS.huanglong_formation_power.min,
                    Math.min(VARIABLE_BOUNDS.huanglong_formation_power.max,
                        (instance.huanglong_formation_power || 0) + choice.huanglong_formation_power_change)
                );
                applied.huanglong_formation_power = instance.huanglong_formation_power;
            }

            // 5. 共鸣数变化（累加到 instance.huanglong_resonance_count，0-5）
            //    由 choice 配置直接指定共鸣数变化（如第1幕入阵固守的共鸣抉择）
            if (choice.huanglong_resonance_count_change) {
                instance.huanglong_resonance_count = Math.max(
                    VARIABLE_BOUNDS.huanglong_resonance_count.min,
                    Math.min(VARIABLE_BOUNDS.huanglong_resonance_count.max,
                        (instance.huanglong_resonance_count || 0) + choice.huanglong_resonance_count_change)
                );
                applied.huanglong_resonance_count = instance.huanglong_resonance_count;
            }

            // 6. 重新计算共鸣数（相同阵眼≥2人的组数）
            //    设计：每次阵眼位置变更后重新计算，确保共鸣数与实际阵眼分布一致
            //    查询所有在场未叛道成员的阵眼位置，按阵眼分组，相同阵眼≥2人的组数即为共鸣数
            const nonDefectingMembers = await MultiDungeonMember.findAll({
                where: {
                    instance_id: instance.id,
                    is_present: 1,
                    huanglong_is_defecting: 0
                },
                transaction
            });
            if (nonDefectingMembers.length > 0) {
                // 按阵眼位置分组统计
                const eyePositionCounts = {};
                for (const m of nonDefectingMembers) {
                    const pos = m.huanglong_eye_position || 'unassigned';
                    if (pos !== 'unassigned') {
                        eyePositionCounts[pos] = (eyePositionCounts[pos] || 0) + 1;
                    }
                }
                // 共鸣数 = 相同阵眼≥2人的组数（最多5）
                let actualResonanceCount = 0;
                for (const pos in eyePositionCounts) {
                    if (eyePositionCounts[pos] >= 2) {
                        actualResonanceCount++;
                    }
                }
                actualResonanceCount = Math.min(VARIABLE_BOUNDS.huanglong_resonance_count.max, actualResonanceCount);
                // 更新实例共鸣数（覆盖之前的累加值，以实际阵眼分布为准）
                if (actualResonanceCount !== instance.huanglong_resonance_count) {
                    instance.huanglong_resonance_count = actualResonanceCount;
                    applied.huanglong_resonance_recalculated = actualResonanceCount;
                    applied.huanglong_eye_distribution = eyePositionCounts;
                }
            }
        }

        // 神识消耗（直接扣 player.divine_sense_balance）
        if (choice.cost_divine_sense > 0) {
            const player = await Player.findByPk(playerId, { transaction, lock: transaction.LOCK.UPDATE });
            if (player) {
                player.divine_sense_balance = Math.max(0, (player.divine_sense_balance || 0) - choice.cost_divine_sense);
                await player.save({ transaction });
                applied.divine_sense_cost = choice.cost_divine_sense;
            }
        }

        // 队伍 HP 损失（按百分比）
        if (choice.team_hp_loss_percent > 0) {
            const members = await MultiDungeonMember.findAll({
                where: { instance_id: instance.id, is_present: 1 },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            const lossPercent = choice.team_hp_loss_percent / 100;
            for (const m of members) {
                const oldHp = BigInt(m.hp_remaining || 0);
                const loss = BigInt(Math.floor(Number(oldHp) * lossPercent));
                m.hp_remaining = oldHp > loss ? (oldHp - loss) : BigInt(0);
                await m.save({ transaction });
            }
            applied.team_hp_loss_percent = choice.team_hp_loss_percent;
        }

        return applied;
    }

    /**
     * 检查失败条件
     * 通用支持：vigilance_gte / seal_stability_lte / morale_lte / demon_corruption_gte
     *          demonic_qi_gte（昆吾山专用）
     *          rounds_exceed（昆吾山第四幕专用，由 _processKunwuFinalAct 内部判断）
     * 注意：team_hp_below_percent 因同步签名限制，由 _settleRewards 兜底处理
     * @param {Object} instance - 副本实例
     * @param {Object} currentAct - 当前幕配置
     * @returns {{failed: boolean, message?: string, reason?: string}}
     */
    static _checkFailCondition(instance, currentAct) {
        const cond = currentAct.fail_condition;
        if (!cond) return { failed: false };

        // 警戒度 ≥ 阈值
        if (cond.vigilance_gte && instance.vigilance >= cond.vigilance_gte) {
            return { failed: true, message: cond.fail_message || `警戒度达到 ${instance.vigilance}`, reason: 'vigilance_exceeded' };
        }
        // 封印稳定度 ≤ 阈值
        if (cond.seal_stability_lte && instance.seal_stability <= cond.seal_stability_lte) {
            return { failed: true, message: cond.fail_message || `封印稳定度降至 ${instance.seal_stability}`, reason: 'seal_stability_depleted' };
        }
        // 士气 ≤ 阈值
        if (cond.morale_lte && instance.morale <= cond.morale_lte) {
            return { failed: true, message: cond.fail_message || `士气降至 ${instance.morale}`, reason: 'morale_depleted' };
        }
        // 魔染值 ≥ 阈值
        if (cond.demon_corruption_gte && instance.demon_corruption >= cond.demon_corruption_gte) {
            return { failed: true, message: cond.fail_message || `魔染值达到 ${instance.demon_corruption}`, reason: 'demon_corruption_exceeded' };
        }
        // 魔气值 ≥ 阈值（昆吾山专用，2026-07-21 新增）
        if (cond.demonic_qi_gte && (instance.demonic_qi || 0) >= cond.demonic_qi_gte) {
            return { failed: true, message: cond.fail_message || `魔气值达到 ${instance.demonic_qi}`, reason: 'demonic_qi_exceeded' };
        }
        // 神魂稳定度 ≤ 阈值（虚天殿专用，2026-07-21 新增）
        if (cond.soul_stability_lte && (instance.soul_stability || 0) <= cond.soul_stability_lte) {
            return { failed: true, message: cond.fail_message || `神魂稳定度降至 ${instance.soul_stability}`, reason: 'soul_stability_depleted' };
        }
        // 阵法强度 ≤ 阈值（虚天殿专用，2026-07-21 新增）
        if (cond.formation_power_lte && (instance.formation_power || 0) <= cond.formation_power_lte) {
            return { failed: true, message: cond.fail_message || `阵法强度降至 ${instance.formation_power}`, reason: 'formation_power_depleted' };
        }
        // 团队平均心魔 ≥ 阈值（坠魔谷专用，2026-07-21 新增）
        // 心魔满100触发全队堕魔，副本失败
        if (cond.avg_heart_demon_gte && (instance.avg_heart_demon || 0) >= cond.avg_heart_demon_gte) {
            return { failed: true, message: cond.fail_message || `团队平均心魔达到 ${instance.avg_heart_demon}，全队堕魔`, reason: 'avg_heart_demon_overflow' };
        }
        // 团队平均道心 ≤ 阈值（坠魔谷专用，2026-07-21 新增）
        // 道心归0触发道心崩溃，副本失败
        if (cond.avg_dao_heart_lte && (instance.avg_dao_heart || 100) <= cond.avg_dao_heart_lte) {
            return { failed: true, message: cond.fail_message || `团队平均道心降至 ${instance.avg_dao_heart}，道心崩溃`, reason: 'avg_dao_heart_depleted' };
        }
        // rounds_exceed：仅作为标志位，由 _processKunwuFinalAct / _processXutianFinalAct 内部主动判断并触发失败
        // 此处不直接检查，避免误判（同步签名无法感知回合数）
        if (cond.team_hp_below_percent !== undefined) {
            // 异步查询会破坏同步签名，此处保守不触发，由 _settleRewards 兜底
        }
        return { failed: false };
    }

    /**
     * 应用空舟惩罚
     * 端午副本投粽总数为 0 时触发：全员扣 388 灵石 + 500 修为，进入 23 小时冷却
     * @param {Object} instance - 副本实例
     * @param {Object} dungeonCfg - 副本配置
     * @param {Object} transaction - 事务
     */
    static async _applyEmptyBoatPenalty(instance, dungeonCfg, transaction) {
        const penalty = dungeonCfg.empty_boat_penalty;
        instance.instance_state = 'failed';
        instance.current_act_state = 'failed';
        instance.dissolved_at = new Date();
        await instance.save({ transaction });

        // 全员扣灵石/修为，并进入冷却
        const members = await MultiDungeonMember.findAll({
            where: { instance_id: instance.id, is_present: 1 },
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        for (const m of members) {
            const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
            if (player) {
                // 扣灵石（不够则扣到 0）
                const oldStones = BigInt(player.spirit_stones || 0);
                const lossStones = BigInt(penalty.spirit_stones_loss);
                player.spirit_stones = oldStones > lossStones ? (oldStones - lossStones).toString() : '0';
                // 扣修为
                const oldExp = BigInt(player.exp || 0);
                const lossExp = BigInt(penalty.exp_loss);
                player.exp = oldExp > lossExp ? (oldExp - lossExp).toString() : '0';
                await player.save({ transaction });
            }
            // 写入冷却记录
            const now = new Date();
            const cooldownEnd = new Date(now.getTime() + penalty.cooldown_hours * 3600 * 1000);
            await MultiDungeonCooldown.create({
                player_id: m.player_id,
                dungeon_key: instance.instance_key,
                instance_id: instance.id,
                cooldown_hours: penalty.cooldown_hours,
                cooldown_start_time: now,
                cooldown_end_time: cooldownEnd,
                reason: 'penalty'
            }, { transaction });
            m.cooldown_end_time = cooldownEnd;
            await m.save({ transaction });

            // 推送惩罚通知
            try {
                WebSocketNotificationService.notifyPlayerUpdate(m.player_id, 'multi_dungeon_empty_boat_penalty', {
                    message: `空舟惩罚！扣除 ${penalty.spirit_stones_loss} 灵石 + ${penalty.exp_loss} 修为，进入 ${penalty.cooldown_hours} 小时冷却`,
                    spirit_stones_loss: penalty.spirit_stones_loss,
                    exp_loss: penalty.exp_loss,
                    cooldown_end_time: cooldownEnd
                });
            } catch (e) { /* 推送失败不阻塞 */ }
        }
    }

    /**
     * 给所有成员应用冷却记录
     * 通关/失败时调用，全员进入冷却
     * @param {Object} instance - 副本实例
     * @param {string} reason - 冷却原因（cleared/failed）
     * @param {Object} transaction - 事务
     */
    static async _applyCooldownToAllMembers(instance, reason, transaction) {
        const members = await MultiDungeonMember.findAll({
            where: { instance_id: instance.id, is_present: 1 },
            transaction
        });

        const now = new Date();
        const cooldownEnd = new Date(now.getTime() + instance.cooldown_hours * 3600 * 1000);

        for (const m of members) {
            await MultiDungeonCooldown.create({
                player_id: m.player_id,
                dungeon_key: instance.instance_key,
                instance_id: instance.id,
                cooldown_hours: instance.cooldown_hours,
                cooldown_start_time: now,
                cooldown_end_time: cooldownEnd,
                reason: reason
            }, { transaction });
            m.cooldown_end_time = cooldownEnd;
            await m.save({ transaction });
        }

        instance.cooldown_until = cooldownEnd;
        await instance.save({ transaction });
    }

    /**
     * 结算奖励
     * 通关后给所有成员发放普通掉落、首通奖励、稀有掉落
     * @param {Object} instance - 副本实例
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} 奖励摘要
     */
    static async _settleRewards(instance, transaction) {
        const config = configLoader.getConfig('multi_dungeon_data');
        const dungeonCfg = config.dungeons[instance.instance_key];
        const rewards = dungeonCfg.rewards;
        const summary = { normal_drops: [], first_clear: [], rare_drop: null };

        const members = await MultiDungeonMember.findAll({
            where: { instance_id: instance.id, is_present: 1 },
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        // 1. 普通掉落：每个成员独立掉落
        if (rewards.normal_drops) {
            for (const m of members) {
                const memberDrops = [];
                for (const drop of rewards.normal_drops) {
                    if (Math.random() < drop.chance) {
                        const count = Math.floor(drop.count_min + Math.random() * (drop.count_max - drop.count_min + 1));
                        if (drop.is_spirit_stones || drop.item_key === 'spirit_stones') {
                            // 灵石直接加
                            const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                            if (player) {
                                const oldStones = BigInt(player.spirit_stones || 0);
                                const actualGain = BigInt(Math.floor(count * instance.harvest_multiplier));
                                player.spirit_stones = (oldStones + actualGain).toString();
                                await player.save({ transaction });
                                memberDrops.push({ item_key: 'spirit_stones', count: actualGain.toString() });
                            }
                        } else {
                            try {
                                await InventoryService.addItem(m.player_id, drop.item_key, count, transaction);
                                memberDrops.push({ item_key: drop.item_key, count });
                            } catch (e) {
                                // 物品配置不存在等错误，跳过但记录日志
                                console.warn(`[MultiDungeonService] 发放物品 ${drop.item_key} 给玩家 ${m.player_id} 失败:`, e.message);
                            }
                        }
                    }
                }
                summary.normal_drops.push({ player_id: m.player_id, drops: memberDrops });
            }
        }

        // 2. 端午基础奖励（全员统一）
        if (rewards.base_rewards) {
            for (const m of members) {
                const memberBaseRewards = [];
                for (const baseReward of rewards.base_rewards) {
                    if (baseReward.type === 'exp') {
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const oldExp = BigInt(player.exp || 0);
                            const actualGain = BigInt(Math.floor(baseReward.count * instance.harvest_multiplier));
                            player.exp = (oldExp + actualGain).toString();
                            await player.save({ transaction });
                            memberBaseRewards.push({ type: 'exp', count: actualGain.toString() });
                        }
                    } else if (baseReward.type === 'honor') {
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            player.honor_value = (player.honor_value || 0) + baseReward.count;
                            await player.save({ transaction });
                            memberBaseRewards.push({ type: 'honor', count: baseReward.count });
                        }
                    } else if (baseReward.type === 'item' && baseReward.item_key) {
                        try {
                            await InventoryService.addItem(m.player_id, baseReward.item_key, baseReward.count, transaction);
                            memberBaseRewards.push({ type: 'item', item_key: baseReward.item_key, count: baseReward.count });
                        } catch (e) {
                            console.warn(`[MultiDungeonService] 发放基础奖励 ${baseReward.item_key} 给玩家 ${m.player_id} 失败:`, e.message);
                        }
                    } else if (baseReward.type === 'spirit_stones') {
                        // 2026-07-21 新增：基础灵石奖励（昆吾山基础奖励用）
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            const actualGain = BigInt(Math.floor(baseReward.count * instance.harvest_multiplier));
                            player.spirit_stones = (oldStones + actualGain).toString();
                            await player.save({ transaction });
                            memberBaseRewards.push({ type: 'spirit_stones', count: actualGain.toString() });
                        }
                    } else if (baseReward.type === 'divine_sense') {
                        // 2026-07-21 新增：昆吾山通关永久神识加成
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const oldDs = player.divine_sense_balance || 0;
                            player.divine_sense_balance = oldDs + baseReward.count;
                            await player.save({ transaction });
                            memberBaseRewards.push({ type: 'divine_sense', count: baseReward.count });
                        }
                    }
                }
                // 端午/昆吾基础奖励合并到 normal_drops 中展示
                const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                if (existing) {
                    existing.drops.push(...memberBaseRewards);
                } else {
                    summary.normal_drops.push({ player_id: m.player_id, drops: memberBaseRewards });
                }
            }
        }

        // 3. 首通奖励（仅首通队伍）
        if (instance.first_clear === 1 && rewards.first_clear_bonus) {
            for (const m of members) {
                const memberFirstClear = [];
                for (const bonus of rewards.first_clear_bonus) {
                    if (bonus.type === 'title') {
                        // 称号奖励：将称号ID加入玩家 titles 数组
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const titles = player.titles || [];
                            if (!titles.includes(bonus.title_id)) {
                                titles.push(bonus.title_id);
                                player.titles = titles;
                                await player.save({ transaction });
                            }
                            memberFirstClear.push({ type: 'title', title_id: bonus.title_id });
                        }
                    } else if (bonus.type === 'item' && bonus.item_key) {
                        try {
                            await InventoryService.addItem(m.player_id, bonus.item_key, bonus.count, transaction);
                            memberFirstClear.push({ type: 'item', item_key: bonus.item_key, count: bonus.count });
                        } catch (e) {
                            console.warn(`[MultiDungeonService] 发放首通物品 ${bonus.item_key} 给玩家 ${m.player_id} 失败:`, e.message);
                        }
                    } else if (bonus.type === 'spirit_stones') {
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonus.count)).toString();
                            await player.save({ transaction });
                            memberFirstClear.push({ type: 'spirit_stones', count: bonus.count });
                        }
                    } else if (bonus.type === 'global_announce') {
                        // 全服公告（仅一次）
                        if (m === members[0]) {
                            try {
                                WebSocketNotificationService.sendGlobalAnnouncement({
                                    title: '全服首通公告',
                                    content: `副本【${instance.instance_name}】首通达成！队长 ${instance.leader_nickname} 率队斩获荣誉！`
                                });
                            } catch (e) { /* 推送失败不阻塞 */ }
                        }
                    }
                }
                summary.first_clear.push({ player_id: m.player_id, bonuses: memberFirstClear });
            }
        }

        // 4. 稀有掉落（掩月血魔剑 0.1%，仅队长）
        if (rewards.rare_drop) {
            // 2026-07-21 新增：宝压加成（昆吾山专用，每10点宝压+5%稀有掉落概率）
            let adjustedRareChance = rewards.rare_drop.chance;
            if (rewards.treasure_pressure_bonus && instance.treasure_pressure > 0) {
                const bonusPer10 = rewards.treasure_pressure_bonus.bonus_per_10_pressure || 0.05;
                const bonus = Math.floor(instance.treasure_pressure / 10) * bonusPer10;
                adjustedRareChance = Math.min(1.0, adjustedRareChance + bonus);
            }
            // 2026-07-21 新增：禁制裂隙加成（苍坤洞府专用，每10点禁制裂隙+3%稀有掉落概率）
            if (rewards.forbidden_rift_bonus && instance.forbidden_rift > 0) {
                const bonusPer10 = rewards.forbidden_rift_bonus.rare_drop_bonus_per_10_rift || 0.03;
                const riftBonus = Math.floor(instance.forbidden_rift / 10) * bonusPer10;
                adjustedRareChance = Math.min(1.0, adjustedRareChance + riftBonus);
            }
            // 苍坤洞府稀有掉落（影傀图谱）按 leader_only=false 分配给队伍中任一成员
            // 血色试炼稀有掉落（血色战甲）按 leader_only=false 分配给队伍幸存成员中任一成员
            const targetMember = rewards.rare_drop.leader_only
                ? members.find(m => m.player_id === instance.leader_player_id)
                : (instance.instance_key === 'cangkun'
                    ? members[Math.floor(Math.random() * members.length)]
                    : (instance.instance_key === 'xuese'
                        ? (() => {
                            // 血色试炼：仅从幸存者中随机分配
                            const survivors = members.filter(m => !m.is_eliminated);
                            return survivors.length > 0
                                ? survivors[Math.floor(Math.random() * survivors.length)]
                                : members[Math.floor(Math.random() * members.length)];
                        })()
                        : members[0]));
            if (targetMember && Math.random() < adjustedRareChance) {
                try {
                    await InventoryService.addItem(targetMember.player_id, rewards.rare_drop.item_key, 1, transaction);
                    summary.rare_drop = {
                        player_id: targetMember.player_id,
                        item_key: rewards.rare_drop.item_key,
                        name: rewards.rare_drop.name,
                        base_chance: rewards.rare_drop.chance,
                        adjusted_chance: adjustedRareChance
                    };
                } catch (e) {
                    console.warn(`[MultiDungeonService] 发放稀有掉落 ${rewards.rare_drop.item_key} 失败:`, e.message);
                }
            }
        }

        // 4.1 昆吾山专属加成：玲珑影响额外奖励（每10点玲珑+1000修为+100灵石）
        if (rewards.linglong_bonus && instance.linglong > 0) {
            const expPer10 = rewards.linglong_bonus.exp_per_10_linglong || 1000;
            const stonesPer10 = rewards.linglong_bonus.spirit_stones_per_10_linglong || 100;
            const linglongBonusExp = Math.floor(instance.linglong / 10) * expPer10;
            const linglongBonusStones = Math.floor(instance.linglong / 10) * stonesPer10;
            for (const m of members) {
                const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                if (player) {
                    if (linglongBonusExp > 0) {
                        const oldExp = BigInt(player.exp || 0);
                        player.exp = (oldExp + BigInt(linglongBonusExp)).toString();
                    }
                    if (linglongBonusStones > 0) {
                        const oldStones = BigInt(player.spirit_stones || 0);
                        player.spirit_stones = (oldStones + BigInt(linglongBonusStones)).toString();
                    }
                    await player.save({ transaction });
                    // 合并到 normal_drops 展示
                    const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                    const linglongBonus = [];
                    if (linglongBonusExp > 0) linglongBonus.push({ type: 'exp', source: 'linglong_bonus', count: linglongBonusExp.toString() });
                    if (linglongBonusStones > 0) linglongBonus.push({ type: 'spirit_stones', source: 'linglong_bonus', count: linglongBonusStones.toString() });
                    if (existing) {
                        existing.drops.push(...linglongBonus);
                    } else {
                        summary.normal_drops.push({ player_id: m.player_id, drops: linglongBonus });
                    }
                }
            }
        }

        // 4.2 小极宫专属加成（2026-07-21 新增）
        // 处理逻辑：
        //   - perfect_bonus：完美破局加成（咒扰<30且士气>60时，每人额外获得修为+3000、宗门贡献+150）
        //   - guaranteed_drops：保底掉落（玄冰花×1 优先分给贡献最高的队员）
        //   - rare_drops：稀有掉落（按 weight 加权随机 1-3 件，分发给全员共享池中随机一名成员）
        //   - title：完美通关有机会获得"北冥破局者"称号（默认 20% 概率）
        // 说明：base_rewards / first_clear_bonus 由前述通用分支处理，此处仅处理小极宫特有的扩展结构
        if (instance.instance_key === 'xiaoji') {
            const xiaojiCfg = dungeonCfg;
            // 完美破局判定：咒扰 < perfect_clear_curse_disorder_max 且 士气 > perfect_clear_morale_min
            const curseDisorderMax = xiaojiCfg.perfect_clear_curse_disorder_max ?? 30;
            const moraleMin = xiaojiCfg.perfect_clear_morale_min ?? 60;
            const isPerfectClear = (instance.curse_disorder || 0) < curseDisorderMax
                && (instance.morale || 0) > moraleMin;
            summary.xiaoji_perfect_clear = isPerfectClear;

            // 4.2.1 完美破局加成
            if (isPerfectClear && rewards.perfect_bonus) {
                const bonusExp = rewards.perfect_bonus.exp || 0;
                const bonusContribution = rewards.perfect_bonus.contribution || 0;
                const PlayerSect = require('../../models/playerSect');
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player && bonusExp > 0) {
                        const oldExp = BigInt(player.exp || 0);
                        player.exp = (oldExp + BigInt(bonusExp)).toString();
                        await player.save({ transaction });
                    }
                    // 宗门贡献度累加（未加入宗门则跳过贡献度部分，仅享受修为加成）
                    if (bonusContribution > 0) {
                        const playerSect = await PlayerSect.findOne({
                            where: { player_id: m.player_id },
                            transaction,
                            lock: transaction.LOCK.UPDATE
                        });
                        if (playerSect) {
                            playerSect.contribution = (playerSect.contribution || 0) + bonusContribution;
                            await playerSect.save({ transaction });
                        }
                    }
                    // 合并到 normal_drops 展示
                    const perfectBonus = [];
                    if (bonusExp > 0) perfectBonus.push({ type: 'exp', source: 'perfect_bonus', count: bonusExp.toString() });
                    if (bonusContribution > 0) perfectBonus.push({ type: 'contribution', source: 'perfect_bonus', count: bonusContribution });
                    if (perfectBonus.length > 0) {
                        const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                        if (existing) {
                            existing.drops.push(...perfectBonus);
                        } else {
                            summary.normal_drops.push({ player_id: m.player_id, drops: perfectBonus });
                        }
                    }
                }
            }

            // 4.2.2 保底掉落：玄冰花优先分给贡献最高的队员
            if (Array.isArray(rewards.guaranteed_drops) && rewards.guaranteed_drops.length > 0) {
                // 找出贡献度最高的成员（contribution 由抉择过程中的 choice 记录累加而来，此处直接用 member.contribution 字段）
                const sortedMembers = [...members].sort((a, b) => (b.contribution || 0) - (a.contribution || 0));
                const targetMember = sortedMembers[0];
                summary.xiaoji_guaranteed_drops = [];
                for (const drop of rewards.guaranteed_drops) {
                    const count = drop.count || 1;
                    try {
                        await InventoryService.addItem(targetMember.player_id, drop.item_key, count, transaction);
                        summary.xiaoji_guaranteed_drops.push({
                            player_id: targetMember.player_id,
                            item_key: drop.item_key,
                            count,
                            reason: drop.priority === 'wanxin' ? '婉心封魂线优先（贡献最高）' : '保底掉落'
                        });
                    } catch (e) {
                        console.warn(`[MultiDungeonService] 小极宫保底掉落 ${drop.item_key} 发放失败:`, e.message);
                    }
                }
            }

            // 4.2.3 稀有掉落：按 weight 加权随机 rare_drop_count_min ~ rare_drop_count_max 件
            if (Array.isArray(rewards.rare_drops) && rewards.rare_drops.length > 0) {
                const minCount = rewards.rare_drop_count_min ?? 1;
                const maxCount = rewards.rare_drop_count_max ?? 3;
                // 完美通关多 1 件稀有掉落上限（鼓励追求高分）
                const actualMax = isPerfectClear ? maxCount + 1 : maxCount;
                const dropCount = Math.max(minCount, Math.min(actualMax, minCount + Math.floor(Math.random() * (actualMax - minCount + 1))));

                // 构建加权池（weight 越大被抽中概率越高）
                const totalWeight = rewards.rare_drops.reduce((s, d) => s + (d.weight || 0), 0);
                const droppedItems = [];
                const availablePool = [...rewards.rare_drops]; // 可重复抽取（允许同一物品多次掉落）
                for (let i = 0; i < dropCount; i++) {
                    if (availablePool.length === 0 || totalWeight <= 0) break;
                    let roll = Math.random() * totalWeight;
                    let pickedIdx = 0;
                    for (let j = 0; j < availablePool.length; j++) {
                        roll -= (availablePool[j].weight || 0);
                        if (roll <= 0) {
                            pickedIdx = j;
                            break;
                        }
                    }
                    const picked = availablePool[pickedIdx];
                    const count = (picked.count_min && picked.count_max)
                        ? Math.floor(picked.count_min + Math.random() * (picked.count_max - picked.count_min + 1))
                        : 1;
                    // 稀有掉落随机分发给队伍中任一成员（全员共享）
                    const randomMember = members[Math.floor(Math.random() * members.length)];
                    try {
                        await InventoryService.addItem(randomMember.player_id, picked.item_key, count, transaction);
                        droppedItems.push({
                            player_id: randomMember.player_id,
                            item_key: picked.item_key,
                            name: picked.name,
                            count
                        });
                    } catch (e) {
                        console.warn(`[MultiDungeonService] 小极宫稀有掉落 ${picked.item_key} 发放失败:`, e.message);
                    }
                }
                summary.xiaoji_rare_drops = droppedItems;
            }

            // 4.2.4 称号奖励：完美通关有 20% 概率获得"北冥破局者"称号
            if (isPerfectClear && rewards.title && rewards.title_chance > 0) {
                const titleRoll = Math.random();
                if (titleRoll < rewards.title_chance) {
                    summary.xiaoji_title_awarded = {
                        title_id: rewards.title,
                        title_name: rewards.title_name,
                        players: []
                    };
                    for (const m of members) {
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const titles = player.titles || [];
                            const alreadyHad = titles.includes(rewards.title);
                            if (!alreadyHad) {
                                titles.push(rewards.title);
                                player.titles = titles;
                                await player.save({ transaction });
                            }
                            summary.xiaoji_title_awarded.players.push({
                                player_id: m.player_id,
                                title_id: rewards.title,
                                already_had: alreadyHad
                            });
                        }
                    }
                }
            }
        }

        // 4.3 落云秘圃专属奖励结算（2026-07-21 新增，migration_0055）
        // 设计依据：xiuxian_game_guide.md 第32节·落云秘圃
        //   - 基础奖励：base_rewards（exp 12000 / spirit_stones 1500，由前述通用分支处理）
        //   - 完美通关加成：root_stability > 70 且 spirit_plant_aura > 50，每人额外 exp+4000 contribution+200
        //   - 灵眼树胚掉落逻辑：
        //     - act3_choice='cut_seal'：必掉 lingyan_sapling x1（guarantee_sapling=true 时 100% 几率）
        //     - act3_choice='balanced_harvest'：50% 几率掉落 lingyan_sapling x1
        //     - act3_choice='branch_care'：25% 几率掉落 lingyan_sapling x1
        //   - 普通掉落：按 chance 概率随机掉落 2-4 件
        //   - 稀有掉落：按 weight 加权随机 1-2 件（除灵眼树胚外，灵眼树胚由 act3_choice 决定）
        //   - 称号：完美通关玩家 20% 概率获得【落云守护者】称号
        if (instance.instance_key === 'luoyun') {
            const luoyunCfg = dungeonCfg;
            // 完美通关判定：根脉稳定 > 70 且 灵植灵气 > 50
            const rootStabilityMin = luoyunCfg.perfect_clear_root_stability_min ?? 70;
            const spiritPlantAuraMin = luoyunCfg.perfect_clear_spirit_plant_aura_min ?? 50;
            const isPerfectClear = (instance.root_stability || 0) > rootStabilityMin
                && (instance.spirit_plant_aura || 0) > spiritPlantAuraMin;
            summary.luoyun_perfect_clear = isPerfectClear;

            // 4.3.1 完美通关加成：每人额外获得修为+4000 贡献+200
            if (isPerfectClear && rewards.perfect_bonus) {
                const bonusExp = rewards.perfect_bonus.exp || 0;
                const bonusContribution = rewards.perfect_bonus.contribution || 0;
                const PlayerSect = require('../../models/playerSect');
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player && bonusExp > 0) {
                        const oldExp = BigInt(player.exp || 0);
                        player.exp = (oldExp + BigInt(bonusExp)).toString();
                        await player.save({ transaction });
                    }
                    // 宗门贡献度累加（未加入宗门则跳过贡献度部分，仅享受修为加成）
                    if (bonusContribution > 0) {
                        const playerSect = await PlayerSect.findOne({
                            where: { player_id: m.player_id },
                            transaction,
                            lock: transaction.LOCK.UPDATE
                        });
                        if (playerSect) {
                            playerSect.contribution = (playerSect.contribution || 0) + bonusContribution;
                            await playerSect.save({ transaction });
                        }
                    }
                    // 合并到 normal_drops 展示
                    const perfectBonus = [];
                    if (bonusExp > 0) perfectBonus.push({ type: 'exp', source: 'perfect_bonus', count: bonusExp.toString() });
                    if (bonusContribution > 0) perfectBonus.push({ type: 'contribution', source: 'perfect_bonus', count: bonusContribution });
                    if (perfectBonus.length > 0) {
                        const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                        if (existing) {
                            existing.drops.push(...perfectBonus);
                        } else {
                            summary.normal_drops.push({ player_id: m.player_id, drops: perfectBonus });
                        }
                    }
                }
            }

            // 4.3.2 灵眼树胚掉落：依据 act3_choice 决定掉落规则
            // 设计说明：灵眼树胚（lingyan_sapling）是落云秘圃的核心稀世掉落，
            //   可用掌天瓶养树培养成一截灵眼之树（详见掌天瓶养树系统）
            //   - act3_choice='cut_seal'（截枝封灵）：必掉，分给贡献最高队员
            //   - act3_choice='balanced_harvest'（均衡采枝）：50% 几率掉落
            //   - act3_choice='branch_care'（留枝养灵）：25% 几率掉落
            const act3Choice = instance.act3_choice;
            let saplingDropRate = 0;
            if (act3Choice === 'cut_seal') {
                saplingDropRate = 1.0;
            } else if (act3Choice === 'balanced_harvest') {
                saplingDropRate = 0.50;
            } else if (act3Choice === 'branch_care') {
                saplingDropRate = 0.25;
            }
            summary.luoyun_sapling_drop_info = {
                act3_choice: act3Choice,
                drop_rate: saplingDropRate,
                rolled: false,
                dropped: false
            };
            if (saplingDropRate > 0) {
                const saplingRoll = Math.random();
                summary.luoyun_sapling_drop_info.rolled = true;
                summary.luoyun_sapling_drop_info.roll_value = saplingRoll;
                if (saplingRoll < saplingDropRate) {
                    // 灵眼树胚优先分给贡献最高的队员
                    const sortedMembers = [...members].sort((a, b) => (b.contribution || 0) - (a.contribution || 0));
                    const targetMember = sortedMembers[0];
                    try {
                        await InventoryService.addItem(targetMember.player_id, 'lingyan_sapling', 1, transaction);
                        summary.luoyun_sapling_drop_info.dropped = true;
                        summary.luoyun_sapling_drop_info.player_id = targetMember.player_id;
                        summary.luoyun_sapling_drop_info.item_key = 'lingyan_sapling';
                        summary.luoyun_sapling_drop_info.count = 1;
                    } catch (e) {
                        console.warn(`[MultiDungeonService] 落云秘圃灵眼树胚发放失败:`, e.message);
                        summary.luoyun_sapling_drop_info.error = e.message;
                    }
                }
            }

            // 4.3.3 普通掉落：按 chance 概率随机掉落（lingzhi_grass/spirit_branch/spirit_vein_stone）
            // 由前述 rewards.normal_drops 通用分支处理（与本节小极宫共用逻辑）

            // 4.3.4 稀有掉落：按 weight 加权随机 1-2 件（除灵眼树胚外，灵眼树胚由 act3_choice 决定）
            if (Array.isArray(rewards.rare_drops) && rewards.rare_drops.length > 0) {
                const minCount = rewards.rare_drop_count_min ?? 1;
                const maxCount = rewards.rare_drop_count_max ?? 2;
                // 完美通关多 1 件稀有掉落上限
                const actualMax = isPerfectClear ? maxCount + 1 : maxCount;
                const dropCount = Math.max(minCount, Math.min(actualMax, minCount + Math.floor(Math.random() * (actualMax - minCount + 1))));

                // 构建加权池
                const totalWeight = rewards.rare_drops.reduce((s, d) => s + (d.weight || 0), 0);
                const droppedItems = [];
                const availablePool = [...rewards.rare_drops];
                for (let i = 0; i < dropCount; i++) {
                    if (availablePool.length === 0 || totalWeight <= 0) break;
                    let roll = Math.random() * totalWeight;
                    let pickedIdx = 0;
                    for (let j = 0; j < availablePool.length; j++) {
                        roll -= (availablePool[j].weight || 0);
                        if (roll <= 0) {
                            pickedIdx = j;
                            break;
                        }
                    }
                    const picked = availablePool[pickedIdx];
                    const count = (picked.count_min && picked.count_max)
                        ? Math.floor(picked.count_min + Math.random() * (picked.count_max - picked.count_min + 1))
                        : 1;
                    // 稀有掉落随机分发给队伍中任一成员（全员共享）
                    const randomMember = members[Math.floor(Math.random() * members.length)];
                    try {
                        await InventoryService.addItem(randomMember.player_id, picked.item_key, count, transaction);
                        droppedItems.push({
                            player_id: randomMember.player_id,
                            item_key: picked.item_key,
                            name: picked.name,
                            count
                        });
                    } catch (e) {
                        console.warn(`[MultiDungeonService] 落云秘圃稀有掉落 ${picked.item_key} 发放失败:`, e.message);
                    }
                }
                summary.luoyun_rare_drops = droppedItems;
            }

            // 4.3.5 称号奖励：完美通关有 20% 概率获得"落云守护者"称号
            if (isPerfectClear && rewards.title && rewards.title_chance > 0) {
                const titleRoll = Math.random();
                if (titleRoll < rewards.title_chance) {
                    summary.luoyun_title_awarded = {
                        title_id: rewards.title,
                        title_name: rewards.title_name,
                        players: []
                    };
                    for (const m of members) {
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const titles = player.titles || [];
                            const alreadyHad = titles.includes(rewards.title);
                            if (!alreadyHad) {
                                titles.push(rewards.title);
                                player.titles = titles;
                                await player.save({ transaction });
                            }
                            summary.luoyun_title_awarded.players.push({
                                player_id: m.player_id,
                                title_id: rewards.title,
                                already_had: alreadyHad
                            });
                        }
                    }
                }
            }
        }

        // 4.4 苍坤洞府专属奖励结算（2026-07-21 新增，migration_0057）
        // 设计依据：xiuxian_game_guide.md 掩月抢亲前置副本·苍坤洞府
        //   - 完美通关加成：士气 > 50 且 神魂稳定 > 60 时，每人额外获得修为+3000 灵石+500
        //   - 卷轴线索加成：每10点卷轴线索 +1000 修为 +100 灵石（全员）
        //   - 动态权重掉落门票线索：
        //       final_chance = base_chance * (1 + scroll_clue/100 + forbidden_rift/100 + escape_choice_bonus)
        //       escape_choice_bonus: forced_breakout=0.0 / formation_escape=0.3 / stealth_escape=0.5
        //       每位在场成员独立判定，掉落月影传书残页或掩月密讯（掩月抢亲门票线索）
        //   - 称号奖励：完美通关 20% 概率获得"苍坤探秘者"称号
        if (instance.instance_key === 'cangkun') {
            const cangkunCfg = dungeonCfg;
            // 完美通关判定：士气 > 50 且 神魂稳定 > 60
            const moraleMin = cangkunCfg.perfect_clear_morale_min ?? 50;
            const soulStabilityMin = cangkunCfg.perfect_clear_soul_stability_min ?? 60;
            const isPerfectClear = (instance.morale || 0) > moraleMin
                && (instance.soul_stability || 0) > soulStabilityMin;
            summary.cangkun_perfect_clear = isPerfectClear;
            summary.cangkun_variables = {
                scroll_clue: instance.scroll_clue,
                forbidden_rift: instance.forbidden_rift,
                escape_difficulty: instance.escape_difficulty,
                escape_choice: instance.escape_choice
            };

            // 4.4.1 完美通关加成：每人额外获得修为+3000 灵石+500
            if (isPerfectClear && rewards.perfect_bonus) {
                const bonusExp = rewards.perfect_bonus.exp || 0;
                const bonusStones = rewards.perfect_bonus.spirit_stones || 0;
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player) {
                        const perfectBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            perfectBonus.push({ type: 'exp', source: 'perfect_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            perfectBonus.push({ type: 'spirit_stones', source: 'perfect_bonus', count: bonusStones.toString() });
                        }
                        if (perfectBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...perfectBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: perfectBonus });
                            }
                        }
                    }
                }
            }

            // 4.4.2 卷轴线索加成：每10点卷轴线索 +1000 修为 +100 灵石（全员）
            if (rewards.scroll_clue_bonus && instance.scroll_clue > 0) {
                const expPer10 = rewards.scroll_clue_bonus.exp_per_10_scroll_clue || 1000;
                const stonesPer10 = rewards.scroll_clue_bonus.spirit_stones_per_10_scroll_clue || 100;
                const bonusExp = Math.floor(instance.scroll_clue / 10) * expPer10;
                const bonusStones = Math.floor(instance.scroll_clue / 10) * stonesPer10;
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player) {
                        const scrollBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            scrollBonus.push({ type: 'exp', source: 'scroll_clue_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            scrollBonus.push({ type: 'spirit_stones', source: 'scroll_clue_bonus', count: bonusStones.toString() });
                        }
                        if (scrollBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...scrollBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: scrollBonus });
                            }
                        }
                    }
                }
            }

            // 4.4.3 动态权重掉落门票线索（核心机制）
            // final_chance = base_chance * (1 + scroll_clue/100 + forbidden_rift/100 + escape_choice_bonus)
            // 每位在场成员独立判定，最多掉落 2 种门票线索（月影传书残页 / 掩月密讯）
            if (rewards.ticket_clue_drops && Array.isArray(rewards.ticket_clue_drops.drops)) {
                const escapeChoiceBonusMap = rewards.ticket_clue_drops.escape_choice_bonus || {
                    forced_breakout: 0.0,
                    formation_escape: 0.3,
                    stealth_escape: 0.5
                };
                const escapeChoiceBonus = escapeChoiceBonusMap[instance.escape_choice] || 0;
                const scrollClueFactor = (instance.scroll_clue || 0) / 100;
                const forbiddenRiftFactor = (instance.forbidden_rift || 0) / 100;
                const dynamicMultiplier = 1 + scrollClueFactor + forbiddenRiftFactor + escapeChoiceBonus;

                summary.cangkun_ticket_clue_drops = {
                    dynamic_multiplier: dynamicMultiplier,
                    escape_choice_bonus: escapeChoiceBonus,
                    scroll_clue_factor: scrollClueFactor,
                    forbidden_rift_factor: forbiddenRiftFactor,
                    drops: []
                };

                for (const m of members) {
                    const memberClueDrops = [];
                    for (const drop of rewards.ticket_clue_drops.drops) {
                        const finalChance = Math.min(1.0, drop.base_chance * dynamicMultiplier);
                        const roll = Math.random();
                        if (roll < finalChance) {
                            try {
                                await InventoryService.addItem(m.player_id, drop.item_key, 1, transaction);
                                memberClueDrops.push({
                                    item_key: drop.item_key,
                                    name: drop.name,
                                    count: 1,
                                    base_chance: drop.base_chance,
                                    final_chance: finalChance,
                                    roll_value: roll
                                });
                            } catch (e) {
                                console.warn(`[MultiDungeonService] 苍坤门票线索 ${drop.item_key} 发放给玩家 ${m.player_id} 失败:`, e.message);
                            }
                        }
                    }
                    if (memberClueDrops.length > 0) {
                        summary.cangkun_ticket_clue_drops.drops.push({
                            player_id: m.player_id,
                            drops: memberClueDrops
                        });
                        // 合并到 normal_drops 展示
                        const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                        if (existing) {
                            existing.drops.push(...memberClueDrops.map(d => ({
                                type: 'item',
                                source: 'ticket_clue_drops',
                                item_key: d.item_key,
                                count: d.count
                            })));
                        } else {
                            summary.normal_drops.push({
                                player_id: m.player_id,
                                drops: memberClueDrops.map(d => ({
                                    type: 'item',
                                    source: 'ticket_clue_drops',
                                    item_key: d.item_key,
                                    count: d.count
                                }))
                            });
                        }
                    }
                }
            }

            // 4.4.4 称号奖励：完美通关 20% 概率获得"苍坤探秘者"称号
            if (isPerfectClear && rewards.title && rewards.title_chance > 0) {
                const titleRoll = Math.random();
                if (titleRoll < rewards.title_chance) {
                    summary.cangkun_title_awarded = {
                        title_id: rewards.title,
                        title_name: rewards.title_name,
                        players: []
                    };
                    for (const m of members) {
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const titles = player.titles || [];
                            const alreadyHad = titles.includes(rewards.title);
                            if (!alreadyHad) {
                                titles.push(rewards.title);
                                player.titles = titles;
                                await player.save({ transaction });
                            }
                            summary.cangkun_title_awarded.players.push({
                                player_id: m.player_id,
                                title_id: rewards.title,
                                already_had: alreadyHad
                            });
                        }
                    }
                }
            }
        }

        // 4.5 血色试炼专属奖励结算（2026-07-21 新增，migration_0058）
        //   - 杀戮分加成：每10点 kill_score +2000 修为 +150 灵石（个人，仅幸存者）
        //   - 幸存者加成：每位幸存者 +5000 修为 +800 灵石（个人，仅幸存者）
        //   - 完美通关加成：零淘汰（eliminations=0）时每人 +10000 修为 +2000 灵石
        //   - 称号奖励：完美通关 30% 概率获得"血色试炼幸存者"称号
        if (instance.instance_key === 'xuese') {
            const xueseCfg = dungeonCfg;
            // 完美通关判定：零淘汰
            const isPerfectClear = (instance.eliminations || 0) === 0;
            summary.xuese_perfect_clear = isPerfectClear;
            summary.xuese_variables = {
                blood_fury: instance.blood_fury,
                eliminations: instance.eliminations,
                survivor_count: instance.survivor_count,
                blood_qi_avg: instance.blood_qi_avg
            };

            // 4.5.1 杀戮分加成：每10点 kill_score +2000 修为 +150 灵石（仅幸存者）
            if (rewards.kill_score_bonus) {
                const expPer10 = rewards.kill_score_bonus.exp_per_10_kill_score || 2000;
                const stonesPer10 = rewards.kill_score_bonus.spirit_stones_per_10_kill_score || 150;
                for (const m of members) {
                    // 仅幸存者（未被淘汰）可获得杀戮分加成
                    if (m.is_eliminated) continue;
                    const memberKillScore = m.kill_score || 0;
                    if (memberKillScore <= 0) continue;
                    const bonusExp = Math.floor(memberKillScore / 10) * expPer10;
                    const bonusStones = Math.floor(memberKillScore / 10) * stonesPer10;
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player && (bonusExp > 0 || bonusStones > 0)) {
                        const killScoreBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            killScoreBonus.push({ type: 'exp', source: 'kill_score_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            killScoreBonus.push({ type: 'spirit_stones', source: 'kill_score_bonus', count: bonusStones.toString() });
                        }
                        if (killScoreBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...killScoreBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: killScoreBonus });
                            }
                        }
                    }
                }
            }

            // 4.5.2 幸存者加成：每位幸存者 +5000 修为 +800 灵石（仅幸存者）
            // 设计：幸存人数越多，每人加成越多（鼓励共生策略）
            if (rewards.survivor_bonus && (instance.survivor_count || 0) > 0) {
                const expPerSurvivor = rewards.survivor_bonus.exp_per_survivor || 5000;
                const stonesPerSurvivor = rewards.survivor_bonus.spirit_stones_per_survivor || 800;
                const bonusExp = expPerSurvivor * instance.survivor_count;
                const bonusStones = stonesPerSurvivor * instance.survivor_count;
                for (const m of members) {
                    if (m.is_eliminated) continue;
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player) {
                        const survivorBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            survivorBonus.push({ type: 'exp', source: 'survivor_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            survivorBonus.push({ type: 'spirit_stones', source: 'survivor_bonus', count: bonusStones.toString() });
                        }
                        if (survivorBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...survivorBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: survivorBonus });
                            }
                        }
                    }
                }
            }

            // 4.5.3 完美通关加成：零淘汰时每人 +10000 修为 +2000 灵石（全员）
            if (isPerfectClear && rewards.perfect_bonus) {
                const bonusExp = rewards.perfect_bonus.exp || 0;
                const bonusStones = rewards.perfect_bonus.spirit_stones || 0;
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player) {
                        const perfectBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            perfectBonus.push({ type: 'exp', source: 'perfect_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            perfectBonus.push({ type: 'spirit_stones', source: 'perfect_bonus', count: bonusStones.toString() });
                        }
                        if (perfectBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...perfectBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: perfectBonus });
                            }
                        }
                    }
                }
            }

            // 4.5.4 称号奖励：完美通关 30% 概率获得"血色试炼幸存者"称号（仅幸存者）
            if (isPerfectClear && rewards.title && rewards.title_chance > 0) {
                const titleRoll = Math.random();
                if (titleRoll < rewards.title_chance) {
                    summary.xuese_title_awarded = {
                        title_id: rewards.title,
                        title_name: rewards.title_name,
                        players: []
                    };
                    for (const m of members) {
                        if (m.is_eliminated) continue; // 仅幸存者可获得称号
                        const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                        if (player) {
                            const titles = player.titles || [];
                            const alreadyHad = titles.includes(rewards.title);
                            if (!alreadyHad) {
                                titles.push(rewards.title);
                                player.titles = titles;
                                await player.save({ transaction });
                            }
                            summary.xuese_title_awarded.players.push({
                                player_id: m.player_id,
                                title_id: rewards.title,
                                already_had: alreadyHad
                            });
                        }
                    }
                }
            }
        }

        // 4.6 坠魔谷专属奖励结算（2026-07-21 新增，migration_0059）
        //   - 道心加成：每10点 avg_dao_heart +3000 修为 +400 灵石（个人，仅未堕魔者）
        //   - 完美通关加成：零堕魔（无任何成员 is_fallen=1）时每人 +12000 修为 +2500 灵石
        //   - 称号奖励：完美通关 25% 概率获得"伏魔者"称号（仅未堕魔者，需 avg_dao_heart ≥ 80）
        // 设计：与血色试炼（杀戮分加成/幸存者加成/完美通关加成）差异化
        //   - 血色试炼奖励侵略策略（高杀戮分高收益）
        //   - 坠魔谷奖励守护策略（高道心高收益，零堕魔完美通关）
        if (instance.instance_key === 'zhuimo') {
            const zhuimoCfg = dungeonCfg;
            // 完美通关判定：无任何成员堕魔（is_fallen=0 全员）
            const fallenCount = await MultiDungeonMember.count({
                where: { instance_id: instance.id, is_fallen: 1 },
                transaction
            });
            const isPerfectClear = fallenCount === 0;
            // 配置可选开关：perfect_clear_no_fallen=true 表示必须零堕魔才算完美通关
            const requireNoFallen = zhuimoCfg.perfect_clear_no_fallen !== false;
            const finalPerfectClear = isPerfectClear || !requireNoFallen;
            summary.zhuimo_perfect_clear = finalPerfectClear;
            summary.zhuimo_variables = {
                avg_heart_demon: instance.avg_heart_demon,
                avg_dao_heart: instance.avg_dao_heart,
                fallen_count: fallenCount
            };

            // 4.6.1 道心加成：每10点 avg_dao_heart +3000 修为 +400 灵石（仅未堕魔者）
            if (rewards.dao_heart_bonus) {
                const expPer10 = rewards.dao_heart_bonus.exp_per_10_dao_heart || 3000;
                const stonesPer10 = rewards.dao_heart_bonus.spirit_stones_per_10_dao_heart || 400;
                const avgDaoHeart = instance.avg_dao_heart || 0;
                const bonusExp = Math.floor(avgDaoHeart / 10) * expPer10;
                const bonusStones = Math.floor(avgDaoHeart / 10) * stonesPer10;
                for (const m of members) {
                    // 仅未堕魔者可获得道心加成
                    if (m.is_fallen) continue;
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player && (bonusExp > 0 || bonusStones > 0)) {
                        const daoHeartBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            daoHeartBonus.push({ type: 'exp', source: 'dao_heart_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            daoHeartBonus.push({ type: 'spirit_stones', source: 'dao_heart_bonus', count: bonusStones.toString() });
                        }
                        if (daoHeartBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...daoHeartBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: daoHeartBonus });
                            }
                        }
                    }
                }
            }

            // 4.6.2 完美通关加成：零堕魔时每人 +12000 修为 +2500 灵石（全员，含已堕魔者）
            // 设计：完美通关是全队荣誉，堕魔者也可获得基础完美奖励（但无法获得道心加成与称号）
            if (finalPerfectClear && rewards.perfect_bonus) {
                const bonusExp = rewards.perfect_bonus.exp || 0;
                const bonusStones = rewards.perfect_bonus.spirit_stones || 0;
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player) {
                        const perfectBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            perfectBonus.push({ type: 'exp', source: 'perfect_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            perfectBonus.push({ type: 'spirit_stones', source: 'perfect_bonus', count: bonusStones.toString() });
                        }
                        if (perfectBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...perfectBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: perfectBonus });
                            }
                        }
                    }
                }
            }

            // 4.6.3 称号奖励：完美通关 25% 概率获得"伏魔者"称号（仅未堕魔者，需 avg_dao_heart ≥ 80）
            // 设计：与血色试炼【血色试炼幸存者】称号差异化，强调道心守护者的荣誉
            if (finalPerfectClear && rewards.title && rewards.title_chance > 0) {
                const minDaoHeart = rewards.title_min_dao_heart || 80;
                const avgDaoHeart = instance.avg_dao_heart || 0;
                if (avgDaoHeart >= minDaoHeart) {
                    const titleRoll = Math.random();
                    if (titleRoll < rewards.title_chance) {
                        summary.zhuimo_title_awarded = {
                            title_id: rewards.title,
                            title_name: rewards.title_name,
                            players: []
                        };
                        for (const m of members) {
                            if (m.is_fallen) continue; // 仅未堕魔者可获得称号
                            const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                            if (player) {
                                const titles = player.titles || [];
                                const alreadyHad = titles.includes(rewards.title);
                                if (!alreadyHad) {
                                    titles.push(rewards.title);
                                    player.titles = titles;
                                    await player.save({ transaction });
                                }
                                summary.zhuimo_title_awarded.players.push({
                                    player_id: m.player_id,
                                    title_id: rewards.title,
                                    already_had: alreadyHad
                                });
                            }
                        }
                    }
                }
            }
        }

        // 4.7 黄龙山专属奖励结算（2026-07-21 新增，migration_0060）
        //   - 完美通关判定：全员未叛道（huanglong_is_defecting=0 全员）+ 共鸣数=5
        //   - 阵法强度加成：每10点 huanglong_formation_power +2000 修为 +150 灵石（全员）
        //   - 完美通关加成：+10000 修为 +2000 灵石（全员）
        //   - 称号奖励：黄龙阵主，30% 几率，需阵法强度≥120（全员未叛道者）
        //   - 宗门贡献奖励：base_rewards 含 sect_contribution:50（新增 reward type）
        // 设计：与坠魔谷（道心加成/零堕魔完美）差异化
        //   - 坠魔谷奖励道心守护策略
        //   - 黄龙山奖励阵法协同策略（高阵法强度+高共鸣数+零叛道完美）
        if (instance.instance_key === 'huanglong') {
            const huanglongCfg = dungeonCfg;
            // 完美通关判定：全员未叛道 + 共鸣数≥5
            const defectingCount = await MultiDungeonMember.count({
                where: { instance_id: instance.id, huanglong_is_defecting: 1 },
                transaction
            });
            const isPerfectClear = defectingCount === 0 && (instance.huanglong_resonance_count || 0) >= 5;
            // 配置可选开关：perfect_clear_no_defect=true 表示必须零叛道才算完美通关
            const requireNoDefect = huanglongCfg.perfect_clear_no_defect !== false;
            const finalPerfectClear = isPerfectClear || !requireNoDefect;
            summary.huanglong_perfect_clear = finalPerfectClear;
            summary.huanglong_variables = {
                formation_power: instance.huanglong_formation_power,
                resonance_count: instance.huanglong_resonance_count,
                defecting_count: defectingCount
            };

            // 4.7.1 阵法强度加成：每10点 huanglong_formation_power +2000 修为 +150 灵石（全员）
            if (rewards.formation_power_bonus) {
                const expPer10 = rewards.formation_power_bonus.exp_per_10_formation_power || 2000;
                const stonesPer10 = rewards.formation_power_bonus.spirit_stones_per_10_formation_power || 150;
                const formationPower = instance.huanglong_formation_power || 0;
                const bonusExp = Math.floor(formationPower / 10) * expPer10;
                const bonusStones = Math.floor(formationPower / 10) * stonesPer10;
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player && (bonusExp > 0 || bonusStones > 0)) {
                        const formationPowerBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            formationPowerBonus.push({ type: 'exp', source: 'formation_power_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            formationPowerBonus.push({ type: 'spirit_stones', source: 'formation_power_bonus', count: bonusStones.toString() });
                        }
                        if (formationPowerBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...formationPowerBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: formationPowerBonus });
                            }
                        }
                    }
                }
            }

            // 4.7.2 完美通关加成：零叛道 + 共鸣数≥5 时每人 +10000 修为 +2000 灵石（全员）
            // 设计：完美通关是全队荣誉，叛道者也可获得基础完美奖励（但无法获得称号）
            if (finalPerfectClear && rewards.perfect_bonus) {
                const bonusExp = rewards.perfect_bonus.exp || 0;
                const bonusStones = rewards.perfect_bonus.spirit_stones || 0;
                for (const m of members) {
                    const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                    if (player) {
                        const perfectBonus = [];
                        if (bonusExp > 0) {
                            const oldExp = BigInt(player.exp || 0);
                            player.exp = (oldExp + BigInt(bonusExp)).toString();
                            perfectBonus.push({ type: 'exp', source: 'perfect_bonus', count: bonusExp.toString() });
                        }
                        if (bonusStones > 0) {
                            const oldStones = BigInt(player.spirit_stones || 0);
                            player.spirit_stones = (oldStones + BigInt(bonusStones)).toString();
                            perfectBonus.push({ type: 'spirit_stones', source: 'perfect_bonus', count: bonusStones.toString() });
                        }
                        if (perfectBonus.length > 0) {
                            await player.save({ transaction });
                            const existing = summary.normal_drops.find(d => d.player_id === m.player_id);
                            if (existing) {
                                existing.drops.push(...perfectBonus);
                            } else {
                                summary.normal_drops.push({ player_id: m.player_id, drops: perfectBonus });
                            }
                        }
                    }
                }
            }

            // 4.7.3 称号奖励：完美通关 30% 概率获得"黄龙阵主"称号（仅未叛道者，需阵法强度≥120）
            // 设计：与坠魔谷【伏魔者】称号差异化，强调阵法协同的荣誉
            if (finalPerfectClear && rewards.title && rewards.title_chance > 0) {
                const minFormationPower = rewards.title_min_formation_power || 120;
                const formationPower = instance.huanglong_formation_power || 0;
                if (formationPower >= minFormationPower) {
                    const titleRoll = Math.random();
                    if (titleRoll < rewards.title_chance) {
                        summary.huanglong_title_awarded = {
                            title_id: rewards.title,
                            title_name: rewards.title_name,
                            players: []
                        };
                        for (const m of members) {
                            if (m.huanglong_is_defecting) continue; // 仅未叛道者可获得称号
                            const player = await Player.findByPk(m.player_id, { transaction, lock: transaction.LOCK.UPDATE });
                            if (player) {
                                const titles = player.titles || [];
                                const alreadyHad = titles.includes(rewards.title);
                                if (!alreadyHad) {
                                    titles.push(rewards.title);
                                    player.titles = titles;
                                    await player.save({ transaction });
                                }
                                summary.huanglong_title_awarded.players.push({
                                    player_id: m.player_id,
                                    title_id: rewards.title,
                                    already_had: alreadyHad
                                });
                            }
                        }
                    }
                }
            }
        }

        // 5. 全员进入冷却
        await MultiDungeonService._applyCooldownToAllMembers(instance, 'cleared', transaction);

        return { summary };
    }

    /**
     * 处理昆吾山·封魔塔第四幕自动决战
     * 5 回合内打掉塔心魔影（HP=1000000）并将封印推进到 80+ 通关
     * 
     * 每回合逻辑：
     *   1. 玩家攻击削减魔影HP：damage = damage_per_round_base + linglong * damage_linglong_bonus_per_point
     *   2. 封印推进值 +10（上限100）
     *   3. 魔气值 +5（上限100）
     *   4. 士气值 +0（保持不变）
     *   5. 写入一条 choice 记录（act_number=4, round_number=1-5）便于审计
     * 
     * 失败条件：魔气 >= 100 OR 士气 <= 0 OR 5 回合未击败魔影
     * 通关条件：tower_shadow_hp <= 0 AND seal_progress >= 80
     * 
     * @param {Object} instance - 副本实例（current_act 已推进到第四幕）
     * @param {Object} finalAct - 第四幕配置（含 rounds_max / damage_per_round_base 等）
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} { outcome: 'cleared'|'failed', rounds_total, rounds_log, fail_reason, fail_reason_message, ... }
     */
    static async _processKunwuFinalAct(instance, finalAct, transaction) {
        // 初始化塔心魔影HP和封印推进值（首次进入第四幕）
        if (!instance.tower_shadow_hp || instance.tower_shadow_hp <= 0) {
            instance.tower_shadow_hp = BigInt(finalAct.tower_shadow_hp_base || 1000000);
        }
        if (instance.seal_progress == null) {
            // 初始封印推进值 = 当前封印稳定度（前3幕累积的）
            instance.seal_progress = instance.seal_stability || 50;
        }

        const roundsMax = finalAct.rounds_max || 5;
        const damageBase = finalAct.damage_per_round_base || 200000;
        const damageLinglongBonus = finalAct.damage_linglong_bonus_per_point || 2000;
        const sealProgressChange = finalAct.seal_progress_change_per_round || 10;
        const demonicQiChange = finalAct.demonic_qi_change_per_round || 5;
        const moraleChange = finalAct.morale_change_per_round || 0;

        // 通关阈值（默认 80）
        const sealProgressTarget = (finalAct.clear_condition && finalAct.clear_condition.seal_progress_gte) || 80;

        const roundsLog = [];
        let battleOutcome = 'ongoing'; // ongoing / cleared / failed
        let failReason = null;
        let failReasonMessage = null;

        for (let round = 1; round <= roundsMax; round++) {
            // 计算本回合伤害：基础 + 玲珑值 * 加成
            const linglong = instance.linglong || 0;
            const damage = BigInt(damageBase + linglong * damageLinglongBonus);
            const oldHp = BigInt(instance.tower_shadow_hp);
            const newHp = oldHp > damage ? (oldHp - damage) : BigInt(0);
            instance.tower_shadow_hp = newHp;
            const actualDamage = oldHp - newHp; // 实际削减量（避免负数）

            // 推进变量
            instance.seal_progress = Math.min(VARIABLE_BOUNDS.seal_progress.max, (instance.seal_progress || 0) + sealProgressChange);
            instance.demonic_qi = Math.min(VARIABLE_BOUNDS.demonic_qi.max, (instance.demonic_qi || 0) + demonicQiChange);
            instance.morale = Math.max(VARIABLE_BOUNDS.morale.min, Math.min(VARIABLE_BOUNDS.morale.max, (instance.morale || 0) + moraleChange));

            // 写入本回合的抉择记录（便于审计回放）
            await MultiDungeonChoice.create({
                instance_id: instance.id,
                act_number: finalAct.act_number,
                act_name: finalAct.act_name,
                choice_key: `auto_round_${round}`,
                choice_text: `第 ${round} 回合自动战斗`,
                chosen_option: 'auto_advance',
                chosen_by: instance.leader_player_id,
                chosen_at: new Date(),
                morale_change: moraleChange,
                vigilance_change: 0,
                demon_corruption_change: 0,
                seal_stability_change: 0,
                harvest_multiplier_change: 0,
                // 昆吾山专属
                demonic_qi_change: demonicQiChange,
                mountain_seal_change: 0,
                treasure_pressure_change: 0,
                linglong_change: 0,
                seal_progress_change: sealProgressChange,
                tower_shadow_hp_change: `-${actualDamage.toString()}`, // 负值表示削减
                round_number: round,
                eye_key: null
            }, { transaction });

            roundsLog.push({
                round,
                damage: actualDamage.toString(),
                tower_shadow_hp_after: newHp.toString(),
                seal_progress_after: instance.seal_progress,
                demonic_qi_after: instance.demonic_qi,
                morale_after: instance.morale
            });

            // 优先检查失败（避免魔气满后还判定通关的边界）
            if (instance.demonic_qi >= 100) {
                battleOutcome = 'failed';
                failReason = 'demonic_qi_exceeded';
                failReasonMessage = `第 ${round} 回合后魔气值达到 ${instance.demonic_qi}，魔气失控，副本失败`;
                break;
            }
            if (instance.morale <= 0) {
                battleOutcome = 'failed';
                failReason = 'morale_depleted';
                failReasonMessage = `第 ${round} 回合后士气归零，队伍溃散，副本失败`;
                break;
            }

            // 检查通关
            if (newHp === 0n && instance.seal_progress >= sealProgressTarget) {
                battleOutcome = 'cleared';
                break;
            }
        }

        // 5 回合用尽仍未通关
        if (battleOutcome === 'ongoing') {
            battleOutcome = 'failed';
            failReason = 'rounds_exceed';
            failReasonMessage = `5 回合用尽，魔影HP剩余 ${instance.tower_shadow_hp.toString()}，封印推进 ${instance.seal_progress}/${sealProgressTarget}，副本失败`;
        }

        await instance.save({ transaction });

        return {
            outcome: battleOutcome,
            fail_reason: failReason,
            fail_reason_message: failReasonMessage,
            rounds_total: roundsLog.length,
            rounds_max: roundsMax,
            rounds_log: roundsLog,
            final_tower_shadow_hp: instance.tower_shadow_hp.toString(),
            final_seal_progress: instance.seal_progress,
            final_demonic_qi: instance.demonic_qi,
            final_morale: instance.morale,
            final_linglong: instance.linglong,
            seal_progress_target: sealProgressTarget
        };
    }

    /**
     * 处理虚天殿第六幕自动决战（后殿阵策）
     *
     * 6 回合自动战斗逻辑：
     *   - 每回合伤害 = base + 阵法强度 × bonus_per_point
     *   - 每回合消耗神魂稳定度、提升宝压
     *   - 通关条件：虚天主魂HP归零 且 阵法强度 ≥ 70
     *   - 失败条件：神魂稳定度 ≤ 0 / 士气 ≤ 0 / 6 回合用尽未通关
     *
     * @param {Object} instance - 副本实例
     * @param {Object} finalAct - 第六幕配置
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} { outcome, fail_reason, fail_reason_message, rounds_total, rounds_max, rounds_log, final_* }
     */
    static async _processXutianFinalAct(instance, finalAct, transaction) {
        // 初始化虚天主魂HP（首次进入第六幕）
        if (!instance.void_soul_hp || instance.void_soul_hp <= 0) {
            instance.void_soul_hp = BigInt(finalAct.void_soul_hp_base || 1500000);
        }
        // 阵法强度沿用前5幕累积值（不重置）

        const roundsMax = finalAct.rounds_max || 6;
        const damageBase = finalAct.damage_per_round_base || 180000;
        const damageFormationBonus = finalAct.damage_formation_bonus_per_point || 2500;
        const soulStabilityChange = finalAct.soul_stability_change_per_round || -3;
        const treasurePressureChange = finalAct.treasure_pressure_change_per_round || 5;
        const moraleChange = finalAct.morale_change_per_round || 0;

        // 通关阈值：阵法强度 ≥ 70（默认）
        const formationPowerTarget = (finalAct.clear_condition && finalAct.clear_condition.formation_power_gte) || 70;

        const roundsLog = [];
        let battleOutcome = 'ongoing'; // ongoing / cleared / failed
        let failReason = null;
        let failReasonMessage = null;

        for (let round = 1; round <= roundsMax; round++) {
            // 计算本回合伤害：基础 + 阵法强度 × 加成
            const formationPower = instance.formation_power || 0;
            const damage = BigInt(damageBase + formationPower * damageFormationBonus);
            const oldHp = BigInt(instance.void_soul_hp);
            const newHp = oldHp > damage ? (oldHp - damage) : BigInt(0);
            instance.void_soul_hp = newHp;
            const actualDamage = oldHp - newHp; // 实际削减量（避免负数）

            // 推进变量：神魂稳定度下降、宝压上升、士气变化
            instance.soul_stability = Math.max(VARIABLE_BOUNDS.soul_stability.min, (instance.soul_stability || 0) + soulStabilityChange);
            instance.treasure_pressure = Math.min(VARIABLE_BOUNDS.treasure_pressure.max, (instance.treasure_pressure || 0) + treasurePressureChange);
            instance.morale = Math.max(VARIABLE_BOUNDS.morale.min, Math.min(VARIABLE_BOUNDS.morale.max, (instance.morale || 0) + moraleChange));

            // 写入本回合的抉择记录（便于审计回放）
            await MultiDungeonChoice.create({
                instance_id: instance.id,
                act_number: finalAct.act_number,
                act_name: finalAct.act_name,
                choice_key: `auto_round_${round}`,
                choice_text: `第 ${round} 回合自动决战`,
                chosen_option: 'auto_advance',
                chosen_by: instance.leader_player_id,
                chosen_at: new Date(),
                morale_change: moraleChange,
                vigilance_change: 0,
                demon_corruption_change: 0,
                seal_stability_change: 0,
                harvest_multiplier_change: 0,
                // 虚天殿专属
                treasure_pressure_change: treasurePressureChange,
                formation_power_change: 0,
                void_soul_hp_change: `-${actualDamage.toString()}`, // 负值表示削减
                round_number: round,
                eye_key: null
            }, { transaction });

            roundsLog.push({
                round,
                damage: actualDamage.toString(),
                void_soul_hp_before: oldHp.toString(),
                void_soul_hp_after: newHp.toString(),
                formation_power_after: instance.formation_power,
                soul_stability_after: instance.soul_stability,
                treasure_pressure_after: instance.treasure_pressure,
                morale_after: instance.morale
            });

            // 优先检查失败（避免神魂崩溃后还判定通关的边界）
            if (instance.soul_stability <= 0) {
                battleOutcome = 'failed';
                failReason = 'soul_stability_depleted';
                failReasonMessage = `第 ${round} 回合后神魂稳定度归零，神魂崩溃，副本失败`;
                break;
            }
            if (instance.morale <= 0) {
                battleOutcome = 'failed';
                failReason = 'morale_depleted';
                failReasonMessage = `第 ${round} 回合后士气归零，队伍溃散，副本失败`;
                break;
            }

            // 检查通关：虚天主魂HP归零 且 阵法强度 ≥ 目标值
            if (newHp === 0n && instance.formation_power >= formationPowerTarget) {
                battleOutcome = 'cleared';
                break;
            }
        }

        // 6 回合用尽仍未通关
        if (battleOutcome === 'ongoing') {
            battleOutcome = 'failed';
            failReason = 'rounds_exceed';
            if (instance.void_soul_hp > 0n) {
                failReasonMessage = `6 回合用尽，虚天主魂HP剩余 ${instance.void_soul_hp.toString()}，阵法强度 ${instance.formation_power}/${formationPowerTarget}，副本失败`;
            } else {
                failReasonMessage = `虚天主魂虽被击溃，但阵法强度仅 ${instance.formation_power}/${formationPowerTarget}，未能完全封印，副本失败`;
            }
        }

        await instance.save({ transaction });

        return {
            outcome: battleOutcome,
            fail_reason: failReason,
            fail_reason_message: failReasonMessage,
            rounds_total: roundsLog.length,
            rounds_max: roundsMax,
            rounds_log: roundsLog,
            final_void_soul_hp: instance.void_soul_hp.toString(),
            final_formation_power: instance.formation_power,
            final_soul_stability: instance.soul_stability,
            final_treasure_pressure: instance.treasure_pressure,
            final_morale: instance.morale,
            final_path_choice: instance.path_choice,
            formation_power_target: formationPowerTarget
        };
    }

    /**
     * 血色试炼淘汰机制：幕末淘汰血气最低者
     *
     * 设计依据：xiuxian_game_guide.md 第20节·副本决策
     *   血色试炼前3幕中第1/3幕标记 is_pvp_eliminable=true，幕末自动淘汰血气最低者
     *   淘汰机制制造 PVP 紧张感，迫使玩家在侵略（高伤害高杀戮分但自损血气）
     *   与共生（保血气多幸存）之间做策略平衡
     *
     * 淘汰规则：
     *   1. 查询所有在场幸存成员（is_present=1, is_eliminated=0）
     *   2. 按 blood_qi 升序排序，取末位 N 名淘汰（N=currentAct.elimination_count）
     *   3. 标记 is_eliminated=1，is_present=0（脱离副本）
     *   4. 累加 instance.eliminations
     *   5. 第3幕结束后更新 instance.survivor_count（用于第4幕决战伤害加成）
     *
     * 边界处理：
     *   - 若幸存人数 ≤ elimination_count，则不淘汰（避免全员淘汰导致副本无法继续）
     *   - 若幸存人数 = 1（仅剩队长），跳过淘汰（保证副本可推进至第4幕）
     *   - 多人血气相同时，按 kill_score 升序（杀戮分低者先淘汰，奖励侵略策略）
     *   - 仍相同则按 join_time 升序（先加入者先淘汰，避免随机性）
     *
     * @param {Object} instance - 副本实例
     * @param {Object} currentAct - 当前幕配置（含 elimination_count）
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} { success, eliminated_count, eliminated_members, survivor_count_after }
     */
    static async _applyXueseElimination(instance, currentAct, transaction) {
        const eliminationCount = currentAct.elimination_count || 0;
        if (eliminationCount <= 0) {
            return { success: false, reason: 'no_elimination_configured', eliminated_count: 0 };
        }

        // 查询所有在场幸存成员（带行级锁防止并发）
        const survivors = await MultiDungeonMember.findAll({
            where: { instance_id: instance.id, is_present: 1, is_eliminated: 0 },
            transaction,
            lock: transaction.LOCK.UPDATE
        });

        // 边界：幸存人数 ≤ 1 时跳过淘汰（保证副本可推进）
        if (survivors.length <= 1) {
            return {
                success: false,
                reason: 'insufficient_survivors',
                eliminated_count: 0,
                survivor_count_after: survivors.length
            };
        }

        // 边界：幸存人数 ≤ elimination_count 时，淘汰人数 = 幸存人数 - 1（至少保留1人）
        const actualEliminationCount = Math.min(eliminationCount, survivors.length - 1);

        // 按 blood_qi 升序 / kill_score 升序 / join_time 升序排序，取末位淘汰
        // 设计：血气相同则淘汰杀戮分低者（奖励侵略策略）；仍相同则淘汰先加入者
        survivors.sort((a, b) => {
            const aBloodQi = a.blood_qi ?? 100;
            const bBloodQi = b.blood_qi ?? 100;
            if (aBloodQi !== bBloodQi) return aBloodQi - bBloodQi;
            const aKillScore = a.kill_score ?? 0;
            const bKillScore = b.kill_score ?? 0;
            if (aKillScore !== bKillScore) return aKillScore - bKillScore;
            return new Date(a.join_time) - new Date(b.join_time);
        });

        const toEliminate = survivors.slice(0, actualEliminationCount);
        const remaining = survivors.slice(actualEliminationCount);

        // 标记淘汰成员
        const eliminatedMembers = [];
        for (const m of toEliminate) {
            m.is_eliminated = 1;
            m.is_present = 0;
            await m.save({ transaction });
            eliminatedMembers.push({
                player_id: m.player_id,
                nickname: m.player_nickname,
                blood_qi: m.blood_qi,
                kill_score: m.kill_score
            });
        }

        // 累加淘汰人数
        instance.eliminations = (instance.eliminations || 0) + actualEliminationCount;

        // 第3幕结束后更新幸存人数（用于第4幕决战伤害加成）
        if (currentAct.act_number === 3) {
            instance.survivor_count = remaining.length;
        }

        await instance.save({ transaction });

        return {
            success: true,
            eliminated_count: actualEliminationCount,
            eliminated_members: eliminatedMembers,
            survivor_count_after: remaining.length
        };
    }

    /**
     * 处理苍坤洞府第四幕自动决战（脱身抉择）
     *
     * 5 回合自动战斗逻辑（受 escape_choice 影响调整回合数）：
     *   - 每回合伤害 = base + 卷轴线索 × bonus_per_point
     *   - 每回合消耗士气(-2) 与神魂稳定度(-2)，提升脱身难度(+5)
     *   - 通关条件：苍坤守灵HP归零
     *   - 失败条件：士气 ≤ 0 / 神魂稳定度 ≤ 0 / 回合用尽未击败守灵
     *
     * escape_choice 对决战的影响（在 advance() 中已预设 escape_difficulty）：
     *   - forced_breakout（强行突围）：rounds_max + 1（更长时间击杀守灵，但门票掉率 +0%）
     *   - formation_escape（借阵脱身）：rounds_max ±0（门票掉率 +30%）
     *   - stealth_escape（隐遁潜行）：rounds_max - 1（更紧迫，但门票掉率 +50%）
     *
     * 注意：escape_difficulty 在 advance() 中已应用 escape_choice 的额外加成，
     *   本方法每回合再累加 escape_difficulty_change_per_round（默认+5），用于影响门票掉率
     *
     * @param {Object} instance - 副本实例（escape_choice 与 escape_difficulty 已预设）
     * @param {Object} finalAct - 第四幕配置（含 rounds_max / damage_per_round_base / cangkun_guardian_hp_base 等）
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} { outcome, fail_reason, fail_reason_message, rounds_total, rounds_max, rounds_log, final_* }
     */
    static async _processCangkunFinalAct(instance, finalAct, transaction) {
        // 初始化苍坤守灵HP（首次进入第四幕）
        if (!instance.cangkun_guardian_hp || instance.cangkun_guardian_hp <= 0) {
            instance.cangkun_guardian_hp = BigInt(finalAct.cangkun_guardian_hp_base || 800000);
        }

        // 基础回合数（5回合）+ escape_choice 调整
        // - forced_breakout: +1 回合（激进路线，给更多时间击杀守灵）
        // - formation_escape: ±0 回合（均衡路线）
        // - stealth_escape: -1 回合（稳健路线，缩短决战）
        let roundsMax = finalAct.rounds_max || 5;
        if (instance.escape_choice === 'forced_breakout') {
            roundsMax += 1;
        } else if (instance.escape_choice === 'stealth_escape') {
            roundsMax = Math.max(1, roundsMax - 1);
        }

        const damageBase = finalAct.damage_per_round_base || 150000;
        const damageScrollBonus = finalAct.damage_scroll_bonus_per_point || 2000;
        const escapeDifficultyChange = finalAct.escape_difficulty_change_per_round || 5;
        const moraleChange = finalAct.morale_change_per_round || -2;
        const soulStabilityChange = finalAct.soul_stability_change_per_round || -2;

        const roundsLog = [];
        let battleOutcome = 'ongoing'; // ongoing / cleared / failed
        let failReason = null;
        let failReasonMessage = null;

        for (let round = 1; round <= roundsMax; round++) {
            // 计算本回合伤害：基础 + 卷轴线索 × 加成
            const scrollClue = instance.scroll_clue || 0;
            const damage = BigInt(damageBase + scrollClue * damageScrollBonus);
            const oldHp = BigInt(instance.cangkun_guardian_hp);
            const newHp = oldHp > damage ? (oldHp - damage) : BigInt(0);
            instance.cangkun_guardian_hp = newHp;
            const actualDamage = oldHp - newHp; // 实际削减量（避免负数）

            // 推进变量：士气下降、神魂稳定度下降、脱身难度上升
            instance.morale = Math.max(VARIABLE_BOUNDS.morale.min, (instance.morale || 0) + moraleChange);
            instance.soul_stability = Math.max(VARIABLE_BOUNDS.soul_stability.min, (instance.soul_stability || 0) + soulStabilityChange);
            instance.escape_difficulty = Math.min(
                VARIABLE_BOUNDS.escape_difficulty.max,
                (instance.escape_difficulty || 0) + escapeDifficultyChange
            );

            // 写入本回合的抉择记录（便于审计回放）
            await MultiDungeonChoice.create({
                instance_id: instance.id,
                act_number: finalAct.act_number,
                act_name: finalAct.act_name,
                choice_key: `auto_round_${round}`,
                choice_text: `第 ${round} 回合自动决战（脱身方式：${instance.escape_choice}）`,
                chosen_option: 'auto_advance',
                chosen_by: instance.leader_player_id,
                chosen_at: new Date(),
                morale_change: moraleChange,
                vigilance_change: 0,
                demon_corruption_change: 0,
                seal_stability_change: 0,
                harvest_multiplier_change: 0,
                // 苍坤洞府专属
                forbidden_rift_change: 0,
                scroll_clue_change: 0,
                escape_difficulty_change: escapeDifficultyChange,
                cangkun_guardian_hp_change: `-${actualDamage.toString()}`, // 负值表示削减
                round_number: round,
                eye_key: null
            }, { transaction });

            roundsLog.push({
                round,
                damage: actualDamage.toString(),
                cangkun_guardian_hp_before: oldHp.toString(),
                cangkun_guardian_hp_after: newHp.toString(),
                scroll_clue_after: instance.scroll_clue,
                escape_difficulty_after: instance.escape_difficulty,
                morale_after: instance.morale,
                soul_stability_after: instance.soul_stability
            });

            // 优先检查失败（避免神魂崩溃后还判定通关的边界）
            if (instance.morale <= 0) {
                battleOutcome = 'failed';
                failReason = 'morale_depleted';
                failReasonMessage = `第 ${round} 回合后士气归零，队伍溃散，副本失败`;
                break;
            }
            if (instance.soul_stability <= 0) {
                battleOutcome = 'failed';
                failReason = 'soul_stability_depleted';
                failReasonMessage = `第 ${round} 回合后神魂稳定度归零，神魂崩溃，副本失败`;
                break;
            }

            // 检查通关：苍坤守灵HP归零
            if (newHp === 0n) {
                battleOutcome = 'cleared';
                break;
            }
        }

        // 回合用尽仍未通关
        if (battleOutcome === 'ongoing') {
            battleOutcome = 'failed';
            failReason = 'rounds_exceed';
            failReasonMessage = `${roundsMax} 回合用尽，苍坤守灵HP剩余 ${instance.cangkun_guardian_hp.toString()}，副本失败`;
        }

        await instance.save({ transaction });

        return {
            outcome: battleOutcome,
            fail_reason: failReason,
            fail_reason_message: failReasonMessage,
            rounds_total: roundsLog.length,
            rounds_max: roundsMax,
            rounds_log: roundsLog,
            final_cangkun_guardian_hp: instance.cangkun_guardian_hp.toString(),
            final_scroll_clue: instance.scroll_clue,
            final_forbidden_rift: instance.forbidden_rift,
            final_escape_difficulty: instance.escape_difficulty,
            final_escape_choice: instance.escape_choice,
            final_morale: instance.morale,
            final_soul_stability: instance.soul_stability
        };
    }

    /**
     * 处理血色试炼第四幕【血色尊者决战】自动决战
     *
     * 设计依据：xiuxian_game_guide.md 第11节·副本与组队 + 第20节·副本决策
     *   血色试炼第4幕：幸存者合作对抗血色尊者（HP=1200000）
     *   每回合伤害 = damage_per_round_base + blood_fury × damage_blood_fury_bonus_per_point + survivor_count × damage_survivor_bonus_per_point
     *   每回合全队平均血气 -10（blood_qi_avg_change_per_round，默认-10）
     *   6 回合内削减 Boss HP 至 0 即通关；平均血气归零或回合用尽即失败
     *
     * 差异化机制：
     *   - blood_fury（血怒）：前3幕抉择累积，越高决战伤害越高（0-200）
     *   - survivor_count（幸存人数）：第3幕淘汰后确定，越多决战伤害越高
     *   - 双重压力：高血怒需要献祭血气（前3幕自损），高幸存人数需要保守策略（少淘汰）
     *     → 侵略（高血怒低幸存）vs 共生（低血怒高幸存）的策略平衡
     *
     * 注意：survivor_count 在第3幕淘汰判定后由 _applyXueseElimination 写入 instance
     *
     * @param {Object} instance - 副本实例（blood_fury 与 survivor_count 已预设）
     * @param {Object} finalAct - 第四幕配置（含 rounds_max / damage_per_round_base 等）
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} { outcome, fail_reason, fail_reason_message, rounds_total, rounds_max, rounds_log, final_* }
     */
    static async _processXueseFinalAct(instance, finalAct, transaction) {
        // 初始化血色尊者HP（首次进入第四幕）
        if (!instance.xuese_boss_hp || instance.xuese_boss_hp <= 0) {
            instance.xuese_boss_hp = BigInt(finalAct.xuese_boss_hp_base || 1200000);
        }

        // 确定幸存人数（第3幕淘汰后已写入 instance.survivor_count；兜底查询 member 表）
        let survivorCount = instance.survivor_count || 0;
        if (survivorCount <= 0) {
            const survivors = await MultiDungeonMember.count({
                where: { instance_id: instance.id, is_present: 1, is_eliminated: 0 },
                transaction
            });
            survivorCount = survivors;
            instance.survivor_count = survivorCount;
        }

        const roundsMax = finalAct.rounds_max || 6;
        const damageBase = finalAct.damage_per_round_base || 100000;
        const damageBloodFuryBonus = finalAct.damage_blood_fury_bonus_per_point || 3000;
        const damageSurvivorBonus = finalAct.damage_survivor_bonus_per_point || 20000;
        const bloodQiAvgChange = finalAct.blood_qi_avg_change_per_round || -10;

        const roundsLog = [];
        let battleOutcome = 'ongoing'; // ongoing / cleared / failed
        let failReason = null;
        let failReasonMessage = null;

        for (let round = 1; round <= roundsMax; round++) {
            // 计算本回合伤害：基础 + 血怒加成 + 幸存人数加成
            const bloodFury = instance.blood_fury || 0;
            const damage = BigInt(damageBase + bloodFury * damageBloodFuryBonus + survivorCount * damageSurvivorBonus);
            const oldHp = BigInt(instance.xuese_boss_hp);
            const newHp = oldHp > damage ? (oldHp - damage) : BigInt(0);
            instance.xuese_boss_hp = newHp;
            const actualDamage = oldHp - newHp; // 实际削减量（避免负数）

            // 推进变量：全队平均血气下降
            instance.blood_qi_avg = Math.max(
                VARIABLE_BOUNDS.blood_qi_avg.min,
                (instance.blood_qi_avg || 0) + bloodQiAvgChange
            );

            // 同步下降每个幸存成员的个人血气（与平均血气同步衰减）
            const survivors = await MultiDungeonMember.findAll({
                where: { instance_id: instance.id, is_present: 1, is_eliminated: 0 },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            for (const m of survivors) {
                m.blood_qi = Math.max(
                    VARIABLE_BOUNDS.member_blood_qi.min,
                    (m.blood_qi ?? 100) + bloodQiAvgChange
                );
                await m.save({ transaction });
            }

            // 写入本回合的抉择记录（便于审计回放）
            await MultiDungeonChoice.create({
                instance_id: instance.id,
                act_number: finalAct.act_number,
                act_name: finalAct.act_name,
                choice_key: `auto_round_${round}`,
                choice_text: `第 ${round} 回合自动决战（血怒 ${bloodFury} / 幸存 ${survivorCount}）`,
                chosen_option: 'auto_advance',
                chosen_by: instance.leader_player_id,
                chosen_at: new Date(),
                morale_change: 0,
                vigilance_change: 0,
                demon_corruption_change: 0,
                seal_stability_change: 0,
                harvest_multiplier_change: 0,
                // 血色试炼专属字段
                blood_qi_self_change: 0,
                blood_qi_others_change: 0,
                kill_score_change: 0,
                blood_fury_change: 0,
                round_number: round,
                eye_key: null
            }, { transaction });

            roundsLog.push({
                round,
                damage: actualDamage.toString(),
                xuese_boss_hp_before: oldHp.toString(),
                xuese_boss_hp_after: newHp.toString(),
                blood_fury: bloodFury,
                survivor_count: survivorCount,
                blood_qi_avg_after: instance.blood_qi_avg
            });

            // 优先检查失败：平均血气归零（全队力竭）
            if (instance.blood_qi_avg <= 0) {
                battleOutcome = 'failed';
                failReason = 'blood_qi_avg_depleted';
                failReasonMessage = `第 ${round} 回合后全队平均血气归零，全队力竭，副本失败`;
                break;
            }

            // 检查通关：血色尊者 HP 归零
            if (newHp === 0n) {
                battleOutcome = 'cleared';
                break;
            }
        }

        // 回合用尽仍未通关
        if (battleOutcome === 'ongoing') {
            battleOutcome = 'failed';
            failReason = 'rounds_exceed';
            failReasonMessage = `${roundsMax} 回合用尽，血色尊者 HP 剩余 ${instance.xuese_boss_hp.toString()}，副本失败`;
        }

        await instance.save({ transaction });

        return {
            outcome: battleOutcome,
            fail_reason: failReason,
            fail_reason_message: failReasonMessage,
            rounds_total: roundsLog.length,
            rounds_max: roundsMax,
            rounds_log: roundsLog,
            final_xuese_boss_hp: instance.xuese_boss_hp.toString(),
            final_blood_fury: instance.blood_fury,
            final_survivor_count: survivorCount,
            final_blood_qi_avg: instance.blood_qi_avg,
            final_eliminations: instance.eliminations
        };
    }

    /**
     * 处理坠魔谷第四幕【心魔决战】自动决战
     *
     * 设计依据：xiuxian_game_guide.md 第11节·副本与组队 + 第20节·副本决策
     *   坠魔谷第4幕：未堕魔成员合作对抗心魔Boss（HP=1000000）
     *   每回合伤害 = damage_per_round_base
     *              + (100 - avg_heart_demon) × damage_heart_demon_bonus_per_point
     *              + avg_dao_heart × damage_dao_heart_bonus_per_point
     *   每回合全队平均道心 -5（dao_heart_change_per_round，腐蚀道心）
     *   每回合全队平均心魔 +5（heart_demon_change_per_round，心魔侵蚀）
     *   5 回合内削减 Boss HP 至 0 即通关；道心归0/心魔满100/回合用尽即失败
     *
     * 差异化机制（与血色试炼 PVPvE 淘汰制对比）：
     *   - PVE 协作：未堕魔成员共同对抗心魔Boss，无 PVP 淘汰
     *   - 双向腐蚀：心魔上升 + 道心下降的双重压力（血色试炼只有血气下降单压力）
     *   - 伤害公式：道心越高伤害越高，心魔越低伤害越高（鼓励维持低心魔高道心状态）
     *   - 通关后奖励：道心加成（每点道心+修为+灵石）、完美通关加成（零堕魔）、称号【伏魔者】
     *
     * 注意：堕魔判定在 _applyChoiceEffect 中即时执行；本方法只处理决战回合内的腐蚀
     *
     * @param {Object} instance - 副本实例（avg_heart_demon 与 avg_dao_heart 已预设）
     * @param {Object} finalAct - 第四幕配置（含 rounds_max / damage_per_round_base 等）
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} { outcome, fail_reason, fail_reason_message, rounds_total, rounds_max, rounds_log, final_* }
     */
    static async _processZhuimoFinalAct(instance, finalAct, transaction) {
        // 初始化心魔Boss HP（首次进入第四幕）
        if (!instance.demon_boss_hp || instance.demon_boss_hp <= 0) {
            instance.demon_boss_hp = BigInt(finalAct.demon_boss_hp_base || 1000000);
        }

        // 确定未堕魔人数（用于伤害加成与失败判定）
        let nonFallenCount = await MultiDungeonMember.count({
            where: { instance_id: instance.id, is_present: 1, is_fallen: 0 },
            transaction
        });
        // 边界：全员堕魔则直接失败
        if (nonFallenCount <= 0) {
            return {
                outcome: 'failed',
                fail_reason: 'all_fallen',
                fail_reason_message: `全员已堕魔，无法进入心魔决战，副本失败`,
                rounds_total: 0,
                rounds_max: finalAct.rounds_max || 5,
                rounds_log: [],
                final_demon_boss_hp: instance.demon_boss_hp.toString(),
                final_avg_heart_demon: instance.avg_heart_demon,
                final_avg_dao_heart: instance.avg_dao_heart,
                final_non_fallen_count: 0
            };
        }

        const roundsMax = finalAct.rounds_max || 5;
        const damageBase = finalAct.damage_per_round_base || 80000;
        const damageHeartDemonBonus = finalAct.damage_heart_demon_bonus_per_point || 2000;
        const damageDaoHeartBonus = finalAct.damage_dao_heart_bonus_per_point || 1500;
        const daoHeartChangePerRound = finalAct.dao_heart_change_per_round ?? -5;
        const heartDemonChangePerRound = finalAct.heart_demon_change_per_round ?? 5;

        const roundsLog = [];
        let battleOutcome = 'ongoing'; // ongoing / cleared / failed
        let failReason = null;
        let failReasonMessage = null;

        for (let round = 1; round <= roundsMax; round++) {
            // 计算本回合伤害：
            // - 基础伤害 + (100 - avg_heart_demon) × 心魔加成（心魔越低伤害越高）
            // - + avg_dao_heart × 道心加成（道心越高伤害越高）
            // 设计：鼓励玩家维持低心魔高道心状态，与第1-3幕的护道/守道策略呼应
            const avgHeartDemon = instance.avg_heart_demon || 0;
            const avgDaoHeart = instance.avg_dao_heart || 100;
            const damage = BigInt(damageBase
                + (100 - avgHeartDemon) * damageHeartDemonBonus
                + avgDaoHeart * damageDaoHeartBonus);
            const oldHp = BigInt(instance.demon_boss_hp);
            const newHp = oldHp > damage ? (oldHp - damage) : BigInt(0);
            instance.demon_boss_hp = newHp;
            const actualDamage = oldHp - newHp; // 实际削减量（避免负数）

            // 推进变量：每回合腐蚀道心 -5，侵蚀心魔 +5
            // 设计：双向压力使决战回合数被限制在 5 回合内，避免无限消耗
            instance.avg_dao_heart = Math.max(
                VARIABLE_BOUNDS.avg_dao_heart.min,
                (instance.avg_dao_heart || 100) + daoHeartChangePerRound
            );
            instance.avg_heart_demon = Math.min(
                VARIABLE_BOUNDS.avg_heart_demon.max,
                (instance.avg_heart_demon || 0) + heartDemonChangePerRound
            );

            // 同步腐蚀每个未堕魔成员的道心与心魔（与实例级同步）
            const nonFallenMembers = await MultiDungeonMember.findAll({
                where: { instance_id: instance.id, is_present: 1, is_fallen: 0 },
                transaction,
                lock: transaction.LOCK.UPDATE
            });
            for (const m of nonFallenMembers) {
                m.dao_heart = Math.max(
                    VARIABLE_BOUNDS.member_dao_heart.min,
                    (m.dao_heart ?? 100) + daoHeartChangePerRound
                );
                m.heart_demon = Math.min(
                    VARIABLE_BOUNDS.member_heart_demon.max,
                    (m.heart_demon ?? 0) + heartDemonChangePerRound
                );
                // 决战回合内的堕魔判定（道心归0或心魔满100）
                if (m.dao_heart <= 0 || m.heart_demon >= 100) {
                    m.is_fallen = 1;
                    m.is_present = 0;
                }
                await m.save({ transaction });
            }

            // 写入本回合的抉择记录（便于审计回放）
            await MultiDungeonChoice.create({
                instance_id: instance.id,
                act_number: finalAct.act_number,
                act_name: finalAct.act_name,
                choice_key: `auto_round_${round}`,
                choice_text: `第 ${round} 回合自动决战（心魔 ${avgHeartDemon} / 道心 ${avgDaoHeart} / 未堕魔 ${nonFallenMembers.length}）`,
                chosen_option: 'auto_advance',
                chosen_by: instance.leader_player_id,
                chosen_at: new Date(),
                morale_change: 0,
                vigilance_change: 0,
                demon_corruption_change: 0,
                seal_stability_change: 0,
                harvest_multiplier_change: 0,
                // 坠魔谷专属字段
                heart_demon_self_change: heartDemonChangePerRound,
                heart_demon_others_change: 0,
                heart_demon_others_change_highest: 0,
                dao_heart_self_change: daoHeartChangePerRound,
                dao_heart_others_change: 0,
                round_number: round,
                eye_key: null
            }, { transaction });

            roundsLog.push({
                round,
                damage: actualDamage.toString(),
                demon_boss_hp_before: oldHp.toString(),
                demon_boss_hp_after: newHp.toString(),
                avg_heart_demon_after: instance.avg_heart_demon,
                avg_dao_heart_after: instance.avg_dao_heart,
                non_fallen_count_after: nonFallenMembers.filter(m => !m.is_fallen).length
            });

            // 优先检查失败：道心归0（道心崩溃）
            if (instance.avg_dao_heart <= 0) {
                battleOutcome = 'failed';
                failReason = 'avg_dao_heart_depleted';
                failReasonMessage = `第 ${round} 回合后团队平均道心归零，道心崩溃，副本失败`;
                break;
            }
            // 检查失败：心魔满100（全队堕魔）
            if (instance.avg_heart_demon >= 100) {
                battleOutcome = 'failed';
                failReason = 'avg_heart_demon_overflow';
                failReasonMessage = `第 ${round} 回合后团队平均心魔满100，全队堕魔，副本失败`;
                break;
            }
            // 检查失败：未堕魔成员全部堕魔
            const stillNonFallen = await MultiDungeonMember.count({
                where: { instance_id: instance.id, is_present: 1, is_fallen: 0 },
                transaction
            });
            if (stillNonFallen === 0) {
                battleOutcome = 'failed';
                failReason = 'all_fallen_in_battle';
                failReasonMessage = `第 ${round} 回合后全员已堕魔，无法继续战斗，副本失败`;
                break;
            }

            // 检查通关：心魔Boss HP 归零
            if (newHp === 0n) {
                battleOutcome = 'cleared';
                break;
            }
        }

        // 回合用尽仍未通关
        if (battleOutcome === 'ongoing') {
            battleOutcome = 'failed';
            failReason = 'rounds_exceed';
            failReasonMessage = `${roundsMax} 回合用尽，心魔Boss HP 剩余 ${instance.demon_boss_hp.toString()}，副本失败`;
        }

        await instance.save({ transaction });

        return {
            outcome: battleOutcome,
            fail_reason: failReason,
            fail_reason_message: failReasonMessage,
            rounds_total: roundsLog.length,
            rounds_max: roundsMax,
            rounds_log: roundsLog,
            final_demon_boss_hp: instance.demon_boss_hp.toString(),
            final_avg_heart_demon: instance.avg_heart_demon,
            final_avg_dao_heart: instance.avg_dao_heart,
            final_non_fallen_count: await MultiDungeonMember.count({
                where: { instance_id: instance.id, is_present: 1, is_fallen: 0 },
                transaction
            })
        };
    }

    /**
     * 处理黄龙山第四幕自动决战·黄龙主阵决战
     * 5 回合内打掉黄龙Boss（HP=1500000）通关
     *
     * 每回合逻辑：
     *   1. 玩家攻击削减黄龙Boss HP：
     *      damage = damage_per_round_base + formation_power × damage_formation_power_bonus_per_point
     *             + resonance_count × damage_resonance_bonus_per_count
     *      默认：100000 + formation_power × 3000 + resonance_count × 15000
     *   2. 双向腐蚀：morale -3（士气下降）/ vigilance +5（警戒上升）
     *   3. 写入一条 choice 记录（act_number=4, round_number=1-5）便于审计
     *
     * 失败条件：vigilance >= 100（警戒满） OR morale <= 0（士气归零） OR 5 回合未击败黄龙
     * 通关条件：huanglong_boss_hp <= 0
     *
     * 设计：与坠魔谷（心魔/道心双向腐蚀）差异化
     *   - 坠魔谷：avg_heart_demon +5 / avg_dao_heart -5（心魔道心对立）
     *   - 黄龙山：morale -3 / vigilance +5（士气警戒对立，宗门协同阵法特色）
     *
     * @param {Object} instance - 副本实例（current_act 已推进到第四幕）
     * @param {Object} finalAct - 第四幕配置（含 rounds_max / damage_per_round_base 等）
     * @param {Object} transaction - 事务
     * @returns {Promise<Object>} { outcome: 'cleared'|'failed', rounds_total, rounds_log, fail_reason, fail_reason_message, ... }
     */
    static async _processHuanglongFinalAct(instance, finalAct, transaction) {
        // 初始化黄龙Boss HP（首次进入第四幕）
        if (!instance.huanglong_boss_hp || instance.huanglong_boss_hp <= 0) {
            instance.huanglong_boss_hp = BigInt(finalAct.huanglong_boss_hp_base || 1500000);
        }

        const roundsMax = finalAct.rounds_max || 5;
        const damageBase = finalAct.damage_per_round_base || 100000;
        const damageFormationPowerBonus = finalAct.damage_formation_power_bonus_per_point || 3000;
        const damageResonanceBonus = finalAct.damage_resonance_bonus_per_count || 15000;
        const moraleChangePerRound = finalAct.morale_change_per_round ?? -3;
        const vigilanceChangePerRound = finalAct.vigilance_change_per_round ?? 5;

        const roundsLog = [];
        let battleOutcome = 'ongoing'; // ongoing / cleared / failed
        let failReason = null;
        let failReasonMessage = null;

        for (let round = 1; round <= roundsMax; round++) {
            // 计算本回合伤害：
            // - 基础伤害 + 阵法强度 × 加成（阵法越强伤害越高）
            // - + 共鸣数 × 加成（共鸣越多伤害越高）
            // 设计：鼓励玩家维持高阵法强度和高共鸣数，与第1-3幕的入阵/共鸣策略呼应
            const formationPower = instance.huanglong_formation_power || 0;
            const resonanceCount = instance.huanglong_resonance_count || 0;
            const damage = BigInt(damageBase
                + formationPower * damageFormationPowerBonus
                + resonanceCount * damageResonanceBonus);
            const oldHp = BigInt(instance.huanglong_boss_hp);
            const newHp = oldHp > damage ? (oldHp - damage) : BigInt(0);
            instance.huanglong_boss_hp = newHp;
            const actualDamage = oldHp - newHp; // 实际削减量（避免负数）

            // 推进变量：每回合双向腐蚀
            // - morale -3（士气下降，宗门协同阵法消耗精神）
            // - vigilance +5（警戒上升，黄龙Boss 逐渐警觉）
            // 设计：双向压力使决战回合数被限制在 5 回合内，避免无限消耗
            instance.morale = Math.max(
                VARIABLE_BOUNDS.morale.min,
                (instance.morale || 100) + moraleChangePerRound
            );
            instance.vigilance = Math.min(
                VARIABLE_BOUNDS.vigilance.max,
                (instance.vigilance || 0) + vigilanceChangePerRound
            );

            // 写入本回合的抉择记录（便于审计回放）
            await MultiDungeonChoice.create({
                instance_id: instance.id,
                act_number: finalAct.act_number,
                act_name: finalAct.act_name,
                choice_key: `auto_round_${round}`,
                choice_text: `第 ${round} 回合自动决战（阵法强度 ${formationPower} / 共鸣数 ${resonanceCount} / 士气 ${instance.morale} / 警戒 ${instance.vigilance}）`,
                chosen_option: 'auto_advance',
                chosen_by: instance.leader_player_id,
                chosen_at: new Date(),
                morale_change: moraleChangePerRound,
                vigilance_change: vigilanceChangePerRound,
                demon_corruption_change: 0,
                seal_stability_change: 0,
                harvest_multiplier_change: 0,
                // 黄龙山专属字段（记录决战回合的变量变化）
                huanglong_formation_power_change: 0,
                huanglong_resonance_count_change: 0,
                huanglong_eye_position: null,
                huanglong_contribution_score_self_change: 0,
                huanglong_is_defecting_self: null,
                round_number: round,
                eye_key: null
            }, { transaction });

            roundsLog.push({
                round,
                damage: actualDamage.toString(),
                huanglong_boss_hp_before: oldHp.toString(),
                huanglong_boss_hp_after: newHp.toString(),
                formation_power: formationPower,
                resonance_count: resonanceCount,
                morale_after: instance.morale,
                vigilance_after: instance.vigilance
            });

            // 优先检查失败：警戒满100（黄龙Boss 完全警觉，阵法被破）
            if (instance.vigilance >= 100) {
                battleOutcome = 'failed';
                failReason = 'vigilance_overflow';
                failReasonMessage = `第 ${round} 回合后警戒度满100，黄龙Boss 完全警觉，阵法被破，副本失败`;
                break;
            }
            // 检查失败：士气归零（宗门协同崩溃，无法维持阵法）
            if (instance.morale <= 0) {
                battleOutcome = 'failed';
                failReason = 'morale_depleted';
                failReasonMessage = `第 ${round} 回合后士气归零，宗门协同崩溃，无法维持阵法，副本失败`;
                break;
            }

            // 检查通关：黄龙Boss HP 归零
            if (newHp === 0n) {
                battleOutcome = 'cleared';
                break;
            }
        }

        // 回合用尽仍未通关
        if (battleOutcome === 'ongoing') {
            battleOutcome = 'failed';
            failReason = 'rounds_exceed';
            failReasonMessage = `${roundsMax} 回合用尽，黄龙Boss HP 剩余 ${instance.huanglong_boss_hp.toString()}，副本失败`;
        }

        await instance.save({ transaction });

        return {
            outcome: battleOutcome,
            fail_reason: failReason,
            fail_reason_message: failReasonMessage,
            rounds_total: roundsLog.length,
            rounds_max: roundsMax,
            rounds_log: roundsLog,
            final_huanglong_boss_hp: instance.huanglong_boss_hp.toString(),
            final_formation_power: instance.huanglong_formation_power,
            final_resonance_count: instance.huanglong_resonance_count,
            final_morale: instance.morale,
            final_vigilance: instance.vigilance
        };
    }

    /**
     * 队长手动触发自动决战幕推进
     * 仅在当前幕为 is_auto_advance 时允许调用
     * 用于昆吾山第四幕5回合 / 虚天殿第六幕6回合 / 苍坤洞府第四幕5回合自动战斗的主动触发
     *
     * 2026-07-21 扩展：苍坤洞府需在调用前选择 escape_choice（脱身抉择），影响：
     *   - 决战回合数（forced_breakout +1 / stealth_escape -1 / formation_escape ±0）
     *   - 脱身难度（forced_breakout +30 / formation_escape +10 / stealth_escape +0）
     *   - 门票线索掉率加成（forced_breakout +0% / formation_escape +30% / stealth_escape +50%）
     *
     * @param {number} playerId - 队长玩家ID
     * @param {string} [escapeChoiceKey] - 苍坤洞府脱身抉择键（forced_breakout/formation_escape/stealth_escape），苍坤副本必填
     * @returns {Promise<Object>} { success, message, data }
     */
    static async advance(playerId, escapeChoiceKey) {
        const t = await sequelize.transaction();
        try {
            const instance = await MultiDungeonInstance.findOne({
                where: {
                    leader_player_id: playerId,
                    instance_state: 'active'
                },
                transaction: t,
                lock: t.LOCK.UPDATE
            });
            if (!instance) {
                await t.rollback();
                return { success: false, message: '你不是任何 active 副本的队长，无法推进' };
            }

            const config = configLoader.getConfig('multi_dungeon_data');
            const dungeonCfg = config.dungeons[instance.instance_key];
            const currentAct = dungeonCfg.acts.find(a => a.act_number === instance.current_act);
            if (!currentAct) {
                await t.rollback();
                return { success: false, message: `幕数 ${instance.current_act} 配置不存在` };
            }
            if (!currentAct.is_auto_advance) {
                await t.rollback();
                return {
                    success: false,
                    message: `第 ${instance.current_act} 幕【${currentAct.act_name}】非自动决战幕，无需调用 advance`
                };
            }

            // 2026-07-21 新增：苍坤洞府脱身抉择参数校验与变量预设
            // 苍坤洞府第4幕必须提供 escape_choice，否则拒绝推进
            let escapeChoiceConfig = null;
            if (instance.instance_key === 'cangkun') {
                if (!escapeChoiceKey) {
                    await t.rollback();
                    return {
                        success: false,
                        message: '苍坤洞府第4幕脱身抉择未指定，必须提供 escape_choice（forced_breakout/formation_escape/stealth_escape）',
                        error_code: ErrorCodes.VALIDATION_ERROR
                    };
                }
                escapeChoiceConfig = (currentAct.escape_choices || []).find(c => c.escape_choice === escapeChoiceKey || c.key === escapeChoiceKey);
                if (!escapeChoiceConfig) {
                    await t.rollback();
                    return {
                        success: false,
                        message: `escape_choice ${escapeChoiceKey} 不在可选列表（forced_breakout/formation_escape/stealth_escape）`,
                        error_code: ErrorCodes.VALIDATION_ERROR
                    };
                }
                // 设置 instance.escape_choice 并应用脱身难度变化
                instance.escape_choice = escapeChoiceConfig.escape_choice;
                if (escapeChoiceConfig.escape_difficulty_change) {
                    instance.escape_difficulty = Math.max(
                        VARIABLE_BOUNDS.escape_difficulty.min,
                        Math.min(VARIABLE_BOUNDS.escape_difficulty.max, (instance.escape_difficulty || 0) + escapeChoiceConfig.escape_difficulty_change)
                    );
                }
                // 2026-07-21 新增：脱身抉择审计记录（act_number=4, choice_key=escape_choice_set）
                await MultiDungeonChoice.create({
                    instance_id: instance.id,
                    act_number: currentAct.act_number,
                    act_name: currentAct.act_name,
                    choice_key: 'escape_choice_set',
                    choice_text: `脱身抉择：${escapeChoiceConfig.text}（${escapeChoiceConfig.desc}）`,
                    chosen_option: escapeChoiceConfig.escape_choice,
                    chosen_by: instance.leader_player_id,
                    chosen_at: new Date(),
                    morale_change: 0,
                    vigilance_change: 0,
                    demon_corruption_change: 0,
                    seal_stability_change: 0,
                    harvest_multiplier_change: 0,
                    // 苍坤洞府专属
                    forbidden_rift_change: 0,
                    scroll_clue_change: 0,
                    escape_difficulty_change: escapeChoiceConfig.escape_difficulty_change || 0,
                    cangkun_guardian_hp_change: null,
                    round_number: null,
                    eye_key: null
                }, { transaction: t });
            }

            // 触发自动决战（2026-07-21 扩展：根据 instance_key 分发到对应副本的决战处理器）
            // - kunwu（昆吾山·封魔塔）：_processKunwuFinalAct 处理塔影5回合自动战斗
            // - xutian（虚天殿）：_processXutianFinalAct 处理虚天主魂6回合自动决战
            // - cangkun（苍坤洞府）：_processCangkunFinalAct 处理苍坤守灵5回合自动决战（受 escape_choice 影响）
            // - xuese（血色试炼）：_processXueseFinalAct 处理血色尊者6回合自动决战（受 blood_fury 和幸存人数影响）
            // - zhuimo（坠魔谷）：_processZhuimoFinalAct 处理心魔Boss 5回合自动决战（受 avg_heart_demon 和 avg_dao_heart 影响）
            // - huanglong（黄龙山）：_processHuanglongFinalAct 处理黄龙Boss 5回合自动决战（受 formation_power 和 resonance_count 影响）
            let finalActHandler;
            if (instance.instance_key === 'xutian') {
                finalActHandler = MultiDungeonService._processXutianFinalAct;
            } else if (instance.instance_key === 'cangkun') {
                finalActHandler = MultiDungeonService._processCangkunFinalAct;
            } else if (instance.instance_key === 'xuese') {
                finalActHandler = MultiDungeonService._processXueseFinalAct;
            } else if (instance.instance_key === 'zhuimo') {
                finalActHandler = MultiDungeonService._processZhuimoFinalAct;
            } else if (instance.instance_key === 'huanglong') {
                finalActHandler = MultiDungeonService._processHuanglongFinalAct;
            } else {
                finalActHandler = MultiDungeonService._processKunwuFinalAct;
            }
            const autoBattleResult = await finalActHandler(instance, currentAct, t);

            if (autoBattleResult.outcome === 'cleared') {
                instance.instance_state = 'cleared';
                instance.current_act_state = 'resolved';
                instance.cleared_at = new Date();

                const existingClears = await MultiDungeonInstance.count({
                    where: { instance_key: instance.instance_key, instance_state: 'cleared' },
                    transaction: t
                });
                instance.first_clear = existingClears === 0 ? 1 : 0;
                await instance.save({ transaction: t });

                const rewardsResult = await MultiDungeonService._settleRewards(instance, t);
                await t.commit();

                // 大五行幻世轮：多人副本通关后所有在场成员自动积累悟印（未装备时静默返回）
                try {
                    const presentMembers = await MultiDungeonMember.findAll({ where: { instance_id: instance.id, is_present: 1 } });
                    if (presentMembers && presentMembers.length > 0) {
                        await Promise.all(presentMembers.map(m =>
                            ArtifactDeepLineService.safeAddInsightExp(m.player_id, {
                                battle_type: 'dungeon',
                                is_win: true
                            })
                        ));
                    }
                } catch (e) { /* 悟印积累失败不阻塞主流程 */ }

                MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_cleared', {
                    instance_id: instance.id,
                    cleared_at: instance.cleared_at,
                    first_clear: !!instance.first_clear,
                    auto_battle: autoBattleResult,
                    rewards: rewardsResult.summary
                });

                return {
                    success: true,
                    message: `【决战】通关！${currentAct.clear_condition.clear_message || ''}${instance.first_clear ? '【首通】' : ''}`,
                    data: {
                        instance_id: instance.id,
                        instance_state: 'cleared',
                        cleared_at: instance.cleared_at,
                        first_clear: !!instance.first_clear,
                        final_act: instance.current_act,
                        auto_battle: autoBattleResult,
                        rewards: rewardsResult.summary
                    }
                };
            } else {
                instance.instance_state = 'failed';
                instance.current_act_state = 'failed';
                await instance.save({ transaction: t });
                await MultiDungeonService._applyCooldownToAllMembers(instance, 'failed', t);
                await t.commit();

                MultiDungeonService._notifyInstanceUpdate(instance.id, 'multi_dungeon_failed', {
                    instance_id: instance.id,
                    reason: autoBattleResult.fail_reason_message || '决战失败',
                    reason_code: autoBattleResult.outcome,
                    auto_battle: autoBattleResult,
                    final_act: instance.current_act
                });

                return {
                    success: true,
                    message: `【决战】失败：${autoBattleResult.fail_reason_message}`,
                    data: {
                        instance_id: instance.id,
                        instance_state: 'failed',
                        failed_at: new Date(),
                        final_act: instance.current_act,
                        auto_battle: autoBattleResult
                    }
                };
            }
        } catch (err) {
            if (t && !t.finished) await t.rollback();
            console.error('[MultiDungeonService] advance 异常:', err);
            throw err;
        }
    }

    /**
     * Socket.IO 推送副本进度更新
     * 给所有在场成员推送事件
     * @param {number} instanceId - 副本实例ID
     * @param {string} event - 事件名
     * @param {Object} data - 推送数据
     */
    static async _notifyInstanceUpdate(instanceId, event, data) {
        try {
            const members = await MultiDungeonMember.findAll({
                where: { instance_id: instanceId, is_present: 1 }
            });
            for (const m of members) {
                WebSocketNotificationService.notifyPlayerUpdate(m.player_id, event, {
                    instance_id: instanceId,
                    ...data
                });
            }
        } catch (e) {
            console.warn('[MultiDungeonService] 推送副本更新失败:', e.message);
        }
    }
}

module.exports = MultiDungeonService;
