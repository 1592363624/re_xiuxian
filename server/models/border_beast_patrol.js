/**
 * 灵兽边境巡边记录模型
 *
 * 对应数据库表 border_beast_patrols
 * 记录玩家派出灵兽参与慕兰战线巡边的行动
 *
 * 业务流程：
 *   1. 玩家调用 .灵兽巡边 <灵兽名> <斥候/护粮/袭营> → 写入派出记录，1小时后可结算
 *   2. 到达 end_time 后，玩家调用 .巡边归来 → 结算奖励（军功/灵石/经验/物品）
 *   3. 袭营路线有失败概率，失败时损失部分 HP 和灵石
 *
 * 字段说明见 migration_0041_border_military_tables.js
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const BorderBeastPatrol = sequelize.define('BorderBeastPatrol', {
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    player_id: { type: DataTypes.BIGINT, allowNull: false, comment: '玩家ID' },
    beast_id: { type: DataTypes.BIGINT, allowNull: false, comment: '灵兽ID' },
    patrol_route: {
        type: DataTypes.STRING(32),
        allowNull: false,
        comment: '巡边路线：scout(斥候)/grain_guard(护粮)/camp_raid(袭营)'
    },
    start_time: { type: DataTypes.DATE, allowNull: false, comment: '派出时间' },
    end_time: { type: DataTypes.DATE, allowNull: false, comment: '预计归来时间' },
    settled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否已结算' },
    settled_at: { type: DataTypes.DATE, allowNull: true, comment: '结算时间' },
    merit_gained: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '获得军功' },
    spirit_stones_gained: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, comment: '获得灵石' },
    exp_gained: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, comment: '玩家获得经验' },
    beast_exp_gained: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '灵兽获得经验' },
    items_dropped: { type: DataTypes.TEXT, allowNull: true, comment: '掉落物品JSON' },
    failed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, comment: '是否失败' },
    failure_penalty: { type: DataTypes.TEXT, allowNull: true, comment: '失败惩罚JSON' }
}, {
    tableName: 'border_beast_patrols',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
});

module.exports = BorderBeastPatrol;
