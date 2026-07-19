/**
 * 玩家阵法学习记录模型
 *
 * 数据表：player_formations
 * 用途：存储玩家已学习的阵法及熟练度（每个阵法一条记录）
 *
 * 字段说明：
 *   - player_id：玩家ID
 *   - formation_id：阵法ID（对应 formation_data.json 中的 id）
 *   - proficiency：熟练度（0-1000，每次成功布阵 +1，每 100 点 +5% 效果）
 *   - learned_at：学习时间
 *
 * 约束：
 *   - (player_id, formation_id) 唯一索引，避免重复学习
 *
 * 关联：
 *   - 属于 Player（player_id 外键）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerFormation = sequelize.define('PlayerFormation', {
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
    formation_id: {
        type: DataTypes.STRING(40),
        allowNull: false,
        comment: '阵法ID（对应 formation_data.json 中的 id）'
    },
    proficiency: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '阵法熟练度（0-1000，每次成功布阵 +1）'
    },
    learned_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '学习时间'
    }
}, {
    tableName: 'player_formations',
    timestamps: true,
    createdAt: 'learned_at',
    updatedAt: false,
    indexes: [
        {
            name: 'uk_player_formation',
            unique: true,
            fields: ['player_id', 'formation_id']
        },
        {
            name: 'idx_player_formations',
            fields: ['player_id']
        }
    ]
});

module.exports = PlayerFormation;
