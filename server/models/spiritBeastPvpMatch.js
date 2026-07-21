/**
 * 灵兽PVP对局记录模型
 *
 * 对应数据库表 spirit_beast_pvp_matches，记录每场灵兽PVP挑战的完整信息：
 *   - 双方信息：挑战方/防守方的玩家ID、灵兽ID、灵兽快照、战术
 *   - 押注信息：押注灵石数量、是否友谊赛
 *   - 战斗结果：胜者、总回合数、双方最终HP、战斗日志
 *   - 赛季信息：所属赛季ID、胜点变化
 *
 * 表设计要点：
 *   - 灵兽快照使用 JSON 存储战斗时的灵兽属性，避免后续灵兽升级影响历史对局
 *   - 战斗日志使用 JSON 存储关键回合摘要（每回合的HP变化/暴击/闪避等）
 *   - bet_spirit_stones 使用 BIGINT，避免高数值溢出
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpiritBeastPvpMatch = sequelize.define('SpiritBeastPvpMatch', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '对局ID'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '所属赛季ID'
    },
    challenger_player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '挑战方玩家ID'
    },
    challenger_beast_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '挑战方灵兽ID'
    },
    challenger_beast_snapshot: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '挑战方灵兽快照（名称/属性/元素/星级/等级）'
    },
    challenger_tactic: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'balanced',
        comment: '挑战方战术：all_out全力一击/balanced稳健输出/counter防御反击'
    },
    defender_player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '防守方玩家ID'
    },
    defender_beast_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '防守方灵兽ID'
    },
    defender_beast_snapshot: {
        type: DataTypes.JSON,
        allowNull: false,
        comment: '防守方灵兽快照'
    },
    defender_tactic: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'balanced',
        comment: '防守方战术'
    },
    bet_spirit_stones: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '押注灵石数量（0=友谊赛）',
        get() {
            const val = this.getDataValue('bet_spirit_stones');
            return val !== null && val !== undefined ? val.toString() : '0';
        }
    },
    is_friendly: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否友谊赛（不计赛季）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: '状态：pending等待中/finished已结束/cancelled已取消'
    },
    winner_player_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '胜者玩家ID（平局为null）'
    },
    winner_side: {
        type: DataTypes.STRING(10),
        allowNull: true,
        comment: '胜方：challenger挑战方/defender防守方/draw平局'
    },
    total_rounds: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '总回合数'
    },
    final_challenger_hp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '挑战方最终HP',
        get() {
            const val = this.getDataValue('final_challenger_hp');
            return val !== null && val !== undefined ? val.toString() : '0';
        }
    },
    final_defender_hp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '防守方最终HP',
        get() {
            const val = this.getDataValue('final_defender_hp');
            return val !== null && val !== undefined ? val.toString() : '0';
        }
    },
    battle_log: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '战斗日志（关键回合摘要：回合数/伤害/暴击/闪避/元素克制）'
    },
    points_change: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '胜点变化（胜+10/负-5/平0）'
    }
}, {
    tableName: 'spirit_beast_pvp_matches',
    timestamps: true,
    underscored: true,
    // 对局记录是 append-only，不需要 updatedAt（只有 created_at + finished_at）
    updatedAt: false,
    indexes: [
        { fields: ['challenger_player_id', 'created_at'], name: 'idx_pvp_challenger' },
        { fields: ['defender_player_id', 'created_at'], name: 'idx_pvp_defender' },
        { fields: ['season_id', 'created_at'], name: 'idx_pvp_season' },
        { fields: ['status', 'created_at'], name: 'idx_pvp_status' }
    ]
});

module.exports = SpiritBeastPvpMatch;
