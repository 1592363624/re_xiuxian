/**
 * 玩家宗门成员关系模型
 *
 * 存储玩家与宗门的归属关系及宗门内动态数据（贡献度、身份、点卯、传功、日常任务进度等）。
 * 设计说明：
 *   - 宗门的静态属性（名称、描述、宝库、任务）从 sect_data.json 读取（配置中心化）
 *   - 玩家在宗门中的动态数据（贡献度、身份、点卯/传功时间、任务完成情况）存数据库
 *   - 一个玩家同时只能加入一个宗门（player_id 唯一索引约束）
 *   - daily_quests_completed 字段使用 TEXT 存 JSON 数组，通过 get/set 访问器自动序列化
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerSect = sequelize.define('PlayerSect', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: 'uk_player_sect',
        comment: '玩家ID（一个玩家只能加入一个宗门）'
    },
    sect_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '宗门ID（对应 sect_data.json 的 sects[].id，如 luoyun/xinggong 等）'
    },
    contribution: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '宗门贡献度（用于兑换宝库物品）'
    },
    role: {
        type: DataTypes.STRING(20),
        defaultValue: 'disciple',
        comment: '在宗门身份（disciple弟子/elder长老）'
    },
    joined_at: {
        type: DataTypes.DATE,
        comment: '加入宗门时间'
    },
    last_check_in: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次点卯时间（用于24小时冷却判断）'
    },
    last_transfer: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次传功时间（用于传功冷却判断）'
    },
    daily_quests_completed: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        comment: '当日已完成任务ID（JSON数组）',
        get() {
            // 读取时反序列化为数组，避免外部手动 JSON.parse
            const rawValue = this.getDataValue('daily_quests_completed');
            try {
                return rawValue ? JSON.parse(rawValue) : [];
            } catch (e) {
                // 容错：数据损坏时返回空数组，避免单条脏数据阻塞整个接口
                return [];
            }
        },
        set(value) {
            // 写入时序列化为字符串存储
            this.setDataValue('daily_quests_completed', JSON.stringify(value || []));
        }
    },
    quests_reset_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '任务重置时间（用于判断每日任务是否需要清零）'
    }
}, {
    tableName: 'player_sects',
    timestamps: true,
    indexes: [
        // 辅助索引：按宗门查询成员列表
        { fields: ['sect_id'] }
    ]
});

module.exports = PlayerSect;
