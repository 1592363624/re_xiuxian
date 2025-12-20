const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * 聊天记录模型
 */
const Chat = sequelize.define('Chat', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  sender: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '发送者昵称'
  },
  content: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '消息内容'
  },
  type: {
    type: DataTypes.ENUM('system', 'player'),
    defaultValue: 'player',
    comment: '消息类型：系统消息或玩家消息'
  }
}, {
  tableName: 'chats',
  timestamps: true,
  updatedAt: false // 聊天记录一般不需要更新时间
});

module.exports = Chat;
