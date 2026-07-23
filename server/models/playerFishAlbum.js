/**
 * 玩家鱼谱图鉴模型
 *
 * 存储玩家已发现的鱼类图鉴记录：
 *   - 鱼类信息（ID/名称/品质）
 *   - 首次钓获时间
 *   - 总钓获次数
 *   - 该鱼类最大重量
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   ".鱼谱 看图鉴"
 *
 * 与 players 表 N:1 关系，与 player_fish_catches 表配合：
 *   新鱼类首次钓获时自动写入图鉴，后续重复钓获更新次数和最大重量
 *
 * 唯一约束：(player_id, fish_id) 确保每个玩家每种鱼只有一条图鉴记录
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerFishAlbum = sequelize.define('PlayerFishAlbum', {
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
    fish_id: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '鱼类ID'
    },
    fish_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '鱼名'
    },
    quality: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '品质'
    },
    total_caught: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '总钓获次数'
    },
    biggest_kg: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: '该鱼类最大重量(kg)'
    }
}, {
    tableName: 'player_fish_album',
    timestamps: true,
    underscored: true,
    createdAt: 'first_caught_at',
    updatedAt: false,
    indexes: [
        { unique: true, fields: ['player_id', 'fish_id'] },
        { fields: ['player_id'] }
    ]
});

module.exports = PlayerFishAlbum;
