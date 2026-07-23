/**
 * 聊天红包模型
 *
 * 存储玩家在聊天频道发送的红包信息。
 * 支持两种类型：
 *   - lucky（拼手气）：金额随机分配，手气最佳者获得最多
 *   - equal（普通均分）：每个领取者获得相同金额
 *
 * 状态流转：
 *   active（可领取）→ exhausted（被领完）/ expired（过期未领完）/ refunded（过期后已退款）
 *
 * 关联表：chat_red_packet_claims（领取记录）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChatRedPacket = sequelize.define('ChatRedPacket', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    sender_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '发送者玩家ID'
    },
    sender_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '发送者昵称（冗余字段，便于查询展示）'
    },
    channel: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'world',
        comment: '所属频道（world=全局频道）'
    },
    total_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '红包总金额（灵石）'
    },
    total_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '红包总个数'
    },
    remain_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '剩余金额（领取时递减）'
    },
    remain_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '剩余个数（领取时递减）'
    },
    packet_type: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'lucky',
        comment: '红包类型：lucky=拼手气，equal=普通均分'
    },
    status: {
        type: DataTypes.STRING(15),
        allowNull: false,
        defaultValue: 'active',
        comment: '红包状态：active/exhausted/expired/refunded'
    },
    message: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '红包附言（可选）'
    },
    expire_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '过期时间'
    }
}, {
    tableName: 'chat_red_packets',
    timestamps: true,
    underscored: false,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = ChatRedPacket;
