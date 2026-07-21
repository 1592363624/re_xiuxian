/**
 * 坐化遗府可分配物品模型
 *
 * 对应表 cave_legacy_items：遗府活动开启时，从坐化玩家储物袋筛选可分配物品，写入此表
 *
 * 字段说明：
 *   - legacy_id：所属遗府ID（与 cave_legacies.id 关联）
 *   - item_key：物品配置键名（对应 item_data.json items[].id）
 *   - item_name_snapshot / item_type_snapshot / item_subtype_snapshot / item_quality_snapshot：
 *     物品静态属性快照，避免物品配置变更后历史记录失真
 *   - original_quantity：原始数量（从坐化玩家储物袋读取的）
 *   - remaining_quantity：剩余可分配数量（玩家分宝时递减）
 *   - source：inventory=储物袋筛选 / manual=管理员手动添加（预留扩展）
 *
 * 设计要点：
 *   - 物品筛选在 Service 层完成，符合 cave_legacy_data.json -> item_filter 规则
 *   - 跳过剧情物/徽章/绑定物/带器灵/已装备/祭炼/本命法宝
 *   - remaining_quantity 在事务中加锁扣减，保证并发分宝时不超分
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveLegacyItem = sequelize.define('CaveLegacyItem', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    legacy_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '所属遗府ID'
    },
    item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品配置键名'
    },
    item_name_snapshot: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品名称快照'
    },
    item_type_snapshot: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '物品类型快照（material/consumable）'
    },
    item_subtype_snapshot: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '物品 subtype 快照'
    },
    item_quality_snapshot: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'common',
        comment: '物品品质快照'
    },
    original_quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '原始数量（从储物袋读取）'
    },
    remaining_quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '剩余可分配数量'
    },
    source: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'inventory',
        comment: '来源：inventory=储物袋 / manual=管理员手动'
    }
}, {
    tableName: 'cave_legacy_items',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['legacy_id'] },
        { fields: ['item_key'] }
    ]
});

module.exports = CaveLegacyItem;
