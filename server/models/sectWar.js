/**
 * 宗门战役模型
 *
 * 每条记录代表一次宗门间战役（攻方 vs 守方）
 * 战役状态机：preparing → announced → active → settled
 *
 * 关键字段：
 *   - war_chest：战争赌注，宣战时由攻方支付，胜方获得
 *   - attacker_score/defender_score：实时得分，决定胜负
 *   - target_territory_id：争夺的资源点ID（NULL 表示纯荣誉战）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SectWar = sequelize.define('SectWar', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '战役ID'
    },
    war_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '战役名称'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '赛季ID'
    },
    attacker_sect_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '进攻方宗门ID'
    },
    attacker_sect_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '进攻方宗门名'
    },
    defender_sect_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '防守方宗门ID'
    },
    defender_sect_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '防守方宗门名'
    },
    target_territory_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '争夺的资源点ID（NULL表示纯荣誉战）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'preparing',
        comment: '状态：preparing/announced/active/settled/cancelled'
    },
    announce_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '宣战时间'
    },
    prepare_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '准备期结束时间'
    },
    active_start_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '交战期开始时间'
    },
    active_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '交战期结束时间'
    },
    settle_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '结算时间'
    },
    winner_sect_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '获胜方宗门ID'
    },
    loser_sect_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '失败方宗门ID'
    },
    attacker_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '攻方得分'
    },
    defender_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '守方得分'
    },
    attacker_kills: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '攻方击杀数'
    },
    defender_kills: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '守方击杀数'
    },
    attacker_participants: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '攻方参战人数'
    },
    defender_participants: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '守方参战人数'
    },
    war_chest: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '战争赌注（灵石）'
    }
}, {
    tableName: 'sect_wars',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['status'] },
        { fields: ['season_id', 'status'] },
        { fields: ['attacker_sect_id', 'defender_sect_id'] }
    ]
});

module.exports = SectWar;