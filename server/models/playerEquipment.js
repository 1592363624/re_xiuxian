/**
 * 玩家装备模型
 *
 * 存储玩家已穿戴的装备信息。设计说明：
 *   - 装备的静态属性（名称、效果、境界要求等）从 item_data.json 读取（配置中心化）
 *   - 本表仅存储 player_id + slot + item_key（动态数据），以及装备时间
 *   - 槽位（slot）对应物品的 subtype 字段：weapon武器 / armor护甲 / accessory饰品 / boots靴子 / dharma法器
 *   - 一个玩家每个槽位只能装备一件物品（uk_player_slot 唯一索引约束）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerEquipment = sequelize.define('PlayerEquipment', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    slot: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '装备槽位（weapon武器/armor护甲/accessory饰品/boots靴子/dharma法器）'
    },
    item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '装备的物品配置键名（对应 item_data.json 的 items[].id）'
    },
    equipped_at: {
        type: DataTypes.DATE,
        comment: '装备穿戴时间'
    }
}, {
    tableName: 'player_equipment',
    timestamps: true,
    // 只使用 created_at，不使用 updated_at（装备记录穿戴后不再变更，卸下即删除）
    updatedAt: false,
    indexes: [
        // 唯一索引：一个玩家每个槽位只能装备一件
        {
            unique: true,
            fields: ['player_id', 'slot'],
            name: 'uk_player_slot'
        },
        // 辅助索引：按玩家查询所有装备
        { fields: ['player_id'] }
    ]
});

module.exports = PlayerEquipment;
