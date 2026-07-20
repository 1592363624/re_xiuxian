/**
 * 玩家神庙模型
 *
 * 神庙是小世界香火产出的核心设施：
 *   - 10 级升级表：消耗香火+灵石，解锁供奉池/护界禁制/神庙加成
 *   - 护界禁制：防御外敌入侵（神域战/灾变），消耗灵石修复
 *   - 供奉兑换池：玩家用香火兑换灵石/神识丹/法则碎片等
 *
 * 与玩家表 1:1 关系（UNIQUE KEY player_id）
 * 与小世界表 N:1 关系（small_world_id 关联 player_small_world.id）
 *
 * 关键字段说明：
 *   - temple_level：1-10，每级提升香火产出 multiplier（1 + (level-1) * 0.1）
 *   - defense_power：护界禁制强度，0-10000，受攻击时降低
 *   - offering_pool：JSON 数组，记录已解锁的供奉项 offering_id
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerDivineTemple = sequelize.define('PlayerDivineTemple', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_pdt_player',
        comment: '所属玩家ID'
    },
    small_world_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属小世界ID'
    },
    temple_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '神庙等级（1-10）'
    },
    temple_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: '神庙',
        comment: '神庙名称'
    },
    defense_power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '护界禁制强度（0-10000）'
    },
    defense_max: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1000,
        comment: '护界禁制上限'
    },
    offering_pool: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '供奉兑换池JSON（记录已解锁供奉项）',
        get() {
            const rawValue = this.getDataValue('offering_pool');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('offering_pool', JSON.stringify(value));
        }
    },
    last_upgrade_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后升级时间'
    },
    last_defense_repair_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后禁制修复时间'
    }
}, {
    tableName: 'player_divine_temple',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['small_world_id'], name: 'uk_pdt_world' }
    ]
});

module.exports = PlayerDivineTemple;
