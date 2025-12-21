/**
 * 境界数据模型
 * 存储各境界的基础属性数值
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Realm = sequelize.define('Realm', {
    name: {
        type: DataTypes.STRING,
        primaryKey: true,
        comment: '境界名称'
    },
    rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
        comment: '境界排序(等级)'
    },
    exp_cap: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '当前境界修为上限(达到后可突破)'
    },
    base_hp: {
        type: DataTypes.BIGINT,
        defaultValue: 100,
        comment: '基础气血'
    },
    base_atk: {
        type: DataTypes.BIGINT,
        defaultValue: 10,
        comment: '基础攻击'
    },
    base_def: {
        type: DataTypes.BIGINT,
        defaultValue: 5,
        comment: '基础防御'
    },
    base_speed: {
        type: DataTypes.INTEGER,
        defaultValue: 10,
        comment: '基础速度'
    },
    base_mp: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '基础灵力'
    },
    base_sense: {
        type: DataTypes.BIGINT,
        defaultValue: 10,
        comment: '基础神识'
    },
    base_lifespan: {
        type: DataTypes.INTEGER,
        defaultValue: 60,
        comment: '基础寿命(年)'
    },
    mp_regen_rate: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '灵力恢复速度/小时'
    },
    toxicity_decay: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '丹毒自然衰减/天'
    }
}, {
    tableName: 'realms',
    timestamps: false
});

module.exports = Realm;
