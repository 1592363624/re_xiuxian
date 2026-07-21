/**
 * 玩家神识对决模型
 *
 * 神识对决是 1v1 实时 PvP 神识小游戏，带赌注机制：
 *   - 双方同时选择行动（凝神 focus / 固元 stabilize），然后同时结算
 *   - 凝神：消耗 15 点自身护盾，对对手造成 20 点伤害
 *   - 固元：恢复 10 点护盾，本回合受到伤害减半
 *   - 双方都固元：各自恢复 5 点护盾（恢复减半）
 *   - 初始护盾 100，护盾上限 100，回合上限 20
 *   - 胜负判定：护盾 <= 0 失败；20 回合后护盾高者胜；相同则平局
 *
 * 与玩家表 N:1 关系（一个玩家可参与多场对局）
 *
 * 关键字段说明：
 *   - status：对局生命周期状态
 *       pending  - 待接受（发起后 60s 未接受自动取消）
 *       active   - 进行中
 *       finished - 已结束（已结算）
 *       cancelled- 已取消（发起方撤回或超时）
 *   - winner_id：胜者ID（null=平局或未结束）
 *   - settle_reason：结算原因
 *       shield_zero  - 护盾归零
 *       rounds_limit - 回合上限
 *       surrender    - 投降
 *       timeout      - 超时（暂未使用，预留扩展）
 *   - challenger_action / defender_action：本回合双方行动
 *       focus     - 凝神（攻击）
 *       stabilize - 固元（防御+恢复）
 *       null      - 未提交
 *   - action_deadline：本回合操作截止时间（60s 后过期自动固元）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerDivineDuel = sequelize.define('PlayerDivineDuel', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '对局主键ID'
    },
    challenger_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '发起方玩家ID'
    },
    defender_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '应战方玩家ID'
    },
    bet_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '赌注类型：spirit_stone/divine_sense'
    },
    bet_amount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '赌注数量'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'pending/active/finished/cancelled'
    },
    winner_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '胜者ID（null=平局或未结束）'
    },
    challenger_shield: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '发起方神识护盾'
    },
    defender_shield: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '应战方神识护盾'
    },
    challenger_action: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '发起方本回合行动：focus/stabilize'
    },
    defender_action: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '应战方本回合行动：focus/stabilize'
    },
    round_number: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前回合数'
    },
    action_deadline: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '本回合操作截止时间'
    },
    settle_reason: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '结算原因：shield_zero/rounds_limit/surrender/timeout'
    },
    finished_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '对局结束时间'
    }
}, {
    tableName: 'player_divine_duels',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['challenger_id'] },
        { fields: ['defender_id'] },
        { fields: ['status'] },
        { fields: ['action_deadline'] }
    ]
});

module.exports = PlayerDivineDuel;
