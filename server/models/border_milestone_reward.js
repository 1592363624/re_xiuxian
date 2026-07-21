/**
 * 慕兰战线里程碑奖励发放记录模型
 *
 * 对应数据库表 border_milestone_rewards
 * 记录玩家达到军功阈值（7/21/49/81）时自动发放的里程碑奖励
 *
 * 设计要点：
 *   - UNIQUE KEY (player_id, milestone_merit) 保证幂等：同一玩家同一里程碑不会重复发放
 *   - 累计军功 border_military_merit_total 增加时，自动检查所有未发放的里程碑
 *
 * 字段说明见 migration_0041_border_military_tables.js
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BorderMilestoneReward = sequelize.define('BorderMilestoneReward', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false, comment: '玩家ID' },
    milestone_merit: { type: DataTypes.INTEGER, allowNull: false, comment: '里程碑军功阈值（7/21/49/81）' },
    milestone_title: { type: DataTypes.STRING(64), allowNull: false, comment: '里程碑标题' },
    rewards_data: { type: DataTypes.TEXT, allowNull: false, comment: '奖励内容JSON' },
    granted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, comment: '发放时间' }
}, {
    tableName: 'border_milestone_rewards',
    timestamps: false
});

module.exports = BorderMilestoneReward;
