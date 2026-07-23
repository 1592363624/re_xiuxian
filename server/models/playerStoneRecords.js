/**
 * 玩家原石记录模型
 *
 * 存储玩家赌石系统中生成的每一块原石（N 与 player_gambling_stone 表关系）：
 *   - 原石基础信息（产地/品质/基础价/生成时间）
 *   - 4维线索（皮壳/重量/灵气/色泽，可能含假线索）
 *   - 真实品质（玩家不可见，切开时校验）
 *   - 切开状态与产出（切法/时间/产出JSON/等价价值）
 *   - 上架拍卖行状态（未切开原石可流转，切开后不可交易）
 *
 * 玩法文档对照：第21节·经济与博彩补充
 *   赌石流程是 `.赌石` 生成三块原石，再用 `.切 <编号>` 购买切开。
 *
 * 关键字段说明：
 *   - clues：JSON 字符串，存储4维线索（可能含假线索，玩家根据线索博弈）
 *   - real_quality：真实品质，玩家不可见，切开时才揭示
 *   - yield_data：JSON 字符串，存储切开产出详情（灵石/修为/物品/LDC/稀有/诅咒等）
 *   - is_listed：是否上架拍卖行，未切开原石可流转，切开后不可交易
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerStoneRecords = sequelize.define('PlayerStoneRecords', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '主键ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '当前持有者玩家ID（流转时更新）'
    },
    origin_player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '原始生成者玩家ID（不随流转变化，用于溯源）'
    },
    origin: {
        type: DataTypes.STRING(30),
        allowNull: false,
        comment: '产地ID（luan_xing_island/huang_feng_mine/kun_wu_depth/xu_tian_relic/cursed_vein）'
    },
    quality: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '展示品质ID（common/spirit_vein/treasure_glow/fairy_mist），可能被假线索伪装'
    },
    base_price: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: '基础价（灵石，按品质决定，100/500/2000/8000）'
    },
    clues: {
        type: DataTypes.TEXT,
        allowNull: false,
        comment: '4维线索JSON（crust/weight/aura/color，可能含假线索）',
        get() {
            const raw = this.getDataValue('clues');
            return raw ? JSON.parse(raw) : null;
        },
        set(val) {
            this.setDataValue('clues', val ? JSON.stringify(val) : null);
        }
    },
    real_quality: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '真实品质（玩家不可见，切开时校验，决定实际产出）'
    },
    is_cut: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否已切开：0=未切开 1=已切开'
    },
    cut_method: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: '切开方式（rough/fine/divine_sense）'
    },
    cut_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '切开时间'
    },
    cut_cost: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '切开消耗（灵石，精切100/神识切0）'
    },
    yield_data: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '产出JSON（spirit_stones/cultivation/items/ldc/rare/curse等）',
        get() {
            const raw = this.getDataValue('yield_data');
            return raw ? JSON.parse(raw) : null;
        },
        set(val) {
            this.setDataValue('yield_data', val ? JSON.stringify(val) : null);
        }
    },
    yield_value: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '产出等价灵石价值（用于统计和保底）'
    },
    is_listed: {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: '是否已上架拍卖行：0=未上架 1=已上架'
    },
    listing_price: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '上架价格（灵石）'
    },
    generated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: '生成时间'
    }
}, {
    tableName: 'player_stone_records',
    timestamps: true,
    underscored: true,
    comment: '玩家原石记录表',
    indexes: [
        { name: 'idx_stone_player', fields: ['player_id', 'is_cut'] },
        { name: 'idx_stone_origin_player', fields: ['origin_player_id'] },
        { name: 'idx_stone_listed', fields: ['is_listed'] },
        { name: 'idx_stone_yield', fields: ['yield_value'] }
    ]
});

module.exports = PlayerStoneRecords;
