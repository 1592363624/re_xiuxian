/**
 * 洞天寻宝日志模型
 *
 * 存储玩家在他人洞府进行寻宝操作的记录
 * 表名：cave_treasure_logs
 *
 * result_type 字段记录寻宝结果类型：
 *   - treasure: 寻得宝物（获得灵石/修为/物品）
 *   - trap: 触发陷阱（HP损失/灵石损失）
 *   - encounter: 遭遇护阵（灵石损失）
 *   - empty: 一无所获
 *
 * rewards 字段以 JSON 存储具体奖励/损失明细，如：
 *   {"spirit_stones": 150, "exp": 200, "item_id": "golden_ore", "hp_loss": 300}
 *
 * is_discovered 字段记录寻宝失败时是否被洞府主人发现，
 * 被发现时洞府主人会收到通知，且双方增加仇怨值
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const CaveTreasureLog = sequelize.define('CaveTreasureLog', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    hunter_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '寻宝者玩家ID'
    },
    cave_owner_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '洞府主人玩家ID'
    },
    plot_number: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '探索地块编号（1-9）'
    },
    result_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '寻宝结果类型：treasure/trap/encounter/empty'
    },
    rewards: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null,
        comment: '奖励/损失明细 JSON（如 {"spirit_stones":150,"exp":200,"item_id":"golden_ore","hp_loss":300}）',
        get() {
            const raw = this.getDataValue('rewards');
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        },
        set(val) {
            this.setDataValue('rewards', val ? JSON.stringify(val) : null);
        }
    },
    is_discovered: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否被洞府主人发现（寻宝失败时按概率触发）'
    }
}, {
    tableName: 'cave_treasure_logs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
});

module.exports = CaveTreasureLog;
