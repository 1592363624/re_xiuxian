/**
 * 玩家成就模型
 *
 * 记录玩家已达成（或已领取奖励）的成就。成就的静态定义来自 achievement_data.json，
 * 本表仅保存玩家的达成进度与领取状态，属于动态数据。
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerAchievement = sequelize.define('PlayerAchievement', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    achievement_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '成就ID（对应 achievement_data.json 的 achievements[].id）'
    },
    // 当前进度（用于展示 进度/目标）
    progress: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '当前完成进度'
    },
    // 是否达成（progress >= target）
    completed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否已达成条件'
    },
    // 奖励是否已领取
    claimed: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '奖励是否已领取'
    },
    completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '达成时间'
    },
    claimed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '领取奖励时间'
    }
}, {
    tableName: 'player_achievements',
    indexes: [
        {
            unique: true,
            name: 'uk_player_achievement',
            fields: ['player_id', 'achievement_id']
        }
    ]
});

module.exports = PlayerAchievement;
