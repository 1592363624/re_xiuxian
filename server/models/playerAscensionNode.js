/**
 * 玩家空间节点模型
 *
 * 飞升前置玩法「搜寻节点 + 定星稳固」的节点数据：
 *   1. 玩家通过 .搜寻节点 接口发现不稳定的空间节点（discovered 状态）
 *   2. 调用 .定星<节点名> 开始稳固节点（stabilizing 状态），消耗神识/灵石
 *   3. 稳固完成后变为 stable 状态，获得逆灵通道坐标/丹方/灵乳/法则碎片奖励
 *   4. 未及时稳固的节点会自动过期消失（expires_at 控制）
 *
 * 与玩家表 N:1 关系（一个玩家可同时拥有多个节点，但 (player_id, node_key) 唯一）
 *
 * 关键字段说明：
 *   - node_state：节点生命周期
 *       discovered - 已发现，等待玩家定星
 *       stabilizing - 定星中（神识消耗阶段）
 *       stable     - 已稳固，可领取奖励
 *       failed     - 稳固失败（神识不足/反噬）
 *   - stability：稳固度，0-100，达 80 时可触发奖励结算
 *   - reward_type：稳固成功后的奖励类型
 *       coord       - 逆灵通道坐标（飞升核心材料）
 *       dan_recipe  - 虚灵丹丹方
 *       spirit_milk - 万年灵乳
 *       law_fragment - 空间法则碎片
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerAscensionNode = sequelize.define('PlayerAscensionNode', {
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
    node_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '节点配置键（如 unstable_void_01）'
    },
    node_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '节点显示名（如「虚空中裂痕」）'
    },
    node_state: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'discovered',
        comment: '节点状态：discovered/stabilizing/stable/failed'
    },
    stability: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '稳固度（0-100，达80可定星）'
    },
    reward_type: {
        type: DataTypes.STRING(30),
        allowNull: true,
        comment: '稳固成功奖励类型：coord/dan_recipe/spirit_milk/law_fragment'
    },
    reward_claimed: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '奖励是否已领取（0否1是）'
    },
    discovered_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '发现时间'
    },
    stabilize_started_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '开始稳固时间'
    },
    stabilized_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '稳固完成时间'
    },
    expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '节点消失时间（未稳固则消失）'
    }
}, {
    tableName: 'player_ascension_node',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'node_key'], unique: true, name: 'uk_pan_player_node' },
        { fields: ['player_id', 'node_state'] },
        { fields: ['expires_at'] }
    ]
});

module.exports = PlayerAscensionNode;
