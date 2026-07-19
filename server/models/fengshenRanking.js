/**
 * 封神台排名模型
 *
 * 存储封神台赛季排名数据，包括玩家排名、封神积分、防守阵容等
 * 表名：fengshen_rankings
 *
 * 设计说明：
 *   - 封神台是赛季制镜像排名竞技场，玩家设置防守阵容后被其他玩家挑战
 *   - 挑战者挑战排名高于自己的玩家，胜利则交换排名
 *   - 赛季结束后按排名发放奖励，重置积分
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const FengshenRanking = sequelize.define('FengshenRanking', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_fengshen_player',
        comment: '玩家ID'
    },
    rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前排名（0=未上榜）'
    },
    season: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '当前赛季编号'
    },
    fengshen_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1000,
        comment: '封神积分（用于排名计算）'
    },
    defense_config: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            const rawValue = this.getDataValue('defense_config');
            return rawValue ? JSON.parse(rawValue) : null;
        },
        set(value) {
            this.setDataValue('defense_config', value ? JSON.stringify(value) : null);
        },
        comment: '防守阵容配置JSON（装备/法宝/灵兽快照）'
    },
    defense_set_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '防守阵容设置时间'
    },
    daily_challenge_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日挑战次数'
    },
    daily_defend_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日被挑战次数'
    },
    total_wins: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '累计胜利次数'
    },
    total_losses: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '累计失败次数'
    },
    last_challenge_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后挑战日期（用于跨日重置每日次数）'
    }
}, {
    tableName: 'fengshen_rankings',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
});

module.exports = FengshenRanking;
