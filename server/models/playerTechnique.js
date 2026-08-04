/**
 * 玩家功法模型
 *
 * 存储玩家已习得的功法及其修炼进度。设计说明：
 *   - 功法的静态属性（品阶、加成、五行、解锁条件等）从 technique_data.json 读取（配置中心化）
 *   - 本表只存储玩家侧的动态数据：习得记录、当前层数、熟练度、装备状态、已领悟神通
 *   - equip_slot 区分主修（main）与辅修（auxiliary），null 表示未装备
 *   - comprehended_skills 存已领悟的神通ID数组，与配置中 skills 表对应
 *   - fail_streak 记录连续突破失败次数，用于保底机制（达到阈值必定成功）
 *
 * 字段说明：
 *   - technique_id：功法ID，对应 technique_data.json 中 techniques 的 key
 *   - layer：当前功法层数，从 1 开始，上限由品阶的 max_layer 决定
 *   - proficiency：当前层的熟练度，达到阈值后可尝试突破下一层
 *   - equip_slot：装备槽位（main 主修 / auxiliary 辅修 / null 未装备）
 *   - fail_streak：连续突破失败次数，突破成功后清零
 *   - last_practice_at：上次修炼时间，用于冷却判断
 *   - last_comprehend_at：上次领悟神通时间，用于领悟冷却判断
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerTechnique = sequelize.define('PlayerTechnique', {
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
    technique_id: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '功法ID（对应 technique_data.json 中 techniques 的 key）'
    },
    layer: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '当前功法层数（从1开始，上限由品阶 max_layer 决定）'
    },
    proficiency: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '当前层熟练度，达到阈值后可尝试突破'
    },
    equip_slot: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: null,
        comment: '装备槽位（main 主修 / auxiliary 辅修 / null 未装备）'
    },
    comprehended_skills: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: [],
        comment: '已领悟的神通ID数组'
    },
    fail_streak: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '连续突破失败次数（用于保底机制，突破成功后清零）'
    },
    practice_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '该功法累计修炼次数'
    },
    daily_practice_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日修炼次数（跨天自动重置）'
    },
    daily_practice_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '今日修炼次数对应的日期，用于跨天重置判断'
    },
    last_practice_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次修炼时间，用于冷却判断'
    },
    last_comprehend_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次领悟神通时间，用于领悟冷却判断'
    },
    acquired_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '习得该功法的时间'
    }
}, {
    tableName: 'player_techniques',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
        // 唯一索引：一个玩家同一功法只能习得一次
        {
            unique: true,
            fields: ['player_id', 'technique_id'],
            name: 'uk_player_technique'
        },
        // 辅助索引：按玩家查询所有已习功法
        { fields: ['player_id'] },
        // 辅助索引：快速查询玩家已装备的功法（属性计算高频调用）
        { fields: ['player_id', 'equip_slot'] }
    ]
});

module.exports = PlayerTechnique;
