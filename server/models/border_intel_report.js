/**
 * 慕兰谍影军报记录模型
 *
 * 对应数据库表 border_intel_reports
 * 记录玩家每日搜集的军报，包含真假标记、辨报结果、公开状态
 *
 * 业务流程：
 *   1. 玩家调用 .搜集军报 → 系统生成 3 条军报（真假混杂）写入此表
 *   2. 玩家调用 .辨报 <编号> → 系统判定辨报成功/失败，更新 identified 字段
 *   3. 玩家调用 .公开军报 <编号> → 系统根据真假给予军功奖惩，更新 public_status
 *
 * 字段说明见 migration_0041_border_military_tables.js
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BorderIntelReport = sequelize.define('BorderIntelReport', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false, comment: '玩家ID' },
    report_date: { type: DataTypes.DATEONLY, allowNull: false, comment: '军报日期' },
    report_index: { type: DataTypes.INTEGER, allowNull: false, comment: '当日军报序号（1-3）' },
    report_type: { type: DataTypes.STRING(32), allowNull: false, comment: '军报类型' },
    is_true: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否真实军报' },
    content: { type: DataTypes.STRING(500), allowNull: false, comment: '军报内容文本' },
    confusion_rate: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0.1, comment: '混淆度' },
    identified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否已辨报' },
    identified_result: { type: DataTypes.STRING(32), allowNull: true, comment: '辨报结果（correct/wrong）' },
    identified_at: { type: DataTypes.DATE, allowNull: true, comment: '辨报时间' },
    public_status: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'pending',
        comment: '公开状态：pending/publiced/discarded'
    },
    publiced_at: { type: DataTypes.DATE, allowNull: true, comment: '公开时间' },
    merit_change: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '公开后军功变化' }
}, {
    tableName: 'border_intel_reports',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
});

module.exports = BorderIntelReport;
