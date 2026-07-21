/**
 * 妖兽入侵捐献记录模型
 *
 * 记录玩家在妖兽入侵捐献阶段贡献物品的明细
 * 每条记录对应一次玩家捐献行为（一名玩家可捐献多次）
 *
 * 用于：
 *   1. 实时累计 donation_current 进度（通过 SUM 聚合）
 *   2. 排行榜：按 contribution_value 排序，结算时按档位发放奖励
 *   3. 审计：保留玩家捐献历史便于追溯
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BeastInvasionDonation = sequelize.define('BeastInvasionDonation', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '捐献记录ID'
    },
    invasion_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '妖兽入侵事件ID'
    },
    player_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称（冗余存储便于排行查询）'
    },
    item_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '捐献物品配置键（如 spirit_stone/spirit_herb/monster_core）'
    },
    item_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品显示名称（冗余）'
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次捐献数量'
    },
    contribution_value: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本次捐献获得的贡献值（数量 × 单位贡献率）'
    }
}, {
    tableName: 'beast_invasion_donations',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['invasion_id'] },
        { fields: ['player_id'] },
        { fields: ['invasion_id', 'player_id'] },
        { fields: ['invasion_id', 'contribution_value'] }
    ]
});

module.exports = BeastInvasionDonation;
