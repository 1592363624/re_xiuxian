/**
 * 玩家装备模型
 *
 * 存储玩家已穿戴的装备信息。设计说明：
 *   - 装备的静态属性（名称、效果、境界要求等）从 item_data.json 读取（配置中心化）
 *   - 本表存储 player_id + slot + item_key + 动态成长字段（耐久、祭炼、本命）
 *   - 槽位（slot）对应物品的 subtype 字段：weapon武器 / armor护甲 / accessory饰品 / boots靴子 / dharma法器
 *   - 一个玩家每个槽位只能装备一件物品（uk_player_slot 唯一索引约束）
 *
 * 法宝深度系统字段说明（v1.2 迭代）：
 *   - durability / max_durability：当前/最大耐久度，战斗损耗，需修理
 *   - refine_level：祭炼（精炼）等级，提升装备属性百分比加成
 *   - is_benming / benming_slot：本命法器标记与所在槽位（1~3），本命后无法卸下，仅可替换
 *   - spirit_power：本命法器法力值，用于本命法器主动技能消耗与被动加成
 *   - sort_order：装备在面板中的排序顺序（玩家可调序）
 *   - is_summoned：本命法器是否已祭出（仅 is_benming=true 的装备可祭出）
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
    },
    // ========== 法宝深度系统字段（v1.2 新增） ==========
    durability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '当前耐久度（<=0 时装备破碎，无法生效）'
    },
    max_durability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '最大耐久度（每次修理会扣减上限，达到阈值时无法继续修理）'
    },
    refine_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '祭炼（精炼）等级 0~15，提升装备属性百分比加成'
    },
    is_benming: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否本命法器（本命后绑定，无法直接卸下，仅可替换为同槽位新本命）'
    },
    benming_slot: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '本命槽位编号（1~max_slots），仅 is_benming=true 时有效'
    },
    spirit_power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本命法器法力值，用于本命法器主动技能消耗与被动加成'
    },
    sort_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '装备在面板中的排序顺序（数值小的排前面）'
    },
    is_summoned: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '本命法器是否已祭出（祭出后用于战斗，受场景限制）'
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
        { fields: ['player_id'] },
        // 辅助索引：查询玩家本命法器列表
        { fields: ['player_id', 'is_benming'] },
        // 辅助索引：查询玩家已祭出的法器
        { fields: ['player_id', 'is_summoned'] }
    ]
});

module.exports = PlayerEquipment;
