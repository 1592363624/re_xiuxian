/**
 * 坐化遗府分配日志模型
 *
 * 对应表 cave_legacy_distribution_logs：每次物品分配（玩家转动分宝或管理员补偿）写入一条日志
 *
 * 字段说明：
 *   - legacy_id：所属遗府ID
 *   - player_id：领取玩家ID
 *   - item_key：物品配置键名
 *   - item_name_snapshot：物品名称快照
 *   - quantity：分配数量
 *   - distributed_at：分配时间
 *   - source：分配来源
 *       spin        - 玩家转动分宝获得
 *       admin_grant - 管理员补偿（预留扩展）
 *
 * 设计要点：
 *   - 该表为只追加（append-only）日志表，不删除（仅按 legacy_id 查询）
 *   - 用于审计：可在 .遗府榜 接口按 legacy_id 聚合查询分配记录
 *   - 一次转动分宝可写入多条记录（玩家分得多种物品时）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveLegacyDistributionLog = sequelize.define('CaveLegacyDistributionLog', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '日志ID'
    },
    legacy_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '所属遗府ID'
    },
    player_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '领取玩家ID'
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
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '分配数量'
    },
    distributed_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '分配时间'
    },
    source: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'spin',
        comment: '分配来源：spin=转动分宝 / admin_grant=管理员补偿'
    }
}, {
    tableName: 'cave_legacy_distribution_logs',
    timestamps: false,  // 仅使用 distributed_at，不启用 Sequelize 自动 timestamps
    underscored: true,
    indexes: [
        { fields: ['legacy_id'] },
        { fields: ['player_id'] },
        { fields: ['distributed_at'] }
    ]
});

module.exports = CaveLegacyDistributionLog;
