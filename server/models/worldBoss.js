/**
 * 世界BOSS实例模型
 *
 * 存储世界BOSS的当前状态（HP/阶段/状态/刷新时间等）
 * 每个 BOSS 实例对应一次刷新，被击杀或过期后归档为历史记录
 * HP 使用 BIGINT 防止高境界玩家伤害溢出
 *
 * 关键字段说明：
 *   - status：BOSS 生命周期状态
 *       pending  - 已刷新但未激活（等待玩家首次攻击）
 *       active   - 已激活，玩家可攻击
 *       defeated - 已被击杀
 *       expired  - 超过 expire_time 未被击杀，自动消失
 *   - phase：BOSS 阶段（1/2/3），根据 HP 百分比切换
 *   - season_id：所属赛季，赛季结算时用于聚合统计
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const WorldBoss = sequelize.define('WorldBoss', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: 'BOSS实例ID'
    },
    boss_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: 'BOSS配置键（如 qingyuanzi/yaoshou/mulan）'
    },
    boss_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'BOSS显示名称'
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
        comment: 'BOSS最大血量'
    },
    hp_current: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 1000000,
        comment: 'BOSS当前血量'
    },
    atk: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1000,
        comment: 'BOSS攻击力'
    },
    def: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 500,
        comment: 'BOSS防御力'
    },
    speed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: 'BOSS速度'
    },
    phase: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '当前阶段（1/2/3）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'BOSS状态：pending/active/defeated/expired'
    },
    spawn_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '刷新时间'
    },
    active_start_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '激活开始时间（首次被攻击时设置）'
    },
    defeat_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '被击杀时间'
    },
    expire_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '过期时间（未击杀则消失）'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '赛季ID'
    },
    total_damage_dealt: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: 'BOSS对玩家造成的总伤害'
    },
    total_damage_taken: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '玩家对BOSS造成的总伤害'
    },
    participant_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '参与玩家数'
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
    first_kill_server: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否全服首杀（0否1是）'
    }
}, {
    tableName: 'world_bosses',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['status'] },
        { fields: ['spawn_time'] },
        { fields: ['boss_key', 'season_id'] }
    ]
});

module.exports = WorldBoss;
