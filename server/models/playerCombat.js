/**
 * 玩家战斗记录模型
 * 
 * 存储玩家战斗历史记录
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerCombat = sequelize.define('PlayerCombat', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
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
    battle_result: {
        type: DataTypes.ENUM('win', 'lose', 'flee', 'draw'),
        comment: '战斗结果'
    },
    rounds: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '战斗回合数'
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
    hp_remaining: {
        type: DataTypes.BIGINT,
        comment: '战斗结束时剩余气血'
    },
    rewards_exp: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '获得修为'
    },
    rewards_items: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const rawValue = this.getDataValue('rewards_items');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('rewards_items', JSON.stringify(value));
        },
        comment: '获得物品列表 [{itemId, quantity}]'
    },
    battle_duration: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '战斗持续时间(秒)'
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '战斗时间'
    }
}, {
    tableName: 'player_combats',
    timestamps: true,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['monster_id'] },
        { fields: ['map_id'] },
        { fields: ['battle_result'] },
        { fields: ['created_at'] }
    ]
});

module.exports = PlayerCombat;
