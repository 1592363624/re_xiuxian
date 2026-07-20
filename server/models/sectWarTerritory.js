/**
 * 宗门战资源点模型
 *
 * 存储资源点的归属、驻防、产出等动态信息
 * 每个赛季开始时按 territory_key 重新初始化归属
 *
 * 资源点类型：
 *   spirit_vein  - 灵脉，产出灵石（宗门资金）
 *   mine         - 矿脉，产出高级材料
 *   secret_realm - 秘境入口，产出贡献度
 *   strategic    - 战略点，无产出但 +10% 战役胜率
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SectWarTerritory = sequelize.define('SectWarTerritory', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        comment: '资源点ID'
    },
    territory_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '资源点配置键'
    },
    territory_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '资源点名称（如 "青云灵脉"）'
    },
    territory_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '资源点类型：spirit_vein/mine/secret_realm/strategic'
    },
    map_x: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '地图X坐标'
    },
    map_y: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '地图Y坐标'
    },
    owner_sect_id: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '当前占领宗门ID（NULL=无主）'
    },
    owner_sect_name: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: '当前占领宗门名'
    },
    owner_since: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '占领起始时间'
    },
    defense_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '驻防等级（1-10）'
    },
    defense_formation: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '驻防阵法ID'
    },
    defender_player_ids: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '驻防玩家ID列表（JSON数组）',
        get() {
            const raw = this.getDataValue('defender_player_ids');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch { return []; }
        },
        set(value) {
            this.setDataValue('defender_player_ids', Array.isArray(value) ? JSON.stringify(value) : '[]');
        }
    },
    daily_production: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '每日产出量'
    },
    production_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'spirit_stones',
        comment: '产出类型：spirit_stones/materials/contribution'
    },
    is_under_attack: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否正在被攻击（0否1是）'
    },
    last_battle_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '上次战斗时间'
    },
    season_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '所属赛季'
    }
}, {
    tableName: 'sect_war_territories',
    timestamps: true,
    underscored: true,
    indexes: [
        { fields: ['territory_key', 'season_id'], unique: true },
        { fields: ['owner_sect_id'] },
        { fields: ['season_id'] }
    ]
});

module.exports = SectWarTerritory;