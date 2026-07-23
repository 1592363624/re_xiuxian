/**
 * 洞天绘卷题词记录模型
 *
 * 存储玩家对他人洞天绘卷的题词（诗意评价）。
 * 洞天绘卷系统：洞府全景展示 + 风貌评级排行 + 题词互动。
 *
 * 业务说明：
 *   - target_player_id：被题词的洞府主人（绘卷所属者）
 *   - inscriber_id：题词者（查看绘卷后留下评价的玩家）
 *   - content：题词内容，限 20 字，由后端校验长度
 *   - 被题词的洞府主人可获得声望奖励（每日上限，见 cave_data.json scroll.inscribe 配置）
 *   - 每个洞府最多保留最近 N 条题词（超限时自动清理最旧记录）
 *
 * 关联表：
 *   - players（target_player_id / inscriber_id → players.id）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveScrollInscription = sequelize.define('CaveScrollInscription', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    target_player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '被题词的洞府主人玩家ID'
    },
    inscriber_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '题词者玩家ID'
    },
    content: {
        type: DataTypes.STRING(60),
        allowNull: false,
        comment: '题词内容（限20字诗意评价）'
    }
}, {
    tableName: 'cave_scroll_inscriptions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false, // 题词记录不修改，无需 updatedAt
    indexes: [
        { fields: ['target_player_id', 'created_at'] },
        { fields: ['inscriber_id', 'created_at'] }
    ]
});

module.exports = CaveScrollInscription;
