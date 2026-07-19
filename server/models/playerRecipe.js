/**
 * 玩家炼制配方模型
 *
 * 存储玩家已学习的炼制配方及炼制技能信息。设计说明：
 *   - 配方的静态属性（材料、成功率、产物等）从 crafting_data.json 读取（配置中心化）
 *   - 本表存储 player_id + recipe_id + 炼制技能经验/等级 + 冷却时间
 *   - learn_source 为 "default" 的配方在玩家创建时自动学习，其余需通过丹方/图谱学习
 *   - skill_exp 和 skill_level 记录玩家的炼制技能成长，等级越高成功率加成越大
 *   - last_craft_at 用于冷却时间判断，防止频繁炼制
 *
 * 字段说明：
 *   - recipe_id：配方ID，对应 crafting_data.json 中配方的 id
 *   - craft_type：炼制类型（alchemy 炼丹 / refining 炼器），便于分类查询
 *   - craft_count：该配方的累计炼制次数
 *   - skill_exp：炼制技能经验值（所有配方共享同一技能等级）
 *   - skill_level：炼制技能等级（1~10），影响成功率加成
 *   - last_craft_at：上次炼制时间，用于冷却判断
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerRecipe = sequelize.define('PlayerRecipe', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    recipe_id: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '配方ID（对应 crafting_data.json 中配方的 id）'
    },
    craft_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '炼制类型（alchemy 炼丹 / refining 炼器）'
    },
    craft_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '该配方累计炼制次数'
    },
    skill_exp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '炼制技能经验值（所有配方共享同一技能等级）'
    },
    skill_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '炼制技能等级（1~10），影响成功率加成'
    },
    last_craft_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次炼制时间，用于冷却判断'
    }
}, {
    tableName: 'player_recipes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
        // 唯一索引：一个玩家同一配方只能学习一次
        {
            unique: true,
            fields: ['player_id', 'recipe_id'],
            name: 'uk_player_recipe'
        },
        // 辅助索引：按玩家查询所有已学配方
        { fields: ['player_id'] },
        // 辅助索引：按炼制类型分类查询
        { fields: ['player_id', 'craft_type'] }
    ]
});

module.exports = PlayerRecipe;
