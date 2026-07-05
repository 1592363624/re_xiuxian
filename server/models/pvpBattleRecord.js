/**
 * PVP 斗法战斗记录模型
 *
 * 存储玩家间斗法的完整战斗日志、奖励、因果值变化等
 * 每条记录对应一次 PVP 战斗，含攻击方/防守方、胜负、回合数、奖励等
 * battle_log 字段以 JSON 字符串存储详细战斗回合数据
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PvpBattleRecord = sequelize.define('PvpBattleRecord', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    attacker_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '攻击方玩家ID'
    },
    defender_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '防守方玩家ID'
    },
    battle_type: {
        type: DataTypes.STRING(20),
        defaultValue: 'normal',
        comment: '战斗类型：normal/match/bounty'
    },
    winner_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '胜利方玩家ID（NULL表示平局）'
    },
    total_rounds: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '总回合数'
    },
    attacker_score_change: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '攻击方段位分变化'
    },
    defender_score_change: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '防守方段位分变化'
    },
    attacker_honor_gain: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '攻击方荣誉值收益'
    },
    defender_honor_gain: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '防守方荣誉值收益'
    },
    spirit_stone_reward: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '灵石奖励'
    },
    drop_item_key: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '掉落物品key'
    },
    drop_item_quantity: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '掉落数量'
    },
    karma_change: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '因果值变化（跨境界欺凌增加）'
    },
    battle_log: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '战斗日志JSON'
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'finished',
        comment: '状态：ongoing/finished/cancelled'
    },
    started_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '战斗开始时间'
    },
    finished_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '战斗结束时间'
    }
}, {
    tableName: 'pvp_battle_records',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['attacker_id', 'created_at'] },
        { fields: ['defender_id', 'created_at'] },
        { fields: ['status', 'started_at'] }
    ]
});

module.exports = PvpBattleRecord;
