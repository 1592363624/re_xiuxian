/**
 * 拍卖主表模型
 *
 * 存储玩家发起的拍卖记录，包含物品信息、起拍价、当前最高出价、状态等。
 *
 * 业务说明：
 *   - 拍卖创建时，物品从卖家背包真实扣除（防伪造/复制）
 *   - 竞价时，竞价者灵石被冻结（防重复使用）
 *   - 防秒杀机制：拍卖结束前1分钟内有人竞价，自动延长1分钟（最多3次）
 *   - 到期自动结算：有竞价则物品给最高竞价者，灵石给卖家（扣手续费）；无竞价则物品退回
 *   - 撤销：仅卖家可撤销，无人竞价时免费撤销；有人竞价时撤销需补偿最高竞价者
 *
 * 状态流转：
 *   open → closed（到期结算）
 *   open → cancelled（卖家撤销）
 *
 * 关联表：
 *   - players（seller_id / current_bidder_id / winner_id → players.id）
 *   - auction_bids（一对多，记录每次竞价历史）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Auction = sequelize.define('Auction', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    seller_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '拍卖者玩家ID'
    },
    item_key: {
        type: DataTypes.STRING(80),
        allowNull: false,
        comment: '拍卖物品配置键名'
    },
    item_name: {
        type: DataTypes.STRING(120),
        allowNull: false,
        comment: '拍卖物品名称（创建时快照）'
    },
    item_quality: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'common',
        comment: '物品品质'
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '拍卖数量'
    },
    starting_price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '起拍价（灵石）'
    },
    current_price: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '当前最高出价'
    },
    current_bidder_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '当前最高出价者ID（无人竞价时为NULL）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'open',
        comment: '拍卖状态：open/closed/cancelled'
    },
    start_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '拍卖开始时间'
    },
    end_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '拍卖结束时间（含防秒杀延长）'
    },
    winner_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '最终得标者ID'
    },
    final_price: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '最终成交价'
    },
    fee_rate: {
        type: DataTypes.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0.05,
        comment: '手续费率（创建时快照配置）'
    },
    extension_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '防秒杀延长次数（上限3次）'
    },
    cancel_reason: {
        type: DataTypes.STRING(120),
        allowNull: true,
        comment: '撤销原因'
    },
    settled_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '结算时间'
    }
}, {
    tableName: 'auctions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
        { fields: ['status', 'end_at'] },
        { fields: ['seller_id', 'status', 'created_at'] },
        { fields: ['current_bidder_id', 'status'] }
    ]
});

module.exports = Auction;
