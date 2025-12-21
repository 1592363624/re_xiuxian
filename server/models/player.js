/**
 * 玩家数据模型
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Player = sequelize.define('Player', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        comment: '登录账号'
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '加密密码'
    },
    nickname: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '游戏昵称'
    },
    realm: {
        type: DataTypes.STRING,
        defaultValue: '凡人',
        comment: '当前境界'
    },
    exp: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '当前修为'
    },
    spirit_stones: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '灵石数量'
    },
    hp_current: {
        type: DataTypes.BIGINT,
        defaultValue: 100,
        comment: '当前气血'
    },
    mp_current: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '当前灵力'
    },
    toxicity: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '丹毒值'
    },
    lifespan_current: {
        type: DataTypes.FLOAT,
        defaultValue: 16,
        comment: '当前年龄'
    },
    lifespan_max: {
        type: DataTypes.INTEGER,
        defaultValue: 60,
        comment: '最大寿元'
    },
    attributes: {
        type: DataTypes.TEXT,
        defaultValue: JSON.stringify({
            hp_max: 100,
            mp_max: 0,
            atk: 10,
            def: 5,
            speed: 10,
            sense: 10
        }),
        get() {
            const rawValue = this.getDataValue('attributes');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('attributes', JSON.stringify(value));
        },
        comment: '基础属性JSON'
    },
    token_version: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'Token版本号，用于单点登录控制'
    },
    role: {
        type: DataTypes.STRING,
        defaultValue: 'user', // user, admin
        comment: '用户角色'
    },
    is_secluded: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否闭关中'
    },
    seclusion_start_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '闭关开始时间'
    },
    seclusion_duration: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '计划闭关时长(秒)'
    },
    last_online: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后在线时间'
    },
    last_seclusion_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后闭关结束时间'
    }
}, {
    tableName: 'players',
    timestamps: true
});

module.exports = Player;
