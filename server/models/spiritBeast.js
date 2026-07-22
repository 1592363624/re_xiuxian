/**
 * 灵兽数据模型
 *
 * 对应数据库表 spirit_beasts，记录玩家拥有的每一只灵兽完整信息：
 *   - 基础信息：player_id / beast_key / beast_name / element / rarity
 *   - 成长属性：star_level（星级）/ level（等级）/ exp（经验）
 *   - 战斗属性：hp_max / atk / def / speed（由配置基础值 × 等级/星级成长系数得出）
 *   - 关系属性：loyalty（忠诚度 0-100）/ is_active（出战中）
 *   - 时间字段：last_feed_time / last_interact_time / caught_at
 *
 * 表设计要点：
 *   - 玩家同时仅允许 1 只灵兽出战（is_active=true），通过应用层 setActiveBeast 保证唯一
 *   - exp/hp_max 使用 BIGINT，避免高等级数值溢出，序列化时需 toString()
 *   - (player_id, is_active) 复合索引支撑快速查询出战灵兽
 *   - element/rarity 使用 STRING(20)，与配置文件 spirit_beast_data.json 中的键保持一致
 *
 * 关联关系：
 *   - 隶属于 Player（player_id → players.id），未做外键约束，由应用层维护
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpiritBeast = sequelize.define('SpiritBeast', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
        comment: '灵兽实例ID'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '所属玩家ID'
    },
    beast_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '灵兽种类key（如 qingyun_wolf/huoyan_lion）'
    },
    beast_name: {
        type: DataTypes.STRING(50),
        allowNull: true,
        comment: '自定义昵称（玩家可修改，null 时显示默认名）'
    },
    element: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '元素属性：metal/wood/water/fire/earth'
    },
    rarity: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '稀有度：common/rare/epic/legendary'
    },
    star_level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '星级（1-10，影响基础属性倍率；3星/5星激活招牌特性）'
    },
    beast_soul: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '兽魂（满级灵兽溢出经验凝练而得，配合妖丹用于通灵升星）'
    },
    last_upgrade_star_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后升星时间（用于升星冷却限制）'
    },
    level: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: '等级（1-100）'
    },
    exp: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '当前经验值',
        get() {
            // BigInt 字段序列化为字符串，避免前端 JSON 解析精度丢失
            const val = this.getDataValue('exp');
            return val !== null && val !== undefined ? val.toString() : '0';
        }
    },
    hp_max: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        comment: '气血上限（由基础值+成长计算）',
        get() {
            const val = this.getDataValue('hp_max');
            return val !== null && val !== undefined ? val.toString() : '0';
        }
    },
    atk: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '攻击'
    },
    def: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '防御'
    },
    speed: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: '速度'
    },
    loyalty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
        comment: '忠诚度（0-100，低于30可能逃跑）'
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否出战中（同一玩家同时仅1只true）'
    },
    is_pasturing: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否正在放养中（放养期间不能出战/喂养/互动）'
    },
    is_exploring: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '是否正在探渊中（探渊期间不能出战/喂养/互动/放养）'
    },
    stamina: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: '体力（0-100，探渊消耗，每小时恢复25）'
    },
    injury_until: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '受伤恢复截止时间（HP归零后需恢复2小时，期间不能探渊/出战/放养）'
    },
    last_explore_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后探渊时间（用于每日次数限制校验）'
    },
    last_feed_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后喂养时间（冷却1小时）'
    },
    last_interact_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后互动时间（冷却10分钟）'
    },
    caught_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '捕获时间'
    }
}, {
    tableName: 'spirit_beasts',
    timestamps: true,
    underscored: true,
    indexes: [
        // 单字段索引：按玩家查灵兽列表
        { fields: ['player_id'], name: 'idx_sb_player' },
        // 复合索引：查询玩家出战灵兽（同时仅1只）
        { fields: ['player_id', 'is_active'], name: 'idx_sb_player_active' },
        // 索引：按种类统计图鉴捕获情况
        { fields: ['beast_key'], name: 'idx_sb_beast_key' }
    ]
});

module.exports = SpiritBeast;
