/**
 * 妖兽入侵实例模型
 *
 * 存储妖兽入侵事件的当前状态（HP/阶段/捐献进度/战斗窗口/击杀信息等）
 * 每条记录对应一次妖兽入侵事件，分两阶段：
 *   1. donation（捐献阶段）：玩家捐献物品累积锁灵大阵进度
 *   2. battle（战斗阶段）：达标后开放攻击，玩家可斩妖
 * 事件结束后归档为历史记录（status=defeated/escaped/expired）
 *
 * HP 使用 BIGINT 防止高境界玩家伤害溢出
 *
 * 关键字段说明：
 *   - phase：事件阶段
 *       donation - 捐献阶段（开放捐献物品）
 *       battle   - 战斗阶段（开放攻击妖兽）
 *       ended    - 已结束（被击杀/逃脱/过期）
 *   - status：事件最终状态
 *       active   - 进行中（donation 或 battle）
 *       defeated - 被玩家击杀
 *       escaped  - 战斗阶段结束未被击杀，妖兽逃脱
 *       expired  - 捐献阶段超时未达标，妖兽自行散去
 *   - aggregated_battle_log：聚合战报 JSON，每 aggregation_window_ms 滚动写入
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BeastInvasion = sequelize.define('BeastInvasion', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '妖兽入侵事件ID'
    },
    beast_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '妖兽配置键（如 xuelang_yaoshou/tianhu_yaoshou/kuimu_yaoshou）'
    },
    beast_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '妖兽显示名称'
    },
    realm_rank_min: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '推荐参与最低境界rank'
    },
    hp_max: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1000000,
        comment: '妖兽最大血量'
    },
    hp_current: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1000000,
        comment: '妖兽当前血量'
    },
    atk: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1000,
        comment: '妖兽攻击力'
    },
    def: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 500,
        comment: '妖兽防御力'
    },
    speed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '妖兽速度'
    },
    phase: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'donation',
        comment: '事件阶段：donation/battle/ended'
    },
    donation_target: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '捐献目标值（达到后切换到战斗阶段）'
    },
    donation_current: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前捐献累计值'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '事件状态：active/defeated/escaped/expired'
    },
    start_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '事件开始时间（捐献阶段开始）'
    },
    donation_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '捐献阶段结束时间（达标则提前切换，否则到此时间停止）'
    },
    battle_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '战斗阶段结束时间（未击杀则妖兽逃脱）'
    },
    defeat_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '被击杀时间'
    },
    killer_player_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '最后一击玩家ID'
    },
    killer_nickname: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '最后一击玩家昵称'
    },
    total_damage_taken: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '玩家对妖兽造成的总伤害'
    },
    total_damage_dealt: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '妖兽对玩家造成的总伤害'
    },
    participant_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '参与玩家数（捐献或攻击过）'
    },
    aggregated_battle_log: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
        comment: '聚合战报（每 aggregation_window_ms 滚动写入，含总伤害/HP变化/参与者数）'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '赛季ID（预留，当前默认0）'
    }
}, {
    tableName: 'beast_invasions',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['status'] },
        { fields: ['beast_key', 'season_id'] },
        { fields: ['start_time'] },
        { fields: ['phase'] }
    ]
});

module.exports = BeastInvasion;
