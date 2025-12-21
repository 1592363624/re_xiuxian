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
    lifespan_current: {
        type: DataTypes.INTEGER,
        defaultValue: 16,
        comment: '当前年龄'
    },
    lifespan_max: {
        type: DataTypes.INTEGER,
        defaultValue: 100,
        comment: '最大寿元'
    },
    attributes: {
        type: DataTypes.TEXT,
        defaultValue: JSON.stringify({
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
    }
}, {
    tableName: 'players',
    timestamps: true
});

module.exports = Player;
