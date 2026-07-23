/**
 * 万宝阁展品模型
 *
 * 存储洞府主人上架至万宝阁的展品记录
 * 表名：cave_exhibits
 *
 * 系统说明：
 *   万宝阁是洞府的"文化展示厅"，洞府主人可将珍贵物品上架展示。
 *   - 上架时从背包扣除 1 件物品存入此表（物品锁定，不可使用/交易）
 *   - 取下时将物品归还背包
 *   - 展品被鉴赏次数累计为 heat_count（热度值），用于热度榜与声望结算
 *   - 展品数量影响洞府"显眼度"，与洞天寻宝系统联动（财富外露风险）
 *
 * quality 字段取值：common / uncommon / rare / epic / legendary / mythic
 * exhibit_slot 字段：展位编号（1-max_exhibits），同一玩家不可重复占用同一展位
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveExhibit = sequelize.define('CaveExhibit', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '洞府主人玩家ID'
    },
    item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品配置键名（上架时从背包扣除）'
    },
    item_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '物品名称（冗余，展示用，避免每次联查 item_data.json）'
    },
    quality: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'common',
        comment: '品质：common/uncommon/rare/epic/legendary/mythic'
    },
    exhibit_slot: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '展位编号（1-max_exhibits，同一玩家不可重复）'
    },
    heat_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '热度值（被鉴赏次数累计，用于热度榜与声望结算）'
    }
}, {
    tableName: 'cave_exhibits',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
        { fields: ['player_id', 'exhibit_slot'], unique: true },
        { fields: ['heat_count'] }
    ]
});

module.exports = CaveExhibit;
