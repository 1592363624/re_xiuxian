/**
 * 宗门战参战记录模型
 *
 * 每条记录代表一个玩家参与一次战役的完整数据
 * (war_id, player_id) 唯一，使用 UPSERT 累加击杀/伤害
 *
 * 关键字段：
 *   - side：阵营（attacker/defender），加入战役时确定
 *   - contribution_score：贡献分，用于战役结算时分配奖励
 *   - honor_rewarded/spirit_stone_rewarded：已发放奖励（防重复）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SectWarParticipant = sequelize.define('SectWarParticipant', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    war_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '战役ID'
    },
    player_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称'
    },
    sect_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '所属宗门ID'
    },
    sect_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '所属宗门名'
    },
    side: {
        type: DataTypes.STRING(10),
        allowNull: false,
        comment: '阵营：attacker/defender'
    },
    kill_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '击杀数'
    },
    death_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '死亡数'
    },
    damage_dealt: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '造成伤害'
    },
    damage_taken: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '承受伤害'
    },
    contribution_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '贡献分'
    },
    honor_rewarded: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '已发放荣誉'
    },
    spirit_stone_rewarded: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '已发放灵石'
    },
    is_online: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否在线参战'
    },
    join_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '加入时间'
    },
    leave_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '离开时间'
    }
}, {
    tableName: 'sect_war_participants',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['war_id', 'player_id'], unique: true },
        { fields: ['war_id'] },
        { fields: ['player_id'] },
        { fields: ['sect_id', 'war_id'] }
    ]
});

module.exports = SectWarParticipant;
