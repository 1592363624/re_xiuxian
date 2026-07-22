/**
 * 多人副本抉择记录模型
 *
 * 对应数据库表 multi_dungeon_choice，记录每幕抉择的完整审计信息：
 *   - 关联字段：instance_id / act_number / act_name
 *   - 抉择内容：choice_key / choice_text / chosen_option / chosen_by（队长）
 *   - 变量变化：morale_change / vigilance_change / demon_corruption_change / seal_stability_change
 *   - 倍率变化：harvest_multiplier_change
 *
 * 表设计要点：
 *   - 索引 idx_mdc_instance_act 支持（实例, 幕数）查询某幕抉择
 *   - 索引 idx_mdc_chosen_by 支持按抉择人审计
 *   - 每次抉择插入一条新记录，不更新历史，便于回放与审计
 *
 * 关联关系：
 *   - belongsTo MultiDungeonInstance
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MultiDungeonChoice = sequelize.define('MultiDungeonChoice', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    instance_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '副本实例ID'
    },
    act_number: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '幕数（1-6）'
    },
    act_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '幕名（如「潜踪」「婚仪」）'
    },
    choice_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '抉择键（如 stealth_open_distraction）'
    },
    choice_text: {
        type: DataTypes.STRING(200),
        allowNull: false,
        comment: '抉择描述'
    },
    chosen_option: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '选定选项'
    },
    chosen_by: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '抉择人ID（队长）'
    },
    chosen_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '抉择时间'
    },
    morale_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '士气变化'
    },
    vigilance_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '警戒变化'
    },
    demon_corruption_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '魔染变化'
    },
    seal_stability_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '封印变化'
    },
    harvest_multiplier_change: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
        comment: '收获倍率变化'
    },
    // 昆吾山·封魔塔专属变量变化（2026-07-21 新增，migration_0050）
    demonic_qi_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '魔气变化（昆吾山专用）'
    },
    mountain_seal_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '山禁变化（昆吾山专用）'
    },
    treasure_pressure_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '宝压变化（昆吾山专用）'
    },
    linglong_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '玲珑变化（昆吾山专用）'
    },
    seal_progress_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '封印推进变化（昆吾山第四幕专用）'
    },
    tower_shadow_hp_change: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '塔心魔影HP变化（昆吾山第四幕专用，负值表示削减）'
    },
    round_number: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '第四幕自动战斗回合数（1-5，仅第四幕有值）'
    },
    eye_key: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '第三幕阵眼键（baling_eye/dragon_eye/blackwind_eye）'
    },
    // 虚天殿专属变量变化（2026-07-21 新增，migration_0051）
    // path_choice_change：道路选择变化（直接设置而非累加，仅第一幕有值）
    path_choice_change: {
        type: DataTypes.TINYINT,
        allowNull: true,
        comment: '道路选择变化（虚天殿第一幕专用，直接设置 1=冰道/2=火道）'
    },
    // formation_power_change：阵法强度变化（累加）
    formation_power_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '阵法强度变化（虚天殿专用，累加）'
    },
    // void_soul_hp_change：虚天主魂HP变化（第六幕自动决战回合记录用，负值表示削减）
    void_soul_hp_change: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '虚天主魂HP变化（虚天殿第六幕专用，负值表示削减）'
    },
    // 小极宫专属变量变化（2026-07-21 新增，migration_0054）
    // curse_disorder_change：咒扰变化（累加，第1幕起累积）
    curse_disorder_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '咒扰变化（小极宫专用，累加）'
    },
    // ice_seal_power_change：冰封之力变化（累加，第4幕需达到 100 通关）
    ice_seal_power_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '冰封之力变化（小极宫专用，累加）'
    },
    // flame_power_change：火焰之力变化（累加，第2幕机关机制）
    flame_power_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '火焰之力变化（小极宫专用，累加）'
    },
    // yinluo_banner_qi_change：阴罗幡煞气变化（负值表示消耗，第3幕阴幡镇魂专用）
    yinluo_banner_qi_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '阴罗幡煞气变化（小极宫专用，负值表示消耗）'
    },
    // 落云秘圃专属变量变化（2026-07-21 新增，migration_0055）
    // spirit_vein_power_change：灵脉之力变化（累加，第1幕破禁入圃使用）
    spirit_vein_power_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '灵脉之力变化（落云秘圃专用，累加）'
    },
    // root_stability_change：根脉稳定变化（累加，影响第3幕通关判定）
    root_stability_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '根脉稳定变化（落云秘圃专用，累加）'
    },
    // branch_vigor_change：枝桠活力变化（累加，影响灵眼树胚掉落）
    branch_vigor_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '枝桠活力变化（落云秘圃专用，累加）'
    },
    // spirit_plant_aura_change：灵植灵气变化（累加，影响最终奖励）
    spirit_plant_aura_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '灵植灵气变化（落云秘圃专用，累加）'
    },
    // 苍坤洞府专属变量变化（2026-07-21 新增，migration_0057）
    // forbidden_rift_change：禁制裂隙变化（累加，第1幕强破禁制/第3幕破禁使用）
    forbidden_rift_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '禁制裂隙变化（苍坤洞府专用，累加）'
    },
    // scroll_clue_change：卷轴线索变化（累加，第2幕搜寻宝物使用）
    scroll_clue_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '卷轴线索变化（苍坤洞府专用，累加）'
    },
    // escape_difficulty_change：脱身难度变化（累加，第4幕自动决战回合记录用）
    escape_difficulty_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '脱身难度变化（苍坤洞府专用，累加）'
    },
    // cangkun_guardian_hp_change：苍坤守灵HP变化（第4幕自动决战回合记录用，负值表示削减）
    cangkun_guardian_hp_change: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '苍坤守灵HP变化（苍坤洞府第4幕专用，负值表示削减）'
    },
    // 血色试炼专属变量变化（2026-07-21 新增，migration_0058）
    // blood_qi_self_change：自身血气变化（可为负，正值表示回复自身血气）
    blood_qi_self_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '自身血气变化（血色试炼专用，可为负）'
    },
    // blood_qi_others_change：他人血气变化（可为负，对其他在场幸存成员造成血气伤害）
    blood_qi_others_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '他人血气变化（血色试炼专用，对其他成员造成伤害，可为负）'
    },
    // kill_score_change：杀戮分变化（可为负，影响最终奖励结算）
    kill_score_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '杀戮分变化（血色试炼专用，可为负）'
    },
    // blood_fury_change：血怒变化（累加到 instance.blood_fury，第4幕决战伤害加成）
    blood_fury_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '血怒变化（血色试炼专用，累加到 instance.blood_fury）'
    },
    // 坠魔谷专属变量变化（2026-07-21 新增，migration_0059）
    // heart_demon_self_change：自身心魔变化（可为负，负值表示降低心魔）
    heart_demon_self_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '自身心魔变化（坠魔谷专用，可为负）'
    },
    // heart_demon_others_change：他人心魔变化（可为负，影响其他在场未堕魔成员）
    //   - 试道抉择使用正值增加他人心魔，护道抉择使用负值降低他人心魔
    heart_demon_others_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '他人心魔变化（坠魔谷专用，影响其他成员，可为负）'
    },
    // heart_demon_others_change_highest：心魔最高者心魔变化（特殊：仅影响心魔最高的队员）
    //   - 护道专用，避免对所有人加心魔的副作用，精准拯救濒临堕魔的队友
    heart_demon_others_change_highest: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '心魔最高者心魔变化（坠魔谷专用，仅影响心魔最高的队员，护道专用）'
    },
    // dao_heart_self_change：自身道心变化（可为负，负值表示降低道心）
    dao_heart_self_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '自身道心变化（坠魔谷专用，可为负）'
    },
    // dao_heart_others_change：他人道心变化（可为正，提升他人道心）
    dao_heart_others_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '他人道心变化（坠魔谷专用，可为正）'
    },
    // 黄龙山专属变量变化（2026-07-21 新增，migration_0060）
    // huanglong_formation_power_change：阵法强度变化（累加到 instance.huanglong_formation_power）
    //   - 注意：与虚天殿 formation_power_change 区分，黄龙山独立使用 huanglong_formation_power_change
    huanglong_formation_power_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '阵法强度变化（黄龙山专用，累加）'
    },
    // huanglong_resonance_count_change：共鸣数变化（累加到 instance.huanglong_resonance_count）
    //   - 相同阵眼≥2人触发共鸣，第1幕入阵和第3幕阵法共鸣抉择可累加
    huanglong_resonance_count_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '共鸣数变化（黄龙山专用，累加）'
    },
    // huanglong_eye_position：阵眼位置（直接设置，记录抉择时的阵眼选择）
    //   - 取值：forward前阵 / center中阵 / rear后阵 / left左阵 / right右阵
    //   - 与昆吾山 eye_key 区分：昆吾山记录阵眼类型（baling_eye/dragon_eye/blackwind_eye）
    //     黄龙山记录阵眼位置（forward/center/rear/left/right）
    huanglong_eye_position: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '阵眼位置（黄龙山专用，forward/center/rear/left/right）'
    },
    // huanglong_contribution_score_self_change：自身贡献分变化（可为负）
    //   - 正常抉择获得基础贡献分，叛道抉择获得双倍贡献分但放弃共鸣
    //   - 影响最终奖励分配权重和宗门贡献奖励加成
    huanglong_contribution_score_self_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '自身贡献分变化（黄龙山专用，可为负，叛道双倍）'
    },
    // huanglong_is_defecting_self：是否叛道（直接设置 0/1，仅第3幕叛道抉择有值）
    //   - 叛道后成员 huanglong_is_defecting 置 1，不再参与共鸣但获得双倍贡献分
    //   - 影响完美通关判定（perfect_clear_no_defect=true 时全员未叛道才完美通关）
    huanglong_is_defecting_self: {
        type: DataTypes.TINYINT,
        allowNull: true,
        comment: '是否叛道（黄龙山专用，直接设置 0/1，第3幕叛道抉择用）'
    }
}, {
    tableName: 'multi_dungeon_choice',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['instance_id', 'act_number'], name: 'idx_mdc_instance_act' },
        { fields: ['chosen_by'], name: 'idx_mdc_chosen_by' }
    ]
});

module.exports = MultiDungeonChoice;
