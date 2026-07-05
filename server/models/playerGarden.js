/**
 * 玩家药园模型
 *
 * 存储玩家洞府药园中每个地块的种植记录
 * 一个玩家最多9个地块，每个地块可种植一种灵草
 * 种植后需等待成熟时间，成熟后可采收
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerGarden = sequelize.define('PlayerGarden', {
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
    plot_index: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '地块序号（1-9）'
    },
    seed_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '种子ID（对应 cave_data.json 中的 seed_id）'
    },
    produce_item_id: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '成熟后产出的物品ID'
    },
    planted_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '种植时间'
    },
    mature_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '成熟时间'
    },
    status: {
        type: DataTypes.STRING(20),
        defaultValue: 'empty',
        comment: '地块状态：empty空地/planted种植中/mature已成熟'
    },
    base_yield: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '基础产量（种植时记录，避免配置变更影响）'
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '创建时间'
    },
    updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '更新时间'
    }
}, {
    tableName: 'player_gardens',
    timestamps: true,
    indexes: [
        { fields: ['player_id', 'plot_index'], unique: true },
        { fields: ['player_id'] },
        { fields: ['status'] },
        { fields: ['mature_at'] }
    ]
});

module.exports = PlayerGarden;
