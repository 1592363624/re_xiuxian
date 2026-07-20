/**
 * 法则碎片流水记录模型
 *
 * 记录玩家法则碎片变动的全量流水，用于审计与统计：
 *   - fragment_type：碎片类型（space/time/five_elements/soul/karma）
 *   - change_amount：变动数量（正数+，负数-）
 *   - source：来源（fracture_explore/world_boss/dungeon/law_convert/gm_grant）
 *   - balance_after：变动后余额（用于核对 player_law 表对应字段）
 *
 * 与玩家表 N:1 关系（一个玩家可产生任意数量流水）
 * 按 (player_id, created_at) 复合索引加速分页查询
 *
 * 关键字段说明：
 *   - fragment_type 对应 late_stage_data.json 的 law.fragment_types 配置
 *   - source 对应 late_stage_data.json 的 law.fragment_change_sources 配置
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerLawFragment = sequelize.define('PlayerLawFragment', {
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
    fragment_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '碎片类型：space/time/five_elements/soul/karma'
    },
    change_amount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '变动数量（正数+，负数-）'
    },
    source: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '来源：fracture_explore/world_boss/dungeon/law_convert/gm_grant'
    },
    balance_after: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '变动后余额'
    }
}, {
    tableName: 'player_law_fragment',
    timestamps: true,
    underscored: true,
    updatedAt: false,  // 流水表仅有创建时间，无更新时间
    indexes: [
        { fields: ['player_id', 'created_at'], name: 'idx_plf_player_time' },
        { fields: ['fragment_type'], name: 'idx_plf_type' }
    ]
});

module.exports = PlayerLawFragment;
