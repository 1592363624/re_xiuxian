/**
 * 玩家元神残篇记录模型
 *
 * 记录玩家获取「凝识/分念/控傀/千机/衍神」5 类残篇的流水：
 *   - ning_shi（凝识残篇）：LDC 商店购买（500 LDC）
 *   - fen_nian（分念残篇）：LDC 商店购买（500 LDC）
 *   - kong_gui（控傀残篇）：昆吾山副本掉落
 *   - qian_ji（千机残篇）：苍坤洞府掉落
 *   - yan_shen（衍神残篇）：青元子世界 Boss 掉落（最稀有）
 *
 * 凝练第二元神需收集 5 类残篇各 1 份，本表为审计与统计用流水表。
 * 与玩家表 N:1 关系（一个玩家可多次获得残篇，每次产生一条记录）
 *
 * 关键字段说明：
 *   - fragment_type：5 类残篇配置键
 *   - source：获取来源，对应配置中 fragment_types.<key>.source
 *   - count：本次获得数量（默认 1）
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerSoulFragment = sequelize.define('PlayerSoulFragment', {
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
    fragment_type: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '残篇类型：ning_shi/fen_nian/kong_gui/qian_ji/yan_shen'
    },
    fragment_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '残篇名（凝识残篇/分念残篇/控傀残篇/千机残篇/衍神残篇）'
    },
    source: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '获取来源：ldc_shop/kunwu_mountain/cangkun_dungeon/qingyuanzi_boss'
    },
    count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '数量'
    },
    obtained_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '获取时间'
    }
}, {
    tableName: 'player_soul_fragment',
    timestamps: false,
    underscored: true,
    indexes: [
        { fields: ['player_id', 'fragment_type'], name: 'idx_psf_player_type' },
        { fields: ['obtained_at'], name: 'idx_psf_obtained' }
    ]
});

module.exports = PlayerSoulFragment;
