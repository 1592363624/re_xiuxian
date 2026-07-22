/**
 * 切磋木人记录模型
 *
 * 对应数据库表 player_sparring，记录玩家与木人傀儡切磋的完整信息：
 *   - 基础信息：player_id / woodman_tier / woodman_key / woodman_name
 *   - 战斗数据：rounds_used / player_hp_remaining / player_hp_max / player_mp_used
 *     total_damage_dealt / total_damage_taken
 *   - 结果与评分：result（win/lose/timeout）/ score / is_first_clear
 *   - 奖励：exp_gained / spirit_stones_gained / title_awarded
 *   - 时间：created_at / settled_at
 *
 * 表设计要点：
 *   - 5 个索引覆盖常见查询：player / player+date / score / tier+date / created_at
 *   - score 字段单独索引，支持排行榜快速排序
 *   - battle_log 使用 TEXT 类型存储 JSON 格式战斗日志（可选）
 *
 * 关联关系：
 *   - belongsTo Player（通过 player_id）
 *
 * @author 修仙游戏开发组
 * @created 2026-07-21
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerSparring = sequelize.define('PlayerSparring', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    player_nickname: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '玩家昵称（冗余便于排行展示）'
    },
    player_realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '玩家境界rank（冗余便于排行展示）'
    },
    player_realm_name: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '玩家境界名（冗余便于排行展示）'
    },
    woodman_tier: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '木人档次（1-5）'
    },
    woodman_key: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '木人键（qi_refining/foundation/core_formation/nascent_soul/spirit_severing）'
    },
    woodman_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '木人名称（炼气木人/筑基木人/...）'
    },
    rounds_used: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '战斗使用回合数'
    },
    max_rounds: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 30,
        comment: '最大回合数上限'
    },
    player_hp_remaining: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '玩家剩余HP'
    },
    player_hp_max: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '玩家最大HP'
    },
    player_mp_used: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '玩家消耗MP'
    },
    total_damage_dealt: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '对木人造成的总伤害'
    },
    total_damage_taken: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '受到木人的总伤害'
    },
    result: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '切磋结果（win/lose/timeout）'
    },
    score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '战力评分（基础分+效率分+HP保留分+完美分）'
    },
    is_first_clear: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否首次击败该档次木人（0否1是）'
    },
    exp_gained: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '获得修为'
    },
    spirit_stones_gained: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '获得灵石'
    },
    title_awarded: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '获得的称号ID（如有）'
    },
    battle_log: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '战斗日志（JSON格式，可选存储）'
    },
    settled_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '排行榜结算时间（如参与每日结算）'
    }
}, {
    tableName: 'player_sparring',
    timestamps: true,
    underscored: true,
    // 切磋记录为一次性写入（创建后不再修改），无需 updated_at 字段
    // 表中只有 created_at 列，故禁用 updatedAt 避免 Sequelize 查询不存在的字段
    updatedAt: false,
    createdAt: 'created_at',
    indexes: [
        { fields: ['player_id'], name: 'idx_ps_player' },
        { fields: ['player_id', 'created_at'], name: 'idx_ps_player_date' },
        { fields: ['score'], name: 'idx_ps_score' },
        { fields: ['woodman_tier', 'created_at'], name: 'idx_ps_tier_date' },
        { fields: ['created_at'], name: 'idx_ps_created' }
    ]
});

module.exports = PlayerSparring;
