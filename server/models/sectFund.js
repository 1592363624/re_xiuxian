/**
 * 宗门资金与积分模型
 *
 * 宗门静态数据（名称/宝库/任务）在 sect_data.json，
 * 动态数据（资金/积分/占领数）存此表，按 sect_id 唯一
 *
 * 关键字段：
 *   - fund_balance：宗门资金（灵石），用于宣战/驻防阵法/宗门升级
 *   - war_score：历史总宗门战积分（永久累积，不随赛季重置）
 *   - season_war_score：本赛季宗门战积分（赛季末结算后清零）
 *   - territories_count：当前占领资源点数（实时同步）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SectFund = sequelize.define('SectFund', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    sect_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
        comment: '宗门ID'
    },
    sect_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '宗门名'
    },
    fund_balance: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '宗门资金（灵石）'
    },
    war_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史总宗门战积分'
    },
    season_war_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本赛季宗门战积分'
    },
    territories_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前占领资源点数'
    },
    leader_player_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '宗主玩家ID'
    }
}, {
    tableName: 'sect_funds',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['war_score'] },
        { fields: ['season_war_score'] }
    ]
});

module.exports = SectFund;