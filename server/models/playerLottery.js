/**
 * 玩家抽奖模型
 *
 * 记录玩家的抽奖统计与保底计数。奖池静态定义在 lottery_data.json，
 * 本表只存玩家的累计抽取次数与当前保底进度（动态数据）。
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerLottery = sequelize.define('PlayerLottery', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    // 累计抽奖次数（用于统计与展示）
    total_draws: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '累计抽奖次数'
    },
    // 自上次 SSR 以来的抽数（保底计数）
    since_last_ssr: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '距上次 SSR 的抽数，达到 pity_threshold 时必出 SSR'
    },
    // 各档位历史产出计数（JSON，便于前端展示出货统计）
    rank_counts: {
        type: DataTypes.JSON,
        defaultValue: {},
        comment: '各 rank 历史产出计数 { SSR: n, SR: n, ... }'
    }
}, {
    tableName: 'player_lottery',
    indexes: [
        { unique: true, name: 'uk_player_lottery', fields: ['player_id'] }
    ]
});

module.exports = PlayerLottery;
