/**
 * 聊天红包领取记录模型
 *
 * 记录每个玩家领取红包的金额信息。
 * 唯一约束：(red_packet_id, receiver_id) —— 同一玩家对同一红包只能领取一次。
 *
 * is_lucky_king 字段仅对 lucky 类型红包有意义：
 *   标记当前红包中领取金额最大的玩家（手气最佳）。
 *   当最后一个红包被领取时，回溯标记手气最佳者。
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChatRedPacketClaim = sequelize.define('ChatRedPacketClaim', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    red_packet_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '关联红包ID'
    },
    receiver_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '领取者玩家ID'
    },
    receiver_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '领取者昵称（冗余字段）'
    },
    amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '领取金额（灵石）'
    },
    is_lucky_king: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否手气最佳（0=否，1=是，仅lucky类型）'
    }
}, {
    tableName: 'chat_red_packet_claims',
    timestamps: true,
    underscored: false,
    createdAt: 'created_at',
    updatedAt: false // 领取记录无需更新时间
});

module.exports = ChatRedPacketClaim;
