/**
 * 玩家悬赏模型
 *
 * 存储玩家发布的悬赏任务数据，包括发布者、目标、悬赏金、状态等
 * 表名：player_bounties
 *
 * 状态流转：
 *   active（悬赏中） -> accepted（已接单） -> completed（已完成）
 *   active -> expired（已过期）
 *   active/accepted -> cancelled（发布者取消）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerBounty = sequelize.define('PlayerBounty', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    publisher_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '悬赏发布者ID'
    },
    target_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '悬赏目标玩家ID'
    },
    bounty_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '悬赏金额（灵石）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '状态：active=悬赏中，accepted=已接单，completed=已完成，expired=已过期，cancelled=已取消'
    },
    acceptor_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '接单者ID'
    },
    accepted_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '接单时间'
    },
    completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '完成时间'
    },
    expire_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '悬赏过期时间'
    },
    battle_record_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '关联的PVP战斗记录ID'
    },
    reason: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: '悬赏理由（可选）'
    }
}, {
    tableName: 'player_bounties',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = PlayerBounty;
