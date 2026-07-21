/**
 * 灵兽PVP赛季配置模型
 *
 * 对应数据库表 spirit_beast_pvp_seasons，记录每个赛季的配置和状态：
 *   - 赛季名称、开始/结束时间、状态（active/settled/cancelled）
 *   - 结算摘要（Top100奖励发放情况，JSON）
 *
 * 赛季机制：
 *   - 每个赛季持续 28 天（配置项 season.duration_days）
 *   - 赛季结束后自动结算，按段位和排名发放奖励
 *   - 同时只有一个 active 赛季
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpiritBeastPvpSeason = sequelize.define('SpiritBeastPvpSeason', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '赛季ID'
    },
    season_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
        comment: '赛季名称（如：2026年第1季）'
    },
    start_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '赛季开始时间'
    },
    end_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '赛季结束时间'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '状态：active进行中/settled已结算/cancelled已取消'
    },
    settled_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '结算时间'
    },
    settlement_summary: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '结算摘要（Top100奖励发放情况：玩家ID/段位/排名/奖励灵石）',
        get() {
            const val = this.getDataValue('settlement_summary');
            return val || null;
        },
        set(val) {
            this.setDataValue('settlement_summary', val);
        }
    }
}, {
    tableName: 'spirit_beast_pvp_seasons',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['status', 'end_time'], name: 'idx_season_status' }
    ]
});

module.exports = SpiritBeastPvpSeason;
