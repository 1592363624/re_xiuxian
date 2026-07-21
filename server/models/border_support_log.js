/**
 * 慕兰战线支援行动日志模型
 *
 * 对应数据库表 border_support_logs
 * 记录玩家每次支援慕兰的行动详情，用于历史查询和数据分析
 *
 * 业务流程：
 *   玩家调用 .支援慕兰 <路线> → 系统计算奖励 → 写入此表 + 更新玩家军功
 *
 * 字段说明见 migration_0041_border_military_tables.js
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BorderSupportLog = sequelize.define('BorderSupportLog', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false, comment: '玩家ID' },
    support_route: {
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '支援路线：scout(斥候)/lamp_breaker(破灯)/array_guard(护阵)/raid(奇袭)'
    },
    support_date: { type: DataTypes.DATEONLY, allowNull: false, comment: '支援日期' },
    is_secret_order: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否密令路线' },
    is_risky_route: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否险棋路线' },
    is_grain_route: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否粮道路线' },
    base_merit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '基础军功' },
    final_merit: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '最终军功（含加成）' },
    merit_bonus_rate: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0, comment: '军功加成比例' },
    spirit_stones_gained: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, comment: '获得灵石' },
    items_dropped: { type: DataTypes.TEXT, allowNull: true, comment: '掉落物品JSON' },
    imprint_triggered: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否触发临战刻印' },
    imprint_bonus_rate: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0, comment: '刻印加成比例' },
    intel_bonus_rate: { type: DataTypes.DECIMAL(5, 4), allowNull: false, defaultValue: 0, comment: '军报加成比例' },
    failed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否失败' },
    failure_penalty: { type: DataTypes.TEXT, allowNull: true, comment: '失败惩罚JSON' }
}, {
    tableName: 'border_support_logs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
});

module.exports = BorderSupportLog;
