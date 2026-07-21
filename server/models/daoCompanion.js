/**
 * 道侣关系模型
 *
 * 道侣是 1v1 长期社交关系，提供双修加成、心契护道等机制：
 *   - relation_state: pending（待确认）/active（已缔结）/broken（已解除）
 *   - heart_contract_level: 心契等级（0-5），影响双修加成与护道概率
 *   - daily_dual_cultivation_count: 今日双修次数（跨日重置）
 *   - vow_type: 立誓类型（protect/secret/cultivate）
 *
 * 表设计：player_a_id 和 player_b_id 都加 UNIQUE KEY，强制 1v1
 * 一个玩家同一时间只能有一个道侣（无论作为发起方还是接受方）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DaoCompanion = sequelize.define('DaoCompanion', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_a_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_dc_player_a',
        comment: '玩家A ID（发起方）'
    },
    player_b_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_dc_player_b',
        comment: '玩家B ID（接受方）'
    },
    relation_state: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: '关系状态：pending=待确认，active=已缔结，broken=已解除'
    },
    heart_contract_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '心契等级（0-5），影响护道/共修加成'
    },
    heart_imprint_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '已种心印数量'
    },
    dual_cultivation_count_total: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史双修总次数'
    },
    daily_dual_cultivation_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日双修次数（跨日重置）'
    },
    last_dual_cultivation_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后双修日期'
    },
    last_dual_cultivation_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后双修时间'
    },
    daily_ask_after_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日问安次数'
    },
    last_ask_after_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后问安日期'
    },
    vow_type: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '立誓类型：protect/secret/cultivate'
    },
    vow_expire_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '誓言到期时间'
    },
    vow_broken: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否毁誓'
    },
    heart_tribulation_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '心劫触发次数'
    },
    broken_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '解除时间'
    }
}, {
    tableName: 'dao_companion',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['relation_state'], name: 'idx_dc_state' },
        { fields: ['player_a_id', 'player_b_id'], name: 'idx_dc_pair' }
    ]
});

module.exports = DaoCompanion;
