/**
 * 玩家系统任务（尘缘指归）模型
 *
 * 一条独立线性链：每人一行。静态节点在 config/system_quest_data.json，
 * 本表只记当前指针、当前环进度与已完成节点顺序。
 * 完成当前环由服务在事务内自动发奖并把指针推到下一环（无手动领取）。
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerSystemQuest = sequelize.define('PlayerSystemQuest', {
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
    chain_id: {
        type: DataTypes.STRING(32),
        allowNull: false,
        defaultValue: 'zhigui',
        comment: '任务链ID（当前仅 zhigui）'
    },
    current_node_id: {
        type: DataTypes.STRING(64),
        allowNull: true,
        defaultValue: null,
        comment: '当前环节点ID；status=done 且为 null 表示已归尘'
    },
    status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'active',
        comment: 'active 进行中 / done 全链完成'
    },
    progress: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '当前环进度 JSON：{ actionCounts, flags, satisfiedBy }'
    },
    completed_nodes: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '已完成节点ID JSON 数组（完成顺序）'
    },
    completed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '全链完成时间'
    }
}, {
    tableName: 'player_system_quests',
    indexes: [
        {
            unique: true,
            name: 'uk_player_system_quest',
            fields: ['player_id', 'chain_id']
        }
    ]
});

module.exports = PlayerSystemQuest;
