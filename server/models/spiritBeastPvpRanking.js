/**
 * 灵兽PVP赛季排行模型
 *
 * 对应数据库表 spirit_beast_pvp_rankings，记录玩家在每个赛季中的段位和战绩：
 *   - 段位：bronze青铜/silver白银/gold黄金/platinum铂金/diamond钻石/king王者
 *   - 胜点：累计胜点（胜+10/负-5，青铜段位保护不扣分）
 *   - 战绩：总胜场/总负场/总平局/总对局数/胜率
 *   - 押注统计：累计赢得/输掉的押注灵石
 *   - 每日限制：今日挑战次数/是否已领首胜奖励/每日重置时间
 *
 * 唯一索引：(season_id, player_id) 保证同一赛季同一玩家只有一条记录
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpiritBeastPvpRanking = sequelize.define('SpiritBeastPvpRanking', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '排行记录ID'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '赛季ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname_snapshot: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称快照（结算时使用）'
    },
    tier: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'bronze',
        comment: '段位：bronze/silver/gold/platinum/diamond/king'
    },
    ranking_points: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '胜点（累计，决定段位）'
    },
    total_wins: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总胜场'
    },
    total_losses: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总负场'
    },
    total_draws: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总平局'
    },
    total_matches: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总对局数'
    },
    win_rate: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: '胜率（百分比，自动计算）'
    },
    best_beast_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '主力灵兽ID（胜场最多的灵兽）'
    },
    total_bet_won: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '累计赢得押注灵石',
        get() {
            const val = this.getDataValue('total_bet_won');
            return val !== null && val !== undefined ? val.toString() : '0';
        }
    },
    total_bet_lost: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '累计输掉押注灵石',
        get() {
            const val = this.getDataValue('total_bet_lost');
            return val !== null && val !== undefined ? val.toString() : '0';
        }
    },
    daily_challenge_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日挑战次数（每日0点重置）'
    },
    daily_first_win_claimed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '今日是否已领首胜奖励'
    },
    daily_reset_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '每日重置时间'
    }
}, {
    tableName: 'spirit_beast_pvp_rankings',
    timestamps: true,
    underscored: true,
    indexes: [
        // 唯一索引：同一赛季同一玩家只有一条记录
        { fields: ['season_id', 'player_id'], name: 'uk_pvp_season_player', unique: true },
        // 排行榜查询：按赛季+胜点倒序
        { fields: ['season_id', 'ranking_points'], name: 'idx_pvp_ranking_points' },
        // 玩家查询：按玩家+赛季
        { fields: ['player_id', 'season_id'], name: 'idx_pvp_player' }
    ]
});

module.exports = SpiritBeastPvpRanking;
