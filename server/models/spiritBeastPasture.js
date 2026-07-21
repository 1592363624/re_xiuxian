/**
 * 灵兽放养记录模型
 *
 * 对应数据库表 spirit_beast_pastures，记录玩家灵兽的放养状态：
 *   - 基础信息：player_id / beast_id / location_key / location_name
 *   - 时间信息：start_time / end_time / actual_end_time
 *   - 状态信息：status / recall_type / yield_discount
 *   - 产物信息：yield_snapshot / steal_count / stolen_count / steal_yields
 *   - 快照信息：beast_snapshot（放养时灵兽属性快照）
 *
 * 表设计要点：
 *   - status: active放养中 / recalled已召回 / auto_settled自动结算 / expired已过期
 *   - yield_discount: 提前召回0.0 / 自动结算0.8 / 正常1.0
 *   - beast_snapshot 存储放养时的灵兽属性，避免后续升级影响历史记录
 *   - (player_id, status) 复合索引支撑查询玩家当前放养列表
 *
 * 关联关系：
 *   - 隶属于 Player（player_id → players.id）
 *   - 关联 SpiritBeast（beast_id → spirit_beasts.id）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpiritBeastPasture = sequelize.define('SpiritBeastPasture', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '放养记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属玩家ID'
    },
    beast_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '灵兽实例ID'
    },
    beast_snapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '放养时灵兽快照（名称/属性/元素/星级/等级）',
        get() {
            const val = this.getDataValue('beast_snapshot');
            return val || null;
        }
    },
    location_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '放养场所key（如 qingyun_mountain）'
    },
    location_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '放养场所名称（如 青云山）'
    },
    start_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '放养开始时间'
    },
    end_time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '放养预计结束时间'
    },
    actual_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '实际结束时间（召回/自动结算时填充）'
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        comment: '放养状态：active放养中/recalled已召回/auto_settled自动结算/expired已过期'
    },
    recall_type: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '召回类型：manual手动/auto自动/early提前'
    },
    yield_snapshot: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '产物快照（结算时填充，含物品ID/数量/品质）',
        get() {
            const val = this.getDataValue('yield_snapshot');
            return val || null;
        }
    },
    steal_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本期间偷菜成功次数'
    },
    stolen_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '本期间被偷次数'
    },
    steal_yields: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: '偷菜收获快照',
        get() {
            const val = this.getDataValue('steal_yields');
            return val || null;
        }
    },
    yield_discount: {
        type: DataTypes.DECIMAL(3, 2),
        allowNull: false,
        defaultValue: 1.00,
        comment: '产物折扣（提前召回0/自动结算0.8/正常1.0）',
        get() {
            const val = this.getDataValue('yield_discount');
            return Number(val);
        }
    }
}, {
    tableName: 'spirit_beast_pastures',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['player_id'], name: 'idx_pasture_player' },
        { fields: ['beast_id'], name: 'idx_pasture_beast' },
        { fields: ['status'], name: 'idx_pasture_status' },
        { fields: ['end_time'], name: 'idx_pasture_end_time' },
        { fields: ['player_id', 'status'], name: 'idx_pasture_player_status' }
    ]
});

module.exports = SpiritBeastPasture;
