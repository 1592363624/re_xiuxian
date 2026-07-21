/**
 * 临战刻印记录模型
 *
 * 对应数据库表 border_war_imprints
 * 记录玩家给法宝施加的临战刻印（一次性，当日匹配路线自动触发）
 *
 * 业务流程：
 *   1. 玩家调用 .临战刻印 <法宝名> <破灯/护阵/潜行> → 消耗材料，写入刻印记录
 *   2. 玩家调用 .支援慕兰 <路线> → 系统检查是否有匹配刻印，若有则自动触发加成
 *   3. 刻印过期后（24小时）自动失效，不可再次使用
 *
 * 字段说明见 migration_0041_border_military_tables.js
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BorderWarImprint = sequelize.define('BorderWarImprint', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false, comment: '玩家ID' },
    artifact_id: { type: DataTypes.BIGINT, allowNull: false, comment: '法宝ID（玩家装备实例ID）' },
    artifact_name: { type: DataTypes.STRING(128), allowNull: false, comment: '法宝名称快照' },
    imprint_type: {
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '刻印类型：lamp_breaker(破灯)/array_guard(护阵)/scout_stealth(潜行)'
    },
    matched_route: { type: DataTypes.STRING(64), allowNull: false, comment: '匹配路线（单路线或多路线逗号分隔）' },
    bonus_rate: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0, comment: '加成比例' },
    materials_consumed: { type: DataTypes.TEXT, allowNull: false, comment: '消耗材料JSON' },
    triggered: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否已触发' },
    triggered_at: { type: DataTypes.DATE, allowNull: true, comment: '触发时间' },
    trigger_route: { type: DataTypes.STRING(32), allowNull: true, comment: '触发时支援路线' },
    expires_at: { type: DataTypes.DATE, allowNull: false, comment: '过期时间（24小时后）' }
}, {
    tableName: 'border_war_imprints',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
});

module.exports = BorderWarImprint;
