const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * 聊天记录模型
 *
 * 消息类型说明：
 *   - system：系统消息（服务器公告、事件通知等）
 *   - player：玩家普通文字消息
 *   - red_packet：红包消息（content 字段存储红包元信息 JSON，含 red_packet_id/total_amount 等）
 *   - item_show：物品展示消息（content 字段存储物品展示信息 JSON，含 item_key/item_name/quality 等）
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
    comment: '消息内容（red_packet/item_show 类型时为 JSON 字符串）'
  },
  type: {
    type: DataTypes.ENUM('system', 'player', 'red_packet', 'item_show'),
    defaultValue: 'player',
    comment: '消息类型：system=系统消息，player=玩家消息，red_packet=红包消息，item_show=物品展示消息'
  }
}, {
  tableName: 'chats',
  timestamps: true,
  updatedAt: false // 聊天记录一般不需要更新时间
});

module.exports = Chat;
