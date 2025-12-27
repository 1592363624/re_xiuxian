/**
 * 玩家数据模型
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Player = sequelize.define('Player', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    username: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: 'uk_player_username',
        comment: '登录账号'
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '加密密码'
    },
    nickname: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: 'uk_player_nickname',
        comment: '游戏昵称'
    },
    realm: {
        type: DataTypes.STRING,
        defaultValue: '凡人',
        comment: '当前境界'
    },
    exp: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '当前修为'
    },
    spirit_stones: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '灵石数量'
    },
    hp_current: {
        type: DataTypes.BIGINT,
        defaultValue: 100,
        comment: '当前气血'
    },
    mp_current: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '当前灵力'
    },
    toxicity: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '丹毒值'
    },
    lifespan_current: {
        type: DataTypes.FLOAT,
        defaultValue: 16,
        comment: '当前年龄'
    },
    lifespan_max: {
        type: DataTypes.INTEGER,
        defaultValue: 60,
        comment: '最大寿元'
    },
    attributes: {
        type: DataTypes.TEXT,
        defaultValue: JSON.stringify({
            // 基础属性（当前值）
            atk: 10,           // 攻击
            def: 5,            // 防御
            hp_current: 100,   // 当前气血
            mp_current: 0,     // 当前灵力
            speed: 10,         // 速度
            sense: 10,         // 神识
            exp: 0,            // 修为
            lifespan_current: 16, // 当前年龄
            toxicity: 0,       // 丹毒
            spirit_stones: 0,  // 灵石
            
            // 属性最大值
            hp_max: 100,       // 气血最大值
            mp_max: 0,         // 灵力最大值
            lifespan_max: 60,  // 寿命最大值
            
            // 属性加成（临时效果）
            temp_boosts: {},
            last_recovery_time: null
        }),
        get() {
            const rawValue = this.getDataValue('attributes');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('attributes', JSON.stringify(value));
        },
        comment: '基础属性JSON（包含当前值和最大值）'
    },
    spirit_roots: {
        type: DataTypes.TEXT,
        defaultValue: JSON.stringify({}),
        get() {
            const rawValue = this.getDataValue('spirit_roots');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('spirit_roots', JSON.stringify(value));
        },
        comment: '灵根资质JSON'
    },
    token_version: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'Token版本号，用于单点登录控制'
    },
    role: {
        type: DataTypes.STRING,
        defaultValue: 'user', // user, admin
        comment: '用户角色'
    },
    is_secluded: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否闭关中'
    },
    seclusion_start_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '闭关开始时间'
    },
    seclusion_duration: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '计划闭关时长(秒)'
    },
    last_online: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后在线时间'
    },
    last_seclusion_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后闭关结束时间'
    },
    current_map_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '当前所在地图ID'
    },
    last_map_move_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后移动地图时间'
    },
    heavenly_age: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        comment: '天道时间年龄（世界基准时间年龄）'
    },
    mortal_age: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        comment: '红尘时间年龄（个人行为时间年龄）'
    },
    last_heavenly_update: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后天道时间更新'
    },
    time_system_data: {
        type: DataTypes.TEXT,
        defaultValue: JSON.stringify({
            mortal_time_records: [],
            pending_activities: [],
            world_event_participation: {},
            next_breakthrough_window: null
        }),
        get() {
            const rawValue = this.getDataValue('time_system_data');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('time_system_data', JSON.stringify(value));
        },
        comment: '双时间系统数据JSON'
    },
    ip_address: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '注册/登录IP地址'
    },
    device_info: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '注册设备信息'
    },
    realm_max_lifespan: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '当前境界对应的最大寿元（只读，来源于境界配置）'
    },
    database_version: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        comment: '玩家数据版本号，用于兼容性检查'
    },
    realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '当前境界排名（用于快速排序和计算）'
    }
}, {
    tableName: 'players',
    timestamps: true
});

module.exports = Player;
