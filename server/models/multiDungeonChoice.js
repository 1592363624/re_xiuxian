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
