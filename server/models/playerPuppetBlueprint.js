/**
 * 玩家傀儡图谱模型
 *
 * 存储玩家已参悟的傀儡图谱：
 *   - 图谱key（对应 puppet_data.json 的 blueprints key）
 *   - 对应傀儡类型
 *   - 参悟时间
 *
 * 与 players 表 N:1 关系
 * UNIQUE KEY (player_id, blueprint_key) 防止重复参悟
 *
 * 玩法文档对照：第23节·大衍诀与傀儡路线
 *   "获得傀儡图谱后，用 .参悟图谱 <图谱名> 解锁制造"
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerPuppetBlueprint = sequelize.define('PlayerPuppetBlueprint', {
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
    blueprint_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '图谱key：mechanical_wood_blueprint等'
    },
    blueprint_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '图谱名称'
    },
    puppet_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '对应傀儡类型'
    }
}, {
    tableName: 'player_puppet_blueprints',
    timestamps: true,
    createdAt: 'learned_at',
    updatedAt: false,
    underscored: true,
    indexes: [
        { unique: true, fields: ['player_id', 'blueprint_key'] },
        { fields: ['player_id'] }
    ]
});

module.exports = PlayerPuppetBlueprint;
