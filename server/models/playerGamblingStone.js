/**
 * 玩家赌石状态模型
 *
 * 存储玩家赌石核心状态（与 players 表 1:1 关系）：
 *   - 赌石熟练度（等级0-100 + 经验，影响线索解读+稀有产出）
 *   - 日生成次数与上限（跨日重置，灵石/修为有日上限）
 *   - 诅咒状态（curse_until，诅咒期间产出可被其他玩家劫掠）
 *   - 统计数据（总切开/累计收益/最大单块/稀有掉落/LDC产出）
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   赌石流程是 `.赌石` 生成三块原石，再用 `.切 <编号>` 购买切开。
 *
 * 关键字段说明：
 *   - skill_level：赌石熟练度等级（0-100），每5级+1%线索解读准确度，每10级+1%稀有产出权重
 *   - curse_until：诅咒到期时间，NULL=无诅咒；诅咒矿脉切石有概率触发，持续24小时
 *   - biggest_win：单块原石最大收益（按灵石等价折算），用于排行榜
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerGamblingStone = sequelize.define('PlayerGamblingStone', {
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
    skill_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '赌石熟练度等级（0-100）'
    },
    skill_exp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '赌石熟练度当前经验'
    },
    daily_generates: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已生成次数（每日3次上限）'
    },
    daily_reset_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '日重置日期（跨日重置次数和日上限）'
    },
    daily_spirit_stone_earned: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已获灵石（BIGINT，有日上限50000）'
    },
    daily_cultivation_earned: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '今日已获修为（BIGINT，有日上限80000）'
    },
    curse_until: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '诅咒到期时间（NULL=无诅咒，诅咒期间产出可被劫）'
    },
    total_cuts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总切开次数'
    },
    total_spirit_stone_earned: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '累计灵石收益'
    },
    total_cultivation_earned: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '累计修为收益'
    },
    total_profit: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '累计净收益（产出-成本，含切石费用）'
    },
    biggest_win: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '单块最大收益（按灵石等价折算）'
    },
    rare_drop_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '稀有掉落累计次数'
    },
    ldc_earned: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '累计获得LDC数量'
    }
}, {
    tableName: 'player_gambling_stone',
    timestamps: true,
    underscored: true,
    comment: '玩家赌石状态表'
});

module.exports = PlayerGamblingStone;
