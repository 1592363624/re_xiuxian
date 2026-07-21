/**
 * 侍妾模型
 *
 * 侍妾是玩家可拥有的 NPC 角色，提供养成与远航玩法：
 *   - concubine_type: normal（普通）/awakened（觉醒）/immortal（仙子）
 *   - charm/intimacy/loyalty: 魅力/亲密度/忠诚度（0-100）
 *   - is_voyaging: 是否远航中（远航期间不可问安/反哺/护法）
 *   - awakened_form: 觉醒形态（特定侍妾可觉醒为高阶形态）
 *
 * 表设计：(player_id, concubine_key) 唯一约束，防止同一玩家重复获得同一侍妾
 * JSON 字段 attributes 在 Model 中配置 getter/setter 自动处理
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Concubine = sequelize.define('Concubine', {
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
    concubine_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '侍妾配置键（如 nangong_wan）'
    },
    concubine_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '侍妾名'
    },
    concubine_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'normal',
        comment: '侍妾类型：normal/awakened（觉醒）/immortal（仙子）'
    },
    realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '侍妾境界rank'
    },
    exp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '侍妾修为'
    },
    charm: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
        comment: '魅力值（0-100）'
    },
    intimacy: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '亲密度（0-100）'
    },
    loyalty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 80,
        comment: '忠诚度（0-100，低于30触发逃跑）'
    },
    talent_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '天赋ID'
    },
    attributes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '属性JSON（atk/def/hp_max/support_bonus）',
        get() {
            const rawValue = this.getDataValue('attributes');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('attributes', JSON.stringify(value));
        }
    },
    is_placed: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否安置中（0否1是）'
    },
    placement_location: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '安置地点（洞府房间名）'
    },
    is_voyaging: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否远航中'
    },
    voyage_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '当前远航记录ID'
    },
    awakened_form: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '觉醒形态（如 nangong_wan_moon_shadow）'
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
    last_ask_after_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后问安时间'
    },
    last_backfeed_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后灵力反哺时间'
    }
}, {
    tableName: 'concubine',
    timestamps: true,
    underscored: true,
    indexes: [
        // 复合唯一约束防止重复获得同一侍妾
        { fields: ['player_id', 'concubine_key'], unique: true, name: 'uk_con_player_key' },
        { fields: ['player_id'], name: 'idx_con_player' },
        { fields: ['is_voyaging'], name: 'idx_con_voyaging' },
        { fields: ['concubine_type'], name: 'idx_con_type' }
    ]
});

module.exports = Concubine;
