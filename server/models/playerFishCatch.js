/**
 * 玩家鱼获记录模型
 *
 * 存储玩家钓获的鱼获记录（鱼获本体不可流转，剖鱼后标记已剖）：
 *   - 鱼类信息（ID/名称/品质/重量）
 *   - 钓获鱼塘
 *   - 剖鱼状态（未剖/已剖）
 *   - 伴生物品（JSON，功能道具/稀有材料/LDC）
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   "鱼获本体不可流转，剖出的普通材料按原系统规则流通"
 *
 * 与 players 表 N:1 关系（一个玩家可有多条鱼获记录）
 * 与 player_fish_album 表配合：新鱼类首次钓获时自动写入图鉴
 *
 * 关键字段说明：
 *   - is_filleted：0=未剖（可剖鱼取机缘） 1=已剖（不可再剖）
 *   - bonus_items：JSON 字符串，存储伴生物品信息（如 {type:'function_item', id:'shaqi_xiaodao', name:'煞气小刀'}）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerFishCatch = sequelize.define('PlayerFishCatch', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    fish_id: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '鱼类ID（如 minnow/crucian/spirit_carp 等）'
    },
    fish_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '鱼名'
    },
    quality: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '品质：common/uncommon/rare/epic/legendary/mythic'
    },
    weight_kg: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        comment: '鱼获重量(kg)'
    },
    pond_id: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '钓获鱼塘ID'
    },
    is_filleted: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否已剖鱼：0=未剖 1=已剖'
    },
    bonus_items: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '伴生物品JSON（功能道具/稀有材料/LDC，null=无伴生）',
        get() {
            const raw = this.getDataValue('bonus_items');
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        },
        set(val) {
            this.setDataValue('bonus_items', val ? JSON.stringify(val) : null);
        }
    }
}, {
    tableName: 'player_fish_catches',
    timestamps: true,
    underscored: true,
    createdAt: 'caught_at',
    updatedAt: false,
    indexes: [
        { fields: ['player_id'] },
        { fields: ['quality'] },
        { fields: ['is_filleted'] },
        { fields: ['caught_at'] }
    ]
});

module.exports = PlayerFishCatch;
