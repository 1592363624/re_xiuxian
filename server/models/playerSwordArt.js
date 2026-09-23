/**
 * 玩家剑诀模型
 * 表 player_sword_arts：一人多部剑诀（manual_id 唯一）
 * 玩法文档对照：xiuxian_game_guide.md 第30节·剑诀线
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerSwordArt = sequelize.define('PlayerSwordArt', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false },
    manual_id: { type: DataTypes.STRING(50), allowNull: false },
    insight: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sword_stage: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    active_formation_id: { type: DataTypes.STRING(50), allowNull: true },
    formation_until: { type: DataTypes.DATE, allowNull: true },
    today_comprehend: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    today_refine: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    today_insight: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    today_form: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    count_date: { type: DataTypes.STRING(10), allowNull: true },
    last_comprehend_at: { type: DataTypes.DATE, allowNull: true },
    last_refine_at: { type: DataTypes.DATE, allowNull: true }
}, {
    tableName: 'player_sword_arts',
    timestamps: true,
    underscored: true,
    updatedAt: 'updated_at',
    createdAt: 'created_at',
    indexes: [
        { fields: ['player_id', 'manual_id'], name: 'idx_psa_player_manual', unique: true },
        { fields: ['player_id'], name: 'idx_psa_player' }
    ]
});

module.exports = PlayerSwordArt;
