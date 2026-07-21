/**
 * 侍妾远航记录模型
 *
 * 远航是侍妾的核心产出玩法，4 种模式风险与收益递增：
 *   - safe（稳妥）：4 小时，风险 0.5，收益 0.6
 *   - balanced（均衡）：8 小时，风险 1.0，收益 1.0
 *   - risky（冒险）：12 小时，风险 1.5，收益 1.8
 *   - moon_palace（月殿寻痕）：24 小时，风险 2.0，收益 3.0（需魅力≥80）
 *
 * 表设计：status 字段记录远航状态（voyaging/returned/interrupted）
 * JSON 字段 rewards 在 Model 中配置 getter/setter 自动处理
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ConcubineVoyage = sequelize.define('ConcubineVoyage', {
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
    concubine_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '侍妾ID'
    },
    voyage_mode: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '远航模式：safe/balanced/risky/moon_palace'
    },
    started_at: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '开始时间'
    },
    expected_end_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '预计归来时间'
    },
    actual_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '实际归来时间'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'voyaging',
        comment: '状态：voyaging=远航中，returned=已归来，interrupted=被打断'
    },
    rewards: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '奖励JSON（待领取）',
        get() {
            const rawValue = this.getDataValue('rewards');
            return rawValue ? JSON.parse(rawValue) : null;
        },
        set(value) {
            this.setDataValue('rewards', value ? JSON.stringify(value) : null);
        }
    },
    risk_modifier: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1.0,
        comment: '风险系数（safe=0.5，balanced=1.0，risky=1.5，moon_palace=2.0）'
    },
    reward_multiplier: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 1.0,
        comment: '收益系数（safe=0.6，balanced=1.0，risky=1.8，moon_palace=3.0）'
    },
    is_collected: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '奖励是否已领取'
    }
}, {
    tableName: 'concubine_voyage',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'status'], name: 'idx_cv_player_status' },
        { fields: ['expected_end_time'], name: 'idx_cv_end_time' },
        { fields: ['concubine_id'], name: 'idx_cv_concubine' }
    ]
});

module.exports = ConcubineVoyage;
