/**
 * 灵兽探渊记录模型
 *
 * 对应数据库表 spirit_beast_abyss_explores，记录玩家灵兽的探渊状态：
 *   - 基础信息：player_id / beast_id / start_floor / max_floor_reached / duration_hours
 *   - 时间信息：start_time / end_time / actual_end_time
 *   - 状态信息：status / recall_type
 *   - 遭遇统计：pvp_encounters / pvp_wins / pvp_losses / monster_kills / treasures_found / traps_triggered
 *   - 奖励信息：events_snapshot / rewards_snapshot / stamina_used / beast_soul_gained
 *   - 快照信息：beast_snapshot（探渊时灵兽属性快照）
 *
 * 表设计要点：
 *   - status: active探渊中 / recalled已召回 / auto_settled自动结算 / injured受伤返回
 *   - recall_type: manual手动 / auto自动 / early提前 / injured受伤
 *   - beast_snapshot 存储探渊时的灵兽属性，避免后续升级影响历史记录
 *   - (player_id, status) 复合索引支撑查询玩家当前探渊列表
 *   - max_floor_reached 索引支撑排行榜查询
 *
 * 关联关系：
 *   - 隶属于 Player（player_id → players.id）
 *   - 关联 SpiritBeast（beast_id → spirit_beasts.id）
 *   - 关联 AbyssEncounterLog（explore_id → abyss_encounter_logs.explore_id）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpiritBeastAbyssExplore = sequelize.define('SpiritBeastAbyssExplore', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '探渊记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属玩家ID'
    },
    beast_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '灵兽实例ID'
    },
    beast_snapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '探渊时灵兽快照（名称/属性/元素/星级/等级/HP）',
        get() {
            const val = this.getDataValue('beast_snapshot');
            return val || null;
        }
    },
    start_floor: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '起始层数'
    },
    max_floor_reached: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '到达的最深层数'
    },
    duration_hours: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '预计探渊时长（小时）'
    },
    start_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '探渊开始时间'
    },
    end_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '预计探渊结束时间'
    },
    actual_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '实际结束时间（召回/自动结算时填充）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '探渊状态：active探渊中/recalled已召回/auto_settled自动结算/injured受伤返回'
    },
    recall_type: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '召回类型：manual手动/auto自动/early提前/injured受伤'
    },
    events_snapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '遭遇事件快照（PVE/PVP/宝箱/陷阱列表）',
        get() {
            const val = this.getDataValue('events_snapshot');
            return val || null;
        }
    },
    rewards_snapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '奖励快照（物品/灵石/经验/兽魂）',
        get() {
            const val = this.getDataValue('rewards_snapshot');
            return val || null;
        }
    },
    pvp_encounters: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次PVP遭遇次数'
    },
    pvp_wins: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次PVP胜利次数'
    },
    pvp_losses: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次PVP失败次数'
    },
    monster_kills: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次怪物击杀数'
    },
    treasures_found: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次宝箱发现数'
    },
    traps_triggered: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次陷阱触发数'
    },
    stamina_used: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次消耗体力'
    },
    beast_soul_gained: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次获得兽魂'
    }
}, {
    tableName: 'spirit_beast_abyss_explores',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id'], name: 'idx_abyss_player' },
        { fields: ['beast_id'], name: 'idx_abyss_beast' },
        { fields: ['status'], name: 'idx_abyss_status' },
        { fields: ['end_time'], name: 'idx_abyss_end_time' },
        { fields: ['player_id', 'status'], name: 'idx_abyss_player_status' },
        { fields: ['max_floor_reached'], name: 'idx_abyss_max_floor' }
    ]
});

module.exports = SpiritBeastAbyssExplore;
