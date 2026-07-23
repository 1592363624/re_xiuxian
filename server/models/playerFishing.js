/**
 * 玩家灵溪垂钓状态模型
 *
 * 存储玩家钓鱼核心状态（与 players 表 1:1 关系）：
 *   - 钓竿等级（0=无/1=青竹/2=银竹/3=金竹/4=金雷竹）
 *   - 钓术熟练度（等级0-100 + 经验）
 *   - 日竿数与日上限（跨日重置，灵石/修为有日上限）
 *   - 炼鳞符增益（剩余竿数 + 幸运加成）
 *   - 活跃钓鱼会话（JSON，null=无活跃会话）
 *   - 统计数据（总抛竿/成功次数/最大鱼获/最稀有品质）
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *
 * 关键字段说明：
 *   - rod_tier：钓竿等级，对应 fishing_data.json 的 rods key（qing_zhu=1/yin_zhu=2/jin_zhu=3/jinlei_zhu=4）
 *   - active_session：JSON 字符串，存储当前钓鱼会话（鱼讯到来时间/试探次数/预选鱼/鱼塘/鱼饵等）
 *   - daily_stone_earned/daily_cultivation_earned：BIGINT 字段，有日上限防止通胀
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerFishing = sequelize.define('PlayerFishing', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        comment: '玩家ID（1:1 与 players 表）'
    },
    rod_tier: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前钓竿等级：0=无钓竿 1=青竹 2=银竹 3=金竹 4=金雷竹'
    },
    skill_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '钓术熟练度等级（0-100）'
    },
    skill_exp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '钓术熟练度当前经验'
    },
    daily_casts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已用竿数'
    },
    daily_reset_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '日重置日期（跨日重置竿数和日上限）'
    },
    daily_stone_earned: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已获灵石（BIGINT，有日上限）'
    },
    daily_cultivation_earned: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已获修为（BIGINT，有日上限）'
    },
    buff_casts_remaining: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '炼鳞符剩余增益竿数'
    },
    buff_luck_bonus: {
        type: DataTypes.DECIMAL(5, 4),
        allowNull: false,
        defaultValue: 0.0000,
        comment: '当前幸运加成（0-1）'
    },
    active_session: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '当前活跃钓鱼会话JSON（null=无活跃会话）',
        get() {
            const raw = this.getDataValue('active_session');
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        },
        set(val) {
            this.setDataValue('active_session', val ? JSON.stringify(val) : null);
        }
    },
    total_catches: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总抛竿次数'
    },
    total_success: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '成功钓获次数'
    },
    biggest_catch_kg: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: '最大鱼获重量(kg)'
    },
    rarest_catch_quality: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: '',
        comment: '最稀有鱼获品质'
    }
}, {
    tableName: 'player_fishing',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['skill_level'] },
        { fields: ['biggest_catch_kg'] }
    ]
});

module.exports = PlayerFishing;
