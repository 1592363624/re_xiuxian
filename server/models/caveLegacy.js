/**
 * 坐化遗府活动主模型
 *
 * 对应表 cave_legacies：存储遗府活动的元数据（坐化玩家/状态/时间/统计/结算摘要）
 *
 * 与其他模型关系：
 *   - 1:N -> CaveLegacyItem（遗府可分配物品）
 *   - 1:N -> CaveLegacyParticipant（参与分宝的玩家）
 *   - 1:N -> CaveLegacyDistributionLog（分配日志）
 *
 * 状态机：
 *   preview  -> open    （管理员调用 .open 接口）
 *   open     -> closed  （管理员手动关闭或到期自动关闭）
 *   closed   -> 终态    （已结算完成）
 *
 * 关键字段说明：
 *   - owner_player_id：坐化玩家ID（已退坑/死亡），保留以备审计与回溯
 *   - owner_nickname_snapshot：坐化玩家昵称快照（玩家改名后仍可追溯）
 *   - owner_ip_snapshot：坐化玩家IP快照（用于同主魂识别，防止小号领取）
 *   - status：preview/open/closed/expired
 *   - settled：是否已结算（true=已生成参与者分配结果，false=待结算）
 *   - close_reason：admin_close（管理员关闭）/ expired（自动过期）/ auto_close（自动结算关闭）
 *   - summary_json：结算摘要 JSON，记录未分配物品的处理结果
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveLegacy = sequelize.define('CaveLegacy', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '遗府活动ID'
    },
    owner_player_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '坐化玩家ID（已退坑/死亡）'
    },
    owner_nickname_snapshot: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '坐化玩家昵称快照'
    },
    owner_ip_snapshot: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '坐化玩家IP快照（同主魂识别）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'preview',
        comment: 'preview/open/closed/expired'
    },
    duration_hours: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 24,
        comment: '活动时长（小时）'
    },
    started_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '开启时间'
    },
    ends_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '计划结束时间'
    },
    closed_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '实际关闭时间'
    },
    opened_by_admin: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '开启操作的管理员ID'
    },
    closed_by_admin: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '关闭操作的管理员ID（null=自动关闭）'
    },
    items_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '可分配物品种类数'
    },
    items_total_quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '可分配物品总数量'
    },
    participants_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '参与分宝的玩家数'
    },
    settled: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否已结算（0=未结算，1=已结算）'
    },
    close_reason: {
        type: DataTypes.STRING(30),
        allowNull: true,
        comment: '关闭原因：admin_close/expired/auto_close'
    },
    summary_json: {
        type: DataTypes.TEXT,
        allowNull: true,
        get() {
            const rawValue = this.getDataValue('summary_json');
            return rawValue ? JSON.parse(rawValue) : null;
        },
        set(value) {
            this.setDataValue('summary_json', value ? JSON.stringify(value) : null);
        },
        comment: '结算摘要 JSON'
    }
}, {
    tableName: 'cave_legacies',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['owner_player_id'] },
        { fields: ['status'] },
        { fields: ['ends_at'] }
    ]
});

module.exports = CaveLegacy;
