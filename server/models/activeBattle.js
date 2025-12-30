/**
 * 正在进行的战斗模型
 * 
 * 存储当前正在进行的战斗状态
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ActiveBattle = sequelize.define('ActiveBattle', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '战斗ID'
    },
    battle_uuid: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        comment: '战斗唯一标识'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID',
        unique: 'uk_player_battle'
    },
    monster_id: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '怪物ID'
    },
    monster_name: {
        type: DataTypes.STRING(100),
        comment: '怪物名称'
    },
    monster_data: {
        type: DataTypes.TEXT,
        defaultValue: '{}',
        get() {
            const rawValue = this.getDataValue('monster_data');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('monster_data', JSON.stringify(value));
        },
        comment: '怪物完整数据 JSON'
    },
    map_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '战斗所在地图ID'
    },
    battle_type: {
        type: DataTypes.ENUM('normal', 'boss', 'elite'),
        defaultValue: 'normal',
        comment: '战斗类型'
    },
    round: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '当前回合数'
    },
    turn: {
        type: DataTypes.ENUM('player', 'monster'),
        defaultValue: 'player',
        comment: '当前行动方'
    },
    player_hp: {
        type: DataTypes.BIGINT,
        comment: '玩家当前气血'
    },
    player_mp: {
        type: DataTypes.BIGINT,
        comment: '玩家当前灵力'
    },
    monster_hp: {
        type: DataTypes.BIGINT,
        comment: '怪物当前气血'
    },
    monster_max_hp: {
        type: DataTypes.BIGINT,
        comment: '怪物最大气血'
    },
    damage_dealt: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '造成的总伤害'
    },
    damage_received: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '受到的总伤害'
    },
    battle_log: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('battle_log');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('battle_log', JSON.stringify(value));
        },
        comment: '战斗日志 [{round, attacker, action, damage, hp_change, ...}]'
    },
    is_player_turn: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: '是否轮到玩家行动'
    },
    battle_start_time: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '战斗开始时间'
    },
    last_action_time: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '最后行动时间'
    },
    expires_at: {
        type: DataTypes.DATE,
        comment: '战斗过期时间（超时未操作自动结束）'
    }
}, {
    tableName: 'active_battles',
    timestamps: true,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['battle_uuid'] },
        { fields: ['expires_at'] }
    ]
});

module.exports = ActiveBattle;
