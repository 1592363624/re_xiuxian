/**
 * 坐化遗府参与者模型
 *
 * 对应表 cave_legacy_participants：参与分宝的玩家记录，含资格校验结果和分宝权重
 *
 * 字段说明：
 *   - legacy_id：所属遗府ID
 *   - player_id：参与玩家ID（唯一索引 legacy_id + player_id，一人一遗府一行）
 *   - player_nickname_snapshot：玩家昵称快照
 *   - player_ip_snapshot：玩家IP快照（同主魂识别，防止小号领取）
 *   - eligible：是否合格（0=不合格但记录尝试，1=合格可分宝）
 *   - ineligibility_reason：不合格原因（NULL=合格）
 *   - weight：分宝权重（合格玩家参与分宝的权重值）
 *   - lucky_factor：幸运因子（0.80~1.20，每次参与时随机生成）
 *   - has_spun：是否已转动分宝（每期每人只能转动一次）
 *   - spun_at：转动时间
 *   - total_item_types：分得物品种类数
 *   - total_quantity：分得总数量
 *   - claimed_at：领取时间
 *
 * 设计要点：
 *   - 同主魂唯一领取：Service 层查询同 legacy_id 下所有 participant.player_ip_snapshot，
 *     若有相同的 IP 且对应玩家已 has_spun=true，则拒绝本次分宝
 *   - 资格校验：通过 cave_legacy_data.json -> eligibility 规则，未达标玩家标记 eligible=false
 *   - 权重计算：weight = log10(exp + 10) * coeff_exp + log10(online_min + 1) * coeff_online
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveLegacyParticipant = sequelize.define('CaveLegacyParticipant', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    legacy_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '所属遗府ID'
    },
    player_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '参与玩家ID'
    },
    player_nickname_snapshot: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '玩家昵称快照'
    },
    player_ip_snapshot: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '玩家IP快照（同主魂识别）'
    },
    eligible: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否合格（0=不合格，1=合格）'
    },
    ineligibility_reason: {
        type: DataTypes.STRING(200),
        allowNull: true,
        comment: '不合格原因'
    },
    weight: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        comment: '分宝权重'
    },
    lucky_factor: {
        type: DataTypes.DECIMAL(4, 2),
        allowNull: false,
        defaultValue: 1.00,
        comment: '幸运因子（0.80~1.20）'
    },
    has_spun: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否已转动分宝（0=未转，1=已转）'
    },
    spun_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '转动时间'
    },
    total_item_types: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '分得物品种类数'
    },
    total_quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '分得总数量'
    },
    claimed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '领取时间'
    }
}, {
    tableName: 'cave_legacy_participants',
    timestamps: true,
    underscored: true,
    indexes: [
        // 唯一索引：一玩家在同一遗府只能有一行记录
        {
            unique: true,
            fields: ['legacy_id', 'player_id'],
            name: 'uk_clp_legacy_player'
        },
        { fields: ['player_id'] },
        { fields: ['legacy_id', 'eligible'] },
        { fields: ['legacy_id', 'has_spun'] }
    ]
});

module.exports = CaveLegacyParticipant;
