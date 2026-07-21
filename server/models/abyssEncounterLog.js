/**
 * 探渊遭遇日志模型
 *
 * 对应数据库表 abyss_encounter_logs，记录灵兽探渊过程中的每次遭遇事件：
 *   - 基础信息：explore_id / player_id / beast_id / floor
 *   - 遭遇类型：encounter_type（monster怪物/PVP玩家/treasure宝箱/trap陷阱）
 *   - 遭遇详情：encounter_detail（怪物信息/对手信息/宝箱内容/陷阱效果）
 *   - 结果信息：result / hp_after / stamina_after
 *   - 奖励信息：exp_gained / items_gained / spirit_stones_gained / beast_soul_gained
 *   - PVP对手：opponent_player_id / opponent_beast_id / opponent_beast_name
 *
 * 表设计要点：
 *   - append-only 表，只有 created_at，无 updated_at
 *   - encounter_type 索引支撑按类型查询遭遇历史
 *   - explore_id 索引支撑查询某次探渊的所有遭遇
 *   - opponent_player_id 索引支撑查询某玩家的PVP对手历史
 *
 * 关联关系：
 *   - 隶属于 SpiritBeastAbyssExplore（explore_id → spirit_beast_abyss_explores.id）
 *   - 隶属于 Player（player_id → players.id）
 *   - 关联 SpiritBeast（beast_id → spirit_beasts.id）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AbyssEncounterLog = sequelize.define('AbyssEncounterLog', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '日志ID'
    },
    explore_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '关联探渊记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    beast_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '灵兽ID'
    },
    floor: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '遭遇所在层数'
    },
    encounter_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '遭遇类型：monster/PVP/treasure/trap'
    },
    encounter_detail: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '遭遇详情（怪物信息/对手信息/宝箱内容/陷阱效果）',
        get() {
            const val = this.getDataValue('encounter_detail');
            return val || null;
        }
    },
    result: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '遭遇结果：victory/defeat/flee/triggered'
    },
    hp_after: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '遭遇后灵兽HP'
    },
    stamina_after: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '遭遇后体力'
    },
    exp_gained: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '获得经验'
    },
    items_gained: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '获得物品列表',
        get() {
            const val = this.getDataValue('items_gained');
            return val || null;
        }
    },
    spirit_stones_gained: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '获得灵石',
        get() {
            const val = this.getDataValue('spirit_stones_gained');
            return val !== null && val !== undefined ? Number(val) : 0;
        }
    },
    beast_soul_gained: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '获得兽魂'
    },
    opponent_player_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'PVP对手玩家ID'
    },
    opponent_beast_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'PVP对手灵兽ID'
    },
    opponent_beast_name: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'PVP对手灵兽名称'
    }
}, {
    tableName: 'abyss_encounter_logs',
    // append-only 表：只有 created_at，无 updated_at
    timestamps: true,
    updatedAt: false,
    underscored: true,
    indexes: [
        { fields: ['explore_id'], name: 'idx_encounter_explore' },
        { fields: ['player_id'], name: 'idx_encounter_player' },
        { fields: ['encounter_type'], name: 'idx_encounter_type' },
        { fields: ['floor'], name: 'idx_encounter_floor' },
        { fields: ['opponent_player_id'], name: 'idx_encounter_opponent' },
        { fields: ['created_at'], name: 'idx_encounter_created' }
    ]
});

module.exports = AbyssEncounterLog;
