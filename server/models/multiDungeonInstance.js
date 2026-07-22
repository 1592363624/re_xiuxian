/**
 * 多人副本实例模型
 *
 * 对应数据库表 multi_dungeon_instance，记录一个多人副本的完整生命周期：
 *   - 实例基础信息：instance_key（yanyue/duanwu）、leader_player_id、member_count
 *   - 状态机字段：instance_state（preparing/active/cleared/failed/dissolved）
 *   - 进度字段：current_act（当前幕数）、current_act_state（幕状态）
 *   - 副本变量：morale（士气）/ vigilance（警戒）/ demon_corruption（魔染）/ seal_stability（封印）/ soul_stability（神魂）
 *   - 奖励字段：harvest_multiplier（收获倍率）、first_clear（首通标志）
 *   - 时间字段：started_at / cleared_at / dissolved_at / expire_at / cooldown_until
 *
 * 表设计要点：
 *   - 4 个索引覆盖常见查询：state / leader / (key, state) / expire
 *   - 变量字段使用 INT，便于事务内原子加减
 *   - harvest_multiplier 使用 FLOAT，受抉择累加影响
 *
 * 关联关系：
 *   - hasMany MultiDungeonMember（一个实例多个成员）
 *   - hasMany MultiDungeonChoice（一个实例多幕抉择）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MultiDungeonInstance = sequelize.define('MultiDungeonInstance', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '副本实例ID'
    },
    instance_key: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '副本配置键：yanyue/duanwu'
    },
    instance_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '副本显示名'
    },
    leader_player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '队长玩家ID'
    },
    leader_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '队长昵称（冗余）'
    },
    current_act: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '当前幕数（掩月1-6，端午1-4）'
    },
    current_act_state: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: '当前幕状态：pending/active/resolved/failed'
    },
    instance_state: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'preparing',
        comment: '副本状态：preparing/active/cleared/failed/dissolved'
    },
    member_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前成员数'
    },
    member_max: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '成员上限（掩月5，端午10）'
    },
    member_min: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '成员下限（掩月3，端午10）'
    },
    consume_item_key: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '消耗物品键（掩月=hongling_wedding_invitation）'
    },
    consume_item_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '消耗数量'
    },
    morale: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '队伍士气（0-100，影响战斗）'
    },
    vigilance: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '敌方警戒度（0-100，越高越难）'
    },
    demon_corruption: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '魔染值（血魔剑相关，0-100）'
    },
    seal_stability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '封印稳定度（端午用，0-100）'
    },
    soul_stability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '神魂稳定度（0-100）'
    },
    // 昆吾山·封魔塔专属变量（2026-07-21 新增）
    // 复用 seal_stability 作为"封印"变量（初始 50，越高越容易镇塔）
    // 复用 morale 作为"士气"变量（初始 100，归零会失败）
    demonic_qi: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '昆吾山·魔气值（0-100，>=100 副本失败，初始0）'
    },
    mountain_seal: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 30,
        comment: '昆吾山·山禁值（0-100，影响推进压力，初始30）'
    },
    treasure_pressure: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '昆吾山·宝压值（0-100，夺宝反噬与爆发收益，初始0）'
    },
    linglong: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
        comment: '昆吾山·玲珑值（0-100，塔影线索与神念清明，初始50）'
    },
    // 第四幕封魔塔决战：塔心魔影 HP（初始1000000，玩家攻击削减）
    tower_shadow_hp: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '昆吾山·塔心魔影HP（第四幕使用，null=未进入第四幕）'
    },
    // 第四幕封印推进值（初始=seal_stability，需推进到80+通关）
    seal_progress: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '昆吾山·封印推进值（第四幕使用，需>=80通关）'
    },
    // 虚天殿专属变量（2026-07-21 新增，migration_0051）
    // path_choice：道路选择（0=未选 / 1=冰道 / 2=火道），影响后续变量变化与第六幕决战加成
    path_choice: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '虚天殿·道路选择（0=未选 / 1=冰道 / 2=火道）'
    },
    // formation_power：阵法强度（0-100），影响第六幕决战伤害与通关条件（需≥70）
    formation_power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 30,
        comment: '虚天殿·阵法强度（0-100，影响决战伤害与通关）'
    },
    // void_soul_hp：虚天主魂HP（初始1500000，null=未进入第六幕）
    void_soul_hp: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '虚天殿·虚天主魂HP（第六幕使用，null=未进入第六幕）'
    },
    // 小极宫专属变量（2026-07-21 新增，migration_0054）
    // curse_disorder：咒扰值（0-100），高时全员受伤，第1幕起累积，影响完美通关判定
    curse_disorder: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '小极宫·咒扰值（0-100，高时全员受伤）'
    },
    // ice_seal_power：冰封之力（0-100），第4幕需达到 100 才通关
    ice_seal_power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
        comment: '小极宫·冰封之力（0-100，第4幕需达到100通关）'
    },
    // flame_power：火焰之力（0-100），第2幕机关机制，与冰封之力相互克制
    flame_power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '小极宫·火焰之力（0-100，第2幕机关机制）'
    },
    // yinluo_banner_qi：阴罗幡煞气（队伍总煞气），第3幕阴幡镇魂消耗 ≥50
    yinluo_banner_qi: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '小极宫·阴罗幡煞气（队伍总煞气，第3幕消耗）'
    },
    // 落云秘圃专属变量（2026-07-21 新增，migration_0055）
    // spirit_vein_power：灵脉之力（0-100），影响灵植生长
    spirit_vein_power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '落云秘圃·灵脉之力（0-100，影响灵植生长）'
    },
    // root_stability：根脉稳定（0-100），第3幕需≥50才不致失败
    root_stability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '落云秘圃·根脉稳定（0-100，第3幕需≥50才不致失败）'
    },
    // branch_vigor：枝桠活力（0-100），影响灵眼树胚掉落
    branch_vigor: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '落云秘圃·枝桠活力（0-100，影响灵眼树胚掉落）'
    },
    // spirit_plant_aura：灵植灵气（0-100），影响最终奖励
    spirit_plant_aura: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '落云秘圃·灵植灵气（0-100，影响最终奖励）'
    },
    // act3_choice：第3幕抉择键（cut_seal/branch_care/balanced_harvest），用于灵眼树胚掉落判定
    act3_choice: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '落云秘圃·第3幕抉择键（用于灵眼树胚掉落判定）'
    },
    // 苍坤洞府专属变量（2026-07-21 新增，migration_0057）
    // forbidden_rift：禁制裂隙（0-100），苍坤旧禁被破开的程度，影响门票线索掉率与脱身难度
    //   - 由第1幕强破禁制/第3幕破禁抉择累加，越高越危险但门票线索掉率越高
    forbidden_rift: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '苍坤洞府·禁制裂隙（0-100，影响门票线索掉率与脱身难度）'
    },
    // scroll_clue：卷轴线索（0-100），千机残篇线索累积度
    //   - 由第2幕搜寻宝物抉择累加，影响门票线索掉率与首通奖励加成
    scroll_clue: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '苍坤洞府·卷轴线索（0-100，千机残篇线索累积度）'
    },
    // escape_difficulty：脱身难度（0-100），第4幕自动决战中累积
    //   - 越高决战回合数越长，但门票线索掉率额外加成
    escape_difficulty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 30,
        comment: '苍坤洞府·脱身难度（0-100，影响决战回合数与门票掉率）'
    },
    // escape_choice：第4幕脱身抉择键（forced_breakout/formation_escape/stealth_escape），用于门票线索掉率加成
    escape_choice: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '苍坤洞府·第4幕脱身抉择键（forced_breakout/formation_escape/stealth_escape）'
    },
    // cangkun_guardian_hp：苍坤守灵 HP（第4幕自动决战使用，null=未进入第4幕）
    cangkun_guardian_hp: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '苍坤洞府·守灵HP（第4幕自动决战使用，null=未进入第4幕）'
    },
    // 血色试炼专属变量（2026-07-21 新增，migration_0058）
    // blood_qi_avg：团队平均血气（0-100），第1幕起每幕由各成员血气取平均
    //   - 第4幕决战中每回合 -10，归零即团灭失败
    blood_qi_avg: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '血色试炼·团队平均血气（0-100，第4幕决战每回合-10，归零团灭）'
    },
    // blood_fury：血怒（0-200），第1-3幕抉择累加，第4幕决战伤害加成（每点 +3000 伤害）
    blood_fury: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '血色试炼·血怒（0-200，第4幕决战伤害加成）'
    },
    // eliminations：累计淘汰人数（前3幕每幕最多淘汰1人，最多淘汰2人）
    eliminations: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '血色试炼·累计淘汰人数（前3幕每幕最多淘汰1人）'
    },
    // survivor_count：最终幸存人数（进入第4幕决战的人数，影响决战伤害与奖励）
    survivor_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '血色试炼·最终幸存人数（进入第4幕决战的人数）'
    },
    // xuese_boss_hp：血色尊者 HP（第4幕自动决战用，初始1200000，null=未进入第4幕）
    xuese_boss_hp: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '血色试炼·血色尊者HP（第4幕自动决战用，初始1200000）'
    },
    // 坠魔谷专属变量（2026-07-21 新增，migration_0059）
    // avg_heart_demon：团队平均心魔（0-100），由各成员 heart_demon 取平均
    //   - 第1-3幕抉择累加，第4幕决战中每回合 +5，满100团灭失败
    avg_heart_demon: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '坠魔谷·团队平均心魔（0-100，第4幕决战每回合+5，满100团灭）'
    },
    // avg_dao_heart：团队平均道心（0-100），由各成员 dao_heart 取平均
    //   - 第1-3幕抉择累加，第4幕决战中每回合 -5，归0团灭失败
    avg_dao_heart: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '坠魔谷·团队平均道心（0-100，第4幕决战每回合-5，归0团灭）'
    },
    // demon_boss_hp：心魔Boss HP（第4幕自动决战用，初始1000000，null=未进入第4幕）
    demon_boss_hp: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '坠魔谷·心魔Boss HP（第4幕自动决战用，初始1000000）'
    },
    // 黄龙山专属变量（2026-07-21 新增，migration_0060）
    // huanglong_formation_power：阵法强度（0-200），第1幕起由阵眼选择与共鸣累加
    //   - 影响第4幕决战伤害（每点 +3000）和称号奖励阈值（≥120 才有 30% 几率给称号）
    //   - 注意：与虚天殿 formation_power 区分，黄龙山独立使用 huanglong_formation_power
    huanglong_formation_power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '黄龙山·阵法强度（0-200，影响决战伤害与称号奖励）'
    },
    // huanglong_resonance_count：共鸣数（0-5），第1/3幕相同阵眼≥2人触发共鸣累加
    //   - 影响第4幕决战伤害（每点 +15000）和完美通关判定（共鸣数=5且无叛道）
    huanglong_resonance_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '黄龙山·共鸣数（0-5，相同阵眼≥2人触发，影响决战伤害与完美通关）'
    },
    // huanglong_boss_hp：黄龙Boss HP（第4幕自动决战用，初始1500000，null=未进入第4幕）
    //   - 决战伤害公式：damage = 100000 + formation_power × 3000 + resonance_count × 15000
    //   - 双向腐蚀：每回合 morale -3 / vigilance +5（vigilance 满100即失败）
    huanglong_boss_hp: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '黄龙山·黄龙Boss HP（第4幕自动决战用，初始1500000）'
    },
    harvest_multiplier: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1.0,
        comment: '收获倍率（受抉择影响）'
    },
    first_clear: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否首通（0否1是）'
    },
    started_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '开打时间'
    },
    cleared_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '通关时间'
    },
    dissolved_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '解散时间'
    },
    expire_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '副本过期时间'
    },
    cooldown_hours: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '通关后冷却小时数'
    },
    cooldown_until: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '全员冷却到期时间'
    }
}, {
    tableName: 'multi_dungeon_instance',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['instance_state'], name: 'idx_mdi_state' },
        { fields: ['leader_player_id'], name: 'idx_mdi_leader' },
        { fields: ['instance_key', 'instance_state'], name: 'idx_mdi_key_state' },
        { fields: ['expire_at'], name: 'idx_mdi_expire' }
    ]
});

module.exports = MultiDungeonInstance;
