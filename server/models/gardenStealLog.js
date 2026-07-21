/**
 * 灵兽偷菜日志模型
 *
 * 对应数据库表 garden_steal_logs，记录灵兽偷菜的完整日志：
 *   - 偷菜方信息：attacker_player_id / attacker_beast_id / attacker_beast_snapshot
 *   - 被偷方信息：target_player_id / target_plot_index / target_seed_id / target_produce_item_id
 *   - 偷菜结果：stolen_qty / stolen_quality / result(success/intercepted/failed)
 *   - 护院信息：guard_beast_id / guard_beast_snapshot / counter_damage
 *   - 奖惩信息：exp_gained / loyalty_change
 *
 * 表设计要点：
 *   - result: success成功 / intercepted被拦截 / failed失败
 *   - append-only 表（只有 created_at，无 updated_at），updatedAt: false
 *   - (attacker_player_id, created_at) 索引支撑查询玩家偷菜历史
 *   - (target_player_id, target_plot_index, created_at) 索引支撑查询地块被偷记录
 *
 * 关联关系：
 *   - 隶属于 Player（attacker_player_id / target_player_id → players.id）
 *   - 关联 SpiritBeast（attacker_beast_id / guard_beast_id → spirit_beasts.id）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const GardenStealLog = sequelize.define('GardenStealLog', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '偷菜日志ID'
    },
    attacker_player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '偷菜方玩家ID'
    },
    attacker_beast_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '偷菜方灵兽ID'
    },
    attacker_beast_snapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '偷菜方灵兽快照',
        get() {
            const val = this.getDataValue('attacker_beast_snapshot');
            return val || null;
        }
    },
    target_player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被偷方玩家ID'
    },
    target_plot_index: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '被偷地块序号'
    },
    target_seed_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '被偷作物种子ID'
    },
    target_produce_item_id: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '被偷作物产出物品ID'
    },
    stolen_qty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '被偷数量'
    },
    stolen_quality: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '被偷作物品质'
    },
    guard_beast_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '护院灵兽ID（无护院为null）'
    },
    guard_beast_snapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '护院灵兽快照',
        get() {
            const val = this.getDataValue('guard_beast_snapshot');
            return val || null;
        }
    },
    result: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '偷菜结果：success成功/intercepted被拦截/failed失败'
    },
    counter_damage: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '反伤伤害（被拦截时护院灵兽造成）'
    },
    exp_gained: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '获得经验'
    },
    loyalty_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '忠诚度变化'
    }
}, {
    tableName: 'garden_steal_logs',
    timestamps: true,
    underscored: true,
    // 偷菜日志是 append-only，不需要 updatedAt
    updatedAt: false,
    indexes: [
        { fields: ['attacker_player_id', 'created_at'], name: 'idx_steal_attacker' },
        { fields: ['target_player_id', 'created_at'], name: 'idx_steal_target' },
        { fields: ['attacker_beast_id', 'created_at'], name: 'idx_steal_beast' },
        { fields: ['result', 'created_at'], name: 'idx_steal_result' },
        { fields: ['target_player_id', 'target_plot_index', 'created_at'], name: 'idx_steal_target_plot' }
    ]
});

module.exports = GardenStealLog;
