/**
 * 宗门外交关系模型
 * 表 sect_diplomacies：两宗一对（sect_a_id < sect_b_id 规范化）
 * 玩法文档对照：xiuxian_game_guide.md 第33节·宗门外交
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SectDiplomacy = sequelize.define('SectDiplomacy', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    sect_a_id: { type: DataTypes.STRING(30), allowNull: false },
    sect_b_id: { type: DataTypes.STRING(30), allowNull: false },
    relation: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'neutral' },
    updated_by: { type: DataTypes.BIGINT, allowNull: true },
    note: { type: DataTypes.STRING(200), allowNull: true }
}, {
    tableName: 'sect_diplomacies',
    timestamps: true,
    underscored: true,
    updatedAt: 'updated_at',
    createdAt: 'created_at',
    indexes: [
        { fields: ['sect_a_id', 'sect_b_id'], name: 'idx_sd_pair', unique: true },
        { fields: ['status'], name: 'idx_sd_status' }
    ]
});

module.exports = SectDiplomacy;
