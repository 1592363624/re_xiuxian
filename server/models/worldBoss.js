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
    },
    // ========== 技能系统字段（迁移 0039 新增，2026-07-20） ==========
    // 配置 world_boss_data.json 中每个 BOSS 有 6 种技能（3阶段×2技能）
    // 这些字段存储 BOSS 在战斗中的实时技能状态，BOSS 死亡后随实例归档
    skill_cooldowns: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
        comment: '技能冷却结束时间戳映射 { skill_name: expire_timestamp_ms }'
    },
    active_buffs: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
        comment: 'BOSS 当前激活的 Buff 列表 [{ name, effect, atk_up_percent, lifesteal_percent, immune_control, expire_at }]'
    },
    minions: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: null,
        comment: 'BOSS 召唤的小怪列表 [{ minion_id, name, hp_max, hp_current, atk, def, spawn_time }]'
    },
    // ========== 多行动机制字段（迁移 0053 新增，2026-07-21） ==========
    // 配置 game_balance.json → world_boss.action_system
    // 三大阶段状态值：幡魂（Boss 减伤）/ 魔压（Boss 加攻、玩家受伤）/ 阵势（Boss 全属性加强）
    // 这三个字段会随玩家行动（强攻/破幡/镇魂/护阵）动态变化，BOSS 死亡后随实例归档
    banner_soul: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '幡魂值（0-100，初始100，高时Boss减伤）'
    },
    magic_pressure: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '魔压值（0-100，初始0，高时Boss攻击加强、玩家伤害下降）'
    },
    array_integrity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '阵势值（0-100，初始100，低时Boss全属性加强）'
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
