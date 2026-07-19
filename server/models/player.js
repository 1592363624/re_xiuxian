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
    talent_id: {
        type: DataTypes.STRING,
        defaultValue: 'common_talent',
        comment: '天赋ID'
    },
    titles: {
        type: DataTypes.TEXT,
        defaultValue: JSON.stringify(['newbie']),
        get() {
            const rawValue = this.getDataValue('titles');
            return rawValue ? JSON.parse(rawValue) : [];
        },
        set(value) {
            this.setDataValue('titles', JSON.stringify(value));
        },
        comment: '已获得称号ID列表'
    },
    equipped_title_id: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '当前装备称号ID'
    },
    stats: {
        type: DataTypes.TEXT,
        defaultValue: JSON.stringify({
            meditation_count: 0,
            breakthrough_count: 0,
            kill_count: 0,
            death_count: 0,
            exploration_count: 0,
            alchemy_count: 0,
            refining_count: 0,
            items_collected: 0,
            achievements_completed: 0
        }),
        get() {
            const rawValue = this.getDataValue('stats');
            return rawValue ? JSON.parse(rawValue) : {};
        },
        set(value) {
            this.setDataValue('stats', JSON.stringify(value));
        },
        comment: '玩家统计数据'
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
    },
    is_moving: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否正在移动中'
    },
    moving_from_map_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '出发地图ID'
    },
    moving_to_map_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '目标地图ID'
    },
    move_start_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '移动开始时间'
    },
    move_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '移动预计结束时间'
    },
    total_online_time: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '累计在线时长(毫秒)'
    },
    attribute_points: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '可分配属性点'
    },
    is_dead: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否已死亡'
    },
    is_banned: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否被封禁'
    },
    ban_reason: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: '封禁原因'
    },
    ban_expire_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '封禁到期时间'
    },
    seclusion_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '闭关预计结束时间（深度闭关为长线挂机，需明确结束时间点）'
    },
    seclusion_mode: {
        type: DataTypes.STRING,
        defaultValue: 'normal',
        comment: '闭关模式：normal=常规闭关，deep=深度闭关'
    },
    daily_seclusion_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '今日常规闭关已用次数（跨日重置）'
    },
    daily_deep_seclusion_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '今日深度闭关已用次数（跨日重置）'
    },
    last_seclusion_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后闭关日期（DATEONLY，用于跨日重置每日次数）'
    },
    // ===== 静思悟道系统字段（第三阶段新增） =====
    is_meditating: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否正在静思悟道中'
    },
    meditation_start_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '悟道开始时间'
    },
    meditation_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '悟道预计结束时间'
    },
    meditation_duration: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '计划悟道时长(秒)'
    },
    meditation_mode: {
        type: DataTypes.STRING,
        defaultValue: 'normal',
        comment: '悟道模式：normal=静思悟道，deep=深度悟道'
    },
    meditation_insight: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        comment: '本命感悟值（悟道结束时结算，用于突破瓶颈）'
    },
    daily_meditation_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '今日悟道已用次数（跨日重置）'
    },
    daily_deep_meditation_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '今日深度悟道已用次数（跨日重置）'
    },
    last_meditation_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        comment: '最后悟道日期（用于跨日重置每日次数）'
    },
    last_meditation_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最后悟道结束时间（用于冷却计算）'
    },
    // ===== 突破瓶颈系统字段（第三阶段新增） =====
    bottleneck_state: {
        type: DataTypes.STRING,
        defaultValue: 'none',
        comment: '瓶颈状态：none=无瓶颈，active=处于瓶颈期，broken=已破瓶颈（可突破），failed=突破失败待重试'
    },
    bottleneck_realm_rank: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '处于瓶颈期的境界排名（用于校验当前境界与瓶颈匹配）'
    },
    bottleneck_insight: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        comment: '当前瓶颈已积累的感悟值（达到阈值后状态转为 broken）'
    },
    bottleneck_threshold: {
        type: DataTypes.FLOAT,
        defaultValue: 100,
        comment: '当前瓶颈感悟阈值（达到此值后破除瓶颈）'
    },
    bottleneck_started_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '瓶颈开始时间（用于计算瓶颈持续时长）'
    },
    breakthrough_failure_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '当前境界连续突破失败次数（成功后归零）'
    },
    // ===== PVP 斗法系统字段（第四阶段新增） =====
    pvp_score: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: 'PVP段位积分（冗余字段，便于列表查询）'
    },
    pvp_rank: {
        type: DataTypes.STRING(20),
        defaultValue: '散修',
        comment: 'PVP段位名称（散修/道子/真传/长老/宗主/大能）'
    },
    honor: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '荣誉值（PVP专用货币，可兑换稀有物品）'
    },
    karma: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '因果值（跨境界欺凌累积，达到阈值影响心魔触发概率）'
    },
    weakness_end_time: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '虚弱状态结束时间（PVP失败惩罚：修炼/突破效率下降）'
    },
    // ===== PVP 扩展系统字段（避世入世/决斗/切磋木人） =====
    pvp_mode: {
        type: DataTypes.STRING(20),
        defaultValue: 'active',
        comment: 'PVP模式：active=入世（可参与PVP），recluse=避世（免疫PVP攻击但无法获得PVP奖励）'
    },
    // ===== 当铺系统字段（第四阶段新增） =====
    pawnshop_credit: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        comment: '当铺信用额度（影响典当折扣率，每次按时赎回+1）'
    },
    // ===== 股市系统字段（第四阶段新增） =====
    stock_account_balance: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '股市账户余额（与 spirit_stones 分账，避免污染主货币）'
    },
    stock_margin_debt: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        comment: '融资负债金额（融资买入累积的负债）'
    },
    is_stock_trading_locked: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        comment: '是否禁止股市交易（GM 可锁定，违规账号处理）'
    }
}, {
    tableName: 'players',
    timestamps: true
});

module.exports = Player;
