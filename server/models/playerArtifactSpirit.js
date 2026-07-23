/**
 * 玩家法宝器灵模型
 *
 * 存储玩家已唤醒的法宝器灵信息。设计说明：
 *   - 器灵附着在已装备的法宝上（关联 player_equipment.id），每件法宝只能唤醒一个器灵
 *   - 器灵4种类型（attack攻灵/defense防灵/support辅灵/balance平灵）影响战斗加成
 *   - 多维度养成：等级/经验/亲密度/力量值，养成路径丰富
 *   - 试炼累计分数（trial_total_score）用于全服排行榜（多人竞争维度）
 *   - 状态机：idle 待机 / protecting 护主中 / activating 催发中
 *
 * 对应玩法文档：第7节装备炼制与法宝 + 第895-909行 法宝、器灵与徽章
 *
 * 器灵8大子功能：
 *   1. 唤醒器灵：消耗资源唤醒，绑定到指定法宝
 *   2. 我的器灵：查看已唤醒器灵列表
 *   3. 器灵试炼：测试器灵战力，获取奖励，排行竞争
 *   4. 器灵护主：开启护主状态，战斗中减伤/反弹/回血
 *   5. 催发器灵：临时强化属性，限时爆发
 *   6. 抚摸法宝：增加亲密度（CD冷却）
 *   7. 温养器灵：增加力量值（CD冷却+消耗）
 *   8. 器灵试炼榜：全服试炼累计分排行
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerArtifactSpirit = sequelize.define('PlayerArtifactSpirit', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '器灵记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '玩家ID'
    },
    equipment_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '关联player_equipment.id（每件法宝一个器灵）'
    },
    item_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '法宝配置键名（冗余存储便于查询）'
    },
    spirit_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '器灵类型（attack攻灵/defense防灵/support辅灵/balance平灵）'
    },
    spirit_name: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '器灵自定义名称（玩家可命名）'
    },
    spirit_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '器灵等级 1~10'
    },
    spirit_exp: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '器灵当前经验值'
    },
    intimacy: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '亲密度 0~100，影响护主/催发效果'
    },
    power: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '力量值 0~1000，影响试炼分数与催发'
    },
    is_awakened: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否已唤醒（false未唤醒/true已唤醒）'
    },
    awakened_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '唤醒时间'
    },
    last_pet_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次抚摸时间（用于CD计算）'
    },
    last_nurture_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次温养时间（用于CD计算）'
    },
    trial_best_score: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '试炼历史最高分'
    },
    trial_total_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '试炼累计次数'
    },
    trial_total_score: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '试炼累计总分（排行榜依据）'
    },
    last_trial_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次试炼时间'
    },
    last_trial_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '上次试炼日期（用于每日次数重置）'
    },
    daily_trial_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '今日试炼次数'
    },
    protect_active_until: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '护主状态结束时间（null=未护主）'
    },
    activate_active_until: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '催发状态结束时间（null=未催发）'
    },
    last_protect_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次护主时间（CD）'
    },
    last_activate_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次催发时间（CD）'
    },
    state: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'idle',
        comment: '器灵当前状态（idle/protecting/activating）'
    }
}, {
    tableName: 'player_artifact_spirits',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
        // 唯一索引：一个装备只能绑定一个器灵
        {
            unique: true,
            fields: ['player_id', 'equipment_id'],
            name: 'uk_player_equipment'
        },
        // 辅助索引：按玩家查询所有器灵
        { fields: ['player_id'] },
        // 排行榜索引：按累计试炼分数排序
        { fields: ['trial_total_score'] },
        // 排行榜索引：按最高分排序
        { fields: ['trial_best_score'] },
        // 辅助索引：按器灵类型查询（统计/分析用）
        { fields: ['spirit_type'] }
    ]
});

module.exports = PlayerArtifactSpirit;
