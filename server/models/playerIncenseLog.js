/**
 * 香火流水记录模型
 *
 * 记录玩家香火余额变动的全量流水，用于审计与统计：
 *   - change_type：变动类型（harvest/temple_upgrade/divine_miracle/quench/manifest/offering_exchange/gm_grant）
 *   - change_amount：变动数量（正数+，负数-）
 *   - balance_after：变动后余额（用于核对玩家表 incense_balance 字段）
 *
 * 与玩家表 N:1 关系（一个玩家可产生任意数量流水）
 * 按 (player_id, created_at) 复合索引加速分页查询
 *
 * 关键字段说明：
 *   - change_type 对应 late_stage_data.json 的 incense.change_types 配置
 *   - balance_after 与 players.incense_balance 同步，确保数据一致性
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerIncenseLog = sequelize.define('PlayerIncenseLog', {
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
    change_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '变动类型：harvest/temple_upgrade/divine_miracle/quench/manifest/offering_exchange/gm_grant'
    },
    change_amount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '变动数量（正数+，负数-）'
    },
    balance_after: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '变动后余额'
    },
    reason: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: '变动原因描述'
    }
}, {
    tableName: 'player_incense_log',
    timestamps: true,
    underscored: true,
    updatedAt: false,  // 流水表仅有创建时间，无更新时间
    indexes: [
        { fields: ['player_id', 'created_at'], name: 'idx_pil_player_time' },
        { fields: ['change_type'], name: 'idx_pil_type' }
    ]
});

module.exports = PlayerIncenseLog;
