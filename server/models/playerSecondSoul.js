/**
 * 玩家第二元神模型
 *
 * 存储玩家主元神+副元神（第二/第三元神）的完整数据：
 *   - 元神序号：1=主元神，2=第二元神，3=第三元神（元神分化产物）
 *   - 元神境界与修为：独立成长，第二元神修炼速度为主元神的 0.5 倍
 *   - 元神属性：atk/def/hp_max/speed/sense，按主元神属性 * inherit_ratio 继承
 *   - 调度模式：combat(出战)/cultivate(修炼)/scout(探查)/defend(护法)，各模式独立 CD
 *   - 独立修炼：12 小时上限，每日 2 次，is_cultivating 标记状态
 *
 * 与玩家表 N:1 关系（一个玩家最多 3 个元神：主+2 副）
 * (player_id, soul_index) 唯一约束防止重复
 *
 * 关键字段说明：
 *   - soul_type：normal=普通元神，magic=魔元神（五子同心魔线，剧情线扩展）
 *   - is_active：同时只能激活一个元神（默认主元神激活）
 *   - dispatch_until：调度结束时间，过期后由 StateCleanerService 自动结算
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerSecondSoul = sequelize.define('PlayerSecondSoul', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属玩家ID'
    },
    soul_index: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '元神序号（1=第一元神/主，2=第二元神，3=第三元神）'
    },
    soul_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '元神名称（玩家自定义）'
    },
    soul_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'normal',
        comment: '元神类型：normal=普通，magic=魔元神（五子同心魔线）'
    },
    realm: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '元神境界'
    },
    realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '元神境界rank'
    },
    exp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '元神修为'
    },
    attributes: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '元神属性JSON（atk/def/hp_max/speed/sense）',
        get() {
            const rawValue = this.getDataValue('attributes');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('attributes', JSON.stringify(value));
        }
    },
    inherit_ratio: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0.6,
        comment: '主元神属性继承比例'
    },
    is_active: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否当前激活（0否1是，同时只能激活一个）'
    },
    is_cultivating: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否在独立修炼（独立挂机成长）'
    },
    cultivate_started_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '开始修炼时间'
    },
    cultivate_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '预计结束时间'
    },
    last_dispatch_mode: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '上次调度模式：combat/cultivate/scout/defend'
    },
    dispatch_until: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '调度结束时间'
    },
    combat_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史参战次数'
    },
    cultivate_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '历史独立修炼次数'
    }
}, {
    tableName: 'player_second_soul',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'soul_index'], unique: true, name: 'uk_pss_player_index' },
        { fields: ['player_id', 'is_active'], name: 'idx_pss_player_active' },
        { fields: ['dispatch_until'], name: 'idx_pss_dispatch' }
    ]
});

module.exports = PlayerSecondSoul;
