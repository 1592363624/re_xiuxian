/**
 * 玩家傀儡模型
 *
 * 存储玩家持有的傀儡数据：
 *   - 傀儡类型（5种：机关木傀/铁甲战傀/五行灵傀/影傀/大衍灵傀）
 *   - 等级与耐久度（淬炼提升等级，维修恢复耐久）
 *   - 战斗属性（ATK/DEF/HP/SPEED，含等级加成）
 *   - 状态（idle闲置/battle出战/guard护法）
 *
 * 与 players 表 N:1 关系（一个玩家最多持有 max_puppets 个傀儡）
 * 同时只有 1 个出战 + 1 个护法
 *
 * 玩法文档对照：第23节·大衍诀与傀儡路线
 *
 * 关键字段说明：
 *   - puppet_type：傀儡类型，对应 puppet_data.json 的 puppet_types key
 *   - status：idle=闲置 / battle=出战（参与PVP/PVE战斗加成） / guard=护法（闭关时自动反击）
 *   - atk/def/hp/speed：当前属性（base_stats × (1 + (level-1) × growth_rate)）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerPuppet = sequelize.define('PlayerPuppet', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    puppet_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '傀儡类型：mechanical_wood/iron_armor/five_element/shadow/dayan_spirit'
    },
    name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '傀儡名称'
    },
    level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '傀儡等级（1-20）'
    },
    exp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前经验（预留，淬炼暂用等级直接提升）'
    },
    durability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '当前耐久度'
    },
    max_durability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '最大耐久度'
    },
    atk: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '攻击力（含等级加成）'
    },
    def: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '防御力（含等级加成）'
    },
    hp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '生命值（含等级加成）'
    },
    speed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '速度（含等级加成）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'idle',
        comment: '状态：idle闲置/battle出战/guard护法'
    }
}, {
    tableName: 'player_puppets',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['status'] },
        { fields: ['puppet_type'] }
    ]
});

module.exports = PlayerPuppet;
