/**
 * 夺舍目标配置模型
 *
 * 飞升失败/死亡后夺舍重生的目标池配置表，存储可夺舍的凡人/修士/妖兽的基础属性：
 *   - 凡人（mortal）：风险等级低，属性低，跌落少，成功率高
 *   - 修士（cultivator）：风险等级中，属性中，跌落中，成功率中
 *   - 妖兽（monster）：风险等级高，属性高，跌落多，成功率低
 *
 * 表中预置 3 条种子数据（migration_0030 中插入），GM 可通过后台新增/编辑目标
 * 出现概率按 weight 字段加权随机
 *
 * 关键字段说明：
 *   - inherit_ratio：属性继承比例（0.3-0.7），影响夺舍后属性强弱
 *   - drop_realm_count：夺舍后境界跌落数（1-3），化神→元婴=1，化神→金丹=2
 *   - risk_level：风险等级（1低-3高），影响夺舍成功率
 *       1 - 90% 成功率
 *       2 - 70% 成功率
 *       3 - 50% 成功率
 *   - is_rare：稀有目标，属性更好但出现概率更低
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ReincarnationTarget = sequelize.define('ReincarnationTarget', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    target_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: 'uk_rt_target_key',
        comment: '目标配置键（如 mortal_warrior_03）'
    },
    target_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '目标显示名'
    },
    target_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '目标类型：mortal=凡人，cultivator=修士，monster=妖兽'
    },
    realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '目标境界rank（夺舍后跌落基准）'
    },
    base_atk: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '基础攻击'
    },
    base_def: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '基础防御'
    },
    base_hp_max: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '基础气血上限'
    },
    base_speed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '基础速度'
    },
    base_sense: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '基础神识'
    },
    spirit_root_grade: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '灵根资质（伪灵根/单灵根/双灵根等）'
    },
    talent_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '天赋ID（部分目标自带特殊天赋）'
    },
    inherit_ratio: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0.5,
        comment: '属性继承比例（0.3-0.7）'
    },
    drop_realm_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '夺舍后境界跌落数（1-3）'
    },
    risk_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '风险等级（1低-3高，影响成功率）'
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '目标背景描述'
    },
    weight: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '出现权重（影响推送概率）'
    },
    is_rare: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否稀有目标（0否1是，稀有目标属性更好）'
    }
}, {
    tableName: 'reincarnation_target',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['target_type'] },
        { fields: ['risk_level'] }
    ]
});

module.exports = ReincarnationTarget;
