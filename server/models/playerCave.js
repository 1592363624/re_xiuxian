/**
 * 玩家洞府模型
 *
 * 存储玩家洞府信息：灵脉/静室/丹房/器室/大阵等级、灵脉产出累计、药园地块数等
 * 洞府是个人经营系统，灵脉产灵石、静室增闭关、丹房炼丹、器室炼器、大阵防御
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerCave = sequelize.define('PlayerCave', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '记录ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        unique: true,
        comment: '玩家ID（一人一洞府）'
    },
    is_opened: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否已开辟洞府'
    },
    opened_at: {
        type: DataTypes.DATE,
        comment: '开辟洞府时间'
    },
    // 五大设施等级
    spirit_vein_level: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '灵脉等级（0未建造，1-10）'
    },
    quiet_room_level: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '静室等级（0未建造，1-10）'
    },
    pill_room_level: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '丹房等级（0未建造，1-10）'
    },
    tool_room_level: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '器室等级（0未建造，1-10）'
    },
    grand_formation_level: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '护山大阵等级（0未建造，1-10）'
    },
    // 灵脉产出累计
    spirit_vein_accumulated: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '灵脉累计产出灵石数（已领取的）'
    },
    spirit_vein_pending: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '灵脉待领取灵石数（按时间累计）'
    },
    last_spirit_vein_collect: {
        type: DataTypes.DATE,
        comment: '上次领取灵脉灵石时间（用于计算待领取数）'
    },
    // 药园地块数
    garden_plots: {
        type: DataTypes.INTEGER,
        defaultValue: 3,
        comment: '药园已开垦地块数（初始3，最多9）'
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '创建时间'
    },
    updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: '更新时间'
    }
}, {
    tableName: 'player_caves',
    timestamps: true,
    indexes: [
        { fields: ['player_id'], unique: true }
    ]
});

module.exports = PlayerCave;
