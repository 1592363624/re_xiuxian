/**
 * 数据库迁移脚本 0022：宗门专属玩法
 *
 * 功能：
 *   1. 创建 player_sect_special 表，存储5个宗门专属玩法数据
 *      - 灵眼之树（落云宗）：成长阶段/成长值/浇灌记录/采收记录
 *      - 观星台（星宫）：观星次数/星象buff
 *      - 命盘（天星宗）：推演次数/命运buff
 *      - 天阶（凌霄宫）：攀登次数/最高层数/心力加成
 *      - 魔道（阴罗宗）：攻击加成/魔气值/修炼记录
 *      - 炉鼎（合欢宗）：问安/反哺/远航/护法
 *
 * 设计说明：
 *   - 采用单表存储所有宗门专属玩法，减少表数量，JSON字段可灵活扩展
 *   - 每个子系统有独立的字段组，便于查询和管理
 *   - 玩家ID唯一索引，一人一条记录
 */
const sequelize = require('../config/database');
const DataTypes = require('sequelize').DataTypes;

async function up() {
    console.log('[Migration 0022] 开始宗门专属玩法迁移...');

    const tables = await sequelize.getQueryInterface().showAllTables();

    if (!tables.includes('player_sect_special')) {
        await sequelize.getQueryInterface().createTable('player_sect_special', {
            id: {
                type: DataTypes.BIGINT,
                primaryKey: true,
                autoIncrement: true
            },
            player_id: {
                type: DataTypes.BIGINT,
                allowNull: false,
                unique: true,
                comment: '玩家ID（一人一条记录）'
            },
            // ===== 灵眼之树（落云宗） =====
            spirit_tree_stage: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '灵眼树成长阶段（0树苗/1幼树/2成树/3灵眼树）'
            },
            spirit_tree_growth: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '灵眼树当前成长值'
            },
            spirit_tree_watered_count: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '今日浇灌次数'
            },
            spirit_tree_watered_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日浇灌日期（用于跨天重置）'
            },
            spirit_tree_harvested_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日采收日期（每日限采1次）'
            },
            // ===== 观星台（星宫） =====
            star_observed_count: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '今日观星次数'
            },
            star_observed_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日观星日期'
            },
            star_last_form: {
                type: DataTypes.STRING(50),
                allowNull: true,
                comment: '上次星象ID'
            },
            star_buff_expire_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '星象buff过期时间'
            },
            // ===== 命盘（天星宗） =====
            fate_divined_count: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '今日推演次数'
            },
            fate_divined_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日推演日期'
            },
            fate_last_result: {
                type: DataTypes.STRING(50),
                allowNull: true,
                comment: '上次推演结果ID'
            },
            fate_buff_expire_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '命运buff过期时间'
            },
            // ===== 天阶（凌霄宫） =====
            stairs_today_count: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '今日攀登次数'
            },
            stairs_today_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日攀登日期'
            },
            stairs_max_floor: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '历史最高层数'
            },
            stairs_current_floor: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '当前到达层数'
            },
            stairs_mental_bonus: {
                type: DataTypes.DECIMAL(5, 2),
                defaultValue: 0,
                comment: '心力加成累计'
            },
            // ===== 魔道（阴罗宗） =====
            dark_atk_bonus: {
                type: DataTypes.DECIMAL(5, 2),
                defaultValue: 0,
                comment: '魔道攻击加成'
            },
            dark_corruption: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '魔气值（0-100，过高会反噬）'
            },
            dark_practiced_count: {
                type: DataTypes.INTEGER,
                defaultValue: 0,
                comment: '今日修炼次数'
            },
            dark_practiced_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日修炼日期'
            },
            dark_purified_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日净化日期'
            },
            // ===== 炉鼎（合欢宗） =====
            furnace_greeted_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日问安日期'
            },
            furnace_feedbacked_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日反哺日期'
            },
            furnace_voyage_route: {
                type: DataTypes.STRING(50),
                allowNull: true,
                comment: '当前远航路线ID（NULL=未远航）'
            },
            furnace_voyage_start_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '远航开始时间'
            },
            furnace_voyage_end_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '远航结束时间'
            },
            furnace_protected_date: {
                type: DataTypes.DATEONLY,
                allowNull: true,
                comment: '今日护法日期'
            },
            furnace_protect_expire_at: {
                type: DataTypes.DATE,
                allowNull: true,
                comment: '护法buff过期时间'
            },
            // ===== 通用 =====
            created_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            },
            updated_at: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            }
        });

        await sequelize.getQueryInterface().addIndex('player_sect_special', ['player_id'], {
            unique: true,
            name: 'idx_sect_special_player'
        });

        console.log('[Migration 0022] player_sect_special 表创建成功');
    } else {
        console.log('[Migration 0022] player_sect_special 表已存在，跳过');
    }

    console.log('[Migration 0022] 宗门专属玩法迁移完成');
}

async function down() {
    await sequelize.getQueryInterface().dropTable('player_sect_special');
    console.log('[Migration 0022] 回滚完成');
}

module.exports = { up, down };
