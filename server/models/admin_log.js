/**
 * 管理员操作日志模型
 * 用于记录GM的所有操作，便于审计和追溯
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AdminLog = sequelize.define('AdminLog', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '日志ID'
    },
    admin_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '执行操作的管理员ID'
    },
    action: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '操作类型: time_travel, ban_player, unban_player, modify_player, give_item, give_spirit_stones, add_exp, reset_player, force_breakthrough, delete_player, update_config'
    },
    target_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '操作目标ID（玩家ID等）'
    },
    details: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '操作详情JSON'
    },
    ip: {
        type: DataTypes.STRING(45),
        allowNull: true,
        comment: 'IP地址'
    }
}, {
    tableName: 'admin_logs',
    timestamps: true,
    indexes: [
        { fields: ['admin_id'] },
        { fields: ['action'] },
        { fields: ['target_id'] },
        { fields: ['createdAt'] }
    ]
});

module.exports = AdminLog;
